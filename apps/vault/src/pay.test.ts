import { verifyRequest } from '@go/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { approvePayment, payInfo, payOptions } from './pay.js';
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

// Contract 1.2: a traveller's own ticket is never voted on. The Server's approval names the traveller (for_person_id),
// who is its payer; the vault still takes both keys, and only that traveller's Face ID pays it.
describe("step 6 for a ticket: only its traveller pays it", () => {
  it("pays a ticket with the traveller's own passkey, with both keys in the log", async () => {
    const { token, jti } = await f.payLinkFor({ ticketFor: 'p_priya' });
    expect(await f.approve(token, priya)).toEqual({ state: 'paid', railRef: `fake_${jti}` });
    expect(f.rail.charges.at(-1)).toMatchObject({ personId: 'p_priya', idempotencyKey: jti });
    expect(await logFor(jti)).toEqual([
      { kind: 'pay_attempt', passkey_ok: true, approval_ok: true, reason: null },
      { kind: 'pay_ok', passkey_ok: true, approval_ok: true, reason: null },
    ]);
  });

  it("refuses anyone else's passkey, even on a link moved to them", async () => {
    const { token, jti } = await f.payLinkFor({ ticketFor: 'p_priya' });
    await f.pool.query("update links set person_id = 'p_rahul' where approval_id = $1", [jti]);
    expect(await f.approve(token, rahul)).toEqual({ state: 'refused', reason: 'not_the_payer' });
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

describe('step 8: a charge that is not sent', () => {
  /**
   * The vault's pool, with `fn` run right after the attempt's transaction commits and before the charge: what another
   * copy of the vault, or the clock, does in between.
   */
  function afterCommit(fn: () => Promise<void>): pg.Pool {
    return new Proxy(f.pool, {
      get(target, prop) {
        if (prop === 'connect') {
          return async () => {
            const client = await target.connect();
            const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
            const release = client.release.bind(client);
            (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
              const r = await query(...args);
              if (args[0] === 'commit') await fn();
              return r;
            };
            client.release = ((err?: Error | boolean) => {
              (client as unknown as { query: unknown }).query = query;
              return release(err);
            }) as typeof client.release;
            return client;
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  }

  async function approveWith(token: string, pool: pg.Pool) {
    const opts = await payOptions(f.d, token);
    if (!opts.ok) throw new Error(opts.reason);
    return approvePayment({ ...f.d, pool }, { token, challengeId: opts.challengeId, response: rahul.assert(opts.options) });
  }

  const rowOf = async (jti: string) =>
    (await f.pool.query('select outcome, fail_reason, rail_called_at, charge_tries from used_approvals where jti = $1', [jti])).rows[0];

  it('past its deadline before it went out, fails at once: nothing was charged, the payer and Go hear failed', async () => {
    const { token, jti } = await f.payLinkFor();
    // The approval runs out at 09:10, so the deadline is 09:12: the clock passes it between taking the approval and charging.
    try {
      expect(await approveWith(token, afterCommit(async () => f.setNow(new Date('2026-10-05T09:13:00Z'))))).toEqual({
        state: 'failed',
        reason: 'rail_error',
      });
    } finally {
      f.setNow(new Date('2026-10-05T09:01:00Z'));
    }
    expect(await rowOf(jti)).toMatchObject({ outcome: 'failed', fail_reason: 'rail_error', rail_called_at: null, charge_tries: 0 });
    expect(f.rail.asked.filter((k) => k === jti)).toEqual([]);
    expect(f.goCalls.filter((c) => c.body.approval_id === jti)).toMatchObject([{ path: '/internal/vault/failed', body: { reason: 'rail_error' } }]);
    expect((await logFor(jti)).map((r) => r.kind)).toEqual(['pay_attempt', 'pay_failed']);
  });

  it('settled failed by another copy of the vault first: a late approve neither stamps nor charges it', async () => {
    const { token, jti } = await f.payLinkFor();
    const settledElsewhere = async () => {
      await f.pool.query("update used_approvals set outcome = 'failed', fail_reason = 'rail_error', settled_at = now() where jti = $1", [jti]);
    };
    expect(await approveWith(token, afterCommit(settledElsewhere))).toEqual({ state: 'failed', reason: 'rail_error' });
    expect(await rowOf(jti)).toMatchObject({ outcome: 'failed', rail_called_at: null });
    expect(f.rail.asked.filter((k) => k === jti)).toEqual([]);
    expect(charges(jti)).toBe(0);
  });
});
