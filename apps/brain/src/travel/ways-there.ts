/**
 * How everyone gets to the trip, asked for. The composite trip.how_we_get_there (recipes/trip/) runs each home city's
 * trains, buses and flights on the day side by side on the trip's computer (flights when ixigo shows them: one flights
 * page across every trip in 20 s), and its flights' link. Go puts each city's cheapest and fastest, across all three, on
 * one options card, each row with "See on ixigo", and posts a line built from the same data, with no model round after.
 * "Flights from my city" opens the tapper's own city's flights.
 *
 * Three cities on a computer that runs two pages at once take about 25 s, longer than a turn. So the room sees the run
 * from the start: an "On it." live card, "Checking 3 cities", a step per city ticking done or failed. A comparison that
 * is in within a search's own wait ends the turn with its card and line; one that isn't posts them itself when it is.
 */
import type * as C from '@go/contract';
import { z } from 'zod';
import { SAY_NOTHING, type QuickTool, type TurnCtx } from '../composer/tools.js';
import type { ServerLink } from '../door/server-link.js';
import { dayText } from './answer.js';
import type { Engine, EngineAnswer } from './book/engine.js';
import { hoursMinutes } from './book/expr.js';
import { buildWaysCard, clip, CLASS_WORDS, formatInr, type CardPick, type OptionsCardT } from './cards.js';
import { stableId } from './ids.js';
import { TravelError } from './mcp-travel.js';
import { CARD_DELAY_MS, searchKindOf, TRAVEL_WAIT_MS } from './recipes/backend.js';
import { norm } from './recipes/places.js';
import { toResultOption, type ResultOption, type ResultsStore } from './results.js';

export const WAYS_THERE = 'trip.how_we_get_there';
/** The card's rows at most: the contract's options card holds five. */
const ROWS_MAX = 5;
/** The tool waits a search's own time for the comparison; past it, the comparison posts itself. */
const WAYS_TOOL_MS = TRAVEL_WAIT_MS + 2_000;
/** The longest the live card's last update holds the comparison's card back. */
const FINISH_WAIT_MS = 1_500;

type Compare = Extract<EngineAnswer, { as: 'compare' }>;
type WorkingCard = z.infer<typeof C.WorkingCard>;

/**
 * How long a comparison may take before it posts what is in: a page takes about 4 s and the computer runs `slots` at
 * once, and each city may need three (its trains, its buses, and ixigo's box for a bus city Go doesn't know yet). 25 s
 * for three cities on two slots, 17 s on four.
 */
export function waysDeadlineMs(cities: number, slots: number): number {
  return Math.min(30_000, Math.max(12_000, 5_000 + Math.ceil((cities * 3) / Math.max(1, slots)) * 4_000));
}

export interface WayThere {
  home: string;
  /** How many of the group live there. */
  people: number;
  cheapest: ResultOption | null;
  fastest: ResultOption | null;
  /** The one train, bus or flight people can take from there: the line says "the one bus" rather than cheapest and fastest. */
  only: boolean;
  /** ixigo's flights page from the city, set for its people; null when its link didn't come. */
  flights: string | null;
  /** Whether its flights came back: without them its fastest is only the fastest by train or bus, and says so. */
  flown: boolean;
  /** The searches that didn't come back for the city. */
  missed: Array<'trains' | 'buses'>;
}

/** A way's time door to door, in minutes. */
const minutesOf = (o: ResultOption): number => (o.journey ? (Date.parse(o.journey.arrive_at) - Date.parse(o.journey.depart_at)) / 60_000 : Infinity);

/** A seat people can still buy: not a train class ixigo says is full or gone, not a bus with no seat left. */
function bookable(o: ResultOption): boolean {
  if (!o.priceMinor || o.priceMinor <= 0 || !o.journey || !Number.isFinite(minutesOf(o))) return false;
  if (o.kind === 'train') return !/regret|not available|departed|cancel/i.test(String(o.facts.availability ?? ''));
  return o.facts.seats_left !== 0;
}

/** Each home city's cheapest and fastest train, bus or flight, its flights link, and what didn't come back. */
export function waysOf(got: Compare, people: Array<{ from_city?: string | null | undefined }>): WayThere[] {
  return got.entries.map(({ entry, steps }) => {
    const options: ResultOption[] = [];
    const missed: WayThere['missed'] = [];
    let flights: string | null = null;
    for (const s of steps) {
      const kind = searchKindOf(s.recipe);
      if (s.answer?.as === 'link' && kind === 'flights') flights = s.answer.link;
      else if (s.answer?.as === 'options') options.push(...s.answer.options.map((o) => toResultOption(o)));
      else if (!s.answer && (kind === 'trains' || kind === 'buses')) missed.push(kind);
    }
    const ok = options.filter(bookable);
    const flown = ok.some((o) => o.kind === 'flight');
    const cheapest = [...ok].sort((a, b) => a.priceMinor! - b.priceMinor! || minutesOf(a) - minutesOf(b))[0] ?? null;
    const fastest = [...ok].sort((a, b) => minutesOf(a) - minutesOf(b) || a.priceMinor! - b.priceMinor!)[0] ?? null;
    // A train comes back once a class: one train in three classes is still the one train.
    const journeys = new Set(ok.map((o) => `${o.kind}|${o.journey?.number ?? o.title}|${o.journey?.depart_at}`));
    const n = people.filter((p) => p.from_city && norm(p.from_city) === norm(entry)).length;
    return { home: entry, people: n, cheapest, fastest, only: journeys.size === 1, flights, flown, missed };
  });
}

type Row = { way: WayThere; option: ResultOption; is: 'cheapest' | 'fastest' | 'both' };

/** The card's rows: each city's cheapest, then its fastest when that is another; past five, the fastest that save least go. */
export function waysRows(ways: WayThere[]): Row[] {
  const rows: Row[] = ways.flatMap((way): Row[] => {
    if (!way.cheapest) return [];
    if (way.fastest === way.cheapest || !way.fastest) return [{ way, option: way.cheapest, is: 'both' }];
    return [{ way, option: way.cheapest, is: 'cheapest' }, { way, option: way.fastest, is: 'fastest' }];
  });
  const saves = (r: Row): number => minutesOf(r.way.cheapest!) - minutesOf(r.option);
  const dropped = new Set(rows.filter((r) => r.is === 'fastest').sort((a, b) => saves(a) - saves(b)).slice(0, Math.max(0, rows.length - ROWS_MAX)));
  return rows.filter((r) => !dropped.has(r));
}

const modeOf = (o: ResultOption): string => (o.kind === 'train' ? 'train' : o.kind === 'flight' ? 'flight' : 'bus');

/** A row as the card shows it: its city in its title, and which it is with its time first among its highlights, once. */
function rowOption(r: Row): ResultOption {
  const tag = r.way.only ? `The only ${modeOf(r.option)}` : { cheapest: 'Cheapest', fastest: `Fastest${byLand(r.way)}`, both: `Cheapest and fastest${byLand(r.way)}` }[r.is];
  const took = hoursMinutes(minutesOf(r.option));
  return {
    ...r.option,
    title: clip(`From ${r.way.home}: ${r.option.title}`, 80),
    highlights: [`${tag}, ${took}`, ...r.option.highlights.filter((h) => h !== took)].slice(0, 4),
  };
}

/** "the Goa Express 12779 in Sleeper", "the Zingbus bus", "the NTC Smart Bus", "the IntrCity SmartBus", "the IndiGo 6E357 flight". */
function nameOf(o: ResultOption): string {
  if (o.kind === 'flight') return `the ${o.title} flight`;
  if (o.kind !== 'train') return /bus$/i.test(o.title) ? `the ${o.title}` : `the ${o.title} bus`;
  const code = typeof o.facts.class_code === 'string' ? o.facts.class_code : null;
  return code ? `the ${o.title} in ${CLASS_WORDS[code] ?? code}` : `the ${o.title}`;
}
/** A fastest with no flights beside it (held back, or none came) is only the fastest by train or bus: never a 25 h train as the fastest. */
const byLand = (w: WayThere): string => (w.flown ? '' : ' by train or bus');
const priced = (o: ResultOption): string => `${formatInr(o.priceMinor!)} (${hoursMinutes(minutesOf(o))})`;
const listOf = (words: string[]): string => (words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);

/**
 * The line with the card, from the same data: each city's cheapest and fastest (or its one train or bus), then once what
 * didn't come back ("Trains didn't come back for any city."), then the flights.
 */
export function waysLine(ways: WayThere[], date: string): string {
  const said = ways.flatMap((w): string[] => {
    if (!w.cheapest) {
      const had = (['trains', 'buses'] as const).filter((k) => !w.missed.includes(k));
      return had.length === 0 ? [] : [`From ${w.home}, ixigo has no ${listOf([...had]).replace(' and ', ' or ')} on ${dayText(date)}.`];
    }
    if (w.only) return [`From ${w.home}, the one ${modeOf(w.cheapest)} is ${nameOf(w.cheapest)}, at ${priced(w.cheapest)}.`];
    if (w.fastest && w.fastest !== w.cheapest) {
      return [`From ${w.home}, the cheapest is ${nameOf(w.cheapest)} at ${priced(w.cheapest)}, the fastest${byLand(w)} ${nameOf(w.fastest)} at ${priced(w.fastest)}.`];
    }
    return [`From ${w.home}, ${nameOf(w.cheapest)} is the cheapest and the fastest${byLand(w)}, at ${priced(w.cheapest)}.`];
  });
  for (const kind of ['trains', 'buses'] as const) {
    const cities = ways.filter((w) => w.missed.includes(kind)).map((w) => w.home);
    if (cities.length === 0) continue;
    const where = cities.length === ways.length && ways.length > 1 ? 'any city' : listOf(cities);
    said.push(`${kind === 'trains' ? 'Trains' : 'Buses'} didn't come back for ${where}.`);
  }
  if (ways.some((w) => w.flights)) said.push('Flights from your own city are a tap away on the card.');
  return said.join(' ');
}

/**
 * The live card while a comparison runs: "Checking 3 cities", a step per city that ticks done when its trains and buses
 * are in (failed when neither came back). Shown only once show() is called, so a comparison that answers at once from
 * kept searches never posts it; updates go out one at a time, in order.
 */
function waysLiveCard(d: { link: Pick<ServerLink, 'request'>; now: () => Date; log?: { warn(obj: object, msg: string): void } }, tripId: string, cardId: string) {
  const cities: Array<{ home: string; going: Set<string>; answered: boolean; state: 'doing' | 'done' | 'failed' }> = [];
  let state: WorkingCard['state'] = 'running';
  let shown = false;
  let posted = false;
  let chain: Promise<void> = Promise.resolve();
  const card = (): WorkingCard => ({
    card_id: cardId,
    kind: 'working',
    fallback_text: 'Go is checking trains and buses on ixigo from each home city.',
    task_id: `ways_${cardId}`,
    title: cities.length > 0 ? `Checking ${cities.length} ${cities.length === 1 ? 'city' : 'cities'}` : 'Checking the home cities',
    state,
    steps: cities.map((c) => ({ text: clip(`${c.home}: trains · buses`, 80), state: c.state })),
    screenshot_url: null,
    page_url: null,
    updated_at: d.now().toISOString(),
    actions: [],
  });
  const send = (): void => {
    if (!shown) return;
    chain = chain.then(async () => {
      try {
        if (!posted) {
          await d.link.request('post_message', { request_id: stableId('go_live', cardId), trip_id: tripId, text: 'On it.', card: card() });
          posted = true;
        } else {
          await d.link.request('replace_card', { trip_id: tripId, card: card() });
        }
      } catch (err) {
        d.log?.warn({ err: String(err).slice(0, 200), cardId }, 'travel: a comparison live card update failed');
      }
    });
  };
  return {
    show(): void {
      if (shown || state !== 'running') return;
      shown = true;
      send();
    },
    cities(entries: string[]): void {
      for (const home of entries) cities.push({ home, going: new Set(['trains', 'buses']), answered: false, state: 'doing' });
      send();
    },
    step(home: string, kind: 'trains' | 'buses', ok: boolean): void {
      const c = cities.find((x) => x.home === home);
      if (!c || !c.going.delete(kind)) return;
      c.answered ||= ok;
      if (c.going.size === 0) c.state = c.answered ? 'done' : 'failed';
      send();
    },
    /** Its last update: every city still going failed, and the card done or failed; waits for it, at most a moment. */
    async finish(ok: boolean): Promise<void> {
      for (const c of cities) if (c.state === 'doing') c.state = c.answered ? 'done' : 'failed';
      state = ok ? 'done' : 'failed';
      send();
      await Promise.race([chain, new Promise((r) => setTimeout(r, FINISH_WAIT_MS).unref())]);
    },
  };
}

export interface WaysThereDeps {
  engine: Pick<Engine, 'answer'>;
  results: Pick<ResultsStore, 'save' | 'saveCard' | 'card'>;
  /** Whether Go searches ixigo.com itself now (TRAVEL_MODE ixigo_web): the composite runs in the trip's browser. */
  live: () => boolean;
  /** Where the live card and a comparison that outlived its turn are posted. */
  link: Pick<ServerLink, 'request'>;
  /** The computer's fetches at once (the BROWSER_FETCH_SLOTS switch), for how long a comparison may take. */
  slots: () => number;
  now: () => Date;
  log?: { warn(obj: object, msg: string): void };
  /** How long the turn waits for the comparison (TRAVEL_WAIT_MS), and before the live card shows (CARD_DELAY_MS). */
  waitMs?: number;
  cardDelayMs?: number;
}

const Args = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, only when the ask names a day other than the trip's start"),
  to: z.string().min(2).max(60).optional().describe("Only when the ask names a place other than the trip's destination"),
});

/** The comparison as the room gets it: the card and its line, or a line alone when no train or bus came back. */
type Comparison = { card: OptionsCardT | null; line: string; facts: unknown[]; resultsId: string | null };

export function waysThereTool(d: WaysThereDeps): QuickTool<z.infer<typeof Args>> {
  /** The comparison from the composite's answer: each city's ways, saved with the card so its taps work. */
  async function comparison(got: Compare, ctx: TurnCtx, cardId: string): Promise<Comparison> {
    const date = String(got.inputs['date']);
    const to = String(got.inputs['to']);
    const ways = waysOf(got, ctx.pack.trip.people);
    const rows = waysRows(ways);
    const facts = ways.map((w) => ({
      home: w.home, people: w.people, missed: w.missed, flights: w.flights !== null,
      cheapest: w.cheapest ? `${w.cheapest.title}, ${priced(w.cheapest)}` : null,
      fastest: w.fastest ? `${w.fastest.title}, ${priced(w.fastest)}` : null,
    }));
    if (rows.length === 0) {
      return { card: null, line: `No train or bus came back from ${listOf(ways.map((w) => w.home))} on ${dayText(date)}. Flights are on ixigo.`, facts, resultsId: null };
    }
    const options = rows.map(rowOption);
    const homeOf = Object.fromEntries(
      ctx.pack.trip.people.flatMap((p) => {
        const way = p.from_city ? ways.find((w) => norm(w.home) === norm(p.from_city!)) : undefined;
        return way ? [[p.person_id, way.home] as const] : [];
      }),
    );
    const flights = Object.fromEntries(ways.flatMap((w) => (w.flights ? [[w.home, w.flights] as const] : [])));
    const set = await d.results.save({
      tripId: ctx.tripId, optionKind: options.every((o) => o.kind === 'bus') ? 'bus' : 'train', source: 'search',
      query: { ways_there: { to, date, flights, home_of: homeOf } }, options, checkedAt: got.checkedAt,
    });
    const picks: CardPick[] = options.map((option, i) => ({ optionId: stableId('opt', cardId, i + 1), option, imageUrl: null }));
    const homes = ways.filter((w) => w.cheapest).map((w) => w.home);
    const card = buildWaysCard({ cardId, title: `Ways to ${to} from ${listOf(homes)}, ${dayText(date)}`, homes, checkedAt: got.checkedAt, picks, flights: Object.keys(flights).length > 0 });
    await d.results.saveCard({ cardId, tripId: ctx.tripId, resultsId: set.resultsId, title: card.title, optionKind: card.option_kind, card }, picks.map((p, i) => ({ ...p, n: i + 1 })), got.checkedAt);
    // A rerun of the same turn finds this card saved already, and shows that one.
    const saved = (await d.results.card(ctx.tripId, cardId))?.card ?? card;
    return { card: saved, line: waysLine(ways, date), facts, resultsId: set.resultsId };
  }

  return {
    name: 'compare_ways_there',
    description:
      "Compares how everyone gets to the trip from their own home cities, all at once: each city's trains and buses on the day, " +
      'its cheapest and its fastest, and its flights, on one card with its line. Use it when people ask how the group gets there, ' +
      'or to compare the ways from their cities. The destination, the day and the home cities come from the trip.',
    input: Args,
    timeoutMs: WAYS_TOOL_MS,
    async run(a, ctx: TurnCtx) {
      if (!d.live()) return { error: 'not_here', note: 'Go compares the ways there only when it searches ixigo.com itself.' };
      const cardId = ctx.stableId('c_opt');
      const live = waysLiveCard(d, ctx.tripId, ctx.stableId('c_live'));
      // The comparison has its own time, longer than the turn's: when it's up, it posts what is in.
      const timeUp = new AbortController();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const showing = setTimeout(() => live.show(), d.cardDelayMs ?? CARD_DELAY_MS);
      showing.unref?.();
      const running = d.engine.answer(WAYS_THERE, { ...(a.date ? { date: a.date } : {}), ...(a.to ? { to: a.to } : {}) }, {
        tripId: ctx.tripId,
        signal: timeUp.signal,
        onSteps: (e) => {
          if (e.type === 'entries') {
            live.cities(e.entries);
            deadline = setTimeout(() => timeUp.abort(), waysDeadlineMs(e.entries.length, d.slots()));
            deadline.unref?.();
            return;
          }
          const kind = searchKindOf(e.recipe);
          if (kind === 'trains' || kind === 'buses') live.step(e.entry, kind, e.ok);
        },
      });
      const done: Promise<{ made: Comparison } | { err: unknown }> = running
        .then(async (got) => {
          if (got.as !== 'compare') throw new Error(`${WAYS_THERE} answered ${got.as}`);
          const made = await comparison(got, ctx, cardId);
          // The card ends as the answer stands: a city's search that ended without telling it still ticks.
          for (const e of got.entries) {
            for (const s of e.steps) {
              const kind = searchKindOf(s.recipe);
              if (kind === 'trains' || kind === 'buses') live.step(e.entry, kind, s.answer !== undefined);
            }
          }
          await live.finish(made.card !== null);
          return { made };
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
      if (first === STILL) {
        // The room has the live card: the comparison posts its own card and line when it is in.
        void done.then(async (out) => {
          if ('err' in out) {
            d.log?.warn({ err: String(out.err).slice(0, 200), tripId: ctx.tripId }, 'travel: a comparison that outlived its turn failed');
            return;
          }
          await d.link.request('post_message', {
            request_id: stableId('go_ways', cardId), trip_id: ctx.tripId, text: out.made.line, ...(out.made.card ? { card: out.made.card } : {}),
          });
        }).catch((err: unknown) => d.log?.warn({ err: String(err).slice(0, 200), tripId: ctx.tripId }, 'travel: a comparison could not be posted'));
        return {
          running: true,
          tell_the_room: SAY_NOTHING,
          note: "The comparison is still running on the trip's computer, and its live card in the room ticks off each city. Post nothing about it now: Go posts its card and line itself when it is in.",
        };
      }
      if ('err' in first) {
        if (!(first.err instanceof TravelError)) throw first.err;
        const err = first.err;
        return { error: err.code, note: err.code === 'needs_more' ? `${clip(err.message, 200)} Ask the group for it in one line.` : clip(err.message, 200) };
      }
      const { made } = first;
      if (made.card) ctx.cards.push(made.card);
      ctx.lines.push(made.line);
      ctx.answered = true;
      return { ways: made.facts, results_id: made.resultsId, card_id: made.card ? cardId : null, answered: true, note: 'The comparison and its line are up: this turn has said what it needed to.' };
    },
  };
}
