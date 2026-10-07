import { describe, expect, it } from 'vitest';
import type { CaptureSpec, FetchPlan } from '../../recipes/recipe.js';
import { buses } from '../../recipes/buses.js';
import { flights, flyingFor, withFlightFilters } from '../../recipes/flights.js';
import { stays } from '../../recipes/stays.js';
import { trains } from '../../recipes/trains.js';
import { capture, fixture } from '../../recipes/__tests__/fixtures.js';
import type { TravelQuery } from '../../travel.js';
import { loadBook } from '../book.js';
import { createEngine } from '../engine.js';

// The four searches as recipe files give what today's recipes give, on today's saved pages: the same address, the same
// fetch, the same options. When the files take over, these become the samples' own checks.
const { book, problems } = loadBook();
// The Goa trip: three members live in Delhi, one in Bangalore, one in Mumbai.
const HOMES = ['Delhi', 'Delhi', 'Bangalore', 'Mumbai', 'Delhi'];

function engineWith(answer: (url: string, plan: FetchPlan) => ReturnType<typeof capture>[]) {
  const runs: Array<{ url: string; plan: FetchPlan }> = [];
  const runner = {
    read: async (_trip: string, url: string, plan: FetchPlan) => {
      runs.push({ url, plan });
      return { captures: answer(url, plan), finalUrl: url };
    },
  };
  const engine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 5, homes: HOMES }), now: () => new Date('2026-10-07T12:00:00Z') });
  return { engine, runs };
}

describe('the recipe book', () => {
  it('loads every file, with nothing left out', () => {
    expect(problems).toEqual([]);
    expect(book.all().map((r) => r.id).sort()).toEqual([
      'buses.between', 'buses.city_lookup', 'flights.airport_lookup', 'flights.search',
      'hotels.place_lookup', 'hotels.search', 'trains.between', 'trains.station_lookup',
    ]);
  });
});

describe('the four searches, as files, read as today', () => {
  it('stays: the same address, fetch and options for a whole state, a half of it, an area and a place of its own', async () => {
    const pages = [fixture('stays-goa-page1.json'), fixture('stays-goa-page2.json')];
    const SEARCH = '/accommodation-search/api/v3/accommodations/search$';
    for (const [area, mustHave] of [['Goa', []], ['North Goa', []], ['South Goa', ['pool']], ['Calangute', ['breakfast', 'free_cancellation']], ['Anjuna', []]] as const) {
      const q: TravelQuery = { area, checkIn: '2026-11-06', checkOut: '2026-11-09', mustHave: [...mustHave] };
      const slots = stays.slotsFrom(q, { people: 5 });
      const caps = pages.map((b) => capture(SEARCH, 'https://www.ixigo.com/accommodation-search/api/v3/accommodations/search', b));
      const { engine, runs } = engineWith(() => caps);
      const got = await engine.answer('hotels.search', { place: area, check_in: q.checkIn, check_out: q.checkOut }, { tripId: 't_goa', conditions: [...mustHave] });
      expect(got.as, area).toBe('options');
      if (got.as !== 'options') return;
      expect(got.page, area).toBe(stays.url(slots));
      const plan = stays.fetchFor!(slots);
      expect(runs[0]!.plan.capture.map((c: CaptureSpec) => ({ ...c })), area).toEqual(plan.capture.map((c) => ({ required: true, ...c })));
      expect(runs[0]!.plan.steps ?? [], area).toEqual(plan.steps ?? []);
      expect(got.options, area).toEqual(stays.extract(caps, slots));
    }
  });

  it('trains: the same address and the same option for every train and class', async () => {
    const caps = [
      capture('/trains/v1/search/between/', 'https://www.ixigo.com/trains/v1/search/between/CSMT/MAO', fixture('trains-csmt-mao-between.json')),
      capture('/api/v3/trains/availability', 'https://www.ixigo.com/api/v3/trains/availability', fixture('trains-csmt-mao-availability.json')),
    ];
    const slots = trains.slotsFrom({ from: 'Mumbai', to: 'Goa', date: '2026-11-06' }, { people: 5 });
    const { engine } = engineWith(() => caps);
    const got = await engine.answer('trains.between', { from: 'Mumbai', to: 'Goa', date: '2026-11-06' }, { tripId: 't_goa' });
    if (got.as !== 'options') throw new Error('not options');
    expect(got.page).toBe(trains.url(slots));
    expect(got.options).toHaveLength(60);
    expect(got.options).toEqual(trains.extract(caps, slots));
  });

  it('buses: the same address and every bus at the same price', async () => {
    const caps = [
      capture('/buslist/v3/services$', 'https://www.ixigo.com/buslist/v3/services/meta/105', '{"status":"success","meta":{}}'),
      capture('/buslist/v3/services$', 'https://www.ixigo.com/buslist/v3/services', fixture('buses-mumbai-goa.json')),
    ];
    const slots = buses.slotsFrom({ from: 'Mumbai', to: 'North Goa', date: '2026-11-06' }, { people: 5 });
    const { engine } = engineWith(() => caps);
    const got = await engine.answer('buses.between', { from: 'Mumbai', to: 'North Goa', date: '2026-11-06' }, { tripId: 't_goa' });
    if (got.as !== 'options') throw new Error('not options');
    expect(got.page).toBe(buses.url(slots));
    expect(got.options).toHaveLength(71);
    expect(got.options).toEqual(buses.extract(caps, slots));
  });

  it("flights: the same link, set for the members who live by the airport, with people's conditions and the cheapest first", async () => {
    const { engine, runs } = engineWith(() => []);
    for (const [args, conditions, q] of [
      [{ from: 'Delhi', to: 'Goa', date: '2026-11-06', depart_after: '18:00' }, ['non_stop'], { from: 'Delhi', to: 'Goa', date: '2026-11-06', departAfter: '18:00', mustHave: ['non_stop'] }],
      [{ from: 'Mumbai', to: 'Goa', date: '2026-11-06', arrive_before: '12:00', max_price: 900_050 }, [], { from: 'Mumbai', to: 'Goa', date: '2026-11-06', arriveBefore: '12:00', maxPriceMinor: 900_050 }],
      [{ from: 'Delhi', to: 'Goa', date: '2026-11-06', adults: 2 }, [], { from: 'Delhi', to: 'Goa', date: '2026-11-06', guests: 2 }],
    ] as const) {
      const slots = flights.slotsFrom(q as TravelQuery, { people: 5, fromCities: HOMES });
      const link = withFlightFilters(flights.url(slots), q as TravelQuery);
      const got = await engine.answer('flights.search', { ...args }, { tripId: 't_goa', conditions: [...conditions] });
      expect(got).toEqual({ as: 'link', link, title: `Flights, ${q.from} to ${q.to}`, who: flyingFor(link) });
    }
    // A link loads nothing.
    expect(runs).toEqual([]);
  });
});
