import type pg from 'pg';
import type { Confirmed } from '../travel/travel.js';
import type { Room } from './rooms.js';

/** 'confirming': the vault took the payer's yes but the bank has not said whether the charge went through. It never expires. */
export type PaymentState = 'asking' | 'waiting' | 'confirming' | 'paid' | 'declined' | 'expired' | 'failed' | 'refused';
export type ReleaseReason = 'payment_failed' | 'payer_declined' | 'price_changed' | 'expired' | 'other';
type Db = pg.Pool | pg.PoolClient;

/** 'ticket': a traveller's own ticket (contract 1.2), paid with no vote; its traveller is the payer. */
export type AskKind = 'group' | 'ticket';

export interface PaymentRow {
  payment_id: string;
  trip_id: string;
  kind: AskKind;
  /** The vote; null for a ticket. */
  decision_id: string | null;
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
  /** The rooms the stay's expenses split by, kept when the payment was asked (REV4 B6); [] for none picked. */
  rooms: Room[] | null;
  booking_id: string | null;
  expense_id: string | null;
  released_at: Date | null;
  ticket_posted_at: Date | null;
  said_at: Date | null;
  /** The vault will not ask the bank again and a person is checking the charge; the payment stays confirming. */
  checking_at: Date | null;
  /** A traveller's own payment (contract 1.3, G3): the card of Go's they tapped and the option on it. Null for a vote's. */
  pick_card_id: string | null;
  pick_option_id: string | null;
  /**
   * 'server': the Server paid it itself on the payer's tap (payment.completed, method demo) and wrote its booking and
   * expense; no vault and no money. Null: the vault paid it, and Go books it.
   */
  paid_by: 'server' | null;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface NewPayment {
  payment_id: string;
  trip_id: string;
  /** Absent: 'group'. */
  kind?: AskKind;
  decision_id: string | null;
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
  /** The rooms picked for the stay when the payment is asked; [] for none, null when nothing reads them. */
  rooms?: Room[] | null;
  /** A traveller's own payment (contract 1.3): their pick, the card and its option. */
  pick_card_id?: string | null;
  pick_option_id?: string | null;
}

const PATCHABLE = [
  'refused_reason', 'release_reason', 'approval_id', 'approval_token', 'approval_expires_at', 'card_id', 'card_state',
  'pay_link_url', 'pay_link_expires_at', 'rail_ref', 'fail_reason', 'confirmed', 'rooms', 'booking_id', 'expense_id',
  'released_at', 'ticket_posted_at', 'said_at', 'last_error', 'checking_at', 'paid_by',
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
    values.push((key === 'confirmed' || key === 'rooms') && value !== null && value !== undefined ? JSON.stringify(value) : value);
  }
  return { sql, values };
}

export async function insertAsking(db: Db, p: NewPayment, now: Date): Promise<'ok' | 'busy'> {
  try {
    await db.query(
      `insert into payments (payment_id, trip_id, decision_id, option_ref, purpose, label, payer_person_id, payer_name, for_person_ids, state,
         hold_id, amount_minor, currency, merchant, payment_kind, hold_expires_at, refundable_until, rooms, kind, pick_card_id, pick_option_id,
         created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'asking', $10, $11, $12, $13, $14, $15, $16, $18, $19, $20, $21, $17, $17)`,
      [
        p.payment_id, p.trip_id, p.decision_id, p.option_ref, p.purpose, p.label, p.payer_person_id, p.payer_name, p.for_person_ids,
        p.hold_id, p.amount_minor, p.currency, p.merchant, p.payment_kind, p.hold_expires_at, p.refundable_until, now,
        p.rooms ? JSON.stringify(p.rooms) : null, p.kind ?? 'group', p.pick_card_id ?? null, p.pick_option_id ?? null,
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
/** The open ask for a traveller's ticket, by what it pays for (its key, kept as option_ref). */
export const openTicket = (db: Db, tripId: string, key: string) =>
  one(db, "trip_id = $1 and kind = 'ticket' and option_ref = $2 and state in ('asking', 'waiting', 'confirming')", [tripId, key]);
export const openForDecision = (db: Db, tripId: string, decisionId: string) =>
  one(db, "trip_id = $1 and decision_id = $2 and state in ('asking', 'waiting', 'confirming')", [tripId, decisionId]);
export const paidForDecision = (db: Db, tripId: string, decisionId: string) =>
  one(db, "trip_id = $1 and decision_id = $2 and state = 'paid'", [tripId, decisionId]);

export async function listForTrip(db: Db, tripId: string, limit = 12): Promise<PaymentRow[]> {
  const r = await db.query<PaymentRow>('select * from payments where trip_id = $1 order by created_at desc limit $2', [tripId, limit]);
  return r.rows;
}

/** Records a failed step and answers how many tries the payment has had. */
export async function bumpAttempt(db: Db, id: string, error: string, now: Date): Promise<number> {
  const r = await db.query<{ attempts: number }>(
    'update payments set attempts = attempts + 1, last_error = $2, updated_at = $3 where payment_id = $1 returning attempts',
    [id, error.slice(0, 300), now],
  );
  return r.rows[0]?.attempts ?? 0;
}

/** After this many failed tries a step stops being retried, except a paid payment's, which backs off instead. */
export const STEP_TRIES = 20;
/** How often a paid payment that is still not finished in the room is tried after STEP_TRIES. */
export const PAID_BACKOFF_MS = 10 * 60_000;

/**
 * Payments whose room or Server still needs a step: a release, a card update, a booking, a line. A paid payment is never
 * dropped: money moved, so after STEP_TRIES it is tried every PAID_BACKOFF_MS instead.
 */
export async function unsettled(db: Db, now: Date, limit = 50): Promise<string[]> {
  const r = await db.query<{ payment_id: string }>(
    `select payment_id from payments where
       (state = 'paid' and ticket_posted_at is null and (attempts < $2 or updated_at < $3))
       or (attempts < $2 and (
         (state in ('declined', 'expired', 'failed', 'refused') and approval_id is not null and released_at is null)
         or (state in ('declined', 'expired', 'failed') and card_id is not null and card_state is distinct from state)
         or (state in ('declined', 'failed') and said_at is null)
         or (state = 'confirming' and card_id is not null
             and card_state is distinct from (case when checking_at is null then 'confirming' else 'checking' end))
       ))
     order by updated_at limit $1`,
    [limit, STEP_TRIES, new Date(now.getTime() - PAID_BACKOFF_MS)],
  );
  return r.rows.map((x) => x.payment_id);
}

/**
 * Paid payments, and those of them not booked yet: money moved, the room does not show it. Rows paid in the last 2 minutes
 * are still being finished. A ticket is booked by its own flow (the flight booking that asked for it), not here.
 */
export async function paidButNotBooked(db: Db, before: Date): Promise<{ missing: number; paid: number }> {
  const r = await db.query<{ missing: number; paid: number }>(
    `select count(*) filter (where booking_id is null and updated_at < $1)::int as missing, count(*)::int as paid
     from payments where state = 'paid' and kind = 'group'`,
    [new Date(before.getTime() - 120_000)],
  );
  return r.rows[0] ?? { missing: 0, paid: 0 };
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

/** Payments the vault paid. One the Server paid itself (payment.completed) moved no money and never opened the vault. */
export async function paidApprovalIds(db: Db): Promise<string[]> {
  const r = await db.query<{ approval_id: string }>(
    "select approval_id from payments where state = 'paid' and approval_id is not null and paid_by is null",
  );
  return r.rows.map((x) => x.approval_id);
}
