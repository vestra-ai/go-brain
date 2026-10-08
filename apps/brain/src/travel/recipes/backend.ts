/**
 * TRAVEL_MODE ixigo_web: Go's travel search on ixigo.com itself, through the recipe book: each kind of search is a recipe
 * file (flights.search, trains.between, buses.between, hotels.search), run by the recipe engine in the trip's own browser,
 * so it needs the trip. Its options carry their ixigo.com page and no offer id: the group books on ixigo, and Go never
 * holds or pays for them. A recipe that answers with a link (flights) loads nothing.
 *
 * A search is kept for its recipe's TTL (10 minutes), by recipe and the words asked; while it runs, the same search joins
 * it, so an early start on intake and the composer's own call make one page load, and one live search card: the card
 * starts with the run and is marked done before the search answers.
 *
 * A live card belongs to the turn that handles its search: the turn for the message whose early start ran it, or the
 * composer turn whose search tool did. A failed early start leaves its card open, and the composer's search in that turn
 * carries on in it. The composer's own search that fails ends its card failed at once, before Go's line. When a turn ends
 * (turnEnded), a card it left open ends failed. So the room sees one card per search, ending done or failed exactly once,
 * and never after its turn; a search still running when its turn ends keeps its card until the run ends it. A card that
 * ended never reopens: a later ask gets a card of its own.
 *
 * A search answers inline within TRAVEL_WAIT_MS of its start; past that the search tool goes on and the options come when
 * the run finishes (waitMs).
 */
import type { TurnEnd } from '../../composer/context.js';
import type { Book } from '../book/book.js';
import type { Engine } from '../book/engine.js';
import type { LiveSearch } from '../live-search.js';
import { TravelError } from '../mcp-travel.js';
import type { SearchFor, TravelBackend, TravelKind, TravelQuery, TravelSearch } from '../travel.js';
import { RECIPE_TTL_MS } from './recipe.js';

/** How long a search may hold up the turn, from its start: a train search on a sleeping box took about 8 s on staging. */
export const TRAVEL_WAIT_MS = 12_000;

export interface IxigoWebDeps {
  book: Pick<Book, 'get'>;
  /** Runs a recipe: the trip's head count and homes, its places and its page are the engine's. */
  engine: Pick<Engine, 'answer'>;
  now: () => Date;
  /** The live search card for a run; absent in tests that don't look at it. */
  live?: (tripId: string, o: { runKey: string; kind: TravelKind; query: TravelQuery }) => LiveSearch;
  /** How long a run goes before its live card shows (CARD_DELAY_MS); 0 shows it at once. */
  cardDelayMs?: number;
  /**
   * The trip's head count. A stay asked for with no head count is for everyone, as its recipe reads it ($trip.people), so
   * it is keyed as that: an early start without one and the composer's search "sleeping 4" in a trip of four are one
   * search. Absent in tests that don't look at it.
   */
  people?: (tripId: string) => Promise<number>;
}

/**
 * A run that answers within this (a recipe's fast call from the warm tab) posts its options card with no live card
 * first: the "On it." card shows only for a run still going after it, with the steps it missed.
 */
export const CARD_DELAY_MS = 1_500;

/** A live card that shows only once the run has gone delayMs; until then its steps wait, and a run done by then shows none. */
function shownAfter(delayMs: number, make: () => LiveSearch): LiveSearch {
  if (delayMs <= 0) return make();
  let live: LiveSearch | null = null;
  const waiting: Array<Parameters<LiveSearch['progress']>[0]> = [];
  const timer = setTimeout(() => {
    live = make();
    for (const e of waiting.splice(0)) live.progress(e);
  }, delayMs);
  timer.unref?.();
  return {
    progress: (e) => {
      if (live) live.progress(e);
      else waiting.push(e);
    },
    finish: async (ok) => {
      clearTimeout(timer);
      // A card never shown has nothing to end.
      if (live) await live.finish(ok);
    },
  };
}

/** Each kind of search's recipe in the book. */
export const SEARCH_RECIPES: Record<TravelKind, string> = { flights: 'flights.search', trains: 'trains.between', buses: 'buses.between', stays: 'hotels.search' };

/** The kind of search a recipe is, when it is one of the four. */
export const searchKindOf = (recipeId: string): TravelKind | null =>
  (Object.entries(SEARCH_RECIPES) as Array<[TravelKind, string]>).find(([, id]) => id === recipeId)?.[0] ?? null;

/**
 * A search's query as its recipe's inputs: the places as the person's words, and the conditions ixigo may filter on. A
 * stay with no head count is for the trip's people, when the trip's head count is given.
 */
export function recipeInputs(kind: TravelKind, q: TravelQuery, people?: number): { given: Record<string, unknown>; conditions: string[] } {
  const conditions = [...(q.mustHave ?? [])];
  if (kind === 'stays') {
    return { given: { place: q.area ?? q.to, check_in: q.checkIn, check_out: q.checkOut, adults: q.guests ?? people }, conditions };
  }
  if (kind === 'flights') {
    return {
      given: {
        from: q.from, to: q.to, date: q.date, adults: q.guests,
        depart_after: q.departAfter, depart_before: q.departBefore, arrive_before: q.arriveBefore, max_price: q.maxPriceMinor,
      },
      conditions,
    };
  }
  return { given: { from: q.from, to: q.to, date: q.date }, conditions };
}

/** The same ask, whatever its spacing or case: "North Goa" and " north goa" are one search. */
const keyOf = (given: Record<string, unknown>, conditions: string[]): string =>
  JSON.stringify([
    Object.entries(given)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, typeof v === 'string' ? v.trim().toLowerCase().replace(/\s+/g, ' ') : v]),
    [...conditions].sort(),
  ]);

/** The ixigo_web backend, and the hook a turn's end calls to end the live cards it left open. */
export type IxigoWebBackend = TravelBackend & { turnEnded(t: TurnEnd): void };

/** Whose a live card is: the message whose early start ran its search, or the composer turn whose search tool did. */
type Owner = { kind: 'message' | 'turn'; id: string } | null;

/** A live card that has not ended: its search running, or a failed early start's card waiting for the composer's search. */
interface OpenCard {
  live: LiveSearch;
  owner: Owner;
  running: boolean;
  /** Why the last run failed, for the card's failed step. */
  code: string;
}

/** Turns and messages remembered as over, so a run that fails after its turn ended ends its card at once. */
const OVER_MAX = 2_000;

/** Flights: ixigo answers our box egress with "No flights found", then a 403 (7 Oct), so flights.search is a link. */
export const LINK_ONLY_KINDS: ReadonlySet<TravelKind> = new Set(['flights']);

const BOOK_ON_IXIGO = 'Options from ixigo.com are booked on ixigo, from their link.';
const CACHE_MAX = 200;

export function createIxigoWebBackend(d: IxigoWebDeps): IxigoWebBackend {
  const kept = new Map<string, { at: number; ttl: number; search: Promise<TravelSearch> }>();
  /** The live cards that have not ended, by trip and search. */
  const cards = new Map<string, OpenCard>();
  /** Owners whose turn has ended, as "<trip>|turn:<id>" and "<trip>|message:<id>". */
  const over = new Set<string>();
  const ownerKey = (o: Owner): string => (o ? `${o.kind}:${o.id}` : '');

  /** The card's one ending: its last step ticked (done) or marked failed, sent before the search answers. */
  function end(cardKey: string, card: OpenCard, ok: boolean): Promise<void> {
    if (cards.get(cardKey) === card) cards.delete(cardKey);
    if (!ok) card.live.progress({ type: 'failed', code: card.code });
    return card.live.finish(ok);
  }

  /** The recipe, its inputs and the search's key, or a plain refusal before anything runs. */
  async function plan(kind: TravelKind, q: TravelQuery, tripId: string | undefined) {
    if (!tripId) throw new TravelError('refused', "An ixigo.com search runs on a trip's computer, so it needs the trip.");
    const id = SEARCH_RECIPES[kind];
    const recipe = d.book.get(id);
    if (!recipe) throw new TravelError('refused', `Go's recipe book has no ${id}.`);
    const people = kind === 'stays' && q.guests === undefined && d.people ? await d.people(tripId) : undefined;
    const { given, conditions } = recipeInputs(kind, q, people);
    // The page is ixigo's public results, the same in any trip's browser: the trip runs it, the words key it.
    const ttl = recipe.ttl_minutes * 60_000 || RECIPE_TTL_MS;
    return { tripId, id, given, conditions, link: recipe.answer.as === 'link', ttl, key: `${id}|${keyOf(given, conditions)}` };
  }

  return {
    async search(kind, q, o?: SearchFor) {
      const { tripId, id, given, conditions, link, ttl, key } = await plan(kind, q, o?.tripId);
      // Never "no flights" when ixigo refuses Go's computer: the group gets the page itself, set as they asked.
      if (link) {
        const a = await d.engine.answer(id, given, { tripId, conditions });
        if (a.as === 'link') throw new TravelError('link_only', "ixigo won't show its results to Go's computer right now.", a.link);
      }
      const owner: Owner = o?.turnId ? { kind: 'turn', id: o.turnId } : o?.messageId ? { kind: 'message', id: o.messageId } : null;
      const cardKey = `${tripId}|${key}`;
      const nowMs = d.now().getTime();
      const hit = kept.get(key);
      if (hit && nowMs - hit.at < hit.ttl) {
        // The composer joining a run its early start began takes the card: if that run fails, nothing retries it.
        const running = cards.get(cardKey);
        if (running?.running && owner?.kind === 'turn') running.owner = owner;
        return hit.search;
      }
      const runId = `${key}|${nowMs}`;
      // A failed early start's card, still open in its turn, carries on with this search; otherwise the run gets its own.
      let card = cards.get(cardKey) ?? null;
      if (card && !card.running) {
        card.running = true;
        card.owner = owner ?? card.owner;
      } else if (d.live) {
        const make = d.live;
        card = { live: shownAfter(d.cardDelayMs ?? CARD_DELAY_MS, () => make(tripId, { runKey: runId, kind, query: q })), owner, running: true, code: 'failed' };
        cards.set(cardKey, card);
      } else {
        card = null;
      }
      const live = card?.live;
      const search = d.engine.answer(id, given, { tripId, conditions, ...(live ? { onProgress: live.progress } : {}) }).then(
        async (run): Promise<TravelSearch> => {
          if (run.as !== 'options') throw new TravelError('refused', `${id} gives no options.`);
          live?.progress({ type: 'extracted', count: run.options.length });
          // The card is done before the options card posts.
          if (card) await end(cardKey, card, true);
          return { results: run.options, checkedAt: run.checkedAt, runId, page: run.page };
        },
        async (err: unknown): Promise<never> => {
          if (card) {
            card.code = err instanceof TravelError ? err.code : 'failed';
            // A failed early start waits, open, for the composer's search in its turn. Anything else ends failed now,
            // before the search answers: the composer's own search, a job's, or one whose turn is already over.
            if (card.owner?.kind === 'message' && !over.has(`${tripId}|${ownerKey(card.owner)}`)) card.running = false;
            else await end(cardKey, card, false);
          }
          throw err;
        },
      );
      kept.delete(key);
      kept.set(key, { at: nowMs, ttl, search });
      while (kept.size > CACHE_MAX) {
        const oldest = kept.keys().next().value;
        if (oldest === undefined) break;
        kept.delete(oldest);
      }
      // A failed search is not kept: the next ask runs it again.
      search.catch(() => {
        if (kept.get(key)?.search === search) kept.delete(key);
      });
      return search;
    },
    async waitMs(kind, q, o) {
      // A search that refuses does so at once, and a link loads nothing: nothing to wait for.
      let p: Awaited<ReturnType<typeof plan>>;
      try {
        p = await plan(kind, q, o?.tripId);
      } catch {
        return null;
      }
      if (p.link) return null;
      const started = kept.get(p.key)?.at ?? d.now().getTime();
      return Math.max(0, TRAVEL_WAIT_MS - (d.now().getTime() - started));
    },
    turnEnded(t) {
      const owners = new Set([`turn:${t.turnId}`, ...t.messageIds.map((id) => `message:${id}`)]);
      for (const k of owners) {
        over.delete(`${t.tripId}|${k}`);
        over.add(`${t.tripId}|${k}`);
      }
      while (over.size > OVER_MAX) {
        const oldest = over.values().next().value;
        if (oldest === undefined) break;
        over.delete(oldest);
      }
      // A card the turn left open ends failed; one whose search still runs is ended by its run.
      for (const [k, card] of cards) {
        if (k.startsWith(`${t.tripId}|`) && !card.running && owners.has(ownerKey(card.owner))) void end(k, card, false);
      }
    },
    async status() {
      throw new TravelError('refused', "Flight and PNR status aren't read from ixigo.com yet.");
    },
    async hold() {
      throw new TravelError('refused', BOOK_ON_IXIGO);
    },
    async confirm() {
      throw new TravelError('refused', BOOK_ON_IXIGO);
    },
  };
}
