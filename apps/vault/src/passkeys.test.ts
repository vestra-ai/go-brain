import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { withVaultSchema } from './db/test-db.js';
import {
  authenticationOptions,
  finishRegistration,
  hasPasskey,
  registrationOptions,
  verifyAssertion,
  type PasskeyConfig,
} from './passkeys.js';
import { ensurePerson } from './store/people.js';
import { TestAuthenticator } from './testing/test-authenticator.js';

const cfg: PasskeyConfig = { rpId: 'vault.test', origin: 'https://vault.test', rpName: 'Go' };
const t0 = new Date('2026-10-05T09:00:00Z');
let pool: pg.Pool;
let drop: () => Promise<void>;
let n = 0;

async function link(personId: string): Promise<string> {
  const id = `lk_t${++n}`;
  await pool.query(
    "insert into links (link_id, token_hash, kind, person_id, expires_at, created_at) values ($1, $2, 'home', $3, $4, $5)",
    [id, Buffer.from(id), personId, new Date(t0.getTime() + 300_000), t0],
  );
  return id;
}

async function registered(personId: string, auth = new TestAuthenticator(cfg.rpId, cfg.origin)): Promise<TestAuthenticator> {
  const linkId = await link(personId);
  const { challengeId, options } = await registrationOptions(pool, cfg, t0, { personId, linkId });
  const r = await finishRegistration(pool, cfg, t0, { personId, linkId, challengeId, response: auth.register(options) });
  expect(r.ok).toBe(true);
  return auth;
}

async function tryAssert(personId: string, auth: TestAuthenticator, o: { at?: Date; counter?: number } = {}) {
  const linkId = await link(personId);
  const opts = await authenticationOptions(pool, cfg, t0, { personId, linkId, purpose: 'pay' });
  if (!opts) throw new Error('no passkey');
  const response = o.counter === undefined ? auth.assert(opts.options) : auth.assert(opts.options, { counter: o.counter });
  return verifyAssertion(pool, cfg, o.at ?? t0, { linkId, purpose: 'pay', challengeId: opts.challengeId, response });
}

beforeAll(async () => {
  ({ pool, drop } = await withVaultSchema());
  await ensurePerson(pool, 'p_rahul', t0, 'Rahul');
  await ensurePerson(pool, 'p_priya', t0, 'Priya');
});
afterAll(async () => {
  await drop();
});

describe('passkeys', () => {
  it('registers on the first visit, then verifies an assertion for that person', async () => {
    expect(await hasPasskey(pool, 'p_rahul')).toBe(false);
    const rahul = await registered('p_rahul');
    expect(await hasPasskey(pool, 'p_rahul')).toBe(true);
    expect(await tryAssert('p_rahul', rahul)).toEqual({ ok: true, personId: 'p_rahul' });
  });

  it('asks for user verification and lists only that person\'s passkeys', async () => {
    const linkId = await link('p_rahul');
    const opts = await authenticationOptions(pool, cfg, t0, { personId: 'p_rahul', linkId, purpose: 'pay' });
    expect(opts?.options.userVerification).toBe('required');
    const ids = (await pool.query<{ credential_id: string }>("select credential_id from passkeys where person_id = 'p_rahul'")).rows.map((r) => r.credential_id);
    expect(opts?.options.allowCredentials?.map((c) => c.id).sort()).toEqual(ids.sort());
  });

  it('uses a challenge once', async () => {
    const rahul = await registered('p_rahul');
    const linkId = await link('p_rahul');
    const opts = await authenticationOptions(pool, cfg, t0, { personId: 'p_rahul', linkId, purpose: 'pay' });
    if (!opts) throw new Error('no passkey');
    const response = rahul.assert(opts.options);
    expect((await verifyAssertion(pool, cfg, t0, { linkId, purpose: 'pay', challengeId: opts.challengeId, response })).ok).toBe(true);
    expect(await verifyAssertion(pool, cfg, t0, { linkId, purpose: 'pay', challengeId: opts.challengeId, response })).toEqual({ ok: false, reason: 'challenge' });
  });

  it('refuses a challenge after 120 seconds', async () => {
    const rahul = await registered('p_rahul');
    expect(await tryAssert('p_rahul', rahul, { at: new Date(t0.getTime() + 121_000) })).toEqual({ ok: false, reason: 'challenge' });
  });

  it('refuses a challenge made for another link or purpose', async () => {
    const rahul = await registered('p_rahul');
    const linkId = await link('p_rahul');
    const opts = await authenticationOptions(pool, cfg, t0, { personId: 'p_rahul', linkId, purpose: 'unlock' });
    if (!opts) throw new Error('no passkey');
    const response = rahul.assert(opts.options);
    expect(await verifyAssertion(pool, cfg, t0, { linkId, purpose: 'pay', challengeId: opts.challengeId, response })).toEqual({ ok: false, reason: 'challenge' });
  });

  it('refuses an authenticator that did not verify the user', async () => {
    const lazy = await registered('p_priya');
    lazy.userVerified = false;
    expect(await tryAssert('p_priya', lazy)).toEqual({ ok: false, reason: 'not_verified' });
  });

  it('refuses a counter that goes backwards (a cloned passkey)', async () => {
    const rahul = await registered('p_rahul');
    expect((await tryAssert('p_rahul', rahul, { counter: 5 })).ok).toBe(true);
    expect(await tryAssert('p_rahul', rahul, { counter: 3 })).toEqual({ ok: false, reason: 'not_verified' });
  });

  it('refuses a passkey the vault does not know', async () => {
    const stranger = new TestAuthenticator(cfg.rpId, cfg.origin);
    const linkId = await link('p_rahul');
    const opts = await authenticationOptions(pool, cfg, t0, { personId: 'p_rahul', linkId, purpose: 'pay' });
    if (!opts) throw new Error('no passkey');
    expect(
      await verifyAssertion(pool, cfg, t0, { linkId, purpose: 'pay', challengeId: opts.challengeId, response: stranger.assert(opts.options) }),
    ).toEqual({ ok: false, reason: 'unknown_passkey' });
  });

  it('answers who unlocked, so the caller can compare it with the payer', async () => {
    const priya = await registered('p_priya');
    expect(await tryAssert('p_rahul', priya)).toEqual({ ok: true, personId: 'p_priya' });
  });

  it('refuses a registration from another origin', async () => {
    const linkId = await link('p_rahul');
    const { challengeId, options } = await registrationOptions(pool, cfg, t0, { personId: 'p_rahul', linkId });
    const evil = new TestAuthenticator(cfg.rpId, 'https://evil.example');
    expect(
      await finishRegistration(pool, cfg, t0, { personId: 'p_rahul', linkId, challengeId, response: evil.register(options) }),
    ).toEqual({ ok: false, reason: 'not_verified' });
  });
});
