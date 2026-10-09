/**
 * The trip's sites' own lists of what they offer (offers.ts), in the turn's context: the model maps the group's ask onto
 * them by name, so the search is the site's filtered one from its first call ("you can search by using the filters
 * already"); what no list has is the model's to pick from the results (wants). AI comes from Go, never from the site.
 */
import type { NowProvider } from '../../composer/context.js';
import { clip } from '../cards.js';
import { searchKindOf } from './backend.js';
import { offersText, type Offers } from './offers.js';

/** After the travel search's own block (35). */
export const OFFERS_ORDER = 36;
/** A list in the prompt is under a thousand tokens. */
const MAX_CHARS = 4_000;

export function offersNow(d: { offers: Offers }): NowProvider {
  return {
    name: 'site offers',
    order: OFFERS_ORDER,
    async render(tripId) {
      const lines = d.offers.forTrip(tripId).flatMap((l) => {
        const kind = searchKindOf(l.recipeId);
        if (!kind) return [];
        return [
          `ixigo's own filters and sorts for ${l.about}, as its page lists them: ${clip(offersText(l), MAX_CHARS)}. ` +
            `On search_${kind}, put the ones the ask means in site_filters (and site_sort), by these names, so ixigo filters itself: ` +
            "the nearest name for what they said, as a person would pick it on ixigo's page, keeping their own word in wants too when ixigo's is only near it; " +
            'a bare number with its heading ("Star Rating 5"). Anything else the group asked for goes in wants, and you pick it from the results.',
        ];
      });
      return lines.length > 0 ? lines.join('\n') : null;
    },
  };
}
