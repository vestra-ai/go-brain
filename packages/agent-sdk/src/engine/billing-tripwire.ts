/**
 * billing-tripwire.ts — the per-turn billing keystone check (Unit C), extracted from
 * native-harness.ts so the loop stays a loop (R3 file-size ratchet — grow a new module,
 * never the loop file).
 *
 * The reconcile identity (parentOwn + Σchild vs turnDelta) + the zero-spend check, plus
 * the raw-event name and the payload the loop journals/emits on a violation. NO-THROW by
 * design (a throw false-positives on the resume-seed / epilogue-fold paths the invariant
 * bends) — the checker WARNS + returns the violation; the caller journals a non-context
 * entry and emits the raw event so the server can persist an error_event.
 */
import { reconcileChildUsage, type ChildCostRecord } from '../contract/child-cost.js';
import type { HarnessEvent } from '../contract/events.js';
import type { HarnessContext } from '../contract/harness.js';
import type { Journal } from '../kernel/index.js';
import type { NativeConfigLike } from './native-config-like.js';
import type { RunContext } from './run-context.js';
import { appendBillingTripwireEntry } from './native-journal.js';

/**
 * The raw HarnessEvent name a billing-tripwire violation rides so the server can persist
 * an error_event (the loud-anomaly precedent: an out-of-band signal on the SAME sink path
 * SESSION_COMPACTED / the capture signal use). The `agent:` namespace mirrors the other
 * engine-authored anomaly events.
 */
export const BILLING_TRIPWIRE_EVENT = 'agent:billing_tripwire';

/**
 * Threshold for the reconcile + positive-spend tripwire; `EPS` absorbs float noise. The
 * two checks and their history: docs/learnings/native-harness-history.md (Billing).
 * Pinned by: native-harness.fuel-tank.test.ts ("Positive-spend tripwire").
 */
const BILLING_TRIPWIRE_EPS = 1e-6;

/**
 * The anomaly a billing-tripwire violation carries. `reason` distinguishes the two
 * checks; `expected`/`actual`/`delta` are the reconciled-vs-turnDelta figures.
 */
export interface BillingTripwireViolation {
  reason: 'reconcile_drift' | 'zero_spend';
  expected: number;
  actual: number;
  delta: number;
}

/**
 * The wire/journal payload for a violation — the reconcile figures plus the run identity
 * so a later audit can locate the turn. Journaled as a non-context `custom` entry AND
 * emitted as the raw event's `data`.
 */
export interface BillingTripwirePayload extends BillingTripwireViolation {
  taskId: string;
  runId: string;
  round: number;
}

/**
 * The reconcile + zero-spend keystone. LOG-ONLY (never throws); returns the violation so
 * the caller can promote it (journal + raw event) or `null` on a clean turn. `reconciled`
 * = parentOwn + Σchild; a drift means a child cost was lost or double-counted; a zero
 * delta on a turn that made ≥1 model call means billing was zeroed.
 */
export function checkTurnBillingTripwire(
  b: { turnDeltaUsd: number; parentOwnCostUsd: number; childUsage: ChildCostRecord[] },
  expectPositiveSpend: boolean,
): BillingTripwireViolation | null {
  const reconciled = reconcileChildUsage(b.childUsage, b.parentOwnCostUsd);
  const delta = reconciled - b.turnDeltaUsd;
  if (Math.abs(delta) > BILLING_TRIPWIRE_EPS) {
    console.warn(
      `[NativeHarness][billing-tripwire] reconcile drift: parentOwn(${b.parentOwnCostUsd}) + ` +
        `Σchild === ${reconciled} but turnDelta=${b.turnDeltaUsd} (Δ=${delta}). ` +
        `A child cost was lost or double-counted.`,
    );
    return { reason: 'reconcile_drift', expected: reconciled, actual: b.turnDeltaUsd, delta };
  }
  if (expectPositiveSpend && b.turnDeltaUsd <= BILLING_TRIPWIRE_EPS) {
    console.warn(
      `[NativeHarness][billing-tripwire] ZERO spend on a turn that made ≥1 model call ` +
        `(turnDelta=${b.turnDeltaUsd}). Billing may be zeroed (native-multisubagent-cost-zeroed class).`,
    );
    return { reason: 'zero_spend', expected: reconciled, actual: b.turnDeltaUsd, delta };
  }
  return null;
}

/** Build the durable/wire payload for a violation (identity fields carried alongside). */
export function buildBillingTripwirePayload(
  violation: BillingTripwireViolation,
  taskId: string,
  runId: string,
  round: number,
): BillingTripwirePayload {
  return { ...violation, taskId, runId, round };
}

/**
 * Promote a violation off the loop: journal a non-context `custom` entry (native-journal
 * owns the write; never replayed into the model context) AND yield the raw event the
 * server persists as an error_event. The console.warn already fired in the check.
 */
export async function* emitBillingTripwire(
  journal: Journal | undefined,
  ctx: HarnessContext<NativeConfigLike>,
  rc: RunContext,
  violation: BillingTripwireViolation,
): AsyncIterable<HarnessEvent> {
  const payload = buildBillingTripwirePayload(violation, ctx.taskId, ctx.sessionId, rc.billing.roundCounter.value);
  await appendBillingTripwireEntry(journal, ctx, payload);
  yield { kind: 'raw', engine: 'native', event: BILLING_TRIPWIRE_EVENT, data: payload };
}
