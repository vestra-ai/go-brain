/**
 * Each person's own flights (the Server's REV4 ask B7; Keshav, 10 Oct: a ticket is each traveller's own). From each
 * member's home city (Person.from_city) to the trip on its day, on cards for them alone: the room sees each card, only
 * its people act on it, and a pick is the picker's own (taps.ts), never a vote.
 *
 * The composite trip.flights_each (recipes/trip/) reads one flights page per home city on the trip's computer (paced:
 * one flights page across every trip in 20 s), and each person's leaving time (Person.earliest_leave, leave-window.ts)
 * narrows their city's flights in Go, with no second load. Every traveller gets a card of their own (the Server team's
 * final round, 10 Oct: one card per traveller, theirs alone to act on, no vote), even two from one city. Each city's
 * cards go up as its page lands, the first in about 5 s, behind a live card ticking off the cities. A city whose page
 * doesn't come never gets a link card (G1, 11 Oct): each of its people hears, theirs alone, that Go couldn't load their
 * flights and will try again in a minute, and Go tries that city again (try-again.ts, eachTryAgain); ixigo's own "No flights
 * found" is no such page: its people hear that ixigo has none that day, and the bus as the next step. That is the one line a
 * person hears for it: never again for an ask again or a later try (p2's re-audit of Keshav's Varkala trip, 11 Oct: 20
 * private lines in four rounds a minute apart, 15 to people who never asked). "My flights" is the asker's alone (asker.ts).
 */
import { z } from 'zod';
import type * as C from '@go/contract';
import { SAY_NOTHING, type QuickTool, type TurnCtx } from '../composer/tools.js';
import type { Desk } from '../desk/desk.js';
import type { ServerLink } from '../door/server-link.js';
import type { TripPack } from '../trips/pack.js';
import { dayText, noFlightsLine, noFlightsText } from './answer.js';
import { noFlightsOfferFor, type NearestAirport } from './nearest-airport.js';
import type { NoneSaid } from './book/engine.js';
import type { Engine, EngineAnswer, StepsEvent } from './book/engine.js';
import { buildOptionsCard, clip, formatInr, type CardPick } from './cards.js';
import { flightDetails } from './details.js';
import { applyConstraints } from './filters.js';
import { stableId } from './ids.js';
import { leaveWindow, type LeaveWindow } from './leave-window.js';
import { TravelError } from './mcp-travel.js';
import { CARD_DELAY_MS, TRAVEL_WAIT_MS } from './recipes/backend.js';
import { norm } from './recipes/places.js';
import { askedBy } from './asker.js';
import { toResultOption, type ResultOption, type ResultsStore } from './results.js';
import type { TravelKind, TravelOption, TravelQuery } from './travel.js';
import { notLoadedLine, TRIES, tryAgain, waitFor, type TryAgainItem } from './try-again.js';
import { waysLiveCard } from './ways-there.js';

export const FLIGHTS_EACH = 'trip.flights_each';
/** One home city's flights page, as the composite reads it: a city's try again reads it alone. */
const CITY_FLIGHTS = 'flights.results';
/** The flights on a person's card at most: the cheapest that fit their window. */
const CARD_FLIGHTS = 3;
/** The tool waits a search's own time; past it, each city's cards still post themselves as they land. */
const EACH_TOOL_MS = TRAVEL_WAIT_MS + 2_000;

/**
 * How long the composite may take: one flights page a city, 20 s apart across every trip (another trip's page may come
 * first), and a page's own time. No turn waits on it: each card posts itself as its page gets through (waitOutPace).
 */
export function eachDeadlineMs(cities: number): number {
  return Math.min(240_000, 30_000 + cities * 30_000);
}

/** How long a person told their city's flights didn't load hears nothing more of it: an ask again, a second search. */
export const TOLD_MS = 30 * 60_000;
/**
 * Who was told, by trip, person, city and day, and when (told: bounded, the oldest first out): true, and kept, the first
 * time in TOLD_MS this person hears their city's flights didn't load for this day.
 */
function firstTell(told: Map<string, number>, tripId: string, personId: string, home: string, date: string, nowMs: number): boolean {
  const key = `${tripId}|${personId}|${norm(home)}|${date}`;
  const at = told.get(key);
  if (at !== undefined && nowMs - at < TOLD_MS) return false;
  told.delete(key);
  told.set(key, nowMs);
  while (told.size > 5_000) told.delete(told.keys().next().value!);
  return true;
}

type Person = C.Person;
type Window = Extract<LeaveWindow, { kind: 'window' }>;

/** One traveller's card: their home city and leaving window (people holds them alone). */
export interface EachGroup {
  home: string;
  people: Array<{ personId: string; name: string }>;
  window: Window | null;
}

export interface EachPlan {
  groups: EachGroup[];
  /** Members who haven't said where they fly from: asked in the line. */
  noHome: string[];
  /** Members whose leaving words aren't a time: their card has every flight, and the line says why. */
  unread: Array<{ name: string; text: string }>;
}

/** Who gets which card: each member their own, by home city and leaving window; nobody whose home is the trip's own place. */
export function planEach(people: Person[], to: string, date: string): EachPlan {
  const groups: EachGroup[] = [];
  const noHome: string[] = [];
  const unread: EachPlan['unread'] = [];
  for (const p of people) {
    const home = p.from_city?.trim();
    if (!home) {
      noHome.push(p.name);
      continue;
    }
    if (norm(home) === norm(to)) continue;
    const w = leaveWindow(p.earliest_leave, date);
    if (w.kind === 'unread') unread.push({ name: p.name, text: w.text });
    groups.push({ home, people: [{ personId: p.person_id, name: p.name }], window: w.kind === 'window' ? w : null });
  }
  return { groups, noHome, unread };
}

const listOf = (words: string[]): string => (words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);
/** A person as a line names them: their first name, as a friend would (Keshav's Varkala trip, 11 Oct: "Keshav Musunuri, I couldn't…"). */
const firstName = (name: string): string => name.trim().split(/\s+/)[0] || name;
const namesOf = (g: EachGroup): string => listOf(g.people.map((p) => firstName(p.name)));

/** A search that stops on which place ixigo means (more than one airport by the words, or none): the person's to say. */
const PLACE_ASKS: ReadonlySet<string> = new Set(['pick_place', 'unknown_place']);
/** That question in a line, with ixigo's own names for the airports it lists. */
const placeAsk = (err: TravelError): string =>
  err.code === 'pick_place' && err.choices.length > 0 ? `which airport do you mean? ixigo has ${listOf(err.choices.slice(0, 4))}.` : `${clip(err.message, 200)}`;

/** A seat people can still buy: a price, a time, and not a fare ixigo says has no seat left. */
const bookable = (o: TravelOption): boolean => o.priceMinor > 0 && !!o.journey && o.facts['seats_left'] !== 0;

/** A group's flights: those its window lets them take, the cheapest first, and how many fit. */
export function flightsFor(g: EachGroup, options: TravelOption[]): { shown: TravelOption[]; fit: number } {
  const q = { ...(g.window?.departAfter ? { departAfter: g.window.departAfter } : {}), ...(g.window?.departBefore ? { departBefore: g.window.departBefore } : {}) };
  const fit = applyConstraints('flights', q, options.filter(bookable)).sort(
    (a, b) => a.priceMinor - b.priceMinor || (a.journey?.depart_at ?? '').localeCompare(b.journey?.depart_at ?? ''),
  );
  return { shown: fit.slice(0, CARD_FLIGHTS), fit: fit.length };
}

export interface FlightsEachDeps {
  engine: Pick<Engine, 'answer'>;
  results: Pick<ResultsStore, 'save' | 'saveCard' | 'card'>;
  /** Whether Go searches ixigo.com itself now (TRAVEL_MODE ixigo_web): the composite runs in the trip's browser. */
  live: () => boolean;
  /** Where the live card and each city's cards are posted. */
  link: Pick<ServerLink, 'request'>;
  now: () => Date;
  /** Where a city whose page didn't come waits for its try again (try-again.ts). */
  desk?: Pick<Desk, 'put'>;
  /** The nearest other airport with flights, for a city ixigo had none for (nearest-airport.ts). */
  nearest?: NearestAirport;
  /** When ixigo's own quiet on a flights page ends (it refused one), or null: a city's try waits past it. */
  ixigoQuiet?: (kind: TravelKind, q: TravelQuery) => number | null;
  log?: { warn(obj: object, msg: string): void };
  /** How long the turn waits (TRAVEL_WAIT_MS), and before the live card shows (CARD_DELAY_MS). */
  waitMs?: number;
  cardDelayMs?: number;
}

/** A group's card and its line, saved before it posts so its taps find their offers. */
async function groupCard(
  d: Pick<FlightsEachDeps, 'results'>, tripId: string, turnId: string, g: EachGroup, at: { to: string; date: string; instead?: Instead },
  got: Extract<EngineAnswer, { as: 'options' }>,
) {
  const { shown, fit } = flightsFor(g, got.options);
  const who = namesOf(g);
  const when = g.window ? `, ${g.window.words}` : '';
  if (shown.length === 0) return { card: null, line: `${who}, no flight from ${g.home} on ${dayText(at.date)}${when} has seats on ixigo.` };
  const cardId = stableId('c_each', turnId, ...g.people.map((p) => p.personId));
  const options: ResultOption[] = shown.map((o) => toResultOption(o));
  const ids = g.people.map((p) => p.personId);
  const set = await d.results.save({
    tripId, optionKind: 'flight', source: 'search', options, checkedAt: got.checkedAt, page: got.page,
    query: { from: g.home, to: at.to, date: at.date, guests: 1, ...(g.window?.departAfter ? { departAfter: g.window.departAfter } : {}), ...(g.window?.departBefore ? { departBefore: g.window.departBefore } : {}), for_person_ids: ids },
  });
  const picks: Array<CardPick & { n: number }> = options.map((option, i) => {
    const details = flightDetails(option, 1);
    return { n: i + 1, optionId: stableId('opt', cardId, i + 1), option, imageUrl: null, ...(details ? { details } : {}) };
  });
  const title = `Flights for ${who}, ${g.home} to ${at.to}, ${dayText(at.date)}${when}`;
  const card = buildOptionsCard({ cardId, title: clip(title, 80), optionKind: 'flight', checkedAt: got.checkedAt, picks, forPersonIds: ids });
  await d.results.saveCard({ cardId, tripId, resultsId: set.resultsId, title: card.title, optionKind: 'flight', card }, picks, got.checkedAt);
  // A rerun of the same turn finds this card saved already, and posts that one.
  const saved = (await d.results.card(tripId, cardId))?.card ?? card;
  const cheapest = shown[0]!;
  // A place with no airport of its own (Varkala), searched at ixigo's nearest (TRV): said once, in plain words.
  const near = (got.near ?? []).map((n) => `${n.words} has no airport, so these are flights ${norm(n.words) === norm(g.home) ? 'from' : 'to'} ${n.city} (${n.code}). `).join('');
  const fits = `${fit} ${fit === 1 ? 'fits' : 'fit'}, from ${formatInr(cheapest.priceMinor)} a person. Tap "I'll take this" on yours.`;
  // A search in place of a route ixigo had no flights on: the none first, then which airport this is and for where
  // (Keshav, 12 Oct: "ixigo has no flights from Delhi to Kullu (Manali's airport) on Fri 13 Nov, so here are flights to
  // Chandigarh, the nearest airport to Manali with flights that day").
  if (at.instead) {
    const { of, side } = at.instead;
    const none = noneAt.get(noneKey(tripId, of, at.date)) ?? {};
    const said = side === 'from' ? noFlightsText(of, at.to, at.date, none) : noFlightsText(g.home, of, at.date, none);
    const here = side === 'from' ? `from ${g.home}` : `to ${at.to}`;
    return { card: saved, line: `${who}, ${said.slice(0, -1)}, so here are flights ${here}, the nearest airport to ${of} with flights that day${when}. ${fits}` };
  }
  const line = `${who}, your flights from ${g.home} on ${dayText(at.date)}${when}: ${near}${fits}`;
  return { card: saved, line };
}

/**
 * Each traveller's card and its line are theirs alone to see (1.2 visible_to_person_ids, Keshav, 10 Oct), as well as to
 * act on. Never throws: a post that fails is logged.
 */
function postFor(
  d: Pick<FlightsEachDeps, 'link' | 'log'>, tripId: string, requestId: string, card: C.Card | null, text: string, only: string[],
  replies: Array<{ label: string; text: string }> = [],
): Promise<void> {
  return d.link.request('post_message', {
    request_id: requestId, trip_id: tripId, text, ...(card ? { card } : {}), ...(replies.length ? { quick_replies: replies } : {}), visible_to_person_ids: only,
  })
    .then(() => undefined)
    .catch((err: unknown) => d.log?.warn({ err: String(err).slice(0, 200), tripId }, "travel: a person's flights card could not be posted"));
}

/** A traveller's line when their city's page didn't come, or the last try didn't either: "Arjun, I couldn't load…". */
const notLoadedFor = (g: EachGroup, line: (what: string) => string): string => `${namesOf(g)}, ${line(`your flights from ${g.home}`)}`;

/**
 * ixigo's none for a place on a day, by trip (noFlightsFrom keeps it): the stand-in search's line says it first, as ixigo
 * searched it ("Kullu (Manali's airport)"). A hint: with none kept (a restart), the line says the place's own words.
 */
const noneAt = new Map<string, NoneSaid>();
const noneKey = (tripId: string, place: string, date: string): string => `${tripId}|${norm(place)}|${date}`;

/** A search that stands in for a route ixigo had no flights on: the place it stands in for, and which end that was. */
export interface Instead {
  of: string;
  side: 'from' | 'to';
}

/**
 * ixigo has no flights from a city to the trip that day (its "No flights found"): each traveller hears it, theirs alone,
 * with the nearest other airport with flights offered, one tap, or a bus (Keshav, 12 Oct: "Should I look at flights to
 * Chandigarh, the nearest airport with flights?"). A tap comes back as their own message, which asks for that search. A
 * search that already stood in for one (instead) offers the bus alone: one nearest airport, never a chain. Never
 * "couldn't load", never a try again.
 */
async function noFlightsFrom(
  d: Pick<FlightsEachDeps, 'link' | 'log' | 'nearest'>, tripId: string, key: string, groups: EachGroup[],
  at: { to: string; date: string; instead?: Instead | undefined }, none: NoneSaid,
): Promise<void> {
  // Kept for the stand-in search's line, under both ends' words: which end had none is the tap's to say.
  for (const place of [groups[0]?.home, at.to]) {
    if (!place) continue;
    noneAt.set(noneKey(tripId, place, at.date), none);
    while (noneAt.size > 500) noneAt.delete(noneAt.keys().next().value!);
  }
  for (const g of groups) {
    // The bus goes from their home to the trip's place, whichever end a stand-in search stood in for.
    const from = at.instead?.side === 'from' ? at.instead.of : g.home;
    const to = at.instead?.side === 'to' ? at.instead.of : at.to;
    const offer = at.instead ? { text: noFlightsLine(from, to, at.date, none), replies: [] } : await noFlightsOfferFor(from, to, at.date, none, d.nearest);
    const ids = g.people.map((p) => p.personId);
    await postFor(d, tripId, stableId('go_each', key, ...ids, 'none'), null, `${namesOf(g)}, ${offer.text}`, ids, offer.replies);
  }
}

/**
 * A home city's try again (try-again.ts): its flights page alone, in the background, through ixigo's quiet. Each
 * traveller from there now (the trip as it is when the try comes) gets their own card when it lands, the next try goes on
 * the desk when it doesn't, and after the last each hears Go's last word, theirs alone. Starts and returns at once.
 */
export function eachTryAgain(d: Omit<FlightsEachDeps, 'live'>): (t: TryAgainItem, pack: TripPack) => void {
  return (t, pack) => {
    const each = t.payload.each;
    if (!each) return;
    // The search's own people (one asked for theirs alone), from that city.
    // Flying from the nearest other airport to their home (instead, from): they fly from that city this time.
    const people = (each.people ? pack.trip.people.filter((p) => each.people!.includes(p.person_id)) : pack.trip.people)
      .map((p) => (each.instead?.side === 'from' ? { ...p, from_city: each.home } : p));
    const groups = planEach(people, each.to, each.date).groups.filter((g) => norm(g.home) === norm(each.home));
    if (groups.length === 0) return;
    const at = { to: each.to, date: each.date };
    const run = async (): Promise<void> => {
      const asked: { err: TravelError | null } = { err: null };
      const got = await d.engine.answer(CITY_FLIGHTS, { from: each.home, to: each.to, date: each.date, ...(each.cabin ? { cabin: each.cabin } : {}) }, { tripId: t.tripId, retry: true })
        .catch((err: unknown) => {
          // Which place ixigo means is the person's to say, never a page that didn't load: no try after it.
          if (err instanceof TravelError && PLACE_ASKS.has(err.code)) asked.err = err;
          d.log?.warn({ err: String(err).slice(0, 200), tripId: t.tripId, n: t.payload.n }, "travel: a city's flights try again didn't load");
          return null;
        });
      if (asked.err) {
        for (const g of groups) {
          const ids = g.people.map((p) => p.personId);
          await postFor(d, t.tripId, stableId('go_each', t.id, ...ids, 'asks'), null, `${namesOf(g)}, ${placeAsk(asked.err)}`, ids);
        }
        return;
      }
      if (got?.as === 'options' && got.options.length > 0) {
        for (const g of groups) {
          const ids = g.people.map((p) => p.personId);
          const made = await groupCard(d, t.tripId, t.id, g, { ...at, ...(each.instead ? { instead: each.instead } : {}) }, got);
          await postFor(d, t.tripId, stableId('go_each', t.id, ...ids), made.card, made.line, ids);
        }
        return;
      }
      // ixigo's own "No flights found": the nearest other airport next, never another try.
      if (got?.as === 'options' && got.none) {
        await noFlightsFrom(d, t.tripId, t.id, groups, { to: each.to, date: each.date, instead: each.instead }, got.none);
        return;
      }
      if (t.payload.n < TRIES && d.desk) {
        await tryAgain({ ...d, desk: d.desk }, t.tripId, 'flights', { ...t.payload, n: t.payload.n + 1 });
        return;
      }
      // The last try didn't land either. Never a line to everyone again: one closing line, to the person who asked when the
      // city is theirs, so "I'll try again in a minute" never reads as Go forgetting (the lead, 11 Oct).
      d.log?.warn({ tripId: t.tripId, home: each.home }, "travel: a city's flights didn't load after its tries");
      if (each.asker && groups.some((g) => g.people.some((p) => p.personId === each.asker))) {
        await postFor(d, t.tripId, stableId('go_each', t.id, each.asker, 'closing'), null, `I kept trying for over 20 minutes and still couldn't load your ${each.home} flights, so I've stopped for now.`, [each.asker]);
      }
    };
    run().catch((err: unknown) => d.log?.warn({ err: String(err).slice(0, 200), tripId: t.tripId }, "travel: a city's flights try again failed"));
  };
}

const Args = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, only when the ask names a day other than the trip's start"),
  to: z.string().min(2).max(60).optional().describe("Only when the ask names a place other than the trip's destination"),
  cabin: z.enum(['economy', 'premium_economy', 'business']).optional().describe('Only when the ask names a cabin'),
  person_ids: z.array(z.string().min(1).max(80)).min(1).max(30).optional()
    .describe('Whose flights: the asker\'s alone for "my flights"; leave it out only when they asked for everyone\'s, or ours'),
  from: z.string().min(2).max(60).optional().describe("Only for the nearest other airport to these people's home, when they asked for it: that airport's city"),
  instead_of: z.string().min(2).max(60).optional()
    .describe('Only for the nearest other airport someone asked for after ixigo had none: the place whose own airport had no flights (Manali)'),
});


export function flightsEachTool(d: FlightsEachDeps): QuickTool<z.infer<typeof Args>> {
  const told = new Map<string, number>();
  return {
    name: 'search_flights_each',
    description:
      "Finds each person's own flights to the trip from their home city, on the trip's day: one card for each city and leaving time, " +
      "for those people alone, each picking their own (a ticket is never a group vote). Each person's leaving time narrows their flights. " +
      'Use it for someone\'s own flights ("my flights": person_ids [theirs]), or when the group asks for everyone\'s or ours; ' +
      'use search_flights for one route someone names. ' +
      'The day, the destination, the home cities and the leaving times come from the trip.',
    input: Args,
    timeoutMs: EACH_TOOL_MS,
    async run(a, ctx: TurnCtx) {
      if (!d.live()) return { error: 'not_here', note: "Go finds each person's flights only when it searches ixigo.com itself: use search_flights for each route." };
      const trip = ctx.pack.trip;
      const to = a.to ?? trip.destination?.name ?? null;
      const date = a.date ?? trip.dates?.start ?? null;
      if (!to || !date) return { error: 'needs_more', note: `Ask the group in one line for ${!to ? 'where the trip goes' : 'the day they fly'}.` };
      // "My flights" is the asker's alone, whoever else the model names; only everyone's or ours fans out (asker.ts).
      const asked = askedBy(ctx);
      const scope = asked?.own ? [asked.personId] : (a.person_ids ?? null);
      // The nearest other airport to their home, when theirs had no flights: they fly from there this time.
      const people = (scope ? trip.people.filter((p) => scope.includes(p.person_id)) : trip.people).map((p) => (a.from ? { ...p, from_city: a.from } : p));
      const instead: Instead | undefined = a.instead_of ? { of: a.instead_of, side: a.from ? 'from' : 'to' } : undefined;
      if (people.length === 0) return { error: 'unknown_person', note: 'person_ids names nobody in the trip: give the person_id of each person whose flights to find.' };
      const plan = planEach(people, to, date);
      const asks = [
        ...(plan.noHome.length > 0 ? [`${listOf(plan.noHome.map(firstName))}, where do you fly from?`] : []),
        ...plan.unread.map((u) => `${firstName(u.name)}, "${clip(u.text, 40)}" isn't a time, so your card has every flight.`),
      ].join(' ');
      if (plan.groups.length === 0) return { error: 'needs_more', note: `Nobody has said where they fly from. Say only this, in one line: ${asks || 'where does everyone fly from?'}` };

      const at = { to, date, ...(instead ? { instead } : {}) };
      const live = waysLiveCard(d, ctx.tripId, ctx.stableId('c_live'), { kinds: ['flights'], fallback: "Go is checking each person's flights on ixigo from their home city." });
      const timeUp = new AbortController();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const showing = setTimeout(() => live.show(), d.cardDelayMs ?? CARD_DELAY_MS);
      showing.unref?.();
      // Each city's two steps (its page and its link); its cards post as its page lands, and when the page didn't come,
      // its people hear that Go will try again, and the city's try goes on the desk. The turn's own line, to the room,
      // names no flight, price or window.
      const cities = new Map<string, { steps: number; posted: boolean; asks?: string }>();
      // The cities whose cards went up, and the rest with why: what the model may say, and nothing more.
      const up = new Set<string>();
      const notUp = new Map<string, string>();
      const posts: Array<Promise<void>> = [];
      const post = (key: string, card: C.Card | null, text: string, only: string[]): void => {
        posts.push(postFor(d, ctx.tripId, stableId('go_each', ctx.turnId, key), card, text, only));
      };
      const groupsOf = (entry: string): EachGroup[] => plan.groups.filter((g) => norm(g.home) === norm(entry));
      const onStep = (e: Extract<StepsEvent, { type: 'step' }>): void => {
        const city = cities.get(norm(e.entry)) ?? { steps: 0, posted: false };
        cities.set(norm(e.entry), city);
        city.steps += 1;
        if (e.why && PLACE_ASKS.has(e.why.split(':')[0]!)) city.asks = e.why.slice(e.why.indexOf(':') + 1).trim();
        if (e.recipe === 'flights.results') live.step(e.entry, 'flights', e.answer?.as === 'options');
        const got = e.answer;
        if (got?.as === 'options' && got.options.length > 0 && !city.posted) {
          city.posted = true;
          for (const g of groupsOf(e.entry)) {
            posts.push(
              groupCard(d, ctx.tripId, ctx.turnId, g, at, got)
                .then((made) => {
                  if (made.card) up.add(g.home);
                  else notUp.set(g.home, 'no flight that day has seats on ixigo');
                  post(g.people.map((p) => p.personId).join(','), made.card, made.line, g.people.map((p) => p.personId));
                })
                .catch((err: unknown) => d.log?.warn({ err: String(err).slice(0, 200), tripId: ctx.tripId }, "travel: a person's flights card could not be made")),
            );
          }
          return;
        }
        // ixigo's own "No flights found" (prod, 12 Oct: Delhi to Kullu on 13 Nov, read as a page that didn't load, and
        // tried again for 20 minutes): the answer, theirs alone, with the bus as the next step; never a try again.
        if (got?.as === 'options' && got.none && !city.posted) {
          city.posted = true;
          for (const g of groupsOf(e.entry)) {
            notUp.set(g.home, instead
              ? 'ixigo has no flights from there that day either; their line says so, with a bus as the next step'
              : 'ixigo has no flights on that route that day; their line says so and offers the nearest airport with flights, or a bus');
          }
          posts.push(noFlightsFrom(d, ctx.tripId, stableId('each_none', ctx.turnId, norm(e.entry)), groupsOf(e.entry), at, got.none));
          return;
        }
        // Both steps in and no flights read: never a link card. Each of the city's people hears it, theirs alone, and the
        // city is tried again in a minute.
        if (city.steps >= 2 && !city.posted && city.asks) {
          // Which place ixigo means is the person's to say (more than one airport by those words): asked once, theirs
          // alone, never "couldn't load" and never a try on the same question.
          city.posted = true;
          for (const g of groupsOf(e.entry)) {
            const only = g.people.map((p) => p.personId);
            post(`${only.join(',')}|asks`, null, `${namesOf(g)}, ${clip(city.asks, 240)} Which one?`, only);
            notUp.set(g.home, `ixigo needs to know which airport: ${clip(city.asks, 160)}`);
          }
          return;
        }
        if (city.steps >= 2 && !city.posted) {
          city.posted = true;
          for (const g of groupsOf(e.entry)) notUp.set(g.home, "ixigo's page didn't load; Go tries again in the background and says so to them");
          // A minute, or past ixigo's own quiet when ixigo refused a flights page: the line says which.
          const wait = waitFor(d, 'flights', { from: e.entry, to, date });
          for (const g of groupsOf(e.entry)) {
            // Their one line for it: someone told lately (an ask again, a second search) hears nothing new while Go tries.
            const nowMs = d.now().getTime();
            const fresh = g.people.filter((p) => firstTell(told, ctx.tripId, p.personId, e.entry, date, nowMs));
            if (fresh.length === 0) continue;
            const only = fresh.map((p) => p.personId);
            post(`${only.join(',')}|not_loaded`, null, notLoadedFor({ ...g, people: fresh }, (what) => notLoadedLine(what, wait)), only);
          }
          if (d.desk) {
            const each = {
              home: e.entry, to, date, ...(a.cabin ? { cabin: a.cabin } : {}), ...(scope ? { people: scope } : {}), ...(asked ? { asker: asked.personId } : {}),
              ...(instead ? { instead } : {}),
            };
            posts.push(
              tryAgain({ ...d, desk: d.desk }, ctx.tripId, 'flights', { key: stableId('each', ctx.turnId, norm(e.entry)), what: `flights from ${e.entry}`, n: 1, each })
                .then(() => undefined)
                .catch((err: unknown) => d.log?.warn({ err: String(err).slice(0, 200), tripId: ctx.tripId }, "travel: a city's flights try again could not be put on the desk")),
            );
          }
        }
      };
      // One person's own (or a few from one city): that city's page alone, never every city's.
      const homes = [...new Set(plan.groups.map((g) => g.home))];
      const from = scope && homes.length === 1 ? homes[0] : undefined;
      const running = d.engine.answer(FLIGHTS_EACH, { to, date, ...(a.cabin ? { cabin: a.cabin } : {}), ...(from ? { from } : {}) }, {
        tripId: ctx.tripId,
        signal: timeUp.signal,
        // Each city's page waits its turn as often as it takes: a traveller gets their flights, never a link for a wait.
        waitOutPace: true,
        onSteps: (e) => {
          if (e.type === 'entries') {
            live.cities(e.entries);
            deadline = setTimeout(() => timeUp.abort(), eachDeadlineMs(e.entries.length));
            deadline.unref?.();
            return;
          }
          onStep(e);
        },
      });
      const done: Promise<{ ok: true } | { err: unknown }> = running
        .then(async () => {
          // Every card the cities made, posted, before the live card says done.
          for (let n = 0; n < posts.length; n++) await posts[n];
          await live.finish([...cities.values()].some((c) => c.posted));
          return { ok: true as const };
        })
        .catch(async (err: unknown) => {
          await live.finish(false);
          return { err };
        })
        .finally(() => {
          clearTimeout(showing);
          clearTimeout(deadline);
        });
      const STILL = Symbol('still running');
      let waited: ReturnType<typeof setTimeout> | undefined;
      const first = await Promise.race([done, new Promise<typeof STILL>((r) => (waited = setTimeout(() => r(STILL), d.waitMs ?? TRAVEL_WAIT_MS)))]);
      clearTimeout(waited);
      const facts = plan.groups.map((g) => ({ home: g.home, people: g.people.map((p) => p.name), leaving: g.window?.words ?? 'any time' }));
      if (first === STILL) {
        void done.then((out) => {
          if ('err' in out) d.log?.warn({ err: String(out.err).slice(0, 200), tripId: ctx.tripId }, "travel: each person's flights failed after the turn");
        });
        return {
          running: true,
          cards: facts,
          tell_the_room: asks ? `Say only this, in one line: ${asks}` : SAY_NOTHING,
          note: "Each person's flights are still coming in on the trip's computer, and the live card ticks off each city. Each city's cards post themselves as they land: never list the flights.",
        };
      }
      if ('err' in first) {
        if (!(first.err instanceof TravelError)) throw first.err;
        return { error: first.err.code, note: clip(first.err.message, 200) };
      }
      if (asks) {
        ctx.lines.push(asks);
        ctx.answered = true;
      }
      // Exactly the cards that went up, and the rest with why (Keshav's Varkala trip, 11 Oct: "your Delhi flights card is
      // up", when none had posted).
      const cardsUp = facts.filter((f) => up.has(f.home));
      const notCards = facts.filter((f) => !up.has(f.home)).map((f) => ({ ...f, why: notUp.get(f.home) ?? 'no card' }));
      const said = cardsUp.length > 0
        ? `These cards are up, each with its own line: ${cardsUp.map((f) => `${listOf(f.people.map(firstName))}'s from ${f.home}`).join('; ')}.`
        : 'No flights card went up.';
      const notSaid = notCards.length > 0 ? ` Not up: ${notCards.map((f) => `${listOf(f.people.map(firstName))}'s from ${f.home} (${f.why})`).join('; ')}; each of them has their own line about it already.` : '';
      return {
        cards_up: cardsUp,
        ...(notCards.length > 0 ? { not_up: notCards } : {}),
        answered: !!asks,
        ...(asks ? {} : { tell_the_room: SAY_NOTHING }),
        note: `${said}${notSaid} Never say a card is up that is not in cards_up.${asks ? " This turn's line asks what is missing: it has said what it needed to." : ' Say nothing more about them.'}`,
      };
    },
  };
}
