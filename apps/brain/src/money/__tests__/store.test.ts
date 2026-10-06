import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { paymentIdFor, rid } from '../ids.js';
import {
  expireOverdue,
  getPayment,
  insertAsking,
  interruptStale,
  openForDecision,
  paidButNotBooked,
  patchPayment,
  transition,
  unsettled,
  type NewPayment,
} from '../store.js';

let pool: pg.Pool;
let drop: () => Promise<void>;
const t0 = new Date('2026-10-05T09:00:00Z');

let asks = 0;
const ask = (over: Partial<NewPayment> = {}): NewPayment => ({
  payment_id: paymentIdFor('t_goa', `go_spend_test_${++asks}`),
  trip_id: 't_goa',
  decision_id: 'd_villa',
  option_ref: 'opt_villa_sol',
  purpose: 'Villa Sol, 3 nights, 6 to 9 Nov',
  label: 'Villa Sol',
  payer_person_id: 'p_rahul',
  payer_name: 'Rahul',
  for_person_ids: ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir'],
  hold_id: 'hold_1',
  amount_minor: 5420000,
  currency: 'INR',
  merchant: 'ixigo: Villa Sol, Anjuna',
  payment_kind: 'fake',
  hold_expires_at: new Date('2026-10-05T09:15:00Z'),
  refundable_until: '2026-11-01T18:29:59Z',
  ...over,
});

beforeAll(async () => {
  ({ pool, drop } = await withSchema());
});
afterAll(async () => {
  await drop();
});

describe('ids', () => {
  it('makes readable ids when they fit and stable hashed ids when they do not', () => {
    expect(rid('go_paid', 'ap_01JA7Q3V8Z', 'booking')).toBe('go_paid_ap_01JA7Q3V8Z_booking');
    const long = rid('go_paid', 'ap_'.padEnd(64, 'x'), 'booking');
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toBe(rid('go_paid', 'ap_'.padEnd(64, 'x'), 'booking'));
    expect(long.startsWith('go_paid_')).toBe(true);
    expect(paymentIdFor('t_goa', 'go_spend_1')).toBe(paymentIdFor('t_goa', 'go_spend_1'));
    expect(paymentIdFor('t_goa', 'go_spend_1')).not.toBe(paymentIdFor('t_goa', 'go_spend_2'));
  });
});

describe('payments', () => {
  it('keeps one open ask per vote', async () => {
    const first = ask();
    expect(await insertAsking(pool, first, t0)).toBe('ok');
    expect(await insertAsking(pool, ask(), t0)).toBe('busy');
    expect(await transition(pool, first.payment_id, ['asking'], 'waiting', { card_id: 'c_pay_1', card_state: 'waiting' }, t0)).toBe(true);
    expect(await insertAsking(pool, ask(), t0)).toBe('busy');
    expect((await openForDecision(pool, 't_goa', 'd_villa'))?.payment_id).toBe(first.payment_id);
    expect(await transition(pool, first.payment_id, ['waiting'], 'paid', { rail_ref: 'fake_ap_1' }, t0)).toBe(true);
    expect(await openForDecision(pool, 't_goa', 'd_villa')).toBeNull();
    expect(await insertAsking(pool, ask(), t0)).toBe('ok');
  });

  it('moves a payment only from the states it names', async () => {
    const p = ask({ decision_id: 'd_two' });
    await insertAsking(pool, p, t0);
    expect(await transition(pool, p.payment_id, ['waiting'], 'paid', {}, t0)).toBe(false);
    expect((await getPayment(pool, p.payment_id))?.state).toBe('asking');
  });

  it('patches named fields and the update time', async () => {
    const p = ask({ decision_id: 'd_three' });
    await insertAsking(pool, p, t0);
    const later = new Date(t0.getTime() + 5000);
    await patchPayment(pool, p.payment_id, { approval_id: 'ap_patch_001', confirmed: { ref: 'IXG-1' } as never }, later);
    const row = await getPayment(pool, p.payment_id);
    expect(row?.approval_id).toBe('ap_patch_001');
    expect(row?.confirmed).toEqual({ ref: 'IXG-1' });
    expect(row?.updated_at.toISOString()).toBe(later.toISOString());
  });

  it('expires a waiting payment only 120 seconds after its approval ran out', async () => {
    const p = ask({ decision_id: 'd_four' });
    await insertAsking(pool, p, t0);
    await transition(pool, p.payment_id, ['asking'], 'waiting', { approval_expires_at: new Date('2026-10-05T09:10:00Z') }, t0);
    expect(await expireOverdue(pool, new Date('2026-10-05T09:11:59Z'))).toEqual([]);
    expect(await expireOverdue(pool, new Date('2026-10-05T09:12:01Z'))).toEqual([p.payment_id]);
    expect(await getPayment(pool, p.payment_id)).toMatchObject({ state: 'expired', release_reason: 'expired' });
  });

  it('gives up on an ask stuck halfway after a minute', async () => {
    const p = ask({ decision_id: 'd_five' });
    await insertAsking(pool, p, t0);
    expect(await interruptStale(pool, new Date(t0.getTime() + 30_000))).toEqual([]);
    // Earlier tests leave their own asks open too, so this one is among those given up, not the only one.
    expect(await interruptStale(pool, new Date(t0.getTime() + 61_000))).toContain(p.payment_id);
    expect(await getPayment(pool, p.payment_id)).toMatchObject({ state: 'refused', refused_reason: 'interrupted' });
  });

  it('lists the payments whose room still needs work', async () => {
    const paid = ask({ decision_id: 'd_six' });
    await insertAsking(pool, paid, t0);
    await transition(pool, paid.payment_id, ['asking'], 'paid', { approval_id: 'ap_six_00001' }, t0);
    const ids = await unsettled(pool, t0);
    expect(ids).toContain(paid.payment_id);
    await patchPayment(pool, paid.payment_id, { ticket_posted_at: t0 }, t0);
    expect(await unsettled(pool, t0)).not.toContain(paid.payment_id);
  });

  it('never drops a paid payment that is not booked: after 20 tries it backs off to every 10 minutes', async () => {
    const paid = ask({ decision_id: 'd_seven' });
    await insertAsking(pool, paid, t0);
    await transition(pool, paid.payment_id, ['asking'], 'paid', { approval_id: 'ap_seven_0001' }, t0);
    await pool.query('update payments set attempts = 20 where payment_id = $1', [paid.payment_id]);
    expect(await unsettled(pool, new Date(t0.getTime() + 60_000))).not.toContain(paid.payment_id);
    expect(await unsettled(pool, new Date(t0.getTime() + 11 * 60_000))).toContain(paid.payment_id);
    const closed = ask({ decision_id: 'd_eight' });
    await insertAsking(pool, closed, t0);
    await transition(pool, closed.payment_id, ['asking'], 'declined', { approval_id: 'ap_eight_0001' }, t0);
    await pool.query('update payments set attempts = 20 where payment_id = $1', [closed.payment_id]);
    expect(await unsettled(pool, new Date(t0.getTime() + 11 * 60_000))).not.toContain(closed.payment_id);
  });

  it('counts paid payments that are not booked, after the first 2 minutes', async () => {
    const before = await paidButNotBooked(pool, new Date(t0.getTime() + 60_000));
    const after = await paidButNotBooked(pool, new Date(t0.getTime() + 3 * 60_000));
    expect(after.missing).toBeGreaterThan(before.missing);
    expect(after.paid).toBe(before.paid);
  });

  it('has no column for card details', async () => {
    const r = await pool.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'payments' and table_schema = current_schema()",
    );
    expect(r.rows.map((x) => x.column_name).filter((n) => /pan|card_number|cvv|cvc|last4|password|payment_method/.test(n))).toEqual([]);
  });
});
