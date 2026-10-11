import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../../db/test-db.js';
import { makeLaneBrain, type LaneBrain } from '../../../tasks/testing/lane-brain.js';
import { capture, fixture } from '../../recipes/__tests__/fixtures.js';
import type { FetchPlan } from '../../recipes/recipe.js';
import type { ReadOptions, RecipeRunner } from '../../recipes/runners.js';
import type { StoredOffer } from '../../travel.js';
import { ageOn, busOf, createBusBooking, SEAT_LAYOUT, type BusBooking } from '../bus-booking.js';
import type { TicketPay } from '../flight-booking.js';

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
  const cards: Array<Record<string, unknown>> = [];
  let paid: ((p: { tripId: string; approvalId: string; railRef: string }) => Promise<void>) | null = null;
  const pay: TicketPay = {
    async requestTicketCard(_trip, req) {
      cards.push(req);
      return { cardId: `c_pay_${req.key}`, paymentId: `pay_${req.key}` };
    },
    onPaid: (fn) => {
      paid = fn;
    },
    travelDetails: async () => (o.details === false ? null : DETAILS),
  };
  return { pay, cards, paid: () => paid };
}

function booking(runner: RecipeRunner, pay: TicketPay | null, on = true): BusBooking {
  void lb.switches.set('BOOKING', on ? 'on' : 'off');
  void lb.switches.set('TRAVEL_MODE', 'ixigo_web');
  return createBusBooking({
    pool: db.pool, runner: () => runner, link: lb.link, switches: lb.switches, now: lb.brain.now, log: lb.brain.log, pay: () => pay ?? undefined,
    nameOf: async () => 'Meher',
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

  it('says so, and stops, when their vault has no travel details, or the cheapest free seat is more than 5% over their pick', async () => {
    const { runner } = fakeRunner();
    const b = booking(runner, money({ details: false }).pay);
    const from = lb.link.requests.length;
    await b.start({ tapId: 'tap_bus3', tripId: 't_bus', personId: 'p_kabir', name: 'Kabir', offer: OFFER });
    await b.settled();
    expect(lb.link.requests.slice(from).map((r) => r.params['text']).filter(Boolean)).toEqual([expect.stringContaining("ixigo's bus form needs your name as on your ID, your age and your gender")]);
    expect((await db.pool.query(`select state, why from bus_bookings where person_id = 'p_kabir'`)).rows[0]).toEqual({ state: 'failed', why: 'passenger_details_needed' });

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
  });

  it('is off without BOOKING', async () => {
    expect(await booking(fakeRunner().runner, null, false).onFor('t_bus')).toBe(false);
  });
});
