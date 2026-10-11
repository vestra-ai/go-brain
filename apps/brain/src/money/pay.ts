/**
 * The only path to spending. Flow: hold → request_spend_approval → pay card → the payer taps Approve →
 * the vault page → passkey → the vault checks the approval and pays the hold's rail → the vault calls Go
 * back → confirm → add_booking (with approval_id) → add_expense → cards. Any failure: cancel_spend_approval
 * and say so. Neither key is ever the model's word.
 */
import type { TicketAsk, TicketCard, TicketLink } from './ask.js';
import type { TravelDetails, TravelField } from './vault-client.js';

/**
 * A payment's word that it is paid: the vault's (POST /internal/vault/paid), or the Server's payment.completed when it paid
 * on the payer's tap itself (the demo). bookingId: the Server's own booking, written as it paid. A listener then books
 * nothing (no add_booking, no add_expense) and uses this one.
 */
export type Paid = { tripId: string; approvalId: string; railRef: string; bookingId?: string };

/** A booking on the trip, paid either way, as booked() takes it. */
export interface Booked {
  tripId: string;
  approvalId: string;
  bookingId: string;
  title: string;
  /** The booking's reference, for the ticket's words; null when Go doesn't have it (the Server's booking). */
  ref: string | null;
  refundableUntil: string | null;
  /** Nothing was booked on ixigo (Go's test rail, or the Server's demo payment): the ticket's words say so. */
  simulated: boolean;
  /** More words for the ticket: a flight's day and times, a bus's seats. */
  detail?: string | null;
  /** A person's own ticket: the card is theirs alone. Null: the group's. */
  personId: string | null;
}

export interface Pay {
  /** optionRef is the winning vote option's option_ref (an options card's option_id), never a travel offer id. */
  askToPay(tripId: string, o: { decisionId: string; optionRef: string; purpose: string }): Promise<{ cardId: string } | { refused: string }>;
  /**
   * A traveller's own ticket (never voted on): the Server's personal approval for their pick (contract 1.3: the person,
   * Go's card and the option they tapped; they are the payer), then the vault's page for them alone (open it from the
   * caller's own card; no pay card is posted). Paid, it comes through onPaid like any payment; a failure is said in the
   * room and the approval let go.
   */
  requestTicketApproval(tripId: string, o: TicketAsk): Promise<TicketLink>;
  /**
   * A traveller's own ticket with a pay card (G2): the same personal approval, then a pay card for them alone
   * (visible_to_person_ids) whose Approve opens the vault (Face ID) and whose Decline closes it, as a group's. The card's
   * id, or the words to say. Paid, it comes through onPaid like any payment, and the card shows paid.
   */
  requestTicketCard(tripId: string, o: TicketAsk): Promise<TicketCard>;
  /**
   * A traveller's own travel details from their vault (vault-client.ts), for a ticket of their own Go is booking: typed
   * only into that booking's own form on ixigo, never a log, the model, memory or a card. Null when they kept none.
   */
  travelDetails?(i: { tripId: string; personId: string; booking: { ref: string; travellerPersonId: string; purpose: string } }): Promise<TravelDetails | null>;
  /** The vault's own travel details form for a person, showing the fields a booking's one ask needs: theirs alone, minutes long. */
  travelLink?(personId: string, fields?: TravelField[]): Promise<{ url: string; expiresAt: string }>;
  /**
   * Paid: apps/vault calls POST /internal/vault/paid (signed with VAULT_SHARED_SECRET), or the Server sends
   * payment.completed with its own booking (bookingId). P5 finishes the booking; a person's flight or bus is its own flow's.
   */
  onPaid(fn: (p: Paid) => Promise<void>): void;
  /**
   * A paid booking's ticket card, whoever paid it (a person's own, for them alone), with Go's line only when Go booked it
   * (the Server's own line says it otherwise). A person's flight or bus calls it once it has the booking; a group's payment
   * posts its own in finish.ts. A retry posts the card once.
   */
  booked(b: Booked, line?: string): Promise<void>;
  /** Payments that went through without both keys, counted from the vault's unlock log and Go's payments. Always 0. */
  withoutBothKeys(): Promise<{ count: number; paid: number; charged: number }>;
}
