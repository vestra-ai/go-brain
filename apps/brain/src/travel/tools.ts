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
import { answerLine, answerTitle, directPicks, linkLine, plainAsk } from './answer.js';
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
}

const todayOf = (d: Pick<TravelToolDeps, 'today' | 'now'>, tripId: string): Promise<string> =>
  d.today ? d.today(tripId) : Promise.resolve(localDay(d.now(), DEFAULT_TRIP_TZ));

export const OPTION_KIND: Record<TravelKind, OptionKind> = { flights: 'flight', trains: 'train', buses: 'bus', stays: 'stay' };

const Where = z.string().min(2).max(60);
const Rupees = z.number().positive().max(10_000_000);
const toPaise = (rupees: number): number => Math.round(rupees * 100);

export const FlightsArgs = z.object({
  from: Where.describe('City or airport code, e.g. "Delhi" or "DEL"; a city abroad with its airport code, e.g. "London (LHR)"'),
  to: Where.describe('City or airport code, e.g. "Goa" or "Dubai (DXB)"'),
  date: z.iso.date().describe('YYYY-MM-DD'),
  depart_after: Clock.optional().describe('24-hour HH:MM. Someone who can only leave after 6 pm is "18:00".'),
  depart_before: Clock.optional(),
  arrive_before: Clock.optional(),
  max_price_per_person: Rupees.optional().describe('In rupees'),
  non_stop: z.boolean().optional(),
  travellers: z.int().min(1).max(9).optional().describe('Only when the ask says how many fly ("for 3 of us"). Leave it out otherwise: Go counts who lives near the origin.'),
});
export const JourneyArgs = z.object({
  from: Where.describe('City or station, e.g. "Jaipur"; for trains, a station with its Indian Railways code works too, e.g. "Udaipur City (UDZ)"'),
  to: Where.describe('City or station, e.g. "Goa"; for trains, a station with its code works too, e.g. "Madgaon (MAO)"'),
  date: z.iso.date().describe('YYYY-MM-DD'),
  depart_after: Clock.optional().describe('24-hour HH:MM'),
  depart_before: Clock.optional(),
  arrive_before: Clock.optional(),
  max_price_per_person: Rupees.optional().describe('In rupees'),
});
export const StaysArgs = z.object({
  area: Where.describe('A city, town or area, e.g. "Manali", "North Goa" or "Anjuna"'),
  check_in: z.iso.date(),
  check_out: z.iso.date(),
  guests: z.int().min(1).max(30).optional(),
  max_price_per_night: Rupees.optional().describe('In rupees, for the whole place per night'),
  must_have: z.array(z.enum(MUST_HAVES)).max(5).optional().describe('pool, beach (10 minutes or less), breakfast, free_cancellation'),
  min_rating: z.number().min(0).max(5).optional(),
});

export function flightsQuery(a: z.infer<typeof FlightsArgs>): TravelQuery {
  return {
    from: a.from,
    to: a.to,
    date: a.date,
    ...(a.depart_after ? { departAfter: a.depart_after } : {}),
    ...(a.depart_before ? { departBefore: a.depart_before } : {}),
    ...(a.arrive_before ? { arriveBefore: a.arrive_before } : {}),
    ...(a.max_price_per_person ? { maxPriceMinor: toPaise(a.max_price_per_person) } : {}),
    ...(a.non_stop ? { mustHave: ['non_stop' as const] } : {}),
    ...(a.travellers ? { guests: a.travellers } : {}),
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

export function journeyQuery(a: z.infer<typeof JourneyArgs>): TravelQuery {
  return {
    from: a.from,
    to: a.to,
    date: a.date,
    ...(a.depart_after ? { departAfter: a.depart_after } : {}),
    ...(a.depart_before ? { departBefore: a.depart_before } : {}),
    ...(a.arrive_before ? { arriveBefore: a.arrive_before } : {}),
    ...(a.max_price_per_person ? { maxPriceMinor: toPaise(a.max_price_per_person) } : {}),
  };
}

export function staysQuery(a: z.infer<typeof StaysArgs>): TravelQuery {
  return {
    area: a.area,
    checkIn: a.check_in,
    checkOut: a.check_out,
    ...(a.guests ? { guests: a.guests } : {}),
    ...(a.max_price_per_night ? { maxPriceMinor: toPaise(a.max_price_per_night) } : {}),
    ...(a.must_have ? { mustHave: a.must_have } : {}),
    ...(a.min_rating !== undefined ? { minRating: a.min_rating } : {}),
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

export function compactOption(n: number, o: ResultOption): Record<string, unknown> {
  const when = o.journey ? subtitleFor(o) : null;
  const nights = typeof o.facts.nights === 'number' ? o.facts.nights : null;
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
 * prices and the stays' areas. When nothing fits it names the conditions and the closest miss, so a line about it can
 * never drop one ("no pool villa under ₹10,000", not "nothing under ₹10,000").
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
      return { search, count: 0, error: err.code, note: clip(err.message, 200), summary: `This search failed (${err.code}): nothing came back for ${search}, so there is no list for it.` };
    }
    throw err;
  }
  // The turn's one plain ask, found: the search answers it, card and line, and no model round follows.
  if (found.results.length > 0 && plainAsk(kind, q, { wake: ctx.wake, pack: ctx.pack, ...(ctx.roundTools ? { roundTools: ctx.roundTools } : {}), today: await todayOf(d, ctx.tripId) }).ok) {
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
  d: Pick<TravelToolDeps, 'results' | 'images'>,
): Promise<{ cardId: string; shown: number }> {
  const cardId = ctx.stableId('c_opt');
  const run = runOfSet.get(set.resultsId);
  if (run) remember(shownRuns, run);
  const picks = await Promise.all(
    numbers.map(async (n, i) => {
      const option = set.options[n - 1]!;
      return { n: i + 1, optionId: stableId('opt', cardId, i + 1), option, imageUrl: option.imageUrl ? await d.images.rehostUrl(option.imageUrl) : null };
    }),
  );
  const title = stayCardTitle(given.title, set.query, picks.map((p) => p.option));
  // Stays from ixigo.com: the card shows a few, so its button opens the whole list the search read (the lead's call).
  const seeAll = set.optionKind === 'stay' && ixigoPage(set.page ?? null) !== null;
  const card = buildOptionsCard({ cardId, title, optionKind: set.optionKind, checkedAt: set.checkedAt, picks, seeAll });
  await d.results.saveCard({ cardId, tripId: ctx.tripId, resultsId: set.resultsId, title: card.title, optionKind: set.optionKind, card }, picks, set.checkedAt);
  // A rerun of the same turn finds this card id saved already: it shows the card saved first, which its stored offers match.
  const shown = (await d.results.card(ctx.tripId, cardId))?.card ?? card;
  ctx.cards.push(shown);
  ctx.lines.push(given.line);
  return { cardId, shown: shown.options.length };
}

/**
 * A finished search that answers the turn's plain ask itself: its list saved, its picks on a card (the engine's order:
 * the first three stays, the three cheapest journeys), and a line built from its data. The turn ends on them, with no
 * model round after the search. "See on ixigo" on the card opens each option's own page, as on any card.
 */
export async function answerItself(kind: TravelKind, q: TravelQuery, found: TravelSearch, ctx: TurnCtx, d: Pick<TravelToolDeps, 'results' | 'images'>): Promise<unknown> {
  const options = found.results.slice(0, 10).map(toResultOption);
  const set = await d.results.save({ tripId: ctx.tripId, optionKind: OPTION_KIND[kind], source: 'search', query: q, options, checkedAt: found.checkedAt, ...(found.page ? { page: found.page } : {}) });
  noteRun(set.resultsId, ctx.tripId, found.runId);
  const numbers = directPicks(kind, options);
  // The line's "from" is the card's own cheapest, never one of the results the card leaves out.
  const line = answerLine(kind, q, numbers.map((n) => options[n - 1]!));
  const { cardId, shown } = await putUpCard(set, numbers, { title: answerTitle(kind, q), line }, ctx, d);
  ctx.answered = true;
  return { search: searchName(kind, q), results_id: set.resultsId, card_id: cardId, shown, answered: true, note: 'The card and its line are up: this turn has said what it needed to.' };
}

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
        const payload: SearchWake = { source: 'travel_search', search: a.search, count: a.count, resultsId: a.results_id ?? null, summary: a.summary, error: null };
        await wake(`search:${o.tripId}:${found.runId ?? o.fallbackId}`, payload);
      },
      async (err: unknown) => {
        const code = err instanceof TravelError ? err.code : 'failed';
        await wake(`search:${o.tripId}:${o.fallbackId}:failed`, { source: 'travel_search', search: searchName(kind, q), count: 0, resultsId: null, summary: '', error: code });
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

/**
 * ixigo won't show Go's computer these results: the card links the group to them on ixigo, with their conditions set
 * (the recipe's own link: ixigo's results page with what people asked for already on it).
 * Go books no flights, so the line it adds sends people to ixigo to book, and offers only to note their pick.
 */
function linkAnswer(kind: TravelKind, q: TravelQuery, url: string, ctx: TurnCtx, plain = false): unknown {
  const who = kind === 'flights' ? flyingFor(url) : null;
  ctx.cards.push(buildFlightsLinkCard({ cardId: ctx.stableId('c_link'), title: suggestTitle(kind, q), url, who }));
  // The turn's one plain ask: the card's line is built here too, and the turn ends on it.
  if (plain) {
    ctx.lines.push(linkLine(kind, q, who));
    ctx.answered = true;
  }
  return {
    search: searchName(kind, q),
    count: 0,
    link: url,
    ...(who ? { set_for: who } : {}),
    note: "ixigo won't show its flights to Go's computer right now. The card with the link to them on ixigo, with these conditions set, goes out with your message.",
    tell_the_room:
      `Say in one short line that the flights are on the card${who ? `, set ${who}` : ''}, to book on ixigo, and that if they tell you ` +
      "which one, you'll note it for the group. You can't book flights: never offer to book one or to take it from there. " +
      'Never say there are no flights, and quote no prices or times.',
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
 * and the best ten in short.
 */
export async function searchAnswer(kind: TravelKind, q: TravelQuery, found: TravelSearch, tripId: string, d: { results: Pick<ResultsStore, 'save'>; now: () => Date }): Promise<SearchAnswer> {
  const scope = searchScope(kind, q);
  const terms = asked(kind, q);
  const search = searchName(kind, q);
  const before = found.found ?? found.results.length;
  const options = found.results.slice(0, 10).map(toResultOption);
  if (options.length === 0) {
    const near = found.closest;
    const closest = near ? ` Closest: ${optionLine(near.option)}, but ${listOf(near.misses)}.` : '';
    const summary =
      before === 0
        ? `Nothing came back: there are no ${scope} at all.`
        : before === 1
          ? `The one ${scopeOf(kind, q, 1)} doesn't fit ${listOf(terms)}.${closest}`
          : `None of the ${before} ${scope} fits ${listOf(terms)}.${closest}`;
    return {
      search,
      count: 0,
      checked: ageText(found.checkedAt, d.now()),
      summary,
      note: 'Nothing to show. Say what the summary says in one line, keeping every condition in it, and suggest loosening one thing.',
    };
  }
  const set = await d.results.save({ tripId, optionKind: OPTION_KIND[kind], source: 'search', query: q, options, checkedAt: found.checkedAt, ...(found.page ? { page: found.page } : {}) });
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
    `${
      terms.length
        ? trainList
          ? `${n} ${scopeOf(kind, q, n)} ${fits} ${listOf(terms)}${byClass}`
          : `${n} of the ${before} ${scopeOf(kind, q, before)} ${fits} ${listOf(terms)}`
        : `${n} ${scopeOf(kind, q, n)}${byClass}`
    }` +
    `${prices ? `: ${prices}` : ''}${areas.length ? `, in ${listOf(areas)}` : ''}.` +
    `${fit > options.length ? ` The best ${options.length} are below.` : ''}`;
  return {
    search,
    results_id: set.resultsId,
    checked: ageText(found.checkedAt, d.now()),
    count: options.length,
    summary,
    results: options.map((o, i) => compactOption(i + 1, o)),
    card: { results_id: set.resultsId, option_numbers: options.slice(0, 3).map((_, i) => i + 1), title: suggestTitle(kind, q) },
    note:
      'To show options, call show_options with this results_id. Quote prices only from these results, and say how long ago they were checked when it is not just now. ' +
      "Each option's area, time and price are as given here: name no other, and say no count the summary does not give. " +
      'If someone asked for a place an option is not in, say the option\'s own area: asked for Calangute, a villa in Vagator is in Vagator. ' +
      CARD_LINE,
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
    description: `Searches flights on one date. ${SEARCH_RULE} For example depart_after "18:00" when someone cannot leave before 6 pm.`,
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
  const searchBuses: QuickTool<z.infer<typeof JourneyArgs>> = {
    name: 'search_buses',
    description: `Searches buses on one date. ${SEARCH_RULE}`,
    input: JourneyArgs,
    run: (a, ctx) => runSearch('buses', journeyQuery(a), ctx, d),
    summarizeRound: searchRoundSummary,
    timeoutMs: SEARCH_TOOL_MS,
  };
  const searchStays: QuickTool<z.infer<typeof StaysArgs>> = {
    name: 'search_stays',
    description: `Searches villas and hotels for check-in and check-out dates. ${SEARCH_RULE} For a deep comparison (reviews, many sites), use start_task instead.`,
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
      'Opens a vote on the options of an options card Go showed (card_id). To show options and put them to a vote at once, ' +
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
