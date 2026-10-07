import { describe, expect, it } from 'vitest';
import type { TurnCtx } from '../../../composer/tools.js';
import type { FetchPlan } from '../../recipes/recipe.js';
import { capture } from '../../recipes/__tests__/fixtures.js';
import type { ResultsStore } from '../../results.js';
import { checkRecipe, loadBook, type Book } from '../book.js';
import { createEngine } from '../engine.js';
import type { RecipeFile } from '../format.js';
import { ixigoTool } from '../tool.js';

const { book } = loadBook();

/** The book with one more recipe, checked as the loader checks a file. */
function bookWith(path: string, text: string): Book {
  const checked = checkRecipe(path, text);
  if (!('recipe' in checked)) throw new Error(checked.problems.join('\n'));
  const extra: RecipeFile = checked.recipe;
  return { get: (id) => (id === extra.id ? extra : book.get(id)), all: () => [...book.all(), extra] };
}

// A stay's details, from one of Go's search results: the option's own ixigo page, its ids read off it. An example id,
// so it never meets the book's own hotels.details.
const DETAILS = `id: example.option_details
title: A stay's details, from one of Go's search results
asks: [tell me more about option 2, does villa sol have a pool]
inputs:
  hotel: { kind: option, about: the stay }
  area: { kind: text, optional: true, about: an area to look in }
auth: none
changes_state: false
let:
  hotel_id: |
    $groups(hotel, "/hotels/(\\\\d+)/details")[0]
page: /hotels/{$hotel_id}/details
fetch:
  - when: "true"
    steps:
      - { op: type, role: textbox, name: "Search within {area}", text: "{area}" }
      - { op: wait_for, match: /hotel-details$ }
capture: [/hotel-details$]
read:
  rows: { from: /hotel-details$, list: data }
answer:
  as: facts
  title: "{$hotel_id}"
  each: "{ 'name': name, 'pool': pool }"
`;

describe('a fetch step filled from the inputs', () => {
  it("types the person's words and names the control from the inputs, as a box's steps do", async () => {
    const plans: FetchPlan[] = [];
    const b = bookWith('example/option_details.yaml', DETAILS);
    const runner = {
      read: async (_t: string, url: string, plan: FetchPlan) => {
        plans.push(plan);
        return { captures: [capture('/hotel-details$', 'https://www.ixigo.com/api/hotel-details', '{"data":[{"name":"Villa Sol","pool":true}]}')], finalUrl: url };
      },
    };
    const engine = createEngine({ book: b, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-07T12:00:00Z') });
    const got = await engine.answer('example.option_details', { hotel: 'https://www.ixigo.com/hotels/1384544/details?x=1', area: 'Old Manali' }, { tripId: 't' });
    expect(plans[0]!.steps).toEqual([{ op: 'type', role: 'textbox', name: 'Search within Old Manali', text: 'Old Manali' }, { op: 'wait_for', match: '/hotel-details$' }]);
    expect(got).toMatchObject({ as: 'facts', title: '1384544', page: 'https://www.ixigo.com/hotels/1384544/details', rows: [{ name: 'Villa Sol', pool: true }] });
  });
});

describe('an option input', () => {
  it("is one of Go's search results, written results_id#n: the tool gives the recipe that option's own ixigo page", async () => {
    const b = bookWith('example/option_details.yaml', DETAILS);
    const given: unknown[] = [];
    const engine = {
      answer: async (_id: string, g: Record<string, unknown>) => {
        given.push(g);
        return { as: 'facts' as const, title: 'Villa Sol', rows: [{ name: 'Villa Sol' }], page: 'https://www.ixigo.com/hotels/1/details', checkedAt: '2026-10-07T12:00:00.000Z', ms: 1 };
      },
    };
    const results = {
      get: async (tripId: string, resultsId: string) =>
        tripId === 't_goa' && resultsId === 'r_ab12'
          ? { options: [{ sourceUrl: 'https://www.ixigo.com/hotels/1/details?a=1' }, { sourceUrl: 'https://www.ixigo.com/hotels/2/details?b=2' }] }
          : null,
    } as unknown as Pick<ResultsStore, 'get'>;
    const tool = ixigoTool({ book: b, engine, results, live: () => true })!;
    expect(tool.description).toContain('hotel (an option from search results, written results_id#n, like r_ab12#2)');
    const turn = { tripId: 't_goa', turnId: 'turn_1', cards: [], stableId: (p: string) => `${p}_1` } as unknown as TurnCtx;
    expect(await tool.run({ recipe: 'example.option_details', inputs: { hotel: 'r_ab12#2' } }, turn)).toMatchObject({ recipe: 'example.option_details', facts: [{ name: 'Villa Sol' }] });
    expect(given).toEqual([{ hotel: 'https://www.ixigo.com/hotels/2/details?b=2' }]);
    // Not an option of this trip's results: said plainly, nothing runs.
    expect(await tool.run({ recipe: 'example.option_details', inputs: { hotel: 'r_ab12#9' } }, turn)).toMatchObject({ error: 'needs_more' });
    expect(await tool.run({ recipe: 'example.option_details', inputs: { hotel: 'Villa Sol' } }, turn)).toMatchObject({ error: 'needs_more' });
    expect(given).toHaveLength(1);
  });
});
