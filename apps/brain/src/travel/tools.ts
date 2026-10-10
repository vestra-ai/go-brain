/**
 * The composer's travel tools. Searches answer compact results for the model and save the full set, so show_options
 * builds the card from what was checked, never from prices the model typed. Constraints people gave ("can't leave
 * before 6") arrive as arguments and are applied in code by the travel layer.
 */
import { z } from 'zod';
import { CARD_LINE } from '../composer/rules.js';
import { CardLineArg, SAY_NOTHING, type QuickTool, type TurnCtx } from '../composer/tools.js';
import type { Desk } from '../desk/desk.js';
import { dateAs } from './book/expr.js';
import { buildFlightsLinkCard, buildIxigoPageCard, buildOptionsCard, clip, formatInr, IXIGO_SEARCH_PAGES, ixigoPage, placeKindNotAll, subtitleFor } from './cards.js';
import { localDay } from '../proactive/clock.js';
import { answerLine, answerTitle, directPicks, ledBy, leftOff, linkLine, plainAsk } from './answer.js';
import { flightDetails, stayDetails, trainDetails } from './details.js';
import { DEFAULT_TRIP_TZ } from './dates.js';
import { asked } from './filters.js';
import { stableId } from './ids.js';
import type { Images } from './images.js';
import { guestsIn } from './recipes/ask.js';
import { TRAVEL_WAIT_MS } from './recipes/backend.js';
import { airportCity } from './recipes/places.js';
import { TravelError } from './mcp-travel.js';
import { toResultOption, type OptionKind, type ResultOption, type ResultSet, type ResultsStore } from './results.js';
import type { SearchWake } from './search-wake.js';
import { Clock, MUST_HAVES, type Travel, type TravelKind, type TravelOption, type TravelQuery, type TravelSearch } from './travel.js';
import { openVoteFromCard } from './votes.js';

export interface TravelToolDeps {
  travel: Travel;
  results: ResultsStore;
  images: Images;
  now: () => Date;
  /** Where a search that outlives its turn wakes Go with its options; without it, every search is waited for. */
  desk?: Pick<Desk, 'put'>;
  log?: { warn(obj: object, msg: string): void };
  /** Wakes the trip's computer for a search of this kind (travel/warm.ts); absent in tests that don't look at it. */
  warmForTravel?: (tripId: string, kind: TravelKind) => void;
  /** Today in the trip's time zone (YYYY-MM-DD), to read the ask a search answers. Default: India's. */
  today?: (tripId: string) => Promise<string>;
  /**
   * Once a stays card is up: its top pick opened on the trip's stage for the room to watch, its card clicked on the results
   * by its name (its page by its address when the click brings nothing), and what it says kept for the next question about
   * it (Keshav, 10 Oct: the group sees Go act on ixigo). Absent, nothing opens.
   */
  showPick?: (tripId: string, pick: { page: string; name: string }) => void;
}

const todayOf = (d: Pick<TravelToolDeps, 'today' | 'now'>, tripId: string): Promise<string> =>
  d.today ? d.today(tripId) : Promise.resolve(localDay(d.now(), DEFAULT_TRIP_TZ));

export const OPTION_KIND: Record<TravelKind, OptionKind> = { flights: 'flight', trains: 'train', buses: 'bus', stays: 'stay' };

const Where = z.string().min(2).max(60);
const Rupees = z.number().positive().max(10_000_000);
const toPaise = (rupees: number): number => Math.round(rupees * 100);
/** A time nobody in this ask said, taken from the trip (a member's own answer): said with the time, so it never reads as made up. */
const Because = z
  .string()
  .min(3)
  .max(80)
  .optional()
  .describe('Only when a time above comes from the trip, not from this ask: who it is for and why, in plain words, e.g. "Rahul can leave Friday after 6 pm".');

export const FlightsArgs = z.object({
  from: Where.describe('City or airport code, e.g. "Delhi" or "DEL"; a city abroad with its airport code, e.g. "London (LHR)"'),
  to: Where.describe('City or airport code, e.g. "Goa" or "Dubai (DXB)"'),
  date: z.iso.date().describe('YYYY-MM-DD'),
  return_date: z.iso.date().optional()
    .describe('YYYY-MM-DD, the day back, for a round trip ("6 ko jaana 9 ko wapas"): both ways on one ixigo page, shown as pairs priced there and back. The times and stops given are the way there. Several legs (multi-city) are one search_flights a leg instead.'),
  depart_after: Clock.optional().describe('24-hour HH:MM. Someone who can only leave after 6 pm is "18:00".'),
  depart_before: Clock.optional(),
  arrive_before: Clock.optional(),
  because: Because,
  max_price_per_person: Rupees.optional().describe('In rupees; for a round trip, there and back'),
  non_stop: z.boolean().optional(),
  travellers: z.int().min(1).max(9).optional().describe('Only when the ask says how many fly ("for 3 of us"). Leave it out otherwise: Go counts who lives near the origin. With children or infants, the adults alone.'),
  children: z.int().min(1).max(8).optional().describe('Children 2 to 11 who fly, only when the ask says so ("2 adults and 2 kids").'),
  infants: z.int().min(1).max(4).optional().describe('Infants under 2, on a lap, only when the ask says so.'),
  cabin: z.enum(['economy', 'premium_economy', 'business']).optional().describe('Only when the ask names one. ixigo sells economy, premium economy and business, and no first class.'),
  special_fare: z.enum(['student', 'senior_citizen', 'armed_forces', 'doctor']).optional()
    .describe("ixigo's special fares, only when the ask says who flies: students, senior citizens, the armed forces, doctors and nurses. ixigo then lists only the flights that sell it, it is not always cheaper than the regular fare, and each takes an ID at check-in."),
  site_filters: z.array(z.string().min(1).max(80)).max(8).optional()
    .describe("ixigo's own flight filters the ask means, by their names on ixigo's list for the route (in your context once a search of it ran): an airline, an airport (Mopa for North Goa), a layover city, bags, a free meal, hiding non-refundable fares. Go applies them to the flights and ixigo's page shows them ticked"),
  wants: z.array(z.string().min(1).max(80)).max(8).optional()
    .describe("Anything else the group asked for that no argument here covers, in their words (a seat): ixigo's page is linked, and the line says to pick it there"),
});
export const JourneyArgs = z.object({
  from: Where.describe('City or station, e.g. "Jaipur"; for trains, a station with its Indian Railways code works too, e.g. "Udaipur City (UDZ)"'),
  to: Where.describe('City or station, e.g. "Goa"; for trains, a station with its code works too, e.g. "Madgaon (MAO)"'),
  date: z.iso.date().describe('YYYY-MM-DD'),
  depart_after: Clock.optional().describe('24-hour HH:MM'),
  depart_before: Clock.optional(),
  arrive_before: Clock.optional(),
  because: Because,
  max_price_per_person: Rupees.optional().describe('In rupees'),
  wants: z.array(z.string().min(1).max(80)).max(8).optional()
    .describe("Anything else the group asked for that no argument here covers, in their words (a class, AC, sleeper, an operator): you pick it from the results' details"),
});
export const StaysArgs = z.object({
  area: Where.describe('A city, town or area, e.g. "Manali", "North Goa" or "Anjuna"'),
  check_in: z.iso.date(),
  check_out: z.iso.date(),
  guests: z.int().min(1).max(30).optional(),
  max_price_per_night: Rupees.optional().describe('In rupees a night, as ixigo prices a stay: a room of a hotel, the whole place of an entire house'),
  max_price_per_person: Rupees.optional()
    .describe("In rupees: each person's share of the whole stay, as in \"under 8k a head\" or \"15k each\". Go divides each stay's total by the people and says the share"),
  must_have: z.array(z.enum(MUST_HAVES)).max(5).optional()
    .describe("pool, beach (10 minutes or less), breakfast, free_cancellation. When ixigo's own filters for the place are in your context, use them in site_filters instead, and must_have only for the beach"),
  min_rating: z.number().min(0).max(5).optional(),
  site_filters: z.array(z.string().min(1).max(80)).max(8).optional()
    .describe("ixigo's own filters the ask means, by their names on ixigo's list for the place (in your context), the nearest one for what they said: ixigo filters the stays itself"),
  site_sort: z.string().min(1).max(80).optional().describe("ixigo's own sort the ask means, by its name on that list"),
  wants: z.array(z.string().min(1).max(80)).max(8).optional()
    .describe("Anything else the group asked for that no filter covers, in their words: you pick it from the results' amenities and details"),
});

export function flightsQuery(a: z.infer<typeof FlightsArgs>): TravelQuery {
  return {
    from: a.from,
    to: a.to,
    date: a.date,
    ...(a.return_date ? { returnDate: a.return_date } : {}),
    ...(a.depart_after ? { departAfter: a.depart_after } : {}),
    ...(a.depart_before ? { departBefore: a.depart_before } : {}),
    ...(a.arrive_before ? { arriveBefore: a.arrive_before } : {}),
    ...(a.because && (a.depart_after || a.depart_before || a.arrive_before) ? { because: a.because } : {}),
    ...(a.max_price_per_person ? { maxPriceMinor: toPaise(a.max_price_per_person) } : {}),
    ...(a.non_stop ? { mustHave: ['non_stop' as const] } : {}),
    ...(a.travellers ? { guests: a.travellers } : {}),
    ...(a.children ? { children: a.children } : {}),
    ...(a.infants ? { infants: a.infants } : {}),
    ...(a.cabin ? { cabin: a.cabin } : {}),
    ...(a.special_fare ? { specialFare: a.special_fare } : {}),
    ...(a.site_filters?.length ? { siteFilters: a.site_filters } : {}),
    ...(a.wants?.length ? { wants: a.wants } : {}),
  };
}

/**
 * A flight's travellers count only when the ask itself says how many fly ("for 3 of us from Delhi"), in a line of this
 * turn's. A count the model took from the whole trip ("the trip has 5 people") is dropped, so the search counts the
 * members who live by the origin instead: Arjun, in Bangalore, is not on a flight from Delhi (re-drill 5).
 */
function askedTravellers(q: TravelQuery, ctx: TurnCtx): TravelQuery {
  if (q.guests === undefined) return q;
  const woke = new Set(ctx.wake.flatMap((w) => (w.kind === 'message' ? [(w.payload as { messageId?: string } | null)?.messageId] : [])));
  const first = Math.min(...ctx.pack.messages.filter((m) => woke.has(m.message_id)).map((m) => m.seq));
  // The asking lines, and any later line of the turn: "@Go flights Delhi to Goa Friday", then "for 3 of us".
  const said = ctx.pack.messages.some((m) => m.seq >= first && m.author.kind === 'person' && guestsIn((m.text ?? '').toLowerCase()) === q.guests);
  if (said) return q;
  const rest = { ...q };
  delete rest.guests;
  return rest;
}

export const BusesArgs = JourneyArgs.extend({
  board_at: z.string().min(2).max(60).optional()
    .describe('A pickup point the group named, as its place name ("Majestic", "Silk Board"): only buses that stop there fit, and ixigo\'s own chip for it is clicked'),
  drop_at: z.string().min(2).max(60).optional()
    .describe('A drop point the group named, as its place name ("Mapusa", "Panjim"): only buses that stop there fit, and ixigo\'s own chip for it is clicked'),
});

export function busesQuery(a: z.infer<typeof BusesArgs>): TravelQuery {
  return { ...journeyQuery(a), ...(a.board_at ? { boardAt: a.board_at } : {}), ...(a.drop_at ? { dropAt: a.drop_at } : {}) };
}

export function journeyQuery(a: z.infer<typeof JourneyArgs>): TravelQuery {
  return {
    from: a.from,
    to: a.to,
    date: a.date,
    ...(a.depart_after ? { departAfter: a.depart_after } : {}),
    ...(a.depart_before ? { departBefore: a.depart_before } : {}),
    ...(a.arrive_before ? { arriveBefore: a.arrive_before } : {}),
    ...(a.because && (a.depart_after || a.depart_before || a.arrive_before) ? { because: a.because } : {}),
    ...(a.max_price_per_person ? { maxPriceMinor: toPaise(a.max_price_per_person) } : {}),
    ...(a.wants?.length ? { wants: a.wants } : {}),
  };
}

export function staysQuery(a: z.infer<typeof StaysArgs>): TravelQuery {
  return {
    area: a.area,
    checkIn: a.check_in,
    checkOut: a.check_out,
    ...(a.guests ? { guests: a.guests } : {}),
    ...(a.max_price_per_night ? { maxPriceMinor: toPaise(a.max_price_per_night) } : {}),
    ...(a.max_price_per_person ? { maxShareMinor: toPaise(a.max_price_per_person) } : {}),
    ...(a.must_have ? { mustHave: a.must_have } : {}),
    ...(a.min_rating !== undefined ? { minRating: a.min_rating } : {}),
    ...(a.site_filters?.length ? { siteFilters: a.site_filters } : {}),
    ...(a.site_sort ? { siteSort: a.site_sort } : {}),
    ...(a.wants?.length ? { wants: a.wants } : {}),
  };
}

export function ageText(checkedAt: string, now: Date): string {
  const seconds = Math.max(0, (now.getTime() - Date.parse(checkedAt)) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

/** A stay's area exactly as the data gives it, so the model never fills one in from what people asked for. */
const areaOf = (o: { facts: Record<string, string | number | boolean> }): string => (typeof o.facts.area === 'string' ? o.facts.area : 'not in the data');

/**
 * An option in short for the model; with details, everything its row says, to pick on what no filter covered: its
 * amenities, its carrier, and each fact the recipe read (a stay's kind and distance, a bus's type and seats left, a
 * train's class and availability), whatever the ask.
 */
export function compactOption(n: number, o: ResultOption, details = false): Record<string, unknown> {
  const when = o.journey ? subtitleFor(o) : null;
  const nights = typeof o.facts.nights === 'number' ? o.facts.nights : null;
  const said = Object.entries(o.facts).filter(([, v]) => typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 80));
  const has = details
    ? {
        ...(o.amenities?.length ? { amenities: o.amenities.slice(0, 12) } : {}),
        ...(o.journey?.carrier_name ? { carrier: o.journey.carrier_name } : {}),
        ...(said.length ? { details: Object.fromEntries(said) } : {}),
      }
    : {};
  return {
    n,
    title: o.title,
    ...(o.journey ? { route: `${o.journey.origin.name} to ${o.journey.destination.name}` } : {}),
    ...(when ? { when } : {}),
    ...(o.kind === 'stay' ? { area: areaOf(o) } : {}),
    ...(o.priceMinor !== undefined ? { price: `${formatInr(o.priceMinor)}${o.priceNote ? ` ${o.priceNote}` : ''}` } : {}),
    ...(o.totalMinor !== undefined && nights ? { total: `${formatInr(o.totalMinor)} for ${nights} nights` } : {}),
    ...(o.rating !== undefined ? { rating: o.rating } : {}),
    highlights: o.highlights,
    ...has,
  };
}

function suggestTitle(kind: TravelKind, q: TravelQuery): string {
  switch (kind) {
    case 'flights':
      return clip(`Flights, ${q.from ?? ''} to ${q.to ?? ''}`, 80);
    case 'trains':
      // A train list is for one day: the card says which ("Trains, Delhi to Goa, 6 Nov").
      return clip(`Trains, ${q.from ?? ''} to ${q.to ?? ''}${q.date ? `, ${dateAs(q.date, 'D Mon')}` : ''}`, 80);
    case 'buses':
      return clip(`Buses, ${q.from ?? ''} to ${q.to ?? ''}`, 80);
    case 'stays':
      return clip(`Stays in ${q.area ?? q.to ?? 'Goa'}`, 80);
  }
}

/** What was searched, where and when, without the conditions: "stays in North Goa, 2026-11-06 to 2026-11-09". */
export function searchScope(kind: TravelKind, q: TravelQuery): string {
  if (kind === 'stays') return `stays in ${q.area ?? q.to ?? 'Goa'}${q.checkIn && q.checkOut ? `, ${q.checkIn} to ${q.checkOut}` : ''}`;
  return `${kind} from ${q.from ?? '?'} to ${q.to ?? '?'}${q.date ? ` on ${q.date}` : ''}`;
}

const ONE: Record<TravelKind, string> = { flights: 'flight', trains: 'train', buses: 'bus', stays: 'stay' };

/** The scope after a count, its noun agreeing with it: "1 train from Delhi…", "4 trains from Delhi…". */
const scopeOf = (kind: TravelKind, q: TravelQuery, n: number): string => {
  const scope = searchScope(kind, q);
  return n === 1 ? `${ONE[kind]}${scope.slice(kind.length)}` : scope;
};
const counted = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** One option in a line: its name, the stay's area, the journey's time, and its price as checked. */
function optionLine(o: TravelOption): string {
  const where = o.kind === 'stay' ? ` (${areaOf(o)})` : '';
  const when = o.journey ? `, ${subtitleFor(toResultOption(o))}` : '';
  return `${o.title}${where}${when}, ${formatInr(o.priceMinor)}${o.priceNote ? ` ${o.priceNote}` : ''}`;
}

/** The lowest to the highest price the results show, with what the price covers. */
function priceRange(options: ResultOption[]): string | null {
  const prices = options.flatMap((o) => (o.priceMinor === undefined ? [] : [o.priceMinor]));
  if (prices.length === 0) return null;
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const note = options.find((o) => o.priceNote)?.priceNote;
  return `${low === high ? formatInr(low) : `${formatInr(low)} to ${formatInr(high)}`}${note ? ` ${note}` : ''}`;
}

const titleWords = (s: string): string => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * An options card's title for stays from ixigo.com: the model's, unless it names a kind of place ("Pool villas in North
 * Goa") that not every option on the card is by its own name; then what was searched ("Stays with a pool in North Goa").
 * ixigo has no villa type, and a pool search there gives hotels and resorts (re-drill 6). Other searches keep the title.
 */
function stayCardTitle(title: string, query: Record<string, unknown>, shown: ResultOption[]): string {
  if (!shown.some((o) => o.kind === 'stay' && ixigoPage(o.sourceUrl ?? null)) || !placeKindNotAll(title, shown.map((o) => o.title))) return title;
  const needs = Array.isArray(query['mustHave']) ? (query['mustHave'] as string[]) : [];
  const withs = [needs.includes('pool') && 'a pool', needs.includes('breakfast') && 'breakfast', needs.includes('free_cancellation') && 'free cancellation']
    .filter((w): w is string => typeof w === 'string');
  const area = typeof query['area'] === 'string' ? titleWords(query['area']) : '';
  return clip(`Stays${withs.length ? ` with ${listOf(withs)}` : ''}${needs.includes('beach') ? ' near the beach' : ''}${area ? ` in ${area}` : ''}`, 80);
}

const listOf = (words: string[]): string => (words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);

/**
 * Every search answers with a summary built in code: how many it found and how many fit, the conditions people gave, the
 * prices and the stays' areas. When nothing fits it names the conditions and the nearest misses (stays: on a card), so a
 * line about it can never drop one ("no pool villa under ₹10,000", not "nothing under ₹10,000").
 */
async function runSearch(kind: TravelKind, q: TravelQuery, ctx: TurnCtx, d: TravelToolDeps): Promise<unknown> {
  // A search starting is travel intent: the trip's computer stays awake for the follow-ups too.
  d.warmForTravel?.(ctx.tripId, kind);
  const pending = d.travel.search(kind, q, { tripId: ctx.tripId, turnId: ctx.turnId });
  // Handled at once, so a refusal that lands while the wait is worked out is never an unhandled rejection; it is read below.
  pending.catch(() => undefined);
  // A search that can't answer in time (an ixigo.com page on a slow box, or the agent job) goes on without the turn.
  const budget = d.desk && d.travel.waitMs ? await d.travel.waitMs(kind, q, { tripId: ctx.tripId }).catch(() => null) : null;
  let found;
  try {
    // At least a second: a search kept from earlier answers in that, even when the run itself would never answer inline.
    const first = budget === null ? await pending : await Promise.race([pending, nap(Math.max(budget, KEPT_ANSWERS_MS)).then((): typeof STILL_RUNNING => STILL_RUNNING)]);
    if (first === STILL_RUNNING) return goOnWithout(kind, q, pending, ctx, d);
    found = first;
  } catch (err) {
    const search = searchName(kind, q);
    if (err instanceof TravelError && err.code === 'link_only' && err.link) return linkAnswer(kind, q, err.link, ctx, plainAsk(kind, q, { wake: ctx.wake, pack: ctx.pack, ...(ctx.roundTools ? { roundTools: ctx.roundTools } : {}), today: await todayOf(d, ctx.tripId) }).ok);
    if (err instanceof TravelError && err.code === 'unknown_place') return pageAnswer(kind, q, ctx);
    // A date in the past is the model's slip (usually the year), not news for the room: search again with the date it names.
    if (err instanceof TravelError && err.code === 'past_date') return { search, count: 0, refused: err.message, tell_the_room: SAY_NOTHING };
    if (err instanceof TravelError) {
      return {
        search, count: 0, error: err.code, note: clip(err.message, 200), summary: `This search failed (${err.code}): nothing came back for ${search}, so there is no list for it.`,
        // Never a job for it (staging, 9 Oct: a refused stays search became start_task, a slow job on a blank page).
        tell_the_room: "Say in one short line that ixigo didn't answer this time, and offer to try again. Never start_task for it: the search tools are how Go searches ixigo.",
      };
    }
    throw err;
  }
  // The turn's one plain ask, found: the search answers it, card and line, and no model round follows. Never with
  // something left to pick: the model picks it from the results.
  if (found.results.length > 0 && !found.earlier && leftToPick(q, found).length === 0 && plainAsk(kind, q, { wake: ctx.wake, pack: ctx.pack, ...(ctx.roundTools ? { roundTools: ctx.roundTools } : {}), today: await todayOf(d, ctx.tripId) }).ok) {
    return answerItself(kind, q, found, ctx, d);
  }
  return searchAnswer(kind, q, found, ctx.tripId, d);
}

/**
 * Puts an options card up from a saved set, with its line: the picks by their numbers, saved before the card is shown
 * so a tap always finds its offers. show_options and a search that answers itself both come here.
 */
export async function putUpCard(
  set: ResultSet,
  numbers: number[],
  given: { title: string; line: string },
  ctx: TurnCtx,
  d: Pick<TravelToolDeps, 'results' | 'images' | 'showPick'>,
): Promise<{ cardId: string; shown: number }> {
  const cardId = ctx.stableId('c_opt');
  const run = runOfSet.get(set.resultsId);
  if (run) remember(shownRuns, run);
  // Each option's sheet (contract 1.1 details), from what the search read: a stay's photos through Go's image cache.
  const query = set.query as TravelQuery;
  const people = query.guests ?? ctx.pack?.trip?.people?.length ?? 0;
  const picks = await Promise.all(
    numbers.map(async (n, i) => {
      const option = set.options[n - 1]!;
      const gallery = set.optionKind === 'stay' ? (await Promise.all((option.imageUrls ?? []).map((u) => d.images.rehostUrl(u)))).filter((u): u is string => u !== null) : [];
      const details = set.optionKind === 'stay'
        ? stayDetails(option, query, people, gallery)
        : set.optionKind === 'train' ? trainDetails(option) : set.optionKind === 'flight' ? flightDetails(option, people) : null;
      return {
        n: i + 1, optionId: stableId('opt', cardId, i + 1), option, imageUrl: option.imageUrl ? await d.images.rehostUrl(option.imageUrl) : null,
        ...(details ? { details } : {}),
      };
    }),
  );
  const title = stayCardTitle(given.title, set.query, picks.map((p) => p.option));
  // Stays from ixigo.com: the card shows a few, so its button opens the whole list the search read (the lead's call).
  const seeAll = set.optionKind === 'stay' && ixigoPage(set.page ?? null) !== null;
  // Nobody in the trip has a budget band yet: the stays card asks for one, in the App's own budget sheet.
  const askBudget = set.optionKind === 'stay' && !ctx.pack.trip.budget?.lowest;
  const card = buildOptionsCard({ cardId, title, optionKind: set.optionKind, checkedAt: set.checkedAt, picks, seeAll, askBudget });
  await d.results.saveCard({ cardId, tripId: ctx.tripId, resultsId: set.resultsId, title: card.title, optionKind: set.optionKind, card }, picks, set.checkedAt);
  // A rerun of the same turn finds this card id saved already: it shows the card saved first, which its stored offers match.
  const shown = (await d.results.card(ctx.tripId, cardId))?.card ?? card;
  ctx.cards.push(shown);
  ctx.lines.push(given.line);
  // The stays' top pick, its own page on the stage once its card is up: the room watches Go open it.
  const top = set.optionKind === 'stay' ? ixigoPage(picks[0]?.option.sourceUrl ?? null) : null;
  if (top) d.showPick?.(ctx.tripId, { page: top, name: picks[0]!.option.title });
  return { cardId, shown: shown.options.length };
}

/**
 * A finished search that answers the turn's plain ask itself: its list saved, its picks on a card (the engine's order:
 * the first three stays, the three cheapest journeys), and a line built from its data. The turn ends on them, with no
 * model round after the search. "See on ixigo" on the card opens each option's own page, as on any card. lead goes
 * before the line ("Already on ixigo: pool stays in…", a watch that is already so). Options read without filters ixigo
 * left off (unapplied) are saved and titled as searched without them, and the line says so first.
 */
export async function answerItself(
  kind: TravelKind,
  q: TravelQuery,
  found: TravelSearch,
  ctx: TurnCtx,
  d: Pick<TravelToolDeps, 'results' | 'images'>,
  lead?: string,
): Promise<unknown> {
  const searched = answeredAs(q, found);
  const options = found.results.slice(0, 10).map(toResultOption);
  const set = await d.results.save({ tripId: ctx.tripId, optionKind: OPTION_KIND[kind], source: 'search', query: searched, options, checkedAt: found.checkedAt, ...(found.page ? { page: found.page } : {}) });
  noteRun(set.resultsId, ctx.tripId, found.runId);
  const numbers = directPicks(kind, options);
  // The line's "from" is the card's own cheapest, never one of the results the card leaves out.
  const line = ledBy(lead ?? leftOffLead(found), answerLine(kind, searched, numbers.map((n) => options[n - 1]!)));
  const { cardId, shown } = await putUpCard(set, numbers, { title: answerTitle(kind, searched), line }, ctx, d);
  ctx.answered = true;
  return { search: searchName(kind, searched), results_id: set.resultsId, card_id: cardId, shown, answered: true, note: 'The card and its line are up: this turn has said what it needed to.' };
}

/**
 * The ask as a search answered it: without the conditions ixigo left off (TravelSearch.unapplied), and with the site's
 * own filters and sort only as the site applied them, in its words. What it didn't apply is the model's to pick (leftToPick).
 */
function answeredAs(q: TravelQuery, found: TravelSearch): TravelQuery {
  const off = found.unapplied ?? [];
  const searched: TravelQuery = { ...q };
  delete searched.siteFilters;
  delete searched.siteSort;
  const filtered = found.site?.filtered ?? [];
  return {
    ...searched,
    ...(off.length > 0 ? { mustHave: (q.mustHave ?? []).filter((c) => !off.includes(c)) } : {}),
    ...(filtered.length > 0 ? { siteFilters: filtered } : {}),
    ...(found.site?.sorted ? { siteSort: found.site.sorted } : {}),
  };
}

/**
 * What a search leaves to the model to pick from its results: the wants, and the site's own filters and sort the site
 * didn't apply (not on its list, its list not known yet, or its filtered page slow). The search never fails for them.
 */
export function leftToPick(q: TravelQuery, found: TravelSearch): string[] {
  const asked = [...(q.siteFilters ?? []), ...(q.siteSort ? [q.siteSort] : [])];
  const notApplied = found.site ? [...found.site.unknown, ...(found.unapplied ?? []).filter((n) => asked.includes(n))] : asked;
  return [...new Set([...notApplied, ...(q.wants ?? [])])];
}

/** What goes before the card's line of a search ixigo left filters off: "ixigo's pool filter didn't load in time, …: ". */
const leftOffLead = (found: TravelSearch): string | undefined => (found.unapplied?.length ? `${leftOff(found.unapplied)}: ` : undefined);

/** The loop waits this long for a search tool: the search's own wait (TRAVEL_WAIT_MS) and its answer fit inside. */
const SEARCH_TOOL_MS = TRAVEL_WAIT_MS + 2_000;
const STILL_RUNNING = Symbol('still running');
const KEPT_ANSWERS_MS = 1_000;
const nap = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref());

/** Runs whose options a card in the room has shown, as "trip:run", and each saved set's run: bounded, newest kept. */
const shownRuns = new Map<string, true>();
const runOfSet = new Map<string, string>();
const RUNS_KEPT = 2_000;
function remember<V>(m: Map<string, V>, key: string, value: V = true as V): void {
  m.delete(key);
  m.set(key, value);
  while (m.size > RUNS_KEPT) m.delete(m.keys().next().value!);
}
function noteRun(resultsId: string, tripId: string, runId: string | undefined): void {
  if (runId) remember(runOfSet, resultsId, `${tripId}:${runId}`);
}

/**
 * A search that outlived its turn, handed over: when its run finishes, its options are saved and Go wakes on a 'search'
 * desk item, and that wake puts its card up with its line itself, with no model call (searchWakeAnswer). Level-triggered
 * at the run: every search that outlives its turn comes here (the early start's, from the right-now block or the early
 * answer, and the search tool's), whatever the model did in that turn, and the ones that shared one run wake Go once. A
 * run whose options a card in the room already showed wakes nothing. Without a desk (tests that don't look) it does nothing.
 */
export function handOver(
  kind: TravelKind,
  q: TravelQuery,
  pending: Promise<TravelSearch>,
  o: { tripId: string; fallbackId: string },
  d: Pick<TravelToolDeps, 'desk' | 'now' | 'log'> & { results: Pick<ResultsStore, 'save'> },
): void {
  const desk = d.desk;
  if (!desk) return;
  const wake = (id: string, payload: SearchWake): Promise<void> => desk.put({ id, tripId: o.tripId, kind: 'search', ref: kind, dueAt: d.now(), payload });
  pending
    .then(
      async (found) => {
        if (found.runId && shownRuns.has(`${o.tripId}:${found.runId}`)) return;
        const a = await searchAnswer(kind, q, found, o.tripId, d);
        const lead = leftOffLead(found);
        // Something left to pick goes to the model, which picks it; so do stays with the nearest saved after too few fits,
        // which the model says plainly. The rest posts its card with no model call.
        const pick = leftToPick(q, found).length > 0 || (kind === 'stays' && ((found.nearest?.length ?? 0) > 0 || !!found.earlier));
        const payload: SearchWake = {
          source: 'travel_search', search: a.search, count: a.count, resultsId: a.results_id ?? null, summary: a.summary, error: null,
          ...(lead ? { lead } : {}), ...(pick ? { pick } : {}),
        };
        await wake(`search:${o.tripId}:${found.runId ?? o.fallbackId}`, payload);
      },
      async (err: unknown) => {
        const code = err instanceof TravelError ? err.code : 'failed';
        // ixigo's own page instead of a list (flights held back or refused): the wake puts its link card up.
        const link = err instanceof TravelError && err.code === 'link_only' && err.link ? linkOf(kind, q, err.link) : null;
        await wake(`search:${o.tripId}:${o.fallbackId}:failed`, {
          source: 'travel_search', search: searchName(kind, q), count: 0, resultsId: null, summary: '', error: code, ...(link ? { link } : {}),
        });
      },
    )
    .catch((err: unknown) => d.log?.warn({ err, tripId: o.tripId, kind }, 'travel: a search that outlived its turn could not wake Go'));
}

/** The turn goes on while the search runs; handOver puts its options up when it finishes. */
function goOnWithout(kind: TravelKind, q: TravelQuery, pending: Promise<TravelSearch>, ctx: TurnCtx, d: TravelToolDeps): unknown {
  handOver(kind, q, pending, { tripId: ctx.tripId, fallbackId: `${ctx.turnId}:${kind}` }, d);
  return {
    search: searchName(kind, q),
    count: 0,
    running: true,
    tell_the_room: SAY_NOTHING,
    note: 'This search is still running on ixigo, and the live card in the room already shows it. Post nothing about it: its options go up in the room by themselves when it finishes.',
  };
}

/** Who a flights results page is set for, read off its own link: "for 3 from Delhi". */
export function flyingFor(url: string): string | null {
  const page = new URL(url);
  const adults = Number(page.searchParams.get('adults'));
  const city = airportCity(page.searchParams.get('from') ?? '');
  return adults > 0 && city ? `for ${adults} from ${city}` : null;
}

/** A link card's title, who it is set for, and its line: the same in the search's own turn and in a late search's wake. */
function linkOf(kind: TravelKind, q: TravelQuery, url: string): NonNullable<SearchWake['link']> {
  const who = kind === 'flights' ? flyingFor(url) : null;
  return { url, title: suggestTitle(kind, q), who, line: linkLine(kind, q, who) };
}

/**
 * ixigo won't show Go's computer these results: the card links the group to them on ixigo, with their conditions set
 * (the recipe's own link: ixigo's results page with what people asked for already on it).
 * Go books no flights, so the line it adds sends people to ixigo to book, and offers only to note their pick.
 */
function linkAnswer(kind: TravelKind, q: TravelQuery, url: string, ctx: TurnCtx, plain = false): unknown {
  const link = linkOf(kind, q, url);
  const who = link.who;
  ctx.cards.push(buildFlightsLinkCard({ cardId: ctx.stableId('c_link'), title: link.title, url, who, ...(kind === 'stays' ? { kind: 'stays' as const } : {}) }));
  // The turn's one plain ask: the card's line is built here too, and the turn ends on it.
  if (plain) {
    ctx.lines.push(link.line);
    ctx.answered = true;
  }
  return {
    search: searchName(kind, q),
    count: 0,
    link: url,
    ...(who ? { set_for: who } : {}),
    ...(kind === 'stays'
      ? {
          note: "ixigo won't show its stays to Go's computer right now, and Go has no read of them from the last few hours. The card with the link to them on ixigo, with these conditions and ixigo's filters set, goes out with your message.",
          tell_the_room:
            "Say in one short line that ixigo wouldn't load its stays for Go just now, so the card opens them on ixigo with what they asked already set, " +
            `${q.wants?.length ? `that they pick for ${listOf(q.wants)} on ixigo's page, ` : ''}and that if they tell you which one, you'll note it for the group. ` +
            'Never say there are no stays, never ask them to try again later, and quote no prices.',
        }
      : {
          note: "ixigo won't show its flights to Go's computer right now. The card with the link to them on ixigo, with these conditions set, goes out with your message.",
          tell_the_room:
            `Say in one short line that the flights are on the card${who ? `, set ${who}` : ''}, to book on ixigo, ` +
            `${q.wants?.length ? `that the link can't set ${listOf(q.wants)}, so they pick for that on ixigo's page, ` : ''}and that if they tell you ` +
            "which one, you'll note it for the group. You can't book flights: never offer to book one or to take it from there. " +
            'Never say there are no flights, and quote no prices or times.',
        }),
  };
}

/**
 * A place Go has no ixigo code for, even after asking ixigo's own search box: the card opens ixigo's page for this kind
 * of search, where the group searches it. Go never sends anyone to another site.
 */
function pageAnswer(kind: TravelKind, q: TravelQuery, ctx: TurnCtx): unknown {
  const page = IXIGO_SEARCH_PAGES[kind];
  ctx.cards.push(buildIxigoPageCard({ cardId: ctx.stableId('c_link'), title: suggestTitle(kind, q), kind }));
  return {
    search: searchName(kind, q),
    count: 0,
    link: page.url,
    note: `Go can't search this place on ixigo itself, so the card opens ixigo's ${page.noun} page, to search it there.`,
    tell_the_room:
      `Say in one short line that the card opens ixigo's ${page.noun} page, where they can search ${searchScope(kind, q)} and book it. ` +
      'Never name or suggest any other travel or booking site or app, and quote no prices or times.',
  };
}

/** What was searched, with the conditions people gave: "flights from Delhi to Goa on 2026-11-06, leaving after 6:00 pm". */
const searchName = (kind: TravelKind, q: TravelQuery): string => {
  const terms = asked(kind, q);
  return terms.length ? `${searchScope(kind, q)}, ${terms.join(', ')}` : searchScope(kind, q);
};

/** What a search answers the model, the same from the search tools and from a search started early. */
export interface SearchAnswer {
  search: string;
  count: number;
  summary: string;
  checked: string;
  results_id?: string;
  results?: Array<Record<string, unknown>>;
  /** The card the model may show: the results_id, the best three, a title. */
  card?: { results_id: string; option_numbers: number[]; title: string };
  note: string;
}

/**
 * A search's answer: the results saved as a set (so show_options builds its card from them), the summary built in code,
 * and the best ten in short. Options read without filters ixigo left off (unapplied) are the search without them, and
 * the summary and the note say so.
 */
export async function searchAnswer(kind: TravelKind, ask: TravelQuery, found: TravelSearch, tripId: string, d: { results: Pick<ResultsStore, 'save'>; now: () => Date }): Promise<SearchAnswer> {
  const q = answeredAs(ask, found);
  const left = found.unapplied?.length ? leftOff(found.unapplied) : null;
  const pick = leftToPick(ask, found);
  // The site's own list, when the ask named filters the site couldn't apply for want of it, and this read brought it;
  // never after a filtered page that didn't load (unapplied): searching with it again would wait on it again.
  const list = found.site && !found.site.listed && found.site.unknown.length > 0 && found.site.offers && !found.unapplied?.length ? found.site.offers : null;
  const scope = searchScope(kind, q);
  const terms = asked(kind, q);
  const search = searchName(kind, q);
  const before = found.found ?? found.results.length;
  const options = found.results.slice(0, 10).map(toResultOption);
  // Not read now (stays): ixigo's page didn't answer, and this is Go's earlier read of it, said first and dated.
  const age = ageText(found.checkedAt, d.now());
  const was = found.earlier ? `ixigo's page didn't answer just now, so this is Go's earlier read of it, checked ${age}. ` : '';
  const wasNote = found.earlier
    ? `Say plainly that ixigo didn't answer just now and these are from Go's read ${age}, never as fresh, and that they can see the latest on ixigo from the card. `
    : '';
  if (options.length === 0) {
    const near = found.nearest ?? [];
    const none = `${was}${before === 1 ? `The one ${scopeOf(kind, q, 1)} doesn't fit ${listOf(terms)}.` : `None of the ${before} ${scope} fits ${listOf(terms)}.`}`;
    // Stays: the nearest go on a card, each saying what it misses, so the group sees how near ixigo gets ("if fewer than
    // three fit, say so and show the nearest", the demo's villa).
    if (kind === 'stays' && near.length > 0) {
      const shown = near.map((n) => toResultOption(n.option));
      const set = await d.results.save({ tripId, optionKind: OPTION_KIND[kind], source: 'search', query: q, options: shown, checkedAt: found.checkedAt, ...(found.page ? { page: found.page } : {}) });
      noteRun(set.resultsId, tripId, found.runId);
      return {
        search,
        results_id: set.resultsId,
        checked: ageText(found.checkedAt, d.now()),
        count: 0,
        summary: `${none} The nearest: ${near.map((n, i) => `${i + 1}. ${optionLine(n.option)}, but ${listOf(n.misses)}`).join('; ')}.`,
        results: shown.map((o, i) => compactOption(i + 1, o, true)),
        card: { results_id: set.resultsId, option_numbers: shown.map((_, i) => i + 1), title: suggestTitle(kind, q) },
        note:
          wasNote +
          'None fits all of it. Show these nearest with show_options, and say in the line that none fits everything, keeping every condition in it, ' +
          `and what the nearest miss, as the summary says: never call them a fit. ${NO_HOMEWORK} ${CARD_LINE}`,
      };
    }
    const closest = near[0] ? ` Closest: ${optionLine(near[0].option)}, but ${listOf(near[0].misses)}.` : '';
    const summary = before === 0 ? `Nothing came back: there are no ${scope} at all.` : `${none}${closest}`;
    return {
      search,
      count: 0,
      checked: ageText(found.checkedAt, d.now()),
      summary,
      note: 'Nothing to show. Say what the summary says in one line, keeping every condition in it, and suggest loosening one thing.',
    };
  }
  // Fewer than three stays fit: the nearest of the rest are saved after them, numbered on, for the same card.
  const besides = kind === 'stays' ? (found.nearest ?? []) : [];
  const saved = [...options, ...besides.map((b) => toResultOption(b.option))];
  const set = await d.results.save({ tripId, optionKind: OPTION_KIND[kind], source: 'search', query: q, options: saved, checkedAt: found.checkedAt, ...(found.page ? { page: found.page } : {}) });
  noteRun(set.resultsId, tripId, found.runId);
  const fit = found.results.length;
  // A train comes back once a class: the summary counts trains, and says how many fares by class they hold. The list
  // before the conditions is counted in fares, so a train list with conditions gives no "of the".
  const trainList = kind === 'trains';
  const n = trainList ? new Set(found.results.map((o) => o.journey?.number ?? o.title)).size : fit;
  const byClass = n === fit ? '' : ` (${counted(fit, 'fare', 'fares')} by class)`;
  const prices = priceRange(options);
  const areas = kind === 'stays' ? [...new Set(options.map(areaOf))] : [];
  const fits = n === 1 ? 'fits' : 'fit';
  const summary =
    was +
    `${
      terms.length
        ? trainList
          ? `${n} ${scopeOf(kind, q, n)} ${fits} ${listOf(terms)}${byClass}`
          : `${n} of the ${before} ${scopeOf(kind, q, before)} ${fits} ${listOf(terms)}`
        : `${n} ${scopeOf(kind, q, n)}${byClass}`
    }` +
    `${prices ? `: ${prices}` : ''}${areas.length ? `, in ${listOf(areas)}` : ''}.` +
    `${fit > options.length ? ` The best ${options.length} are below.` : ''}` +
    `${left ? ` ${left}.` : ''}` +
    `${found.cut ? ` ixigo's list came cut short: these are from the first ${before} it sent, not all of them.` : ''}` +
    `${pick.length ? ` Not filtered by ixigo, for you to pick from each option's amenities and details: ${listOf(pick)}.` : ''}` +
    `${list ? ` ixigo's own filters for this place, now known: ${list}.` : ''}` +
    `${besides.length ? ` The nearest of the rest, saved after them: ${besides.map((b, i) => `${options.length + i + 1}. ${optionLine(b.option)}, but ${listOf(b.misses)}`).join('; ')}.` : ''}`;
  return {
    search,
    results_id: set.resultsId,
    checked: ageText(found.checkedAt, d.now()),
    count: options.length,
    summary,
    results: options.map((o, i) => compactOption(i + 1, o, pick.length > 0)),
    card: { results_id: set.resultsId, option_numbers: saved.slice(0, 3).map((_, i) => i + 1), title: suggestTitle(kind, q) },
    note:
      wasNote +
      (besides.length
        ? `Only ${counted(options.length, 'stay fits', 'stays fit')}: show ${options.length === 1 ? 'it' : 'them'} first and the nearest after on the same card, and say plainly which fit and what the others miss, as the summary says. `
        : '') +
      'To show options, call show_options with this results_id. Quote prices only from these results, and say how long ago they were checked when it is not just now. ' +
      "Each option's area, time and price are as given here: name no other, and say no count the summary does not give. " +
      'If someone asked for a place an option is not in, say the option\'s own area: asked for Calangute, a villa in Vagator is in Vagator. ' +
      `${left ? `Say in the line that ${left}. ` : ''}` +
      `${found.cut ? `Say in the line that these are from the first ${before} ixigo sent, and the whole list is on ixigo's page. ` : ''}` +
      (pick.length
        ? `Show the options whose amenities or details fit ${listOf(pick)}, the best three when there are three, best first, and say which part ixigo filtered and which you picked; ` +
          "a want the data can't show (quiet) is no reason to show fewer: pick on what it does show and say plainly what ixigo doesn't tell. " +
          'If none clearly fits, say so and show the closest. ' +
          (list ? "If one of ixigo's own filters is what was asked, you may search again with it in site_filters. " : '')
        : '') +
      `${NO_HOMEWORK} ${CARD_LINE}`,
  };
}

/**
 * Two or more searches in one reply come back together, so their tally is said once, in code: how many came back with
 * options, and which found nothing or failed. Prose about "the three lists" can then only count what came back.
 */
export function searchRoundSummary(results: Array<{ content: string; isError: boolean }>): string | null {
  const came: string[] = [];
  const nothing: string[] = [];
  const failed: string[] = [];
  for (const r of results) {
    let out: { search?: string; count?: number; error?: string } = {};
    try {
      out = JSON.parse(r.content) as typeof out;
    } catch {
      // A thrown tool comes back as its message: it failed.
    }
    const name = out.search ?? 'one search';
    if (r.isError || out.error) failed.push(name);
    else if ((out.count ?? 0) > 0) came.push(`${name} (${out.count})`);
    else nothing.push(name);
  }
  const lines = [`${came.length} of ${results.length} searches came back with options${came.length ? `: ${came.join('; ')}` : ''}.`];
  if (nothing.length) lines.push(`Nothing came back for ${nothing.join('; ')}.`);
  if (failed.length) lines.push(`Failed: ${failed.join('; ')}.`);
  lines.push('Count only what came back.');
  return lines.join(' ');
}

const SEARCH_RULE = 'Put every constraint people gave into the arguments: Go applies them to the results itself.';

/**
 * The call is Go's, and so is the maths (real model, staging, 10 Oct: "Priya, check the per-head split against your 8k",
 * "Meher, does this feel quiet enough?").
 */
const NO_HOMEWORK =
  "Never hand the work back to the group: no maths for them to check (each stay's share a head is on the card, worked out by Go) and no " +
  '"does this work for you?" about whether an option fits: you make that call from the results and say it.';

const ShowArgs = z.object({
  results_id: z.string().min(3).max(64),
  option_numbers: z.array(z.int().min(1).max(10)).min(1).max(5).optional().describe('From the results, best first. Default: the first three.'),
  title: z.string().min(1).max(80),
  line: CardLineArg,
});

const VoteArgs = z.object({
  card_id: z
    .string()
    .min(3)
    .max(64)
    .optional()
    .describe('The options card to vote on. Leave it out to vote on the options card you show in this same reply.'),
  question: z.string().min(3).max(200).optional(),
  closes_in_hours: z.number().min(0.5).max(72).optional(),
  anonymous: z.boolean().optional().describe('true for a secret ballot, only when someone asks for a secret or anonymous vote. Leave it out otherwise.'),
  line: CardLineArg,
});

export function travelTools(d: TravelToolDeps): QuickTool<any>[] {
  const searchFlights: QuickTool<z.infer<typeof FlightsArgs>> = {
    name: 'search_flights',
    description:
      `Searches flights on one date. ${SEARCH_RULE} For example depart_after "18:00" when someone cannot leave before 6 pm. ` +
      "ixigo's own flight filters for the route, once a search of it has run, are in your context: the ones the ask means go in site_filters, by their names there.",
    input: FlightsArgs,
    run: (a, ctx) => runSearch('flights', askedTravellers(flightsQuery(a), ctx), ctx, d),
    summarizeRound: searchRoundSummary,
    timeoutMs: SEARCH_TOOL_MS,
  };
  const searchTrains: QuickTool<z.infer<typeof JourneyArgs>> = {
    name: 'search_trains',
    description: `Searches trains on one date, one fare per class. ${SEARCH_RULE}`,
    input: JourneyArgs,
    run: (a, ctx) => runSearch('trains', journeyQuery(a), ctx, d),
    summarizeRound: searchRoundSummary,
    timeoutMs: SEARCH_TOOL_MS,
  };
  const searchBuses: QuickTool<z.infer<typeof BusesArgs>> = {
    name: 'search_buses',
    description: `Searches buses on one date. ${SEARCH_RULE} A pickup or drop point the group named goes in board_at or drop_at.`,
    input: BusesArgs,
    run: (a, ctx) => runSearch('buses', busesQuery(a), ctx, d),
    summarizeRound: searchRoundSummary,
    timeoutMs: SEARCH_TOOL_MS,
  };
  const searchStays: QuickTool<z.infer<typeof StaysArgs>> = {
    name: 'search_stays',
    description:
      `Searches ixigo's stays for check-in and check-out dates: every kind (hotels, resorts, homestays, villas), unless the ask names one. ${SEARCH_RULE} ` +
      "ixigo's own filters for the place, once Go has read them, are in your context: the ones the ask means go in site_filters, and the rest of the ask in wants, which you pick from the results. " +
      "Every part of the ask lands somewhere: a kind of stay they named goes in site_filters as ixigo's nearest stay type (a villa is an Entire house on ixigo), with their own word in wants; " +
      'a budget per person goes in max_price_per_person, never worked out by you. ' +
      'For a deep comparison (reviews, many sites), use start_task instead.',
    input: StaysArgs,
    run: (a, ctx) => runSearch('stays', staysQuery(a), ctx, d),
    summarizeRound: searchRoundSummary,
    timeoutMs: SEARCH_TOOL_MS,
  };
  const showOptions: QuickTool<z.infer<typeof ShowArgs>> = {
    name: 'show_options',
    description:
      'Shows an options card from a results_id (a search, or a finished job), with up to 5 option_numbers, best first, and a short title. ' +
      `The card goes out with your line and shows the checked prices, so never type prices yourself. ${CARD_LINE}`,
    input: ShowArgs,
    endsTurn: true,
    async run(a, ctx) {
      const set = await d.results.get(ctx.tripId, a.results_id);
      if (!set || set.options.length === 0) return { error: 'unknown_results', note: 'Search again, then show the new results.' };
      const numbers = [...new Set(a.option_numbers ?? set.options.slice(0, 3).map((_, i) => i + 1))].filter((n) => n <= set.options.length).slice(0, 5);
      if (numbers.length === 0) return { error: 'no_such_options', note: `Pick numbers from 1 to ${set.options.length}.` };
      const { cardId, shown } = await putUpCard(set, numbers, { title: a.title, line: a.line }, ctx, d);
      return { card_id: cardId, shown, checked: ageText(set.checkedAt, d.now()), note: 'The card goes out with your line.' };
    },
  };
  const putToVote: QuickTool<z.infer<typeof VoteArgs>> = {
    name: 'put_to_vote',
    description:
      'Opens a vote on the options of an options card Go showed (card_id), even a card with one option (that option or keep looking). ' +
      'Only this vote can be booked: never open_vote for options on a card. To show options and put them to a vote at once, ' +
      'call show_options and then this with no card_id, in the same reply. The vote card goes out with the line you give it. ' +
      `${CARD_LINE} Use it when the group should decide together. ` +
      'Set anonymous when someone asks for a secret or anonymous vote.',
    input: VoteArgs,
    endsTurn: true,
    async run(a, ctx) {
      // No card_id: the one options card shown earlier in this reply (the loop runs a reply of card tools in order).
      let cardId = a.card_id;
      if (!cardId) {
        const shown = ctx.cards.filter((c) => c.kind === 'options');
        if (shown.length !== 1) {
          return shown.length === 0
            ? { error: 'no_card', note: 'Show the options first with show_options in this reply, or give the card_id of a card shown before.' }
            : { error: 'which_card', note: `This reply showed ${shown.length} options cards: give the card_id of the one to vote on.` };
        }
        cardId = shown[0]!.card_id;
      }
      const r = await openVoteFromCard(
        { results: d.results, link: ctx.link, now: d.now },
        {
          tripId: ctx.tripId,
          cardId,
          key: ctx.turnId,
          requestId: ctx.stableId('go_vote'),
          voteCardId: ctx.stableId('c_vote'),
          ...(a.question ? { question: a.question } : {}),
          ...(a.closes_in_hours ? { closesInHours: a.closes_in_hours } : {}),
          ...(a.anonymous ? { anonymous: true } : {}),
        },
      );
      if (!r.ok) return { error: r.reason, ...(r.decisionId ? { decision_id: r.decisionId } : {}) };
      ctx.cards.push(r.voteCard);
      ctx.lines.push(a.line);
      return { decision_id: r.decisionId, note: 'The vote card goes out with your line.' };
    },
  };
  return [searchFlights, searchTrains, searchBuses, searchStays, showOptions, putToVote];
}
