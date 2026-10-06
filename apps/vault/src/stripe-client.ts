import Stripe from 'stripe';

export interface SavedCard {
  paymentMethodId: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

/** The few Stripe calls the vault makes. Stripe holds the card number; the vault holds only its token. */
export interface StripeLike {
  createCustomer(personId: string): Promise<{ id: string }>;
  createSetupIntent(customerId: string): Promise<{ id: string; clientSecret: string }>;
  /** The SetupIntent as Stripe has it, read on the server, never taken from the page. */
  readSetupIntent(id: string): Promise<{ status: string; customerId: string | null; card: SavedCard | null }>;
  chargeSaved(input: {
    customerId: string;
    paymentMethodId: string;
    amountMinor: number;
    currency: string;
    description: string;
    idempotencyKey: string;
    metadata: Record<string, string>;
  }): Promise<{ id: string; status: string }>;
  /** Read only: the PaymentIntents charged with this approval jti, found by their metadata. */
  findCharges(approvalJti: string): Promise<Array<{ id: string; status: string }>>;
}

export function assertTestKey(key: string): void {
  if (!/^(sk|rk)_test_/.test(key)) throw new Error('Refusing a Stripe key that is not a test key');
}

interface RawSetupIntent {
  status: string;
  customer: string | { id: string } | null;
  payment_method:
    | string
    | { id: string; card?: { brand: string; last4: string; exp_month: number; exp_year: number } | null }
    | null;
}

export function realStripe(secretKey: string): StripeLike {
  assertTestKey(secretKey);
  const stripe = new Stripe(secretKey, { maxNetworkRetries: 1, timeout: 15_000 });
  return {
    async createCustomer(personId) {
      const c = await stripe.customers.create({ metadata: { person_id: personId } });
      return { id: c.id };
    },
    async createSetupIntent(customerId) {
      const si = await stripe.setupIntents.create({ customer: customerId, payment_method_types: ['card'], usage: 'off_session' });
      if (!si.client_secret) throw new Error('Stripe gave no client secret');
      return { id: si.id, clientSecret: si.client_secret };
    },
    async readSetupIntent(id) {
      const si = (await stripe.setupIntents.retrieve(id, { expand: ['payment_method'] })) as unknown as RawSetupIntent;
      const customerId = typeof si.customer === 'string' ? si.customer : (si.customer?.id ?? null);
      const pm = si.payment_method;
      const card =
        pm && typeof pm === 'object' && pm.card
          ? { paymentMethodId: pm.id, brand: pm.card.brand, last4: pm.card.last4, expMonth: pm.card.exp_month, expYear: pm.card.exp_year }
          : null;
      return { status: si.status, customerId, card };
    },
    async chargeSaved(i) {
      const pi = await stripe.paymentIntents.create(
        {
          amount: i.amountMinor,
          currency: i.currency.toLowerCase(),
          customer: i.customerId,
          payment_method: i.paymentMethodId,
          payment_method_types: ['card'],
          off_session: true,
          confirm: true,
          description: i.description,
          metadata: i.metadata,
        },
        { idempotencyKey: i.idempotencyKey },
      );
      return { id: pi.id, status: pi.status };
    },
    async findCharges(approvalJti) {
      const r = await stripe.paymentIntents.search({ query: `metadata['approval_jti']:'${approvalJti}'`, limit: 10 });
      return r.data.map((pi) => ({ id: pi.id, status: pi.status }));
    },
  };
}
