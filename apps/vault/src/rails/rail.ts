/**
 * A payment rail moves money for one approved payment. Only the vault holds rails: Go never
 * charges anything, and the trip's computer holds no rail at all.
 *
 * The vault calls charge() only after the payer's passkey and the Server's approval both
 * passed, with the approval's jti as the idempotency key, so a retry never charges twice.
 *
 * ixigo: when ixigo's payment path is known, add an IxigoRail here. It takes the hold's ixigo
 * payment token (Hold.payment = { kind: 'ixigo', token }, from Travel.hold in Go), pays that
 * hold with the saved card through ixigo's checkout, and answers ixigo's payment reference as
 * railRef. Until then 'ixigo' answers rail_not_ready, and the demo runs on PAY_RAIL=stripe_test.
 */
export type RailKind = 'fake' | 'stripe_test' | 'ixigo';
export type RailFailReason = 'card_declined' | 'needs_authentication' | 'rail_error' | 'rail_not_ready';

export interface ChargeInput {
  personId: string;
  /** The saved card's processor token, opened from the vault only for this call. Never logged. */
  paymentMethodRef: string;
  amountMinor: number;
  currency: string;
  merchant: string;
  /** The spend approval's jti. */
  idempotencyKey: string;
}

/**
 * `failed` is definite: nothing was charged. `unknown` means the rail gave no clear answer (a dropped connection, a
 * server error, a payment still processing), so the money may or may not have moved: it is never settled as failed, and
 * the sweep asks the rail again with the same idempotency key.
 */
export type ChargeResult = { railRef: string } | { failed: RailFailReason } | { unknown: string };
/** A result the vault can record: paid, or a definite failure. */
export type SettledResult = Exclude<ChargeResult, { unknown: string }>;

export interface Rail {
  readonly kind: RailKind;
  charge(input: ChargeInput): Promise<ChargeResult>;
}

export type Rails = Record<RailKind, Rail>;
