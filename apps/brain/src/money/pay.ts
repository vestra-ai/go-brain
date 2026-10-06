/**
 * Lane D (P5) owns this file. P1 creates it so Brain compiles. The only path to spending: hold, then
 * request_spend_approval, the pay card, the payer's Approve and passkey in the vault, then confirm and record.
 */
export interface Pay {
  askToPay(tripId: string, o: { decisionId: string; optionRef: string; purpose: string }): Promise<{ cardId: string } | { refused: string }>;
  /** apps/vault calls POST /internal/vault/paid (signed with VAULT_SHARED_SECRET); P5 finishes the booking. */
  onPaid(fn: (p: { tripId: string; approvalId: string; railRef: string }) => Promise<void>): void;
}
