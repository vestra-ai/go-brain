import { describe, expect, it } from 'vitest';
import { buildVault } from './app.js';
import { makeRails } from './rails/index.js';
import { FakeStripe } from './testing/fake-stripe.js';
import { testVaultEnv } from './testing/vault-test-env.js';

/** A vault whose log lines are kept. No route used here touches the database. */
async function vaultWithLog() {
  const lines: string[] = [];
  const stripe = new FakeStripe();
  const app = await buildVault({
    env: testVaultEnv(),
    pool: {} as never,
    now: () => new Date('2026-10-05T09:01:00Z'),
    stripe,
    rails: makeRails({ stripe, customerOf: async () => null }),
    fetch,
    logger: { level: 'info', stream: { write: (l: string) => void lines.push(l) } },
  });
  return { app, lines };
}

describe('a failed request', () => {
  it('is logged by its route, never by its path, and answers without the details', async () => {
    const { app, lines } = await vaultWithLog();
    app.get('/boom/:token', async () => {
      throw new Error('the database went away');
    });
    const token = 'T'.repeat(43);
    const res = await app.inject({ method: 'GET', url: `/boom/${token}` });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'internal', message: 'Something went wrong.' } });
    expect(res.headers['x-frame-options']).toBe('DENY');
    const log = lines.join('\n');
    expect(log).toContain('"route":"/boom/:token"');
    expect(log).toContain('the database went away');
    expect(log).not.toContain(token);
    await app.close();
  });

  it('keeps a client error a client error, logged the same way', async () => {
    const { app, lines } = await vaultWithLog();
    const token = 'A'.repeat(43);
    const res = await app.inject({
      method: 'POST',
      url: `/l/${token}/unlock/options`,
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: 'bad_request', message: 'The body is not JSON' } });
    const log = lines.join('\n');
    expect(log).toContain('"route":"/l/:token/unlock/options"');
    expect(log).not.toContain(token);
    await app.close();
  });
});
