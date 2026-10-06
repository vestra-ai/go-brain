import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { masterKeyOf } from './crypto/envelope.js';
import type { VaultEnv } from './env.js';
import type { ChargeResult, RailKind, Rails } from './rails/rail.js';
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
    return { failed: 'rail_error' };
  }
}

/** Records the outcome once. Answers false when another worker already settled this attempt. */
export async function settle(db: Db, now: Date, a: AttemptRow, result: ChargeResult): Promise<boolean> {
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
