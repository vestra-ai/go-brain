import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TurnCtx } from '../../../composer/tools.js';
import { capture } from '../../recipes/__tests__/fixtures.js';
import { flightOfPage, flightValues, readBodyAs, withoutCredentials } from '../bodies.js';
import { BOOK_DIR, loadBook } from '../book.js';
import { createEngine } from '../engine.js';
import { ixigoTool, NAMES_ONLY_FROM_IXIGO, toolRecipes } from '../tool.js';

const { book } = loadBook();
const sample = (name: string): string => readFileSync(`${BOOK_DIR}samples/${name}`, 'utf8');
/** The page's own credentials, as the samples carry them (their values replaced). */
const CREDENTIALS = /apikey|deviceId|"uuid"|REDACTED|token/;

describe("a page's body", () => {
  it("drops the page's own credentials wherever they are, before anything reads it", () => {
    expect(withoutCredentials({ apikey: 'k', data: [{ deviceId: 'd', uuid: 'u', name: 'Baga Beach', auth: { token: 't' } }], api_key: 'k2' }))
      .toEqual({ data: [{ name: 'Baga Beach' }] });
    expect(JSON.stringify(readBodyAs(sample('plan.destination.rsc.txt'), 'rsc', 'the guide'))).not.toMatch(CREDENTIALS);
    expect(JSON.stringify(readBodyAs(sample('plan.destination.html'), 'next_html', 'the guide'))).not.toMatch(CREDENTIALS);
  });

  it("reads a Next.js flight payload line by line, a text chunk where a value points at it, and the same payload from the page's scripts", () => {
    const values = flightValues('0:{"a":1}\n1:I["chunk.js"]\n2:["$","$L1",null,{"faq":"$2c"}]\n2c:T12,<p>By air.</p>\nnot a line\n');
    expect(values).toEqual([{ a: 1 }, ['chunk.js'], ['$', '$L1', null, { faq: '<p>By air.</p>' }]]);
    expect(flightOfPage(sample('plan.destination.html'))).toBe(sample('plan.destination.rsc.txt'));
    expect(() => readBodyAs('<html>no payload</html>', 'next_html', 'the guide')).toThrow(/shape Go does not read/);
  });
});

describe('plan.destination', () => {
  function world() {
    let reads = 0;
    const runner = {
      read: async (_t: string, url: string) => {
        reads += 1;
        return { captures: [capture('/plan/', url, sample('plan.destination.html'))], finalUrl: url };
      },
    };
    const engine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-07T12:00:00Z') });
    return { engine, reads: () => reads };
  }

  it("answers from ixigo's guide: the best time, the weather by month, and the places to visit and to eat, with ratings", async () => {
    const w = world();
    const got = await w.engine.answer('plan.destination', { place: 'Goa' }, { tripId: 't_goa' });
    if (got.as !== 'facts') throw new Error('not facts');
    expect(got.page).toBe('https://www.ixigo.com/plan/goa');
    expect(got.title).toBe('Goa');
    expect(got.rows).toHaveLength(1);
    expect(got.rows[0]).toMatchObject({
      destination: 'Goa, India',
      best_time: 'November - March',
      places_to_visit: ['Baga Beach (4.5): Water sports and nightlife', 'Dudhsagar Falls (4.6): Spectacular waterfall in the jungle', 'Cape Goa Cliff (4.6): Great place for influencers'],
      places_to_eat: ['The Bodhi Tree Cafe and Bar (4.8)', 'THE SINGH FAMILY RESTAURANT & BAR PALOLEM GOA (4.7)', 'Cafe de port (4.8)'],
    });
    expect(got.rows[0]!['weather_by_month']).toContain('JAN: 16 to 34 C. January in Goa is characterized by mild temperatures with clear skies and good air quality.');
    expect(got.rows[0]!['questions']).toContain('How can you reach Goa? By air to Dabolim or Mopa, by train to Madgaon, or by road.');
    expect(JSON.stringify(got)).not.toMatch(CREDENTIALS);
  });

  it('keeps the guide per destination: the second question about the same place is instant, and counted as kept', async () => {
    const w = world();
    await w.engine.answer('plan.destination', { place: 'Goa' }, { tripId: 't_goa' });
    await w.engine.answer('plan.destination', { place: ' goa ' }, { tripId: 't_goa' });
    expect(w.reads()).toBe(1);
    expect(w.engine.stats().map((s) => [s.recipe, s.speed, s.runs])).toEqual(expect.arrayContaining([['plan.destination', 'page', 1], ['plan.destination', 'kept', 1]]));
  });
});

describe('the ixigo tool', () => {
  const turn = { tripId: 't_goa', turnId: 'turn_1', cards: [], stableId: (p: string) => `${p}_1` } as unknown as TurnCtx;

  it("offers the book's facts recipes, never a search, a lookup or one that changes something", () => {
    expect(toolRecipes(book).map((r) => r.id)).toEqual(['plan.destination']);
    const tool = ixigoTool({ book, engine: { answer: async () => { throw new Error('unused'); } }, live: () => true })!;
    expect(tool.description).toContain('- plan.destination: A destination');
    expect(tool.description).toContain('Asked as: "best time to visit goa", "good places to eat in goa"');
  });

  it("answers with the guide's facts, and tells the model to name only the places in them", async () => {
    const runner = { read: async (_t: string, url: string) => ({ captures: [capture('/plan/', url, sample('plan.destination.html'))], finalUrl: url }) };
    const engine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => new Date() });
    const tool = ixigoTool({ book, engine, live: () => true })!;
    const out = (await tool.run({ recipe: 'plan.destination', inputs: { place: 'Goa' } }, turn)) as Record<string, unknown>;
    expect(out).toMatchObject({ recipe: 'plan.destination', title: 'Goa', source: 'https://www.ixigo.com/plan/goa', tell_the_room: NAMES_ONLY_FROM_IXIGO });
    expect((out['facts'] as Array<Record<string, unknown>>)[0]!['places_to_eat']).toContain('Cafe de port (4.8)');
    expect(NAMES_ONLY_FROM_IXIGO).toContain('never one from memory');
    // Off ixigo_web the recipes don't run.
    const off = ixigoTool({ book, engine, live: () => false })!;
    expect(await off.run({ recipe: 'plan.destination', inputs: { place: 'Goa' } }, turn)).toMatchObject({ error: 'not_here' });
    // A page that sends nothing Go reads: said plainly, as an error the model reads.
    const empty = createEngine({ book, runner: () => ({ read: async (_t: string, url: string) => ({ captures: [], finalUrl: url }) }), trip: async () => ({ people: 4, homes: [] }), now: () => new Date() });
    expect(await ixigoTool({ book, engine: empty, live: () => true })!.run({ recipe: 'plan.destination', inputs: { place: 'Goa' } }, turn)).toMatchObject({ error: 'refused' });
  });
});
