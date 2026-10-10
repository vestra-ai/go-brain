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

// Keshav, 10 Oct: buses have many pickup and drop points. A bus's own, with their times and landmarks, and its
// cancellation policy are on its seat layout, opened by that card's own "Select Seats" (read on 10 Oct, read only).
describe('buses.stops', () => {
  const RESULTS = 'https://www.ixigo.com/buses/bus_search/Bengaluru/7/Goa/102/06-11-2026/O';
  const PAULO = `${RESULTS}#Paulo%20Travels%20Express@17:30`;
  const LAYOUT = '/wap/GetSeatLayout$';
  const layout = (over: Record<string, unknown> = {}) =>
    capture(LAYOUT, 'https://www.ixigo.com/wap/GetSeatLayout', JSON.stringify({ ...JSON.parse(sample('buses.stops.json')), ...over }));

  it("opens the bus's results and clicks its own Select Seats by its operator and time, and says every stop with its time", async () => {
    const got = await facts('buses.stops', { bus: PAULO }, [layout()]);
    expect(got.runs[0]!.url).toBe(RESULTS);
    expect(got.runs[0]!.plan.capture).toEqual([{ match: LAYOUT, required: true }]);
    expect(got.runs[0]!.plan.steps).toEqual([
      { op: 'wait_for', match: '/buslist/v3/services$' },
      { op: 'click', role: 'button', name: 'Select Seats', near_text: ['Paulo Travels Express', '17:30'] },
      { op: 'wait_for', match: LAYOUT },
    ]);
    expect(got.title).toBe('Paulo Travels Express at 17:30: its stops');
    const bus = got.rows[0]!;
    expect(bus['pickups']).toHaveLength(8);
    expect((bus['pickups'] as string[])[0]).toBe('Marathahalli Opp Innovative Multiplex main Road, 05:35 PM');
    // A landmark the name doesn't hold is said with it; a phone number in a name never is.
    expect((bus['pickups'] as string[])[2]).toBe('Silk Board- Nr Jamia Masjid Bus Stop Opp Traffic Police Stn (National Highway 7, Hosur Rd, Madiwala, 1st Stage, BTM 1st Stage, Bengaluru, Karnataka), 06:00 PM');
    expect((bus['pickups'] as string[])[4]).toBe('Majestic- Amar Hotel Near Bhagya Vinayaka Temple, 07:30 PM');
    expect(bus['drops']).toContain('Mapusa - Gandhi Circle New Bus Stand, 10:30 AM');
    expect(bus['drops']).toContain('Madgaon - Inside KTC Bus Stand (Margao), 08:30 AM');
    expect(bus['cancellation']).toEqual([
      'Before 30-Oct 20:00: 100% refund (Rs. 2500)',
      'Between 30-Oct 20:00 & 3-Nov 20:00: 90% refund (Rs. 2250)',
      'Between 3-Nov 20:00 & 5-Nov 20:00: 50% refund (Rs. 1250)',
      'Between 5-Nov 20:00 & 6-Nov 17:00: 0% refund (Rs. 0)',
    ]);
  });

  it("never reads another bus's layout as this one's: another operator, or the same at another time", async () => {
    expect((await facts('buses.stops', { bus: PAULO }, [layout({ travelerAgentName: 'VRL Travels' })])).rows).toEqual([]);
    expect((await facts('buses.stops', { bus: PAULO }, [layout({ startTimeDateFormat: '2026-11-06 19:30:00' })])).rows).toEqual([]);
    expect((await facts('buses.stops', { bus: PAULO }, [layout({ startTimeDateFormat: '2026-11-06 17:30:00' })])).rows).toHaveLength(1);
  });
});
