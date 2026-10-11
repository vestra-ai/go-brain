import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signTestApproval, signedInject } from '../testing/vault-test-env.js';
import { startTestVault, type TestVault } from '../testing/start-test-vault.js';
import type { TestAuthenticator } from '../testing/test-authenticator.js';
import { moneyLabel, PAY_MESSAGES } from './words.js';

let v: TestVault;
let now = new Date('2026-10-05T09:01:00Z');
const goCalls: string[] = [];
const goFetch = (async (input: string | URL | Request) => {
  goCalls.push(new URL(input instanceof Request ? input.url : String(input)).pathname);
  return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
let rahul: TestAuthenticator;
let seconds = 0;

/** Each internal call gets its own second, so the replay guard sees distinct signatures. */
const signedAt = () => new Date(now.getTime() + 1000 * ++seconds);

async function homeLink(personId: string): Promise<string> {
  const res = await signedInject(v.app, { method: 'POST', url: '/internal/links', body: { person_id: personId }, now: signedAt() });
  return new URL((res.json() as { url: string }).url).pathname;
}

async function payPath(jti: string, payer = 'p_rahul'): Promise<string> {
  const body = {
    approval: signTestApproval({ jti, payer_person_id: payer }),
    approval_id: jti,
    trip_id: 't_goa',
    payer_person_id: payer,
    payer_name: 'Rahul',
    hold: { hold_id: `hold_${jti}`, amount_minor: 5420000, currency: 'INR', merchant: 'ixigo: Villa Sol, Anjuna', payment_kind: 'fake', expires_at: '2026-10-05T09:30:00Z' },
  };
  const res = await signedInject(v.app, { method: 'POST', url: '/internal/pay-links', body, now: signedAt() });
  return new URL((res.json() as { url: string }).url).pathname;
}

const cookieOf = (setCookie: string | string[] | undefined) => String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0] as string;

beforeAll(async () => {
  v = await startTestVault({ goFetch, now: () => now });
  rahul = await v.passkeyFor('p_rahul', { withCard: true });
});
afterAll(async () => {
  await v.close();
});

describe('every response', () => {
  it('forbids framing and sends no referrer', async () => {
    // An approve page may be framed by the App's origins (rev 5 R8: pages/embedded.test.ts); nothing else may.
    for (const url of ['/l/x', '/l/x/state', '/p/x/info', '/static/vault.js', '/static/vault.css', '/static/webauthn.js']) {
      const res = await v.app.inject({ method: 'GET', url });
      expect(res.headers['x-frame-options'], url).toBe('DENY');
      expect(String(res.headers['content-security-policy']), url).toContain("frame-ancestors 'none'");
      expect(res.headers['referrer-policy'], url).toBe('no-referrer');
    }
  });
});

describe('the pages', () => {
  it('are plain HTML with no em dash, no vendor name and no token inside', async () => {
    const path = await homeLink('p_rahul');
    for (const url of [path, '/p/AAAA']) {
      const res = await v.app.inject({ method: 'GET', url });
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).not.toMatch(/\u2014|Claude|Anthropic|OpenAI/);
      expect(res.body).not.toContain(path.split('/')[2]);
      expect(res.body).toContain('/static/webauthn.js');
    }
    const js = await v.app.inject({ method: 'GET', url: '/static/vault.js' });
    expect(js.body).not.toMatch(/\u2014/);
  });

  it('serve the browser passkey library', async () => {
    const res = await v.app.inject({ method: 'GET', url: '/static/webauthn.js' });
    expect(res.body).toContain('SimpleWebAuthnBrowser');
  });
});

describe('the home page', () => {
  it('asks a new person to set up Face ID, and a returning one to unlock', async () => {
    const meher = await homeLink('p_meher');
    expect((await v.app.inject({ method: 'GET', url: `${meher}/state` })).json()).toEqual({ state: 'register' });
    const again = await homeLink('p_rahul');
    expect((await v.app.inject({ method: 'GET', url: `${again}/state` })).json()).toEqual({ state: 'unlock' });
  });

  it('opens after the owner unlocks, and lists cards and the unlock log', async () => {
    const path = await homeLink('p_rahul');
    const opts = (await v.app.inject({ method: 'POST', url: `${path}/unlock/options`, payload: {} })).json() as { challenge_id: string; options: { challenge: string } };
    const res = await v.app.inject({
      method: 'POST',
      url: `${path}/unlock/verify`,
      payload: { challenge_id: opts.challenge_id, response: rahul.assert(opts.options as never) },
    });
    expect(res.statusCode).toBe(200);
    const cookie = cookieOf(res.headers['set-cookie']);
    expect(String(res.headers['set-cookie'])).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    const state = (await v.app.inject({ method: 'GET', url: `${path}/state`, headers: { cookie } })).json() as {
      state: string;
      cards: Array<{ brand_label: string; last4: string; expires: string }>;
      log: Array<{ text: string }>;
    };
    expect(state.state).toBe('open');
    expect(state.cards).toEqual([{ brand_label: 'Visa', last4: '4242', expires: '12/30' }]);
    expect(state.log.map((l) => l.text)).toContain('Added a card');
  });

  it('offers "Add a card" only: no login form, no login in its state, and no route to save one', async () => {
    const path = await homeLink('p_rahul');
    const page = await v.app.inject({ method: 'GET', url: path });
    expect(page.body).toContain('Add a card');
    expect(page.body).not.toMatch(/login|password/i);
    const opts = (await v.app.inject({ method: 'POST', url: `${path}/unlock/options`, payload: {} })).json() as { challenge_id: string; options: never };
    const unlocked = await v.app.inject({ method: 'POST', url: `${path}/unlock/verify`, payload: { challenge_id: opts.challenge_id, response: rahul.assert(opts.options) } });
    const cookie = cookieOf(unlocked.headers['set-cookie']);
    const state = await v.app.inject({ method: 'GET', url: `${path}/state`, headers: { cookie } });
    expect(state.json()).not.toHaveProperty('logins');
    const tried = await v.app.inject({ method: 'POST', url: `${path}/logins`, headers: { cookie }, payload: { site: 'ixigo.com', username: 'rahul@example.com', password: 'hunter2-goa' } });
    expect(tried.statusCode).toBe(404);
    expect(tried.body).not.toContain('hunter2');
  });

  it('refuses card changes without an unlocked session', async () => {
    const path = await homeLink('p_rahul');
    expect((await v.app.inject({ method: 'POST', url: `${path}/cards/setup`, payload: {} })).statusCode).toBe(401);
  });

  it("does not let someone else's passkey unlock the vault", async () => {
    const priya = await v.passkeyFor('p_priya');
    const path = await homeLink('p_rahul');
    const opts = (await v.app.inject({ method: 'POST', url: `${path}/unlock/options`, payload: {} })).json() as { challenge_id: string; options: never };
    const res = await v.app.inject({ method: 'POST', url: `${path}/unlock/verify`, payload: { challenge_id: opts.challenge_id, response: priya.assert(opts.options) } });
    expect(res.statusCode).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('says a link has expired after 5 minutes', async () => {
    const path = await homeLink('p_rahul');
    now = new Date(now.getTime() + 6 * 60_000);
    try {
      expect((await v.app.inject({ method: 'GET', url: `${path}/state` })).json()).toEqual({ state: 'expired' });
    } finally {
      now = new Date('2026-10-05T09:01:00Z');
    }
  });
});

describe('the pay page', () => {
  it('shows what the Server approved, pays with Face ID once, and tells Go', async () => {
    const path = await payPath('ap_page_00001');
    const info = (await v.app.inject({ method: 'GET', url: `${path}/info` })).json() as Record<string, unknown>;
    expect(info).toMatchObject({
      state: 'ready',
      amount_label: '₹54,200',
      merchant: 'ixigo: Villa Sol, Anjuna',
      purpose: 'Villa Sol, 3 nights, 6 to 9 Nov',
      card_label: 'Visa ending 4242',
    });
    expect(String(info.refundable_label)).toContain('1 Nov');
    expect(await v.approve(`https://vault.test${path}`, rahul)).toEqual({ state: 'paid', message: PAY_MESSAGES.paid });
    expect(goCalls.at(-1)).toBe('/internal/vault/paid');
    expect(await v.approve(`https://vault.test${path}`, rahul)).toEqual({ state: 'refused', message: PAY_MESSAGES.link_used });
    expect((await v.app.inject({ method: 'GET', url: `${path}/info` })).json()).toMatchObject({ state: 'used' });
  });

  it('tells a payer without a passkey to set up the vault first', async () => {
    const path = await payPath('ap_page_00002', 'p_kabir');
    expect((await v.app.inject({ method: 'GET', url: `${path}/info` })).json()).toMatchObject({ state: 'no_passkey' });
    expect((await v.app.inject({ method: 'POST', url: `${path}/options`, payload: {} })).statusCode).toBe(409);
  });
});

describe('words', () => {
  it('formats rupees the Indian way and says nothing with an em dash', () => {
    expect(moneyLabel(5420000, 'INR')).toBe('₹54,200');
    expect(moneyLabel(5420050, 'INR')).toBe('₹54,200.50');
    expect(Object.values(PAY_MESSAGES).join(' ')).not.toMatch(/\u2014/);
  });
});
