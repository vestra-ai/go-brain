/**
 * How everyone gets to the trip, asked for. The composite trip.how_we_get_there (recipes/trip/) runs each home city's
 * trains and buses on the day side by side on the trip's computer, and its flights as a link. Go puts each city's
 * cheapest and fastest on one options card, each row with "See on ixigo", and posts a line built from the same data:
 * the turn ends on them, with no model round after. "Flights from my city" opens the tapper's own city's flights.
 */
import { z } from 'zod';
import type { QuickTool, TurnCtx } from '../composer/tools.js';
import { dayText } from './answer.js';
import type { Engine, EngineAnswer } from './book/engine.js';
import { hoursMinutes } from './book/expr.js';
import { buildWaysCard, clip, CLASS_WORDS, formatInr, type CardPick } from './cards.js';
import { stableId } from './ids.js';
import { TravelError } from './mcp-travel.js';
import { searchKindOf, TRAVEL_WAIT_MS } from './recipes/backend.js';
import { norm } from './recipes/places.js';
import { toResultOption, type ResultOption, type ResultsStore } from './results.js';

export const WAYS_THERE = 'trip.how_we_get_there';
/** The card's rows at most: the contract's options card holds five. */
const ROWS_MAX = 5;
/** The tool waits a search's own time for the steps, then answers with what came back. */
const WAYS_TOOL_MS = TRAVEL_WAIT_MS + 2_000;

type Compare = Extract<EngineAnswer, { as: 'compare' }>;

export interface WayThere {
  home: string;
  /** How many of the group live there. */
  people: number;
  cheapest: ResultOption | null;
  fastest: ResultOption | null;
  /** ixigo's flights page from the city, set for its people; null when its link didn't come. */
  flights: string | null;
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

/** Each home city's cheapest and fastest train or bus, its flights link, and what didn't come back. */
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
    const cheapest = [...ok].sort((a, b) => a.priceMinor! - b.priceMinor! || minutesOf(a) - minutesOf(b))[0] ?? null;
    const fastest = [...ok].sort((a, b) => minutesOf(a) - minutesOf(b) || a.priceMinor! - b.priceMinor!)[0] ?? null;
    const n = people.filter((p) => p.from_city && norm(p.from_city) === norm(entry)).length;
    return { home: entry, people: n, cheapest, fastest, flights, missed };
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

/** A row as the card shows it: its city in its title, and which it is, with its time, first among its highlights. */
function rowOption(r: Row): ResultOption {
  const tag = { cheapest: 'Cheapest', fastest: 'Fastest', both: 'Cheapest and fastest' }[r.is];
  return { ...r.option, title: clip(`From ${r.way.home}: ${r.option.title}`, 80), highlights: [`${tag}, ${hoursMinutes(minutesOf(r.option))}`, ...r.option.highlights].slice(0, 4) };
}

/** "the Goa Express 12779 in Sleeper", "the Zingbus bus". */
function nameOf(o: ResultOption): string {
  if (o.kind !== 'train') return `the ${o.title} bus`;
  const code = typeof o.facts.class_code === 'string' ? o.facts.class_code : null;
  return code ? `the ${o.title} in ${CLASS_WORDS[code] ?? code}` : `the ${o.title}`;
}
const priced = (o: ResultOption): string => `${formatInr(o.priceMinor!)} (${hoursMinutes(minutesOf(o))})`;
const listOf = (words: string[]): string => (words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);

/** The line with the card, from the same data: each city's cheapest and fastest, and what didn't come back. */
export function waysLine(ways: WayThere[], date: string): string {
  const said = ways.map((w) => {
    const missed = listOf(w.missed);
    if (!w.cheapest) {
      const had = (['trains', 'buses'] as const).filter((k) => !w.missed.includes(k));
      if (had.length === 0) return `From ${w.home}, the trains and buses didn't come back.`;
      return `From ${w.home}, ixigo has no ${listOf([...had]).replace(' and ', ' or ')} on ${dayText(date)}${missed ? `, and the ${missed} didn't come back` : ''}.`;
    }
    const best =
      w.fastest && w.fastest !== w.cheapest
        ? `the cheapest is ${nameOf(w.cheapest)} at ${priced(w.cheapest)}, the fastest ${nameOf(w.fastest)} at ${priced(w.fastest)}.`
        : `${nameOf(w.cheapest)} is the cheapest and the fastest, at ${priced(w.cheapest)}.`;
    return `From ${w.home}, ${best}${missed ? ` The ${missed} didn't come back.` : ''}`;
  });
  const flights = ways.some((w) => w.flights) ? ' Flights from your own city are a tap away on the card.' : '';
  return `${said.join(' ')}${flights}`;
}

export interface WaysThereDeps {
  engine: Pick<Engine, 'answer'>;
  results: Pick<ResultsStore, 'save' | 'saveCard' | 'card'>;
  /** Whether Go searches ixigo.com itself now (TRAVEL_MODE ixigo_web): the composite runs in the trip's browser. */
  live: () => boolean;
}

const Args = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, only when the ask names a day other than the trip's start"),
  to: z.string().min(2).max(60).optional().describe("Only when the ask names a place other than the trip's destination"),
});

export function waysThereTool(d: WaysThereDeps): QuickTool<z.infer<typeof Args>> {
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
      // What came back in a search's own time: the steps still going then end, and say so.
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(TRAVEL_WAIT_MS)]);
      let got: EngineAnswer;
      try {
        got = await d.engine.answer(WAYS_THERE, { ...(a.date ? { date: a.date } : {}), ...(a.to ? { to: a.to } : {}) }, { tripId: ctx.tripId, signal });
      } catch (err) {
        if (!(err instanceof TravelError)) throw err;
        return { error: err.code, note: err.code === 'needs_more' ? `${clip(err.message, 200)} Ask the group for it in one line.` : clip(err.message, 200) };
      }
      if (got.as !== 'compare') throw new Error(`${WAYS_THERE} answered ${got.as}`);
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
        return { ways: facts, note: 'No train or bus came back for any city. Say so in one line, and that flights are on ixigo.' };
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
      const cardId = ctx.stableId('c_opt');
      const picks: CardPick[] = options.map((option, i) => ({ optionId: stableId('opt', cardId, i + 1), option, imageUrl: null }));
      const homes = ways.filter((w) => w.cheapest).map((w) => w.home);
      const card = buildWaysCard({ cardId, title: `Ways to ${to} from ${listOf(homes)}, ${dayText(date)}`, homes, checkedAt: got.checkedAt, picks, flights: Object.keys(flights).length > 0 });
      await d.results.saveCard({ cardId, tripId: ctx.tripId, resultsId: set.resultsId, title: card.title, optionKind: card.option_kind, card }, picks.map((p, i) => ({ ...p, n: i + 1 })), got.checkedAt);
      // A rerun of the same turn finds this card saved already, and shows that one.
      ctx.cards.push((await d.results.card(ctx.tripId, cardId))?.card ?? card);
      ctx.lines.push(waysLine(ways, date));
      ctx.answered = true;
      return { ways: facts, results_id: set.resultsId, card_id: cardId, answered: true, note: 'The card and its line are up: this turn has said what it needed to.' };
    },
  };
}
