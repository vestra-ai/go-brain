import { signRequest } from '@go/contract';
import { chargeOnce, settle, type AttemptRow, type PayDeps } from './charge.js';
import { VAULT_SIGNATURE_HEADER } from './internal/auth.js';
import type { RailFailReason } from './rails/rail.js';

export type GoOutcome =
  | { kind: 'paid'; trip_id: string; approval_id: string; rail_ref: string }
  | { kind: 'failed'; trip_id: string; approval_id: string; reason: RailFailReason };

/** Calls Go back, signed with VAULT_SHARED_SECRET. 'final' means Go answered something a retry cannot change. */
export async function tellGo(d: Pick<PayDeps, 'env' | 'fetch' | 'now'>, o: GoOutcome): Promise<'ok' | 'retry' | 'final'> {
  const url = new URL(o.kind === 'paid' ? '/internal/vault/paid' : '/internal/vault/failed', d.env.GO_CALLBACK_URL);
  const body = JSON.stringify(
    o.kind === 'paid'
      ? { trip_id: o.trip_id, approval_id: o.approval_id, rail_ref: o.rail_ref }
      : { trip_id: o.trip_id, approval_id: o.approval_id, reason: o.reason },
  );
  const signature = signRequest(
    { method: 'POST', target: url.pathname + url.search, body },
    d.env.VAULT_SHARED_SECRET,
    Math.floor(d.now().getTime() / 1000),
  );
  try {
    const res = await d.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [VAULT_SIGNATURE_HEADER]: signature },
      body,
      signal: AbortSignal.timeout(2_000),
    });
    if (res.ok) return 'ok';
    if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 408 && res.status !== 429) return 'final';
    return 'retry';
  } catch {
    return 'retry';
  }
}

interface SettledRow extends AttemptRow {
  outcome: 'paid' | 'failed';
  rail_ref: string | null;
  fail_reason: RailFailReason | null;
}

/** Sends a settled outcome to Go once Go has not acknowledged it yet. */
export async function reportOutcome(d: PayDeps, jti: string): Promise<void> {
  const r = await d.pool.query<SettledRow>(
    `select jti, approval_id, trip_id, payer_person_id, card_id, amount_minor, currency, merchant, rail, outcome, rail_ref, fail_reason
     from used_approvals where jti = $1 and outcome in ('paid', 'failed') and callback_at is null`,
    [jti],
  );
  const row = r.rows[0];
  if (!row) return;
  const said = await tellGo(
    d,
    row.outcome === 'paid'
      ? { kind: 'paid', trip_id: row.trip_id, approval_id: row.approval_id, rail_ref: row.rail_ref ?? '' }
      : { kind: 'failed', trip_id: row.trip_id, approval_id: row.approval_id, reason: row.fail_reason ?? 'rail_error' },
  );
  if (said === 'retry') {
    await d.pool.query('update used_approvals set callback_attempts = callback_attempts + 1 where jti = $1', [jti]);
    return;
  }
  if (said === 'final') d.log.error({ approval_id: row.approval_id }, 'Go refused a payment outcome; not sending it again');
  await d.pool.query('update used_approvals set callback_at = $2, callback_attempts = callback_attempts + 1 where jti = $1', [jti, d.now()]);
}

/** Finishes what a crash or a lost call left behind. Safe to run any time, from any copy of the service. */
export async function sweep(d: PayDeps): Promise<{ recharged: number; resent: number }> {
  const now = d.now();
  let recharged = 0;
  const stuck = await d.pool.query<AttemptRow>(
    `select jti, approval_id, trip_id, payer_person_id, card_id, amount_minor, currency, merchant, rail
     from used_approvals where outcome = 'charging' and used_at < $1 order by used_at limit 20`,
    [new Date(now.getTime() - 120_000)],
  );
  for (const a of stuck.rows) {
    // The same idempotency key: a charge that already went through is answered again, never made twice.
    const result = await chargeOnce(d, a);
    if (await settle(d.pool, d.now(), a, result)) recharged += 1;
    await reportOutcome(d, a.jti);
  }
  const pending = await d.pool.query<{ jti: string }>(
    `select jti from used_approvals where outcome in ('paid', 'failed') and callback_at is null and callback_attempts < 50
     order by used_at limit 50`,
  );
  for (const p of pending.rows) await reportOutcome(d, p.jti);
  await d.pool.query('delete from internal_seen where seen_at < $1', [new Date(now.getTime() - 600_000)]);
  return { recharged, resent: pending.rows.length };
}

export function startSweep(d: PayDeps, everyMs = 30_000): () => void {
  const timer = setInterval(() => {
    sweep(d).catch((e: unknown) => d.log.error({ err: e instanceof Error ? e.message : 'unknown' }, 'vault sweep failed'));
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
