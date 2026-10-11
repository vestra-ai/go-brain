import type * as C from '@go/contract';
import type { z } from 'zod';

type BookingKind = z.infer<typeof C.BookingKind>;
type Category = z.infer<typeof C.Category>;
type SpendDenialReason = z.infer<typeof C.SpendDenialReason>;

export function money(minor: number, currency: string): string {
  const whole = minor % 100 === 0;
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(minor / 100);
}

/** "1 Nov", in India time, where these trips are planned. */
export function shortDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' }).format(new Date(iso));
}

/** No em dashes in anything a person sees: a dash between two numbers becomes "to" ("6 to 9"), a dash between words becomes a comma. */
export function plain(text: string): string {
  return text
    .replace(/(\d)\s*\u2013\s*(\d)/g, '$1 to $2')
    .replace(/\s*[\u2014\u2013]\s*/g, ', ')
    .trim();
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`.slice(0, max);
}

export function categoryFor(kind: BookingKind): Category {
  switch (kind) {
    case 'stay':
      return 'stay';
    case 'flight':
    case 'train':
    case 'bus':
    case 'cab':
      return 'getting_around';
    case 'table':
      return 'food';
    case 'activity':
      return 'activities';
    case 'other':
      return 'other';
  }
}

export type RefusalCode =
  | SpendDenialReason
  | 'no_vote'
  | 'wrong_offer'
  /** The travel layer has no offer to book for the winner: a job found it by browsing, or Go never showed it. */
  | 'not_bookable'
  /** The winner is a flight, train or bus: booking those for the whole group is cut this week (master §9 "Cut now"). */
  | 'not_bookable_yet'
  | 'already_paid'
  | 'no_travel'
  | 'hold_failed'
  | 'rail_not_ready'
  | 'vault_refused'
  | 'server_down'
  | 'closed';

export interface Said {
  text: string;
  /** False when the room should hear nothing (a bug on Go's side, logged instead). */
  say: boolean;
}

/** What Go says when it will not pay, in its own voice. The model may reword it; it may never offer another way to pay. */
export function refusalWords(code: RefusalCode, c: { payer: string; what: string; amount?: string; cap?: string; kind?: string; link?: string; own?: boolean }): Said {
  const yes = (text: string): Said => ({ text, say: true });
  switch (code) {
    case 'decision_not_found':
      return { text: "I couldn't find that vote.", say: false };
    case 'no_vote':
      return yes('I can only pay for something the group voted on, and the payer approves it on their own phone. Want me to put it to a vote?');
    case 'decision_not_closed':
      return yes("The vote is still open. I'll book the winner once it closes.");
    case 'no_mandate':
      return yes("The group hasn't set what to book yet: the choice, the cap and who pays.");
    case 'payer_declined':
      return yes(declinedLine(c.what));
    case 'payer_has_not_confirmed':
      return yes(`${c.payer}, tap Yes, book it on the card above when you're ready.`);
    case 'currency_mismatch':
      return yes(`${c.what} is priced in another currency now. Want me to check again?`);
    case 'over_cap':
      return yes(`${c.what} is now ${c.amount ?? 'more'}, above the ${c.cap ?? 'cap'} the group allowed. Raise the cap or pick another option?`);
    case 'not_refundable':
      return yes(`I can't find free cancellation on ${c.what} now. Want me to look for a refundable rate?`);
    case 'approval_outstanding':
      return yes(`${c.payer}, the payment for ${c.what} is already waiting on the card above.`);
    case 'already_booked':
      // Never "wait": nothing is pending. A second payment would charge twice.
      return yes(`${c.what} is booked already. To book it again, cancel that booking first.`);
    case 'not_in_trip':
      return yes(`${c.payer} isn't in this trip any more, so I can't take a payment for their ticket. Nothing was charged.`);
    case 'no_pick':
      // Contract 1.3 (G3): the Server grants a person's own payment only for an option they tapped on their own card in the
      // last 30 minutes, at most its price plus 5%.
      return yes(`${c.payer}, pick ${c.what} again on your card: it has been a while, or the price moved. Nothing was charged.`);
    case 'wrong_offer':
      return yes(`That isn't what the group voted for. I can only pay for ${c.what}.`);
    case 'not_bookable':
      // An option from ixigo.com (TRAVEL_MODE ixigo_web) has its own page there, in its details on its card (rev 5 R5's
      // View on ixigo): a link is never in the words (the door takes any out).
      return yes(
        c.link
          ? `${c.what} is booked on ixigo, not here: View on ixigo, in its details on its card, opens it there.`
          : "I found this one on the web, so it can't be booked through me. Want the closest ones on ixigo, which I can book?",
      );
    case 'not_bookable_yet': {
      // A fare is per person, so one payment for the group would be wrong. Where Go books each person's own flight
      // (BOOKING on for the trip: own), each of them picks theirs on their own card and Go books it; otherwise the group
      // books these on ixigo themselves.
      if (c.own && (c.kind ?? 'flight') === 'flight') {
        return yes("Flights are each person's own, so there's no one payment for the group: each of you taps I'll take this on your own flights card, and I book it.");
      }
      const first = `I can't book ${c.kind === 'train' ? 'trains' : c.kind === 'bus' ? 'buses' : 'flights'} for the whole group yet.`;
      return yes(c.link ? `${first} View on ixigo, in its details on its card, opens each one set up for you.` : first);
    }
    case 'already_paid':
      return yes(`${c.what} is already booked.`);
    case 'no_travel':
      return yes("I can't book anything right now. Nothing was charged.");
    case 'hold_failed':
      return yes(`I couldn't hold ${c.what} just now. Want me to try again?`);
    case 'rail_not_ready':
      return yes("Paying this way isn't ready yet. Nothing was charged.");
    case 'vault_refused':
      // No pay page was opened: the payment never started.
      return yes("I couldn't start this payment, so nothing was charged.");
    case 'server_down':
      return yes("I couldn't reach the trip just now, so nothing was charged. Want me to try again now?");
    case 'closed':
      return yes('That payment is already closed. Want a fresh one?');
  }
}

export function failReasonWords(reason: string | null): string {
  switch (reason) {
    case 'card_declined':
      return 'the bank declined the card';
    case 'needs_authentication':
      return 'the bank wanted an extra check';
    case 'rail_not_ready':
      return "that way of paying isn't ready yet";
    default:
      return 'the payment service had a problem';
  }
}

/**
 * The line on a booking's ticket. Who paid, how much and how it is split is never in it: the Server posts its own money
 * line for each expense Go adds (rev 4 A4; the Server team's GO-TEAM-FINAL §8: "the room shows both").
 */
export function bookedLine(o: { title: string; simulated?: boolean; ixigoMoney?: boolean }): string {
  // Paid in one tap with ixigo money (the demo's mocked payment): said as paid, and as a demo, since nothing real moved.
  if (o.ixigoMoney) return `Booked ${o.title}, paid with ixigo money. A demo booking: nothing real was paid or booked on ixigo.`;
  // A booking on Go's test rail only (a stay from ixigo.com) says so: nothing was booked on ixigo, nothing real was paid.
  if (o.simulated) return `Booked (simulated): ${o.title}. A test payment only; nothing was booked on ixigo.`;
  return `Booked ${o.title}!`;
}

/** A traveller's own ticket, paid through the vault (contract 1.2). On Go's test rails nothing real was paid or booked. */
export function ticketPaidLine(o: { what: string; payer: string; amount: string; simulated: boolean; ixigoMoney?: boolean }): string {
  if (o.ixigoMoney) return `${o.payer} paid ${o.amount} with ixigo money for ${o.what}. A demo booking: nothing real was paid or booked on ixigo.`;
  if (o.simulated) return `Paid (simulated): ${o.what}. ${o.payer}'s test payment of ${o.amount}; nothing was booked on ixigo.`;
  return `${o.payer} paid ${o.amount} for ${o.what}.`;
}

export function failedLine(o: { payer: string; what: string; reason: string | null }): string {
  return `${o.payer}, the payment for ${o.what} didn't go through (${failReasonWords(o.reason)}). Nothing was charged. Want to try again?`;
}

export function declinedLine(what: string): string {
  return `Holding off on ${what} for now.`;
}

export const TOASTS = {
  notPayer: (payer: string) => `Only ${payer} can approve this payment.`,
  notPay: "This card can't take payments.",
  gone: "This payment isn't open any more.",
  paid: 'Already paid.',
  declined: 'This payment was declined.',
  failed: "This payment didn't go through. Ask Go to try again.",
  notReady: "This payment isn't ready yet.",
  fresh: 'That one timed out. Setting up a fresh payment.',
  restart: 'Setting up a fresh payment.',
  /** A traveller's ticket has no vote to ask again from: its own flow asks afresh. */
  ticketRunOut: 'That payment ran out. Tap Book it again for a fresh one.',
  noPage: "Couldn't open the payment page. Try again.",
  declinedDone: 'Declined. Nothing was charged.',
  paidWithIxigoMoney: 'Paid with ixigo money.',
  confirming: "We're confirming this payment with the bank. Don't pay again.",
  checking: "We couldn't confirm this payment. Don't pay again; we're checking.",
} as const;
