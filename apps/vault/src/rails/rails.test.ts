import { describe, expect, it } from 'vitest';
import { FakeStripe } from '../testing/fake-stripe.js';
import { realStripe } from '../stripe-client.js';
import { FakeRail } from './fake-rail.js';
import { makeRails } from './index.js';
import type { ChargeInput } from './rail.js';
import { StripeTestRail, stripeFailure } from './stripe-test-rail.js';

const input: ChargeInput = {
  personId: 'p_rahul',
  paymentMethodRef: 'pm_card_visa',
  amountMinor: 5420000,
  currency: 'INR',
  merchant: 'ixigo: Villa Sol, Anjuna',
  idempotencyKey: 'ap_01JA7Q3V8Z',
};

describe('FakeRail', () => {
  it('pays once per idempotency key', async () => {
    const rail = new FakeRail();
    expect(await rail.charge(input)).toEqual({ railRef: 'fake_ap_01JA7Q3V8Z' });
    expect(await rail.charge(input)).toEqual({ railRef: 'fake_ap_01JA7Q3V8Z' });
    expect(rail.charges).toHaveLength(1);
  });

  it('fails the way it is told to', async () => {
    expect(await new FakeRail('card_declined').charge(input)).toEqual({ failed: 'card_declined' });
  });
});

describe('StripeTestRail', () => {
  const customerOf = async (personId: string) => (personId === 'p_rahul' ? 'cus_1' : null);

  it('charges the saved card off session with the approval jti as the idempotency key', async () => {
    const stripe = new FakeStripe();
    const rail = new StripeTestRail(stripe, customerOf);
    expect(await rail.charge(input)).toEqual({ railRef: 'pi_1' });
    expect(stripe.charges[0]).toEqual({
      customerId: 'cus_1',
      paymentMethodId: 'pm_card_visa',
      amountMinor: 5420000,
      currency: 'INR',
      description: 'ixigo: Villa Sol, Anjuna',
      idempotencyKey: 'ap_01JA7Q3V8Z',
      metadata: { approval_jti: 'ap_01JA7Q3V8Z' },
    });
  });

  it('answers the same payment for the same key, so a retry never charges twice', async () => {
    const stripe = new FakeStripe();
    const rail = new StripeTestRail(stripe, customerOf);
    await rail.charge(input);
    await rail.charge(input);
    expect(stripe.charges).toHaveLength(1);
  });

  it('turns declines and extra checks into plain reasons', async () => {
    const stripe = new FakeStripe();
    const rail = new StripeTestRail(stripe, customerOf);
    stripe.nextCharge = { error: { type: 'StripeCardError', code: 'card_declined' } };
    expect(await rail.charge({ ...input, idempotencyKey: 'ap_k2' })).toEqual({ failed: 'card_declined' });
    stripe.nextCharge = { error: { type: 'StripeCardError', code: 'authentication_required' } };
    expect(await rail.charge({ ...input, idempotencyKey: 'ap_k3' })).toEqual({ failed: 'needs_authentication' });
    stripe.nextCharge = { status: 'requires_action' };
    expect(await rail.charge({ ...input, idempotencyKey: 'ap_k4' })).toEqual({ failed: 'needs_authentication' });
    stripe.nextCharge = { error: { type: 'StripeAPIError', code: 'api_error' } };
    expect(await rail.charge({ ...input, idempotencyKey: 'ap_k5' })).toEqual({ failed: 'rail_error' });
  });

  it('fails without a Stripe customer for the person', async () => {
    const rail = new StripeTestRail(new FakeStripe(), customerOf);
    expect(await rail.charge({ ...input, personId: 'p_priya' })).toEqual({ failed: 'rail_error' });
  });

  it('maps unknown errors to rail_error', () => {
    expect(stripeFailure(new Error('socket hang up'))).toBe('rail_error');
  });
});

describe('the rails together', () => {
  it('keeps ixigo as a seam that is not ready', async () => {
    const rails = makeRails({ stripe: new FakeStripe(), customerOf: async () => 'cus_1' });
    expect(await rails.ixigo.charge(input)).toEqual({ failed: 'rail_not_ready' });
    expect(rails.fake.kind).toBe('fake');
    expect(rails.stripe_test.kind).toBe('stripe_test');
  });
});

describe('realStripe', () => {
  it('refuses a live key before any network call', () => {
    expect(() => realStripe('sk_live_123')).toThrow(/not a test key/);
  });
});
