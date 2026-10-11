/**
 * The only path to spending. Flow: hold → request_spend_approval → pay card → the payer taps Approve →
 * the vault page → passkey → the vault checks the approval and pays the hold's rail → the vault calls Go
 * back → confirm → add_booking (with approval_id) → add_expense → cards. Any failure: cancel_spend_approval
 * and say so. Neither key is ever the model's word.
 */
import type { TicketAsk, TicketCard, TicketLink } from './ask.js';
import type { TravelDetails } from './vault-client.js';

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
  /** The vault's own travel details form for a person, for a booking's one ask: a link for them alone, a few minutes long. */
  travelLink?(personId: string): Promise<{ url: string; expiresAt: string }>;
  /** apps/vault calls POST /internal/vault/paid (signed with VAULT_SHARED_SECRET); P5 finishes the booking. */
  onPaid(fn: (p: { tripId: string; approvalId: string; railRef: string }) => Promise<void>): void;
  /** Payments that went through without both keys, counted from the vault's unlock log and Go's payments. Always 0. */
  withoutBothKeys(): Promise<{ count: number; paid: number; charged: number }>;
}
