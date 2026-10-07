/**
 * TRAVEL_MODE ixigo_web: Go's travel search on ixigo.com itself, through the recipes. Each search runs in the trip's own
 * browser, so it needs the trip. Its options carry their ixigo.com page and no offer id: the group books on ixigo, and
 * Go never holds or pays for them.
 *
 * A search is kept for its recipe's TTL (10 minutes), by recipe and slots, so "Delhi" and "DEL" are one search; while it
 * runs, the same search joins it, so an early start on intake and the composer's own call make one page load, and one
 * live search card: the card starts with the run and is marked done before the search answers.
 *
 * A search answers inline only through the browser fetch, within TRAVEL_WAIT_MS of its start; past that (and always for
 * the agent job, 25 to 55 s) the search tool goes on and the options come when the run finishes (waitMs).
 */
import type { LiveSearch } from '../live-search.js';
import { TravelError } from '../mcp-travel.js';
import type { TravelBackend, TravelKind, TravelQuery, TravelSearch } from '../travel.js';
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
  now: () => Date;
  /** The live search card for a run; absent in tests that don't look at it. */
  live?: (tripId: string, o: { runKey: string; kind: TravelKind; query: TravelQuery }) => LiveSearch;
}

const BOOK_ON_IXIGO = 'Options from ixigo.com are booked on ixigo, from their link.';
const CACHE_MAX = 200;

export function createIxigoWebBackend(d: IxigoWebDeps): TravelBackend {
  const kept = new Map<string, { at: number; ttl: number; search: Promise<TravelSearch> }>();

  /** The recipe, its runner and the search's key, or a plain refusal before anything runs. */
  async function plan(kind: TravelKind, q: TravelQuery, tripId: string | undefined) {
    if (!tripId) throw new TravelError('refused', "An ixigo.com search runs on a trip's computer, so it needs the trip.");
    const recipe = RECIPES[kind];
    const runner = d.runner(recipe);
    if (!runner) throw new TravelError('refused', "An ixigo.com search needs the trip's computer, which is not set up here.");
    const slots = recipe.slotsFrom(q, { people: Math.max(1, await d.peopleOf(tripId)) });
    // The page is ixigo's public results, the same in any trip's browser: the trip runs it, the slots key it.
    return { tripId, recipe, runner, slots, key: `${recipe.id}|${JSON.stringify(slots)}` };
  }

  return {
    async search(kind, q, o) {
      const { tripId, recipe, runner, slots, key } = await plan(kind, q, o?.tripId);
      const nowMs = d.now().getTime();
      const hit = kept.get(key);
      if (hit && nowMs - hit.at < hit.ttl) return hit.search;
      const runId = `${key}|${nowMs}`;
      const live = d.live?.(tripId, { runKey: runId, kind, query: q });
      const search = runner.run(tripId, recipe, slots, live ? { onProgress: live.progress } : {}).then(
        async (run): Promise<TravelSearch> => {
          live?.progress({ type: 'extracted', count: run.options.length });
          // The card is done before the options card posts.
          await live?.finish(true);
          return { results: run.options, checkedAt: run.checkedAt, runId };
        },
        async (err: unknown): Promise<never> => {
          live?.progress({ type: 'failed', code: err instanceof TravelError ? err.code : 'failed' });
          await live?.finish(false);
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
      if (!p) return null;
      if (p.runner.name === 'agent_job') return 0;
      const started = kept.get(p.key)?.at ?? d.now().getTime();
      return Math.max(0, TRAVEL_WAIT_MS - (d.now().getTime() - started));
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
