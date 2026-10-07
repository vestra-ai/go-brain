/**
 * TRAVEL_MODE ixigo_web: Go's travel search on ixigo.com itself, through the recipes. Each search runs in the trip's own
 * browser, so it needs the trip. Its options carry their ixigo.com page and no offer id: the group books on ixigo, and
 * Go never holds or pays for them.
 */
import { TravelError } from '../mcp-travel.js';
import type { TravelBackend } from '../travel.js';
import { RECIPES } from './index.js';
import type { RecipeRunner } from './runners.js';

export interface IxigoWebDeps {
  /** The runner the TRAVEL_RUNNER switch names now; null while the trip's computer is not set up here (no /v1 settings). */
  runner: () => RecipeRunner | null;
  /** The trip's head count: the adults (and so the rooms) a search asks for when nobody gave a number. */
  peopleOf: (tripId: string) => Promise<number>;
}

const BOOK_ON_IXIGO = 'Options from ixigo.com are booked on ixigo, from their link.';

export function createIxigoWebBackend(d: IxigoWebDeps): TravelBackend {
  return {
    async search(kind, q, o) {
      if (!o?.tripId) throw new TravelError('refused', "An ixigo.com search runs on a trip's computer, so it needs the trip.");
      const runner = d.runner();
      if (!runner) throw new TravelError('refused', "An ixigo.com search needs the trip's computer, which is not set up here.");
      const recipe = RECIPES[kind];
      const slots = recipe.slotsFrom(q, { people: Math.max(1, await d.peopleOf(o.tripId)) });
      const run = await runner.run(o.tripId, recipe, slots);
      return { results: run.options, checkedAt: run.checkedAt };
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
