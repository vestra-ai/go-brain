/**
 * TRAVEL_MODE ixigo_web: Go's travel search on ixigo.com itself, through the recipes. Each search runs in the trip's own
 * browser, so it needs the trip. Its options carry their ixigo.com page and no offer id: the group books on ixigo, and
 * Go never holds or pays for them.
 *
 * A search is kept for its recipe's TTL (10 minutes), by recipe and slots, so "Delhi" and "DEL" are one search; while it
 * runs, the same search joins it, so an early start on intake and the composer's own call make one page load, and one
 * live search card: the card starts with the run and is marked done before the search answers.
 *
 * A live card belongs to the turn that handles its search: the turn for the message whose early start ran it, or the
 * composer turn whose search tool did. A failed early start leaves its card open, and the composer's search in that turn
 * carries on in it. The composer's own search that fails ends its card failed at once, before Go's line. When a turn ends
 * (turnEnded), a card it left open ends failed. So the room sees one card per search, ending done or failed exactly once,
 * and never after its turn; a search still running when its turn ends keeps its card until the run ends it. A card that
 * ended never reopens: a later ask gets a card of its own.
 *
 * A search answers inline only through the browser fetch, within TRAVEL_WAIT_MS of its start; past that (and always for
 * the agent job, 25 to 55 s) the search tool goes on and the options come when the run finishes (waitMs).
 */
import type { TurnEnd } from '../../composer/context.js';
import type { LiveSearch } from '../live-search.js';
import { TravelError } from '../mcp-travel.js';
import type { SearchFor, TravelBackend, TravelKind, TravelQuery, TravelSearch } from '../travel.js';
import { RECIPES } from './index.js';
import type { Recipe } from './recipe.js';
import type { RecipeRunner } from './runners.js';

/** How long a search may hold up the turn, from its start: a train search on a sleeping box took about 8 s on staging. */
export const TRAVEL_WAIT_MS = 12_000;

export interface IxigoWebDeps {
  /** The runner for this recipe now; null while the trip's computer is not set up here (no /v1 settings). */
  runner: (recipe: Recipe<unknown>) => RecipeRunner | null;
  /** The trip's head count: the adults (and so the rooms) a search asks for when nobody gave a number. */
  peopleOf: (tripId: string) => Promise<number>;
  /** The members' home cities, where known: a flight's adults leave out the ones who live by another airport. */
  homesOf?: (tripId: string) => Promise<string[]>;
  now: () => Date;
  /** The live search card for a run; absent in tests that don't look at it. */
  live?: (tripId: string, o: { runKey: string; kind: TravelKind; query: TravelQuery }) => LiveSearch;
  /** Kinds whose page ixigo won't serve Go's computer: the search answers with the page's link and loads nothing. */
  linkOnly?: (kind: TravelKind) => boolean;
}

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

/** Flights: ixigo answers our box egress with "No flights found", then a 403 (7 Oct), until Keshav decides the route. */
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

  /** The recipe, its runner and the search's key, or a plain refusal before anything runs. */
  async function plan(kind: TravelKind, q: TravelQuery, tripId: string | undefined) {
    if (!tripId) throw new TravelError('refused', "An ixigo.com search runs on a trip's computer, so it needs the trip.");
    const recipe = RECIPES[kind];
    const runner = d.runner(recipe);
    if (!runner) throw new TravelError('refused', "An ixigo.com search needs the trip's computer, which is not set up here.");
    const slots = recipe.slotsFrom(q, { people: Math.max(1, await d.peopleOf(tripId)), fromCities: (await d.homesOf?.(tripId)) ?? [] });
    // The page is ixigo's public results, the same in any trip's browser: the trip runs it, the slots key it.
    return { tripId, recipe, runner, slots, key: `${recipe.id}|${JSON.stringify(slots)}` };
  }

  return {
    async search(kind, q, o?: SearchFor) {
      const { tripId, recipe, runner, slots, key } = await plan(kind, q, o?.tripId);
      // Never "no flights" when ixigo refused us: the group gets the page itself, and ixigo gets no load from Go.
      if (d.linkOnly?.(kind)) throw new TravelError('link_only', "ixigo won't show its results to Go's computer right now.", recipe.url(slots));
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
        card = { live: d.live(tripId, { runKey: runId, kind, query: q }), owner, running: true, code: 'failed' };
        cards.set(cardKey, card);
      } else {
        card = null;
      }
      const live = card?.live;
      const search = runner.run(tripId, recipe, slots, live ? { onProgress: live.progress } : {}).then(
        async (run): Promise<TravelSearch> => {
          live?.progress({ type: 'extracted', count: run.options.length });
          // The card is done before the options card posts.
          if (card) await end(cardKey, card, true);
          return { results: run.options, checkedAt: run.checkedAt, runId };
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
      kept.set(key, { at: nowMs, ttl: recipe.ttlMs, search });
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
      // A search that refuses does so at once: nothing to wait for.
      const p = await plan(kind, q, o?.tripId).catch(() => null);
      if (!p || d.linkOnly?.(kind)) return null;
      if (p.runner.name === 'agent_job') return 0;
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
