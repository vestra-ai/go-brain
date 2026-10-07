import { describe, expect, it } from 'vitest';
import { TravelError } from '../../mcp-travel.js';
import { flights, flyingFor, readFlightsPage, withFlightFilters } from '../flights.js';
import { capture, fixture } from './fixtures.js';

const slots = flights.slotsFrom({ from: 'Delhi', to: 'Goa', date: '2026-11-06' }, { people: 4 });
const STREAM_URL = 'https://www.ixigo.com/flights/v2/search/stream?origin=DEL&destination=GOI&leave=06112026&return=&adults=4&children=0&infants=0&class=e';
const stream = () => [capture('/flights/v2/search/stream', STREAM_URL, fixture('flights-del-goi.sse'))];

describe('the flights recipe', () => {
  it('fills its slots from the query, with the trip head count as adults', () => {
    expect(slots).toEqual({ from: 'DEL', to: 'GOI', date: '2026-11-06', adults: 4 });
    expect(flights.slotsFrom({ from: 'BOM', to: 'North Goa', date: '2026-11-06', guests: 12 }, { people: 4 })).toEqual({ from: 'BOM', to: 'GOX', date: '2026-11-06', adults: 9 });
  });

  it('leaves out of the head count the members whose home has another airport', () => {
    // The Goa trip: Rahul, Priya and Kabir live in Delhi, Arjun in Bangalore, Meher in Mumbai.
    const goa = { people: 5, fromCities: ['Delhi', 'Delhi', 'Bangalore', 'Mumbai', 'New Delhi'] };
    expect(flights.slotsFrom({ from: 'Delhi', to: 'Goa', date: '2026-11-06' }, goa).adults).toBe(3);
    expect(flights.slotsFrom({ from: 'Bengaluru', to: 'Goa', date: '2026-11-06' }, goa).adults).toBe(1);
    // A member with no home city, or a home Go has no airport for, may fly from here: 4 people, only one said Delhi.
    expect(flights.slotsFrom({ from: 'Delhi', to: 'Goa', date: '2026-11-06' }, { people: 4, fromCities: ['Delhi'] }).adults).toBe(4);
    expect(flights.slotsFrom({ from: 'Delhi', to: 'Goa', date: '2026-11-06' }, { people: 5, fromCities: ['Shimla', 'Bangalore'] }).adults).toBe(4);
    expect(flights.slotsFrom({ from: 'Delhi', to: 'Goa', date: '2026-11-06' }, { people: 5 }).adults).toBe(5);
    // Everyone lives by another airport: the search is for the whole group.
    expect(flights.slotsFrom({ from: 'Chennai', to: 'Goa', date: '2026-11-06' }, goa).adults).toBe(5);
    // A number people gave wins.
    expect(flights.slotsFrom({ from: 'Delhi', to: 'Goa', date: '2026-11-06', guests: 6 }, goa).adults).toBe(6);
  });

  it('says who a results page is set for, from its own link', () => {
    expect(flyingFor(withFlightFilters(flights.url(slots), { departAfter: '18:00' }))).toBe('for 4 from Delhi');
    expect(flyingFor('https://www.ixigo.com/search/result/flight?from=XXX&adults=2')).toBeNull();
    expect(flyingFor('https://www.ixigo.com/search/result/flight?from=DEL')).toBeNull();
  });

  it('opens the results page the map gives', () => {
    expect(flights.url(slots)).toBe(
      'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026&returnDate=&adults=4&children=0&infants=0&class=e&source=Search%20Form',
    );
    expect(flights.capture).toEqual([{ match: '/flights/v2/search/stream', required: true, max_bytes: 2_000_000 }]);
  });

  it('refuses a search without a date, and a place it has no airport for', () => {
    expect(() => flights.slotsFrom({ from: 'Delhi', to: 'Goa' }, { people: 4 })).toThrow(TravelError);
    expect(() => flights.slotsFrom({ from: 'Shimla', to: 'Goa', date: '2026-11-06' }, { people: 4 })).toThrow(/Go can search ixigo flights for these places/);
  });

  it('reads every fare in the stream, per person, with its times in India', () => {
    const options = flights.extract(stream(), slots);
    expect(options).toHaveLength(134);
    expect(options.filter((o) => o.journey?.destination.code === 'GOX')).toHaveLength(30);
    expect(options.filter((o) => o.journey?.stops === 0)).toHaveLength(15);
    const nonStop = options.find((o) => o.title === 'IndiGo 6E 5341')!;
    expect(nonStop).toMatchObject({
      kind: 'flight',
      priceMinor: 789_600,
      currency: 'INR',
      priceNote: 'per person',
      journey: {
        mode: 'flight',
        origin: { name: 'New Delhi (DEL)', code: 'DEL' },
        destination: { name: 'Goa (GOI)', code: 'GOI' },
        depart_at: '2026-11-06T05:00:00+05:30',
        arrive_at: '2026-11-06T07:35:00+05:30',
        carrier_name: 'IndiGo',
        carrier_code: '6E',
        number: '6E 5341',
        stops: 0,
      },
      highlights: ['Non-stop', '2h 35m'],
      facts: { stops: 0, duration_min: 155, seats_left: 9, refundable: 'partly' },
      sourceUrl: flights.url(slots),
    });
    expect(nonStop).not.toHaveProperty('offerId');
  });

  it('reads a one-stop flight that lands after midnight as the next day', () => {
    const first = flights.extract(stream(), slots)[0]!;
    expect(first.title).toBe('IndiGo 6E 329, 6E 5106');
    expect(first.journey).toMatchObject({ depart_at: '2026-11-06T18:30:00+05:30', arrive_at: '2026-11-07T00:40:00+05:30', stops: 1, number: '6E 329' });
    expect(first.highlights).toEqual(['1 stop', '6h 10m']);
  });

  it('refuses when the stream is missing, failed or in a shape it does not read', () => {
    expect(() => flights.extract([], slots)).toThrow(/did not load its fares/);
    expect(() => flights.extract([capture('/flights/v2/search/stream', STREAM_URL, fixture('flights-del-goi.sse'), 503)], slots)).toThrow(/did not load/);
    expect(() => flights.extract([capture('/flights/v2/search/stream', STREAM_URL, 'data:{"data":{"flights":[]}}\n\n')], slots)).toThrow(/shape Go does not read/);
  });

  it('reads the same flights at the same prices from the page text, for the fallback runner', () => {
    const rows = readFlightsPage(fixture('flights-del-goi.txt'));
    expect(rows).toEqual([
      { airline: 'IndiGo', numbers: '6E5341', depart: '05:00', from: 'DEL', arrive: '07:35', to: 'GOI', duration: '2h 35m', stops: 'Non-stop', price: 7896 },
      { airline: 'IndiGo', numbers: '6E2265', depart: '06:20', from: 'DEL', arrive: '08:40', to: 'GOX', duration: '2h 20m', stops: 'Non-stop', price: 8093 },
      { airline: 'IndiGo', numbers: '6E2271', depart: '18:50', from: 'DEL', arrive: '21:20', to: 'GOX', duration: '2h 30m', stops: 'Non-stop', price: 8093 },
    ]);
    const fromPage = flights.fromAgent(rows, slots);
    const fromStream = flights.extract(stream(), slots);
    for (const o of fromPage) {
      const same = fromStream.find((x) => x.title === o.title)!;
      expect(o.priceMinor).toBe(same.priceMinor);
      expect(o.journey?.depart_at).toBe(same.journey?.depart_at);
      expect(o.journey?.arrive_at).toBe(same.journey?.arrive_at);
      expect(o.journey?.destination.code).toBe(same.journey?.destination.code);
    }
  });

  it('refuses page rows that do not check out, so the fallback never shows a wrong flight', () => {
    expect(() => flights.fromAgent([{ airline: 'IndiGo', numbers: '6E5341', depart: '5 am', from: 'DEL', arrive: '07:35', to: 'GOI', duration: null, stops: null, price: 7896 }], slots)).toThrow(TravelError);
    expect(() => flights.fromAgent('nothing', slots)).toThrow(/did not check out/);
  });

  it('reads an arrival clock earlier than the departure as the next day', () => {
    const [o] = flights.fromAgent([{ airline: 'Air India', numbers: 'AI2985', depart: '23:10', from: 'DEL', arrive: '01:45', to: 'GOI', duration: '2h 35m', stops: 'Non-stop', price: 9000 }], slots);
    expect(o!.journey?.arrive_at).toBe('2026-11-07T01:45:00+05:30');
    expect(o!.facts).toMatchObject({ stops: 0, duration_min: 155 });
  });

  it("sets people's conditions in ixigo's own filter params, for the link", () => {
    const url = flights.url(slots);
    expect(withFlightFilters(url, { from: 'Delhi', to: 'Goa', date: '2026-11-06' })).toBe(url);
    expect(withFlightFilters(url, { departAfter: '18:00', mustHave: ['non_stop'], maxPriceMinor: 900_050 })).toBe(`${url}&stops=0&takeOff=NIGHT&price=0,9000`);
    expect(withFlightFilters(url, { departAfter: '10:00', departBefore: '15:00', arriveBefore: '12:00' })).toBe(`${url}&takeOff=MORNING,AFTERNOON&landing=EARLY_MORNING,MORNING`);
  });

  it('sends a page script that is one expression with the reader inside it', () => {
    expect(() => new Function(`return ${flights.agentExtractor};`)).not.toThrow();
    expect(flights.agentExtractor).toContain('document.body.innerText');
    expect(flights.agentExtractor).toContain('.slice(0, 15)');
  });
});
