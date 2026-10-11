import * as C from '@go/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { askForTicketCard } from '../ask.js';
import { createPay, type PayEngine } from '../engine.js';
import { EXPIRY_GRACE_MS, getPayment } from '../store.js';
import type { Booked } from '../pay.js';
import { moneyKit, type MoneyKit } from './kit.js';

// The Server team's demo payment (11 Oct): the payer's tap on a waiting pay card never reaches Go. The Server sets the card
// paid, writes the booking and the expense, and tells Go with payment.completed. Go books nothing more: the ticket card,
// then the next step.

let k: MoneyKit;
let pay: PayEngine;
/** The stay booked: Go wakes for each person's flights (MoneyDeps.stayBooked, #492). */
let next: Array<{ tripId: string; bookingId: string; title: string }>;
let seq = 300;

beforeEach(async () => {
  k = await moneyKit();
  next = [];
  k.deps.stayBooked = async (tripId, b) => void next.push({ tripId, ...b });
  pay = createPay(k.deps);
});
afterEach(async () => {
  await pay.settled();
  await k.drop();
});

const event = (data: Record<string, unknown>) =>
  C.Event.parse({ event_id: `ev_${++seq}`, trip_id: 't_goa', seq, occurred_at: '2026-10-05T09:02:00Z', type: 'payment.completed', data });

/** What the Server does on the payer's tap, in one transaction: the approval used, the booking, the card paid; then the event. */
async function serverPays(paymentId: string, booking: Partial<C.Booking> = {}) {
  const row = (await getPayment(k.pool, paymentId))!;
  const approvalId = row.approval_id!;
  k.server.approvals.get(approvalId)!.used = true;
  k.server.trip('t_goa').bookings.push(C.Booking.parse({
    booking_id: 'bk_srv', kind: 'stay', status: 'confirmed', title: 'Villa Sol, 3 nights', vendor: 'ixigo', ref: 'IXG-7781',
    amount_minor: row.amount_minor, currency: row.currency, payer_person_id: row.payer_person_id, for_person_ids: row.for_person_ids,
    decision_id: row.decision_id, approval_id: approvalId, created_at: '2026-10-05T09:02:00Z', ...booking,
  }));
  if (row.card_id) {
    const card = k.server.cards.get(row.card_id) as C.Card & { kind: 'pay' };
    k.server.cards.set(row.card_id, { ...card, state: 'paid', actions: null } as C.Card);
  }
  return event({
    approval_id: approvalId, card_id: row.card_id, payer_person_id: row.payer_person_id, amount_minor: row.amount_minor, currency: row.currency,
    merchant: row.merchant, purpose: row.purpose,
    ...(row.decision_id ? { decision_id: row.decision_id } : { personal: { person_id: row.payer_person_id, card_id: row.pick_card_id, option_id: row.pick_option_id } }),
    booking_id: 'bk_srv', expense_id: 'ex_srv', method: 'demo', paid_at: '2026-10-05T09:02:00Z', by: { kind: 'person', person_id: row.payer_person_id },
  });
}

const asked = async () => {
  const r = await k.ask();
  if (!('paymentId' in r)) throw new Error('refused');
  return r;
};

describe('payment.completed', () => {
  it("marks the group's payment paid, posts the ticket card alone, then the next step; Go books, adds and replaces nothing", async () => {
    const r = await asked();
    const from = k.server.writes.length;
    await pay.tripEvent(await serverPays(r.paymentId));
    await pay.settled();

    expect(await getPayment(k.pool, r.paymentId)).toMatchObject({
      state: 'paid', paid_by: 'server', booking_id: 'bk_srv', expense_id: 'ex_srv', card_state: 'paid', ticket_posted_at: expect.any(Date),
      confirmed: { kind: 'stay', title: 'Villa Sol, 3 nights', ref: 'IXG-7781', vendor: 'ixigo' },
    });
    const after = k.server.writes.slice(from);
    // One read of the Server's booking for the ticket's words, then the ticket card: nothing else.
    expect(after.map((w) => w.method)).toEqual(['read_trip', 'post_message']);
    expect(k.travel.confirms).toEqual([]);
    const ticket = after[1]!.params;
    // No "booked" line of Go's: the Server's own says it.
    expect(ticket.text).toBeUndefined();
    expect(ticket.visible_to_person_ids).toBeUndefined();
    expect(ticket.card).toMatchObject({ kind: 'ticket', booking_id: 'bk_srv', fallback_text: 'Booked (simulated): Villa Sol, 3 nights. Ref IXG-7781. Free cancellation until 1 Nov.' });
    // Then the stay's next step, as after the vault's: each person's flights.
    expect(next).toEqual([{ tripId: 't_goa', bookingId: 'bk_srv', title: 'Villa Sol, 3 nights' }]);
    // The pay card is as the Server left it: paid, no buttons.
    expect(k.server.cards.get(r.cardId)).toMatchObject({ state: 'paid', actions: null });
  });

  it('leaves nothing to close it after: no expiry past its time, no "not now", no let-go of the approval', async () => {
    const r = await asked();
    await pay.tripEvent(await serverPays(r.paymentId));
    await pay.settled();
    k.advance(60 * 60_000 + EXPIRY_GRACE_MS);
    await pay.sweep();
    await pay.tripEvent(C.Event.parse({
      event_id: 'ev_no', trip_id: 't_goa', seq: ++seq, occurred_at: '2026-10-05T10:05:00Z', type: 'mandate.declined', data: { decision_id: 'd_villa', person_id: 'p_rahul' },
    }));
    await pay.settled();
    expect(await getPayment(k.pool, r.paymentId)).toMatchObject({ state: 'paid', released_at: null });
    expect(k.server.writesOf('cancel_spend_approval')).toEqual([]);
    expect(k.server.writesOf('replace_card')).toEqual([]);
    expect(k.vault.voids).toEqual([]);
  });

  it('heard twice, and again with a new event id, does nothing more', async () => {
    const r = await asked();
    const ev = await serverPays(r.paymentId);
    await pay.tripEvent(ev);
    await pay.tripEvent(ev);
    await pay.tripEvent({ ...ev, event_id: 'ev_again', seq: ++seq });
    await pay.settled();
    await pay.sweep();
    expect(k.server.writesOf('post_message').filter((w) => (w.params.card as { kind?: string } | undefined)?.kind === 'ticket')).toHaveLength(1);
    expect(next).toHaveLength(1);
    expect(k.server.writesOf('add_booking')).toEqual([]);
    expect(k.server.writesOf('add_expense')).toEqual([]);
  });

  it('for an approval Go has no payment for is accepted and ignored, with a log', async () => {
    await asked();
    const from = k.server.writes.length;
    // Lenient: only the approval is needed, so the Server's event is never refused.
    const ev = event({ approval_id: 'ap_not_ours' });
    await pay.tripEvent(ev);
    await pay.settled();
    expect(k.server.writes.slice(from)).toEqual([]);
    expect(next).toEqual([]);
    expect(k.lines.some((l) => l.includes('payment.completed for an approval Go has no payment for: ignored') && l.includes('ap_not_ours'))).toBe(true);
  });

  it("a person's own ticket: paid with no paid line, the card as the Server left it; their flow gets the Server's booking", async () => {
    const t = await askForTicketCard(k.deps, 't_goa', {
      personId: 'p_meher', cardId: 'c_flights_meher', optionId: 'opt_flight_2', amountMinor: 753600, currency: 'INR',
      purpose: 'IndiGo 6E2150, Fri 6 Nov, for Meher', key: 'fb_meher', trigger: 'tap_m1',
    });
    if (!('cardId' in t)) throw new Error(t.refused);
    const heard: Array<{ approvalId: string; bookingId?: string }> = [];
    pay.onPaid(async (p) => void heard.push({ approvalId: p.approvalId, ...(p.bookingId ? { bookingId: p.bookingId } : {}) }));
    const from = k.server.writes.length;
    await pay.tripEvent(await serverPays(t.paymentId, { kind: 'flight', title: 'IndiGo 6E2150', for_person_ids: ['p_meher'], decision_id: null }));
    await pay.settled();
    const row = (await getPayment(k.pool, t.paymentId))!;
    expect(row).toMatchObject({ state: 'paid', paid_by: 'server', booking_id: 'bk_srv', card_state: 'paid', ticket_posted_at: expect.any(Date) });
    expect(heard).toEqual([{ approvalId: row.approval_id, bookingId: 'bk_srv' }]);
    // Go posts nothing itself here: the ticket card is the flight flow's (pay.booked), and the Server said it is paid. No
    // stay, so nothing wakes.
    expect(k.server.writes.slice(from)).toEqual([]);
    expect(next).toEqual([]);
  });
});

describe("the vault's path, when no payment.completed comes", () => {
  it('still books it, with the line and the ticket card, then the same next step', async () => {
    const r = await asked();
    const approvalId = (await getPayment(k.pool, r.paymentId))!.approval_id!;
    expect(await pay.paid({ tripId: 't_goa', approvalId, railRef: `fake_${approvalId}` })).toBe('ok');
    await pay.settled();
    expect(await getPayment(k.pool, r.paymentId)).toMatchObject({ state: 'paid', paid_by: null, ticket_posted_at: expect.any(Date) });
    expect(k.server.writesOf('add_booking')).toHaveLength(1);
    expect(k.server.writesOf('add_expense')).toHaveLength(1);
    const ticket = k.server.writesOf('post_message').at(-1)!.params;
    expect(ticket.text).toEqual(expect.stringContaining('Villa Sol'));
    expect(ticket.card).toMatchObject({ kind: 'ticket' });
    expect(next).toEqual([{ tripId: 't_goa', bookingId: (await getPayment(k.pool, r.paymentId))!.booking_id, title: 'Villa Sol, 3 nights' }]);
  });

  it("booked() posts a person's ticket card for them alone, once, and wakes nothing (no stay)", async () => {
    const b: Booked = {
      tripId: 't_goa', approvalId: 'ap_meher', bookingId: 'b_9', title: 'IntrCity SmartBus 22:35', ref: null, refundableUntil: null,
      simulated: true, detail: 'seat 6LC', personId: 'p_meher',
    };
    await pay.booked(b);
    await pay.settled();
    const posts = k.server.writesOf('post_message');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.params).toMatchObject({
      visible_to_person_ids: ['p_meher'],
      card: { kind: 'ticket', booking_id: 'b_9', fallback_text: 'Booked (simulated): IntrCity SmartBus 22:35, seat 6LC.' },
    });
    expect(posts[0]!.params.text).toBeUndefined();
    expect(next).toEqual([]);
  });
});
