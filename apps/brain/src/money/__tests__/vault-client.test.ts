import { signRequest, verifyRequest } from '@go/contract';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { checkVaultCall } from '../signed.js';
import { vaultClient, type PayLinkInput } from '../vault-client.js';

const secret = 'test-only-vault-shared-secret-0123456789';
const now = new Date('2026-10-05T09:01:00Z');
const calls: Array<{ url: string; method: string; body: string; signature: string }> = [];
let answer: { status: number; body: unknown } = { status: 200, body: {} };

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  calls.push({
    url: String(input),
    method: init?.method ?? 'GET',
    body: typeof init?.body === 'string' ? init.body : '',
    signature: String(new Headers(init?.headers).get('x-vault-signature')),
  });
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const client = vaultClient({ baseUrl: 'https://vault.test/', secret, fetch: fakeFetch, now: () => now });

const input: PayLinkInput = {
  approval: 'token',
  approvalId: 'ap_01JA7Q3V8Z',
  tripId: 't_goa',
  payerPersonId: 'p_rahul',
  payerName: 'Rahul',
  hold: {
    holdId: 'hold_1',
    amountMinor: 5420000,
    currency: 'INR',
    merchant: 'ixigo: Villa Sol, Anjuna',
    paymentKind: 'stripe_test',
    expiresAt: '2026-10-05T09:15:00Z',
  },
};

describe('vaultClient', () => {
  it('signs each call over its exact target and body, with a fresh nonce', async () => {
    answer = { status: 200, body: { url: 'https://vault.test/l/abc', expires_at: '2026-10-05T09:06:00.000Z' } };
    expect(await client.homeLink({ personId: 'p_rahul', start: 'add_card' })).toEqual({
      url: 'https://vault.test/l/abc',
      expiresAt: '2026-10-05T09:06:00.000Z',
    });
    await client.homeLink({ personId: 'p_rahul', start: 'add_card' });
    const [a, b] = calls.slice(-2);
    expect(a?.url).toBe('https://vault.test/internal/links');
    expect(JSON.parse(a?.body ?? '{}')).toMatchObject({ person_id: 'p_rahul', start: 'add_card' });
    expect(a?.body).not.toBe(b?.body);
    const check = verifyRequest(
      { method: 'POST', target: '/internal/links', body: a?.body ?? '' },
      a?.signature,
      secret,
      Math.floor(now.getTime() / 1000),
    );
    expect(check).toEqual({ ok: true });
  });

  it('sends the approval and the hold in the vault words', async () => {
    answer = { status: 200, body: { url: 'https://vault.test/p/xyz', expires_at: '2026-10-05T09:06:00.000Z' } };
    expect(await client.payLink(input)).toEqual({ ok: true, url: 'https://vault.test/p/xyz', expiresAt: '2026-10-05T09:06:00.000Z' });
    expect(JSON.parse(calls.at(-1)?.body ?? '{}')).toMatchObject({
      approval: 'token',
      approval_id: 'ap_01JA7Q3V8Z',
      trip_id: 't_goa',
      payer_person_id: 'p_rahul',
      payer_name: 'Rahul',
      hold: { hold_id: 'hold_1', amount_minor: 5420000, currency: 'INR', merchant: 'ixigo: Villa Sol, Anjuna', payment_kind: 'stripe_test', expires_at: '2026-10-05T09:15:00Z' },
    });
  });

  it('turns a vault refusal into its reason, and anything else into unavailable', async () => {
    answer = { status: 409, body: { error: { code: 'conflict', message: 'x', reason: 'over_amount' } } };
    expect(await client.payLink(input)).toEqual({ ok: false, reason: 'over_amount' });
    answer = { status: 500, body: {} };
    expect(await client.payLink(input)).toEqual({ ok: false, reason: 'unavailable', detail: 'the vault answered 500' });
    answer = { status: 409, body: { error: { code: 'conflict', message: 'x', reason: 'bad_approval', detail: 'the signature is not valid for this key' } } };
    expect(await client.payLink(input)).toEqual({ ok: false, reason: 'bad_approval', detail: 'the signature is not valid for this key' });
  });

  it('gives up on a vault that does not answer in time', async () => {
    const hanging = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;
    const slow = vaultClient({ baseUrl: 'https://vault.test', secret, fetch: hanging, now: () => now });
    expect(await slow.payLink(input, { timeoutMs: 50 })).toMatchObject({ ok: false, reason: 'unavailable', detail: expect.stringContaining('could not be reached') });
  });

  it('voids an approval\'s pay links with a signed POST, and throws when the vault does not take it', async () => {
    answer = { status: 200, body: { ok: true, voided: 1 } };
    await client.voidPayLinks('ap_01JA7Q3V8Z');
    const call = calls.at(-1);
    expect(call?.url).toBe('https://vault.test/internal/pay-links/void');
    expect(JSON.parse(call?.body ?? '{}')).toMatchObject({ approval_id: 'ap_01JA7Q3V8Z' });
    expect(verifyRequest({ method: 'POST', target: '/internal/pay-links/void', body: call?.body ?? '' }, call?.signature, secret, Math.floor(now.getTime() / 1000))).toEqual({ ok: true });
    answer = { status: 503, body: {} };
    await expect(client.voidPayLinks('ap_01JA7Q3V8Z')).rejects.toThrow(/503/);
  });

  it('reads the both-keys count with a signed GET', async () => {
    answer = { status: 200, body: { charged_approval_ids: ['ap_1'], without_both_keys: 0 } };
    expect(await client.bothKeys()).toEqual({ chargedApprovalIds: ['ap_1'], withoutBothKeys: 0 });
    const call = calls.at(-1);
    const target = new URL(call?.url ?? '').pathname + new URL(call?.url ?? '').search;
    expect(target).toMatch(/^\/internal\/both-keys\?n=[0-9a-f]{16}$/);
    expect(verifyRequest({ method: 'GET', target, body: '' }, call?.signature, secret, Math.floor(now.getTime() / 1000))).toEqual({ ok: true });
  });
});

describe('checkVaultCall', () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ pool, drop } = await withSchema());
  });
  afterAll(async () => {
    await drop();
  });

  const body = JSON.stringify({ trip_id: 't_goa', approval_id: 'ap_1', rail_ref: 'fake_ap_1' });
  const req = (signature: string) => ({ method: 'POST', url: '/internal/vault/paid', headers: { 'x-vault-signature': signature } });

  it('accepts a good signature once', async () => {
    const sig = signRequest({ method: 'POST', target: '/internal/vault/paid', body }, secret, Math.floor(now.getTime() / 1000));
    expect(await checkVaultCall(pool, secret, req(sig), body, now)).toBe(true);
    expect(await checkVaultCall(pool, secret, req(sig), body, now)).toBe(false);
  });

  it('refuses another secret, another body and a stale time', async () => {
    const t = Math.floor(now.getTime() / 1000);
    expect(await checkVaultCall(pool, secret, req(signRequest({ method: 'POST', target: '/internal/vault/paid', body }, 'x'.repeat(40), t)), body, now)).toBe(false);
    expect(await checkVaultCall(pool, secret, req(signRequest({ method: 'POST', target: '/internal/vault/paid', body: '{}' }, secret, t)), body, now)).toBe(false);
    expect(await checkVaultCall(pool, secret, req(signRequest({ method: 'POST', target: '/internal/vault/paid', body }, secret, t - 400)), body, now)).toBe(false);
  });
});
