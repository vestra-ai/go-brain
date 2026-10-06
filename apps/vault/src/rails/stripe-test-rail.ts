import type { StripeLike } from '../stripe-client.js';
import type { ChargeInput, ChargeResult, Rail, RailFailReason } from './rail.js';

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
      return { failed: pi.status === 'requires_action' ? 'needs_authentication' : 'rail_error' };
    } catch (e) {
      return { failed: stripeFailure(e) };
    }
  }
}

/** Stripe's error type and code, in the vault's words. Never reads anything else off the error. */
export function stripeFailure(e: unknown): RailFailReason {
  const err = (e ?? {}) as { type?: unknown; code?: unknown };
  if (err.type === 'StripeCardError') return err.code === 'authentication_required' ? 'needs_authentication' : 'card_declined';
  return 'rail_error';
}
