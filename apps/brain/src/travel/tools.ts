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
import { buildOptionsCard, clip, formatInr, ixigoPage, PERSONAL_KINDS, placeKindNotAll, stayNight, stayNote, stayWhole, subtitleFor } from './cards.js';
import { localDay } from '../proactive/clock.js';
import { answerLine, answerTitle, directPicks, droppedWords, ledBy, leftOff, loadWhat, plainAsk } from './answer.js';
import { flightDetails, stayDetails, trainDetails } from './details.js';
import { guideName, placeDetails, type PlacePick } from './places-card.js';
import { DEFAULT_TRIP_TZ } from './dates.js';
import { asked } from './filters.js';
import { stableId } from './ids.js';
import { nearStay, type GroupStay } from './group-stay.js';
import type { Images } from './images.js';
import { guestsIn } from './recipes/ask.js';
import { TRAVEL_WAIT_MS } from './recipes/backend.js';
import { TravelError } from './mcp-travel.js';
import { photosOf } from './photos.js';
import type { TopPick } from './pick-photos.js';
import { toResultOption, unseenNumbers, type OptionKind, type ResultOption, type ResultSet, type ResultsStore } from './results.js';
import type { SearchWake } from './search-wake.js';
import { Clock, MUST_HAVES, type Travel, type TravelKind, type TravelOption, type TravelQuery, type TravelSearch } from './travel.js';
import { notLoadedLine, stillNotLoadedLine, TRIES, tryAgain, waitFor } from './try-again.js';
import { openVoteFromCard, VOTE_MOST } from './votes.js';

export interface TravelToolDeps {
  /**
   * The group's decided budget for the stay, per person, in paise, or null (trip-budget.ts): a stays search takes ixigo's
   * own price bands by it. Absent, no search does.
   */
  stayBudget?: (tripId: string) => Promise<number | null>;
  travel: Travel;
  results: ResultsStore;
  images: Images;
  now: () => Date;
  /** Where a search that outlives its turn wakes Go with its options; without it, every search is waited for. */
  desk?: Pick<Desk, 'put'>;
  /** When ixigo's own quiet on a search's page ends (it refused one), or null: Go's try again waits past it (try-again.ts). */
  ixigoQuiet?: (kind: TravelKind, q: TravelQuery) => number | null;
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
  /**
   * more: a stays card's next options (2 and 3), whose own pages are read after the top pick's, in the background and one
   * at a time, so each has its labelled photos and rooms too (the Server team's rev 5, R1).
   */
  showPick?: (tripId: string, pick: TopPick, more?: TopPick[]) => void;
  /** A place card's first places, given their own place and guide in the background (places-card.ts showPlaces, rev 5 R2). */
  showPlaces?: (tripId: string, picks: PlacePick[]) => void;
  /**
   * A place's own cover from ixigo's guide (placeFor, already in Go's image cache), for a place the explorer gave no photo:
   * waited for in parallel, up to COVER_WAIT_MS, before its card goes up. Null when ixigo has none: never a made-up one.
   */
  placeCover?: (tripId: string, name: string) => Promise<string | null>;
  /** Where the group stays, with its position (group-stay.ts): each bus's nearest drop to it. Absent, none is said. */
  groupStay?: (tripId: string) => Promise<GroupStay | null>;
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

/** A journey search's day: the one asked, else the trip's own, never a question back (p2's prod audit, 11 Oct #8). */
const DAY = "YYYY-MM-DD: the day asked, else the trip's own (its start, or its end for the way back). Never ask for it when the trip has one.";

export const FlightsArgs = z.object({
  from: Where.describe('City or airport code, e.g. "Delhi" or "DEL"; a city abroad with its airport code, e.g. "London (LHR)"'),
  to: Where.describe('City or airport code, e.g. "Goa" or "Dubai (DXB)"'),
  date: z.iso.date().describe(DAY),
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
    .describe("Anything else the group asked for that no argument here covers, in their words (a seat): you pick from the results' details, and say plainly what they can't show"),
});
export const JourneyArgs = z.object({
  from: Where.describe('City or station, e.g. "Jaipur"; for trains, a station with its Indian Railways code works too, e.g. "Udaipur City (UDZ)"'),
  to: Where.describe('City or station, e.g. "Goa"; for trains, a station with its code works too, e.g. "Madgaon (MAO)"'),
  date: z.iso.date().describe(DAY),
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
    .describe("In rupees: each person's share of the WHOLE stay, as in \"under 8k a head\" or \"15k each\" for the trip. Go divides each stay's total by the people and says the share"),
  max_price_per_person_per_night: Rupees.optional()
    .describe("In rupees: each person's share a NIGHT, as in \"8k a head a night\". Go works out the whole stay's share from the nights; never both this and max_price_per_person"),
  must_have: z.array(z.enum(MUST_HAVES)).max(5).optional()
    .describe("pool, beach (10 minutes or less), breakfast, free_cancellation. When ixigo's own filters for the place are in your context, use them in site_filters instead, and must_have only for the beach"),
  min_rating: z.number().min(0).max(5).optional()
    .describe("Guests' rating out of 5 (a stay's rating), never stars: \"5 star\" is ixigo's Star Rating 5 in site_filters"),
  site_filters: z.array(z.string().min(1).max(80)).max(8).optional()
    .describe(
      "ixigo's own filters the ask means, by their names on ixigo's list for the place (in your context), the nearest one for what they said: ixigo filters " +
        'the stays itself. "A pool" is the ordinary Swimming Pool; Private Pool only when they say private',
    ),
  site_sort: z.string().min(1).max(80).optional().describe("ixigo's own sort the ask means, by its name on that list"),
  wants: z.array(z.string().min(1).max(80)).max(8).optional()
    .describe(
      "Anything else the group asked for, in their words (a gym, a jacuzzi): ixigo filters it itself when one of its own filters means it " +
        "(a gym is its Fitness Centre), and the rest you pick from the results' amenities and details",
    ),
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

/** The nights between check-in and check-out (YYYY-MM-DD), at least one. */
const nightsOf = (checkIn: string, checkOut: string): number =>
  Math.max(1, Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000));

export function staysQuery(a: z.infer<typeof StaysArgs>): TravelQuery {
  return {
    area: a.area,
    checkIn: a.check_in,
    checkOut: a.check_out,
    ...(a.guests ? { guests: a.guests } : {}),
    ...(a.max_price_per_night ? { maxPriceMinor: toPaise(a.max_price_per_night) } : {}),
    ...(a.max_price_per_person ? { maxShareMinor: toPaise(a.max_price_per_person) } : {}),
    // A budget a head a night is the whole stay's share over its nights, worked out here, never by the model: the band
    // cap then divides the whole stay by the nights once (engine siteOf), never a night's budget again.
    ...(a.max_price_per_person_per_night && !a.max_price_per_person ? { maxShareMinor: toPaise(a.max_price_per_person_per_night) * nightsOf(a.check_in, a.check_out) } : {}),
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
  // A stay's price as its card says it: the whole stay and each person's share, the night after (stayWhole).
  const whole = o.kind === 'stay' ? stayWhole(o) : null;
  const night = whole ? stayNight(o) : null;
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
    ...(whole
      ? { price: whole, ...(night ? { a_night: night } : {}) }
      : o.priceMinor !== undefined ? { price: `${formatInr(o.priceMinor)}${o.priceNote ? ` ${o.priceNote}` : ''}` } : {}),
    ...(!whole && o.totalMinor !== undefined && nights ? { total: `${formatInr(o.totalMinor)} for ${nights} nights` } : {}),
    ...(o.rating !== undefined ? { rating: o.rating } : {}),
    // A stay's stars are ixigo's own, never its guests' rating out of 5 (p2's audit, 11 Oct).
    ...(o.kind === 'stay' && typeof o.facts.stars === 'number' ? { stars: o.facts.stars } : {}),
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
  // A stay's whole price first, as its card says it, its night in brackets: "₹29,400 for 3 nights (₹9,800 a night)".
  const whole = o.kind === 'stay' ? stayWhole(o) : null;
  const night = whole ? stayNight(o) : null;
  return `${o.title}${where}${when}, ${whole ? `${whole}${night ? ` (${night})` : ''}` : `${formatInr(o.priceMinor)}${o.priceNote ? ` ${o.priceNote}` : ''}`}`;
}

/** The lowest to the highest price the results show, with what the price covers. */
function priceRange(options: ResultOption[]): string | null {
  // Stays as their cards say them: the whole stays, and what they cover (stayWhole), never a night's.
  const totals = options.flatMap((o) => (o.kind === 'stay' && o.totalMinor !== undefined ? [o.totalMinor] : []));
  if (totals.length > 0 && totals.length === options.length) {
    const [low, high] = [Math.min(...totals), Math.max(...totals)];
    return `${low === high ? formatInr(low) : `${formatInr(low)} to ${formatInr(high)}`} ${stayNote(options[0]!)}`;
  }
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
const upperFirst = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/**
 * Every search answers with a summary built in code: how many it found and how many fit, the conditions people gave, the
 * prices and the stays' areas. When nothing fits it names the conditions and the nearest misses (stays: on a card), so a
 * line about it can never drop one ("no pool villa under ₹10,000", not "nothing under ₹10,000").
 */
async function runSearch(kind: TravelKind, given: TravelQuery, ctx: TurnCtx, d: TravelToolDeps): Promise<unknown> {
  // A search starting is travel intent: the trip's computer stays awake for the follow-ups too.
  d.warmForTravel?.(ctx.tripId, kind);
  // Stays: the ask's own budget a head, else the group's decided one, picks ixigo's own price bands for the read (one band
  // over kept, and the search without them when they hold nothing: backend.ts). Never a guessed budget.
  const decided = kind === 'stays' ? (given.maxShareMinor ?? (d.stayBudget ? await d.stayBudget(ctx.tripId).catch(() => null) : null)) : null;
  const q: TravelQuery = decided ? { ...given, budgetMinor: decided } : given;
  // Buses: each one's nearest drop to the group's stay, for this trip only (the read itself is shared across trips).
  const stay = kind === 'buses' && d.groupStay ? d.groupStay(ctx.tripId).catch(() => null) : null;
  const pending = d.travel.search(kind, q, { tripId: ctx.tripId, turnId: ctx.turnId }).then(async (f) => (stay ? nearStay(f, await stay) : f));
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
    // Not loaded, or no answer: Go tries again by itself and says so, never "offer to try again" (Keshav, 11 Oct: "make it
    // a proper travel agent… why this whining").
    if (err instanceof TravelError && TRY_AGAIN_CODES.has(err.code)) return notLoadedAnswer(kind, q, ctx, d, plainAsk(kind, q, { wake: ctx.wake, pack: ctx.pack, ...(ctx.roundTools ? { roundTools: ctx.roundTools } : {}), today: await todayOf(d, ctx.tripId) }).ok);
    if (err instanceof TravelError && err.code === 'unknown_place') return placeAnswer(kind, q, err.message);
    // A date in the past is the model's slip (usually the year), not news for the room: search again with the date it names.
    if (err instanceof TravelError && err.code === 'past_date') return { search, count: 0, refused: err.message, tell_the_room: SAY_NOTHING };
    if (err instanceof TravelError) {
      return {
        search, count: 0, error: err.code, note: clip(err.message, 200), summary: `This search failed (${err.code}): nothing came back for ${search}, so there is no list for it.`,
        // Never a job for it (staging, 9 Oct: a refused stays search became start_task, a slow job on a blank page).
        tell_the_room: "Say in one short line what didn't work, and do the nearest thing you can now (another date, place or kind), never only an offer to try again. Never start_task for it: the search tools are how Go searches ixigo.",
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
/**
 * A saved set's picked options as a card shows them, numbered on the card: each option's sheet (contract 1.1 details)
 * from what the search read, a stay's photos through Go's image cache. people: who the trip is for, for a sheet's prices.
 */
export async function cardPicks(set: ResultSet, numbers: number[], cardId: string, people: number, d: Pick<TravelToolDeps, 'images' | 'placeCover'>) {
  const query = set.query as TravelQuery;
  return Promise.all(
    numbers.map(async (n, i) => {
      const option = set.options[n - 1]!;
      // A stay's photos from the search, with no labels (ixigo's list gives none): the top pick's labelled ones replace
      // them once its own page is read (pick-photos.ts). The sheet's gallery stays for an App before 10 Oct's B3.
      const photos = set.optionKind === 'stay' ? await photosOf(option.imageUrls ?? [], d.images) : [];
      const gallery = photos.map((p) => p.url);
      const details = set.optionKind === 'stay'
        ? stayDetails(option, query, people, gallery)
        : set.optionKind === 'train' ? trainDetails(option) : set.optionKind === 'flight' ? flightDetails(option, people) : set.optionKind === 'place' ? placeDetails(option) : null;
      // A place goes up with its real cover (Saket, 11 Oct: never the App's drawing): the explorer's own photo, else its
      // guide's, waited for a little; a place with neither goes up without one.
      const imageUrl = option.imageUrl
        ? await d.images.rehostUrl(option.imageUrl)
        : set.optionKind === 'place' && d.placeCover ? await coverWithin(d.placeCover(set.tripId, option.title)) : null;
      return {
        n: i + 1, optionId: stableId('opt', cardId, i + 1), option, imageUrl,
        ...(details ? { details } : {}),
        ...(photos.length ? { photos } : {}),
      };
    }),
  );
}

/** How long a place card waits for a place's cover from its guide, every place at once, before it goes up without one. */
export const COVER_WAIT_MS = 2_500;

const coverWithin = (cover: Promise<string | null>): Promise<string | null> =>
  Promise.race([cover.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), COVER_WAIT_MS).unref())]);

/**
 * How many options a card shows, and each "See more" after it (Keshav, 11 Oct: "show 10 then see more button, and on
 * click 10 more etc").
 */
export const CARD_SHOWS = 10;
/** How many of a search's options its set keeps, for the cards after the first ("See more", taps.ts). */
const KEPT = 50;
/** ixigo's stays list sends 10 stays a page (hotels.search). */
const STAYS_PAGE = 10;

/**
 * A card's numbers in a set: the picks first, in their order (the model's, or Go's own for a search that answers itself),
 * then the set's options no card has shown (shown: results.shownFrom), in its order, to CARD_SHOWS. The picks set the
 * order and the line, never how many the card shows. No picks: the set's first, as they come.
 */
export function cardNumbers(set: Pick<ResultSet, 'options'>, picks: readonly number[], shown: ResultOption[] = []): number[] {
  const total = set.options.length;
  const first = [...new Set(picks)].filter((n) => Number.isInteger(n) && n >= 1 && n <= total);
  if (first.length === 0) return set.options.slice(0, CARD_SHOWS).map((_, i) => i + 1);
  return [...first, ...unseenNumbers(set, shown).filter((n) => !first.includes(n))].slice(0, CARD_SHOWS);
}

/**
 * ixigo has more of a stays search than this read: it read one page, and the page was full (listed, before a half of
 * Goa was kept). A card's "See more" reads the next page once the set's own are shown (results.siteMore).
 */
const siteMoreOf = (kind: TravelKind, found: TravelSearch): boolean =>
  kind === 'stays' && !found.earlier && found.listed !== undefined && found.listed >= STAYS_PAGE && found.listed < 2 * STAYS_PAGE;

/** The vote a shared thing's card opens with, as show_options asks for it: each left out takes the vote's own default. */
export type CardVote = { question?: string; closesInHours?: number; anonymous?: boolean };

/** picked: the options to show first, by their numbers in the set; the card shows 10 (cardNumbers). */
export async function putUpCard(
  set: ResultSet,
  picked: number[],
  given: { title: string; line: string; vote?: CardVote },
  ctx: TurnCtx,
  d: Pick<TravelToolDeps, 'results' | 'images' | 'showPick' | 'showPlaces' | 'placeCover' | 'log'> & { now?: () => Date },
): Promise<{ cardId: string; shown: number; decisionId: string | null }> {
  const cardId = ctx.stableId('c_opt');
  const run = runOfSet.get(set.resultsId);
  if (run) remember(shownRuns, run);
  const before = await d.results.shownFrom(ctx.tripId, set.resultsId);
  const numbers = cardNumbers(set, picked, before);
  const picks = await cardPicks(set, numbers, cardId, (set.query as TravelQuery).guests ?? ctx.pack?.trip?.people?.length ?? 0, d);
  const title = stayCardTitle(given.title, set.query, picks.map((p) => p.option));
  // "See more" while the search has more than the cards show: the set's own, or ixigo's next page (siteMore).
  const more = !!set.siteMore || unseenNumbers(set, [...before, ...picks.map((p) => p.option)]).length > 0;
  // A ticket's card has it from the start, with "I'll take this"; a shared thing's once its vote is open, below.
  const personal = PERSONAL_KINDS.has(set.optionKind);
  const card = buildOptionsCard({ cardId, title, optionKind: set.optionKind, checkedAt: set.checkedAt, picks, ...(personal && more ? { more: true } : {}) });
  await d.results.saveCard({ cardId, tripId: ctx.tripId, resultsId: set.resultsId, title: card.title, optionKind: set.optionKind, card }, picks, set.checkedAt);
  // A rerun of the same turn finds this card id saved already: it shows the card saved first, which its stored offers match.
  let shown = (await d.results.card(ctx.tripId, cardId))?.card ?? card;
  // A shared thing's card is its vote (rev 5 R5): the vote opens before the card goes up, so the App draws Vote on each
  // option from the start, and the card has "See more" while its search has more to show (R4). A rerun keeps its vote.
  // A vote that can't open leaves the card without one, for put_to_vote after.
  if (!personal && picks.length >= 2 && !shown.decision_id) {
    const voted = await openVoteFromCard(
      { results: d.results, link: ctx.link, now: d.now ?? (() => new Date()) },
      // Its ids from the card, so a rerun that skips an earlier card's vote never gives this one that card's request.
      { tripId: ctx.tripId, cardId, key: ctx.turnId, requestId: stableId('go_vote', cardId), voteCardId: stableId('c_vote', cardId), onCard: true, ...given.vote },
    ).catch((err: unknown) => {
      d.log?.warn({ err: String(err).slice(0, 200), cardId }, 'travel: a card went up without its vote');
      return null;
    });
    // See more only while the vote has room: a card that joined the open vote (votes.ts) may have filled it.
    if (voted && voted.ok) shown = (await d.results.setCardDecision(ctx.tripId, cardId, voted.decisionId, more && (voted.size ?? 0) < VOTE_MOST)) ?? shown;
  }
  ctx.cards.push(shown);
  ctx.lines.push(given.line);
  // The top pick on the stage once its card is up, the room watching Go open it: a stay's own page, a bus's seat layout
  // (its stops and cancellation, kept for "where do we board"). A bus's address carries its operator and time after "#".
  // Its card and option go with it, so a stay's page's photos can replace the search's there (pick-photos.ts).
  const top = set.optionKind === 'stay' || set.optionKind === 'bus' ? ixigoPage(picks[0]?.option.sourceUrl ?? null) : null;
  if (top && (set.optionKind === 'stay' || top.includes('#'))) {
    const more = set.optionKind === 'stay'
      ? picks.slice(1, 3).flatMap((p) => {
          const page = ixigoPage(p.option.sourceUrl ?? null);
          return page ? [{ page, name: p.option.title, kind: 'stay' as const, cardId, optionId: p.optionId }] : [];
        })
      : [];
    d.showPick?.(ctx.tripId, { page: top, name: picks[0]!.option.title, kind: set.optionKind === 'bus' ? 'bus' : 'stay', cardId, optionId: picks[0]!.optionId }, more);
  }
  // A place card's first three: each one's own place and guide, read in the background after the card is up (rev 5 R2).
  if (set.optionKind === 'place') d.showPlaces?.(ctx.tripId, picks.slice(0, 3).map((p) => ({ cardId, optionId: p.optionId, name: p.option.title, guide: guideName(p.option) })));
  return { cardId, shown: shown.options.length, decisionId: shown.decision_id ?? null };
}

/**
 * A finished search that answers the turn's plain ask itself: its list saved, 10 on a card (the engine's order: the
 * first 10 stays; the three cheapest journeys, then the rest as listed), and a line built from its data. The turn ends on them, with no
 * model round after the search. Each option carries its own ixigo page, as on any card; stays go up as their vote. lead goes
 * before the line ("Already on ixigo: pool stays in…", a watch that is already so). Options read without filters ixigo
 * left off (unapplied) are saved and titled as searched without them, and the line says so first.
 */
export async function answerItself(
  kind: TravelKind,
  q: TravelQuery,
  found: TravelSearch,
  ctx: TurnCtx,
  d: Pick<TravelToolDeps, 'results' | 'images' | 'log'> & { now?: () => Date },
  lead?: string,
): Promise<unknown> {
  const searched = answeredAs(q, found);
  const options = found.results.slice(0, KEPT).map(toResultOption);
  const set = await d.results.save({
    tripId: ctx.tripId, optionKind: OPTION_KIND[kind], source: 'search', query: searched, options, checkedAt: found.checkedAt, ...(found.page ? { page: found.page } : {}),
    ...(siteMoreOf(kind, found) ? { siteMore: true } : {}),
  });
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
  // A want the site's own filter covered (a gym, as its Fitness Centre) is filtered, never the model's to pick.
  const wanted = found.site?.wanted ?? [];
  return [...new Set([...notApplied, ...(q.wants ?? []).filter((w) => !wanted.includes(w))])];
}

/** What goes before the card's line of a search ixigo left filters off: "ixigo's pool filter didn't load in time, …: ". */
const leftOffLead = (found: TravelSearch): string | undefined => {
  const said = [...(found.unapplied?.length ? [leftOff(found.unapplied)] : []), ...(found.dropped?.length ? [droppedWords(found.dropped)] : [])];
  return said.length > 0 ? `${said.join('; ')}: ` : undefined;
};

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
 * A try again Go promised (try-again.ts) comes here too, as try `tryNo` of the search keyed fallbackId.
 */
export function handOver(
  kind: TravelKind,
  q: TravelQuery,
  pending: Promise<TravelSearch>,
  o: { tripId: string; fallbackId: string; tryNo?: number },
  d: Pick<TravelToolDeps, 'desk' | 'now' | 'log' | 'ixigoQuiet'> & { results: Pick<ResultsStore, 'save'> },
): void {
  const desk = d.desk;
  if (!desk) return;
  const wake = (id: string, payload: SearchWake): Promise<void> => desk.put({ id, tripId: o.tripId, kind: 'search', ref: kind, dueAt: d.now(), payload });
  pending
    .then(
      async (found) => {
        // A run a card already showed for this ask (its own turn, or the head start it shared) wakes nothing. An earlier
        // read standing in for a page that failed answers a new ask, however often it was shown: it always wakes (the exam,
        // 10 Oct: the second stays ask got the first one's read back, already shown, and the room stayed on "On it.").
        if (found.runId && !found.earlier && shownRuns.has(`${o.tripId}:${found.runId}`)) return;
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
        const failed = { source: 'travel_search', search: searchName(kind, q), count: 0, resultsId: null, summary: '', error: code } as const;
        if (!TRY_AGAIN_CODES.has(code)) return wake(`search:${o.tripId}:${o.fallbackId}:failed`, failed);
        // ixigo didn't load it (flights held back or refused, stays with no earlier read): never its link card. The next
        // try goes on the desk; the room hears it now when this was the first, with no turn of its own to say it, and Go's
        // last word when this was the last try.
        const n = o.tryNo ?? 0;
        const what = loadWhat(kind, q);
        if (n === 0) {
          const wait = await tryAgain({ ...d, desk }, o.tripId, kind, { key: o.fallbackId, what, n: 1, query: q });
          await wake(`search:${o.tripId}:${o.fallbackId}:not_loaded`, { ...failed, line: notLoadedLine(what, wait) });
        } else if (n < TRIES) await tryAgain({ ...d, desk }, o.tripId, kind, { key: o.fallbackId, what, n: n + 1, query: q });
        else await wake(`search:${o.tripId}:${o.fallbackId}:gave_up`, { ...failed, line: stillNotLoadedLine(what) });
      },
    )
    .catch((err: unknown) => d.log?.warn({ err, tripId: o.tripId, kind }, 'travel: a search that outlived its turn could not wake Go'));
}

/**
 * The ways a search fails that Go tries again by itself (try-again.ts): ixigo didn't load it, or didn't answer (a timeout,
 * a busy computer, Cloudflare's check). A refusal (something Go's computer can't do) is said, never tried again.
 */
const TRY_AGAIN_CODES = new Set<string>(['link_only', 'unreachable']);

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

/**
 * ixigo didn't load this search for Go (link_only: flights held back or refused, stays with no earlier read): never its
 * link card (G1, 11 Oct). Go says so plainly and tries again in a minute (try-again.ts), and the card goes up by itself
 * when a try lands. A plain ask's line is the turn's answer, as a card's would be.
 */
async function notLoadedAnswer(kind: TravelKind, q: TravelQuery, ctx: TurnCtx, d: TravelToolDeps, plain: boolean): Promise<unknown> {
  const what = loadWhat(kind, q);
  const try1 = { key: stableId('search', ctx.turnId, searchName(kind, q)), what, n: 1, query: q };
  const line = notLoadedLine(what, d.desk ? await tryAgain({ ...d, desk: d.desk }, ctx.tripId, kind, try1) : waitFor(d, kind, q));
  if (plain) {
    ctx.lines.push(line);
    ctx.answered = true;
  }
  return {
    search: searchName(kind, q),
    count: 0,
    not_loaded: true,
    note: `ixigo didn't load this search for Go just now. Go tries it again in the background, up to ${TRIES} times (as the line says when), and its card goes up by itself when a try lands.`,
    tell_the_room: `Say only this, in one line: "${line}" Never send or offer a link, never name another site, never say there are none, and quote no prices or times.`,
  };
}

/** What ixigo calls a place each kind of search starts or ends at, for the line about one it doesn't know. */
const STOP_WORDS: Record<TravelKind, string> = { flights: 'an airport', trains: 'a station', buses: 'a stop', stays: 'a place to stay' };

/**
 * A place Go has no ixigo code for (unknown_place): said in words, never ixigo's own search page as the answer (the lead,
 * 11 Oct, with G1). The model reads a fact and the next step: the place ixigo doesn't know, then the nearest place it does,
 * offered as a question to search from there.
 */
function placeAnswer(kind: TravelKind, q: TravelQuery, why: string): unknown {
  return {
    search: searchName(kind, q),
    count: 0,
    unknown_place: `${clip(why, 140)} Offer the nearest place ixigo knows as ${STOP_WORDS[kind]}, and ask whether to search from there.`,
    tell_the_room:
      `Say in one short line which place ixigo doesn't know as ${STOP_WORDS[kind]} (unknown_place), name the nearest place to it ixigo would ` +
      "know (a city with an airport, a station or a bus stand, or a known stay area), and ask whether to search from there: \"ixigo doesn't " +
      'know Kasol as a stop; the nearest it knows is Bhuntar. Search from there?" Never send them to ixigo. Never name or suggest any other travel or ' +
      'booking site or app, and quote no prices or times.',
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
  /** The card the model may show: the results_id, the first 10, a title. */
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
  const dropped = found.dropped?.length ? droppedWords(found.dropped) : null;
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
    ? `Say plainly that ixigo didn't answer just now and these are from Go's read ${age}, never as fresh. `
    : '';
  if (options.length === 0) {
    const near = found.nearest ?? [];
    // The limit that alone left every one out, said as it is (the exam, 10 Oct: "no AC sleeper", where it was the time).
    const cut = found.missedByAll ?? [];
    const cutWords = cut.length === 1 ? ` ${upperFirst(cut[0]!)} alone leaves out every one.` : cut.length > 1 ? ` Each of ${listOf(cut)} alone leaves out every one.` : '';
    const none = `${was}${before === 1 ? `The one ${scopeOf(kind, q, 1)} doesn't fit ${listOf(terms)}.` : `None of the ${before} ${scope} fits ${listOf(terms)}.`}${cutWords}`;
    // The nearest go on a card, each saying what it misses, so the group sees how near ixigo gets ("if fewer than three
    // fit, say so and show the nearest", the demo's villa; a bus or a train the same, the lead, 10 Oct).
    if (near.length > 0) {
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
          `the limit that alone left every one out when the summary names one, and what the nearest miss, as the summary says: never call them a fit. ${NO_HOMEWORK} ${CARD_LINE}`,
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
  // Fewer than three stays fit: the nearest of the rest are saved after them, numbered on, for the same card. The rest of
  // the list after the first 10 are saved after those, for "See more" (KEPT); the model's list is the first 10.
  const besides = kind === 'stays' ? (found.nearest ?? []) : [];
  const saved = [...options, ...besides.map((b) => toResultOption(b.option)), ...found.results.slice(10, KEPT).map(toResultOption)];
  const set = await d.results.save({
    tripId, optionKind: OPTION_KIND[kind], source: 'search', query: q, options: saved, checkedAt: found.checkedAt, ...(found.page ? { page: found.page } : {}),
    ...(siteMoreOf(kind, found) ? { siteMore: true } : {}),
  });
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
    `${dropped ? ` ${upperFirst(dropped)}.` : ''}` +
    `${found.cut ? ` ixigo's list came cut short: these are from the first ${before} it sent, not all of them.` : ''}` +
    `${found.notes?.length ? ` ${found.notes.join(' ')}` : ''}` +
    `${pick.length ? ` Not filtered by ixigo, for you to pick from each option's amenities and details: ${listOf(pick)}.` : ''}` +
    `${list ? ` ixigo's own filters for this place, now known: ${list}.` : ''}` +
    `${found.site?.priced ? ` ixigo filtered them by price for the group's budget: up to ${formatInr(found.site.priced * 100)} a night a room, and one band over.` : ''}` +
    `${besides.length ? ` The nearest of the rest, saved after them: ${besides.map((b, i) => `${options.length + i + 1}. ${optionLine(b.option)}, but ${listOf(b.misses)}`).join('; ')}.` : ''}`;
  return {
    search,
    results_id: set.resultsId,
    checked: ageText(found.checkedAt, d.now()),
    count: options.length,
    summary,
    results: options.map((o, i) => compactOption(i + 1, o, pick.length > 0)),
    card: { results_id: set.resultsId, option_numbers: saved.slice(0, CARD_SHOWS).map((_, i) => i + 1), title: suggestTitle(kind, q) },
    note:
      wasNote +
      (found.nearStay
        ? `Each bus's first highlight is its nearest drop to ${found.nearStay}, in a straight line: say it with the stay and whose it is ("about 3 km from Casa Anjuna, the villa you voted for"), never a drive time. `
        : '') +
      (besides.length
        ? `Only ${counted(options.length, 'stay fits', 'stays fit')}: show ${options.length === 1 ? 'it' : 'them'} first and the nearest after on the same card, and say plainly which fit and what the others miss, as the summary says. `
        : '') +
      'To show options, call show_options with this results_id. Quote prices only from these results, and say how long ago they were checked when it is not just now. ' +
      "Each option's area, time and price are as given here: name no other, and say no count the summary does not give. " +
      'If someone asked for a place an option is not in, say the option\'s own area: asked for Calangute, a villa in Vagator is in Vagator. ' +
      `${left ? `Say in the line that ${left}. ` : ''}` +
      `${dropped ? `Say in the line that ${dropped}: they are the nearest, never a fit for it. ` : ''}` +
      `${found.cut ? `Say in the line that you picked these from the first ${before} ixigo sent, and offer to look at more. ` : ''}` +
      `${found.notes?.length ? "What ixigo itself offers for this list is in the summary: say it in one short line when it helps the ask (holding a fare while the group decides, a budget), as ixigo's to set, never Go's. " : ''}` +
      (pick.length
        ? `Show the options whose amenities or details fit ${listOf(pick)} first, best first (the card shows the rest of the results after them, 10 in all), and say which part ixigo filtered, which you picked, and that the ones after them don't say it; ` +
          "a want the data can't show (quiet) is no reason to show fewer: pick on what it does show and say plainly what ixigo doesn't tell, never that they should check it. " +
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
  "Never hand the work back to the group: no maths for them to check (each stay's share a head is on the card, worked out by Go), no " +
  '"does this work for you?" about whether an option fits, and never "check each one\'s amenities": you make that call from the results and say it.';

const ShowArgs = z.object({
  results_id: z.string().min(3).max(64),
  option_numbers: z.array(z.int().min(1).max(10)).min(1).max(10).optional().describe('Your picks from the results, best first: the card shows them first, then the rest in order, 10 in all. Default: the first 10.'),
  title: z.string().min(1).max(80),
  line: CardLineArg,
  // A shared thing's card is its vote (rev 5 R5): how that vote runs, only when someone asked.
  question: z.string().min(3).max(200).optional().describe("The vote's question, when a card of shared things should ask something other than the usual (\"Where do we stay?\")."),
  closes_in_hours: z.number().min(0.5).max(72).optional().describe('When the vote closes, only when someone asked for a time. Default: a day.'),
  anonymous: z.boolean().optional().describe('true for a secret ballot, only when someone asks for a secret or anonymous vote. Leave it out otherwise.'),
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
      "For a deep comparison on ixigo (its reviews and details of several stays), use start_task instead.",
    input: StaysArgs,
    run: (a, ctx) => runSearch('stays', staysQuery(a), ctx, d),
    summarizeRound: searchRoundSummary,
    timeoutMs: SEARCH_TOOL_MS,
  };
  const showOptions: QuickTool<z.infer<typeof ShowArgs>> = {
    name: 'show_options',
    description:
      'Shows an options card from a results_id (a search, or a finished job), and a short title. option_numbers are your picks, best first: ' +
      `the card shows them first, then the rest of the results in order, 10 in all (fewer when there are fewer), and See more brings the next 10. ` +
      `The card goes out with your line and shows the checked prices, so never type prices yourself. ${CARD_LINE} ` +
      'A card of shared things (stays, places, things to do) is the group\'s vote: each option has Vote on it from the start, and See more adds more of the same search. ' +
      'So never put_to_vote or open_vote for it; give question, anonymous or closes_in_hours here when someone asks. ' +
      "A ticket's card (flights, trains, buses) is each traveller's own pick, never a vote.",
    input: ShowArgs,
    endsTurn: true,
    async run(a, ctx) {
      const set = await d.results.get(ctx.tripId, a.results_id);
      if (!set || set.options.length === 0) return { error: 'unknown_results', note: 'Search again, then show the new results.' };
      // Picks that are none of the set's are a slip, never a card of the set's first 10.
      if (a.option_numbers?.length && !a.option_numbers.some((n) => n >= 1 && n <= set.options.length)) return { error: 'no_such_options', note: `Pick numbers from 1 to ${set.options.length}.` };
      const numbers = a.option_numbers ?? [];
      const vote: CardVote = {
        ...(a.question ? { question: a.question } : {}),
        ...(a.closes_in_hours ? { closesInHours: a.closes_in_hours } : {}),
        ...(a.anonymous ? { anonymous: true } : {}),
      };
      const { cardId, shown, decisionId } = await putUpCard(set, numbers, { title: a.title, line: a.line, vote }, ctx, d);
      return {
        card_id: cardId, shown, checked: ageText(set.checkedAt, d.now()),
        ...(decisionId ? { decision_id: decisionId } : {}),
        note: decisionId ? "The card goes out with your line, as the group's vote: each option has Vote on it." : 'The card goes out with your line.',
      };
    },
  };
  const putToVote: QuickTool<z.infer<typeof VoteArgs>> = {
    name: 'put_to_vote',
    description:
      'Opens a vote on the options of an options card Go showed (card_id), even a card with one option (that option or keep looking). ' +
      'Only this vote can be booked: never open_vote for options on a card. A card of shared things that show_options put up is its own vote ' +
      'already (Vote on each option): this only says so. For a card from before, or one option, the vote card goes out with the line you give it. ' +
      `${CARD_LINE} Use it when the group should decide together on a shared thing (a stay, a cab, an activity), never on a ticket: a flight, train or bus is each traveller's own pick. ` +
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
      // A card that is its vote already (rev 5 R5): nothing to open, and no vote card beside it.
      const onCard = (await d.results.card(ctx.tripId, cardId))?.card.decision_id;
      if (onCard) return { decision_id: onCard, note: "This card is the group's vote already: each option has Vote on it. Say so in one short line only if someone asked for a vote." };
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
      if (r.ok === false && r.reason === 'personal') {
        return {
          error: 'personal',
          note: "A ticket (a flight, train or bus) is its traveller's own, never a group vote: each person taps \"I'll take this\" on it, and Go posts their own confirm. Say that in one line if anyone asked for a vote.",
        };
      }
      if (!r.ok) return { error: r.reason, ...(r.decisionId ? { decision_id: r.decisionId } : {}) };
      ctx.cards.push(r.voteCard);
      ctx.lines.push(a.line);
      return { decision_id: r.decisionId, note: 'The vote card goes out with your line.' };
    },
  };
  return [searchFlights, searchTrains, searchBuses, searchStays, showOptions, putToVote];
}
