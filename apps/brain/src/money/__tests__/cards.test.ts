import * as C from '@go/contract';
import { describe, expect, it } from 'vitest';
import { mandateCard, payCard, ticketCard, type PayCardInput } from '../cards.js';

const villa: PayCardInput = {
  cardId: 'c_villa_pay',
  approvalId: 'ap_01JA7Q3V8Z',
  payerPersonId: 'p_rahul',
  payerName: 'Rahul',
  amountMinor: 5420000,
  currency: 'INR',
  merchant: 'ixigo: Villa Sol, Anjuna',
  purpose: 'Villa Sol, 3 nights, 6 to 9 Nov',
  refundableUntil: '2026-11-01T18:29:59Z',
  expiresAt: '2026-10-05T09:10:00Z',
};

describe('pay card', () => {
  it('waits for the payer, with buttons only the payer sees', () => {
    const card = payCard(villa, 'waiting');
    expect(C.Card.parse(card)).toEqual(card);
    expect(card).toMatchObject({
      kind: 'pay',
      state: 'waiting',
      for_person_ids: ['p_rahul'],
      approval_id: 'ap_01JA7Q3V8Z',
      amount_minor: 5420000,
      refundable_until: '2026-11-01T18:29:59Z',
      fallback_text: 'Rahul, approve ₹54,200 to ixigo: Villa Sol, Anjuna for Villa Sol, 3 nights, 6 to 9 Nov. Free cancellation until 1 Nov.',
    });
    expect(card.actions).toEqual([
      { action_id: 'approve', label: 'Approve', style: 'primary', only_for_person_ids: ['p_rahul'] },
      { action_id: 'decline', label: 'Decline', style: 'secondary', only_for_person_ids: ['p_rahul'] },
    ]);
  });

  it('drops the buttons and the pin once settled', () => {
    for (const state of ['paid', 'declined', 'failed'] as const) {
      const card = payCard(villa, state);
      expect(card.state).toBe(state);
      expect(card.actions ?? null).toBeNull();
      expect(card.for_person_ids ?? null).toBeNull();
    }
  });

  it('offers the payer a fresh start when it expired', () => {
    expect(payCard(villa, 'expired').actions).toEqual([
      { action_id: 'approve', label: 'Start again', style: 'primary', only_for_person_ids: ['p_rahul'] },
    ]);
  });

  it('never carries an em dash, even when the purpose had one', () => {
    const card = payCard({ ...villa, purpose: 'Villa Sol \u2014 3 nights' }, 'waiting');
    expect(JSON.stringify(card)).not.toMatch(/\u2014/);
  });

  it('says the bank is being asked, as a waiting card with no buttons and no pin', () => {
    const card = payCard(villa, 'confirming');
    expect(C.Card.parse(card)).toEqual(card);
    expect(card.state).toBe('waiting');
    expect(card.actions ?? null).toBeNull();
    expect(card.for_person_ids ?? null).toBeNull();
    expect(card.fallback_text).toBe("Confirming ₹54,200 to ixigo: Villa Sol, Anjuna with the bank. Don't pay again; Go will say when it's done.");
  });

  it('says a person is checking once the vault stopped asking the bank, still with no buttons', () => {
    const card = payCard(villa, 'checking');
    expect(C.Card.parse(card)).toEqual(card);
    expect(card).toMatchObject({ state: 'waiting', fallback_text: "We couldn't confirm this payment. Don't pay again; we're checking." });
    expect(card.actions ?? null).toBeNull();
    expect(JSON.stringify(card)).not.toContain('Nothing was charged');
  });

  it('leaves free cancellation out when there is none', () => {
    const card = payCard({ ...villa, refundableUntil: null }, 'waiting');
    expect(card.refundable_until ?? null).toBeNull();
    expect(card.fallback_text).not.toContain('Free cancellation');
  });
});

describe('mandate and ticket cards', () => {
  it('builds a mandate card for the vote, without pins', () => {
    const card = mandateCard({ cardId: 'c_m', decisionId: 'd_villa', what: 'Villa Sol', capMinor: 5500000, currency: 'INR', refundableOnly: true, payerName: 'Rahul' });
    expect(C.Card.parse(card)).toEqual(card);
    expect(card.fallback_text).toBe('Ready to book Villa Sol: up to ₹55,000, refundable only, Rahul pays. Rahul, open Go to say yes.');
    expect(card.for_person_ids ?? null).toBeNull();
  });

  it('builds a ticket card for the booking', () => {
    const card = ticketCard({ cardId: 'c_t', bookingId: 'b_villa', title: 'Villa Sol, 3 nights', ref: 'IXG-7Q2K9', refundableUntil: '2026-11-01T18:29:59Z' });
    expect(C.Card.parse(card)).toEqual(card);
    expect(card.fallback_text).toBe('Booked: Villa Sol, 3 nights. Ref IXG-7Q2K9. Free cancellation until 1 Nov.');
  });
});
