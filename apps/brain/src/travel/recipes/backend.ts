/**
 * TRAVEL_MODE ixigo_web: Go's travel search on ixigo.com itself, through the recipes. Each search runs in the trip's own
 * browser, so it needs the trip. Its options carry their ixigo.com page and no offer id: the group books on ixigo, and
 * Go never holds or pays for them.
 *
 * A search is kept for its recipe's TTL (10 minutes), by recipe and slots, so "Delhi" and "DEL" are one search; while it
 * runs, the same search joins it, so an early start on intake and the composer's own call make one page load.
 */
import { TravelError } from '../mcp-travel.js';
import type { TravelBackend, TravelSearch } from '../travel.js';
import { RECIPES } from './index.js';
import type { RecipeRunner } from './runners.js';

export interface IxigoWebDeps {
  /** The runner the TRAVEL_RUNNER switch names now; null while the trip's computer is not set up here (no /v1 settings). */
  runner: () => RecipeRunner | null;
  /** The trip's head count: the adults (and so the rooms) a search asks for when nobody gave a number. */
  peopleOf: (tripId: string) => Promise<number>;
  now: () => Date;
}

const BOOK_ON_IXIGO = 'Options from ixigo.com are booked on ixigo, from their link.';
const CACHE_MAX = 200;

export function createIxigoWebBackend(d: IxigoWebDeps): TravelBackend {
  const kept = new Map<string, { at: number; ttl: number; search: Promise<TravelSearch> }>();
  return {
    async search(kind, q, o) {
      if (!o?.tripId) throw new TravelError('refused', "An ixigo.com search runs on a trip's computer, so it needs the trip.");
      const runner = d.runner();
      if (!runner) throw new TravelError('refused', "An ixigo.com search needs the trip's computer, which is not set up here.");
      const recipe = RECIPES[kind];
      const slots = recipe.slotsFrom(q, { people: Math.max(1, await d.peopleOf(o.tripId)) });
      // The page is ixigo's public results, the same in any trip's browser: the trip runs it, the slots key it.
      const key = `${recipe.id}|${JSON.stringify(slots)}`;
      const nowMs = d.now().getTime();
      const hit = kept.get(key);
      if (hit && nowMs - hit.at < hit.ttl) return hit.search;
      const search = runner.run(o.tripId, recipe, slots).then((run) => ({ results: run.options, checkedAt: run.checkedAt }));
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
