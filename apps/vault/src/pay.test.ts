import { verifyRequest } from '@go/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { payInfo } from './pay.js';
import { payFixture, type PayFixture } from './testing/pay-fixtures.js';
import { TEST_SHARED_SECRET } from './testing/vault-test-env.js';
import type { TestAuthenticator } from './testing/test-authenticator.js';

let f: PayFixture;
let rahul: TestAuthenticator;
let priya: TestAuthenticator;

const charges = (jti: string) => f.rail.charges.filter((c) => c.idempotencyKey === jti).length;
const logFor = async (jti: string) =>
  (await f.pool.query('select kind, passkey_ok, approval_ok, reason from unlock_log where approval_id = $1 order by id', [jti])).rows;

beforeAll(async () => {
  f = await payFixture();
  rahul = await f.registerFor('p_rahul');
  await f.cardFor('p_rahul');
  priya = await f.registerFor('p_priya');
  await f.cardFor('p_priya');
});
afterAll(async () => {
  await f.drop();
});

describe('a payment with both keys', () => {
  it('pays once, records the attempt and the outcome, and tells Go, signed', async () => {
    const { token, jti } = await f.payLinkFor();
    expect(await f.approve(token, rahul)).toEqual({ state: 'paid', railRef: `fake_${jti}` });
    const charge = f.rail.charges.at(-1);
    expect(charge).toMatchObject({ personId: 'p_rahul', paymentMethodRef: 'pm_card_visa', amountMinor: 5420000, currency: 'INR', idempotencyKey: jti });
    const call = f.goCalls.at(-1);
    expect(call?.path).toBe('/internal/vault/paid');
    expect(call?.body).toEqual({ trip_id: 't_goa', approval_id: jti, rail_ref: `fake_${jti}` });
    const signed = verifyRequest(
      { method: 'POST', target: '/internal/vault/paid', body: JSON.stringify(call?.body) },
      call?.signature,
      TEST_SHARED_SECRET,
      Math.floor(f.now().getTime() / 1000),
    );
    expect(signed).toEqual({ ok: true });
    expect(await logFor(jti)).toEqual([
      { kind: 'pay_attempt', passkey_ok: true, approval_ok: true, reason: null },
      { kind: 'pay_ok', passkey_ok: true, approval_ok: true, reason: null },
    ]);
    const used = await f.pool.query('select outcome, callback_at from used_approvals where jti = $1', [jti]);
    expect(used.rows[0].outcome).toBe('paid');
    expect(used.rows[0].callback_at).not.toBeNull();
  });

  it('never writes the card token to a log line', async () => {
    const { token } = await f.payLinkFor();
    await f.approve(token, rahul);
    expect(f.lines.length).toBeGreaterThan(0);
    expect(f.lines.join('\n')).not.toContain('pm_card_visa');
  });

  it('shows the payer what the Server approved', async () => {
    const { token } = await f.payLinkFor();
    expect(await payInfo(f.d, token)).toMatchObject({
      state: 'ready',
      merchant: 'ixigo: Villa Sol, Anjuna',
      purpose: 'Villa Sol, 3 nights, 6 to 9 Nov',
      amount_minor: 5420000,
      currency: 'INR',
      refundable_until: '2026-11-01T18:29:59Z',
      card: { brand: 'visa', last4: '4242' },
    });
  });
});

describe('step 1: the link', () => {
  it('refuses a link that does not exist', async () => {
    expect(await f.approve('A'.repeat(43), rahul)).toEqual({ state: 'refused', reason: 'link_invalid' });
  });

  it('refuses a link after it expires', async () => {
    const { token, jti } = await f.payLinkFor();
    f.setNow(new Date('2026-10-05T09:06:01Z'));
    try {
      expect(await f.approve(token, rahul)).toEqual({ state: 'refused', reason: 'link_expired' });
    } finally {
      f.setNow(new Date('2026-10-05T09:01:00Z'));
    }
    expect(charges(jti)).toBe(0);
  });

  it('refuses a link that already paid', async () => {
    const { token, jti } = await f.payLinkFor();
    await f.approve(token, rahul);
    expect(await f.approve(token, rahul)).toEqual({ state: 'refused', reason: 'link_used' });
    expect(charges(jti)).toBe(1);
    expect(await payInfo(f.d, token)).toEqual({ state: 'used' });
  });
});

describe('step 2: the passkey', () => {
  it('refuses a failed assertion and logs it without either key', async () => {
    const { token, jti } = await f.payLinkFor();
    rahul.userVerified = false;
    try {
      expect(await f.approve(token, rahul)).toEqual({ state: 'refused', reason: 'passkey_failed' });
    } finally {
      rahul.userVerified = true;
    }
    expect(charges(jti)).toBe(0);
    expect(await logFor(jti)).toEqual([{ kind: 'pay_refused', passkey_ok: false, approval_ok: false, reason: 'passkey_failed' }]);
  });

  it("refuses a friend's passkey on the payer's link", async () => {
    const { token, jti } = await f.payLinkFor();
    expect(await f.approve(token, priya)).toEqual({ state: 'refused', reason: 'not_the_payer' });
    expect(charges(jti)).toBe(0);
  });
});

describe('step 3 and 4: the Server approval', () => {
  it('refuses an approval that expired after the link was made', async () => {
    const { token, jti } = await f.payLinkFor();
    await f.pool.query("update links set expires_at = '2026-10-05T10:00:00Z' where approval_id = $1", [jti]);
    f.setNow(new Date('2026-10-05T09:10:30Z'));
    try {
      expect(await f.approve(token, rahul)).toEqual({ state: 'refused', reason: 'approval_expired' });
    } finally {
      f.setNow(new Date('2026-10-05T09:01:00Z'));
    }
    expect(charges(jti)).toBe(0);
  });

  it('refuses a token that was changed after signing', async () => {
    const { token, jti } = await f.payLinkFor();
    // Position 60 is inside the signed claims, so the signature no longer matches.
    await f.pool.query(
      "update pay_requests set approval = overlay(approval placing (case when substr(approval, 60, 1) = 'A' then 'B' else 'A' end) from 60 for 1) where approval_id = $1",
      [jti],
    );
    expect(await f.approve(token, rahul)).toEqual({ state: 'refused', reason: 'bad_approval' });
    expect(charges(jti)).toBe(0);
  });

  it('refuses an approval for another trip', async () => {
    const { token, jti } = await f.payLinkFor();
    await f.pool.query("update pay_requests set trip_id = 't_other' where approval_id = $1", [jti]);
    expect(await f.approve(token, rahul)).toEqual({ state: 'refused', reason: 'wrong_trip' });
    expect(charges(jti)).toBe(0);
  });
});

describe('step 5: one use', () => {
  it('refuses a second link for an approval that already paid', async () => {
    const first = await f.payLinkFor();
    const second = await f.payLinkFor({ jti: first.jti, sameApproval: true });
    expect((await f.approve(first.token, rahul)).state).toBe('paid');
    expect(await f.approve(second.token, rahul)).toEqual({ state: 'refused', reason: 'used' });
    expect(charges(first.jti)).toBe(1);
  });

  it('pays once when two links race, even from two of the payer\'s own passkeys', async () => {
    const rahulLaptop = await f.registerFor('p_rahul');
    const a = await f.payLinkFor();
    const b = await f.payLinkFor({ jti: a.jti, sameApproval: true });
    const results = await Promise.all([f.approve(a.token, rahul), f.approve(b.token, rahulLaptop)]);
    expect(results.map((r) => r.state).sort()).toEqual(['paid', 'refused']);
    expect(charges(a.jti)).toBe(1);
  });
});

describe('step 6: the payer is the person who unlocked', () => {
  it('refuses when the link was moved to someone the approval does not name', async () => {
    const { token, jti } = await f.payLinkFor();
    await f.pool.query("update links set person_id = 'p_priya' where approval_id = $1", [jti]);
    expect(await f.approve(token, priya)).toEqual({ state: 'refused', reason: 'not_the_payer' });
    expect(charges(jti)).toBe(0);
  });
});

describe('step 7: within the approval', () => {
  it('refuses an amount above the approval', async () => {
    const { token, jti } = await f.payLinkFor();
    await f.pool.query('update pay_requests set amount_minor = 5420001 where approval_id = $1', [jti]);
    expect(await f.approve(token, rahul)).toEqual({ state: 'refused', reason: 'over_amount' });
    expect(charges(jti)).toBe(0);
  });

  it('refuses another currency', async () => {
    const { token, jti } = await f.payLinkFor();
    await f.pool.query("update pay_requests set currency = 'USD' where approval_id = $1", [jti]);
    expect(await f.approve(token, rahul)).toEqual({ state: 'refused', reason: 'currency_mismatch' });
  });

  it('refuses a hold that is about to run out', async () => {
    const { token, jti } = await f.payLinkFor();
    await f.pool.query("update pay_requests set hold_expires_at = '2026-10-05T09:01:20Z' where approval_id = $1", [jti]);
    expect(await f.approve(token, rahul)).toEqual({ state: 'refused', reason: 'hold_expiring' });
  });

  it('refuses a payer with no card', async () => {
    const kabir = await f.registerFor('p_kabir');
    const { token } = await f.payLinkFor({ payer: 'p_kabir' });
    expect(await f.approve(token, kabir)).toEqual({ state: 'refused', reason: 'no_card' });
  });
});

describe('step 8: the rail fails', () => {
  it('records the failure, uses up the approval and tells Go why', async () => {
    const { token, jti } = await f.payLinkFor();
    f.rail.outcome = 'card_declined';
    try {
      expect(await f.approve(token, rahul)).toEqual({ state: 'failed', reason: 'card_declined' });
    } finally {
      f.rail.outcome = 'ok';
    }
    expect(f.goCalls.at(-1)).toMatchObject({ path: '/internal/vault/failed', body: { trip_id: 't_goa', approval_id: jti, reason: 'card_declined' } });
    expect((await logFor(jti)).map((r) => r.kind)).toEqual(['pay_attempt', 'pay_failed']);
    expect(await f.approve(token, rahul)).toEqual({ state: 'refused', reason: 'link_used' });
  });
});
