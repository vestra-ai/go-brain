import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildVault } from '../app.js';
import { withVaultSchema } from '../db/test-db.js';
import type { VaultEnv } from '../env.js';
import { sweep } from '../go-callback.js';
import { FakeRail } from '../rails/fake-rail.js';
import { makeRails } from '../rails/index.js';
import { customerIdOf } from '../store/people.js';
import { FakeStripe } from './fake-stripe.js';
import { injectFetch } from './inject-fetch.js';
import { TestAuthenticator } from './test-authenticator.js';
import { signedInject, testVaultEnv } from './vault-test-env.js';

export interface TestVault {
  app: FastifyInstance;
  pool: pg.Pool;
  env: VaultEnv;
  rail: FakeRail;
  stripe: FakeStripe;
  /** Calls this vault in process. Give it to Go's vault client in tests. */
  fetch: typeof fetch;
  /** Where Go reaches the vault: a real port with `listen`, otherwise https://vault.test through `fetch`. */
  baseUrl: string;
  /** Sets up Face ID for a person through the vault page, and with `withCard` adds the 4242 test card. */
  passkeyFor(personId: string, o?: { withCard?: boolean }): Promise<TestAuthenticator>;
  /** Does what the pay page does: asks for the challenge, signs it with the passkey, approves. */
  approve(payUrl: string, who: TestAuthenticator): Promise<{ state: string; message: string }>;
  sweep(): Promise<void>;
  close(): Promise<void>;
}

/** A whole vault in this process: its own schema, a FakeRail, a FakeStripe, and Go reached through `goFetch`. */
export async function startTestVault(o: { goFetch: typeof fetch; now: () => Date; rail?: FakeRail; listen?: boolean; env?: Partial<VaultEnv> }): Promise<TestVault> {
  const { pool, drop } = await withVaultSchema();
  const env = testVaultEnv(o.env);
  const stripe = new FakeStripe();
  const rail = o.rail ?? new FakeRail();
  const rails = makeRails({ stripe, customerOf: (p) => customerIdOf(pool, p), fake: rail });
  const app = await buildVault({ env, pool, now: o.now, stripe, rails, fetch: o.goFetch });
  let baseUrl = env.VAULT_PUBLIC_URL;
  if (o.listen) baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  let second = 0;
  // Counts back from now, so these signatures never match a test's own signed calls, which count forward.
  const signedAt = () => new Date(o.now().getTime() - 1000 * ++second);

  async function ceremonyCookie(path: string, kind: 'register' | 'unlock', auth: TestAuthenticator): Promise<string> {
    const opts = (await app.inject({ method: 'POST', url: `${path}/${kind}/options`, payload: {} })).json() as {
      challenge_id: string;
      options: never;
    };
    const response = kind === 'register' ? auth.register(opts.options) : auth.assert(opts.options);
    const res = await app.inject({ method: 'POST', url: `${path}/${kind}/verify`, payload: { challenge_id: opts.challenge_id, response } });
    if (res.statusCode !== 200) throw new Error(`${kind} failed: ${res.body}`);
    const cookie = res.headers['set-cookie'];
    return String(Array.isArray(cookie) ? cookie[0] : cookie).split(';')[0] as string;
  }

  return {
    app,
    pool,
    env,
    rail,
    stripe,
    fetch: injectFetch(app),
    baseUrl,
    async passkeyFor(personId, opts = {}) {
      const res = await signedInject(app, { method: 'POST', url: '/internal/links', body: { person_id: personId }, now: signedAt() });
      const path = new URL((res.json() as { url: string }).url).pathname;
      const auth = new TestAuthenticator(env.WEBAUTHN_RP_ID, env.WEBAUTHN_ORIGIN);
      const cookie = await ceremonyCookie(path, 'register', auth);
      if (opts.withCard) {
        const setup = (await app.inject({ method: 'POST', url: `${path}/cards/setup`, headers: { cookie }, payload: {} })).json() as {
          client_secret: string;
        };
        const setupIntentId = setup.client_secret.split('_secret_')[0] as string;
        stripe.completeSetup(setupIntentId);
        const saved = await app.inject({ method: 'POST', url: `${path}/cards`, headers: { cookie }, payload: { setup_intent_id: setupIntentId } });
        if (saved.statusCode !== 200) throw new Error(`card not saved: ${saved.body}`);
      }
      return auth;
    },
    async approve(payUrl, who) {
      const path = new URL(payUrl).pathname;
      const opts = await app.inject({ method: 'POST', url: `${path}/options`, payload: {} });
      if (opts.statusCode !== 200) return { state: 'refused', message: (opts.json() as { message: string }).message };
      const { challenge_id, options } = opts.json() as { challenge_id: string; options: never };
      const res = await app.inject({ method: 'POST', url: `${path}/approve`, payload: { challenge_id, response: who.assert(options) } });
      const body = res.json() as { state: string; message: string };
      return { state: body.state, message: body.message };
    },
    async sweep() {
      await sweep({ env, pool, now: o.now, rails, fetch: o.goFetch, log: app.log });
    },
    async close() {
      await app.close();
      await drop();
    },
  };
}
