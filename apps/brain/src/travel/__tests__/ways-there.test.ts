import * as C from '@go/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { makeLaneBrain, type LaneBrain } from '../../tasks/testing/lane-brain.js';
import type { EngineAnswer, StepAnswer } from '../book/engine.js';
import { TravelError } from '../mcp-travel.js';
import type { RecipeOption } from '../recipes/recipe.js';
import { createResultsStore, toResultOption, type ResultsStore } from '../results.js';
import { registerTravelTaps } from '../taps.js';
import { waysLine, waysOf, waysRows, waysThereTool, WAYS_THERE, type WayThere } from '../ways-there.js';

let db: Awaited<ReturnType<typeof withSchema>>;
let lb: LaneBrain;
let results: ResultsStore;

beforeAll(async () => {
  db = await withSchema();
  lb = makeLaneBrain({ pool: db.pool });
  results = createResultsStore(db.pool);
  registerTravelTaps(lb.taps, { results, link: lb.brain.door.link, desk: lb.brain.desk, now: lb.brain.now, log: lb.brain.log });
});
afterAll(async () => {
  await db.drop();
});

const at = (day: number, hhmm: string) => `2026-11-${String(day).padStart(2, '0')}T${hhmm}:00+05:30`;
function train(name: string, number: string, cls: string, rupees: number, depart: string, arrive: string, availability = 'Available 12'): RecipeOption {
  return {
    kind: 'train', title: `${name} ${number}`, priceMinor: rupees * 100, currency: 'INR', priceNote: `per person, ${cls}`,
    journey: { mode: 'train', origin: { name: 'New Delhi', code: 'NDLS' }, destination: { name: 'Madgaon', code: 'MAO' }, depart_at: depart, arrive_at: arrive, carrier_name: 'Indian Railways', number },
    highlights: [cls, availability], facts: { class_code: cls, availability }, sourceUrl: `https://www.ixigo.com/trains/${number}?orgn=NDLS&dstn=MAO&departDate=2026-11-06&quota=GN`,
  };
}
function bus(operator: string, rupees: number, depart: string, arrive: string, seats?: number): RecipeOption {
  return {
    kind: 'bus', title: operator, priceMinor: rupees * 100, currency: 'INR', priceNote: 'per seat, from',
    journey: { mode: 'bus', origin: { name: 'Mumbai' }, destination: { name: 'Goa' }, depart_at: depart, arrive_at: arrive, carrier_name: operator },
    highlights: ['A/C Sleeper'], facts: { bus_type: 'A/C Sleeper', ...(seats !== undefined ? { seats_left: seats } : {}) }, sourceUrl: 'https://www.ixigo.com/buses/bus_search/Mumbai/4/Goa/102/06-11-2026/O',
  };
}
const options = (list: RecipeOption[]): EngineAnswer => ({ as: 'options', options: list, page: 'https://www.ixigo.com/x', checkedAt: '2026-10-08T12:00:00.000Z', ms: 900 });
const flights = (from: string): StepAnswer => ({
  recipe: 'flights.search', answer: { as: 'link', link: `https://www.ixigo.com/search/result/flight?from=${from}&to=GOI&date=06112026&adults=1`, title: 'Flights', who: null },
});

/**
 * The Goa trip's three home cities. Delhi: the Goa Express sleeper is cheapest, the Rajdhani fastest, a full class
 * cheaper still, and the buses didn't come back. Mumbai: the Konkan Kanya beats the bus on both. Bangalore: nothing.
 */
const COMPARE: EngineAnswer = {
  as: 'compare',
  inputs: { to: 'North Goa', date: '2026-11-06' },
  checkedAt: '2026-10-08T12:00:00.000Z',
  ms: 3_100,
  entries: [
    {
      entry: 'Delhi',
      steps: [
        {
          recipe: 'trains.between',
          answer: options([
            train('Goa Express', '12779', '3A', 1_700, at(6, '15:00'), at(7, '17:10')),
            train('Goa Express', '12779', 'SL', 645, at(6, '15:00'), at(7, '17:10')),
            train('Rajdhani', '22413', '3A', 2_140, at(6, '06:00'), at(6, '21:30')),
            train('Rajdhani', '22413', '2A', 500, at(6, '06:00'), at(6, '21:30'), 'REGRET'),
          ]),
        },
        { recipe: 'buses.between', why: 'unreachable: ixigo took too long to answer.' },
        flights('DEL'),
      ],
    },
    { entry: 'Bangalore', steps: [{ recipe: 'trains.between', answer: options([]) }, { recipe: 'buses.between', answer: options([]) }, flights('BLR')] },
    {
      entry: 'Mumbai',
      steps: [
        { recipe: 'trains.between', answer: options([train('Konkan Kanya', '10111', 'SL', 420, at(6, '23:05'), at(7, '10:45'))]) },
        { recipe: 'buses.between', answer: options([bus('Zingbus', 900, at(6, '20:00'), at(7, '08:00')), bus('Paulo Travels', 300, at(6, '19:00'), at(7, '07:00'), 0)]) },
        flights('BOM'),
      ],
    },
  ],
};

const toolWith = (answer: () => Promise<EngineAnswer>, live = true) =>
  waysThereTool({ engine: { answer: async (id) => (id === WAYS_THERE ? answer() : Promise.reject(new Error(id))) }, results, live: () => live });

describe("each home city's ways to the trip", () => {
  it("picks each city's cheapest and fastest seat people can still buy, and says what didn't come back", () => {
    if (COMPARE.as !== 'compare') return;
    const ways = waysOf(COMPARE, lb.ctx().pack.trip.people);
    expect(ways.map((w) => [w.home, w.people, w.cheapest?.title, w.cheapest?.facts.class_code, w.fastest?.title, w.missed, !!w.flights])).toEqual([
      // The Rajdhani's 2A is cheaper, but ixigo says it is full.
      ['Delhi', 3, 'Goa Express 12779', 'SL', 'Rajdhani 22413', ['buses'], true],
      ['Bangalore', 1, undefined, undefined, undefined, [], true],
      // The Paulo Travels bus is cheaper and faster, but has no seat left.
      ['Mumbai', 1, 'Konkan Kanya 10111', 'SL', 'Konkan Kanya 10111', [], true],
    ]);
    expect(waysLine(ways, '2026-11-06')).toBe(
      'From Delhi, the cheapest is the Goa Express 12779 in Sleeper at ₹645 (26 h 10 m), the fastest the Rajdhani 22413 in AC 3 Tier at ₹2,140 (15 h 30 m). ' +
        "The buses didn't come back. From Bangalore, ixigo has no trains or buses on Fri 6 Nov. " +
        'From Mumbai, the Konkan Kanya 10111 in Sleeper is the cheapest and the fastest, at ₹420 (11 h 40 m). Flights from your own city are a tap away on the card.',
    );
  });

  it("keeps five rows at most: past five, the fastest rows that save the least time go first, and the line still says them", () => {
    const way = (home: string, savesMin: number): WayThere => {
      const slow = toResultOption(train('Slow', '1', 'SL', 500, at(6, '06:00'), at(7, '06:00')));
      const quick = toResultOption(train('Quick', '2', '3A', 1_500, at(6, '06:00'), new Date(Date.parse(at(7, '06:00')) - savesMin * 60_000).toISOString()));
      return { home, people: 1, cheapest: slow, fastest: quick, flights: null, missed: [] };
    };
    const rows = waysRows([way('Delhi', 600), way('Mumbai', 60), way('Pune', 300), way('Jaipur', 30)]);
    expect(rows.map((r) => `${r.way.home} ${r.is}`)).toEqual(['Delhi cheapest', 'Delhi fastest', 'Mumbai cheapest', 'Pune cheapest', 'Jaipur cheapest']);
  });

  it('puts them on one card, each row with its own ixigo page, posts the line with it, and ends the turn there', async () => {
    const ctx = lb.ctx({ turnId: 'turn_ways1' });
    const got = (await toolWith(async () => COMPARE).run({}, ctx)) as { answered: boolean; results_id: string };
    expect(got.answered).toBe(true);
    expect(ctx.answered).toBe(true);
    expect(ctx.lines).toEqual([expect.stringMatching(/^From Delhi, the cheapest is the Goa Express 12779 in Sleeper/)]);
    const card = C.Card.parse(ctx.cards[0]);
    if (card.kind !== 'options') throw new Error('expected an options card');
    expect(card.title).toBe('Ways to North Goa from Delhi and Mumbai, Fri 6 Nov');
    expect(card.options.map((o) => [o.title, o.highlights[0], o.price_minor])).toEqual([
      ['From Delhi: Goa Express 12779', 'Cheapest, 26 h 10 m', 64_500],
      ['From Delhi: Rajdhani 22413', 'Fastest, 15 h 30 m', 214_000],
      ['From Mumbai: Konkan Kanya 10111', 'Cheapest and fastest, 11 h 40 m', 42_000],
    ]);
    expect(card.actions?.map((a) => a.action_id)).toEqual(['open', 'flights_home']);
    // "See on ixigo" on a row opens that train's own page.
    const open = await lb.taps.tap('options', 'open', { tap_id: 'tap_w1', trip_id: 't_goa', card_id: card.card_id, action_id: 'open', person_id: 'p_rahul', option_id: card.options[1]!.option_id }, card);
    expect(open).toMatchObject({ result: 'open', url: expect.stringContaining('/trains/22413?') });
    // "Flights from my city": Meher lives in Mumbai, Arjun in Bangalore, which has flights though no train or bus row.
    const flightsFor = async (person: string) =>
      lb.taps.tap('options', 'flights_home', { tap_id: `tap_f_${person}`, trip_id: 't_goa', card_id: card.card_id, action_id: 'flights_home', person_id: person }, card);
    expect(await flightsFor('p_meher')).toMatchObject({ result: 'open', url: expect.stringContaining('from=BOM&') });
    expect(await flightsFor('p_arjun')).toMatchObject({ result: 'open', url: expect.stringContaining('from=BLR&') });
    // Someone with no home city on the trip gets the first city's.
    expect(await flightsFor('p_new')).toMatchObject({ result: 'open', url: expect.stringContaining('from=DEL&') });
  });

  it("says why it can't, without a card: not searching ixigo.com, no day or home city yet, or nothing came back", async () => {
    const ctx = lb.ctx({ turnId: 'turn_ways2' });
    expect(await toolWith(async () => COMPARE, false).run({}, ctx)).toMatchObject({ error: 'not_here' });
    const needs = await toolWith(async () => {
      throw new TravelError('needs_more', 'How everyone gets to the trip needs the day everyone travels.');
    }).run({}, ctx);
    expect(needs).toMatchObject({ error: 'needs_more', note: expect.stringContaining('Ask the group for it in one line.') });
    const empty: EngineAnswer = {
      as: 'compare', inputs: { to: 'North Goa', date: '2026-11-06' }, checkedAt: '2026-10-08T12:00:00.000Z', ms: 12_000,
      entries: [{ entry: 'Delhi', steps: [{ recipe: 'trains.between', why: 'out of time' }, { recipe: 'buses.between', why: 'out of time' }, flights('DEL')] }],
    };
    expect(await toolWith(async () => empty).run({}, ctx)).toMatchObject({ note: expect.stringContaining('No train or bus came back') });
    expect([ctx.cards, ctx.lines, ctx.answered]).toEqual([[], [], undefined]);
  });
});
