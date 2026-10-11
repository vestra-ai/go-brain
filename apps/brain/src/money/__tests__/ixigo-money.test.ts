import type * as C from '@go/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { payCard } from '../cards.js';
import { createPay } from '../engine.js';
import { getPayment, paidApprovalIds } from '../store.js';
import { bookedLine, ticketPaidLine, TOASTS } from '../words.js';
import { moneyKit, type MoneyKit } from './kit.js';

// Keshav, 11 Oct: payment and ticketing are mocked for the demo, and paying should feel like the ixigo wallet: one tap on
// the pay card itself. On Go's fake rail there is no page, card form, Face ID or code; the booking moves on as after the
// vault's paid. Go still never presses ixigo's own Pay: nothing real is paid or booked.
let k: MoneyKit;
let n = 0;
beforeEach(async () => {
  k = await moneyKit();
});
afterEach(async () => {
  await k.drop();
});

const tap = (cardId: string, personId: string, actionId = 'approve'): C.CardTap =>
  ({ tap_id: `tap_im_${++n}`, trip_id: 't_goa', card_id: cardId, action_id: actionId, person_id: personId });
const asked = async () => {
  const r = await k.ask();
  if (!('cardId' in r)) throw new Error(r.refused);
  return r;
};
const cardOf = (cardId: string) => k.server.cards.get(cardId) as C.Card & { kind: 'pay' };

describe('Pay with ixigo money', () => {
  it('is one tap on the pay card, for the payer alone', async () => {
    const r = await asked();
    const card = cardOf(r.cardId);
    expect(card).toMatchObject({
      state: 'waiting', for_person_ids: ['p_rahul'],
      actions: [
        { action_id: 'approve', label: 'Pay with ixigo money', style: 'primary', only_for_person_ids: ['p_rahul'] },
        { action_id: 'decline', label: 'Decline', only_for_person_ids: ['p_rahul'] },
      ],
    });
    expect(card.fallback_text).toMatch(/^Rahul, pay ₹54,200 with ixigo money for /);
  });

  it('pays on the tap, with no vault page: the card says so, and the booking, the expense and the ticket follow', async () => {
    const pay = createPay(k.deps);
    const r = await asked();
    const pages = k.vault.payLinks.length;
    expect(await pay.approveTap(tap(r.cardId, 'p_priya'), cardOf(r.cardId))).toEqual({ result: 'refused', toast: 'Only Rahul can approve this payment.' });
    expect(await pay.approveTap(tap(r.cardId, 'p_rahul'), cardOf(r.cardId))).toEqual({ result: 'done', toast: TOASTS.paidWithIxigoMoney });
    await pay.settled();
    expect(k.vault.payLinks).toHaveLength(pages);
    expect(await getPayment(k.pool, r.paymentId)).toMatchObject({ state: 'paid', rail_ref: expect.stringMatching(/^ixigo_money_/) });
    expect(cardOf(r.cardId)).toMatchObject({ state: 'paid' });
    expect(cardOf(r.cardId).fallback_text).toMatch(/^Paid ₹54,200 with ixigo money for /);
    expect(cardOf(r.cardId)).not.toHaveProperty('actions');
    expect(k.server.writesOf('add_booking')).toHaveLength(1);
    expect(k.server.writesOf('add_expense').length).toBeGreaterThan(0);
    const ticket = k.server.writesOf('post_message').find((w) => (w.params.card as { kind?: string } | undefined)?.kind === 'ticket');
    expect(String(ticket?.params.text)).toMatch(/, paid with ixigo money\. A demo booking: nothing real was paid or booked on ixigo\.$/);
    // Tapped again: it is paid already, and nothing moves twice.
    expect(await pay.approveTap(tap(r.cardId, 'p_rahul'), cardOf(r.cardId))).toEqual({ result: 'refused', toast: TOASTS.paid });
    await pay.settled();
    expect(k.server.writesOf('add_booking')).toHaveLength(1);
    // Never counted as a vault payment that went without its keys.
    expect(await paidApprovalIds(k.pool)).toEqual([]);
  });

  it('a real rail keeps Approve and the vault page', async () => {
    k.deps.payRail = () => 'stripe_test';
    const pay = createPay(k.deps);
    const r = await asked();
    expect(cardOf(r.cardId).actions?.[0]).toMatchObject({ action_id: 'approve', label: 'Approve' });
    expect(await pay.approveTap(tap(r.cardId, 'p_rahul'), cardOf(r.cardId))).toMatchObject({ result: 'open', url: expect.stringMatching(/^https:\/\/vault\.test\/p\//) });
    expect((await getPayment(k.pool, r.paymentId))?.state).toBe('waiting');
  });

  it('says paid with ixigo money on the card, on the booked line and on a ticket of its own', () => {
    const input = {
      cardId: 'c_pay_1', approvalId: 'ap_1', payerPersonId: 'p_meher', payerName: 'Meher', amountMinor: 753_600, currency: 'INR', merchant: 'ixigo',
      purpose: 'IndiGo 6E2150, Fri 6 Nov, for Meher', refundableUntil: null, expiresAt: '2026-10-05T09:10:00.000Z', ixigoMoney: true,
    };
    expect(payCard(input, 'waiting').actions?.[0]).toMatchObject({ label: 'Pay with ixigo money' });
    expect(payCard(input, 'paid').fallback_text).toBe('Paid ₹7,536 with ixigo money for IndiGo 6E2150, Fri 6 Nov, for Meher.');
    expect(bookedLine({ title: 'Villa Sol, 3 nights', simulated: true, ixigoMoney: true }))
      .toBe('Booked Villa Sol, 3 nights, paid with ixigo money. A demo booking: nothing real was paid or booked on ixigo.');
    expect(ticketPaidLine({ what: 'IndiGo 6E2150, Fri 6 Nov, for Meher', payer: 'Meher', amount: '₹7,536', simulated: true, ixigoMoney: true }))
      .toBe('Meher paid ₹7,536 with ixigo money for IndiGo 6E2150, Fri 6 Nov, for Meher. A demo booking: nothing real was paid or booked on ixigo.');
    for (const text of [payCard(input, 'waiting').fallback_text, payCard(input, 'paid').fallback_text]) expect(text).not.toMatch(/Face ID|fingerprint|OTP|card number/i);
  });
});
