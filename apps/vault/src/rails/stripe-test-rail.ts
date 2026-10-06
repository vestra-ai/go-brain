import type { StripeLike } from '../stripe-client.js';
import type { ChargeInput, ChargeResult, FindResult, Rail, RailFailReason } from './rail.js';

/** Charges a saved test card through Stripe test mode, off session, once per approval. */
export class StripeTestRail implements Rail {
  readonly kind = 'stripe_test' as const;

  constructor(
    private readonly stripe: StripeLike,
    private readonly customerOf: (personId: string) => Promise<string | null>,
  ) {}

  async charge(i: ChargeInput): Promise<ChargeResult> {
    const customerId = await this.customerOf(i.personId);
    if (!customerId) return { failed: 'rail_error' };
    try {
      const pi = await this.stripe.chargeSaved({
        customerId,
        paymentMethodId: i.paymentMethodRef,
        amountMinor: i.amountMinor,
        currency: i.currency,
        description: i.merchant.slice(0, 200),
        idempotencyKey: i.idempotencyKey,
        metadata: { approval_jti: i.idempotencyKey },
      });
      if (pi.status === 'succeeded') return { railRef: pi.id };
      // Definite: the payment stopped and nothing was charged.
      if (pi.status === 'requires_action') return { failed: 'needs_authentication' };
      if (pi.status === 'requires_payment_method') return { failed: 'card_declined' };
      if (pi.status === 'canceled') return { failed: 'rail_error' };
      // Processing, or any other state: the money may still move.
      return { unknown: `status_${pi.status}` };
    } catch (e) {
      return stripeErrorResult(e);
    }
  }

  /**
   * Read only: finds the PaymentIntent charged with this jti by its metadata (set at charge time). Succeeded is the
   * payment; no PaymentIntent, or one that stopped, means no money went out; anything else cannot be told yet. Stripe's
   * search can lag behind a fresh payment, so the caller waits before it reads `none` as final.
   */
  async find(idempotencyKey: string): Promise<FindResult> {
    if (!SEARCHABLE.test(idempotencyKey)) return { unknown: 'unsearchable_key' };
    try {
      const found = await this.stripe.findCharges(idempotencyKey);
      const paid = found.find((pi) => pi.status === 'succeeded');
      if (paid) return { railRef: paid.id };
      if (found.every((pi) => STOPPED.has(pi.status))) return { none: true };
      return { unknown: `status_${found.map((pi) => pi.status).join('_')}` };
    } catch (e) {
      const err = (e ?? {}) as { type?: unknown };
      return { unknown: typeof err.type === 'string' && err.type.startsWith('Stripe') ? err.type : 'thrown' };
    }
  }
}

/** A key safe to put in a Stripe search query as it is. Approval ids are made of these. */
const SEARCHABLE = /^[A-Za-z0-9_.:-]{1,64}$/;
/** PaymentIntent states in which no money moved and none will. */
const STOPPED: ReadonlySet<string> = new Set(['canceled', 'requires_payment_method', 'requires_action']);

/** Stripe errors that mean Stripe refused the request, so nothing was charged. */
const REFUSED: ReadonlySet<unknown> = new Set(['StripeInvalidRequestError', 'StripeAuthenticationError', 'StripePermissionError']);

/**
 * Stripe's error type and code, in the vault's words. Never reads anything else off the error. A card error or a refused
 * request is a definite failure. A dropped connection, a Stripe server error, a rate limit or any other throw is unknown:
 * Stripe may have charged before the answer was lost.
 */
export function stripeErrorResult(e: unknown): { failed: RailFailReason } | { unknown: string } {
  const err = (e ?? {}) as { type?: unknown; code?: unknown };
  if (err.type === 'StripeCardError') return { failed: err.code === 'authentication_required' ? 'needs_authentication' : 'card_declined' };
  if (REFUSED.has(err.type)) return { failed: 'rail_error' };
  return { unknown: typeof err.type === 'string' && err.type.startsWith('Stripe') ? err.type : 'thrown' };
}
