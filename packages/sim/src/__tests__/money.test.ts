import { describe, expect, it } from 'vitest';
import { verifySpendApproval, type Event } from '@go/contract';
import { GOA_SNAPSHOT, goaFreshTrip } from '../goa.js';
import { SocketCallError } from '../server-socket.js';
import { TEST_SPEND_PRIVATE_KEY_PEM, TEST_SPEND_PUBLIC_KEY_PEM } from '../test-spend-key.js';
import { confirmMandate, declineMandate, openVote, setMandate, vote } from '../state/decisions.js';
import { addBooking, addExpense, cancelSpendApproval, recomputeMoney, requestSpendApproval, spendCheck, updateBooking } from '../state/money.js';
import { TripState } from '../state/trip-state.js';

const everyone = ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir'];
const start = Date.parse('2026-10-05T08:45:00Z');

function setUp() {
  let t = start;
  let n = 0;
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const s = new TripState(goaFreshTrip(), { mint: (p) => `${p}${String(++n).padStart(4, '0')}`, now: clock.now });
  s.created();
  return { s, clock };
}

function closedVote(s: TripState, winnerIndex = 0): string {
  const id = openVote(s, {
    request_id: `rq_open_${s.trip.seq}`, trip_id: 't_goa', question: 'Where do we stay?', kind: 'choice', anonymous: false,
    options: [{ label: 'Villa Sol', price_minor: 5420000, currency: 'INR' }, { label: 'Casa Azul', price_minor: 6180000, currency: 'INR' }],
  }).result.decision_id;
  for (const p of everyone) vote(s, id, p, winnerIndex);
  return id;
}

function mandate(s: TripState, decision_id: string): void {
  setMandate(s, { request_id: 'rq_m', trip_id: 't_goa', decision_id, choice_index: 0, cap_minor: 5500000, currency: 'INR', refundable_only: true, payer_person_id: 'p_rahul' });
}

/** A closed vote with a mandate the payer said yes to. */
function readyToPay() {
  const { s, clock } = setUp();
  const id = closedVote(s);
  mandate(s, id);
  clock.advance(60_000);
  confirmMandate(s, id);
  return { s, clock, id };
}

const ask = (decision_id: string, extra: Record<string, unknown> = {}) => ({
  request_id: 'rq_s', trip_id: 't_goa', decision_id, amount_minor: 5420000, currency: 'INR', merchant: 'ixigo: Villa Sol, Anjuna',
  purpose: 'Villa Sol, 3 nights, 6 to 9 Nov', refundable_until: '2026-11-01T18:29:59Z', ...extra,
}) as never;

const booking = (decision_id: string, approval_id: string | undefined, extra: Record<string, unknown> = {}) => ({
  request_id: 'rq_b', trip_id: 't_goa', kind: 'stay', title: 'Villa Sol, 3 nights', vendor: 'ixigo', ref: 'IXG-7Q2K9', amount_minor: 5420000,
  currency: 'INR', payer_person_id: 'p_rahul', for_person_ids: everyone, refundable_until: '2026-11-01T18:29:59Z', decision_id,
  ...(approval_id ? { approval_id } : {}), ...extra,
}) as never;

function approve(s: TripState, id: string): string {
  const r = requestSpendApproval(s, ask(id), TEST_SPEND_PRIVATE_KEY_PEM).result;
  if (r.status !== 'approved') throw new Error(`denied: ${r.reason}`);
  return r.approval_id;
}

function err(fn: () => unknown): SocketCallError {
  try {
    fn();
  } catch (e) {
    if (e instanceof SocketCallError) return e;
    throw e;
  }
  throw new Error('it did not throw');
}

const types = (events: Event[]) => events.map((e) => e.type);

describe('the spend check', () => {
  it("denies in the guide's order, the first rule that fails", () => {
    const { s, clock } = setUp();
    expect(spendCheck(s, ask('d_nope'))).toBe('decision_not_found');
    const id = openVote(s, { request_id: 'rq_o', trip_id: 't_goa', question: 'Where?', kind: 'choice', anonymous: false, options: [{ label: 'A' }, { label: 'B' }] }).result.decision_id;
    expect(spendCheck(s, ask(id))).toBe('decision_not_closed');
    for (const p of everyone) vote(s, id, p, 0);
    expect(spendCheck(s, ask(id))).toBe('no_mandate');
    mandate(s, id);
    expect(spendCheck(s, ask(id))).toBe('payer_has_not_confirmed');
    clock.advance(1000);
    declineMandate(s, id);
    expect(spendCheck(s, ask(id))).toBe('payer_declined');
    clock.advance(1000);
    confirmMandate(s, id);
    expect(spendCheck(s, ask(id, { currency: 'USD' }))).toBe('currency_mismatch');
    expect(spendCheck(s, ask(id, { amount_minor: 5640000 }))).toBe('over_cap');
    expect(spendCheck(s, ask(id, { refundable_until: null }))).toBe('not_refundable');
    expect(spendCheck(s, ask(id, { refundable_until: '2026-10-01T00:00:00Z' }))).toBe('not_refundable');
    expect(spendCheck(s, ask(id))).toBeNull();
    approve(s, id);
    expect(spendCheck(s, ask(id))).toBe('approval_outstanding');
  });

  it("approves with a token signed by the test key, for the mandate's payer, for at most 10 minutes", () => {
    const { s, clock, id } = readyToPay();
    const done = s.once('rq_s1', () => requestSpendApproval(s, ask(id), TEST_SPEND_PRIVATE_KEY_PEM));
    const r = done.result;
    expect(r.status).toBe('approved');
    if (r.status !== 'approved') return;
    const check = verifySpendApproval(r.approval, TEST_SPEND_PUBLIC_KEY_PEM, Math.floor(clock.now().getTime() / 1000) + 60);
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.claims).toMatchObject({
        iss: 'server', aud: 'go-vault', jti: r.approval_id, trip_id: 't_goa', decision_id: id, payer_person_id: 'p_rahul', amount_minor: 5420000, currency: 'INR',
      });
    }
    expect(Date.parse(r.expires_at) - clock.now().getTime()).toBe(600_000);
    expect(done.events).toEqual([]);
    const again = s.once('rq_s1', () => requestSpendApproval(s, ask(id), TEST_SPEND_PRIVATE_KEY_PEM));
    expect(again.repeat).toBe(true);
    expect(again.result).toEqual(r);
    const second = s.once('rq_s2', () => requestSpendApproval(s, ask(id), TEST_SPEND_PRIVATE_KEY_PEM)).result;
    expect(second).toMatchObject({ status: 'denied', reason: 'approval_outstanding' });
  });

  it('cancel releases an approval, is safe to repeat, and a cancelled approval cannot book', () => {
    const { s, id } = readyToPay();
    const approvalId = approve(s, id);
    const cancel = (approval_id: string) => cancelSpendApproval(s, { request_id: 'rq_c', trip_id: 't_goa', approval_id, reason: 'payer_declined' });
    expect(cancel(approvalId)).toEqual({ result: { ok: true }, events: [] });
    expect(cancel(approvalId).result).toEqual({ ok: true });
    expect(err(() => cancel('ap_nope')).code).toBe(404);
    expect(spendCheck(s, ask(id))).toBeNull();
    expect(err(() => addBooking(s, booking(id, approvalId))).code).toBe(409);
  });
});

// Contract 1.3 (G3): a person's own pick is never voted on. The FakeServer grants it on the Server's rules: that person
// tapped that option on their own card of Go's in the last 30 minutes, the amount is at most its price plus 5%, and nothing
// else is approved or booked for the pick. It signs `personal` in place of decision_id, and that person is the payer.
describe("a person's own pick", () => {
  const pick = { person_id: 'p_meher', card_id: 'c_flights_meher', option_id: 'opt_flight_2' };
  const personalAsk = (over: Record<string, unknown> = {}) => ({
    request_id: 'rq_t', trip_id: 't_goa', personal: pick, amount_minor: 753600, currency: 'INR', merchant: 'ixigo',
    purpose: 'IndiGo 6E2150, Fri 6 Nov, for Meher', ...over,
  }) as never;
  /** Go's flights card for Meher alone, and her tap on its second flight. */
  function picked(o: { tap?: boolean; forPerson?: string } = {}) {
    const { s, clock } = setUp();
    const option = (n: number, price: number) => ({ option_id: `opt_flight_${n}`, title: `Flight ${n}`, price_minor: price, currency: 'INR', highlights: [] });
    // The room keeps the card as Go sent it (the raw request), as the Server does.
    const post = {
      request_id: 'rq_card', trip_id: 't_goa', text: 'Meher, your flights from Mumbai',
      card: { card_id: 'c_flights_meher', kind: 'options', fallback_text: 'Flights', title: 'Your flights', option_kind: 'flight', checked_at: new Date(start).toISOString(), for_person_ids: [o.forPerson ?? 'p_meher'], options: [option(1, 690000), option(2, 717800)] },
    };
    s.postMessage(post as never, post);
    if (o.tap !== false) s.recordTap('p_meher', 'c_flights_meher', 'opt_flight_2');
    return { s, clock };
  }

  it('is granted for the option its person tapped on their own card, signed for them as its payer, and the vault can read it', () => {
    const { s } = picked();
    const r = requestSpendApproval(s, personalAsk(), TEST_SPEND_PRIVATE_KEY_PEM).result;
    if (r.status !== 'approved') throw new Error(`denied: ${r.reason}`);
    const read = verifySpendApproval(r.approval, TEST_SPEND_PUBLIC_KEY_PEM, Math.floor(start / 1000) + 1);
    if (!read.ok) throw new Error(read.reason);
    expect(read.claims).toMatchObject({ personal: pick, payer_person_id: 'p_meher', amount_minor: 753600 });
    expect(read.claims.decision_id ?? null).toBeNull();
    expect(s.approvals.get(r.approval_id)).toMatchObject({ decision_id: null, personal: pick, payer_person_id: 'p_meher' });
  });

  it('is denied no_pick with no tap, a tap over 30 minutes old, a card that is not theirs, or more than the price plus 5%', () => {
    const denied = (s: TripState, over: Record<string, unknown> = {}) => requestSpendApproval(s, personalAsk(over), TEST_SPEND_PRIVATE_KEY_PEM).result;
    expect(denied(picked({ tap: false }).s)).toMatchObject({ status: 'denied', reason: 'no_pick' });
    const late = picked();
    late.clock.advance(31 * 60_000);
    expect(denied(late.s)).toMatchObject({ status: 'denied', reason: 'no_pick' });
    expect(denied(picked({ forPerson: 'p_rahul' }).s)).toMatchObject({ status: 'denied', reason: 'no_pick' });
    // 717,800 plus 5% is 753,690: a paisa more is too much.
    expect(denied(picked().s, { amount_minor: 753691 })).toMatchObject({ status: 'denied', reason: 'no_pick' });
    expect(denied(picked().s, { personal: { ...pick, person_id: 'p_stranger' } })).toMatchObject({ status: 'denied', reason: 'not_in_trip' });
  });

  it("allows one approval a pick at a time, books with no vote paid by its person, and never twice", () => {
    const { s } = picked();
    const r = requestSpendApproval(s, personalAsk(), TEST_SPEND_PRIVATE_KEY_PEM).result;
    if (r.status !== 'approved') throw new Error(`denied: ${r.reason}`);
    expect(requestSpendApproval(s, personalAsk({ request_id: 'rq_t2' }), TEST_SPEND_PRIVATE_KEY_PEM).result).toMatchObject({ reason: 'approval_outstanding' });
    const flight = (extra: Record<string, unknown>) => booking(undefined as never, r.approval_id, {
      kind: 'flight', title: 'IndiGo 6E2150', amount_minor: 753600, payer_person_id: 'p_meher', for_person_ids: ['p_meher'], decision_id: undefined, ...extra,
    });
    expect(err(() => addBooking(s, flight({ payer_person_id: 'p_rahul' }))).code).toBe(409);
    expect(err(() => addBooking(s, flight({ decision_id: closedVote(s) }))).code).toBe(409);
    expect(s.approvals.get(r.approval_id)!.used).toBe(false);
    addBooking(s, flight({}));
    expect(s.approvals.get(r.approval_id)!.used).toBe(true);
    expect(requestSpendApproval(s, personalAsk({ request_id: 'rq_t3' }), TEST_SPEND_PRIVATE_KEY_PEM).result).toMatchObject({ reason: 'already_booked' });
  });
});

describe('a vote that is booked already', () => {
  it('is denied already_booked, never approval_outstanding: a second payment would charge twice', () => {
    const { s, id } = readyToPay();
    addBooking(s, booking(id, undefined));
    expect(spendCheck(s, ask(id))).toBe('already_booked');
  });
});

describe('bookings', () => {
  it('records a paid booking, marks the approval used, and turns the decided line into the booked line', () => {
    const { s, id } = readyToPay();
    const approvalId = approve(s, id);
    const decided = s.trip.record.find((l) => l.kind === 'decided' && l.decision_id === id)!;
    const done = s.once('rq_b1', () => addBooking(s, booking(id, approvalId)));
    expect(types(done.events)).toEqual(['booking.changed', 'record.changed']);
    expect(done.result.seq).toBe(done.events[0]!.seq);
    expect(done.events[0]).toMatchObject({ data: { change: 'added', by: { kind: 'go' }, booking: { status: 'confirmed', approval_id: approvalId, decision_id: id } } });
    expect(done.events[1]).toMatchObject({
      data: { change: 'updated', by: { kind: 'system' }, line: { line_id: decided.line_id, kind: 'booked', text: 'Villa Sol, 3 nights', source: 'booking' } },
    });
    expect(s.approvals.get(approvalId)!.used).toBe(true);
    // The same request_id again gets its first answer, even though the approval is now used.
    expect(s.once('rq_b1', () => addBooking(s, booking(id, approvalId))).result).toEqual(done.result);
    expect(err(() => addBooking(s, booking(id, approvalId))).code).toBe(409);
  });

  it('refuses an approval for another vote, more than approved, an unknown approval, and people or votes outside the trip', () => {
    const { s, id } = readyToPay();
    const approvalId = approve(s, id);
    const other = closedVote(s, 1);
    expect(err(() => addBooking(s, booking(other, approvalId))).code).toBe(409);
    expect(err(() => addBooking(s, booking(id, approvalId, { amount_minor: 5420001 }))).code).toBe(409);
    expect(err(() => addBooking(s, booking(id, 'ap_other_trip'))).code).toBe(409);
    expect(err(() => addBooking(s, booking(id, undefined, { payer_person_id: 'p_stranger' }))).code).toBe(422);
    expect(err(() => addBooking(s, booking('d_nope', undefined))).code).toBe(422);
    expect(s.approvals.get(approvalId)!.used).toBe(false);
  });

  it('a booking someone made themselves is recorded without an approval, with a new booked line', () => {
    const { s } = setUp();
    const done = addBooking(s, { request_id: 'rq_cab', trip_id: 't_goa', kind: 'cab', title: 'Airport cab', vendor: 'GoaMiles', ref: 'GM-1', amount_minor: 340000, currency: 'INR', payer_person_id: 'p_kabir', for_person_ids: everyone });
    expect(done.events[1]).toMatchObject({ data: { change: 'added', line: { kind: 'booked', text: 'Airport cab', source: 'booking' } } });
  });

  it('cancels a booking, and nothing changes a cancelled one', () => {
    const { s } = setUp();
    const bookingId = addBooking(s, booking(closedVote(s), undefined)).result.booking_id;
    const u = (extra: Record<string, unknown>) => ({ request_id: 'rq_ub', trip_id: 't_goa', booking_id: bookingId, ...extra }) as never;
    expect(err(() => updateBooking(s, u({}))).code).toBe(422);
    expect(updateBooking(s, u({ ends_at: '2026-11-09T13:00:00+05:30' })).events[0]).toMatchObject({ data: { change: 'updated' } });
    expect(updateBooking(s, u({ status: 'cancelled' })).events[0]).toMatchObject({ data: { change: 'cancelled', booking: { status: 'cancelled' } } });
    expect(err(() => updateBooking(s, u({ ref: 'X' }))).code).toBe(409);
    expect(err(() => updateBooking(s, u({ booking_id: 'b_nope', ref: 'X' }))).code).toBe(404);
  });
});

describe('expenses and the money maths', () => {
  it('records an expense by Go and works out who pays whom', () => {
    const { s } = setUp();
    const cab = { request_id: 'rq_e', trip_id: 't_goa', paid_by_person_id: 'p_kabir', amount_minor: 340000, currency: 'INR', note: 'Airport cab', category: 'getting_around', split_person_ids: everyone } as const;
    const done = addExpense(s, { ...cab, split_person_ids: [...cab.split_person_ids] });
    expect(done.events[0]).toMatchObject({ type: 'expense.changed', data: { change: 'added', by: { kind: 'go' }, expense: { note: 'Airport cab' } } });
    expect(s.trip.money).toMatchObject({ spent_minor: 340000, by_category: [{ category: 'getting_around', amount_minor: 340000 }] });
    expect(s.trip.money.transfers).toEqual(
      ['p_rahul', 'p_priya', 'p_arjun', 'p_meher'].map((from) => ({ from_person_id: from, to_person_id: 'p_kabir', amount_minor: 68000, currency: 'INR' })),
    );
    expect(err(() => addExpense(s, { ...cab, split_person_ids: ['p_stranger'] })).code).toBe(422);
    expect(err(() => addExpense(s, { ...cab, split_person_ids: [...cab.split_person_ids], booking_id: 'b_nope' })).code).toBe(422);
    expect(err(() => addExpense(s, { ...cab, split_person_ids: [...cab.split_person_ids], currency: 'USD' })).code).toBe(422);
  });

  it("reproduces the money in the guide's Goa trip exactly", () => {
    const s = new TripState(GOA_SNAPSHOT, { mint: (p) => `${p}1`, now: () => new Date(start) });
    const expected = structuredClone(GOA_SNAPSHOT.money);
    s.trip.money.spent_minor = 0;
    s.trip.money.by_category = [];
    s.trip.money.transfers = [];
    recomputeMoney(s);
    expect(s.trip.money).toEqual(expected);
  });
});
