import { afterEach, describe, expect, it } from 'vitest';
import { masterKeyOf } from '../crypto/envelope.js';
import { DEMO_ONLY, DEMO_OTP } from '../demo-cards.js';
import { approvePayment, payOptions } from '../pay.js';
import { openCardRef, saveDemoCard } from '../store/cards.js';
import { payFixture, type PayFixture } from '../testing/pay-fixtures.js';
import { startTestVault, type TestVault } from '../testing/start-test-vault.js';
import type { TestAuthenticator } from '../testing/test-authenticator.js';
import { signedInject } from '../testing/vault-test-env.js';
import { VAULT_JS } from './assets.js';
import { homePage, payPage } from './html.js';

// Keshav, 11 Oct: "we dont have access to stripe in India". With no Stripe keys, a card is one of the demo's test cards,
// matched on the phone and named to the vault, never typed to it; a payment asks for the demo's bank code after Face ID.
const now = new Date('2026-10-11T09:00:00Z');
const goFetch = (async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
const PLACEHOLDERS = { STRIPE_SECRET_KEY: 'sk_test_pending_from_keshav', STRIPE_PUBLISHABLE_KEY: 'pk_test_pending_from_keshav' };
const cookieOf = (setCookie: string | string[] | undefined) => String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0] as string;

let v: TestVault | null = null;
let f: PayFixture | null = null;
let seconds = 0;
afterEach(async () => {
  await v?.close();
  await f?.drop();
  v = null;
  f = null;
});

async function opened(vault: TestVault, personId: string, who: TestAuthenticator): Promise<{ path: string; cookie: string }> {
  const res = await signedInject(vault.app, { method: 'POST', url: '/internal/links', body: { person_id: personId, start: 'add_card' }, now: new Date(now.getTime() + 1000 * ++seconds) });
  const path = new URL((res.json() as { url: string }).url).pathname;
  const opts = (await vault.app.inject({ method: 'POST', url: `${path}/unlock/options`, payload: {} })).json() as { challenge_id: string; options: never };
  const done = await vault.app.inject({ method: 'POST', url: `${path}/unlock/verify`, payload: { challenge_id: opts.challenge_id, response: who.assert(opts.options) } });
  return { path, cookie: cookieOf(done.headers['set-cookie']) };
}
const addDemo = (vault: TestVault, o: { path: string; cookie: string }, body: Record<string, unknown>) =>
  vault.app.inject({ method: 'POST', url: `${o.path}/cards/demo`, headers: { cookie: o.cookie }, payload: body });

describe("the demo's cards, while the vault has no Stripe keys", () => {
  it('adds a test card by its name alone: brand, last four and expiry kept, its demo token sealed, never a number', async () => {
    v = await startTestVault({ goFetch, now: () => now, env: PLACEHOLDERS });
    const page = await opened(v, 'p_meher', await v.passkeyFor('p_meher'));
    const res = await addDemo(v, page, { card: 'visa_4242', exp_month: 12, exp_year: 2029 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ brand_label: 'Visa', last4: '4242' });
    const state = (await v.app.inject({ method: 'GET', url: `${page.path}/state`, headers: { cookie: page.cookie } })).json() as Record<string, unknown>;
    expect(state).toMatchObject({ cards_mode: 'demo', cards: [{ brand_label: 'Visa', last4: '4242', expires: '12/29' }] });
    const rows = (await v.pool.query<{ card_id: string; brand: string; last4: string }>('select card_id, brand, last4 from cards where person_id = $1', ['p_meher'])).rows;
    expect(rows).toEqual([{ card_id: expect.any(String), brand: 'visa', last4: '4242' }]);
    expect(await openCardRef(v.pool, masterKeyOf(v.env.VAULT_MASTER_KEY), 'p_meher', rows[0]!.card_id)).toBe('demo_visa_4242');
    expect(v.stripe.customers).toEqual([]);
  });

  it("refuses any card that isn't a test card, named or as a number, and an expired one, and keeps nothing", async () => {
    v = await startTestVault({ goFetch, now: () => now, env: PLACEHOLDERS });
    const page = await opened(v, 'p_meher', await v.passkeyFor('p_meher'));
    const refused = [
      { card: 'mastercard_5555', exp_month: 12, exp_year: 2029 },
      { number: '4111111111111111', exp_month: 12, exp_year: 2029 },
      { card: 'visa_4242', number: '4242424242424242', exp_month: 12, exp_year: 2029 },
      { card: 'visa_4242', cvv: '123', exp_month: 12, exp_year: 2029 },
    ];
    for (const body of refused) {
      const res = await addDemo(v, page, body);
      expect(res.statusCode, JSON.stringify(Object.keys(body))).toBe(400);
      expect(res.json()).toEqual({ message: DEMO_ONLY });
    }
    expect((await addDemo(v, page, { card: 'visa_4242', exp_month: 9, exp_year: 2026 })).statusCode).toBe(400);
    expect((await v.pool.query('select 1 from cards')).rowCount).toBe(0);
  });

  it("is off with real Stripe keys: Stripe's own form takes cards there", async () => {
    v = await startTestVault({ goFetch, now: () => now });
    const page = await opened(v, 'p_meher', await v.passkeyFor('p_meher'));
    expect((await addDemo(v, page, { card: 'visa_4242', exp_month: 12, exp_year: 2029 })).statusCode).toBe(409);
    expect((await v.app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ ok: true, cards: 'ready' });
  });

  it('pays after Face ID and the bank code 123456 only: a missing or wrong code pays nothing', async () => {
    f = await payFixture();
    f.d.otp = DEMO_OTP;
    const rahul = await f.registerFor('p_rahul');
    await saveDemoCard(f.pool, masterKeyOf(f.env.VAULT_MASTER_KEY), f.now(), { personId: 'p_rahul', card: 'visa_4242', expMonth: 12, expYear: 2029 });
    const { token } = await f.payLinkFor();
    const fx = f;
    const pay = async (otp?: string) => {
      const opts = await payOptions(fx.d, token);
      if (!opts.ok) throw new Error(opts.reason);
      return approvePayment(fx.d, { token, challengeId: opts.challengeId, response: rahul.assert(opts.options), ...(otp !== undefined ? { otp } : {}) });
    };
    expect(await pay()).toEqual({ state: 'refused', reason: 'otp_wrong' });
    expect(await pay('000000')).toEqual({ state: 'refused', reason: 'otp_wrong' });
    expect(f.rail.charges).toEqual([]);
    expect(await pay(DEMO_OTP)).toMatchObject({ state: 'paid' });
    expect(f.rail.charges).toEqual([expect.objectContaining({ personId: 'p_rahul', paymentMethodRef: 'demo_visa_4242', amountMinor: 5420000 })]);
  });

  it('the decline test card: the bank says no, and nothing moves', async () => {
    f = await payFixture();
    f.d.otp = DEMO_OTP;
    const rahul = await f.registerFor('p_rahul');
    await saveDemoCard(f.pool, masterKeyOf(f.env.VAULT_MASTER_KEY), f.now(), { personId: 'p_rahul', card: 'visa_decline', expMonth: 12, expYear: 2029 });
    const { token } = await f.payLinkFor();
    const opts = await payOptions(f.d, token);
    if (!opts.ok) throw new Error(opts.reason);
    expect(await approvePayment(f.d, { token, challengeId: opts.challengeId, response: rahul.assert(opts.options), otp: DEMO_OTP })).toEqual({ state: 'failed', reason: 'card_declined' });
    expect(f.rail.charges).toEqual([]);
  });

  it('on the page: the number is matched on the phone and never sent, never a saved card offered, the demo said plainly', () => {
    expect(VAULT_JS).toContain("const DEMO = { '4242424242424242': 'visa_4242', '4000000000000002': 'visa_decline' };");
    expect(VAULT_JS).toContain("api('/cards/demo', { card, exp_month: month, exp_year: 2000 + Number(exp[2]) })");
    const home = homePage();
    expect(home).toContain('Demo build: no money moves. Use the test card 4242 4242 4242 4242.');
    expect(home).toContain('Fill test card');
    expect(home).toMatch(/id="dc-number"[^>]*autocomplete="off"/);
    expect(home).not.toContain('cc-number');
    const pay = payPage();
    expect(pay).toContain('Demo OTP: 123456');
    expect(pay).toContain('Demo build: no money moves.');
  });
});
