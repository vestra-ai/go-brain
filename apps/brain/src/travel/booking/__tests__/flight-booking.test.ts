import * as C from '@go/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../../db/test-db.js';
import { makeLaneBrain, type LaneBrain } from '../../../tasks/testing/lane-brain.js';
import { capture } from '../../recipes/__tests__/fixtures.js';
import type { FetchPlan } from '../../recipes/recipe.js';
import type { ReadOptions, RecipeRunner } from '../../recipes/runners.js';
import { createResultsStore, type ResultOption } from '../../results.js';
import type { StoredOffer } from '../../travel.js';
import { SWITCH_RULES } from '../../../admin/switches.js';
import { createFlightBooking, dayMs, dayOf, FLIGHT_FARE, FLIGHT_STREAM, GRAPH, numbersOf, readyCard, SAVED_TRAVELLERS, TRAVELLER_FIELDS, type FlightBooking, type TicketPay } from '../flight-booking.js';

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

// The account's saved travellers as ixigo answers them (E2's keys; made-up people): Meher once, Arjun twice.
const SAVED = JSON.stringify({
  data: [
    { id: 'tv1', firstName: 'Meher', lastName: 'Kapoor', dob: '1994-03-02', travellerType: 'ADULT' },
    { id: 'tv2', firstName: 'Arjun', lastName: 'Rao', travellerType: 'ADULT' },
    { id: 'tv3', firstName: 'Arjun', lastName: 'Mehta', travellerType: 'ADULT' },
  ],
});

type Read = { url: string; plan: FetchPlan; o: ReadOptions | undefined };
function fakeRunner(o: { fare?: boolean; tick?: boolean | 'ran_out' } = {}): { runner: RecipeRunner; reads: Read[]; calls: string[] } {
  const reads: Read[] = [];
  const calls: string[] = [];
  const runner: RecipeRunner = {
    name: 'browser_fetch',
    async read(_trip, url, plan, opts) {
      reads.push({ url, plan, o: opts });
      if (url.includes('/search/result/flight')) return { captures: [{ ...capture(FLIGHT_STREAM, 'https://www.ixigo.com/flights/v2/search/stream', STREAM), content_type: 'text/event-stream' }], finalUrl: url };
      if (opts?.private) {
        if (o.tick === false) throw new Error('504 timeout at 3 click');
        // Ran out of time at the tick, with the traveller step's call caught: the runner answers it, and its trace says so.
        if (o.tick === 'ran_out') opts.onTrace?.({ started_at: 0, elapsed_ms: 20_000, calls: [], failed: { status: 504, why: 'ran out of time at 3 click' } });
        return { captures: [capture(TRAVELLER_FIELDS, 'https://www.ixigo.com/flight-booking/v1/traveller/display-fields?x', '{"data":{}}')], finalUrl: url };
      }
      return {
        captures: o.fare === false ? [] : [capture(FLIGHT_FARE, 'https://www.ixigo.com/flight-booking/flight-fare?x', FARE), capture(GRAPH, 'https://www.ixigo.com/graph', COUPONS)],
        finalUrl: url,
      };
    },
    async pageFetch(_trip, call) {
      calls.push(call.url);
      return capture(SAVED_TRAVELLERS, `https://www.ixigo.com${call.url}`, SAVED);
    },
  };
  return { runner, reads, calls };
}

const OFFER: StoredOffer = {
  optionId: 'opt_fl1', tripId: 't_goa', cardId: 'c_fl', resultsId: 'r_1', n: 1, offerId: null, kind: 'flight', title: 'IndiGo 6E2150',
  priceMinor: 789_600, totalMinor: null, currency: 'INR', priceNote: 'per person', checkedAt: '2026-10-10T07:00:00.000Z',
  sourceUrl: 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026&returnDate=&adults=4&children=0&infants=0&class=e&source=Search%20Form',
};

function booking(runner: RecipeRunner, on = true, ticketPay: TicketPay | null = null, more: { results?: ReturnType<typeof createResultsStore> } = {}): FlightBooking {
  void lb.switches.set('BOOKING', on ? 'on' : 'off');
  void lb.switches.set('TRAVEL_MODE', 'ixigo_web');
  return createFlightBooking({
    pool: db.pool, runner: () => runner, link: lb.link, switches: lb.switches, now: lb.brain.now, log: lb.brain.log, pay: () => ticketPay ?? undefined,
    nameOf: async (_trip, personId) => ({ p_rahul: 'Rahul' } as Record<string, string>)[personId] ?? 'Someone',
    ...(more.results ? { results: more.results } : {}),
  });
}

describe("Go books a person's own flight up to ixigo's pay button", () => {
  it('opens the fare on the stage for them alone, picks the fare type, keeps ixigo\'s coupon, and posts their ready card', async () => {
    const { runner, reads, calls } = fakeRunner();
    const b = booking(runner);
    expect(await b.onFor('t_goa')).toBe(true);
    const from = lb.link.requests.length;
    await b.start({ tapId: 'tap_b1', tripId: 't_goa', personId: 'p_meher', name: 'Meher', offer: OFFER, choice: 'basic' });
    await b.settled();
    // 1. ixigo's results for one adult, on the stage, the stream's last event; 2. that flight's review page, on the stage;
    // 4. the same page again in a private tab, where her saved traveller is ticked on the traveller step.
    expect(reads.map((r) => [new URL(r.url).pathname, r.o?.stage ?? false, r.o?.private ?? false])).toEqual([
      ['/search/result/flight', true, false], ['/flight/booking/1044/tok123', true, false], ['/flight/booking/1044/tok123', false, true],
    ]);
    expect(new URL(reads[0]!.url).searchParams.get('adults')).toBe('1');
    expect(reads[0]!.plan.capture).toEqual([{ match: FLIGHT_STREAM, required: true, max_bytes: 4_194_304, sse: 'last' }]);
    expect(new URL(reads[1]!.url).searchParams.get('ftk')).toBe('T-6E2150');
    expect(reads[1]!.plan.steps).toEqual([{ op: 'click', role: 'radio', text: "I don't want Free Cancellation" }]);
    // The account's saved travellers, read inside the page for the day she flies, and her own ticked by her name there.
    expect(calls).toEqual([`${SAVED_TRAVELLERS}?date=${dayMs('06112026')}`]);
    expect(reads[2]!.plan).toEqual({
      capture: [{ match: TRAVELLER_FIELDS, required: true }],
      steps: [{ op: 'click', role: 'radio', text: "I don't want Free Cancellation" }, { op: 'click', role: 'button', name: 'Continue' }, { op: 'click', text: 'Meher Kapoor' }],
    });
    // Her live card ticking each step, then her ready card with what she would pay: each posted for her alone (1.2).
    const sent = lb.link.requests.slice(from);
    expect(sent.filter((r) => r.method === 'post_message').map((r) => r.params['visible_to_person_ids'])).toEqual([['p_meher'], ['p_meher']]);
    const live = sent.filter((r) => (r.params['card'] as { kind?: string } | undefined)?.kind === 'working').at(-1)!.params['card'] as C.Card & { steps: Array<{ state: string }> };
    expect(live).toMatchObject({ title: 'Booking IndiGo 6E2150 for Meher', state: 'done' });
    expect(live.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'done']);
    const ready = C.NoticeCard.parse(sent.find((r) => (r.params['card'] as { kind?: string } | undefined)?.kind === 'notice')!.params['card']);
    expect(ready).toMatchObject({
      title: 'Ready to pay ₹7,536 for Meher', for_person_ids: ['p_meher'],
      body: "IndiGo 6E2150, Fri 6 Nov, no free cancellation. ixigo's SALE coupon: ₹360 off.",
      actions: [{ action_id: 'pay_flight', label: 'Pay', only_for_person_ids: ['p_meher'] }],
    });
    // Nothing of the account's wallet or of its saved travellers reaches the room.
    expect(JSON.stringify(sent)).not.toContain('987654');
    expect(JSON.stringify(sent)).not.toMatch(/Kapoor|Rao|Mehta/);
    const row = (await db.pool.query(`select state, total_minor, coupon_code, coupon_minor, review_url from flight_bookings where person_id = 'p_meher'`)).rows[0];
    expect(row).toMatchObject({ state: 'ready_to_pay', total_minor: '753600', coupon_code: 'SALE', coupon_minor: '36000' });
  });

  it('prices the fare type they asked for, and a repeat of the tap starts nothing', async () => {
    const { runner, reads } = fakeRunner();
    const b = booking(runner);
    // A traveller the account has saved (Meher), so the booking runs to its end: three reads, the stage's two and the private one.
    // Flex, at ₹9,045 after the coupon, within 5% of the ₹9,000 its card showed.
    const ask = { tapId: 'tap_b2', tripId: 't_goa', personId: 'p_meher6', name: 'Meher', offer: { ...OFFER, priceMinor: 900_000 }, choice: 'flex' as const };
    await b.start(ask);
    await b.start(ask);
    await b.settled();
    expect(reads).toHaveLength(3);
    expect(reads[1]!.plan.steps).toEqual([{ op: 'click', role: 'radio', near_text: 'Free Cancellation + Rescheduling' }]);
    const row = (await db.pool.query(`select state, total_minor from flight_bookings where person_id = 'p_meher6'`)).rows[0];
    expect(row).toEqual({ state: 'ready_to_pay', total_minor: String(940_500 - 36_000) });
  });

  // The App team's G2 (11 Oct): up to 5% over the price picked at goes ahead; more is asked again at the new price.
  it('books a fare within 5% of the price they picked at, and asks again at the new price, on a card of their own, past that', async () => {
    const results = createResultsStore(db.pool);
    const flight: ResultOption = { kind: 'flight', title: 'IndiGo 6E2150', priceMinor: 600_000, currency: 'INR', priceNote: 'per person', highlights: [], facts: {}, sourceUrl: OFFER.sourceUrl! };
    const set = await results.save({ tripId: 't_goa', optionKind: 'flight', source: 'search', query: {}, options: [flight], checkedAt: '2026-10-10T07:00:00.000Z' });
    await results.saveCard(
      { cardId: 'c_g2', tripId: 't_goa', resultsId: set.resultsId, title: 'Flights', optionKind: 'flight', card: { card_id: 'c_g2' } as never },
      [{ optionId: 'opt_g2', n: 1, option: flight }], '2026-10-10T07:00:00.000Z',
    );
    const offer = { ...OFFER, optionId: 'opt_g2', cardId: 'c_g2', resultsId: set.resultsId };
    // ₹7,536 to pay against ₹7,200 picked: within 5%, booked to its end.
    const near = fakeRunner();
    const a = booking(near.runner, true, null, { results });
    await a.start({ tapId: 'tap_g2a', tripId: 't_goa', personId: 'p_meher7', name: 'Meher', offer: { ...offer, priceMinor: 720_000 }, choice: 'basic' });
    await a.settled();
    expect((await db.pool.query(`select state from flight_bookings where person_id = 'p_meher7'`)).rows[0]).toEqual({ state: 'ready_to_pay' });
    // Against ₹6,000 picked: 26% over. The run stops before her travellers, and she gets that flight at ₹7,536, hers to pick.
    const far = fakeRunner();
    const b = booking(far.runner, true, null, { results });
    const from = lb.link.requests.length;
    await b.start({ tapId: 'tap_g2b', tripId: 't_goa', personId: 'p_meher8', name: 'Meher', offer, choice: 'basic' });
    await b.settled();
    expect(far.reads).toHaveLength(2);
    expect((await db.pool.query(`select state, why, total_minor from flight_bookings where person_id = 'p_meher8'`)).rows[0]).toEqual({ state: 'failed', why: 'fare_moved', total_minor: '753600' });
    const again = lb.link.requests.slice(from).find((r) => r.method === 'post_message' && (r.params['card'] as { kind?: string } | undefined)?.kind === 'options')!;
    expect(again.params['text']).toBe("Meher, IndiGo 6E2150 is ₹7,536 now, up from ₹6,000. Tap I'll take this to book it at ₹7,536.");
    expect(again.params['visible_to_person_ids']).toEqual(['p_meher8']);
    const card = C.OptionsCard.parse(again.params['card']);
    expect(card).toMatchObject({ title: 'IndiGo 6E2150 at ₹7,536 now', for_person_ids: ['p_meher8'], options: [{ title: 'IndiGo 6E2150', price_minor: 753_600 }] });
    expect(card.actions?.map((x) => [x.action_id, x.only_for_person_ids])).toContainEqual(['pick', ['p_meher8']]);
    // Its pick is a new tap on a card at the new price, which the Server's personal approval can verify.
    expect(await results.offer(card.options[0]!.option_id)).toMatchObject({ cardId: card.card_id, priceMinor: 753_600 });
    // With no store for the card: the line alone.
    const c = booking(fakeRunner().runner);
    const from2 = lb.link.requests.length;
    await c.start({ tapId: 'tap_g2c', tripId: 't_goa', personId: 'p_meher9', name: 'Meher', offer, choice: 'basic' });
    await c.settled();
    const line = lb.link.requests.slice(from2).find((r) => r.method === 'post_message' && !r.params['card'])!;
    expect(line.params).toMatchObject({ text: "Meher, IndiGo 6E2150 is ₹7,536 now, up from ₹6,000. Tap I'll take this to book it at ₹7,536.", visible_to_person_ids: ['p_meher9'] });
  });

  it("asks a traveller the account doesn't have once to add themselves on its owner's ixigo, naming none of its saved travellers", async () => {
    await db.pool.query(`insert into ixigo_logins (trip_id, person_id, state, attempt, asked_at, updated_at) values ('t_goa', 'p_rahul', 'logged_in', 1, now(), now()) on conflict (trip_id) do nothing`);
    const from = lb.link.requests.length;
    const b = booking(fakeRunner().runner);
    await b.start({ tapId: 'tap_b5', tripId: 't_goa', personId: 'p_kabir2', name: 'Kabir', offer: OFFER, choice: 'basic' });
    await b.start({ tapId: 'tap_b6', tripId: 't_goa', personId: 'p_arjun2', name: 'Arjun', offer: OFFER, choice: 'basic' });
    await b.settled();
    // The two bookings run at once, so their asks may come in either order: each is checked as its traveller's.
    const posted = lb.link.requests.slice(from).filter((r) => (r.params['card'] as C.Card | undefined)?.kind === 'notice');
    const asks = posted.map((r) => r.params['card'] as C.Card);
    // Each ask is posted for its traveller alone.
    expect(posted).toHaveLength(2);
    expect(posted.map((r) => [(r.params['card'] as C.Card).for_person_ids, r.params['visible_to_person_ids']])).toEqual(
      expect.arrayContaining([[['p_kabir2'], ['p_kabir2']], [['p_arjun2'], ['p_arjun2']]]),
    );
    expect(asks.map((c) => [c.for_person_ids?.[0], (c as { body: string }).body]).sort()).toEqual([
      ['p_arjun2', "Rahul's ixigo has more than one saved traveller named Arjun; keep one there, then tap Book it again."],
      ['p_kabir2', "Kabir isn't a saved traveller on Rahul's ixigo yet; add Kabir there once, then tap Book it again."],
    ]);
    expect(JSON.stringify(asks)).not.toMatch(/Rao|Mehta/);
    const rows = (await db.pool.query(`select person_id, why from flight_bookings where person_id in ('p_kabir2', 'p_arjun2') order by person_id`)).rows;
    expect(rows).toEqual([{ person_id: 'p_arjun2', why: 'several_saved_travellers' }, { person_id: 'p_kabir2', why: 'no_saved_traveller' }]);
  });

  it('asks for the trip\'s ixigo login before the saved travellers, and stops there when there is none', async () => {
    const { runner, calls } = fakeRunner();
    const asked: string[] = [];
    const b = createFlightBooking({
      pool: db.pool, runner: () => runner, link: lb.link, switches: lb.switches, now: lb.brain.now, log: lb.brain.log, nameOf: async () => 'Someone',
      login: { ensure: async (_trip, what) => (asked.push(what), { ok: false, note: 'asked to log in' }) },
    });
    await b.start({ tapId: 'tap_l1', tripId: 't_goa', personId: 'p_meher5', name: 'Meher', offer: OFFER, choice: 'basic' });
    await b.settled();
    expect(asked).toEqual(['Booking IndiGo 6E2150 for Meher']);
    // She is told why, on a card for her alone: whose login card it is (the trip's login row's person, named here by this
    // booking's nameOf), then Book it again.
    const told = lb.link.requests.filter((r) => (r.params['card'] as { card_id?: string } | undefined)?.card_id?.startsWith('c_book_login'));
    expect(told.map((r) => [r.params['visible_to_person_ids'], (r.params['card'] as { body: string }).body])).toEqual([
      [['p_meher5'], "Your traveller details come from the trip's ixigo login, which isn't linked yet: Someone has the Log in to ixigo card. Once it's in, tap Book it again."],
    ]);
    expect(calls).toEqual([]);
    expect((await db.pool.query(`select state, why from flight_bookings where person_id = 'p_meher5'`)).rows[0]).toEqual({ state: 'failed', why: 'login_needed' });
  });

  it("stops when her saved traveller couldn't be ticked on ixigo's traveller step, whether the fetch failed or ran out at the tick", async () => {
    for (const [tick, person] of [[false, 'p_meher2'], ['ran_out', 'p_meher3']] as const) {
      const b = booking(fakeRunner({ tick }).runner);
      await b.start({ tapId: `tap_${person}`, tripId: 't_goa', personId: person, name: 'Meher', offer: OFFER, choice: 'basic' });
      await b.settled();
      const row = (await db.pool.query(`select state, why from flight_bookings where person_id = $1`, [person])).rows[0];
      expect(row, String(tick)).toEqual({ state: 'failed', why: 'traveller_not_ticked' });
    }
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

  it("Pay opens the vault's page for the traveller alone, through the Server's approval for their own ticket, and paid marks it", async () => {
    const asked: Array<Record<string, unknown>> = [];
    const hook: { paid?: (p: { tripId: string; approvalId: string; railRef: string }) => Promise<void> } = {};
    const pay: TicketPay = {
      async requestTicketApproval(_trip, o) {
        asked.push(o);
        return { url: 'https://vault.example/pay/x', expiresAt: '2026-10-10T12:00:00.000Z', approvalId: 'appr_1', paymentId: 'pay_1' };
      },
      onPaid(fn) {
        hook.paid = fn;
      },
    };
    const b = booking(fakeRunner().runner, true, pay);
    await b.start({ tapId: 'tap_p1', tripId: 't_goa', personId: 'p_meher4', name: 'Meher', offer: OFFER, choice: 'basic' });
    await b.settled();
    const cardId = (await db.pool.query(`select card_id from flight_bookings where person_id = 'p_meher4'`)).rows[0].card_id as string;
    expect(await b.pay({ tripId: 't_goa', cardId, personId: 'p_kabir', tapId: 'tap_p2' })).toEqual({ result: 'refused', toast: 'This one is for someone else to pay' });
    expect(await b.pay({ tripId: 't_goa', cardId, personId: 'p_meher4', tapId: 'tap_p3' })).toEqual({ result: 'open', url: 'https://vault.example/pay/x', expires_at: '2026-10-10T12:00:00.000Z' });
    // Their pick goes with it (contract 1.3): the options card they tapped and the flight on it.
    expect(asked).toEqual([{
      personId: 'p_meher4', cardId: 'c_fl', optionId: 'opt_fl1', amountMinor: 753_600, currency: 'INR', purpose: 'IndiGo 6E2150, Fri 6 Nov, for Someone',
      key: expect.stringMatching(/^fb_/), trigger: 'tap_p3',
    }]);
    await hook.paid!({ tripId: 't_goa', approvalId: 'appr_1', railRef: 'fake_1' });
    expect((await db.pool.query(`select state, approval_id from flight_bookings where person_id = 'p_meher4'`)).rows[0]).toEqual({ state: 'paid', approval_id: 'appr_1' });
    expect(await b.pay({ tripId: 't_goa', cardId, personId: 'p_meher4', tapId: 'tap_p4' })).toEqual({ result: 'refused', toast: 'Already paid' });
  });

  // The App team's G2 (11 Oct): ready, ONE pay card, money's, with the Server's personal approval for the pick in it.
  it("ends on money's one pay card for them, no ready card; paid, the ticket goes on the trip as theirs", async () => {
    const asked: Array<Record<string, unknown>> = [];
    const hook: { paid?: (p: { tripId: string; approvalId: string; railRef: string }) => Promise<void> } = {};
    const pay: TicketPay = {
      async requestTicketCard(_trip, o) {
        asked.push(o);
        return { cardId: 'c_pay_t1', paymentId: 'pay_t1' };
      },
      onPaid(fn) {
        hook.paid = fn;
      },
    };
    const results = createResultsStore(db.pool);
    const b = booking(fakeRunner().runner, true, pay, { results });
    const from = lb.link.requests.length;
    await b.start({ tapId: 'tap_t1', tripId: 't_goa', personId: 'p_meher10', name: 'Meher', offer: OFFER, choice: 'basic' });
    await b.settled();
    expect(asked).toEqual([{
      personId: 'p_meher10', cardId: 'c_fl', optionId: 'opt_fl1', amountMinor: 753_600, currency: 'INR', purpose: 'IndiGo 6E2150, Fri 6 Nov, for Meher',
      key: expect.stringMatching(/^fb_/), trigger: 'tap_t1',
    }]);
    // Money's pay card is the one card: no ready card with Pay, and the live card ends done.
    const sent = lb.link.requests.slice(from);
    expect(sent.some((r) => (r.params['card'] as { kind?: string } | undefined)?.kind === 'notice')).toBe(false);
    expect((sent.filter((r) => (r.params['card'] as { kind?: string } | undefined)?.kind === 'working').at(-1)!.params['card'] as { state: string }).state).toBe('done');
    const row = (await db.pool.query(`select run_id, state, card_id from flight_bookings where person_id = 'p_meher10'`)).rows[0];
    expect(row).toMatchObject({ state: 'ready_to_pay', card_id: 'c_pay_t1' });
    // Paid: money's ticket payment keeps the run as its key. The ticket goes on the trip as Meher's, Go's own reference.
    const at = new Date('2026-10-10T08:00:00Z');
    await db.pool.query(
      `insert into payments (payment_id, trip_id, decision_id, option_ref, purpose, label, payer_person_id, payer_name, for_person_ids, state, created_at, updated_at, kind, hold_id, approval_id)
       values ('pay_t1', 't_goa', null, $1, 'IndiGo 6E2150', 'IndiGo 6E2150', 'p_meher10', 'Meher', '{p_meher10}', 'paid', $2, $2, 'ticket', $1, 'appr_t1')`,
      [row.run_id, at],
    );
    const paidFrom = lb.link.requests.length;
    await hook.paid!({ tripId: 't_goa', approvalId: 'appr_t1', railRef: 'fake_t1' });
    expect((await db.pool.query(`select state, approval_id from flight_bookings where person_id = 'p_meher10'`)).rows[0]).toEqual({ state: 'paid', approval_id: 'appr_t1' });
    const booked = lb.link.requests.slice(paidFrom).filter((r) => r.method === 'add_booking');
    expect(booked).toHaveLength(1);
    expect(booked[0]!.params).toMatchObject({
      trip_id: 't_goa', kind: 'flight', title: 'IndiGo 6E2150', vendor: 'ixigo (simulated)', ref: expect.stringMatching(/^SIM-[0-9A-F]{8}$/),
      amount_minor: 753_600, currency: 'INR', payer_person_id: 'p_meher10', for_person_ids: ['p_meher10'], approval_id: 'appr_t1',
    });
    // Heard again, nothing is booked twice.
    await hook.paid!({ tripId: 't_goa', approvalId: 'appr_t1', railRef: 'fake_t1' });
    expect(lb.link.requests.slice(paidFrom).filter((r) => r.method === 'add_booking')).toHaveLength(1);
  });

  it("sends them to ixigo only when the vault can't take it, saying why; any other no is said, theirs alone", async () => {
    const refusing = (code: string, say = false): TicketPay => ({ requestTicketCard: async () => ({ refused: 'The test rail is not ready.', code, say }), onPaid: () => undefined });
    const from = lb.link.requests.length;
    const b = booking(fakeRunner().runner, true, refusing('rail_not_ready'));
    await b.start({ tapId: 'tap_t2', tripId: 't_goa', personId: 'p_meher11', name: 'Meher', offer: OFFER, choice: 'basic' });
    await b.settled();
    const ixigo = lb.link.requests.slice(from).find((r) => (r.params['card'] as { kind?: string } | undefined)?.kind === 'notice')!;
    expect(ixigo.params).toMatchObject({ text: 'The test rail is not ready. You can book it on ixigo yourself: it opens set for you.', visible_to_person_ids: ['p_meher11'] });
    expect(C.NoticeCard.parse(ixigo.params['card'])).toMatchObject({ for_person_ids: ['p_meher11'], source: { url: expect.stringContaining('adults=1') } });
    expect((await db.pool.query(`select state, why from flight_bookings where person_id = 'p_meher11'`)).rows[0]).toEqual({ state: 'failed', why: 'pay_rail_not_ready' });
    const from2 = lb.link.requests.length;
    const c = booking(fakeRunner().runner, true, refusing('not_in_trip'));
    await c.start({ tapId: 'tap_t3', tripId: 't_goa', personId: 'p_meher12', name: 'Meher', offer: OFFER, choice: 'basic' });
    await c.settled();
    const said = lb.link.requests.slice(from2).filter((r) => r.method === 'post_message' && !r.params['card']);
    expect(said.map((r) => [r.params['text'], r.params['visible_to_person_ids']])).toEqual([['The test rail is not ready.', ['p_meher12']]]);
  });

  it("Pay says it opens soon with no ticket payment yet, says ixigo's refusal, and answers inside the tap when the Server is slow", async () => {
    // A saved traveller's booking (Meher's name on the account), so it ends on its ready card and Pay finds it.
    const b0 = booking(fakeRunner().runner);
    await b0.start({ tapId: 'tap_q1', tripId: 't_goa', personId: 'p_q', name: 'Meher', offer: OFFER, choice: 'basic' });
    await b0.settled();
    const cardId = (await db.pool.query(`select card_id from flight_bookings where person_id = 'p_q'`)).rows[0].card_id as string;
    expect(await b0.pay({ tripId: 't_goa', cardId, personId: 'p_q', tapId: 'tap_q2' })).toEqual({ result: 'refused', toast: 'Paying for a ticket through Go opens soon' });
    const refusing = booking(fakeRunner().runner, true, { requestTicketApproval: async () => ({ refused: "Q isn't in this trip", code: 'not_in_trip' }), onPaid: () => undefined });
    expect(await refusing.pay({ tripId: 't_goa', cardId, personId: 'p_q', tapId: 'tap_q3' })).toEqual({ result: 'refused', toast: "Q isn't in this trip" });
    const slow = booking(fakeRunner().runner, true, {
      requestTicketApproval: () => new Promise((r) => setTimeout(() => r({ url: 'https://vault.example/pay/y', expiresAt: 'x', approvalId: 'appr_2', paymentId: 'pay_2' }), 3_000)),
      onPaid: () => undefined,
    });
    expect(await slow.pay({ tripId: 't_goa', cardId, personId: 'p_q', tapId: 'tap_q4' })).toEqual({ result: 'done', toast: 'Getting your payment ready, tap Pay again in a moment' });
  });

  it("is off unless the switch is on, or names the trip's Server instance, and Go reads ixigo.com itself", async () => {
    expect(['off', 'on', 'instances:drill-p0', 'instances:drill-p0,drill-p2'].every(SWITCH_RULES.BOOKING.valid)).toBe(true);
    expect(['instances:', 'yes', 'instances:a b'].some(SWITCH_RULES.BOOKING.valid)).toBe(false);
    await db.pool.query(`insert into trips (trip_id, server_instance) values ('t_drill_p0', 'drill-p0'), ('t_his', 'go-live-keshav') on conflict (trip_id) do nothing`);
    const b = booking(fakeRunner().runner, false);
    expect(await b.onFor('t_drill_p0')).toBe(false);
    await lb.switches.set('BOOKING', 'instances:drill-p0,drill-p2');
    expect([await b.onFor('t_drill_p0'), await b.onFor('t_his'), await b.onFor('t_no_row')]).toEqual([true, false, false]);
    await lb.switches.set('TRAVEL_MODE', 'fake');
    expect(await b.onFor('t_drill_p0')).toBe(false);
  });

  it("reads a card title's flight numbers leg by leg, and says a ready card's coupon only when ixigo applied one", () => {
    expect(['IndiGo 6E2150', 'IndiGo 6E328 + 6E5106', 'Air India Express IX1196', 'Akasa QP1100'].map(numbersOf)).toEqual([['6E2150'], ['6E328', '6E5106'], ['IX1196'], ['QP1100']]);
    // ixigo's own day for 6 Nov 2026 (its flight-fare's departDate, 7 Oct capture), and the day a results page asks for.
    expect(dayMs('06112026')).toBe(1_793_903_400_000);
    expect([dayOf(OFFER.sourceUrl), dayOf(null), dayOf('https://www.ixigo.com/x')]).toEqual(['2026-11-06', null, null]);
    const card = readyCard({ cardId: 'c_r', personId: 'p_meher', name: 'Meher', title: 'IndiGo 6E2150', when: 'Fri 6 Nov, 18:15', choice: 'assured', amountMinor: 910_500, coupon: null });
    expect(card.body).toBe('IndiGo 6E2150, Fri 6 Nov, 18:15, Assured (free cancellation).');
  });
});
