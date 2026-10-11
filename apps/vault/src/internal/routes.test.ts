import { createHash, generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildVault } from '../app.js';
import { PayLinkBody, openPayLink } from './pay-links.js';
import { withVaultSchema } from '../db/test-db.js';
import { makeRails } from '../rails/index.js';
import { FakeStripe } from '../testing/fake-stripe.js';
import { signRequest, signSpendApproval } from '@go/contract';
import {
  TEST_SHARED_SECRET,
  signedInject,
  signRawApproval,
  signTestApproval,
  spendVector,
  testVaultEnv,
} from '../testing/vault-test-env.js';

const now = new Date('2026-10-05T09:01:00Z'); // the test vector's approval: iat 09:00:00, exp 09:10:00
let app: FastifyInstance;
let pool: pg.Pool;
let drop: () => Promise<void>;

const hold = {
  hold_id: 'hold_1',
  amount_minor: 5420000,
  currency: 'INR',
  merchant: 'ixigo: Villa Sol, Anjuna',
  payment_kind: 'stripe_test',
  expires_at: '2026-10-05T09:30:00Z',
};
const payBody = (over: Record<string, unknown> = {}) => ({
  approval: spendVector().token,
  approval_id: 'ap_01JA7Q3V8Z',
  trip_id: 't_goa',
  payer_person_id: 'p_rahul',
  payer_name: 'Rahul',
  hold,
  ...over,
});
// Each call gets its own second, so the replay guard never mistakes two tests for one repeated call.
const payLink = (body: unknown, at = now) => signedInject(app, { method: 'POST', url: '/internal/pay-links', body, now: at });
const reasonOf = async (body: unknown, at = now) => {
  const res = await payLink(body, at);
  expect(res.statusCode).toBe(409);
  return (res.json() as { error: { reason: string } }).error.reason;
};
const refusalOf = async (body: unknown, at = now) => {
  const res = await payLink(body, at);
  expect(res.statusCode).toBe(409);
  return (res.json() as { error: { reason: string; detail?: string; message: string } }).error;
};

beforeAll(async () => {
  ({ pool, drop } = await withVaultSchema());
  const stripe = new FakeStripe();
  app = await buildVault({
    env: testVaultEnv(),
    pool,
    now: () => now,
    stripe,
    rails: makeRails({ stripe, customerOf: async () => null }),
    fetch,
  });
});
afterAll(async () => {
  await app.close();
  await drop();
});

describe('headers', () => {
  it('never lets a page be framed, and sends no referrer', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ ok: true, cards: 'ready' });
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('internal signatures', () => {
  const body = { person_id: 'p_rahul', start: 'add_card' };

  it('refuses a call with no signature', async () => {
    const res = await app.inject({ method: 'POST', url: '/internal/links', payload: body });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a call signed with another secret', async () => {
    const res = await signedInject(app, { method: 'POST', url: '/internal/links', body, now, secret: 'another-secret-another-secret-0000' });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a stale signature', async () => {
    const res = await signedInject(app, { method: 'POST', url: '/internal/links', body, now: new Date(now.getTime() - 400_000) });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a signature once', async () => {
    const one = { person_id: 'p_meher' };
    const header = signRequest(
      { method: 'POST', target: '/internal/links', body: JSON.stringify(one) },
      TEST_SHARED_SECRET,
      Math.floor(now.getTime() / 1000),
    );
    const first = await signedInject(app, { method: 'POST', url: '/internal/links', body: one, now, header });
    expect(first.statusCode).toBe(200);
    const again = await signedInject(app, { method: 'POST', url: '/internal/links', body: one, now, header });
    expect(again.statusCode).toBe(401);
  });
});

describe('POST /internal/links', () => {
  it('answers a 5 minute link and stores only a hash of its token', async () => {
    const res = await signedInject(app, { method: 'POST', url: '/internal/links', body: { person_id: 'p_rahul', start: 'add_card' }, now });
    const link = res.json() as { url: string; expires_at: string };
    expect(link.url).toMatch(/^https:\/\/vault\.test\/l\/[A-Za-z0-9_-]{43}$/);
    expect(link.expires_at).toBe('2026-10-05T09:06:00.000Z');
    const token = link.url.split('/').pop() as string;
    const hash = createHash('sha256').update(token).digest();
    const rows = await pool.query("select *, row_to_json(links)::text as everything from links where token_hash = $1", [hash]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].start).toBe('add_card');
    expect(String(rows.rows[0].everything)).not.toContain(token);
  });

  it('opens the home for add_login, because logins are not stored this week', async () => {
    const res = await signedInject(app, { method: 'POST', url: '/internal/links', body: { person_id: 'p_rahul', start: 'add_login' }, now });
    expect(res.statusCode).toBe(200);
    const token = (res.json() as { url: string }).url.split('/').pop() as string;
    const rows = await pool.query('select start from links where token_hash = $1', [createHash('sha256').update(token).digest()]);
    expect(rows.rows[0].start).toBe('home');
  });

  it('refuses a body that does not match', async () => {
    const res = await signedInject(app, { method: 'POST', url: '/internal/links', body: { person: 'p_rahul' }, now });
    expect(res.statusCode).toBe(422);
  });
});

describe('POST /internal/pay-links', () => {
  it('answers a pay link that lives 5 minutes when the approval lives longer', async () => {
    const res = await payLink(payBody());
    expect(res.statusCode).toBe(200);
    const link = res.json() as { url: string; expires_at: string };
    expect(link.url).toMatch(/^https:\/\/vault\.test\/p\/[A-Za-z0-9_-]{43}$/);
    expect(link.expires_at).toBe('2026-10-05T09:06:00.000Z');
  });

  it('never lets a pay link outlive its approval', async () => {
    const iat = 1791190800;
    const approval = signTestApproval({ jti: 'ap_short_0001', iat, exp: iat + 180 });
    const res = await payLink(payBody({ approval, approval_id: 'ap_short_0001' }));
    expect((res.json() as { expires_at: string }).expires_at).toBe('2026-10-05T09:03:00.000Z');
  });

  it('refuses an expired approval', async () => {
    const approval = signTestApproval({ jti: 'ap_old_000001', iat: 1791190800 - 3600 });
    expect(await reasonOf(payBody({ approval, approval_id: 'ap_old_000001' }))).toBe('expired');
  });

  it('refuses a token whose signature does not match', async () => {
    const t = spendVector().token;
    const tampered = `${t.slice(0, -2)}${t.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(await reasonOf(payBody({ approval: tampered }))).toBe('bad_approval');
  });

  it('refuses a token meant for another audience', async () => {
    const approval = signRawApproval({ ...spendVector().claims, aud: 'another-service' });
    expect(await refusalOf(payBody({ approval }))).toMatchObject({ reason: 'bad_approval', detail: "the approval's claims are not valid" });
  });

  it('says plainly when an approval is signed with a key other than the one this vault has', async () => {
    const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const approval = signSpendApproval({ ...spendVector().claims, jti: 'ap_otherkey_01' }, other);
    const refusal = await refusalOf(payBody({ approval, approval_id: 'ap_otherkey_01' }));
    expect(refusal).toMatchObject({ reason: 'bad_approval', detail: "the approval's signature is not valid for this vault's GO_SPEND_PUBLIC_KEY" });
    expect(refusal.message).toContain('not valid for this vault');
  });

  it('refuses a token whose jti is not the approval id Go named', async () => {
    expect(await reasonOf(payBody({ approval_id: 'ap_someone_else' }))).toBe('bad_approval');
  });

  it('refuses an approval for another trip', async () => {
    expect(await reasonOf(payBody({ trip_id: 't_other' }))).toBe('wrong_trip');
  });

  it('refuses another payer', async () => {
    expect(await reasonOf(payBody({ payer_person_id: 'p_priya' }))).toBe('wrong_payer');
  });

  // Contract 1.3: a person's own pick names it (personal) in place of a vote, and they are its payer.
  const pick = { person_id: 'p_priya', card_id: 'c_flights_priya', option_id: 'opt_flight_1' };
  it("opens a personal approval's pay link for its person alone", async () => {
    const ticket = { jti: 'ap_ticket_ok_1', decision_id: null, personal: pick, payer_person_id: 'p_priya' };
    const approval = signTestApproval(ticket);
    expect(await reasonOf(payBody({ approval, approval_id: ticket.jti, payer_person_id: 'p_rahul' }))).toBe('wrong_payer');
    expect((await payLink(payBody({ approval, approval_id: ticket.jti, payer_person_id: 'p_priya' }))).statusCode).toBe(200);
  });

  it('refuses a personal approval whose payer is not its person, or one that names a vote too', async () => {
    const claims = Object.fromEntries(Object.entries(spendVector().claims).filter(([k]) => k !== 'decision_id'));
    const notTheirs = signRawApproval({ ...claims, jti: 'ap_ticket_bad_1', personal: pick, payer_person_id: 'p_rahul' });
    expect(await reasonOf(payBody({ approval: notTheirs, approval_id: 'ap_ticket_bad_1' }))).toBe('bad_approval');
    const both = signRawApproval({ ...spendVector().claims, jti: 'ap_ticket_bad_2', personal: { ...pick, person_id: 'p_rahul' } });
    expect(await reasonOf(payBody({ approval: both, approval_id: 'ap_ticket_bad_2' }))).toBe('bad_approval');
  });

  it('refuses another currency', async () => {
    expect(await reasonOf(payBody({ hold: { ...hold, currency: 'USD' } }))).toBe('currency_mismatch');
  });

  it('refuses an amount above the approval', async () => {
    expect(await reasonOf(payBody({ hold: { ...hold, amount_minor: 5420001 } }))).toBe('over_amount');
  });

  it('refuses a hold that runs out within a minute', async () => {
    expect(await reasonOf(payBody({ hold: { ...hold, expires_at: '2026-10-05T09:01:30Z' } }))).toBe('hold_expiring');
  });

  it('says a rail this vault does not pay on is not ready, before writing anything', async () => {
    const body = PayLinkBody.parse(payBody({ approval_id: 'ap_01JA7Q3V8Z' }));
    expect(await openPayLink(pool, testVaultEnv({ VAULT_RAILS: ['fake'] }), now, body)).toEqual({ ok: false, reason: 'rail_not_ready' });
  });

  it('says the ixigo rail is not ready yet', async () => {
    expect(await reasonOf(payBody({ hold: { ...hold, payment_kind: 'ixigo' } }))).toBe('rail_not_ready');
  });

  it('refuses the same approval with a different hold', async () => {
    expect(await reasonOf(payBody({ hold: { ...hold, hold_id: 'hold_2' } }))).toBe('bad_approval');
  });

  it('refuses an approval the vault already paid with', async () => {
    const approval = signTestApproval({ jti: 'ap_used_00001' });
    const first = await payLink(payBody({ approval, approval_id: 'ap_used_00001' }));
    expect(first.statusCode).toBe(200);
    const linkId = (await pool.query<{ link_id: string }>("select link_id from links where approval_id = 'ap_used_00001'")).rows[0]?.link_id;
    await pool.query(
      "insert into cards (card_id, person_id, brand, last4, exp_month, exp_year, sealed, created_at) values ('cd_used', 'p_rahul', 'visa', '4242', 12, 2030, '\\x01', now())",
    );
    await pool.query(
      `insert into used_approvals (jti, approval_id, trip_id, payer_person_id, link_id, card_id, amount_minor, currency, merchant, rail, outcome, used_at)
       values ('ap_used_00001', 'ap_used_00001', 't_goa', 'p_rahul', $1, 'cd_used', 5420000, 'INR', 'ixigo: Villa Sol, Anjuna', 'fake', 'paid', now())`,
      [linkId],
    );
    expect(await reasonOf(payBody({ approval, approval_id: 'ap_used_00001' }), new Date(now.getTime() + 1000))).toBe('used');
  });
});

describe('POST /internal/pay-links/void', () => {
  const at = (s: number) => new Date(now.getTime() + s * 1000);

  it('stops every pay link for the approval, and refuses a new one', async () => {
    const body = payBody({ approval: signTestApproval({ jti: 'ap_void_00001' }), approval_id: 'ap_void_00001' });
    expect((await payLink(body)).statusCode).toBe(200);
    const res = await signedInject(app, { method: 'POST', url: '/internal/pay-links/void', body: { approval_id: 'ap_void_00001' }, now: at(3) });
    expect(res.json()).toEqual({ ok: true, voided: 1 });
    const links = await pool.query<{ used_at: Date | null }>("select used_at from links where approval_id = 'ap_void_00001'");
    expect(links.rows.map((l) => l.used_at !== null)).toEqual([true]);
    expect(await reasonOf(body, at(4))).toBe('used');
  });

  it('voids an approval it has not seen yet, so a pay link asked for later is refused', async () => {
    const res = await signedInject(app, { method: 'POST', url: '/internal/pay-links/void', body: { approval_id: 'ap_void_00002' }, now: at(5) });
    expect(res.json()).toEqual({ ok: true, voided: 0 });
    const body = payBody({ approval: signTestApproval({ jti: 'ap_void_00002' }), approval_id: 'ap_void_00002' });
    expect(await reasonOf(body, at(6))).toBe('used');
  });

  it('refuses a call without the shared secret', async () => {
    const res = await app.inject({ method: 'POST', url: '/internal/pay-links/void', payload: { approval_id: 'ap_void_00003' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /internal/both-keys', () => {
  it('counts payments without both keys from the unlock log', async () => {
    const res = await signedInject(app, { method: 'GET', url: '/internal/both-keys', now: new Date(now.getTime() + 2000) });
    expect(res.json()).toEqual({ charged_approval_ids: [], without_both_keys: 1 });
  });
});
