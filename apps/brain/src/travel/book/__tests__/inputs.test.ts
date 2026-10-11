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
    expect(tool.description).toContain('- example.option_details (hotel#, area?): ');
    expect(tool.description).toContain('# an option from this trip\'s search results, written results_id#n like r_ab12#2');
    const turn = { tripId: 't_goa', turnId: 'turn_1', cards: [], stableId: (p: string) => `${p}_1` } as unknown as TurnCtx;
    expect(await tool.run({ recipe: 'example.option_details', inputs: { hotel: 'r_ab12#2' } }, turn)).toMatchObject({ recipe: 'example.option_details', facts: [{ name: 'Villa Sol' }] });
    expect(given).toEqual([{ hotel: 'https://www.ixigo.com/hotels/2/details?b=2' }]);
    // Not an option of this trip's results: said plainly, nothing runs.
    expect(await tool.run({ recipe: 'example.option_details', inputs: { hotel: 'r_ab12#9' } }, turn)).toMatchObject({
      error: 'needs_more', inputs: { hotel: "an option from search results, written results_id#n, like r_ab12#2, or an options card's id#n for its option n, like c_opt_ab12#1" },
    });
    expect(await tool.run({ recipe: 'example.option_details', inputs: { hotel: 'Villa Sol' } }, turn)).toMatchObject({ error: 'needs_more' });
    expect(given).toHaveLength(1);
  });

  // The C3 drill (10 Oct): a follow-up on a card from an earlier turn ("the first bus") had no results_id and searched
  // again. The chat numbers each options card's options, so card_id#n is that option, as the room sees it.
  it("is an options card's option too, by its number on the card: card_id#n", async () => {
    const b = bookWith('example/option_details.yaml', DETAILS);
    const given: unknown[] = [];
    const engine = {
      answer: async (_id: string, g: Record<string, unknown>) => {
        given.push(g);
        return { as: 'facts' as const, title: 'Villa Sol', rows: [{ name: 'Villa Sol' }], page: 'https://www.ixigo.com/hotels/7/details', checkedAt: '2026-10-07T12:00:00.000Z', ms: 1 };
      },
    };
    const results = {
      get: async () => null,
      card: async (tripId: string, cardId: string) =>
        tripId === 't_goa' && cardId === 'c_opt_villas' ? { card: { options: [{ option_id: 'opt_villas_1' }, { option_id: 'opt_villas_2' }] } } : null,
      offer: async (optionId: string) => (optionId === 'opt_villas_2' ? { sourceUrl: 'https://www.ixigo.com/hotels/7/details?c=2' } : null),
    } as unknown as Pick<ResultsStore, 'get' | 'card' | 'offer'>;
    const tool = ixigoTool({ book: b, engine, results, live: () => true })!;
    expect(tool.description).toContain("or an options card's id#n as the chat numbers its options, like c_opt_ab12#1");
    const turn = { tripId: 't_goa', turnId: 'turn_1', cards: [], stableId: (p: string) => `${p}_1` } as unknown as TurnCtx;
    expect(await tool.run({ recipe: 'example.option_details', inputs: { hotel: 'c_opt_villas#2' } }, turn)).toMatchObject({ facts: [{ name: 'Villa Sol' }] });
    expect(given).toEqual([{ hotel: 'https://www.ixigo.com/hotels/7/details?c=2' }]);
    // No such option on the card, or a card of another trip: said plainly, nothing runs.
    expect(await tool.run({ recipe: 'example.option_details', inputs: { hotel: 'c_opt_villas#3' } }, turn)).toMatchObject({ error: 'needs_more' });
    expect(await tool.run({ recipe: 'example.option_details', inputs: { hotel: 'c_opt_other#1' } }, turn)).toMatchObject({ error: 'needs_more' });
    expect(given).toHaveLength(1);
  });

  // The exam, 10 Oct (#17): "can we lock the price while we vote?" was answered "I can't", with each flight's Lock Price
  // read and kept by its search. option.facts says what ixigo showed for an option, by results_id#n or card_id#n, and
  // opens no page.
  it("says an option's kept facts, Lock Price and all, by results_id#n or card_id#n, opening no page, ixigo.com or not", async () => {
    const flight = {
      kind: 'flight', title: 'IndiGo 6E 2134', priceMinor: 592_000, currency: 'INR', priceNote: 'per person', highlights: ['Non-stop'],
      facts: { lock: 'Lock Price ₹349 a person, holds 72 h', refundable: 'partly', photo_list: [{ url: 'https://x/y.jpg' }] },
      journey: { mode: 'flight', origin: { name: 'Delhi' }, destination: { name: 'Goa' }, depart_at: '2026-11-06T18:10:00+05:30', arrive_at: '2026-11-06T20:45:00+05:30' },
    };
    const set = { resultsId: 'r_fl', checkedAt: '2026-10-10T09:00:00.000Z', options: [flight] };
    const ran: string[] = [];
    const results = {
      get: async (tripId: string, id: string) => (tripId === 't_goa' && id === 'r_fl' ? set : null),
      card: async (tripId: string, cardId: string) => (tripId === 't_goa' && cardId === 'c_opt_fl' ? { card: { options: [{ option_id: 'opt_fl_1' }] } } : null),
      offer: async (optionId: string) => (optionId === 'opt_fl_1' ? { resultsId: 'r_fl', n: 1 } : null),
    } as unknown as Pick<ResultsStore, 'get' | 'card' | 'offer'>;
    const tool = ixigoTool({ book, engine: { answer: async (id: string) => { ran.push(id); throw new Error('no page'); } }, results, live: () => false })!;
    // The exam's re-run (10 Oct): the turn still said "I can't lock a price"; the line leads with the asks it answers.
    expect(tool.description).toMatch(/\n\n- option\.facts \(option#\): Can we lock its price, is it refundable, how many seats are left: what ixigo showed for one option/);
    const turn = { tripId: 't_goa', turnId: 'turn_k', cards: [], stableId: (p: string) => `${p}_1` } as unknown as TurnCtx;
    const want = {
      recipe: 'option.facts', title: 'IndiGo 6E 2134', checked_at: '2026-10-10T09:00:00.000Z',
      facts: [{ title: 'IndiGo 6E 2134', price: '₹5,920 per person', lock: 'Lock Price ₹349 a person, holds 72 h', refundable: 'partly', leaves: '2026-11-06T18:10:00+05:30' }],
    };
    expect(await tool.run({ recipe: 'option.facts', inputs: { option: 'r_fl#1' } }, turn)).toMatchObject(want);
    expect(await tool.run({ recipe: 'option.facts', inputs: { option: 'c_opt_fl#1' } }, turn)).toMatchObject(want);
    // Never a photo list in the facts the model reads; an option that isn't there is said plainly.
    expect(((await tool.run({ recipe: 'option.facts', inputs: { option: 'r_fl#1' } }, turn)) as { facts: Array<Record<string, unknown>> }).facts[0]).not.toHaveProperty('photo_list');
    expect(await tool.run({ recipe: 'option.facts', inputs: { option: 'c_opt_fl#2' } }, turn)).toMatchObject({ error: 'needs_more' });
    expect(ran).toEqual([]);
    // Called as a tool of its own, it is sent back to the ixigo tool.
    expect(tool.misnamed?.('option_facts')).toContain('{"recipe": "option.facts"');
  });
});
