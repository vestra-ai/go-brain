import { describe, expect, it } from 'vitest';
import type { CaptureSpec, FetchPlan } from '../../recipes/recipe.js';
import { buses } from '../../recipes/buses.js';
import { flights, flyingFor, withFlightFilters } from '../../recipes/flights.js';
import { stays } from '../../recipes/stays.js';
import { capture, fixture } from '../../recipes/__tests__/fixtures.js';
import type { TravelQuery } from '../../travel.js';
import { readFileSync } from 'node:fs';
import { BOOK_DIR, loadBook } from '../book.js';
import { createEngine } from '../engine.js';

// The four searches as recipe files give what today's recipes give, on today's saved pages: the same address, the same
// fetch, the same options. Trains read ixigo's own train call, which the results page uses since October (p4's sample).
// When the files take over, these become the samples' own checks.
const { book, problems } = loadBook();
const sample = (name: string): string => readFileSync(`${BOOK_DIR}samples/${name}`, 'utf8');
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
      expect([runs[0]!.plan.timeoutMs, runs[0]!.plan.settleMs], area).toEqual([plan.timeoutMs, plan.settleMs]);
      expect(got.options, area).toEqual(stays.extract(caps, slots));
    }
  });

  it("trains: ixigo's own train call (confirmtkt.com since October), one option per train and class, with its seats and chance", async () => {
    const MATCH = 'ixigotrainsapi.confirmtkt.com/api/v1/trains/search';
    const caps = [capture(MATCH, `https://${MATCH}?sourceStationCode=SBC&destinationStationCode=MAS&dateOfJourney=22-10-2026`, sample('trains.between.page.json'))];
    const { engine, runs } = engineWith(() => caps);
    const got = await engine.answer('trains.between', { from: 'Bangalore', to: 'Chennai', date: '2026-10-22' }, { tripId: 't_goa' });
    if (got.as !== 'options') throw new Error('not options');
    expect(got.page).toBe('https://www.ixigo.com/trains/search-pwa/from/SBC/to/MAS/22-10-2026');
    expect(runs[0]!.plan.capture).toEqual([{ match: MATCH, required: true }]);
    expect(got.options.map((o) => `${o.title} ${o.facts.class_code} ${o.facts.availability}`)).toEqual([
      'Muzaffarpur EXP 15227 1A WL 9', 'Muzaffarpur EXP 15227 2A Available 2', 'Muzaffarpur EXP 15227 3A Available 8',
      'Muzaffarpur EXP 15227 3E Regret', 'Muzaffarpur EXP 15227 SL WL 127', 'Shatabdi EXP 12028 EC Available 25',
      'Shatabdi EXP 12028 CC Available 659', 'Lalbagh SF EXP 12608 CC WL 7', 'Lalbagh SF EXP 12608 2S Available 291',
    ]);
    expect(got.options[0]).toEqual({
      kind: 'train',
      title: 'Muzaffarpur EXP 15227',
      priceMinor: 145_500,
      currency: 'INR',
      priceNote: 'per person, 1A',
      journey: {
        mode: 'train',
        origin: { name: 'Smvt Bengaluru', code: 'SMVB' },
        destination: { name: 'Perambur', code: 'PER' },
        depart_at: '2026-10-22T00:30:00+05:30',
        arrive_at: '2026-10-22T06:35:00+05:30',
        carrier_name: 'Indian Railways',
        number: '15227',
      },
      highlights: ['AC First Class', 'WL 9', '76% chance to confirm', '6 h 5 m'],
      facts: { class_code: '1A', availability: 'WL 9', chance: 76, duration_min: 365, rating: expect.any(Number) },
      sourceUrl: 'https://www.ixigo.com/trains/15227?orgn=SMVB&dstn=PER&departDate=2026-10-22&quota=GN',
    });
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
