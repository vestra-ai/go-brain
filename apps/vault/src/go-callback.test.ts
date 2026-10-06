import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reportOutcome, sweep } from './go-callback.js';
import { payFixture, type PayFixture } from './testing/pay-fixtures.js';
import type { TestAuthenticator } from './testing/test-authenticator.js';

let f: PayFixture;
let rahul: TestAuthenticator;

beforeAll(async () => {
  f = await payFixture();
  rahul = await f.registerFor('p_rahul');
  await f.cardFor('p_rahul');
});
afterAll(async () => {
  await f.drop();
});

const row = async (jti: string) =>
  (await f.pool.query('select outcome, callback_at, callback_refused_at, callback_attempts from used_approvals where jti = $1', [jti])).rows[0];

describe('telling Go', () => {
  it('keeps the outcome until Go acknowledges it, then the sweep sends it again', async () => {
    f.setGoStatus(503);
    const { token, jti } = await f.payLinkFor();
    expect((await f.approve(token, rahul)).state).toBe('paid');
    expect(await row(jti)).toMatchObject({ outcome: 'paid', callback_at: null, callback_attempts: 1 });
    f.setGoStatus(200);
    const before = f.goCalls.length;
    expect((await sweep(f.d)).resent).toBeGreaterThanOrEqual(1);
    expect(f.goCalls.length).toBeGreaterThan(before);
    expect((await row(jti)).callback_at).not.toBeNull();
  });

  it('stops after an answer that will never change, and records it apart from an answer Go took', async () => {
    f.setGoStatus(409);
    const { token, jti } = await f.payLinkFor();
    await f.approve(token, rahul);
    expect(await row(jti)).toMatchObject({ callback_at: null, callback_attempts: 1 });
    expect((await row(jti)).callback_refused_at).not.toBeNull();
    f.setGoStatus(200);
    const before = f.goCalls.length;
    await sweep(f.d);
    expect(f.goCalls.slice(before).filter((c) => c.body.approval_id === jti)).toEqual([]);
  });

  it('sends a paid outcome again after a 404, until Go takes it', async () => {
    f.setGoStatus(404);
    const { token, jti } = await f.payLinkFor();
    expect((await f.approve(token, rahul)).state).toBe('paid');
    expect(await row(jti)).toMatchObject({ outcome: 'paid', callback_at: null, callback_refused_at: null, callback_attempts: 1 });
    await sweep(f.d);
    expect(await row(jti)).toMatchObject({ callback_at: null, callback_attempts: 2 });
    f.setGoStatus(200);
    await sweep(f.d);
    expect((await row(jti)).callback_at).not.toBeNull();
    expect(f.goCalls.filter((c) => c.body.approval_id === jti).map((c) => c.path)).toEqual([
      '/internal/vault/paid', '/internal/vault/paid', '/internal/vault/paid',
    ]);
  });

  it('stops after 50 tries, the only cap on a retried outcome', async () => {
    f.setGoStatus(503);
    const { token, jti } = await f.payLinkFor();
    await f.approve(token, rahul);
    await f.pool.query('update used_approvals set callback_attempts = 50 where jti = $1', [jti]);
    const before = f.goCalls.length;
    await sweep(f.d);
    f.setGoStatus(200);
    expect(f.goCalls.slice(before).filter((c) => c.body.approval_id === jti)).toEqual([]);
  });

  it('finishes a charge left half done, with the same idempotency key, once', async () => {
    const { jti } = await f.payLinkFor();
    const link = (await f.pool.query<{ link_id: string }>('select link_id from links where approval_id = $1 limit 1', [jti])).rows[0];
    const card = (await f.pool.query<{ card_id: string }>("select card_id from cards where person_id = 'p_rahul' limit 1")).rows[0];
    await f.pool.query(
      `insert into used_approvals (jti, approval_id, trip_id, payer_person_id, link_id, card_id, amount_minor, currency, merchant, rail, outcome, used_at)
       values ($1, $1, 't_goa', 'p_rahul', $2, $3, 5420000, 'INR', 'ixigo: Villa Sol, Anjuna', 'fake', 'charging', $4)`,
      [jti, link?.link_id, card?.card_id, new Date(f.now().getTime() - 180_000)],
    );
    expect((await sweep(f.d)).recharged).toBe(1);
    expect(await sweep(f.d)).toMatchObject({ recharged: 0 });
    expect(f.rail.charges.filter((c) => c.idempotencyKey === jti)).toHaveLength(1);
    expect(await row(jti)).toMatchObject({ outcome: 'paid' });
    expect(f.goCalls.at(-1)).toMatchObject({ path: '/internal/vault/paid', body: { approval_id: jti } });
  });

  it('does nothing for an approval it never paid with', async () => {
    expect(await reportOutcome(f.d, 'ap_unknown_000')).toBeUndefined();
  });

  it('forgets internal signatures after 10 minutes', async () => {
    await f.pool.query("insert into internal_seen (t, v1, seen_at) values (1, 'old', $1)", [new Date(f.now().getTime() - 700_000)]);
    await sweep(f.d);
    expect((await f.pool.query("select 1 from internal_seen where v1 = 'old'")).rowCount).toBe(0);
  });
});

describe('a charge the rail gave no clear answer for', () => {
  const later = (ms: number) => f.setNow(new Date(new Date('2026-10-05T09:01:00Z').getTime() + ms));
  const callsFor = (jti: string) => f.goCalls.filter((c) => c.body.approval_id === jti).map((c) => c.path);

  it('stays charging, is asked again with the same key, charges once, and Go hears paid once', async () => {
    const { token, jti } = await f.payLinkFor({ kind: 'stripe_test' });
    // Stripe took the charge, then the connection dropped before its answer came back.
    f.stripe.throwOnce = { type: 'StripeConnectionError', afterCharging: true };
    expect(await f.approve(token, rahul)).toEqual({ state: 'confirming' });
    expect(await row(jti)).toMatchObject({ outcome: 'charging', callback_at: null });
    expect(callsFor(jti)).toEqual([]);
    later(121_000);
    try {
      expect((await sweep(f.d)).recharged).toBe(1);
      await sweep(f.d);
    } finally {
      later(0);
    }
    expect(f.stripe.charges.filter((c) => c.idempotencyKey === jti)).toHaveLength(1);
    expect(await row(jti)).toMatchObject({ outcome: 'paid' });
    expect(callsFor(jti)).toEqual(['/internal/vault/paid']);
    const kinds = (await f.pool.query('select kind from unlock_log where approval_id = $1 order by id', [jti])).rows.map((r) => r.kind);
    expect(kinds).toEqual(['pay_attempt', 'pay_ok']);
  });

  it('after 20 unclear answers is marked unknown for a person to check, never failed, and Go is told nothing', async () => {
    const { token, jti } = await f.payLinkFor({ kind: 'stripe_test' });
    f.stripe.nextCharge = { error: { type: 'StripeAPIError', code: 'api_error' } };
    try {
      expect(await f.approve(token, rahul)).toEqual({ state: 'confirming' });
      later(121_000);
      for (let i = 0; i < 18; i += 1) await sweep(f.d);
      expect(await row(jti)).toMatchObject({ outcome: 'charging' });
      await sweep(f.d);
      expect(await row(jti)).toMatchObject({ outcome: 'unknown' });
      await sweep(f.d);
    } finally {
      f.stripe.nextCharge = { status: 'succeeded' };
      later(0);
    }
    expect(await row(jti)).toMatchObject({ outcome: 'unknown', callback_at: null });
    expect(callsFor(jti)).toEqual([]);
    expect(f.lines.join('\n')).toContain('marked unknown for a person to check');
    const kinds = (await f.pool.query('select kind from unlock_log where approval_id = $1 order by id', [jti])).rows.map((r) => r.kind);
    expect(kinds).toEqual(['pay_attempt']);
  });

  it('after an hour of unclear answers is marked unknown too', async () => {
    const { token, jti } = await f.payLinkFor({ kind: 'stripe_test' });
    f.stripe.nextCharge = { error: { type: 'StripeAPIError', code: 'api_error' } };
    try {
      expect(await f.approve(token, rahul)).toEqual({ state: 'confirming' });
      later(61 * 60_000);
      await sweep(f.d);
    } finally {
      f.stripe.nextCharge = { status: 'succeeded' };
      later(0);
    }
    expect(await row(jti)).toMatchObject({ outcome: 'unknown' });
    expect(callsFor(jti)).toEqual([]);
  });
});
