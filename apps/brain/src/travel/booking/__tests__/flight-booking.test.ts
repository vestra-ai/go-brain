import * as C from '@go/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../../db/test-db.js';
import { makeLaneBrain, type LaneBrain } from '../../../tasks/testing/lane-brain.js';
import { capture } from '../../recipes/__tests__/fixtures.js';
import type { FetchPlan } from '../../recipes/recipe.js';
import type { ReadOptions, RecipeRunner } from '../../recipes/runners.js';
import type { StoredOffer } from '../../travel.js';
import { createFlightBooking, FLIGHT_FARE, FLIGHT_STREAM, GRAPH, numbersOf, readyCard, type FlightBooking } from '../flight-booking.js';

let db: Awaited<ReturnType<typeof withSchema>>;
let lb: LaneBrain;

beforeAll(async () => {
  db = await withSchema();
  lb = makeLaneBrain({ pool: db.pool });
});
afterAll(async () => {
  await db.drop();
});

// ixigo's answers, in the 7 Oct capture's shapes (values made up): the 1-adult stream, the review page's fare and the
// coupon ixigo applied itself. The coupon call also carries the account's wallet ("burn"), which is never read.
const STREAM = `data:${JSON.stringify({
  data: {
    searchToken: 'tok123',
    flightJourneys: [{ flightFare: [
      { flightKeys: 'DEL-GOI-AI101-06112026', fares: [{ fareType: 'REGULAR', fareDetails: { fareToken: 'T-AI101' }, fareMetadata: [{ providerId: 1044 }] }] },
      { flightKeys: 'DEL-GOI-6E2150-06112026', fares: [{ fareType: 'REGULAR', fareDetails: { fareToken: 'T-6E2150' }, fareMetadata: [{ providerId: 1044 }] }] },
    ] }],
  },
})}\n\n`;
const FARE = JSON.stringify({
  data: {
    flightFare: [{ fareSummary: { currency: 'INR', totalFareForAllPassengers: 7896 } }],
    fareTypeResponse: { fareTypes: [
      { type: 'BASIC_FARE', finalTotalDisplayedFare: 7896 }, { type: 'IXIGO_ASSURED', finalTotalDisplayedFare: 9105 }, { type: 'ASSURED_FLEX', finalTotalDisplayedFare: 9405 },
    ] },
  },
});
const COUPONS = JSON.stringify({
  data: { insuranceCouponBurnV2: {
    coupon: { data: [
      { couponCode: 'SALE', selected: true, instantDiscount: { amount: 360, currency: 'INR' } },
      { couponCode: 'AUSFD', selected: false, instantDiscount: { amount: 1500, currency: 'INR' } },
    ] },
    burn: { data: { totalWalletBalance: 987654 } },
  } },
});

type Read = { url: string; plan: FetchPlan; o: ReadOptions | undefined };
function fakeRunner(o: { fare?: boolean } = {}): { runner: RecipeRunner; reads: Read[] } {
  const reads: Read[] = [];
  const runner: RecipeRunner = {
    name: 'browser_fetch',
    async read(_trip, url, plan, opts) {
      reads.push({ url, plan, o: opts });
      if (url.includes('/search/result/flight')) return { captures: [{ ...capture(FLIGHT_STREAM, 'https://www.ixigo.com/flights/v2/search/stream', STREAM), content_type: 'text/event-stream' }], finalUrl: url };
      return {
        captures: o.fare === false ? [] : [capture(FLIGHT_FARE, 'https://www.ixigo.com/flight-booking/flight-fare?x', FARE), capture(GRAPH, 'https://www.ixigo.com/graph', COUPONS)],
        finalUrl: url,
      };
    },
  };
  return { runner, reads };
}

const OFFER: StoredOffer = {
  optionId: 'opt_fl1', tripId: 't_goa', cardId: 'c_fl', resultsId: 'r_1', n: 1, offerId: null, kind: 'flight', title: 'IndiGo 6E2150',
  priceMinor: 789_600, totalMinor: null, currency: 'INR', priceNote: 'per person', checkedAt: '2026-10-10T07:00:00.000Z',
  sourceUrl: 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026&returnDate=&adults=4&children=0&infants=0&class=e&source=Search%20Form',
};

function booking(runner: RecipeRunner, on = true): FlightBooking {
  void lb.switches.set('FLIGHT_BOOKING', on ? 'on' : 'off');
  void lb.switches.set('TRAVEL_MODE', 'ixigo_web');
  return createFlightBooking({ pool: db.pool, runner: () => runner, link: lb.link, switches: lb.switches, now: lb.brain.now, log: lb.brain.log });
}

describe("Go books a person's own flight up to ixigo's pay button", () => {
  it('opens the fare on the stage for them alone, picks the fare type, keeps ixigo\'s coupon, and posts their ready card', async () => {
    const { runner, reads } = fakeRunner();
    const b = booking(runner);
    expect(b.on()).toBe(true);
    const from = lb.link.requests.length;
    await b.start({ tapId: 'tap_b1', tripId: 't_goa', personId: 'p_meher', name: 'Meher', offer: OFFER, choice: 'basic' });
    await b.settled();
    // 1. ixigo's results for one adult, on the stage, the stream's last event; 2. that flight's review page, on the stage.
    expect(reads.map((r) => [new URL(r.url).pathname, r.o?.stage])).toEqual([['/search/result/flight', true], ['/flight/booking/1044/tok123', true]]);
    expect(new URL(reads[0]!.url).searchParams.get('adults')).toBe('1');
    expect(reads[0]!.plan.capture).toEqual([{ match: FLIGHT_STREAM, required: true, max_bytes: 4_194_304, sse: 'last' }]);
    expect(new URL(reads[1]!.url).searchParams.get('ftk')).toBe('T-6E2150');
    expect(reads[1]!.plan.steps).toEqual([{ op: 'click', role: 'radio', text: "I don't want Free Cancellation" }]);
    // The room: a live card ticking each step, then Meher's card, for her alone, with what she would pay.
    const sent = lb.link.requests.slice(from);
    const live = sent.filter((r) => (r.params['card'] as { kind?: string } | undefined)?.kind === 'working').at(-1)!.params['card'] as C.Card & { steps: Array<{ state: string }> };
    expect(live).toMatchObject({ title: 'Booking IndiGo 6E2150 for Meher', state: 'done' });
    expect(live.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done']);
    const ready = C.NoticeCard.parse(sent.find((r) => (r.params['card'] as { kind?: string } | undefined)?.kind === 'notice')!.params['card']);
    expect(ready).toMatchObject({
      title: 'Ready to pay ₹7,536 for Meher', for_person_ids: ['p_meher'],
      body: "IndiGo 6E2150, no free cancellation. ixigo's SALE coupon: ₹360 off.",
      actions: [{ action_id: 'pay_flight', label: 'Pay', only_for_person_ids: ['p_meher'] }],
    });
    // Nothing of the account's wallet reaches the room.
    expect(JSON.stringify(sent)).not.toContain('987654');
    const row = (await db.pool.query(`select state, total_minor, coupon_code, coupon_minor, review_url from flight_bookings where person_id = 'p_meher'`)).rows[0];
    expect(row).toMatchObject({ state: 'ready_to_pay', total_minor: '753600', coupon_code: 'SALE', coupon_minor: '36000' });
  });

  it('prices the fare type they asked for, and a repeat of the tap starts nothing', async () => {
    const { runner, reads } = fakeRunner();
    const b = booking(runner);
    const ask = { tapId: 'tap_b2', tripId: 't_goa', personId: 'p_kabir', name: 'Kabir', offer: OFFER, choice: 'flex' as const };
    await b.start(ask);
    await b.start(ask);
    await b.settled();
    expect(reads).toHaveLength(2);
    expect(reads[1]!.plan.steps).toEqual([{ op: 'click', role: 'radio', text: 'Assured Flex' }]);
    const row = (await db.pool.query(`select total_minor from flight_bookings where person_id = 'p_kabir'`)).rows[0];
    expect(row.total_minor).toBe(String(940_500 - 36_000));
  });

  it('stops and says so when the flight is gone or the review page did not answer', async () => {
    const gone = booking(fakeRunner().runner);
    await gone.start({ tapId: 'tap_b3', tripId: 't_goa', personId: 'p_arjun', name: 'Arjun', offer: { ...OFFER, title: 'Vistara UK811' }, choice: 'basic' });
    await gone.settled();
    const unread = booking(fakeRunner({ fare: false }).runner);
    await unread.start({ tapId: 'tap_b4', tripId: 't_goa', personId: 'p_priya', name: 'Priya', offer: OFFER, choice: 'basic' });
    await unread.settled();
    const rows = (await db.pool.query(`select person_id, state, why from flight_bookings where person_id in ('p_arjun', 'p_priya') order by person_id`)).rows;
    expect(rows).toEqual([{ person_id: 'p_arjun', state: 'failed', why: 'fare_not_found' }, { person_id: 'p_priya', state: 'failed', why: 'review_not_read' }]);
  });

  it('is off unless the switch is on and Go reads ixigo.com itself', () => {
    expect(booking(fakeRunner().runner, false).on()).toBe(false);
  });

  it("reads a card title's flight numbers leg by leg, and says a ready card's coupon only when ixigo applied one", () => {
    expect(['IndiGo 6E2150', 'IndiGo 6E328 + 6E5106', 'Air India Express IX1196', 'Akasa QP1100'].map(numbersOf)).toEqual([['6E2150'], ['6E328', '6E5106'], ['IX1196'], ['QP1100']]);
    const card = readyCard({ cardId: 'c_r', personId: 'p_meher', name: 'Meher', title: 'IndiGo 6E2150', when: 'Fri 6 Nov, 18:15', choice: 'assured', amountMinor: 910_500, coupon: null });
    expect(card.body).toBe('IndiGo 6E2150, Fri 6 Nov, 18:15, Assured (free cancellation).');
  });
});
