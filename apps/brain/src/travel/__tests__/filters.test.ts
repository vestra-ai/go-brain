import { describe, expect, it } from 'vitest';
import { FakeIxigoStore } from '../fake-ixigo/data.js';
import { applyConstraints, asked, misses, missedByAll, pointAt } from '../filters.js';
import { createFakeTravel } from '../mcp-travel.js';
import { loadBook } from '../book/book.js';
import { createEngine } from '../book/engine.js';
import { capture, fixture } from '../recipes/__tests__/fixtures.js';
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

  it('spreads a region ask across its areas: the best good stay of each area first, then each one\'s second (re-drill 4)', () => {
    const stay = (title: string, area: string, rating: number): TravelOption => ({
      offerId: `fake:${title}`, kind: 'stay', title, priceMinor: 900_000, currency: 'INR', priceNote: 'per night', rating, highlights: [], facts: { area },
    });
    const all = [stay('A', 'Calangute', 4.8), stay('B', 'Calangute', 4.7), stay('C', 'Calangute', 4.6), stay('D', 'Baga', 3.5), stay('E', 'Candolim', 4.5)];
    const titles = (q: { area?: string }) => applyConstraints('stays', q, all).map((o) => o.title);
    expect(titles({ area: 'North Goa' })).toEqual(['A', 'E', 'B', 'C', 'D']);
    expect(titles({ area: 'Goa' })).toEqual(['A', 'E', 'B', 'C', 'D']);
    // One area asked for, or none: best rated first, as before. Baga's 3.5 is not good, so it never jumps the queue.
    expect(titles({ area: 'Calangute' })).toEqual(['A', 'B', 'C', 'E', 'D']);
    expect(titles({})).toEqual(['A', 'B', 'C', 'E', 'D']);
  });

  it("puts three areas up front for North Goa from ixigo's own two pages, not the Candolim strip", async () => {
    const SEARCH = '/accommodation-search/api/v3/accommodations/search$';
    const url = 'https://www.ixigo.com/accommodation-search/api/v3/accommodations/search';
    const pages = [capture(SEARCH, url, fixture('stays-goa-page1.json')), capture(SEARCH, url, fixture('stays-goa-page2.json'))];
    const engine = createEngine({
      book: loadBook().book, runner: () => ({ read: async (_t: string, page: string) => ({ captures: pages, finalUrl: page }) }), trip: async () => ({ people: 4, homes: [] }), now,
    });
    const north = await engine.answer('hotels.search', { place: 'North Goa', check_in: FRIDAY, check_out: '2026-11-09' }, { tripId: 't_goa' });
    if (north.as !== 'options') throw new Error('not options');
    const options = north.options.map((o, i) => ({ ...o, offerId: `ixigo-web:${i}` }));
    const top = (q: { area?: string }) => applyConstraints('stays', q, options).slice(0, 3).map((o) => o.facts.area);
    expect(top({})).toEqual(['Vagator', 'Candolim', 'Candolim']);
    expect(top({ area: 'North Goa' })).toEqual(['Vagator', 'Candolim', 'Prabhu wada']);
  });

  it('drops a journey that arrives the next day when it must arrive before a time', () => {
    const overnight: TravelOption = {
      offerId: 'fake:x', kind: 'flight', title: 'Late flight', priceMinor: 500000, currency: 'INR', priceNote: 'per person', highlights: [], facts: {},
      journey: { mode: 'flight', origin: { name: 'Delhi' }, destination: { name: 'Goa' }, depart_at: '2026-11-06T22:50:00+05:30', arrive_at: '2026-11-07T01:25:00+05:30' },
    };
    expect(applyConstraints('flights', { arriveBefore: '23:00' }, [overnight])).toEqual([]);
  });

  // The exam, 10 Oct (#6, #7): "any AC sleeper on the 5th night that reaches by morning" held 10 am against the night's
  // own date, so every overnight bus missed it (46 of the 54 Bengaluru to Goa buses were AC sleepers).
  it('reads an arrival time as the first one after it leaves: the morning after a night bus, the same day for a morning one', () => {
    const bus = (depart: string, arrive: string): TravelOption => ({
      kind: 'bus', title: `${depart} bus`, priceMinor: 200_000, currency: 'INR', priceNote: 'per seat, from', highlights: [], facts: { ac: true, sleeper: true },
      journey: { mode: 'bus', origin: { name: 'Bengaluru' }, destination: { name: 'Goa' }, depart_at: `2026-11-05T${depart}:00+05:30`, arrive_at: arrive },
    });
    const byMorning = { departAfter: '18:00', arriveBefore: '10:00' };
    expect(misses('buses', byMorning, bus('18:00', '2026-11-06T07:00:00+05:30'))).toEqual([]);
    expect(misses('buses', byMorning, bus('20:15', '2026-11-06T10:30:00+05:30'))).toEqual(['arrives at 10:30 am the next day, after 10:00 am']);
    expect(misses('buses', { arriveBefore: '10:00' }, bus('06:00', '2026-11-05T09:30:00+05:30'))).toEqual([]);
    expect(misses('buses', { arriveBefore: '10:00' }, bus('06:00', '2026-11-06T09:30:00+05:30'))).toEqual(['arrives at 9:30 am the next day, after 10:00 am']);
    // A bus that leaves late and arrives before midnight is in long before the next morning.
    expect(misses('buses', byMorning, bus('19:00', '2026-11-05T23:30:00+05:30'))).toEqual([]);
  });

  it('names the limit that alone leaves out every option when nothing fits, never one some of them meet', () => {
    const bus = (depart: string, arrive: string, boarding: string): TravelOption => ({
      kind: 'bus', title: `${depart} bus`, priceMinor: 200_000, currency: 'INR', priceNote: 'per seat, from', highlights: [], facts: { boarding_points: boarding },
      journey: { mode: 'bus', origin: { name: 'Bengaluru' }, destination: { name: 'Goa' }, depart_at: `2026-11-05T${depart}:00+05:30`, arrive_at: arrive },
    });
    const buses = [bus('18:00', '2026-11-06T07:00:00+05:30', 'Majestic; Silk Board'), bus('21:00', '2026-11-06T09:15:00+05:30', 'Majestic')];
    // Arriving by 6 am cuts both; picking up at Silk Board only one; leaving after 6 pm none.
    expect(missedByAll('buses', { departAfter: '18:00', arriveBefore: '06:00', boardAt: 'Silk Board' }, buses)).toEqual(['arriving by 6:00 am']);
    expect(missedByAll('buses', { arriveBefore: '06:00', maxPriceMinor: 100_000 }, buses)).toEqual(['arriving by 6:00 am', 'at most ₹1,000 a person']);
    expect(missedByAll('buses', { departAfter: '18:00', boardAt: 'Silk Board' }, buses)).toEqual([]);
    expect(missedByAll('buses', { arriveBefore: '06:00' }, [])).toEqual([]);
  });

  it('says the day a train arrives when it is two days later, not "the next day"', () => {
    const longTrain: TravelOption = {
      offerId: 'fake:22634', kind: 'train', title: '22634 NZM TVC SF Exp', priceMinor: 218500, currency: 'INR', priceNote: 'per person', highlights: [], facts: {},
      journey: { mode: 'train', origin: { name: 'Delhi' }, destination: { name: 'Thiruvananthapuram' }, depart_at: '2026-11-06T22:15:00+05:30', arrive_at: '2026-11-08T02:00:00+05:30' },
    };
    expect(misses('trains', { arriveBefore: '23:00' }, longTrain)).toEqual(['arrives at 2:00 am on Sun 8 Nov, after 11:00 pm']);
  });

  it('drops a train that arrives the next day when it must arrive before a time', async () => {
    const { results } = await fake.search('trains', { from: 'Delhi', to: 'Goa', date: FRIDAY });
    expect(results.length).toBeGreaterThan(0);
    expect(applyConstraints('trains', { arriveBefore: '23:00' }, results)).toEqual([]);
  });

  // Keshav, 10 Oct: buses have many pickup and drop points. A point the group named keeps the buses that stop there.
  it('keeps the buses that pick up and drop where the group named, by the names ixigo lists, and holds no unlisted points against a bus', () => {
    const bus = (title: string, facts: Record<string, string>): TravelOption => ({
      kind: 'bus', title, priceMinor: 150_000, currency: 'INR', priceNote: 'per seat, from', highlights: [], facts, sourceUrl: 'https://www.ixigo.com/buses',
      journey: { mode: 'bus', origin: { name: 'Bengaluru' }, destination: { name: 'Goa' }, depart_at: '2026-11-06T19:30:00+05:30', arrive_at: '2026-11-07T08:30:00+05:30' },
    });
    const all = [
      bus('Paulo Travels Express', { boarding_points: 'Majestic; Silk Board; Marathahalli', dropping_points: 'Panjim; Mapusa- Isbt Private Bus Stand; Madgaon, Goa' }),
      bus('VRL Travels', { boarding_points: 'Silk Board; Electronic City', dropping_points: 'Madgaon' }),
      bus('Seabird Tourists', {}),
    ];
    expect(pointAt('Panjim; Mapusa- Isbt Private Bus Stand; Madgaon, Goa', 'mapusa')).toBe('Mapusa- Isbt Private Bus Stand');
    expect(pointAt('Majestic; Silk Board', 'Majestic bus stand')).toBe('Majestic');
    expect(pointAt('Silk Board', 'Majestic')).toBeNull();
    const titles = (q: { boardAt?: string; dropAt?: string }) => applyConstraints('buses', q, all).map((o) => o.title);
    expect(titles({ boardAt: 'Majestic' })).toEqual(['Paulo Travels Express', 'Seabird Tourists']);
    expect(titles({ dropAt: 'Madgaon' })).toEqual(['Paulo Travels Express', 'VRL Travels', 'Seabird Tourists']);
    expect(titles({ boardAt: 'Silk Board', dropAt: 'Mapusa' })).toEqual(['Paulo Travels Express', 'Seabird Tourists']);
    expect(misses('buses', { boardAt: 'Majestic', dropAt: 'Mapusa' }, all[1]!)).toEqual(['no pickup at Majestic', 'no drop at Mapusa']);
    expect(asked('buses', { boardAt: 'Majestic', dropAt: 'Mapusa' })).toEqual(['picking up at Majestic', 'dropping at Mapusa']);
  });
});
