import type { SavedCard, StripeLike } from '../stripe-client.js';

type NextCharge = { status: string } | { error: { type: string; code: string } };

/** Stripe for tests: customers, SetupIntents and off-session charges, in memory. */
export class FakeStripe implements StripeLike {
  readonly customers: string[] = [];
  readonly setupIntents = new Map<string, { customerId: string; card: SavedCard | null; status: string }>();
  readonly charges: Array<Parameters<StripeLike['chargeSaved']>[0]> = [];
  private readonly byKey = new Map<string, { id: string; status: string }>();
  nextCharge: NextCharge = { status: 'succeeded' };
  /** The next charge throws this Stripe error once. With `afterCharging`, Stripe took the charge and the answer was lost. */
  throwOnce: { type: string; code?: string; afterCharging?: boolean } | null = null;
  /** Listing fails, the way Stripe's API can. */
  listThrows = false;
  private readonly customerByKey = new Map<string, string>();

  async createCustomer(): Promise<{ id: string }> {
    const id = `cus_${this.customers.length + 1}`;
    this.customers.push(id);
    return { id };
  }

  async createSetupIntent(customerId: string): Promise<{ id: string; clientSecret: string }> {
    const id = `seti_${this.setupIntents.size + 1}`;
    this.setupIntents.set(id, { customerId, card: null, status: 'requires_payment_method' });
    return { id, clientSecret: `${id}_secret_test` };
  }

  /** Lists what was charged under a key for that customer, as Stripe's list does (it ignores the time window). */
  async findCharges(i: { customerId: string; createdSince: Date; approvalJti: string }): Promise<Array<{ id: string; status: string }>> {
    if (this.listThrows) throw Object.assign(new Error('Stripe could not list PaymentIntents.'), { type: 'StripeAPIError' });
    const seen = this.byKey.get(i.approvalJti);
    return seen && this.customerByKey.get(i.approvalJti) === i.customerId ? [seen] : [];
  }

  /** What Stripe.js does on the vault page when the person types a test card and taps Save. */
  completeSetup(
    id: string,
    card: SavedCard = { paymentMethodId: 'pm_card_visa', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 },
  ): void {
    const si = this.setupIntents.get(id);
    if (!si) throw new Error(`no SetupIntent ${id}`);
    this.setupIntents.set(id, { ...si, card, status: 'succeeded' });
  }

  async readSetupIntent(id: string): Promise<{ status: string; customerId: string | null; card: SavedCard | null }> {
    const si = this.setupIntents.get(id);
    if (!si) throw Object.assign(new Error('No such setupintent'), { type: 'StripeInvalidRequestError' });
    return { status: si.status, customerId: si.customerId, card: si.card };
  }

  async chargeSaved(input: Parameters<StripeLike['chargeSaved']>[0]): Promise<{ id: string; status: string }> {
    const seen = this.byKey.get(input.idempotencyKey);
    if (seen) return seen;
    const once = this.throwOnce;
    if (once) {
      this.throwOnce = null;
      if (once.afterCharging) {
        this.charges.push(input);
        this.customerByKey.set(input.idempotencyKey, input.customerId);
        this.byKey.set(input.idempotencyKey, { id: `pi_${this.charges.length}`, status: 'succeeded' });
      }
      throw Object.assign(new Error('The connection to Stripe dropped.'), { type: once.type, ...(once.code ? { code: once.code } : {}) });
    }
    const next = this.nextCharge;
    if ('error' in next) throw Object.assign(new Error('The card was refused.'), next.error);
    this.charges.push(input);
    this.customerByKey.set(input.idempotencyKey, input.customerId);
    const result = { id: `pi_${this.charges.length}`, status: next.status };
    this.byKey.set(input.idempotencyKey, result);
    return result;
  }
}
