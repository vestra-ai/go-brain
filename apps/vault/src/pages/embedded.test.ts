import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VAULT_JS } from './assets.js';
import { signedInject } from '../testing/vault-test-env.js';
import { startTestVault, type TestVault } from '../testing/start-test-vault.js';
import type { TestAuthenticator } from '../testing/test-authenticator.js';

// Rev 5 R8 (contract 1.3 CreateLink.display): the vault inside the App, for the unlock and the approve pages only. Card
// entry stays in the browser sheet (Stripe: avoid placing its payment element within another iframe; PCI 4.0 scope).
const now = new Date('2026-10-11T09:00:00Z');
const goFetch = (async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
const APP = "frame-ancestors https://app.test http://localhost:3000";
let v: TestVault;
let meher: TestAuthenticator;
let seconds = 0;
const signedAt = () => new Date(now.getTime() + 1000 * ++seconds);

const link = (body: Record<string, unknown>) => signedInject(v.app, { method: 'POST', url: '/internal/links', body: { person_id: 'p_meher', ...body }, now: signedAt() });
const pathOf = async (body: Record<string, unknown>) => new URL(((await link(body)).json() as { url: string }).url).pathname;

/** Unlocks the page with Meher's passkey: the verify's answer, and its cookie. */
async function unlock(path: string): Promise<{ answer: Record<string, unknown>; cookie: string }> {
  const opts = (await v.app.inject({ method: 'POST', url: `${path}/unlock/options`, payload: {} })).json() as { challenge_id: string; options: never };
  const res = await v.app.inject({ method: 'POST', url: `${path}/unlock/verify`, payload: { challenge_id: opts.challenge_id, response: meher.assert(opts.options) } });
  return { answer: res.json() as Record<string, unknown>, cookie: String(res.headers['set-cookie']).split(';')[0]! };
}
const stateOf = async (path: string, headers: Record<string, string>) => ((await v.app.inject({ method: 'GET', url: `${path}/state`, headers })).json() as { state: string }).state;

beforeAll(async () => {
  v = await startTestVault({ goFetch, now: () => now });
  meher = await v.passkeyFor('p_meher');
});
afterAll(async () => {
  await v.close();
});

describe('the vault inside the App', () => {
  it("lets the App's origins, and no others, frame an embedded unlock page; a sheet page stays unframeable", async () => {
    const embedded = await v.app.inject({ method: 'GET', url: await pathOf({ display: 'embedded' }) });
    expect(String(embedded.headers['content-security-policy'])).toContain(APP);
    expect(embedded.headers['x-frame-options']).toBeUndefined();
    expect(embedded.body).toContain('data-display="embedded"');
    expect(embedded.body).toContain('data-frame-origins="https://app.test http://localhost:3000"');
    for (const sheet of [await pathOf({}), await pathOf({ display: 'sheet' })]) {
      const res = await v.app.inject({ method: 'GET', url: sheet });
      expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.body).not.toContain('data-display');
    }
  });

  it("lets the App's origins frame an approve page, which says when it is done to its parent", async () => {
    // The page's own document: the same for any pay link, its frame headers too.
    const res = await v.app.inject({ method: 'GET', url: '/p/AAAA' });
    expect(String(res.headers['content-security-policy'])).toContain(APP);
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.body).toContain('id="close-btn"');
    expect(res.body).toContain('data-frame-origins="https://app.test http://localhost:3000"');
    // Its answers are never framed.
    const info = await v.app.inject({ method: 'GET', url: '/p/AAAA/info' });
    expect(info.headers['x-frame-options']).toBe('DENY');
  });

  it("keeps an embedded unlock's session in a header: its own link only, never another's", async () => {
    const path = await pathOf({ display: 'embedded' });
    const { answer } = await unlock(path);
    expect(answer).toEqual({ ok: true, session: expect.any(String) });
    const session = String(answer['session']);
    expect(await stateOf(path, { 'x-vault-session': session })).toBe('open');
    expect(await stateOf(path, {})).toBe('unlock');
    // Another link of Meher's: that session opens nothing there.
    expect(await stateOf(await pathOf({ display: 'embedded' }), { 'x-vault-session': session })).toBe('unlock');
    // A sheet unlock answers no session: its cookie holds it.
    const sheet = await pathOf({});
    const plain = await unlock(sheet);
    expect(plain.answer).toEqual({ ok: true });
    expect(await stateOf(sheet, { cookie: plain.cookie })).toBe('open');
  });

  it('never embeds card or travel entry: Go gets 409, and the embedded page shows no form', async () => {
    for (const start of ['add_card', 'add_travel']) {
      const res = await link({ display: 'embedded', start });
      expect(res.statusCode, start).toBe(409);
    }
    expect(VAULT_JS).toContain("show('card-form', cardsReady && !embedded)");
    expect(VAULT_JS).toContain("show('travel-form', !embedded)");
  });

  it('says go-vault to its parent, at each of the App origins, and only when framed', () => {
    expect(VAULT_JS).toContain("window.parent.postMessage({ type: 'go-vault', status }, origin)");
    expect(VAULT_JS).toContain('if (!framed) return;');
    for (const status of ["tellApp('saved')", "tellApp('cancelled')", "tellApp('failed')"]) expect(VAULT_JS).toContain(status);
  });
});
