import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { masterKeyOf } from './crypto/envelope.js';
import type { VaultEnv } from './env.js';
import type { ChargeResult, RailKind, Rails, SettledResult } from './rails/rail.js';
import { openCardRef } from './store/cards.js';
import type { Db } from './store/people.js';
import { logUnlock } from './store/unlock-log.js';

export interface PayDeps {
  env: VaultEnv;
  pool: pg.Pool;
  now: () => Date;
  rails: Rails;
  fetch: typeof fetch;
  log: FastifyBaseLogger;
}

/** One row of used_approvals: one approval the vault tried to pay with. */
export interface AttemptRow {
  jti: string;
  approval_id: string;
  trip_id: string;
  payer_person_id: string;
  card_id: string;
  amount_minor: number;
  currency: string;
  merchant: string;
  rail: RailKind;
}

/** Opens the card token in memory, hands it to the rail, and drops it. Nothing here is logged. */
export async function chargeOnce(d: PayDeps, a: AttemptRow): Promise<ChargeResult> {
  let ref: string;
  try {
    ref = await openCardRef(d.pool, masterKeyOf(d.env.VAULT_MASTER_KEY), a.payer_person_id, a.card_id);
  } catch {
    return { failed: 'rail_error' };
  }
  // Stamped before the call: past the deadline, a charge the rail may have seen is never called a failure.
  await d.pool.query('update used_approvals set rail_called_at = coalesce(rail_called_at, $2) where jti = $1', [a.jti, d.now()]);
  try {
    return await d.rails[a.rail].charge({
      personId: a.payer_person_id,
      paymentMethodRef: ref,
      amountMinor: a.amount_minor,
      currency: a.currency,
      merchant: a.merchant,
      idempotencyKey: a.jti,
    });
  } catch {
    // The rail threw: the money may or may not have moved, so this is never a failure.
    return { unknown: 'thrown' };
  }
}

/** How many unclear answers, and for how long, before a person has to look at a charge. */
export const UNKNOWN_TRIES = 20;
export const UNKNOWN_FOR_MS = 60 * 60_000;

/**
 * The rail gave no clear answer. The row stays charging, so the sweep asks the rail again with the same jti (the rail
 * answers the same payment for the same key). After UNKNOWN_TRIES unclear answers or an hour, the row is marked unknown
 * for a person to check, never failed: the money may have moved.
 */
export async function holdUnknown(d: Pick<PayDeps, 'pool' | 'log'>, now: Date, a: AttemptRow, why: string): Promise<'retry' | 'gave_up'> {
  const r = await d.pool.query<{ charge_tries: number; used_at: Date }>(
    "update used_approvals set charge_tries = charge_tries + 1 where jti = $1 and outcome = 'charging' returning charge_tries, used_at",
    [a.jti],
  );
  const row = r.rows[0];
  if (!row || (row.charge_tries < UNKNOWN_TRIES && now.getTime() - row.used_at.getTime() < UNKNOWN_FOR_MS)) return 'retry';
  await markUnknown(d, now, a, `${why}, after ${row.charge_tries} tries`);
  return 'gave_up';
}

/** The money may have moved and the rail will not be asked again: a person checks it. Never failed. */
export async function markUnknown(d: Pick<PayDeps, 'pool' | 'log'>, now: Date, a: AttemptRow, why: string): Promise<void> {
  const r = await d.pool.query("update used_approvals set outcome = 'unknown', settled_at = $2 where jti = $1 and outcome = 'charging'", [a.jti, now]);
  if ((r.rowCount ?? 0) === 0) return;
  d.log.error(
    { approval_id: a.approval_id, rail: a.rail, why },
    'the rail never said whether this payment went through; marked unknown for a person to check',
  );
}

/** Records the outcome once. Answers false when another worker already settled this attempt. */
export async function settle(db: Db, now: Date, a: AttemptRow, result: SettledResult): Promise<boolean> {
  const paid = 'railRef' in result;
  const r = await db.query(
    `update used_approvals set outcome = $2, rail_ref = $3, fail_reason = $4, settled_at = $5
     where jti = $1 and outcome = 'charging'`,
    [a.jti, paid ? 'paid' : 'failed', paid ? result.railRef : null, paid ? null : result.failed, now],
  );
  if ((r.rowCount ?? 0) === 0) return false;
  await logUnlock(db, now, {
    personId: a.payer_person_id,
    kind: paid ? 'pay_ok' : 'pay_failed',
    cardId: a.card_id,
    approvalId: a.approval_id,
    tripId: a.trip_id,
    amountMinor: a.amount_minor,
    currency: a.currency,
    merchant: a.merchant,
    passkeyOk: true,
    approvalOk: true,
    rail: a.rail,
    ...(paid ? { railRef: result.railRef } : { reason: result.failed }),
  });
  return true;
}
