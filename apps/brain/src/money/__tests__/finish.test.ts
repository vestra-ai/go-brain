import * as C from '@go/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markFailed, markPaid, reconcile, sweepPayments } from '../finish.js';
import { getPayment, transition, unsettled } from '../store.js';
import { FakeCallError, moneyKit, type MoneyKit } from './kit.js';

let k: MoneyKit;
let paymentId: string;
let cardId: string;
let approvalId: string;

beforeEach(async () => {
  k = await moneyKit();
  const r = await k.ask();
  if (!('cardId' in r)) throw new Error(r.refused);
  paymentId = r.paymentId;
  cardId = r.cardId;
  approvalId = [...k.server.approvals.keys()][0] as string;
});
afterEach(async () => {
  await k.drop();
});

const paid = async () => {
  const row = await markPaid(k.deps, { tripId: 't_goa', approvalId, railRef: `fake_${approvalId}` });
  if (row) await reconcile(k.deps, row.payment_id);
};

describe('a paid payment', () => {
  it('confirms the hold, records the booking and the expense, updates the pay card and posts the ticket', async () => {
    await paid();
    expect(k.travel.confirms).toEqual([{ holdId: 'hold_1', paid: { approvalId, railRef: `fake_${approvalId}` } }]);
    expect(k.server.writesOf('add_booking')[0]?.params).toMatchObject({
      request_id: `go_paid_${approvalId}_booking`,
      kind: 'stay',
      title: 'Villa Sol, 3 nights',
      vendor: 'ixigo',
      ref: 'IXG-7Q2K9',
      amount_minor: 5420000,
      currency: 'INR',
      payer_person_id: 'p_rahul',
      for_person_ids: ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir'],
      refundable_until: '2026-11-01T18:29:59Z',
      starts_at: '2026-11-06T14:00:00+05:30',
      place: { name: 'Villa Sol', address: 'Anjuna, North Goa' },
      decision_id: 'd_villa',
      approval_id: approvalId,
    });
    expect(k.server.approvals.get(approvalId)?.used).toBe(true);
    const bookingId = k.server.trip('t_goa').bookings[0]?.booking_id;
    expect(k.server.writesOf('add_expense')[0]?.params).toMatchObject({
      request_id: `go_paid_${approvalId}_expense`,
      paid_by_person_id: 'p_rahul',
      amount_minor: 5420000,
      category: 'stay',
      note: 'Villa Sol, 3 nights',
      split_person_ids: ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir'],
      booking_id: bookingId,
    });
    const card = C.PayCard.parse(k.server.cards.get(cardId));
    expect(card.state).toBe('paid');
    expect(card.actions ?? null).toBeNull();
    const ticket = k.server.posts.at(-1);
    expect(ticket?.text).toBe('Booked Villa Sol, 3 nights! Rahul paid ₹54,200, split between all 5.');
    expect(ticket?.card).toMatchObject({ kind: 'ticket', card_id: `c_ticket_${approvalId}`, booking_id: bookingId });
    expect(await getPayment(k.pool, paymentId)).toMatchObject({ state: 'paid', booking_id: bookingId, ticket_posted_at: expect.any(Date) });
    expect(await unsettled(k.pool, k.now())).toEqual([]);
  });

  it('does every step once when the vault calls back twice', async () => {
    await paid();
    await paid();
    await reconcile(k.deps, paymentId);
    expect(k.server.writesOf('add_booking')).toHaveLength(1);
    expect(k.server.writesOf('add_expense')).toHaveLength(1);
    expect(k.server.posts.filter((p) => p.card?.kind === 'ticket')).toHaveLength(1);
    expect(k.travel.confirms).toHaveLength(1);
  });

  it('finishes after a step fails, without doing the earlier steps again', async () => {
    k.server.failNext.set('add_expense', new FakeCallError(503, 'the Server is busy'));
    await paid();
    expect(await getPayment(k.pool, paymentId)).toMatchObject({ expense_id: null, attempts: 1, last_error: 'the Server is busy' });
    expect(await sweepPayments(k.deps)).toBe(1);
    expect(k.server.writesOf('add_booking')).toHaveLength(1);
    expect(k.server.writesOf('add_expense')).toHaveLength(1);
    expect((await getPayment(k.pool, paymentId))?.ticket_posted_at).not.toBeNull();
  });

  it('keeps trying when the travel layer has not confirmed yet', async () => {
    k.travel.failConfirm = true;
    await paid();
    expect(k.server.writesOf('add_booking')).toEqual([]);
    k.travel.failConfirm = false;
    await sweepPayments(k.deps);
    expect(k.server.writesOf('add_booking')).toHaveLength(1);
  });

  it('backs off a paid payment after 20 tries, never drops it, and logs an error on the 20th', async () => {
    k.travel.failConfirm = true;
    await markPaid(k.deps, { tripId: 't_goa', approvalId, railRef: `fake_${approvalId}` });
    await k.pool.query('update payments set attempts = 19');
    await reconcile(k.deps, paymentId);
    expect((await getPayment(k.pool, paymentId))?.attempts).toBe(20);
    expect(k.lines.join('\n')).toContain('still not booked after 20 tries');
    expect(await unsettled(k.pool, k.now())).toEqual([]);
    k.advance(11 * 60_000);
    expect(await unsettled(k.pool, k.now())).toEqual([paymentId]);
    k.travel.failConfirm = false;
    await sweepPayments(k.deps);
    expect(k.server.writesOf('add_booking')).toHaveLength(1);
  });
});

describe('a payment that did not happen', () => {
  it('after a failed charge: releases the approval, marks the card failed and says why, without card details', async () => {
    await markFailed(k.deps, { tripId: 't_goa', approvalId, reason: 'card_declined' });
    await reconcile(k.deps, paymentId);
    expect(k.server.writesOf('cancel_spend_approval')[0]?.params).toMatchObject({
      request_id: `go_failed_${approvalId}_release`,
      approval_id: approvalId,
      reason: 'payment_failed',
    });
    expect(k.server.cards.get(cardId)).toMatchObject({ state: 'failed' });
    expect(k.server.posts.at(-1)?.text).toBe(
      "Rahul, the payment for Villa Sol didn't go through (the bank declined the card). Nothing was charged. Want to try again?",
    );
  });

  it('ignores a failure for a payment that already went through', async () => {
    await paid();
    expect((await markFailed(k.deps, { tripId: 't_goa', approvalId, reason: 'rail_error' }))?.state).toBe('paid');
    expect((await getPayment(k.pool, paymentId))?.state).toBe('paid');
  });

  it('after a decline: releases as payer_declined and holds off once', async () => {
    await transition(k.pool, paymentId, ['waiting'], 'declined', { release_reason: 'payer_declined' }, k.now());
    await reconcile(k.deps, paymentId);
    await reconcile(k.deps, paymentId);
    expect(k.server.writesOf('cancel_spend_approval').map((w) => w.params.reason)).toEqual(['payer_declined']);
    expect(k.server.cards.get(cardId)).toMatchObject({ state: 'declined' });
    expect(k.server.posts.filter((p) => p.text === 'Holding off on Villa Sol for now.')).toHaveLength(1);
  });

  it('expires 120 s after the approval ran out, quietly, with a way to start again', async () => {
    k.setNow(new Date('2026-10-05T09:11:59Z'));
    await sweepPayments(k.deps);
    expect((await getPayment(k.pool, paymentId))?.state).toBe('waiting');
    k.setNow(new Date('2026-10-05T09:12:01Z'));
    await sweepPayments(k.deps);
    expect((await getPayment(k.pool, paymentId))?.state).toBe('expired');
    expect(k.server.writesOf('cancel_spend_approval')[0]?.params.reason).toBe('expired');
    const card = C.PayCard.parse(k.server.cards.get(cardId));
    expect(card.state).toBe('expired');
    expect(card.actions?.[0]).toMatchObject({ action_id: 'approve', label: 'Start again' });
    expect(k.server.posts.filter((p) => p.text !== null && p.card === null)).toEqual([]);
  });

  it('gives up an ask stuck halfway and releases its approval', async () => {
    await k.pool.query("update payments set state = 'asking', created_at = '2026-10-05T08:58:00Z'");
    await sweepPayments(k.deps);
    expect(await getPayment(k.pool, paymentId)).toMatchObject({ state: 'refused', refused_reason: 'interrupted', released_at: expect.any(Date) });
    expect(k.server.writesOf('cancel_spend_approval')[0]?.params.reason).toBe('other');
  });
});
