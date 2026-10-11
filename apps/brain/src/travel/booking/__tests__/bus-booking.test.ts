import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../../db/test-db.js';
import type { Booked, Paid } from '../../../money/pay.js';
import { makeLaneBrain, type LaneBrain } from '../../../tasks/testing/lane-brain.js';
import { capture, fixture } from '../../recipes/__tests__/fixtures.js';
import type { FetchPlan } from '../../recipes/recipe.js';
import type { ReadOptions, RecipeRunner } from '../../recipes/runners.js';
import { createResultsStore, type ResultOption } from '../../results.js';
import type { StoredOffer } from '../../travel.js';
import { ageOn, busOf, createBusBooking, SEAT_LAYOUT, type BusBooking } from '../bus-booking.js';
import { TRAVEL_DETAILS, type TicketPay } from '../flight-booking.js';

let db: Awaited<ReturnType<typeof withSchema>>;
let lb: LaneBrain;
beforeAll(async () => {
  db = await withSchema();
  lb = makeLaneBrain({ pool: db.pool });
});
afterAll(async () => {
  await db.drop();
});

// p5's drill, 11 Oct: IntrCity SmartBus 22:35, Bengaluru to Goa on 6 Nov, its seat layout as "Select Seats" opened it.
const LAYOUT = fixture('bus-seat-layout-blr-goa.json');
const OFFER: StoredOffer = {
  optionId: 'opt_bus1', tripId: 't_bus', cardId: 'c_bus', resultsId: 'r_bus', n: 1, offerId: null, kind: 'bus', title: 'IntrCity SmartBus 22:35',
  priceMinor: 385_800, totalMinor: null, currency: 'INR', priceNote: 'per seat', checkedAt: '2026-10-11T07:00:00.000Z',
  sourceUrl: 'https://www.ixigo.com/buses/bus_search/Bengaluru/7/Goa/102/06-11-2026/O#IntrCity%20SmartBus@22:35',
};
// Made-up details, as the vault keeps them: typed only into ixigo's form.
const DETAILS = { firstName: 'Meher', lastName: 'Zainab', gender: 'female' as const, dob: '1996-11-20' };

type Read = { url: string; plan: FetchPlan; o: ReadOptions | undefined };
function fakeRunner(o: { fill?: boolean } = {}): { runner: RecipeRunner; reads: Read[] } {
  const reads: Read[] = [];
  const runner: RecipeRunner = {
    name: 'browser_fetch',
    async read(_trip, url, plan, opts) {
      reads.push({ url, plan, o: opts });
      if (opts?.private && o.fill === false) throw new Error('504 timeout at 3 click');
      return { captures: [capture(SEAT_LAYOUT, 'https://www.ixigo.com/wap/GetSeatLayout', LAYOUT)], finalUrl: url };
    },
  };
  return { runner, reads };
}

function money(o: { details?: boolean } = {}) {
  const kept = { details: o.details !== false };
  const cards: Array<Record<string, unknown>> = [];
  const links: Array<{ personId: string; fields: unknown }> = [];
  const booked: Booked[] = [];
  let paid: ((p: Paid) => Promise<void>) | null = null;
  const pay: TicketPay = {
    async requestTicketCard(_trip, req) {
      cards.push(req);
      return { cardId: `c_pay_${req.key}`, paymentId: `pay_${req.key}` };
    },
    onPaid: (fn) => {
      paid = fn;
    },
    booked: async (b) => void booked.push(b),
    travelDetails: async () => (kept.details ? DETAILS : null),
    travelLink: async (personId, fields) => {
      links.push({ personId, fields });
      return { url: 'https://vault.test/l/travel', expiresAt: '2026-10-11T08:00:00.000Z' };
    },
  };
  return { pay, cards, paid: () => paid, kept, links, booked };
}

function booking(runner: RecipeRunner, pay: TicketPay | null, on = true, more: { name?: string; results?: ReturnType<typeof createResultsStore> } = {}): BusBooking {
  void lb.switches.set('BOOKING', on ? 'on' : 'off');
  void lb.switches.set('TRAVEL_MODE', 'ixigo_web');
  return createBusBooking({
    pool: db.pool, runner: () => runner, link: lb.link, switches: lb.switches, now: lb.brain.now, log: lb.brain.log, pay: () => pay ?? undefined,
    nameOf: async () => more.name ?? 'Meher',
    ...(more.results ? { results: more.results } : {}),
  });
}

describe("a bus's address and a passenger's age", () => {
  it("reads the results page, the operator and the time from the card's address", () => {
    expect(busOf(OFFER.sourceUrl)).toEqual({ page: 'https://www.ixigo.com/buses/bus_search/Bengaluru/7/Goa/102/06-11-2026/O', operator: 'IntrCity SmartBus', departs: '22:35', day: '2026-11-06' });
    expect(busOf('https://www.ixigo.com/buses/bus_search/x')).toBeNull();
  });

  it('counts their age on the day the bus leaves', () => {
    expect(ageOn('1996-11-20', '2026-11-06')).toBe(29);
    expect(ageOn('1996-11-06', '2026-11-06')).toBe(30);
    expect(ageOn('not a day', '2026-11-06')).toBeNull();
  });
});

describe("Go books a person's own bus up to ixigo's pay button", () => {
  it('reads the seat map on the stage, chooses the seat and stops in code, fills the passenger privately, and asks for their pay card', async () => {
    const { runner, reads } = fakeRunner();
    const m = money();
    const b = booking(runner, m.pay);
    expect(await b.onFor('t_bus')).toBe(true);
    const from = lb.link.requests.length;
    await b.start({ tapId: 'tap_bus1', tripId: 't_bus', personId: 'p_meher', name: 'Meher Zainab', offer: OFFER });
    await b.settled();
    // 1. The bus on the stage, its own Select Seats; 2. the seat, the stops and the passenger in a private tab.
    expect(reads.map((r) => [r.url, r.o?.stage ?? false, r.o?.private ?? false])).toEqual([
      ['https://www.ixigo.com/buses/bus_search/Bengaluru/7/Goa/102/06-11-2026/O', true, false],
      ['https://www.ixigo.com/buses/bus_search/Bengaluru/7/Goa/102/06-11-2026/O', false, true],
    ]);
    expect(reads[0]!.plan.steps).toContainEqual({ op: 'click', role: 'button', name: 'Select Seats', near_text: ['IntrCity SmartBus', '22:35'] });
    // The private tab opens the bus's seat map again, then its seat (6LC: the fifth ₹3858 text, the page holding each deck
    // from its last row up, the upper deck first), the stops, Proceed, and the passenger.
    expect(reads[1]!.plan.steps).toEqual(expect.arrayContaining([
      { op: 'click', role: 'button', name: 'Select Seats', near_text: ['IntrCity SmartBus', '22:35'] },
      { op: 'click', role: 'StaticText', name: '₹3858', nth: 5 },
      { op: 'click', role: 'radio', nth: 1 },
      { op: 'click', role: 'button', name: 'Proceed' },
    ]));
    // Her details only in ixigo's form, in the private tab.
    expect(JSON.stringify(reads[1]!.plan.steps)).toContain('Meher Zainab');
    const sent = lb.link.requests.slice(from);
    expect(JSON.stringify(sent)).not.toMatch(/Zainab|1996/);
    // Her live card, for her alone, says the seat and the stops; the cheapest free seat, by a window.
    const live = sent.filter((r) => (r.params['card'] as { kind?: string } | undefined)?.kind === 'working').at(-1)!.params['card'] as { title: string; state: string; steps: Array<{ text: string; state: string }> };
    expect(live).toMatchObject({ title: 'Booking IntrCity SmartBus 22:35 for Meher', state: 'done' });
    expect(live.steps[1]!.text).toBe('seat 6LC (lower berth by the window), boarding at Chandapura 07:45 PM');
    expect(sent.filter((r) => r.method === 'post_message').every((r) => JSON.stringify(r.params['visible_to_person_ids']) === '["p_meher"]')).toBe(true);
    // Money's pay card for her pick: the seat's fare, for the card and the option she tapped.
    expect(m.cards).toEqual([expect.objectContaining({ personId: 'p_meher', cardId: 'c_bus', optionId: 'opt_bus1', amountMinor: 385_800, currency: 'INR', key: expect.any(String), trigger: 'tap_bus1' })]);
    expect(String(m.cards[0]!['purpose'])).toMatch(/^IntrCity SmartBus 22:35, Fri 6 Nov, seat 6LC .* for Meher$/);
    const row = (await db.pool.query(`select state, seats, board_id, drop_id, total_minor from bus_bookings where person_id = 'p_meher'`)).rows[0];
    expect(row).toEqual({ state: 'ready_to_pay', seats: ['6LC'], board_id: '14531', drop_id: '6691', total_minor: '385800' });
  });

  it("seats the next person on the same bus beside the trip's first, never in a seat it took", async () => {
    const { runner } = fakeRunner();
    const b = booking(runner, money().pay);
    await b.start({ tapId: 'tap_bus2', tripId: 't_bus', personId: 'p_arjun', name: 'Arjun', offer: OFFER });
    await b.settled();
    const row = (await db.pool.query(`select seats from bus_bookings where person_id = 'p_arjun'`)).rows[0];
    expect(row?.seats).toEqual(['6LB']);
  });

  // The lead, 11 Oct: never "add them" and stop, and one ask beats two: their date of birth and gender in one card (the
  // one ask p0's trains use), its Add it opening their vault's form at just those, and the booking carries on by itself.
  it('with no vault details: one ask for their date of birth and gender, Add it opens their vault at those, then it carries on by itself', async () => {
    const m = money({ details: false });
    // The bus on its card, as the person picked it: a booking that waited reads its offer again from there.
    const results = createResultsStore(db.pool);
    const bus: ResultOption = { kind: 'bus', title: OFFER.title, priceMinor: 385_800, currency: 'INR', priceNote: 'per seat', highlights: [], facts: {}, sourceUrl: OFFER.sourceUrl! };
    const set = await results.save({ tripId: 't_bus', optionKind: 'bus', source: 'search', query: {}, options: [bus], checkedAt: '2026-10-11T07:00:00.000Z' });
    await results.saveCard({ cardId: 'c_bus', tripId: 't_bus', resultsId: set.resultsId, title: 'Buses', optionKind: 'bus', card: { card_id: 'c_bus' } as never }, [{ optionId: 'opt_bus1', n: 1, option: bus }], '2026-10-11T07:00:00.000Z');
    const b = booking(fakeRunner().runner, m.pay, true, { name: 'Kabir Shah', results });
    const from = lb.link.requests.length;
    await b.start({ tapId: 'tap_bus3', tripId: 't_bus', personId: 'p_kabir', name: 'Kabir Shah', offer: OFFER });
    await b.settled();
    // 1. One card, theirs alone: their date of birth and gender, no separate gender card.
    const posted = lb.link.requests.slice(from).filter((r) => r.method === 'post_message' && (r.params['card'] as { kind?: string } | undefined)?.kind === 'notice');
    expect(posted).toHaveLength(1);
    const ask = posted[0]!;
    expect(ask.params['visible_to_person_ids']).toEqual(['p_kabir']);
    expect(ask.params['card']).toMatchObject({ for_person_ids: ['p_kabir'], actions: [{ action_id: TRAVEL_DETAILS, only_for_person_ids: ['p_kabir'] }] });
    expect((await db.pool.query(`select why from bus_bookings where person_id = 'p_kabir'`)).rows[0]).toEqual({ why: 'details_needed' });
    // 2. Add it: their vault's form at exactly what the booking waits on.
    expect(await b.detailsLink({ tripId: 't_bus', cardId: 'c_nope', personId: 'p_kabir' })).toEqual({ result: 'refused', toast: 'This booking has moved on' });
    const cardId = String((ask.params['card'] as { card_id: string }).card_id);
    expect(await b.detailsLink({ tripId: 't_bus', cardId, personId: 'p_kabir' })).toEqual({ result: 'open', url: 'https://vault.test/l/travel', expires_at: '2026-10-11T08:00:00.000Z' });
    expect(m.links).toEqual([{ personId: 'p_kabir', fields: ['dob', 'gender'] }]);
    // 3. Not kept yet: it waits. Kept: the sweep carries the booking on to their pay card.
    await b.sweep();
    expect((await db.pool.query(`select why from bus_bookings where person_id = 'p_kabir'`)).rows[0]).toEqual({ why: 'details_needed' });
    m.kept.details = true;
    await b.sweep();
    await b.settled();
    expect((await db.pool.query(`select state from bus_bookings where person_id = 'p_kabir'`)).rows[0]).toEqual({ state: 'ready_to_pay' });
    expect(m.cards.map((c) => c['personId'])).toEqual(['p_kabir']);
  });

  it('stops and says so when the cheapest free seat is more than 5% over the price they picked', async () => {
    const c = booking(fakeRunner().runner, money().pay);
    await c.start({ tapId: 'tap_bus4', tripId: 't_bus', personId: 'p_priya', name: 'Priya', offer: { ...OFFER, priceMinor: 300_000 } });
    await c.settled();
    expect((await db.pool.query(`select state, why from bus_bookings where person_id = 'p_priya'`)).rows[0]).toEqual({ state: 'failed', why: 'fare_moved' });
  });

  it('records their ticket once, theirs alone, when the vault says it is paid', async () => {
    const { runner } = fakeRunner();
    const m = money();
    const b = booking(runner, m.pay);
    await b.start({ tapId: 'tap_bus5', tripId: 't_bus', personId: 'p_rahul', name: 'Rahul', offer: OFFER });
    await b.settled();
    const key = String(m.cards.at(-1)!['key']);
    // Money's ticket payment keeps the run as its key (hold_id), as it does a flight's.
    const at = new Date('2026-10-11T08:00:00Z');
    await db.pool.query(
      `insert into payments (payment_id, trip_id, decision_id, option_ref, purpose, label, payer_person_id, payer_name, for_person_ids, state, created_at, updated_at, kind, hold_id, approval_id)
       values ($1, 't_bus', null, $2, 'IntrCity SmartBus 22:35', 'IntrCity SmartBus 22:35', 'p_rahul', 'Rahul', '{p_rahul}', 'paid', $3, $3, 'ticket', $2, $4)`,
      [`pay_${key}`, key, at, `ap_${key}`],
    );
    const from = lb.link.requests.length;
    await m.paid()!({ tripId: 't_bus', approvalId: `ap_${key}`, railRef: 'fake_1' });
    await m.paid()!({ tripId: 't_bus', approvalId: `ap_${key}`, railRef: 'fake_1' });
    const tickets = lb.link.requests.slice(from).filter((r) => r.method === 'add_booking');
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.params).toMatchObject({ kind: 'bus', vendor: 'ixigo (simulated)', amount_minor: 385_800, payer_person_id: 'p_rahul', for_person_ids: ['p_rahul'], approval_id: `ap_${key}` });
    // Then their ticket card, theirs alone, through money's one way on (pay.booked), naming the booking Go just added.
    const row = (await db.pool.query(`select booking_id from bus_bookings where person_id = 'p_rahul' and state = 'paid'`)).rows[0];
    expect(row.booking_id).toMatch(/^bk_/);
    expect(m.booked).toEqual([expect.objectContaining({ bookingId: row.booking_id, personId: 'p_rahul', ref: expect.stringMatching(/^SIM-/) })]);
  });

  // The Server team's demo payment (11 Oct): it paid on their tap and wrote the booking, so Go books nothing.
  it("takes the Server's own booking when the Server paid it (payment.completed): no add_booking, their ticket card on it", async () => {
    const { runner } = fakeRunner();
    const m = money();
    // Picked at a price the next free seat fits in (the bus's cheap seats are the earlier tests').
    const b = booking(runner, m.pay);
    await b.start({ tapId: 'tap_bus6', tripId: 't_bus', personId: 'p_bus_srv', name: 'Arjun', offer: { ...OFFER, priceMinor: 900_000 } });
    await b.settled();
    const key = String(m.cards.at(-1)!['key']);
    const at = new Date('2026-10-11T08:00:00Z');
    await db.pool.query(
      `insert into payments (payment_id, trip_id, decision_id, option_ref, purpose, label, payer_person_id, payer_name, for_person_ids, state, created_at, updated_at, kind, hold_id, approval_id, paid_by)
       values ($1, 't_bus', null, $2, 'IntrCity SmartBus 22:35', 'IntrCity SmartBus 22:35', 'p_bus_srv', 'Arjun', '{p_bus_srv}', 'paid', $3, $3, 'ticket', $2, $4, 'server')`,
      [`pay_${key}`, key, at, `ap_${key}`],
    );
    const from = lb.link.requests.length;
    await m.paid()!({ tripId: 't_bus', approvalId: `ap_${key}`, railRef: 'demo', bookingId: 'bk_server_1' });
    await m.paid()!({ tripId: 't_bus', approvalId: `ap_${key}`, railRef: 'demo', bookingId: 'bk_server_1' });
    expect(lb.link.requests.slice(from).filter((r) => r.method === 'add_booking')).toEqual([]);
    const row = (await db.pool.query(`select state, booking_id, seats from bus_bookings where person_id = 'p_bus_srv'`)).rows[0];
    expect(row).toMatchObject({ state: 'paid', booking_id: 'bk_server_1' });
    expect(m.booked).toEqual([{
      tripId: 't_bus', approvalId: `ap_${key}`, bookingId: 'bk_server_1', title: expect.any(String), ref: null, refundableUntil: null,
      simulated: true, detail: `seat ${row.seats.join(', ')}`, personId: 'p_bus_srv',
    }]);
  });

  // Prod, 11 Oct: a pick asked in words is older than the Server's 30 minutes (no_pick). Never a dead end: a line asking
  // for the fresh tap, theirs alone, and no "it failed" line.
  it("answers a stale pick (no_pick) with one line asking for the tap on I'll take this", async () => {
    const m = money();
    m.pay.requestTicketCard = async () => ({ refused: 'Arjun, pick it again on your card: it has been a while, or the price moved. Nothing was charged.', code: 'no_pick', say: true });
    const b = booking(fakeRunner().runner, m.pay);
    const from = lb.link.requests.length;
    await b.start({ tapId: 'words_bus1', tripId: 't_bus', personId: 'p_bus_stale', name: 'Arjun Mehta', offer: { ...OFFER, priceMinor: 900_000 } });
    await b.settled();
    const lines = lb.link.requests.slice(from).filter((r) => r.method === 'post_message' && !r.params['card'] && r.params['visible_to_person_ids']);
    expect(lines.map((r) => [r.params['text'], r.params['visible_to_person_ids']])).toEqual([["Arjun, tap I'll take this on IntrCity SmartBus 22:35 and I'll book it.", ['p_bus_stale']]]);
    expect((await db.pool.query(`select state, why from bus_bookings where person_id = 'p_bus_stale'`)).rows[0]).toEqual({ state: 'failed', why: 'pay_no_pick' });
  });

  it('is off without BOOKING', async () => {
    expect(await booking(fakeRunner().runner, null, false).onFor('t_bus')).toBe(false);
  });
});
