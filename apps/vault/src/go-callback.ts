import { signRequest } from '@go/contract';
import { chargeOnce, deadlineSql, holdUnknown, markUnknown, PAST_DEADLINE, RAIL_GRACE_MS, settle, type AttemptRow, type PayDeps } from './charge.js';
import { VAULT_SIGNATURE_HEADER } from './internal/auth.js';
import type { FindResult, RailFailReason } from './rails/rail.js';

export type GoOutcome =
  | { kind: 'paid'; trip_id: string; approval_id: string; rail_ref: string }
  | { kind: 'failed'; trip_id: string; approval_id: string; reason: RailFailReason }
  /** Not an outcome: the rail gave no clear answer yet, so Go keeps the pay card waiting on the bank. */
  | { kind: 'confirming'; trip_id: string; approval_id: string }
  /** The rail will not be asked again and a person checks the charge: Go keeps the payment waiting and says so. */
  | { kind: 'checking'; trip_id: string; approval_id: string };

const PATHS: Record<GoOutcome['kind'], string> = {
  paid: '/internal/vault/paid',
  failed: '/internal/vault/failed',
  confirming: '/internal/vault/confirming',
  checking: '/internal/vault/confirming',
};

/** Answers from Go that a resend cannot change: the body or the request itself is wrong. Anything else is tried again. */
const FINAL: ReadonlySet<number> = new Set([400, 409, 422]);

/**
 * Calls Go back, signed with VAULT_SHARED_SECRET. 'final' means Go answered something a retry cannot change. A 404 is
 * not final: a paid outcome is never dropped because Go did not know the payment yet.
 */
export async function tellGo(d: Pick<PayDeps, 'env' | 'fetch' | 'now'>, o: GoOutcome): Promise<'ok' | 'retry' | 'final'> {
  const url = new URL(PATHS[o.kind], d.env.GO_CALLBACK_URL);
  const body = JSON.stringify(
    o.kind === 'paid'
      ? { trip_id: o.trip_id, approval_id: o.approval_id, rail_ref: o.rail_ref }
      : o.kind === 'failed'
        ? { trip_id: o.trip_id, approval_id: o.approval_id, reason: o.reason }
        : o.kind === 'checking'
          ? { trip_id: o.trip_id, approval_id: o.approval_id, checking: true }
          : { trip_id: o.trip_id, approval_id: o.approval_id },
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
    return FINAL.has(res.status) ? 'final' : 'retry';
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
     from used_approvals where jti = $1 and outcome in ('paid', 'failed') and callback_at is null and callback_refused_at is null`,
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
  if (said === 'final') {
    // Kept apart from callback_at: Go never took this outcome, and a person has to look at it.
    d.log.error({ approval_id: row.approval_id, outcome: row.outcome }, 'Go refused a payment outcome; not sending it again');
    await d.pool.query('update used_approvals set callback_refused_at = $2, callback_attempts = callback_attempts + 1 where jti = $1', [jti, d.now()]);
    return;
  }
  await d.pool.query('update used_approvals set callback_at = $2, callback_attempts = callback_attempts + 1 where jti = $1', [jti, d.now()]);
}

/**
 * Tells Go, once, that a charge has no clear answer yet, so its pay card says the bank is being asked and nobody starts
 * the payment again. The sweep sends it again until Go takes it, while the row is still charging.
 */
export async function tellConfirming(d: PayDeps, jti: string): Promise<void> {
  const r = await d.pool.query<{ trip_id: string; approval_id: string }>(
    "select trip_id, approval_id from used_approvals where jti = $1 and outcome = 'charging' and charge_tries > 0 and confirming_told_at is null",
    [jti],
  );
  const row = r.rows[0];
  if (!row) return;
  const said = await tellGo(d, { kind: 'confirming', trip_id: row.trip_id, approval_id: row.approval_id });
  if (said === 'retry') return;
  if (said === 'final') d.log.error({ approval_id: row.approval_id }, 'Go refused a confirming notice; not sending it again');
  await d.pool.query('update used_approvals set confirming_told_at = $2 where jti = $1', [jti, d.now()]);
}

/** Tells Go, once, that a charge is unknown for good and a person is checking it. The sweep sends it again until Go takes it. */
export async function tellChecking(d: PayDeps, jti: string): Promise<void> {
  const r = await d.pool.query<{ trip_id: string; approval_id: string }>(
    "select trip_id, approval_id from used_approvals where jti = $1 and outcome = 'unknown' and checking_told_at is null",
    [jti],
  );
  const row = r.rows[0];
  if (!row) return;
  const said = await tellGo(d, { kind: 'checking', trip_id: row.trip_id, approval_id: row.approval_id });
  if (said === 'retry') return;
  if (said === 'final') d.log.error({ approval_id: row.approval_id }, 'Go refused a checking notice; not sending it again');
  await d.pool.query('update used_approvals set checking_told_at = $2 where jti = $1', [jti, d.now()]);
}

interface SweptRow extends AttemptRow {
  outcome: 'charging' | 'unknown';
  charge_tries: number;
  rail_called_at: Date | null;
  used_at: Date;
  /** The approval's expiry plus the grace. After it the rail's charge() is never called again for this row. */
  deadline: Date;
}

/** How long the rail's records may take to show a payment: `none` is read as final only this long after the deadline. */
export const FIND_LAG_MS = 10 * 60_000;
/** How long after the deadline the sweep keeps looking for an unknown charge. After that a person settles it by hand. */
export const FIND_FOR_MS = 24 * 3_600_000;

/**
 * Past the approval's expiry and the grace, the vault never calls the rail's charge again. A charge the rail was never
 * sent failed for sure: nothing went out. For any other, the rail is asked, read only, what it has for the jti.
 */
async function closeLate(d: PayDeps, a: SweptRow): Promise<void> {
  if (a.outcome === 'charging' && a.charge_tries === 0 && !a.rail_called_at) {
    if (await settle(d.pool, d.now(), a, { failed: 'rail_error' })) await reportOutcome(d, a.jti);
    return;
  }
  await findLate(d, a);
}

/**
 * Settles a late charge from what the rail finds for its jti, never by charging. Paid settles at once and Go books it
 * through the normal path. Anything else waits out FIND_LAG_MS past the deadline, while Go keeps saying the bank is
 * confirming. After that: nothing found is a definite failure and Go shows its failed card; no clear answer leaves it
 * unknown, Go's card says a person is checking, and the sweep keeps looking.
 */
async function findLate(d: PayDeps, a: SweptRow): Promise<void> {
  let found: FindResult;
  try {
    found = await d.rails[a.rail].find({ idempotencyKey: a.jti, personId: a.payer_person_id, since: a.used_at });
  } catch {
    found = { unknown: 'thrown' };
  }
  const now = d.now();
  await d.pool.query('update used_approvals set rail_checked_at = $2 where jti = $1', [a.jti, now]);
  if ('railRef' in found) {
    if (await settle(d.pool, now, a, { railRef: found.railRef })) await reportOutcome(d, a.jti);
    return;
  }
  if (now.getTime() < a.deadline.getTime() + FIND_LAG_MS) return;
  if ('none' in found) {
    if (await settle(d.pool, now, a, { failed: 'rail_error' })) await reportOutcome(d, a.jti);
    return;
  }
  if (a.outcome === 'unknown') {
    d.log.warn({ approval_id: a.approval_id, why: found.unknown }, 'an unknown charge is still not settled; the sweep looks again');
    return;
  }
  await markUnknown(d, now, a, `past the approval and the grace: ${found.unknown}`);
}

/** Finishes what a crash or a lost call left behind. Safe to run any time, from any copy of the service. */
export async function sweep(d: PayDeps): Promise<{ recharged: number; resent: number }> {
  const now = d.now();
  let recharged = 0;
  // Each row once per sweep, the one looked at longest ago first, so a long outage starves no row: charges still charging,
  // and unknown charges past their deadline for up to a day.
  const rows = await d.pool.query<SweptRow>(
    `select * from (
       select jti, approval_id, trip_id, payer_person_id, card_id, amount_minor, currency, merchant, rail, outcome, charge_tries,
         rail_called_at, rail_checked_at, used_at, ${deadlineSql('$4')} as deadline
       from used_approvals where outcome in ('charging', 'unknown')
     ) u
     where (outcome = 'charging' and used_at < $1) or (outcome = 'unknown' and deadline <= $2 and deadline > $3)
     order by coalesce(rail_checked_at, used_at) limit 20`,
    [new Date(now.getTime() - 120_000), now, new Date(now.getTime() - FIND_FOR_MS), RAIL_GRACE_MS / 1000],
  );
  for (const a of rows.rows) {
    if (a.deadline.getTime() <= now.getTime()) {
      await closeLate(d, a);
      continue;
    }
    if (a.outcome !== 'charging') continue;
    // The same idempotency key: a charge that already went through is answered again, never made twice. chargeOnce
    // checks the deadline again with the clock as it is then, so a slow batch never charges a row that ran out meanwhile.
    const result = await chargeOnce(d, a);
    await d.pool.query('update used_approvals set rail_checked_at = $2 where jti = $1', [a.jti, d.now()]);
    if ('unknown' in result) {
      // Still no clear answer: the row stays charging until the cap marks it unknown. Never failed.
      if (result.unknown !== PAST_DEADLINE) await holdUnknown(d, d.now(), a, result.unknown);
      continue;
    }
    if (await settle(d.pool, d.now(), a, result)) recharged += 1;
    await reportOutcome(d, a.jti);
  }
  const pending = await d.pool.query<{ jti: string }>(
    `select jti from used_approvals
     where outcome in ('paid', 'failed') and callback_at is null and callback_refused_at is null and callback_attempts < 50
     order by used_at limit 50`,
  );
  for (const p of pending.rows) await reportOutcome(d, p.jti);
  const confirming = await d.pool.query<{ jti: string }>(
    "select jti from used_approvals where outcome = 'charging' and charge_tries > 0 and confirming_told_at is null order by used_at limit 50",
  );
  for (const c of confirming.rows) await tellConfirming(d, c.jti);
  // "A person is checking" only once the rail's records had time to catch up; until then Go says the bank is confirming.
  const checking = await d.pool.query<{ jti: string }>(
    `select jti from used_approvals
     where outcome = 'unknown' and checking_told_at is null and ${deadlineSql('$2')} + make_interval(secs => $3) <= $1
     order by used_at limit 50`,
    [now, RAIL_GRACE_MS / 1000, FIND_LAG_MS / 1000],
  );
  for (const c of checking.rows) await tellChecking(d, c.jti);
  // A charge still unsettled a day after its deadline is no longer looked for: said once, for a person.
  const stale = await d.pool.query<{ approval_id: string }>(
    `update used_approvals set stale_logged_at = $1
     where outcome in ('charging', 'unknown') and stale_logged_at is null and ${deadlineSql('$3')} <= $2
     returning approval_id`,
    [now, new Date(now.getTime() - FIND_FOR_MS), RAIL_GRACE_MS / 1000],
  );
  for (const r of stale.rows) d.log.error({ approval_id: r.approval_id }, 'a charge is still not settled a day after its deadline; a person has to settle it');
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
