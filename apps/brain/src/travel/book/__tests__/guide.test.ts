import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TurnCtx } from '../../../composer/tools.js';
import { TravelError } from '../../mcp-travel.js';
import { capture } from '../../recipes/__tests__/fixtures.js';
import { flightOfPage, flightValues, readBodyAs, withoutCredentials } from '../bodies.js';
import { BOOK_DIR, loadBook } from '../book.js';
import { createEngine } from '../engine.js';
import { ixigoTool, NAMES_ONLY_FROM_IXIGO, toolRecipes } from '../tool.js';

const { book } = loadBook();
const sample = (name: string): string => readFileSync(`${BOOK_DIR}samples/${name}`, 'utf8');
/** The page's own credentials, as the samples carry them (p1-b's raw payload, their values replaced). */
const CREDENTIALS = /apikey|deviceId|"uuid"|REDACTED|otpless/i;

describe("a page's body", () => {
  it("drops the page's own credentials wherever they are, before anything reads it", () => {
    expect(withoutCredentials({ apiKey: 'k', data: [{ deviceId: 'd', uuid: 'u', name: 'Baga Beach', auth: { token: 't' } }], api_key: 'k2', OTPlessInId: 'o' }))
      .toEqual({ data: [{ name: 'Baga Beach' }] });
    expect(sample('plan.destination.rsc.txt')).toMatch(/"apiKey":"REDACTED"/);
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
        return { captures: [capture('/plan/goa$', url, sample('plan.destination.html'))], finalUrl: url };
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
    const guide = got.rows[0]!;
    expect(guide).toMatchObject({ destination: 'Goa, India', best_time: 'November - March' });
    expect(guide['weather_by_month']).toHaveLength(12);
    expect(guide['weather_by_month']).toContain('JAN: 16 to 34 C. January in Goa is characterized by mild temperatures with clear skies and good air quality.');
    expect(guide['places_to_visit']).toHaveLength(36);
    expect((guide['places_to_visit'] as string[]).slice(0, 3)).toEqual(['Baga Beach (4.5): Water sports and nightlife', 'Dudhsagar Falls (4.6): Spectacular waterfall in the jungle', 'Cape Goa Cliff (4.6): Great place for influencers']);
    expect(guide['places_to_eat']).toHaveLength(20);
    expect((guide['places_to_eat'] as string[]).slice(0, 3)).toEqual(['The Bodhi Tree Cafe and Bar (4.8)', 'THE SINGH FAMILY RESTAURANT & BAR PALOLEM GOA (4.7)', 'Cafe de port (4.8)']);
    expect(guide['ideas']).toEqual(['Beachfront Meditation Retreat', 'Goan Culinary Adventure', 'Wildlife Safari Excursion', 'Water Sports Extravaganza', 'Heritage Village Exploration']);
    expect(JSON.stringify(got)).not.toMatch(CREDENTIALS);
  });

  it("keeps the one page's document, whatever the place, and answers no guide with no rows, never an error", async () => {
    const plans: Array<{ url: string; match: string }> = [];
    const notFound = `<html><body><script>self.__next_f.push([1,${JSON.stringify('0:{"notFound":true}\n')}])</script></body></html>`;
    const runner = {
      read: async (_t: string, url: string, plan: { capture: Array<{ match: string }> }) => {
        plans.push({ url, match: plan.capture[0]!.match });
        return { captures: [capture('/plan/north-goa$', url, notFound)], finalUrl: url };
      },
    };
    const engine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-07T12:00:00Z') });
    const got = await engine.answer('plan.destination', { place: 'North Goa' }, { tripId: 't_goa' });
    expect(plans).toEqual([{ url: 'https://www.ixigo.com/plan/north-goa', match: '/plan/north-goa$' }]);
    expect(got).toMatchObject({ as: 'facts', rows: [] });
    const tool = ixigoTool({ book, engine, live: () => true })!;
    expect(await tool.run({ recipe: 'plan.destination', inputs: { place: 'North Goa' } }, { tripId: 't_goa' } as unknown as TurnCtx))
      .toMatchObject({ facts: [], note: expect.stringContaining('Answer from what you know, as a well-travelled friend would, with no word about ixigo') });
    // Gate 2 for #314, 10 Oct: an empty guide became "Sorry, I don't have a pick". Nothing in the note asks Go to say so.
    const empty = (await tool.run({ recipe: 'plan.destination', inputs: { place: 'North Goa' } }, { tripId: 't_goa' } as unknown as TurnCtx)) as { note: string };
    expect(empty.note).not.toMatch(/say so/i);
    expect(empty.note).toContain('a cafe, restaurant, bar, beach shack, club or shop never from memory');
  });

  it('keeps the guide per destination: the second question about the same place is instant, and counted as kept', async () => {
    const w = world();
    await w.engine.answer('plan.destination', { place: 'Goa' }, { tripId: 't_goa' });
    await w.engine.answer('plan.destination', { place: ' goa ' }, { tripId: 't_goa' });
    expect(w.reads()).toBe(1);
    expect(w.engine.stats().map((s) => [s.recipe, s.speed, s.runs])).toEqual(expect.arrayContaining([['plan.destination', 'page', 1], ['plan.destination', 'kept', 1]]));
  });
});

describe('flights.fare_calendar', () => {
  it("answers with each day's cheapest fare around the date, from ixigo's own fare calendar", async () => {
    const body = sample('flights.fare_calendar.json');
    const runner = { read: async (_t: string, url: string) => ({ captures: [capture('/outlook/v1/onward/ranged', 'https://www.ixigo.com/outlook/v1/onward/ranged?origin=DEL', body)], finalUrl: url }) };
    const engine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-07T12:00:00Z') });
    const got = await engine.answer('flights.fare_calendar', { from: 'Delhi', to: 'Goa', date: '2026-11-06' }, { tripId: 't_goa' });
    if (got.as !== 'facts') throw new Error('not facts');
    expect(got.title).toBe('Cheapest fares, Delhi to Goa');
    expect(got.page).toBe('https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026&adults=1&children=0&infants=0&class=e&source=Search%20Form');
    expect(got.rows).toHaveLength(10);
    expect(got.rows.slice(0, 3)).toEqual([
      { date: '22-10-2026', cheapest_fare: '₹10,194 per person', airline: 'Air-India Express', flight: 'IX1817' },
      { date: '23-10-2026', cheapest_fare: '₹10,194 per person', airline: 'Air-India Express', flight: 'IX1049' },
      { date: '24-10-2026', cheapest_fare: '₹8,618 per person', airline: 'IndiGo', flight: '6E2271' },
    ]);
  });
});

describe('the ixigo tool', () => {
  const turn = { tripId: 't_goa', turnId: 'turn_1', cards: [], stableId: (p: string) => `${p}_1` } as unknown as TurnCtx;

  it("offers the book's facts recipes, never a search, a lookup or one that changes something", () => {
    expect(toolRecipes(book).map((r) => r.id)).toEqual([
      'buses.offers', 'buses.stops', 'flights.fare_calendar', 'help.downtime', 'help.faq', 'help.services',
      'hotels.details', 'hotels.offers', 'hotels.reviews', 'hotels.rooms', 'hotels.search_filters', 'hotels.similar',
      'offers.campaign', 'offers.details', 'offers.list', 'plan.destination', 'plan.explore', 'plan.top_locations',
      'trains.alternate_dates', 'trains.alternate_travel_plan', 'trains.alternates', 'trains.by_name', 'trains.confirm_chance', 'trains.offers',
      'trains.platform_locator', 'trains.running_status', 'trains.schedule', 'trains.station_status', 'trains.tatkal',
    ]);
    const tool = ixigoTool({ book, engine: { answer: async () => { throw new Error('unused'); } }, live: () => true })!;
    expect(tool.description).toContain("- plan.destination (place): A destination's guide on ixigo.");
  });

  // Keshav, 10 Oct: "I want users to see how the agent is acting on the ixigo site". A guide, a running status, a PNR the
  // tool runs is watched as a search is: its page opens on the stage, and the room's live card shows it.
  it("runs a recipe on the stage with a live card (its progress is the run's), done when it answers, failed when it doesn't", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const cards: Array<{ recipe: string; events: string[]; finished: boolean | null }> = [];
    const card = (_trip: string, o: { runKey: string; recipe: string }) => {
      const c = { recipe: o.recipe, events: [] as string[], finished: null as boolean | null };
      cards.push(c);
      return { progress: (e: { type: string }) => c.events.push(e.type), finish: async (ok: boolean) => { c.finished = ok; } };
    };
    const engine = {
      answer: async (id: string, _given: Record<string, unknown>, o: Record<string, unknown> & { onProgress?: (e: { type: string }) => void }) => {
        seen.push(o);
        o.onProgress?.({ type: 'opening' });
        if (id === 'plan.explore') throw new TravelError('unreachable', 'ixigo took too long to answer.');
        return { as: 'facts' as const, title: 'Goa', rows: [{ a: 1 }], page: 'https://www.ixigo.com/plan/goa', checkedAt: '2026-10-10T05:00:00.000Z', ms: 3_000 };
      },
    };
    const tool = ixigoTool({ book, engine: engine as never, live: () => true, card: card as never, cardDelayMs: 0 })!;
    await tool.run({ recipe: 'plan.destination', inputs: { place: 'Goa' } }, turn);
    // Watched: the run has the card's progress, so the engine puts its page on the stage.
    expect(typeof seen[0]!.onProgress).toBe('function');
    expect(cards[0]).toEqual({ recipe: book.all().find((r) => r.id === 'plan.destination')!.title, events: ['opening', 'extracted'], finished: true });
    await tool.run({ recipe: 'plan.explore', inputs: { month: '2026-12-01' } }, turn);
    expect(cards[1]!.finished).toBe(false);
    // With no live card here (a test, another mode), the run is as before: no progress, so off the stage.
    await ixigoTool({ book, engine: engine as never, live: () => true })!.run({ recipe: 'plan.destination', inputs: { place: 'Goa' } }, turn);
    expect(seen.at(-1)!.onProgress).toBeUndefined();
  });

  it("joins a read the early start began for this turn's message on that read's own card, and keys its own card otherwise", async () => {
    const keys: string[] = [];
    const card = (_trip: string, o: { runKey: string; recipe: string }) => {
      keys.push(o.runKey);
      return { progress: () => undefined, finish: async () => undefined };
    };
    const engine = { answer: async () => ({ as: 'facts' as const, title: 'Goa', rows: [], page: 'https://www.ixigo.com/plan/goa', checkedAt: '2026-10-10T05:00:00.000Z', ms: 900 }) };
    const asked: Array<{ recipe: string; inputs: Record<string, string | number> }> = [];
    const joinKey = (_ctx: TurnCtx, recipe: string, inputs: Record<string, string | number>) => {
      asked.push({ recipe, inputs });
      return inputs['place'] === 'Goa' ? 'early:m_7|plan.destination' : null;
    };
    const tool = ixigoTool({ book, engine: engine as never, live: () => true, card: card as never, cardDelayMs: 0, joinKey })!;
    await tool.run({ recipe: 'plan.destination', inputs: { place: 'Goa' } }, turn);
    await tool.run({ recipe: 'plan.destination', inputs: { place: 'Gokarna' } }, turn);
    expect(asked).toEqual([{ recipe: 'plan.destination', inputs: { place: 'Goa' } }, { recipe: 'plan.destination', inputs: { place: 'Gokarna' } }]);
    expect(keys[0]).toBe('early:m_7|plan.destination');
    expect(keys[1]).toBe(`${turn.turnId ?? ''}|plan.destination|${JSON.stringify({ place: 'Gokarna' })}`);
  });

  it('describes the book in one short line a recipe, the same bytes on every turn, so it stays cheap as the book grows', () => {
    const unused = { answer: async () => { throw new Error('unused'); } };
    const tool = ixigoTool({ book, engine: unused, live: () => true })!;
    const recipes = toolRecipes(book);
    // One line a recipe, in id order, a blank line between sections.
    const lines = tool.description.split('\n').filter((l) => l.startsWith('- '));
    expect(lines.map((l) => l.slice(2).split(/[ :]/)[0])).toEqual(recipes.map((r) => r.id));
    expect(tool.description).toContain("- trains.schedule (train): A train's route and timetable.\n");
    expect(tool.description).toContain('\n\n- trains.alternate_dates (from, to, date): ');
    // A choice's values are said, since the model can't guess them; nothing else about an input.
    expect(tool.description).toContain("- plan.explore (origin, month, theme?): Where to go from a city in a month. theme: one of ixigo's themes: beaches, festivals, mountains, wildlife, cultural or romantic.");
    // How people ask is for Jev and the tests, never the prompt.
    for (const r of recipes) for (const ask of r.asks) expect(tool.description, r.id).not.toContain(ask);
    // Short: at most 140 characters a recipe besides a choice's values (27 recipes: about 2,700, from 8,300).
    const choices = recipes.flatMap((r) => Object.values(r.inputs).filter((i) => i.kind === 'choice' && !i.value).map((i) => (i.about ?? '').length + 12));
    expect(tool.description.length - choices.reduce((a, b) => a + b, 0)).toBeLessThan(140 * recipes.length + 300);
    // The same bytes on every turn and every build: the prompt cache holds them.
    expect(ixigoTool({ book, engine: unused, live: () => true })!.description).toBe(tool.description);
    expect(ixigoTool({ book, engine: unused, live: () => false })!.description).toBe(tool.description);
  });

  it('answers a call that went wrong with the recipe\'s inputs in full, to call it again with', async () => {
    const engine = createEngine({ book, runner: () => null, trip: async () => ({ people: 4, homes: [] }), now: () => new Date() });
    const out = (await ixigoTool({ book, engine, live: () => true })!.run({ recipe: 'plan.explore', inputs: { month: '2026-12-01' } }, turn)) as Record<string, unknown>;
    expect(out).toMatchObject({ recipe: 'plan.explore', error: 'needs_more' });
    expect(out['inputs']).toEqual({
      origin: 'the city the group would start from, such as Delhi or Bengaluru',
      month: 'any day in the month they would travel',
      theme: "optional; one of ixigo's themes: beaches, festivals, mountains, wildlife, cultural or romantic",
    });
  });

  it("answers with the guide's facts, and tells the model to name only the places in them", async () => {
    const runner = { read: async (_t: string, url: string) => ({ captures: [capture('/plan/goa$', url, sample('plan.destination.html'))], finalUrl: url }) };
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
