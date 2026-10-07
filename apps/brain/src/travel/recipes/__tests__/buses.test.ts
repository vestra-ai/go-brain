import { describe, expect, it } from 'vitest';
import { buses, readBusesPage } from '../buses.js';
import { capture, fixture } from './fixtures.js';

const slots = buses.slotsFrom({ from: 'Mumbai', to: 'North Goa', date: '2026-11-06' }, { people: 4 });
const RESULTS = 'https://www.ixigo.com/buses/bus_search/Mumbai/4/Goa/102/06-11-2026/O';
const load = () => [
  // The page loads /buslist/v3/services/meta/105 first: it must never be read as the buses.
  capture('/buslist/v3/services$', 'https://www.ixigo.com/buslist/v3/services/meta/105', '{"status":"success","meta":{}}'),
  capture('/buslist/v3/services$', 'https://www.ixigo.com/buslist/v3/services', fixture('buses-mumbai-goa.json')),
];

/** The saved bus list with its services changed by `edit`. */
const busesWith = (edit: (services: any[]) => void) => {
  const body = JSON.parse(fixture('buses-mumbai-goa.json'));
  edit(body.services);
  return [capture('/buslist/v3/services$', 'https://www.ixigo.com/buslist/v3/services', JSON.stringify(body))];
};

describe('the buses recipe', () => {
  it('fills the AbhiBus city ids, and opens the results page the map gives', () => {
    expect(slots).toEqual({ from: { name: 'Mumbai', id: 4 }, to: { name: 'Goa', id: 102 }, date: '2026-11-06' });
    expect(buses.url(slots)).toBe(RESULTS);
    expect(buses.capture).toEqual([{ match: '/buslist/v3/services$', required: true }]);
    // Bash's browser fetch draws its window now, so the list loads there: the TRAVEL_RUNNER switch picks the runner.
    expect(buses.fetchable).toBe(true);
    expect(() => buses.slotsFrom({ from: 'Pune', to: 'Goa', date: '2026-11-06' }, { people: 4 })).toThrow('Go has no ixigo bus city code for "Pune" yet.');
  });

  it('reads every bus, from its lowest seat fare after the offer ixigo applies', () => {
    const options = buses.extract(load(), slots);
    expect(options).toHaveLength(71);
    expect(options[0]).toEqual({
      kind: 'bus',
      title: 'Paulo Travels Express',
      priceMinor: 270_000,
      currency: 'INR',
      priceNote: 'per seat, from',
      journey: {
        mode: 'bus',
        origin: { name: 'Mumbai' },
        destination: { name: 'Goa' },
        depart_at: '2026-11-06T18:20:00+05:30',
        arrive_at: '2026-11-07T10:45:00+05:30',
        carrier_name: 'Paulo Travels Express',
      },
      rating: 4.6,
      highlights: ['VE AC Sleeper (2 + 1)', '16 h 25 m'],
      facts: { bus_type: 'VE AC Sleeper (2 + 1)', seats_left: 31, duration_min: 985, reviews: 15 },
      sourceUrl: RESULTS,
    });
    expect(options[1]!.priceMinor).toBe(300_000);
    expect(Math.min(...options.map((o) => o.priceMinor))).toBe(150_000);
  });

  it('refuses when only the meta call came back', () => {
    expect(() => buses.extract(load().slice(0, 1), slots)).toThrow(/did not load its buses/);
  });

  it('reads the same buses at the same prices from the page text, for the fallback runner', () => {
    const rows = readBusesPage(fixture('buses-mumbai-goa.txt'));
    expect(rows).toHaveLength(16);
    expect(rows[0]).toEqual({ operator: 'Paulo Travels Express', type: 'VE AC Sleeper (2 + 1)', depart: '18:20', arrive: '10:45', duration_min: 985, price: 2700, rating: 4.6, seats_left: 31 });
    expect(rows[2]).toMatchObject({ operator: 'VRL Travels' });
    const fromPage = buses.fromAgent(rows, slots);
    const fromCalls = buses.extract(load(), slots);
    for (const o of fromPage.slice(0, 8)) {
      const same = fromCalls.find((x) => x.title === o.title && x.journey?.depart_at === o.journey?.depart_at)!;
      expect(o.priceMinor).toBe(same.priceMinor);
      expect(o.journey?.arrive_at).toBe(same.journey?.arrive_at);
    }
  });

  it('leaves out a bus it cannot read, reads null details as missing, and refuses only when no bus reads', () => {
    const name = JSON.parse(fixture('buses-mumbai-goa.json')).services[0].travelerAgentName.trim();
    const options = buses.extract(busesWith((v) => {
      Object.assign(v[0], { rating: null, noOfRatings: null, busTypeName: null, seatStats: { availableSeats: null } });
      v[1].fares.fare = 0;
    }), slots);
    expect(options).toHaveLength(70);
    const first = options.find((o) => o.title === name)!;
    expect(first).not.toHaveProperty('rating');
    expect(first.facts).not.toHaveProperty('seats_left');
    expect(first.facts).not.toHaveProperty('bus_type');
    expect(() => buses.extract(busesWith((v) => {
      for (const s of v) s.fares = null;
    }), slots)).toThrow(/shape Go does not read/);
  });

  it('leaves out a page row whose arrival does not match its journey time, and keeps the rest', () => {
    const good = { operator: 'Paulo Travels Express', type: 'AC Sleeper', depart: '18:20', arrive: '10:45', duration_min: 985, price: 2700, rating: null, seats_left: null };
    expect(buses.fromAgent([{ ...good, arrive: '09:45' }, good], slots).map((o) => o.title)).toEqual(['Paulo Travels Express']);
  });

  it('refuses a page row whose arrival does not match its journey time', () => {
    const row = { operator: 'Paulo Travels Express', type: 'AC Sleeper', depart: '18:20', arrive: '09:45', duration_min: 985, price: 2700, rating: null, seats_left: null };
    expect(() => buses.fromAgent([row], slots)).toThrow(/arrives at 09:45/);
  });
});
