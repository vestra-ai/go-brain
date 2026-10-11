import * as C from '@go/contract';
import type { z } from 'zod';
import { clip, money, plain, shortDate } from './words.js';

export type PayCard = z.infer<typeof C.PayCard>;
export type PayCardState = PayCard['state'];
export type MandateCard = z.infer<typeof C.MandateCard>;
export type TicketCard = z.infer<typeof C.TicketCard>;

export interface PayCardInput {
  cardId: string;
  approvalId: string;
  payerPersonId: string;
  payerName: string;
  amountMinor: number;
  currency: string;
  merchant: string;
  purpose: string;
  refundableUntil: string | null;
  expiresAt: string;
  /**
   * Payment is mocked for the demo (Keshav, 11 Oct): on Go's fake rail the payer pays in one tap, with ixigo money, on
   * the card itself. No page, card form, Face ID or code. A real rail keeps Approve, which opens the vault.
   */
  ixigoMoney?: boolean;
}

/**
 * How Go draws a pay card: one of the contract's states, or 'confirming' while the vault asks the bank about a charge.
 * The contract has no state for that, so it goes out as a waiting card with no buttons and words that say so.
 */
export type PayCardLook = PayCardState | 'confirming' | 'checking';

/** The pay card in each of its states. Only the payer sees the buttons; settled cards carry none. */
export function payCard(i: PayCardInput, look: PayCardLook): PayCard {
  const amount = money(i.amountMinor, i.currency);
  const merchant = clip(plain(i.merchant), 120);
  const purpose = clip(plain(i.purpose), 200);
  const refund = i.refundableUntil ? ` Free cancellation until ${shortDate(i.refundableUntil)}.` : '';
  const fallback: Record<PayCardLook, string> = {
    waiting: i.ixigoMoney ? `${i.payerName}, pay ${amount} with ixigo money for ${purpose}.${refund}` : `${i.payerName}, approve ${amount} to ${merchant} for ${purpose}.${refund}`,
    paid: i.ixigoMoney ? `Paid ${amount} with ixigo money for ${purpose}.${refund}` : `Paid ${amount} to ${merchant} for ${purpose}.${refund}`,
    declined: `${i.payerName} declined ${amount} to ${merchant}.`,
    expired: `The payment of ${amount} to ${merchant} timed out.`,
    failed: `The payment of ${amount} to ${merchant} didn't go through. Nothing was charged.`,
    confirming: `Confirming ${amount} to ${merchant} with the bank. Don't pay again; Go will say when it's done.`,
    checking: "We couldn't confirm this payment. Don't pay again; we're checking.",
  };
  const state: PayCardState = look === 'confirming' || look === 'checking' ? 'waiting' : look;
  const only = [i.payerPersonId];
  const actions =
    look === 'waiting'
      ? [
          { action_id: 'approve', label: i.ixigoMoney ? 'Pay with ixigo money' : 'Approve', style: 'primary' as const, only_for_person_ids: only },
          { action_id: 'decline', label: 'Decline', style: 'secondary' as const, only_for_person_ids: only },
        ]
      : look === 'expired'
        ? [{ action_id: 'approve', label: 'Start again', style: 'primary' as const, only_for_person_ids: only }]
        : null;
  return C.PayCard.parse({
    card_id: i.cardId,
    kind: 'pay',
    fallback_text: clip(plain(fallback[look]), 300),
    ...(look === 'waiting' ? { for_person_ids: only } : {}),
    approval_id: i.approvalId,
    payer_person_id: i.payerPersonId,
    amount_minor: i.amountMinor,
    currency: i.currency,
    merchant,
    purpose,
    ...(i.refundableUntil ? { refundable_until: i.refundableUntil } : {}),
    expires_at: i.expiresAt,
    state,
    ...(actions ? { actions } : {}),
  });
}

/** Posted right after set_mandate. The Server draws it and shows "Yes, book it" to the payer only, so Go pins nobody. */
export function mandateCard(o: {
  cardId: string;
  decisionId: string;
  what: string;
  capMinor: number;
  currency: string;
  refundableOnly: boolean;
  payerName: string;
  /** The price moved since the vote: said first, before anyone says yes. */
  moved?: string | null;
}): MandateCard {
  const refundable = o.refundableOnly ? ', refundable only' : '';
  const moved = o.moved ? `${o.moved} ` : '';
  const text = `${moved}Ready to book ${o.what}: up to ${money(o.capMinor, o.currency)}${refundable}, ${o.payerName} pays. ${o.payerName}, open Go to say yes.`;
  return C.MandateCard.parse({ card_id: o.cardId, kind: 'mandate', decision_id: o.decisionId, fallback_text: clip(plain(text), 300) });
}

/**
 * The ticket: the Server draws it from its booking (route or stay, dates and times, the travellers). detail: who it is
 * for, when, and the seat or rooms where known, in its words for anyone who sees only the text.
 */
export function ticketCard(o: { cardId: string; bookingId: string; title: string; ref: string; refundableUntil: string | null; simulated?: boolean; detail?: string | null }): TicketCard {
  const refund = o.refundableUntil ? ` Free cancellation until ${shortDate(o.refundableUntil)}.` : '';
  const detail = o.detail ? `, ${o.detail}` : '';
  return C.TicketCard.parse({
    card_id: o.cardId,
    kind: 'ticket',
    booking_id: o.bookingId,
    fallback_text: clip(plain(`${o.simulated ? 'Booked (simulated)' : 'Booked'}: ${o.title}${detail}. Ref ${o.ref}.${refund}`), 300),
  });
}
