/**
 * The only path to spending. Flow: hold → request_spend_approval → pay card → the payer taps Approve →
 * the vault page → passkey → the vault checks the approval and pays the hold's rail → the vault calls Go
 * back → confirm → add_booking (with approval_id) → add_expense → cards. Any failure: cancel_spend_approval
 * and say so. Neither key is ever the model's word.
 */
import type { TicketAsk, TicketLink } from './ask.js';

export interface Pay {
  /** optionRef is the winning vote option's option_ref (an options card's option_id), never a travel offer id. */
  askToPay(tripId: string, o: { decisionId: string; optionRef: string; purpose: string }): Promise<{ cardId: string } | { refused: string }>;
  /**
   * A traveller's own ticket (contract 1.2, never voted on): the Server's ticket approval for that person, who is the
   * payer, then the vault's page for them alone (open it from the caller's own card; no pay card is posted). Paid, it
   * comes through onPaid like any payment; a failure is said in the room and the approval let go.
   */
  requestTicketApproval(tripId: string, o: TicketAsk): Promise<TicketLink>;
  /** apps/vault calls POST /internal/vault/paid (signed with VAULT_SHARED_SECRET); P5 finishes the booking. */
  onPaid(fn: (p: { tripId: string; approvalId: string; railRef: string }) => Promise<void>): void;
  /** Payments that went through without both keys, counted from the vault's unlock log and Go's payments. Always 0. */
  withoutBothKeys(): Promise<{ count: number; paid: number; charged: number }>;
}
