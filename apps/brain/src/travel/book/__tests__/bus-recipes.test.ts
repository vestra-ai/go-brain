import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Capture, FetchPlan } from '../../recipes/recipe.js';
import { capture } from '../../recipes/__tests__/fixtures.js';
import { BOOK_DIR, loadBook } from '../book.js';
import { createEngine } from '../engine.js';

// p4's buses recipes beyond the search, each read from its own sample: ixigo's own pages, recorded logged out on 8 Oct
// 2026 and trimmed to a few of their parts. No person's details are in any of them.
const { book } = loadBook();
const sample = (name: string): string => readFileSync(`${BOOK_DIR}samples/${name}`, 'utf8');

async function facts(id: string, inputs: Record<string, unknown>, captures: Capture[]) {
  const runs: Array<{ url: string; plan: FetchPlan }> = [];
  const runner = {
    read: async (_trip: string, url: string, plan: FetchPlan) => {
      runs.push({ url, plan });
      return { captures, finalUrl: url };
    },
  };
  const engine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-08T12:00:00Z') });
  const got = await engine.answer(id, inputs, { tripId: 't_goa' });
  if (got.as !== 'facts') throw new Error('not facts');
  return { ...got, runs };
}

describe('buses.offers', () => {
  const PAGE = 'https://www.ixigo.com/buses/offers';

  it("reads every offer in the page's flight payload once, with its code, what it gives, its first terms and its days", async () => {
    const got = await facts('buses.offers', {}, [capture('/buses/offers$', PAGE, sample('buses.offers.html'))]);
    expect(got.page).toBe(PAGE);
    expect(got.runs[0]!.plan.capture).toEqual([{ match: '/buses/offers$', required: true, max_bytes: 1_000_000 }]);
    // RBL300 is in the payload twice, as on the page: it is read once.
    expect(got.rows.map((r) => r['code'])).toEqual(['RBL300', 'BUSAU200', 'VISACC', 'NAVEEN500', 'MAHA200', 'ROYAL30']);
    expect(got.rows[0]).toEqual({
      offer: 'Get up to Rs.300 off with RBL Bank Credit Card',
      code: 'RBL300',
      what: 'Use Coupon RBL300 & Get up to Rs.300 off with RBL Bank Credit Card on your 1st booking',
      terms: [
        'Use code RBL300 to Get 10% up to Rs.300 Instant Discount with RBL Bank Credit Card',
        'Offer valid for all users, once per user during the offer period',
        'Offer Valid on select RBL Bank Credit Cards only',
        'Valid on a minimum transaction value of Rs.1500 (excluding service charge & taxes)',
      ],
      from: '2025-09-13',
      until: '2026-11-30',
      new_users_only: false,
    });
    expect(got.rows[3]).toMatchObject({ code: 'NAVEEN500', until: '2026-10-31', new_users_only: true });
  });
});

// The ixigo atlas (10 Oct): ixigo's own bus box ranks a city's boarding points by how many people board there.
describe('buses.points', () => {
  it("says a city's boarding points the busiest first, by the names people use, from ixigo's bus box", async () => {
    const BOX = '/wap/abus-autocompleter/api/v1/results';
    const got = await facts('buses.points', { city: 'bangalore' }, [capture(BOX, `https://www.ixigo.com${BOX}?s=bangalore`, sample('buses.city_lookup.bangalore.json'))]);
    expect(got.runs[0]!.url).toBe('https://www.ixigo.com/wap/abus-autocompleter/api/v1/results?s=bangalore');
    expect(got.title).toBe('Bus boarding points in bangalore');
    expect(got.rows).toEqual([{
      city: 'Bangalore',
      region: 'Bengaluru, Karnataka',
      busiest: 'Majestic',
      points: ['Majestic', 'Marathahalli', 'Silk Board', 'Madiwala', 'Anand Rao Circle', 'KR Puram', 'Tin Factory', 'Electronic City', 'Yeswanthpur', 'Kalasipalyam'],
      how_many: 15,
    }]);
  });
});
