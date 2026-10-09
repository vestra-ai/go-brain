import { describe, expect, it } from 'vitest';
import { FakeIxigoStore } from '../fake-ixigo/data.js';
import { applyConstraints, misses } from '../filters.js';
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
    expect(applyConstraints('flights', { departBefore: '10:00', nonStop: true }, results).map((o) => o.title)).toEqual(['IndiGo 6E 515', 'IndiGo 6E 6153', 'SpiceJet SG 8169']);
    expect(applyConstraints('flights', { maxPriceMinor: 550000 }, results).every((o) => o.priceMinor <= 550000)).toBe(true);
  });

  it("keeps the stays that sleep everyone within a nightly price; a pool or the beach is ixigo's filter or the model's pick, never Go's", async () => {
    const { results } = await fake.search('stays', { area: 'North Goa', checkIn: FRIDAY, checkOut: '2026-11-09' });
    const sleepsFive = results.filter((o) => typeof o.facts.sleeps === 'number' && o.facts.sleeps >= 5);
    const kept = applyConstraints('stays', { guests: 5 }, results);
    expect(kept).toHaveLength(sleepsFive.length);
    expect(kept.every((o) => (o.facts.sleeps as number) >= 5)).toBe(true);
    // A stay with no pool stays in: nobody's code guesses one for the ask.
    expect(kept.some((o) => o.facts.pool === false)).toBe(true);
    const capped = applyConstraints('stays', { guests: 5, maxPriceMinor: 1300000 }, results);
    expect(capped.length).toBeGreaterThan(0);
    expect(capped.every((o) => o.priceMinor <= 1300000 && (o.facts.sleeps as number) >= 5)).toBe(true);
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
});
