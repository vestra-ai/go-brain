import type { PayRefusal } from '../pay.js';
import type { RailFailReason } from '../rails/rail.js';
import type { UnlockRow } from '../store/unlock-log.js';

export function moneyLabel(minor: number, currency: string): string {
  const whole = minor % 100 === 0;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

/** "Sun, 1 Nov, 11:59 pm" in India time, where the trips are planned. */
export function whenLabel(at: string | Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(at));
}

const BRANDS: Record<string, string> = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', rupay: 'RuPay', discover: 'Discover', diners: 'Diners Club', jcb: 'JCB', unionpay: 'UnionPay' };

export function brandLabel(brand: string): string {
  return BRANDS[brand] ?? 'Card';
}

const CANT = "Go can't take this payment. Nothing was charged.";

export const PAY_MESSAGES: Record<'paid' | PayRefusal | RailFailReason, string> = {
  paid: 'Paid. Go is booking it now. You can close this page.',
  card_declined: 'Your bank declined the card. Nothing was charged.',
  needs_authentication: "Your bank wants an extra check this card can't do here. Nothing was charged.",
  rail_error: "The payment didn't go through. Nothing was charged. Ask Go to try again.",
  rail_not_ready: "This way of paying isn't ready yet. Nothing was charged.",
  link_invalid: "This link doesn't work. Tap Approve on the card in Go again.",
  link_used: 'This payment link was already used.',
  link_expired: 'This link has expired. Tap Approve on the card in Go again.',
  passkey_failed: "Your passkey didn't confirm it. Try again.",
  not_the_payer: 'Only the payer can approve this payment.',
  bad_approval: CANT,
  approval_expired: 'This approval ran out. Ask Go to set it up again.',
  wrong_audience: CANT,
  wrong_trip: CANT,
  used: 'This payment was already made.',
  currency_mismatch: CANT,
  over_amount: CANT,
  hold_expiring: 'The hold on this booking ran out. Ask Go to set it up again.',
  no_card: 'Add a card in your vault first: in Go, open You, then My vault.',
};

export function unlockLine(row: UnlockRow): string {
  const amount = row.amount_minor !== null && row.currency ? moneyLabel(row.amount_minor, row.currency) : '';
  const to = row.merchant ? ` to ${row.merchant}` : '';
  switch (row.kind) {
    case 'passkey_added':
      return 'Set up Face ID for your vault';
    case 'unlock':
      return 'Opened your vault';
    case 'card_added':
      return 'Added a card';
    case 'pay_attempt':
      return `Approved ${amount}${to}`;
    case 'pay_ok':
      return `Paid ${amount}${to}`;
    case 'pay_failed':
      return `A payment of ${amount}${to} didn't go through`;
    case 'pay_refused':
      return `Refused a payment of ${amount}${to}`;
  }
}
