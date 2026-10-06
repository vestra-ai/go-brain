import { describe, expect, it } from 'vitest';
import { FakeIxigoStore } from '../fake-ixigo/data.js';
import { applyConstraints } from '../filters.js';
import { createFakeTravel } from '../mcp-travel.js';
import type { TravelOption } from '../travel.js';

const now = () => new Date('2026-10-07T12:00:00Z');
const fake = createFakeTravel({ store: new FakeIxigoStore({ now }), now, payRail: () => 'fake' });
const FRIDAY = '2026-11-06';

describe('constraints applied in code', () => {
  it("keeps only flights at or after 18:00 when Arjun can't leave before 6, whatever the model would have listed", async () => {
    const { results } = await fake.search('flights', { from: 'Delhi', to: 'Goa', date: FRIDAY });
    const kept = applyConstraints('flights', { departAfter: '18:00' }, results);
    expect(kept.map((o) => o.title)).toEqual(['IndiGo 6E 2134', 'Air India AI 2981', 'Air India AI 2847', 'IndiGo 6E 6721']);
    expect(kept.some((o) => o.title === 'Akasa Air QP 1846')).toBe(false);
  });

  it('applies before, price and non-stop together', async () => {
    const { results } = await fake.search('flights', { from: 'Delhi', to: 'Goa', date: FRIDAY });
    expect(applyConstraints('flights', { departBefore: '10:00', mustHave: ['non_stop'] }, results).map((o) => o.title)).toEqual(['IndiGo 6E 515', 'IndiGo 6E 6153', 'SpiceJet SG 8169']);
    expect(applyConstraints('flights', { maxPriceMinor: 550000 }, results).every((o) => o.priceMinor <= 550000)).toBe(true);
  });

  it('keeps villas with a pool near the beach that sleep everyone, best rated first, within a nightly price', async () => {
    const { results } = await fake.search('stays', { area: 'North Goa', checkIn: FRIDAY, checkOut: '2026-11-09' });
    const kept = applyConstraints('stays', { guests: 5, mustHave: ['pool', 'beach'] }, results);
    expect(kept.map((o) => o.title)).toEqual(['Casa Mareia', 'Villa Sol', 'The Palms Villa', 'Ocean Breeze Villa']);
    expect(applyConstraints('stays', { guests: 5, mustHave: ['pool', 'beach'], maxPriceMinor: 1300000 }, results).map((o) => o.title)).toEqual(['Villa Sol', 'The Palms Villa']);
  });

  it('drops a journey that arrives the next day when it must arrive before a time', () => {
    const overnight: TravelOption = {
      offerId: 'fake:x', kind: 'flight', title: 'Late flight', priceMinor: 500000, currency: 'INR', priceNote: 'per person', highlights: [], facts: {},
      journey: { mode: 'flight', origin: { name: 'Delhi' }, destination: { name: 'Goa' }, depart_at: '2026-11-06T22:50:00+05:30', arrive_at: '2026-11-07T01:25:00+05:30' },
    };
    expect(applyConstraints('flights', { arriveBefore: '23:00' }, [overnight])).toEqual([]);
  });
});
