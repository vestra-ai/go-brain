import type pg from 'pg';
import type { Confirmed } from '../travel/travel.js';

export type PaymentState = 'asking' | 'waiting' | 'paid' | 'declined' | 'expired' | 'failed' | 'refused';
export type ReleaseReason = 'payment_failed' | 'payer_declined' | 'price_changed' | 'expired' | 'other';
type Db = pg.Pool | pg.PoolClient;

export interface PaymentRow {
  payment_id: string;
  trip_id: string;
  decision_id: string;
  option_ref: string;
  purpose: string;
  label: string;
  payer_person_id: string;
  payer_name: string;
  for_person_ids: string[];
  state: PaymentState;
  refused_reason: string | null;
  release_reason: ReleaseReason | null;
  hold_id: string | null;
  amount_minor: number | null;
  currency: string | null;
  merchant: string | null;
  payment_kind: string | null;
  hold_expires_at: Date | null;
  refundable_until: string | null;
  approval_id: string | null;
  approval_token: string | null;
  approval_expires_at: Date | null;
  card_id: string | null;
  card_state: string | null;
  pay_link_url: string | null;
  pay_link_expires_at: Date | null;
  rail_ref: string | null;
  fail_reason: string | null;
  confirmed: Confirmed | null;
  booking_id: string | null;
  expense_id: string | null;
  released_at: Date | null;
  ticket_posted_at: Date | null;
  said_at: Date | null;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface NewPayment {
  payment_id: string;
  trip_id: string;
  decision_id: string;
  option_ref: string;
  purpose: string;
  label: string;
  payer_person_id: string;
  payer_name: string;
  for_person_ids: string[];
  hold_id: string;
  amount_minor: number;
  currency: string;
  merchant: string;
  payment_kind: string;
  hold_expires_at: Date;
  refundable_until: string | null;
}

const PATCHABLE = [
  'refused_reason', 'release_reason', 'approval_id', 'approval_token', 'approval_expires_at', 'card_id', 'card_state',
  'pay_link_url', 'pay_link_expires_at', 'rail_ref', 'fail_reason', 'confirmed', 'booking_id', 'expense_id',
  'released_at', 'ticket_posted_at', 'said_at', 'last_error',
] as const;
export type PaymentPatch = Partial<Pick<PaymentRow, (typeof PATCHABLE)[number]>>;

/** "set a = $n, b = $n+1" for the known keys in the patch, and their values. */
function setClause(patch: PaymentPatch, first: number): { sql: string[]; values: unknown[] } {
  const sql: string[] = [];
  const values: unknown[] = [];
  for (const key of PATCHABLE) {
    if (!(key in patch)) continue;
    const value = patch[key];
    sql.push(`${key} = $${first + values.length}`);
    values.push(key === 'confirmed' && value !== null && value !== undefined ? JSON.stringify(value) : value);
  }
  return { sql, values };
}

export async function insertAsking(db: Db, p: NewPayment, now: Date): Promise<'ok' | 'busy'> {
  try {
    await db.query(
      `insert into payments (payment_id, trip_id, decision_id, option_ref, purpose, label, payer_person_id, payer_name, for_person_ids, state,
         hold_id, amount_minor, currency, merchant, payment_kind, hold_expires_at, refundable_until, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'asking', $10, $11, $12, $13, $14, $15, $16, $17, $17)`,
      [
        p.payment_id, p.trip_id, p.decision_id, p.option_ref, p.purpose, p.label, p.payer_person_id, p.payer_name, p.for_person_ids,
        p.hold_id, p.amount_minor, p.currency, p.merchant, p.payment_kind, p.hold_expires_at, p.refundable_until, now,
      ],
    );
    return 'ok';
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return 'busy';
    throw e;
  }
}

export async function patchPayment(db: Db, id: string, patch: PaymentPatch, now: Date): Promise<void> {
  const set = setClause(patch, 3);
  await db.query(`update payments set ${[...set.sql, 'updated_at = $2'].join(', ')} where payment_id = $1`, [id, now, ...set.values]);
}

/** Moves a payment to `to` only from one of `from`. False when another path moved it first. */
export async function transition(db: Db, id: string, from: PaymentState[], to: PaymentState, patch: PaymentPatch, now: Date): Promise<boolean> {
  const set = setClause(patch, 5);
  const r = await db.query(
    `update payments set ${['state = $3', 'updated_at = $2', ...set.sql].join(', ')} where payment_id = $1 and state = any($4::text[])`,
    [id, now, to, from, ...set.values],
  );
  return (r.rowCount ?? 0) > 0;
}

async function one(db: Db, where: string, values: unknown[]): Promise<PaymentRow | null> {
  const r = await db.query<PaymentRow>(`select * from payments where ${where} order by created_at desc limit 1`, values);
  return r.rows[0] ?? null;
}

export const getPayment = (db: Db, id: string) => one(db, 'payment_id = $1', [id]);
export const byApproval = (db: Db, tripId: string, approvalId: string) => one(db, 'trip_id = $1 and approval_id = $2', [tripId, approvalId]);
export const byCard = (db: Db, tripId: string, cardId: string) => one(db, 'trip_id = $1 and card_id = $2', [tripId, cardId]);
export const openForDecision = (db: Db, tripId: string, decisionId: string) =>
  one(db, "trip_id = $1 and decision_id = $2 and state in ('asking', 'waiting')", [tripId, decisionId]);
export const paidForDecision = (db: Db, tripId: string, decisionId: string) =>
  one(db, "trip_id = $1 and decision_id = $2 and state = 'paid'", [tripId, decisionId]);

export async function listForTrip(db: Db, tripId: string, limit = 12): Promise<PaymentRow[]> {
  const r = await db.query<PaymentRow>('select * from payments where trip_id = $1 order by created_at desc limit $2', [tripId, limit]);
  return r.rows;
}

export async function bumpAttempt(db: Db, id: string, error: string, now: Date): Promise<void> {
  await db.query('update payments set attempts = attempts + 1, last_error = $2, updated_at = $3 where payment_id = $1', [id, error.slice(0, 300), now]);
}

/** Payments whose room or Server still needs a step: a release, a card update, a booking, a line. */
export async function unsettled(db: Db, limit = 50): Promise<string[]> {
  const r = await db.query<{ payment_id: string }>(
    `select payment_id from payments where attempts < 20 and (
       (state = 'paid' and ticket_posted_at is null)
       or (state in ('declined', 'expired', 'failed', 'refused') and approval_id is not null and released_at is null)
       or (state in ('declined', 'expired', 'failed') and card_id is not null and card_state is distinct from state)
       or (state in ('declined', 'failed') and said_at is null)
     ) order by updated_at limit $1`,
    [limit],
  );
  return r.rows.map((x) => x.payment_id);
}

/** How long after its approval runs out a waiting payment is left alone: the vault may still finish a charge at the edge. */
export const EXPIRY_GRACE_MS = 120_000;

/** A waiting payment whose approval ran out more than graceMs ago. The vault may still finish a charge at the edge. */
export async function expireOverdue(db: Db, now: Date, graceMs = EXPIRY_GRACE_MS): Promise<string[]> {
  const r = await db.query<{ payment_id: string }>(
    `update payments set state = 'expired', release_reason = 'expired', updated_at = $1
     where state = 'waiting' and approval_expires_at < $2 returning payment_id`,
    [now, new Date(now.getTime() - graceMs)],
  );
  return r.rows.map((x) => x.payment_id);
}

/** An ask that stopped halfway (the service restarted between the approval and the card) is given up. */
export async function interruptStale(db: Db, now: Date, ageMs = 60_000): Promise<string[]> {
  const r = await db.query<{ payment_id: string }>(
    `update payments set state = 'refused', refused_reason = 'interrupted', release_reason = 'other', updated_at = $1
     where state = 'asking' and created_at < $2 returning payment_id`,
    [now, new Date(now.getTime() - ageMs)],
  );
  return r.rows.map((x) => x.payment_id);
}

export async function paidApprovalIds(db: Db): Promise<string[]> {
  const r = await db.query<{ approval_id: string }>("select approval_id from payments where state = 'paid' and approval_id is not null");
  return r.rows.map((x) => x.approval_id);
}
