import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import type pg from 'pg';
import type { PayDeps } from '../charge.js';
import { masterKeyOf } from '../crypto/envelope.js';
import { withVaultSchema } from '../db/test-db.js';
import type { VaultEnv } from '../env.js';
import { openPayLink } from '../internal/pay-links.js';
import { createHomeLink, findLink } from '../links.js';
import { finishRegistration, passkeyConfig, registrationOptions } from '../passkeys.js';
import { approvePayment, payOptions, type ApproveResult } from '../pay.js';
import { FakeRail } from '../rails/fake-rail.js';
import { makeRails } from '../rails/index.js';
import { saveCardFromSetup, startCardSetup, type CardSummary } from '../store/cards.js';
import { customerIdOf, ensurePerson } from '../store/people.js';
import { FakeStripe } from './fake-stripe.js';
import { TestAuthenticator } from './test-authenticator.js';
import { signTestApproval, testVaultEnv } from './vault-test-env.js';

export interface PayFixture {
  d: PayDeps;
  pool: pg.Pool;
  env: VaultEnv;
  rail: FakeRail;
  stripe: FakeStripe;
  lines: string[];
  goCalls: Array<{ path: string; body: Record<string, unknown>; signature: string }>;
  now(): Date;
  setNow(at: Date): void;
  setGoStatus(status: number): void;
  registerFor(personId: string): Promise<TestAuthenticator>;
  cardFor(personId: string): Promise<CardSummary>;
  /** ticketFor: 1.3's personal approval for that person's own pick (no vote), who is its payer. */
  payLinkFor(o?: { jti?: string; sameApproval?: boolean; payer?: string; ticketFor?: string; kind?: 'fake' | 'stripe_test'; groupAgreed?: boolean }): Promise<{ token: string; jti: string }>;
  approve(token: string, who: TestAuthenticator): Promise<ApproveResult>;
  drop(): Promise<void>;
}

/** A vault database, a fake rail, a fake Go that records callbacks, and the Goa villa approval. Clock: 09:01, approvals 09:00 to 09:10. */
export async function payFixture(): Promise<PayFixture> {
  const { pool, drop } = await withVaultSchema();
  const env = testVaultEnv();
  let now = new Date('2026-10-05T09:01:00Z');
  let goStatus = 200;
  const goCalls: PayFixture['goCalls'] = [];
  const lines: string[] = [];
  const goFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    goCalls.push({
      path: url.pathname,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      signature: String(new Headers(init?.headers).get('x-vault-signature')),
    });
    return new Response(JSON.stringify({ ok: true }), { status: goStatus, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const log = Fastify({ logger: { level: 'trace', stream: { write: (l: string) => void lines.push(l) } } }).log;
  const stripe = new FakeStripe();
  const rail = new FakeRail();
  const d: PayDeps = {
    env,
    pool,
    now: () => now,
    rails: makeRails({ stripe, customerOf: (p) => customerIdOf(pool, p), fake: rail }),
    fetch: goFetch,
    log,
  };
  const cfg = passkeyConfig(env);
  const approvals = new Map<string, string>();
  return {
    d,
    pool,
    env,
    rail,
    stripe,
    lines,
    goCalls,
    now: () => now,
    setNow: (at) => {
      now = at;
    },
    setGoStatus: (status) => {
      goStatus = status;
    },
    async registerFor(personId) {
      await ensurePerson(pool, personId, now);
      const { token } = await createHomeLink(pool, now, { personId, start: 'home' });
      const link = await findLink(pool, token);
      if (!link) throw new Error('no link');
      const auth = new TestAuthenticator(cfg.rpId, cfg.origin);
      const { challengeId, options } = await registrationOptions(pool, cfg, now, { personId, linkId: link.link_id });
      const done = await finishRegistration(pool, cfg, now, { personId, linkId: link.link_id, challengeId, response: auth.register(options) });
      if (!done.ok) throw new Error(`registration failed: ${done.reason}`);
      return auth;
    },
    async cardFor(personId) {
      const { clientSecret } = await startCardSetup(pool, stripe, personId, now);
      const setupIntentId = clientSecret.split('_secret_')[0] as string;
      stripe.completeSetup(setupIntentId);
      const saved = await saveCardFromSetup(pool, stripe, masterKeyOf(env.VAULT_MASTER_KEY), now, { personId, setupIntentId });
      if (!saved.ok) throw new Error(`card not saved: ${saved.reason}`);
      return saved.card;
    },
    async payLinkFor(o = {}) {
      const jti = o.jti ?? `ap_${randomBytes(6).toString('hex')}`;
      const payer = o.ticketFor ?? o.payer ?? 'p_rahul';
      const form = o.ticketFor ? { decision_id: null, personal: { person_id: o.ticketFor, card_id: 'c_flights_mine', option_id: 'opt_flight_1' } } : {};
      const approval = (o.sameApproval ? approvals.get(jti) : undefined) ?? signTestApproval({ jti, payer_person_id: payer, ...form });
      approvals.set(jti, approval);
      const r = await openPayLink(pool, env, now, {
        approval,
        approval_id: jti,
        trip_id: 't_goa',
        payer_person_id: payer,
        payer_name: payer,
        ...(o.groupAgreed !== undefined ? { group_agreed: o.groupAgreed } : {}),
        hold: {
          hold_id: `hold_${jti}`,
          amount_minor: 5420000,
          currency: 'INR',
          merchant: 'ixigo: Villa Sol, Anjuna',
          payment_kind: o.kind ?? 'fake',
          expires_at: '2026-10-05T09:30:00Z',
        },
      });
      if (!r.ok) throw new Error(`no pay link: ${r.reason}`);
      return { token: r.url.split('/').pop() as string, jti };
    },
    async approve(token, who) {
      const opts = await payOptions(d, token);
      if (!opts.ok) return { state: 'refused', reason: opts.reason };
      return approvePayment(d, { token, challengeId: opts.challengeId, response: who.assert(opts.options) });
    },
    drop,
  };
}
