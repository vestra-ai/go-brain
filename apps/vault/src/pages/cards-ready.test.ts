import { afterEach, describe, expect, it } from 'vitest';
import { PAGE_CSP } from '../http/security.js';
import { CARDS_DOWN, CARDS_NOT_READY, isStripeError, stripeKeysSet } from '../stripe-ready.js';
import { signedInject } from '../testing/vault-test-env.js';
import { startTestVault, type TestVault } from '../testing/start-test-vault.js';
import type { TestAuthenticator } from '../testing/test-authenticator.js';

// Rev 5 R8, 10 Oct: the App team's "Save card does nothing" was the staging vault on placeholder Stripe keys. Stripe
// refused the card setup with a 401 ("Invalid API Key provided: sk_test_***…shav"), which reached the page in a shape it
// doesn't read, so the page fell back to a small grey line.
const now = new Date('2026-10-11T09:00:00Z');
const goFetch = (async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
const PLACEHOLDERS = { STRIPE_SECRET_KEY: 'sk_test_pending_from_keshav', STRIPE_PUBLISHABLE_KEY: 'pk_test_pending_from_keshav' };
const REFUSED = { type: 'StripeAuthenticationError', statusCode: 401, message: 'Invalid API Key provided: sk_test_***************shav' };
const cookieOf = (setCookie: string | string[] | undefined) => String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0] as string;

let v: TestVault | null = null;
let seconds = 0;
afterEach(async () => {
  await v?.close();
  v = null;
});

/** A vault page unlocked with the person's passkey: its path and session cookie. */
async function opened(vault: TestVault, personId: string, who: TestAuthenticator): Promise<{ path: string; cookie: string }> {
  const res = await signedInject(vault.app, { method: 'POST', url: '/internal/links', body: { person_id: personId, start: 'add_card' }, now: new Date(now.getTime() + 1000 * ++seconds) });
  const path = new URL((res.json() as { url: string }).url).pathname;
  const opts = (await vault.app.inject({ method: 'POST', url: `${path}/unlock/options`, payload: {} })).json() as { challenge_id: string; options: never };
  const done = await vault.app.inject({ method: 'POST', url: `${path}/unlock/verify`, payload: { challenge_id: opts.challenge_id, response: who.assert(opts.options) } });
  return { path, cookie: cookieOf(done.headers['set-cookie']) };
}

const state = async (vault: TestVault, o: { path: string; cookie: string }) =>
  (await vault.app.inject({ method: 'GET', url: `${o.path}/state`, headers: { cookie: o.cookie } })).json() as { cards_ready: boolean };
const setup = (vault: TestVault, o: { path: string; cookie: string }) =>
  vault.app.inject({ method: 'POST', url: `${o.path}/cards/setup`, headers: { cookie: o.cookie }, payload: {} });

describe("adding a card when the vault's Stripe keys can't add one", () => {
  it('with placeholder keys: the page says it is not ready yet, and no card setup reaches Stripe', async () => {
    v = await startTestVault({ goFetch, now: () => now, env: PLACEHOLDERS });
    const page = await opened(v, 'p_meher', await v.passkeyFor('p_meher'));
    expect(await state(v, page)).toMatchObject({ cards_ready: false });
    const res = await setup(v, page);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ message: CARDS_NOT_READY });
    expect(v.stripe.customers).toEqual([]);
    expect((await v.app.inject({ method: 'GET', url: page.path })).body).toContain('id="cards-not-ready"');
  });

  it("when Stripe refuses the keys: plain words, never Stripe's, and cards are off from then on", async () => {
    v = await startTestVault({ goFetch, now: () => now });
    const page = await opened(v, 'p_meher', await v.passkeyFor('p_meher'));
    expect(await state(v, page)).toMatchObject({ cards_ready: true });
    v.stripe.setupThrows = REFUSED;
    const res = await setup(v, page);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ message: CARDS_NOT_READY });
    expect(res.body).not.toMatch(/API Key|shav|sk_test/);
    expect(await state(v, page)).toMatchObject({ cards_ready: false });
    // Off: the next try never reaches Stripe.
    v.stripe.setupThrows = null;
    const customers = v.stripe.customers.length;
    expect((await setup(v, page)).json()).toEqual({ message: CARDS_NOT_READY });
    expect(v.stripe.customers).toHaveLength(customers);
  });

  it('when Stripe fails otherwise: try again later, and cards stay on', async () => {
    v = await startTestVault({ goFetch, now: () => now });
    const page = await opened(v, 'p_meher', await v.passkeyFor('p_meher'));
    v.stripe.setupThrows = { type: 'StripeAPIError', statusCode: 500, message: 'An error occurred with our connection to Stripe.' };
    const res = await setup(v, page);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ message: CARDS_DOWN });
    expect(await state(v, page)).toMatchObject({ cards_ready: true });
  });
});

describe("the vault's Stripe settings", () => {
  it('takes a key that says it is a placeholder for no key; test and real keys are keys', () => {
    expect(stripeKeysSet(PLACEHOLDERS)).toBe(false);
    expect(stripeKeysSet({ STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_PUBLISHABLE_KEY: 'pk_test_fake' })).toBe(true);
    expect(stripeKeysSet({ STRIPE_SECRET_KEY: 'sk_test_51NxAbC', STRIPE_PUBLISHABLE_KEY: 'pk_test_placeholder' })).toBe(false);
    expect(isStripeError(Object.assign(new Error('x'), { type: 'StripeCardError' }))).toBe(true);
    expect(isStripeError(new Error('the database went away'))).toBe(false);
  });

  it("lets Stripe.js start its frames on *.js.stripe.com, as Stripe's security guide lists", () => {
    expect(PAGE_CSP).toContain("script-src 'self' https://js.stripe.com https://*.js.stripe.com");
    expect(PAGE_CSP).toContain('frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com');
    expect(PAGE_CSP).toContain("frame-ancestors 'none'");
  });
});
