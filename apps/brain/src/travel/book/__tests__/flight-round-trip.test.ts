import { describe, expect, it } from 'vitest';
import { TravelError } from '../../mcp-travel.js';
import { createIxigoWebBackend } from '../../recipes/backend.js';
import type { FetchPlan, RecipeOption } from '../../recipes/recipe.js';
import { capture, fixture } from '../../recipes/__tests__/fixtures.js';
import { flightsQuery, FlightsArgs } from '../../tools.js';
import { loadBook } from '../book.js';
import { createEngine, type Engine } from '../engine.js';

// A round trip on ixigo (the 10 Oct atlas): one page with a return date, its stream holding both ways (flightJourneys[0]
// there, [1] back), and the page's own price for the pair it picks (POST /flights/v2/search/discount). The sample is
// ixigo's own Delhi to Goa stream (9 Oct, four flights) there, and the same four made the way back.
const { book } = loadBook();
const STREAM = '/flights/v2/search/stream';
const DISCOUNT = '/flights/v2/search/discount';
const GIVEN = { from: 'Delhi', to: 'Goa', date: '2026-11-13', return_date: '2026-11-16' };

function roundTrip(): { stream: string; pairKey: string } {
  const value = JSON.parse(fixture('flights-del-goi-2026-11-13.sse').trim().slice('data:'.length)) as { data: { flightJourneys: Array<Record<string, any>> } };
  const there = value.data.flightJourneys[0]!;
  // The way back: each flight reversed, three days on, ₹500 dearer, leaving in the evening.
  const back = (there['flightFare'] as Array<Record<string, any>>).map((f, i) => ({
    ...f,
    flightKeys: (f['flightKeys'] as string).split('*').reverse().map((k) => { const [a, b, n] = k.split('-'); return `${b}-${a}-${n}-16112026`; }).join('*'),
    fares: f['fares'].map((x: Record<string, any>) => ({ ...x, fareDetails: { ...x['fareDetails'], displayFare: x['fareDetails'].displayFare + 500 } })),
    flightDetails: f['flightDetails'].map((d: Record<string, any>) => ({ ...d, origin: d['destination'], destination: d['origin'], departureTime: `${19 + (i % 3)}:05` })),
  }));
  const stream = `data:${JSON.stringify({ ...value, data: { ...value.data, type: 'SPLIT', flightJourneys: [there, { ...there, flightFare: back }] } })}\n\n`;
  return { stream, pairKey: `DEL-GOI-IX1196-13112026+GOI-DEL-IX1196-16112026` };
}

describe('flights there and back, as pairs priced there and back', () => {
  it("reads both ways from one page, pairs the cheapest, and takes ixigo's own price for the pair its page priced", async () => {
    const { stream, pairKey } = roundTrip();
    const pair = { data: { flightFares: { [pairKey]: { displayFare: 17_500, fareToken: 'x', offerText: '', priceLockAttributes: { priceLockText: 'Lock price @899', priceLockPremium: 899, expiryEpoch: 1, lockWindow: 48 } } }, validCombination: true } };
    const urls: string[] = [];
    const plans: FetchPlan[] = [];
    const runner = {
      read: async (_trip: string, url: string, plan: FetchPlan) => {
        urls.push(url);
        plans.push(plan);
        return {
          captures: [
            capture(STREAM, 'https://www.ixigo.com/flights/v2/search/stream', stream),
            capture(DISCOUNT, 'https://www.ixigo.com/flights/v2/search/discount', JSON.stringify(pair)),
            capture(DISCOUNT, 'https://www.ixigo.com/flights/v2/search/discount', JSON.stringify(pair)),
          ],
          finalUrl: url,
        };
      },
    };
    const engine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-10T07:30:00Z') });
    const got = await engine.answer('flights.round_trip', GIVEN, { tripId: 't_rt' });
    if (got.as !== 'options') throw new Error(got.as);
    expect(urls[0]).toContain('&date=13112026&returnDate=16112026&adults=4&children=0&infants=0&class=e&');
    expect(plans[0]!.capture).toEqual([
      { match: STREAM, required: true, max_bytes: 4_194_304, sse: 'last' },
      { match: DISCOUNT, required: false, max_count: 2, max_bytes: 200_000 },
    ]);
    // Four each way: sixteen pairs, the ten cheapest there and back, the cheapest first.
    expect(got.options).toHaveLength(10);
    const first = got.options[0]!;
    expect(first.title).toBe('Air-India Express IX1196, back Air-India Express IX1196');
    // ixigo's own price for that pair, not the two fares added up (₹8,630 + ₹9,130).
    expect(first).toMatchObject({
      priceMinor: 1_750_000, priceNote: 'per person there and back',
      journey: { origin: { code: 'DEL' }, destination: { code: 'GOI' }, depart_at: '2026-11-13T18:35:00+05:30', number: 'IX1196' },
    });
    expect(first.highlights).toEqual(['Non-stop', 'Back 19:05, non-stop', "ixigo's pair price"]);
    expect(first.facts).toMatchObject({
      back_flights: 'IX1196', back_depart_at: '2026-11-16T19:05:00+05:30', there_fare_minor: 863_000, back_fare_minor: 913_000,
      pair_price: "ixigo's own price for this pair", total_for_group: '₹70,000 for 4',
      lock: 'Lock Price ₹899 a person for the pair, holds 48 h', lock_fee_minor: 89_900, lock_hours: 48, arrival_airport: 'Dabolim (GOI)',
    });
    // A pair ixigo's page didn't price: the two fares added up, said as such.
    const other = got.options[1]!;
    expect(other.highlights).not.toContain("ixigo's pair price");
    expect(other.priceMinor).toBe((other.facts['there_fare_minor'] as number) + (other.facts['back_fare_minor'] as number));
  });

  it('a search with a day back runs the round trip; its link, when ixigo holds the page back, carries the day back too', async () => {
    const runs: string[] = [];
    const real = createEngine({ book, runner: () => null, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-10T07:30:00Z') });
    let refuse = false;
    const flight: RecipeOption = { kind: 'flight', title: 'IndiGo 6E357, back IndiGo 6E358', priceMinor: 1_600_000, currency: 'INR', priceNote: 'per person there and back', highlights: [], facts: {}, sourceUrl: 'https://www.ixigo.com/x' };
    const engine = {
      answer: (async (id, given, r) => {
        runs.push(id);
        if (id === 'flights.search') return real.answer(id, given, r);
        if (refuse) throw new TravelError('refused', "ixigo's page did not send flights there and back.");
        return { as: 'options', options: [flight], page: 'https://www.ixigo.com/x', checkedAt: '2026-10-10T07:30:00.000Z', ms: 4_000 };
      }) as Engine['answer'],
    };
    const backend = createIxigoWebBackend({ book, engine, now: () => new Date('2026-10-10T07:30:00Z') });
    const q = flightsQuery(FlightsArgs.parse({ from: 'Delhi', to: 'Goa', date: '2026-11-13', return_date: '2026-11-16' }));
    expect((await backend.search('flights', q, { tripId: 't_rt' })).results.map((o) => o.title)).toEqual(['IndiGo 6E357, back IndiGo 6E358']);
    expect(runs).toEqual(['flights.round_trip']);
    refuse = true;
    const err = (await backend.search('flights', { ...q, returnDate: '2026-11-17' }, { tripId: 't_rt' }).catch((e: unknown) => e)) as TravelError;
    expect(err.code).toBe('link_only');
    expect(err.link).toContain('&date=13112026&returnDate=17112026&');
    // One way, as ever.
    runs.length = 0;
    refuse = false;
    await backend.search('flights', { from: 'Delhi', to: 'Goa', date: '2026-11-14' }, { tripId: 't_rt' });
    expect(runs).toEqual(['flights.results']);
  });
});
