import * as C from '@go/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../../db/test-db.js';
import type { Booked, Paid } from '../../../money/pay.js';
import { makeLaneBrain, type LaneBrain } from '../../../tasks/testing/lane-brain.js';
import { capture } from '../../recipes/__tests__/fixtures.js';
import type { FetchPlan } from '../../recipes/recipe.js';
import type { ReadOptions, RecipeRunner } from '../../recipes/runners.js';
import { createResultsStore, type ResultOption } from '../../results.js';
import type { StoredOffer } from '../../travel.js';
import { SWITCH_RULES } from '../../../admin/switches.js';
import { spokenFirstName } from '../travellers.js';
import {
  createFlightBooking, dayMs, dayOf, FLIGHT_FARE, FLIGHT_STREAM, GRAPH, LOGIN_WAIT_MS, newTravellerSteps, numbersOf, readyCard, SAVED_TRAVELLERS, TRAVELLER_FEMALE,
  TRAVEL_DETAILS, TRAVELLER_FIELDS, TRAVELLER_MALE, travellerAsk, TRAVELLERS_RETRY, detailsAsk, hasFields, ticketWhen,
  type FlightBooking, type TicketPay,
} from '../flight-booking.js';
import { buildOptionsCard, type OptionsCardT } from '../../cards.js';
import { FARE_TYPES } from '../review-read.js';

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
/**
 * saved: how the traveller step's own call for the saved travellers goes: answered (the default), refused by ixigo once
 * then answered, or refused every time. calls: each read of it, in order.
 */
/** fillFails: how many reads that type a new traveller into ixigo's form find no box. */
function fakeRunner(o: { fare?: boolean; tick?: boolean | 'ran_out'; saved?: 'ok' | 'once' | 'never'; intl?: boolean; fillFails?: number } = {}): { runner: RecipeRunner; reads: Read[]; calls: string[] } {
  const reads: Read[] = [];
  const calls: string[] = [];
  let fills = 0;
  const runner: RecipeRunner = {
    name: 'browser_fetch',
    async read(_trip, url, plan, opts) {
      reads.push({ url, plan, o: opts });
      if (url.includes('/search/result/flight')) return { captures: [{ ...capture(FLIGHT_STREAM, 'https://www.ixigo.com/flights/v2/search/stream', STREAM), content_type: 'text/event-stream' }], finalUrl: url };
      if (opts?.private && plan.capture.some((c) => c.match === SAVED_TRAVELLERS)) {
        calls.push(SAVED_TRAVELLERS);
        const refused = o.saved === 'never' || (o.saved === 'once' && calls.length === 1);
        const call = `https://www.ixigo.com${SAVED_TRAVELLERS}?date=${dayMs('06112026')}`;
        // The traveller step's fields call, with its journeyType (an international ticket needs passport details).
        const fields = capture(TRAVELLER_FIELDS, `https://www.ixigo.com${TRAVELLER_FIELDS}?fareKey=x&journeyType=${o.intl ? 'INTERNATIONAL' : 'DOMESTIC'}`, '{"data":{}}');
        return { captures: [refused ? capture(SAVED_TRAVELLERS, call, '{"errors":[{"message":"unauthorized"}]}', 401) : capture(SAVED_TRAVELLERS, call, SAVED), fields], finalUrl: url };
      }
      if (opts?.private && plan.steps?.some((st) => st.op === 'click' && st.near_text === 'First & Middle Name')) {
        fills += 1;
        if (fills <= (o.fillFails ?? 0)) throw new Error('504 timeout at 3 click');
      }
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
  };
  return { runner, reads, calls };
}

const OFFER: StoredOffer = {
  optionId: 'opt_fl1', tripId: 't_goa', cardId: 'c_fl', resultsId: 'r_1', n: 1, offerId: null, kind: 'flight', title: 'IndiGo 6E2150',
  priceMinor: 789_600, totalMinor: null, currency: 'INR', priceNote: 'per person', checkedAt: '2026-10-10T07:00:00.000Z',
  sourceUrl: 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026&returnDate=&adults=4&children=0&infants=0&class=e&source=Search%20Form',
};

function booking(
  runner: RecipeRunner, on = true, ticketPay: TicketPay | null = null,
  more: { results?: ReturnType<typeof createResultsStore>; nameOf?: (tripId: string, personId: string) => Promise<string> } = {},
): FlightBooking {
  void lb.switches.set('BOOKING', on ? 'on' : 'off');
  void lb.switches.set('TRAVEL_MODE', 'ixigo_web');
  return createFlightBooking({
    pool: db.pool, runner: () => runner, link: lb.link, switches: lb.switches, now: lb.brain.now, log: lb.brain.log, pay: () => ticketPay ?? undefined,
    nameOf: more.nameOf ?? (async (_trip, personId) => ({ p_rahul: 'Rahul' } as Record<string, string>)[personId] ?? 'Someone'),
    ...(more.results ? { results: more.results } : {}),
  });
}

// flydubai FZ436+FZ191, prod 11 Oct ("stopped at 1 click", review_not_read): an international review with no Free
// Cancellation radio stopped at the basic fare's click. A live look, 12 Oct: one HYD-DXB review had no such radio, a
// BOM-DXB one had it, named as on a domestic review.
describe("the basic fare declines Free Cancellation only where ixigo offers it", () => {
  it("its radio is looked for, up to 10 s, never needed; Assured's and Flex's radios are", () => {
    expect(FARE_TYPES.basic.click).toEqual({ op: 'click', role: 'radio', text: "I don't want Free Cancellation", optional: true, within_ms: 10_000 });
    expect(FARE_TYPES.assured.click.optional).toBeUndefined();
    expect(FARE_TYPES.flex.click.optional).toBeUndefined();
  });
});

describe("Go books a person's own flight up to ixigo's pay button", () => {
  it('opens the fare on the stage for them alone, picks the fare type, keeps ixigo\'s coupon, and posts their ready card', async () => {
    const { runner, reads, calls } = fakeRunner();
    const b = booking(runner);
    expect(await b.onFor('t_goa')).toBe(true);
    const from = lb.link.requests.length;
    await b.start({ tapId: 'tap_b1', tripId: 't_goa', personId: 'p_meher', name: 'Meher', offer: OFFER, choice: 'basic' });
    await b.settled();
    // 1. ixigo's results for one adult, on the stage, the stream's last event; 2. that flight's review page, on the stage;
    // 4. the same page again in a private tab, twice: its traveller step's own call for the saved travellers, then her
    // saved traveller ticked there.
    expect(reads.map((r) => [new URL(r.url).pathname, r.o?.stage ?? false, r.o?.private ?? false])).toEqual([
      ['/search/result/flight', true, false], ['/flight/booking/1044/tok123', true, false], ['/flight/booking/1044/tok123', false, true], ['/flight/booking/1044/tok123', false, true],
    ]);
    expect(new URL(reads[0]!.url).searchParams.get('adults')).toBe('1');
    expect(reads[0]!.plan.capture).toEqual([{ match: FLIGHT_STREAM, required: true, max_bytes: 4_194_304, sse: 'last' }]);
    expect(new URL(reads[1]!.url).searchParams.get('ftk')).toBe('T-6E2150');
    expect(reads[1]!.plan.steps).toEqual([{ op: 'click', role: 'radio', text: "I don't want Free Cancellation", optional: true, within_ms: 10_000 }]);
    // The account's saved travellers, as ixigo's traveller step asks for them itself (prod, 11 Oct: ixigo turned away Go's
    // own call), and her own ticked by her name there.
    expect(calls).toEqual([SAVED_TRAVELLERS]);
    expect(reads[2]!.plan).toEqual({
      capture: [{ match: SAVED_TRAVELLERS, required: true }, { match: TRAVELLER_FIELDS, required: false }],
      steps: [{ op: 'click', role: 'radio', text: "I don't want Free Cancellation", optional: true, within_ms: 10_000 }, { op: 'click', role: 'button', name: 'Continue' }],
    });
    expect(reads[3]!.plan).toEqual({
      capture: [{ match: TRAVELLER_FIELDS, required: true }],
      steps: [{ op: 'click', role: 'radio', text: "I don't want Free Cancellation", optional: true, within_ms: 10_000 }, { op: 'click', role: 'button', name: 'Continue' }, { op: 'click', text: 'Meher Kapoor' }],
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
    // A traveller the account has saved (Meher), so the booking runs to its end: four reads, the stage's two and the private two.
    // Flex, at ₹9,045 after the coupon, within 5% of the ₹9,000 its card showed.
    const ask = { tapId: 'tap_b2', tripId: 't_goa', personId: 'p_meher6', name: 'Meher', offer: { ...OFFER, priceMinor: 900_000 }, choice: 'flex' as const };
    await b.start(ask);
    await b.start(ask);
    await b.settled();
    expect(reads).toHaveLength(4);
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
    // Picked at ₹6,000 on its card.
    const offer = { ...OFFER, optionId: 'opt_g2', cardId: 'c_g2', resultsId: set.resultsId, priceMinor: 600_000 };
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

  // Keshav, 11 Oct: "why is it asking to add me to Saket's saved traveller… its not mandatory, it can use the details of
  // the traveller and just go ahead".
  it("types a traveller who isn't saved into ixigo's own form from their vault's details, never asks them to be saved, and books on to the pay card", async () => {
    const vaultAsks: unknown[] = [];
    const pay: TicketPay = {
      onPaid: () => undefined,
      travelDetails: async (i) => (vaultAsks.push(i), { firstName: 'Arjun', lastName: 'Varma', gender: 'male', dob: '1990-01-01' }),
    };
    const { runner, reads } = fakeRunner();
    const b = booking(runner, true, pay);
    const from = lb.link.requests.length;
    await b.start({ tapId: 'tap_pf1', tripId: 't_goa', personId: 'p_arjun2', name: 'Arjun', offer: OFFER, choice: 'basic' });
    await b.settled();
    // Two saved Arjuns: neither is surely his, so he is typed in, from his vault, for a ticket of his own.
    expect(vaultAsks).toEqual([{ tripId: 't_goa', personId: 'p_arjun2', booking: { ref: expect.stringMatching(/^fb_/), travellerPersonId: 'p_arjun2', purpose: 'IndiGo 6E2150, for Arjun' } }]);
    expect(reads.at(-1)!.o?.private).toBe(true);
    expect(reads.at(-1)!.plan.steps).toEqual([
      { op: 'click', role: 'radio', text: "I don't want Free Cancellation", optional: true, within_ms: 10_000 }, { op: 'click', role: 'button', name: 'Continue' },
      { op: 'click', role: 'textbox', near_text: 'Adult 1' }, { op: 'click', name: 'Mr', near_text: 'Title' },
      { op: 'click', role: 'textbox', near_text: 'First & Middle Name' }, { op: 'type', text: 'Arjun' },
      { op: 'click', role: 'textbox', near_text: 'Last Name' }, { op: 'type', text: 'Varma' },
    ]);
    expect((await db.pool.query(`select state from flight_bookings where person_id = 'p_arjun2'`)).rows[0]).toEqual({ state: 'ready_to_pay' });
    // Never "add yourself to X's saved travellers", and none of his details reaches a card or a line.
    expect(JSON.stringify(lb.link.requests.slice(from))).not.toMatch(/saved traveller|Varma|1990/);
  });

  it("asks a traveller's gender once, theirs alone, with Male and Female, when no vault has it, and carries on by itself on their tap", async () => {
    const results = createResultsStore(db.pool);
    const flight: ResultOption = { kind: 'flight', title: 'IndiGo 6E2150', priceMinor: 789_600, currency: 'INR', priceNote: 'per person', highlights: [], facts: {}, sourceUrl: OFFER.sourceUrl! };
    const set = await results.save({ tripId: 't_goa', optionKind: 'flight', source: 'search', query: {}, options: [flight], checkedAt: '2026-10-10T07:00:00.000Z' });
    await results.saveCard(
      { cardId: 'c_pf', tripId: 't_goa', resultsId: set.resultsId, title: 'Flights', optionKind: 'flight', card: { card_id: 'c_pf' } as never },
      [{ optionId: 'opt_pf', n: 1, option: flight }], '2026-10-10T07:00:00.000Z',
    );
    const offer = { ...OFFER, optionId: 'opt_pf', cardId: 'c_pf', resultsId: set.resultsId };
    const { runner, reads } = fakeRunner();
    // His name in the trip, as on his ID; no vault details.
    const b = booking(runner, true, null, { results, nameOf: async () => 'Kabir Singh' });
    const from = lb.link.requests.length;
    await b.start({ tapId: 'tap_pf2', tripId: 't_goa', personId: 'p_kabir3', name: 'Kabir Singh', offer, choice: 'basic' });
    await b.settled();
    const asked = lb.link.requests.slice(from).filter((r) => (r.params['card'] as C.Card | undefined)?.kind === 'notice');
    expect(asked.map((r) => r.params['visible_to_person_ids'])).toEqual([['p_kabir3']]);
    const card = C.NoticeCard.parse(asked[0]!.params['card']);
    expect(card).toMatchObject({ for_person_ids: ['p_kabir3'], title: 'Kabir, one detail for your ticket' });
    expect(card.actions?.map((a) => [a.action_id, a.label, a.only_for_person_ids])).toEqual([[TRAVELLER_MALE, 'Male', ['p_kabir3']], [TRAVELLER_FEMALE, 'Female', ['p_kabir3']]]);
    expect((await db.pool.query(`select state, why from flight_bookings where person_id = 'p_kabir3'`)).rows[0]).toEqual({ state: 'failed', why: 'gender_needed' });
    // His tap: kept, and the booking carries on by itself, typed in as Mr Kabir Singh, to his pay card.
    expect(await b.gender({ tripId: 't_goa', cardId: card.card_id, personId: 'p_kabir3', gender: 'male' })).toEqual({ result: 'done', toast: 'Go carries on with your booking' });
    await b.settled();
    expect(reads.at(-1)!.plan.steps?.slice(2)).toEqual(newTravellerSteps({ first: 'Kabir', last: 'Singh', gender: 'male' }));
    expect((await db.pool.query(`select state from flight_bookings where person_id = 'p_kabir3'`)).rows[0]).toEqual({ state: 'ready_to_pay' });
    // Asked once: a second tap finds nothing waiting.
    expect(await b.gender({ tripId: 't_goa', cardId: card.card_id, personId: 'p_kabir3', gender: 'female' })).toEqual({ result: 'refused', toast: 'This booking has moved on' });
  });

  // Prod, 11 Oct (fb_def5s1f6…, fb_xaxfpt62…, fb_57z1hwje…): every newcomer stopped at ixigo's Title, looked for by a
  // name no box has. ixigo's labels are not tied to their boxes (E2): each box is the first textbox after its label.
  it("fills ixigo's Adult 1 form as ixigo draws it: each box clicked by its label's words, then typed into as the focused box", async () => {
    const pay: TicketPay = { onPaid: () => undefined, travelDetails: async () => ({ firstName: 'Meher', lastName: 'Varma', gender: 'female', dob: '1992-02-02' }) };
    const fills = (reads: Read[]) => reads.filter((r) => r.plan.steps?.some((st) => st.op === 'click' && st.near_text === 'First & Middle Name'));
    const ok = fakeRunner();
    const b = booking(ok.runner, true, pay);
    await b.start({ tapId: 'tap_ts1', tripId: 't_goa', personId: 'p_kabir6', name: 'Kabir', offer: OFFER, choice: 'basic' });
    await b.settled();
    // One read: the fare, Continue, then the form, its Title a dropdown and every name typed into the box clicked.
    expect(fills(ok.reads).map((r) => r.plan.steps!.slice(2))).toEqual([[
      { op: 'click', role: 'textbox', near_text: 'Adult 1' },
      { op: 'click', name: 'Ms', near_text: 'Title' },
      { op: 'click', role: 'textbox', near_text: 'First & Middle Name' },
      { op: 'type', text: 'Meher' },
      { op: 'click', role: 'textbox', near_text: 'Last Name' },
      { op: 'type', text: 'Varma' },
    ]]);
    // No type step names a box ixigo never names.
    expect(fills(ok.reads)[0]!.plan.steps!.filter((st) => st.op === 'type').every((st) => !('name' in st) && !('role' in st))).toBe(true);
    expect((await db.pool.query(`select state from flight_bookings where person_id = 'p_kabir6'`)).rows[0]).toEqual({ state: 'ready_to_pay' });
    // A box not found: said, and stopped, nothing submitted.
    const none = fakeRunner({ fillFails: 1 });
    const c = booking(none.runner, true, pay);
    const from = lb.link.requests.length;
    await c.start({ tapId: 'tap_ts2', tripId: 't_goa', personId: 'p_kabir7', name: 'Kabir', offer: OFFER, choice: 'basic' });
    await c.settled();
    expect(fills(none.reads)).toHaveLength(1);
    expect(lb.link.requests.slice(from).filter((r) => r.method === 'post_message' && !r.params['card']).map((r) => r.params['text'])).toEqual([
      "Go couldn't fill your traveller details on ixigo's form, so it stopped before booking IndiGo 6E2150. Tap I'll take this to try again.",
    ]);
    expect((await db.pool.query(`select why from flight_bookings where person_id = 'p_kabir7'`)).rows[0]).toEqual({ why: 'traveller_not_filled' });
  });

  it("stops, saying why, for what Go can't type: an international ticket's passport details, or a last name it doesn't have", async () => {
    const from = lb.link.requests.length;
    const intl = booking(fakeRunner({ intl: true }).runner, true, null, { nameOf: async () => 'Kabir Singh' });
    await intl.start({ tapId: 'tap_pf3', tripId: 't_goa', personId: 'p_kabir4', name: 'Kabir', offer: OFFER, choice: 'basic' });
    await intl.settled();
    const one = booking(fakeRunner().runner, true, null, { nameOf: async () => 'Kabir' });
    await one.start({ tapId: 'tap_pf4', tripId: 't_goa', personId: 'p_kabir5', name: 'Kabir', offer: OFFER, choice: 'basic' });
    await one.settled();
    const said = (person: string) => lb.link.requests.slice(from).filter((r) => r.method === 'post_message' && !r.params['card'] && JSON.stringify(r.params['visible_to_person_ids']) === `["${person}"]`).map((r) => r.params['text']);
    expect(said('p_kabir4')).toEqual(["An international ticket needs passport details on ixigo's form, which Go doesn't fill yet, so it stopped before booking IndiGo 6E2150."]);
    expect(said('p_kabir5')).toEqual([
      "ixigo's traveller form needs your last name as on your ID, and your name in the trip is one word, so Go stopped before booking IndiGo 6E2150. Add your travel details in Go, then tap I'll take this to try again.",
    ]);
    const rows = (await db.pool.query(`select person_id, why from flight_bookings where person_id in ('p_kabir4', 'p_kabir5') order by person_id`)).rows;
    expect(rows).toEqual([{ person_id: 'p_kabir4', why: 'international_traveller' }, { person_id: 'p_kabir5', why: 'traveller_name_needed' }]);
  });

  it('asks for the trip\'s ixigo login before the saved travellers, and waits there for it when there is none', async () => {
    const { runner, calls } = fakeRunner();
    const asked: string[] = [];
    const asks: unknown[] = [];
    const b = createFlightBooking({
      pool: db.pool, runner: () => runner, link: lb.link, switches: lb.switches, now: lb.brain.now, log: lb.brain.log, nameOf: async () => 'Someone',
      // As the real ensure does with for: the trip's login ask is the person booking's (login.ts).
      login: {
        ensure: async (trip, what, o) => {
          asked.push(what);
          asks.push(o);
          await db.pool.query(
            `insert into ixigo_logins (trip_id, person_id, state, attempt, asked_at, updated_at) values ($1, $2, 'asked', 0, now(), now())
             on conflict (trip_id) do update set person_id = excluded.person_id`,
            [trip, o?.for ?? 'p_rahul'],
          );
          return { ok: false, note: 'asked to log in' };
        },
      },
    });
    await b.start({ tapId: 'tap_l1', tripId: 't_goa', personId: 'p_meher5', name: 'Meher', offer: OFFER, choice: 'basic' });
    await b.settled();
    expect(asked).toEqual(['Booking IndiGo 6E2150 for Meher']);
    // Its login card goes to the person booking, first (the lead, 11 Oct: Keshav's booking asked Saket, the organizer).
    expect(asks).toEqual([{ booking: true, for: 'p_meher5' }]);
    // She is told why, on a card for her alone: the login card is hers, and Go carries on by itself once it's in
    // (Keshav, 11 Oct).
    const told = lb.link.requests.filter((r) => (r.params['card'] as { card_id?: string } | undefined)?.card_id?.startsWith('c_book_login'));
    expect(told.map((r) => [r.params['visible_to_person_ids'], (r.params['card'] as { body: string }).body])).toEqual([
      [['p_meher5'], "Your booking needs the trip's ixigo login, which isn't linked yet. Log in on your card and Go carries on with your booking."],
    ]);
    expect(calls).toEqual([]);
    // It waits on the login, with what it carries on with.
    const row = (await db.pool.query(`select state, why, resume, waiting_since from flight_bookings where person_id = 'p_meher5'`)).rows[0];
    expect(row).toMatchObject({ state: 'failed', why: 'login_needed', resume: { tapId: 'tap_l1', name: 'Meher', choice: 'basic' }, waiting_since: expect.any(Date) });
    await db.pool.query("delete from ixigo_logins where trip_id = 't_goa'");
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

  // p2's prod audit (11 Oct, #15): its words said "Booking … for <first last>". Go says first names.
  it("says the traveller's first name in every word of the booking, past a title", async () => {
    expect(['Dr. Meher Kapoor', 'Meher', '  Ankur Sharma ', 'Mr Rahul'].map(spokenFirstName)).toEqual(['Meher', 'Meher', 'Ankur', 'Rahul']);
    const b = booking(fakeRunner().runner);
    const from = lb.link.requests.length;
    await b.start({ tapId: 'tap_fn1', tripId: 't_goa', personId: 'p_meher22', name: 'Dr. Meher Kapoor', offer: OFFER, choice: 'basic' });
    await b.settled();
    const cards = lb.link.requests.slice(from).map((r) => r.params['card'] as { kind?: string; title?: string } | undefined).filter((c) => c !== undefined);
    expect(cards.find((c) => c.kind === 'working')?.title).toBe('Booking IndiGo 6E2150 for Meher');
    expect(cards.find((c) => c.kind === 'notice')?.title).toBe('Ready to pay ₹7,536 for Meher');
    expect(JSON.stringify(lb.link.requests.slice(from))).not.toContain('Kapoor');
  });

  // Keshav's first real booking (prod, 11 Oct 08:28Z): ixigo turned away Go's own call for his saved travellers, the run
  // stopped with nothing said, and Go then told him it couldn't book flights.
  it('says when the saved travellers did not read and reads them once more, booking on when they come', async () => {
    const { runner, calls } = fakeRunner({ saved: 'once' });
    const b = booking(runner);
    const from = lb.link.requests.length;
    expect(await b.start({ tapId: 'tap_sv1', tripId: 't_goa', personId: 'p_meher18', name: 'Meher', offer: OFFER, choice: 'basic' })).toBe('started');
    await b.settled();
    expect(calls).toEqual([SAVED_TRAVELLERS, SAVED_TRAVELLERS]);
    const said = lb.link.requests.slice(from).filter((r) => r.method === 'post_message' && !r.params['card']);
    expect(said.map((r) => [r.params['text'], r.params['visible_to_person_ids']])).toEqual([[TRAVELLERS_RETRY, ['p_meher18']]]);
    expect((await db.pool.query(`select state from flight_bookings where person_id = 'p_meher18'`)).rows[0]).toEqual({ state: 'ready_to_pay' });
  });

  it("stops after the second read fails too, saying what is missing and to tap again, never that Go can't book, and never an ixigo page", async () => {
    const { runner, calls, reads } = fakeRunner({ saved: 'never' });
    const b = booking(runner);
    const from = lb.link.requests.length;
    await b.start({ tapId: 'tap_sv2', tripId: 't_goa', personId: 'p_meher19', name: 'Meher', offer: OFFER, choice: 'basic' });
    await b.settled();
    // Read twice, and nothing ticked: no third private read.
    expect(calls).toEqual([SAVED_TRAVELLERS, SAVED_TRAVELLERS]);
    expect(reads.filter((r) => r.o?.private)).toHaveLength(2);
    const said = lb.link.requests.slice(from).filter((r) => r.method === 'post_message' && r.params['text']);
    expect(said.map((r) => r.params['text'])).toEqual([
      TRAVELLERS_RETRY,
      "Go still couldn't read your saved travellers on ixigo, so it stopped before booking IndiGo 6E2150. Tap I'll take this to try again.",
    ]);
    expect(said.every((r) => JSON.stringify(r.params['visible_to_person_ids']) === '["p_meher19"]')).toBe(true);
    expect(said.every((r) => r.params['card'] === undefined)).toBe(true);
    expect(JSON.stringify(said)).not.toMatch(/can't book|cannot book|on ixigo yourself/i);
    expect((await db.pool.query(`select state, why from flight_bookings where person_id = 'p_meher19'`)).rows[0]).toEqual({ state: 'failed', why: 'travellers_not_read' });
  });

  // Prod, 11 Oct: two taps on the room's card 1.5 s apart ran two bookings for one pick.
  it("starts one booking of a person's at a time: a second tap meanwhile starts nothing, and one after it ends starts again", async () => {
    const { runner, reads } = fakeRunner();
    const b = booking(runner);
    const ask = { tripId: 't_goa', personId: 'p_meher20', name: 'Meher', offer: OFFER, choice: 'basic' as const };
    expect(await b.start({ ...ask, tapId: 'tap_one1' })).toBe('started');
    expect(await b.start({ ...ask, tapId: 'tap_one2' })).toBe('running');
    // The same tap again is the booking it started.
    expect(await b.start({ ...ask, tapId: 'tap_one1' })).toBe('started');
    // Someone else's goes ahead.
    expect(await b.start({ ...ask, personId: 'p_meher21', tapId: 'tap_one3' })).toBe('started');
    await b.settled();
    expect((await db.pool.query(`select run_id from flight_bookings where person_id = 'p_meher20'`)).rows).toHaveLength(1);
    expect(reads.filter((r) => new URL(r.url).pathname === '/search/result/flight')).toHaveLength(2);
    // Done (ready to pay): her next tap books again.
    expect(await b.start({ ...ask, tapId: 'tap_one4' })).toBe('started');
    await b.settled();
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

  // The Server team's demo payment (11 Oct): the Server paid on her tap and wrote the booking, so Go books nothing; her
  // ticket card names the Server's booking, theirs alone, through money's one way on (pay.booked).
  it("takes the Server's own booking when the Server paid it (payment.completed): no add_booking, her ticket card on it", async () => {
    const hook: { paid?: (p: Paid) => Promise<void> } = {};
    const booked: Booked[] = [];
    const pay: TicketPay = {
      requestTicketCard: async () => ({ cardId: 'c_pay_srv', paymentId: 'pay_srv' }),
      onPaid(fn) {
        hook.paid = fn;
      },
      booked: async (b) => void booked.push(b),
    };
    const b = booking(fakeRunner().runner, true, pay, { results: createResultsStore(db.pool) });
    await b.start({ tapId: 'tap_srv', tripId: 't_goa', personId: 'p_meher_srv', name: 'Meher', offer: OFFER, choice: 'basic' });
    await b.settled();
    const row = (await db.pool.query(`select run_id from flight_bookings where person_id = 'p_meher_srv'`)).rows[0];
    const at = new Date('2026-10-10T08:00:00Z');
    await db.pool.query(
      `insert into payments (payment_id, trip_id, decision_id, option_ref, purpose, label, payer_person_id, payer_name, for_person_ids, state, created_at, updated_at, kind, hold_id, approval_id, paid_by)
       values ('pay_srv', 't_goa', null, $1, 'IndiGo 6E2150', 'IndiGo 6E2150', 'p_meher_srv', 'Meher', '{p_meher_srv}', 'paid', $2, $2, 'ticket', $1, 'appr_srv', 'server')`,
      [row.run_id, at],
    );
    const from = lb.link.requests.length;
    await hook.paid!({ tripId: 't_goa', approvalId: 'appr_srv', railRef: 'demo', bookingId: 'bk_server_2' });
    await hook.paid!({ tripId: 't_goa', approvalId: 'appr_srv', railRef: 'demo', bookingId: 'bk_server_2' });
    expect(lb.link.requests.slice(from).filter((r) => r.method === 'add_booking')).toEqual([]);
    expect((await db.pool.query(`select state, approval_id, booking_id from flight_bookings where person_id = 'p_meher_srv'`)).rows[0]).toEqual({
      state: 'paid', approval_id: 'appr_srv', booking_id: 'bk_server_2',
    });
    expect(booked).toEqual([expect.objectContaining({
      tripId: 't_goa', approvalId: 'appr_srv', bookingId: 'bk_server_2', title: 'IndiGo 6E2150', ref: null, personId: 'p_meher_srv',
    })]);
  });

  it("says a ticket's day and times in India's time, or nothing without a journey", () => {
    expect(ticketWhen({ depart_at: '2026-11-06T00:40:00Z', arrive_at: '2026-11-06T03:15:00Z' })).toBe('Fri 6 Nov, 06:10 to 08:45');
    expect(ticketWhen(null)).toBeNull();
  });

  // The G2 drill, 11 Oct: logged out, the booking stopped at its travellers and her card, showing her flight alone with no
  // buttons, left her nothing to tap.
  it("puts the person's own card back as it was when the booking stops before the pay card, and says to pick again on it", async () => {
    const results = createResultsStore(db.pool);
    const flight: ResultOption = { kind: 'flight', title: 'IndiGo 6E2150', priceMinor: 789_600, currency: 'INR', priceNote: 'per person', highlights: [], facts: {}, sourceUrl: OFFER.sourceUrl! };
    const set = await results.save({ tripId: 't_goa', optionKind: 'flight', source: 'search', query: {}, options: [flight], checkedAt: '2026-10-10T07:00:00.000Z' });
    const before = buildOptionsCard({
      cardId: 'c_restore', title: 'Flights for Meher', optionKind: 'flight', checkedAt: '2026-10-10T07:00:00.000Z',
      picks: [{ optionId: 'opt_restore', option: flight, imageUrl: null }], forPersonIds: ['p_meher13'],
    });
    await results.saveCard({ cardId: 'c_restore', tripId: 't_goa', resultsId: set.resultsId, title: before.title, optionKind: 'flight', card: before }, [{ optionId: 'opt_restore', n: 1, option: flight }], '2026-10-10T07:00:00.000Z');
    // What her pick showed: her flight alone, no buttons (taps.ts).
    await results.replaceCard('t_goa', { ...before, actions: [] });
    const from = lb.link.requests.length;
    // ixigo's review didn't load: the run stops before her travellers.
    const b = booking(fakeRunner({ fare: false }).runner, true, null, { results });
    await b.start({ tapId: 'tap_r1', tripId: 't_goa', personId: 'p_meher13', name: 'Meher', offer: { ...OFFER, optionId: 'opt_restore', cardId: 'c_restore' }, choice: 'basic', restore: before });
    await b.settled();
    expect(lb.link.requests.slice(from).filter((r) => r.method === 'replace_card' && (r.params['card'] as { card_id?: string }).card_id === 'c_restore').map((r) => r.params['card'])).toEqual([before]);
    expect((await results.card('t_goa', 'c_restore'))?.card).toEqual(before);
    // The login's note says Go carries on by itself: theirs to log in on, or whose card it is.
    expect(travellerAsk('c_n', { personId: 'p_meher13', name: 'Meher', restore: before }, 'Meher', true).body)
      .toBe("Your booking needs the trip's ixigo login, which isn't linked yet. Log in on your card and Go carries on with your booking.");
    expect(travellerAsk('c_n', { personId: 'p_meher13', name: 'Meher' }, 'Rahul').body)
      .toBe("Your booking needs the trip's ixigo login, which isn't linked yet: Rahul has the Log in to ixigo card. Once it's in, Go carries on with your booking.");
  });

  // Keshav, 11 Oct: "when logged in, automatically continue"; the lead: a login let go, or never in, puts the card back.
  describe('a booking that waits on the trip login', () => {
    // Made in each test: the database is ready only once beforeAll has run.
    const store = () => createResultsStore(db.pool);
    const flight: ResultOption = { kind: 'flight', title: 'IndiGo 6E2150', priceMinor: 789_600, currency: 'INR', priceNote: 'per person', highlights: [], facts: {}, sourceUrl: OFFER.sourceUrl! };
    /** A person's own card of one flight, as their pick left it (their flight alone, no buttons), kept and its offer saved. */
    const ownCard = async (tripId: string, personId: string, cardId: string) => {
      const results = store();
      const set = await results.save({ tripId, optionKind: 'flight', source: 'search', query: {}, options: [flight], checkedAt: '2026-10-10T07:00:00.000Z' });
      const before = buildOptionsCard({
        cardId, title: 'Flights for Meher', optionKind: 'flight', checkedAt: '2026-10-10T07:00:00.000Z', picks: [{ optionId: `${cardId}_1`, option: flight, imageUrl: null }], forPersonIds: [personId],
      });
      await results.saveCard({ cardId, tripId, resultsId: set.resultsId, title: before.title, optionKind: 'flight', card: before }, [{ optionId: `${cardId}_1`, n: 1, option: flight }], '2026-10-10T07:00:00.000Z');
      await results.replaceCard(tripId, { ...before, actions: [] });
      return { before, offer: { ...OFFER, tripId, optionId: `${cardId}_1`, cardId, resultsId: set.resultsId } };
    };
    /** The trip's login, out until `in` is set. */
    const loginOf = () => {
      const s = { in: false };
      return { s, login: { ensure: async () => (s.in ? { ok: true as const } : { ok: false as const, note: 'asked to log in' }) } };
    };
    const make = (login: { ensure: () => Promise<{ ok: true } | { ok: false; note: string }> }) =>
      createFlightBooking({
        pool: db.pool, runner: () => fakeRunner().runner, link: lb.link, switches: lb.switches, now: lb.brain.now, log: lb.brain.log, nameOf: async () => 'Meher', login, results: store(),
      });
    const cardSent = (from: number, cardId: string) => lb.link.requests.slice(from).filter((r) => r.method === 'replace_card' && (r.params['card'] as { card_id?: string }).card_id === cardId);

    it("keeps the pick pending, card and all, and carries on by itself when the login lands, to the end", async () => {
      const { before, offer } = await ownCard('t_wait1', 'p_meher14', 'c_wait1');
      const { s, login } = loginOf();
      const b = make(login);
      const from = lb.link.requests.length;
      await b.start({ tapId: 'tap_w1', tripId: 't_wait1', personId: 'p_meher14', name: 'Meher', offer, choice: 'basic', restore: before });
      await b.settled();
      // Waiting: her card stays as her pick left it.
      expect(cardSent(from, 'c_wait1')).toEqual([]);
      expect((await db.pool.query(`select why from flight_bookings where person_id = 'p_meher14'`)).rows[0]).toEqual({ why: 'login_needed' });
      // The login lands (login.ts onLoggedIn): the booking runs again from the start, to its ready card.
      s.in = true;
      await b.resumeWaiting('t_wait1');
      await b.settled();
      expect((await db.pool.query(`select state from flight_bookings where person_id = 'p_meher14'`)).rows[0]).toEqual({ state: 'ready_to_pay' });
      expect(cardSent(from, 'c_wait1')).toEqual([]);
      // Heard again, nothing runs twice.
      await b.resumeWaiting('t_wait1');
      await b.settled();
      expect((await db.pool.query(`select state from flight_bookings where person_id = 'p_meher14'`)).rows[0]).toEqual({ state: 'ready_to_pay' });
    });

    it('carries on from the sweep when the login landed while nothing heard it; puts the card back for a login let go or never in', async () => {
      const { s, login } = loginOf();
      const b = make(login);
      // Landed while nothing heard it: the login's row says in since the booking stopped.
      const landed = await ownCard('t_wait2', 'p_meher15', 'c_wait2');
      await b.start({ tapId: 'tap_w2', tripId: 't_wait2', personId: 'p_meher15', name: 'Meher', offer: landed.offer, choice: 'basic', restore: landed.before });
      await b.settled();
      s.in = true;
      const at = new Date(Date.now() + 60_000);
      await db.pool.query(`insert into ixigo_logins (trip_id, person_id, state, asked_at, logged_in_at, checked_at, updated_at) values ('t_wait2', 'p_meher15', 'logged_in', $1, $1, $1, $1)`, [at]);
      await b.sweep();
      await b.settled();
      expect((await db.pool.query(`select state from flight_bookings where person_id = 'p_meher15'`)).rows[0]).toEqual({ state: 'ready_to_pay' });
      // Let go (Not now): her card is back as it was, to pick again.
      s.in = false;
      const skipped = await ownCard('t_wait3', 'p_meher16', 'c_wait3');
      await b.start({ tapId: 'tap_w3', tripId: 't_wait3', personId: 'p_meher16', name: 'Meher', offer: skipped.offer, choice: 'basic', restore: skipped.before });
      await b.settled();
      await db.pool.query(`insert into ixigo_logins (trip_id, person_id, state, asked_at) values ('t_wait3', 'p_meher16', 'skipped', now())`);
      // Never in: past LOGIN_WAIT_MS, the same.
      const never = await ownCard('t_wait4', 'p_meher17', 'c_wait4');
      await b.start({ tapId: 'tap_w4', tripId: 't_wait4', personId: 'p_meher17', name: 'Meher', offer: never.offer, choice: 'basic', restore: never.before });
      await b.settled();
      await db.pool.query(`update flight_bookings set waiting_since = waiting_since - make_interval(secs => $1) where person_id = 'p_meher17'`, [LOGIN_WAIT_MS / 1000 + 1]);
      const from = lb.link.requests.length;
      await b.sweep();
      expect(cardSent(from, 'c_wait3').map((r) => r.params['card'])).toEqual([skipped.before]);
      expect(cardSent(from, 'c_wait4').map((r) => r.params['card'])).toEqual([never.before]);
      expect((await store().card('t_wait4', 'c_wait4'))?.card).toEqual(never.before);
      const rows = (await db.pool.query(`select person_id, why from flight_bookings where person_id in ('p_meher16', 'p_meher17') order by person_id`)).rows;
      expect(rows).toEqual([{ person_id: 'p_meher16', why: 'login_let_go' }, { person_id: 'p_meher17', why: 'login_let_go' }]);
      // Swept again, nothing is put back twice.
      const from2 = lb.link.requests.length;
      await b.sweep();
      expect(cardSent(from2, 'c_wait3')).toEqual([]);
    });
  });

  // Keshav, 11 Oct: an ixigo page is never the answer; pay is always through the vault.
  it("never sends them to ixigo when the vault can't take it: why, in the vault's words, and the pick kept; any other no is said, theirs alone", async () => {
    const refusing = (code: string, say = false): TicketPay => ({ requestTicketCard: async () => ({ refused: 'The test rail is not ready.', code, say }), onPaid: () => undefined });
    const from = lb.link.requests.length;
    const b = booking(fakeRunner().runner, true, refusing('rail_not_ready'));
    await b.start({ tapId: 'tap_t2', tripId: 't_goa', personId: 'p_meher11', name: 'Meher', offer: OFFER, choice: 'basic' });
    await b.settled();
    const vaultSaid = lb.link.requests.slice(from).filter((r) => r.method === 'post_message' && String(r.params['text'] ?? '').startsWith('The test rail is not ready.'));
    expect(vaultSaid).toHaveLength(1);
    expect(vaultSaid[0]!.params).toMatchObject({
      text: "The test rail is not ready. Your pick is kept: tap I'll take this on your flights card to pay once it goes through.", visible_to_person_ids: ['p_meher11'],
    });
    expect(vaultSaid[0]!.params['card']).toBeUndefined();
    // No ixigo link card at all.
    expect(lb.link.requests.slice(from).some((r) => /ixigo\.com/.test(JSON.stringify((r.params['card'] as { source?: unknown } | undefined)?.source ?? '')))).toBe(false);
    expect((await db.pool.query(`select state, why from flight_bookings where person_id = 'p_meher11'`)).rows[0]).toEqual({ state: 'failed', why: 'pay_rail_not_ready' });
    const from2 = lb.link.requests.length;
    const c = booking(fakeRunner().runner, true, refusing('not_in_trip'));
    await c.start({ tapId: 'tap_t3', tripId: 't_goa', personId: 'p_meher12', name: 'Meher', offer: OFFER, choice: 'basic' });
    await c.settled();
    const said = lb.link.requests.slice(from2).filter((r) => r.method === 'post_message' && !r.params['card']);
    expect(said.map((r) => [r.params['text'], r.params['visible_to_person_ids']])).toEqual([['The test rail is not ready.', ['p_meher12']]]);
    // A no money marks to be said is said too: money never says a ticket's no itself (prod, 11 Oct: Saket heard nothing).
    const from3 = lb.link.requests.length;
    const e = booking(fakeRunner().runner, true, refusing('already_booked', true));
    await e.start({ tapId: 'tap_t4', tripId: 't_goa', personId: 'p_meher14x', name: 'Meher', offer: OFFER, choice: 'basic' });
    await e.settled();
    const told = lb.link.requests.slice(from3).filter((r) => r.method === 'post_message' && !r.params['card']);
    expect(told.map((r) => [r.params['text'], r.params['visible_to_person_ids']])).toEqual([['The test rail is not ready.', ['p_meher14x']]]);
  });

  // Prod, 11 Oct: Saket typed "book my flight"; Go booked his pick from 14:49 and the Server answered no_pick (its 30-minute
  // rule), then Go said nothing. A stale pick is never a dead end: "I'll take this" comes back, and one line asks for the tap.
  it("answers a stale pick (no_pick) with I'll take this back on their card and one line asking for the tap, never a failure", async () => {
    const results = createResultsStore(db.pool);
    // The flight the fake ixigo's fare page has (Saket's was Alliance Air 9I547).
    const flight: ResultOption = { kind: 'flight', title: 'IndiGo 6E2150', priceMinor: 789_600, currency: 'INR', priceNote: 'per person', highlights: [], facts: {}, sourceUrl: OFFER.sourceUrl! };
    const set = await results.save({ tripId: 't_goa', optionKind: 'flight', source: 'search', query: {}, options: [flight], checkedAt: '2026-10-10T07:00:00.000Z' });
    const before = buildOptionsCard({
      cardId: 'c_stale', title: 'Flights for Saket', optionKind: 'flight', checkedAt: '2026-10-10T07:00:00.000Z',
      picks: [{ optionId: 'opt_stale', option: flight, imageUrl: null }], forPersonIds: ['p_saket'],
    });
    await results.saveCard({ cardId: 'c_stale', tripId: 't_goa', resultsId: set.resultsId, title: before.title, optionKind: 'flight', card: before }, [{ optionId: 'opt_stale', n: 1, option: flight }], '2026-10-10T07:00:00.000Z');
    // What his tap at 14:49 left: his flight alone, no buttons.
    await results.replaceCard('t_goa', { ...before, actions: [] });
    const stale: TicketPay = {
      requestTicketCard: async () => ({ refused: 'Saket, pick Alliance Air 9I547 again on your card: it has been a while, or the price moved. Nothing was charged.', code: 'no_pick', say: true }),
      onPaid: () => undefined,
    };
    const offer = { ...OFFER, optionId: 'opt_stale', cardId: 'c_stale' };
    // Asked in words (book_flight): no card kept with the booking, so his own card gets the flight with its button back.
    const from = lb.link.requests.length;
    const b = booking(fakeRunner().runner, true, stale, { results });
    // Meher: the name on the trip account's saved travellers, so the run reaches its pay step.
    await b.start({ tapId: 'words_t1', tripId: 't_goa', personId: 'p_saket', name: 'Meher Varma', offer, choice: 'basic' });
    await b.settled();
    const sent = lb.link.requests.slice(from);
    const back = sent.filter((r) => r.method === 'replace_card' && (r.params['card'] as { card_id?: string }).card_id === 'c_stale').map((r) => r.params['card'] as OptionsCardT);
    expect(back).toHaveLength(1);
    expect(back[0]!.options.map((o) => o.option_id)).toEqual(['opt_stale']);
    expect(back[0]!.actions).toEqual([{ action_id: 'pick', label: "I'll take this", style: 'primary', per_option: true, only_for_person_ids: ['p_saket'] }]);
    expect((await results.card('t_goa', 'c_stale'))?.card.actions).toEqual(back[0]!.actions);
    const lines = sent.filter((r) => r.method === 'post_message' && !r.params['card']);
    expect(lines.map((r) => [r.params['text'], r.params['visible_to_person_ids']])).toEqual([["Meher, tap I'll take this on IndiGo 6E2150 and I'll book it.", ['p_saket']]]);
    expect((await db.pool.query(`select state, why from flight_bookings where person_id = 'p_saket'`)).rows[0]).toEqual({ state: 'failed', why: 'pay_no_pick' });
    // From a tap whose booking kept his card as it was: that card comes back, every option and its buttons.
    const from2 = lb.link.requests.length;
    const c = booking(fakeRunner().runner, true, stale, { results });
    await c.start({ tapId: 'tap_stale2', tripId: 't_goa', personId: 'p_saket2', name: 'Meher', offer, choice: 'basic', restore: before });
    await c.settled();
    expect(lb.link.requests.slice(from2).filter((r) => r.method === 'replace_card' && (r.params['card'] as { card_id?: string }).card_id === 'c_stale').map((r) => r.params['card'])).toEqual([before]);
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

// Keshav, 11 Oct: "trains and buses are crying to get booked like flights". p0's T1 drill found the way in: the day's
// results page, a row's SHOW AVAILABILITY, the class's tile, the day's BOOK, behind ixigo's login.
describe("Go books a person's own train up to ixigo's pay button, as a flight", () => {
  const MANDOVI = 'https://www.ixigo.com/trains/10103?orgn=CSMT&dstn=MAO&departDate=2026-11-06&quota=GN';
  const RESULTS = 'https://www.ixigo.com/search/result/train/CSMT/MAO/06112026//1/0/0/0/SL';
  const seats = (status: string, p = 0) => JSON.stringify({ data: { routesData: [{ trainCode: '10103', availabilities: [{ c: 'SL', q: 'GN', a: status, p, f: 410 }] }] } });
  const AVAIL = 'https://www.ixigo.com/api/v3/trains/availability?originCode=CSMT&destinationCode=MAO&travelDate=06112026';

  /** The day's results page: its seats call on the stage and in the private tab; fill: whether the passenger form fills. */
  function trainRunner(o: { status?: string; chance?: number; seats?: boolean; fill?: boolean } = {}): { runner: RecipeRunner; reads: Read[] } {
    const reads: Read[] = [];
    const runner: RecipeRunner = {
      name: 'browser_fetch',
      async read(_trip, url, plan, opts) {
        reads.push({ url, plan, o: opts });
        if (opts?.private && o.fill === false) throw new Error('504 timeout at 4 type');
        return { captures: o.seats === false ? [] : [capture('/api/v3/trains/availability', AVAIL, seats(o.status ?? 'AVAILABLE 34', o.chance ?? 0))], finalUrl: url };
      },
    };
    return { runner, reads };
  }

  /** Meher's own Mandovi, SL, picked on her card at ₹410. */
  async function trainOffer(optionId: string) {
    const results = createResultsStore(db.pool);
    const train: ResultOption = {
      kind: 'train', title: 'Mandovi Express 10103', priceMinor: 41_000, currency: 'INR', priceNote: 'per person', highlights: [], facts: { class_code: 'SL', availability: 'AVAILABLE 34' }, sourceUrl: MANDOVI,
    };
    const set = await results.save({ tripId: 't_goa', optionKind: 'train', source: 'search', query: {}, options: [train], checkedAt: '2026-10-10T07:00:00.000Z' });
    await results.saveCard({ cardId: `c_${optionId}`, tripId: 't_goa', resultsId: set.resultsId, title: 'Trains', optionKind: 'train', card: { card_id: `c_${optionId}` } as never }, [{ optionId, n: 1, option: train }], '2026-10-10T07:00:00.000Z');
    const offer: StoredOffer = { ...OFFER, optionId, cardId: `c_${optionId}`, resultsId: set.resultsId, kind: 'train', title: 'Mandovi Express 10103', priceMinor: 41_000, sourceUrl: MANDOVI };
    return { results, offer };
  }

  const VAULT = { firstName: 'Meher', lastName: 'Varma', gender: 'female' as const, dob: '1994-11-07', irctcUserId: 'meher_irctc' };

  it('reads its seats on the stage, types its passenger from the vault privately, says a waitlist before pay, and books on to the pay card', async () => {
    const { results, offer } = await trainOffer('opt_tr1');
    const vaultAsks: unknown[] = [];
    const pay: TicketPay = { onPaid: () => undefined, travelDetails: async (i) => (vaultAsks.push(i), VAULT) };
    const { runner, reads } = trainRunner({ status: 'GNWL 12', chance: 47 });
    const b = booking(runner, true, pay, { results });
    const from = lb.link.requests.length;
    expect(await b.start({ tapId: 'tap_tr1', tripId: 't_goa', personId: 'p_meher30', name: 'Meher', offer, choice: 'basic' })).toBe('started');
    await b.settled();
    // 1. The day's results for its class, on the stage, its seats call required.
    expect(reads[0]).toMatchObject({ url: RESULTS, o: { stage: true }, plan: { capture: [{ match: '/api/v3/trains/availability', required: true }] } });
    // 2. Privately: the row's SHOW AVAILABILITY by its train, the class's tile, the day's BOOK, then her passenger.
    expect(reads[1]!.o?.private).toBe(true);
    expect(reads[1]!.plan.steps).toEqual([
      { op: 'click', name: 'SHOW AVAILABILITY', near_text: '10103' },
      { op: 'click', text: 'SL', near_text: ['10103', 'HIDE AVAILABILITY'] },
      { op: 'click', role: 'button', name: 'BOOK', near_text: 'Fri, 06 Nov' },
      { op: 'type', role: 'textbox', name: 'Name', text: 'Meher Varma' },
      { op: 'type', role: 'textbox', name: 'Age', text: '31' },
      { op: 'type', role: 'combobox', name: 'Gender', text: 'Female' },
      { op: 'type', role: 'textbox', name: 'IRCTC Username', text: 'meher_irctc' },
    ]);
    expect(vaultAsks).toEqual([{ tripId: 't_goa', personId: 'p_meher30', booking: { ref: expect.stringMatching(/^fb_/), travellerPersonId: 'p_meher30', purpose: 'Mandovi Express 10103 (SL), Fri, 06 Nov, for Meher' } }]);
    // The waitlist, said plainly before she pays, hers alone; then her ready card.
    const said = lb.link.requests.slice(from).filter((r) => r.method === 'post_message' && !r.params['card']).map((r) => [r.params['text'], r.params['visible_to_person_ids']]);
    expect(said).toEqual([[
      "Before you pay for Mandovi Express 10103 (SL): It's waitlisted (GNWL 12); ixigo gives it a 47% chance to confirm: a waitlisted ticket that doesn't confirm by the chart is cancelled and refunded.",
      ['p_meher30'],
    ]]);
    expect((await db.pool.query(`select state, total_minor from flight_bookings where person_id = 'p_meher30'`)).rows[0]).toEqual({ state: 'ready_to_pay', total_minor: '41000' });
    // None of her details reaches a card or a line.
    expect(JSON.stringify(lb.link.requests.slice(from))).not.toMatch(/Varma|meher_irctc|1994/);
  });

  it('asks once, one tap, for the age and IRCTC user ID its form needs, opening the vault\'s own form, and carries on by itself once they\'re there', async () => {
    const { results, offer } = await trainOffer('opt_tr2');
    let kept: typeof VAULT | null = null;
    const links: string[] = [];
    const pay: TicketPay = {
      onPaid: () => undefined,
      travelDetails: async () => kept,
      travelLink: async (personId, fields) => (links.push(`${personId}:${(fields ?? []).join(',')}`), { url: 'https://vault.example/travel?t=1', expiresAt: '2026-10-11T12:00:00.000Z' }),
    };
    const { runner } = trainRunner();
    const b = booking(runner, true, pay, { results });
    const from = lb.link.requests.length;
    await b.start({ tapId: 'tap_tr2', tripId: 't_goa', personId: 'p_meher31', name: 'Meher', offer, choice: 'basic' });
    await b.settled();
    const asked = lb.link.requests.slice(from).filter((r) => (r.params['card'] as C.Card | undefined)?.kind === 'notice');
    expect(asked.map((r) => r.params['visible_to_person_ids'])).toEqual([['p_meher31']]);
    const card = C.NoticeCard.parse(asked[0]!.params['card']);
    expect(card).toMatchObject({
      for_person_ids: ['p_meher31'], title: 'Meher, one step for your train',
      body: 'Your train needs your age and IRCTC user ID: add them once (30 s), and Go carries on with your booking.',
    });
    expect(card.actions?.map((a) => [a.action_id, a.label, a.only_for_person_ids])).toEqual([[TRAVEL_DETAILS, 'Add them', ['p_meher31']]]);
    expect((await db.pool.query(`select state, why from flight_bookings where person_id = 'p_meher31'`)).rows[0]).toEqual({ state: 'failed', why: 'details_needed' });
    // Her tap: the vault's own travel form, hers alone, showing exactly what it needs (#485's fields); someone else's, nothing.
    expect(await b.detailsLink({ tripId: 't_goa', cardId: card.card_id, personId: 'p_meher31' })).toEqual({ result: 'open', url: 'https://vault.example/travel?t=1', expires_at: '2026-10-11T12:00:00.000Z' });
    expect(links).toEqual(['p_meher31:dob,irctc_user_id']);
    expect(await b.detailsLink({ tripId: 't_goa', cardId: card.card_id, personId: 'p_kabir' })).toEqual({ result: 'refused', toast: 'This booking has moved on' });
    // Not in yet: the sweep waits. Once they are, it carries on by itself to her pay card.
    await b.sweep();
    expect((await db.pool.query(`select why from flight_bookings where person_id = 'p_meher31'`)).rows[0]).toEqual({ why: 'details_needed' });
    kept = VAULT;
    await b.sweep();
    await b.settled();
    expect((await db.pool.query(`select state from flight_bookings where person_id = 'p_meher31'`)).rows[0]).toEqual({ state: 'ready_to_pay' });
  });

  // p5's buses (11 Oct) ask through the same card and wait on the same sweep.
  it("words its one ask by what it needs and the ticket's kind, a bus's age alone too, and knows when the vault has every one", () => {
    expect(detailsAsk('c_d', 'p_x', 'Ravi', ['dob'], 'bus')).toMatchObject({
      title: 'Ravi, one step for your bus', body: 'Your bus needs your age: add it once (30 s), and Go carries on with your booking.',
      actions: [{ action_id: TRAVEL_DETAILS, label: 'Add it', only_for_person_ids: ['p_x'] }],
    });
    expect(hasFields(VAULT, ['dob', 'irctc_user_id'])).toBe(true);
    const { irctcUserId: _none, ...noIrctc } = VAULT;
    expect(hasFields(noIrctc, ['dob', 'irctc_user_id'])).toBe(false);
    expect(hasFields(noIrctc, ['dob'])).toBe(true);
    expect(hasFields(null, ['dob'])).toBe(false);
  });

  it("stops, saying so, when its seats don't read, or its passenger form doesn't fill, and puts their card back", async () => {
    const pay: TicketPay = { onPaid: () => undefined, travelDetails: async () => VAULT };
    const from = lb.link.requests.length;
    const one = await trainOffer('opt_tr3');
    const a = booking(trainRunner({ seats: false }).runner, true, pay, { results: one.results });
    await a.start({ tapId: 'tap_tr3', tripId: 't_goa', personId: 'p_meher32', name: 'Meher', offer: one.offer, choice: 'basic' });
    await a.settled();
    const two = await trainOffer('opt_tr4');
    const b = booking(trainRunner({ fill: false }).runner, true, pay, { results: two.results });
    await b.start({ tapId: 'tap_tr4', tripId: 't_goa', personId: 'p_meher33', name: 'Meher', offer: two.offer, choice: 'basic' });
    await b.settled();
    const said = (person: string) => lb.link.requests.slice(from).filter((r) => r.method === 'post_message' && !r.params['card'] && JSON.stringify(r.params['visible_to_person_ids']) === `["${person}"]`).map((r) => r.params['text']);
    expect(said('p_meher32')).toEqual(["Go couldn't read the seats on Mandovi Express 10103 just now, so it stopped before booking it. Tap I'll take this to try again."]);
    expect(said('p_meher33')).toEqual(["Go couldn't fill your passenger details on ixigo's form, so it stopped before booking Mandovi Express 10103. Tap I'll take this to try again."]);
    const rows = (await db.pool.query(`select person_id, why from flight_bookings where person_id in ('p_meher32', 'p_meher33') order by person_id`)).rows;
    expect(rows).toEqual([{ person_id: 'p_meher32', why: 'seats_not_read' }, { person_id: 'p_meher33', why: 'passengers_not_filled' }]);
  });
});
