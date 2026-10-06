import { describe, expect, it } from 'vitest';
import { FakeStripe } from '../testing/fake-stripe.js';
import { realStripe } from '../stripe-client.js';
import { FakeRail } from './fake-rail.js';
import { makeRails } from './index.js';
import type { ChargeInput } from './rail.js';
import { StripeTestRail, stripeErrorResult } from './stripe-test-rail.js';

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

  it('can give no clear answer, and still pay once when asked again with the same key', async () => {
    const rail = new FakeRail('unknown');
    expect(await rail.charge(input)).toEqual({ unknown: 'fake' });
    rail.outcome = 'ok';
    expect(await rail.charge(input)).toEqual({ railRef: 'fake_ap_01JA7Q3V8Z' });
    expect(rail.charges).toHaveLength(1);
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
    stripe.nextCharge = { status: 'requires_payment_method' };
    expect(await rail.charge({ ...input, idempotencyKey: 'ap_k5' })).toEqual({ failed: 'card_declined' });
    stripe.nextCharge = { status: 'canceled' };
    expect(await rail.charge({ ...input, idempotencyKey: 'ap_k6' })).toEqual({ failed: 'rail_error' });
    stripe.nextCharge = { error: { type: 'StripeInvalidRequestError', code: 'parameter_invalid_integer' } };
    expect(await rail.charge({ ...input, idempotencyKey: 'ap_k7' })).toEqual({ failed: 'rail_error' });
  });

  it('never calls an unclear answer a failure: the money may have moved', async () => {
    const stripe = new FakeStripe();
    const rail = new StripeTestRail(stripe, customerOf);
    stripe.nextCharge = { error: { type: 'StripeAPIError', code: 'api_error' } };
    expect(await rail.charge({ ...input, idempotencyKey: 'ap_u1' })).toEqual({ unknown: 'StripeAPIError' });
    stripe.nextCharge = { error: { type: 'StripeRateLimitError', code: 'rate_limit' } };
    expect(await rail.charge({ ...input, idempotencyKey: 'ap_u2' })).toEqual({ unknown: 'StripeRateLimitError' });
    stripe.nextCharge = { status: 'processing' };
    expect(await rail.charge({ ...input, idempotencyKey: 'ap_u3' })).toEqual({ unknown: 'status_processing' });
  });

  it('answers the payment Stripe already took when the first answer was lost', async () => {
    const stripe = new FakeStripe();
    const rail = new StripeTestRail(stripe, customerOf);
    stripe.throwOnce = { type: 'StripeConnectionError', afterCharging: true };
    expect(await rail.charge(input)).toEqual({ unknown: 'StripeConnectionError' });
    expect(await rail.charge(input)).toEqual({ railRef: 'pi_1' });
    expect(stripe.charges).toHaveLength(1);
  });

  it('fails without a Stripe customer for the person', async () => {
    const rail = new StripeTestRail(new FakeStripe(), customerOf);
    expect(await rail.charge({ ...input, personId: 'p_priya' })).toEqual({ failed: 'rail_error' });
  });

  it('reads any other throw as unknown, never as a failure', () => {
    expect(stripeErrorResult(new Error('socket hang up'))).toEqual({ unknown: 'thrown' });
    expect(stripeErrorResult(undefined)).toEqual({ unknown: 'thrown' });
  });
});

describe('find, which never moves money', () => {
  const customerOf = async (personId: string) => (personId === 'p_rahul' ? 'cus_1' : null);
  const q = (idempotencyKey: string) => ({ idempotencyKey, personId: 'p_rahul', since: new Date('2026-10-05T09:01:00Z') });

  it('FakeRail answers from what it recorded, and a lost answer is still found', async () => {
    const rail = new FakeRail('lost');
    expect(await rail.charge(input)).toEqual({ unknown: 'fake' });
    expect(await rail.find(q('ap_01JA7Q3V8Z'))).toEqual({ railRef: 'fake_ap_01JA7Q3V8Z' });
    expect(await rail.find(q('ap_never_charged'))).toEqual({ none: true });
    expect(rail.charges).toHaveLength(1);
  });

  it("StripeTestRail lists the person's PaymentIntents and finds the one with the jti in its metadata", async () => {
    const stripe = new FakeStripe();
    const rail = new StripeTestRail(stripe, customerOf);
    stripe.throwOnce = { type: 'StripeConnectionError', afterCharging: true };
    expect(await rail.charge(input)).toEqual({ unknown: 'StripeConnectionError' });
    expect(await rail.find(q('ap_01JA7Q3V8Z'))).toEqual({ railRef: 'pi_1' });
    expect(await rail.find(q('ap_never_charged'))).toEqual({ none: true });
    // Another person's PaymentIntents are never theirs; a person with no Stripe customer was never charged here.
    expect(await rail.find({ ...q('ap_01JA7Q3V8Z'), personId: 'p_priya' })).toEqual({ none: true });
    expect(stripe.charges).toHaveLength(1);
  });

  it('StripeTestRail cannot tell while a payment is processing, or when the list fails', async () => {
    const stripe = new FakeStripe();
    const rail = new StripeTestRail(stripe, customerOf);
    stripe.nextCharge = { status: 'processing' };
    await rail.charge({ ...input, idempotencyKey: 'ap_processing' });
    expect(await rail.find(q('ap_processing'))).toEqual({ unknown: 'status_processing' });
    stripe.nextCharge = { status: 'requires_payment_method' };
    await rail.charge({ ...input, idempotencyKey: 'ap_declined' });
    expect(await rail.find(q('ap_declined'))).toEqual({ none: true });
    stripe.listThrows = true;
    expect(await rail.find(q('ap_processing'))).toEqual({ unknown: 'StripeAPIError' });
  });

  it('ixigo cannot tell yet', async () => {
    const rails = makeRails({ stripe: new FakeStripe(), customerOf: async () => 'cus_1' });
    expect(await rails.ixigo.find(q('ap_01JA7Q3V8Z'))).toEqual({ unknown: 'rail_not_ready' });
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
