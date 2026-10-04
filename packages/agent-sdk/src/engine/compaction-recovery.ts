/**
 * compaction-recovery.ts — reactive compact-on-overflow (Unit B), the COMPACTION_V2
 * deferred-overflow latch and its two staleness guards, plus the shared
 * {@link CompactionResult} shape a compaction returns to its caller.
 *
 * Extracted from native-harness.ts so the loop stays a loop: native-harness only
 * ratchets DOWN (R3 file-size ratchet — grow a new module, never the loop file).
 *
 * ── THE TWO OVERFLOW SHAPES ─────────────────────────────────────────────────
 * A context overflow reaches us two completely different ways, and pre-V2 only
 * one of them was handled:
 *
 *   THROWN  — the provider REJECTS the request (413, or a 400 whose body says the
 *             context is too long). The round throws; Unit B catches it. Nothing
 *             was generated, so there is no partial assistant message to clean up.
 *
 *   TRUNCATED — the provider ACCEPTS the request and the model runs out of window
 *             MID-GENERATION (`stop_reason: model_context_window_exceeded`). The
 *             call SUCCEEDS. Nothing throws, no status exists, and pre-V2 nothing
 *             noticed: the turn finished with a half-written assistant message that
 *             is now journaled and will be replayed on the next request — which is
 *             strictly larger than the one that just failed to fit.
 *
 * V2 handles the truncated shape by LATCHING an observation (below) and acting at
 * the next round head, which is also what makes the two staleness guards real:
 * between the observation and the recovery, the user can switch models and another
 * compaction can land.
 */
import type { HarnessContext } from '../contract/harness.js';
import type { CompactionInfo, HarnessEvent } from '../contract/events.js';
import type { NativeConfig } from './native-config.js';
import type { RunContext } from './run-context.js';
import type { NormalizedUsage, ProviderHistory, Transport } from './transport.js';
import type { JournalEntry } from '../contract/journal.js';
import { foldCompactionResult } from './turn-decisions.js';
import { appendUsageEntry } from './native-journal.js';
import { wireMessages, projectWire, type FrozenElision } from './context-elision.js';
import {
  classifyOverflow,
  overflowSurvivesModelSwitch,
  overflowSurvivesCompaction,
  resolveMaxContextTokens,
  type OverflowObservation,
} from '../kernel/index.js';
import { compactionV2Enabled } from '../policy/feature-flags.js';

/**
 * What a compaction returns to its caller. `compactionUsage`/`compactionModel`
 * carry the summarize call's raw usage + model so the caller journals a
 * source:'compaction' usage entry at the same fold that accrues `compactionCostUsd`.
 */
export interface CompactionResult {
  event: HarnessEvent;
  compactionCostUsd: number;
  compactionUsage: NormalizedUsage;
  compactionModel: string;
  /** What it did (reason, strategy, tokens before/after): the O1 rail's fields (COMPACTION_POST_TURN_V1). */
  info?: CompactionInfo;
}

/**
 * The recovery directive the round catch applies. `attempted` latches the per-turn
 * "reactive compaction already ran" flag (so a second overflow is terminal); `retry`
 * says whether to re-drive the round with the (re-projected) `history`.
 */
export type OverflowRecovery =
  /** `refusalEvents` — the record + billed-spend legs of a REFUSED recovery, for the caller
   *  to yield (this function returns a verdict; it is not a stream). Empty otherwise. */
  | { attempted: boolean; retry: false; refusalEvents?: HarnessEvent[] }
  | { attempted: true; retry: true; event: HarnessEvent; history: ProviderHistory };

/**
 * UNIT B — reactive compact-on-overflow. A `context_exceeded` round self-heals ONCE per
 * turn: run the manual compaction path (bypassing the 80% gate the way `/compact` does)
 * and retry the round. Gated tight — only when NOT yet attempted this turn AND compaction
 * is configured AND a journal is present AND the error classifies as an overflow. The
 * summarize call bills/journals `source:'compaction'` via the SAME `foldCompactionResult`
 * the proactive trigger uses. An abort mid-compaction re-throws (→ the terminal catch →
 * user_aborted); a compaction that can't cut degrades to `retry:false` (→ the caller's
 * terminal overflow throw).
 *
 * V2 swaps the classifier only: `isOverflowError` checks throttle exclusions FIRST and
 * prefers structured fields, so a rate-limit body that happens to mention tokens can no
 * longer be answered by destroying the conversation. Flag OFF ⇒ `transport.classifyError`,
 * byte-identical.
 */
export async function recoverFromOverflow(args: {
  err: unknown;
  ctx: HarnessContext<NativeConfig>;
  cfg: NativeConfig;
  transport: Transport;
  rc: RunContext;
  alreadyAttempted: boolean;
  /**
   * The RECOVERY compaction — `runRecoveryCompaction`, which sizes its window to make the
   * next request FIT. NAMED `runRecovery`, not `runManualCompaction`: the old slot name is
   * what let the manual (turn-first) window sit on this path through two reviews of this
   * very file. A recovery is not a `/compact`.
   */
  runRecovery: () => Promise<CompactionResult | null>;
  /**
   * Called when the reactive compaction REFUSES: record the named reason (the journal
   * legs) and fold any summarize it already paid for. Injected for the same reason
   * `runManualCompaction` is — `recordCompactionFailure` lives in compaction-run.ts,
   * which imports this module.
   */
  onRefused: (err: unknown) => Promise<HarnessEvent[]>;
  /** The turn's FROZEN elision — the post-compaction retry re-projects through the
   *  SAME wire seam the turn head used. */
  elision: FrozenElision | null;
}): Promise<OverflowRecovery> {
  const { err, ctx, cfg, transport, rc } = args;
  if (
    args.alreadyAttempted ||
    !cfg.compaction ||
    !cfg.journal ||
    !isOverflowError(err, transport)
  ) {
    return { attempted: false, retry: false };
  }
  let reactive: CompactionResult | null = null;
  let refusalEvents: HarnessEvent[] = [];
  try {
    reactive = await args.runRecovery();
  } catch (compactErr) {
    if (cfg.signal?.aborted) throw compactErr; // → terminal catch → user_aborted
    console.warn('[NativeHarness] reactive compaction failed', compactErr);
    // T9b fix round 1 — this is the OOM path, and its refusal was the LAST silent one:
    // the run is about to die of `context_exceeded` and nothing durable said why the
    // recovery did not save it. Record the named reason and keep whatever summarize it
    // already paid for. INJECTED, like `runManualCompaction` above, because the recorder
    // lives in compaction-run.ts — which imports THIS module, so the edge runs one way.
    refusalEvents = await args.onRefused(compactErr);
  }
  if (!reactive) return { attempted: true, retry: false, refusalEvents };
  const fold = foldCompactionResult(reactive);
  rc.billing.cumulativeCostUsd += fold.cumulativeDeltaUsd;
  rc.billing.parentOwnCostUsd += fold.parentOwnDeltaUsd;
  await appendUsageEntry(cfg.journal, ctx, fold.usageEntry);
  const history = await projectWire(cfg.journal, transport, args.elision);
  return { attempted: true, retry: true, event: reactive.event, history };
}

/**
 * Is this thrown error a context overflow?
 *
 * V2: {@link classifyOverflow} over the error's STRUCTURED fields, with throttle
 * exclusions checked first. OFF: `transport.classifyError`, unchanged — the `&&`
 * chain in the caller short-circuits before either, so an unconfigured run never
 * calls one and stays byte-identical.
 */
function isOverflowError(err: unknown, transport: Transport): boolean {
  if (!compactionV2Enabled()) {
    return transport.classifyError(err).kind === 'context_exceeded';
  }
  const e = err as {
    status?: number;
    message?: string;
    error?: { type?: string };
    headers?: { get?: (name: string) => string | null };
  } | null;
  if (!e) return false;
  return classifyOverflow({
    status: e.status,
    errorType: e.error?.type,
    message: e.message ?? String(err),
    retryAfterPresent: retryAfterPresent(e),
  }).overflow;
}

/** Structured throttle signal: a retry-after header means "wait", never "too big". */
function retryAfterPresent(e: { headers?: { get?: (name: string) => string | null } }): boolean {
  try {
    return typeof e.headers?.get === 'function' && e.headers.get('retry-after') !== null;
  } catch {
    return false;
  }
}

// ─── V2: the deferred (truncated-stop) overflow latch ────────────────────────

/**
 * Stop reasons that mean the model ran out of CONTEXT mid-generation. `max_tokens`
 * is deliberately absent — that is the OUTPUT cap, a normal long answer, and
 * force-compacting on it would punish verbosity.
 */
const TRUNCATING_STOP_REASONS: ReadonlySet<string> = new Set([
  'model_context_window_exceeded',
  'context_length_exceeded',
]);

/**
 * Arm the deferred-overflow latch after a round that TRUNCATED on context.
 *
 * Records the model it happened under and the journal position at the time —
 * everything the two guards need to re-check the facts later. No-op when the flag
 * is off, when the stop reason is anything else, or when a latch is already armed
 * (the first observation is the one closest to the failure).
 */
export function armOverflowLatch(rc: RunContext, stopReason: string | null, model: string, seq: number): void {
  if (!compactionV2Enabled()) return;
  if (!stopReason || !TRUNCATING_STOP_REASONS.has(stopReason)) return;
  if (rc.pendingOverflow) return;
  rc.pendingOverflow = { model, seq };
}

/**
 * Arm the latch from a just-completed round — the ONE line the loop file carries.
 *
 * Fast-exits before touching the journal on every ordinary round: the flag check
 * and the stop-reason check are both pure, so a healthy turn pays nothing. The
 * projection (warm = O(1) from the journal's cache) is read only on the round that
 * actually truncated, to stamp the observation with its position in the journal's
 * total order.
 */
export async function armOverflowLatchFromRound(
  rc: RunContext,
  journal: NativeConfig['journal'],
  stopReason: string | null,
  model: string,
): Promise<void> {
  if (!compactionV2Enabled() || rc.pendingOverflow) return;
  if (!stopReason || !TRUNCATING_STOP_REASONS.has(stopReason) || !journal) return;
  try {
    const messages = (await journal.project()).messages;
    const head = messages[messages.length - 1];
    armOverflowLatch(rc, stopReason, model, head ? head.seq : 0);
  } catch {
    // Arming is an optimization over the terminal path that already exists; a
    // projection hiccup must never turn a truncated round into a thrown turn.
  }
}

/** What the round head should do about an armed latch. */
export type LatchVerdict =
  | { act: false; reason: 'none' | 'model_switch' | 'post_compaction' }
  | { act: true; observation: OverflowObservation };

/**
 * Consume the deferred-overflow latch at a round head, applying BOTH staleness
 * guards. Consuming ALWAYS disarms — an observation gets exactly one chance, which
 * is what stops a latch that keeps failing its guards from re-firing forever.
 *
 * GUARD 1 (model switch): the overflow was raised under one model; if the turn now
 * runs a LARGER-window model, the context that did not fit may fit fine, and
 * compacting on that stale signal would destroy history to solve a problem that no
 * longer exists.
 *
 * GUARD 2 (post-compaction): a compaction that landed after the observation already
 * shrank the context the observation described. The observation's own usage numbers
 * describe the OLD, larger context, so acting on them would immediately re-trigger
 * on a conversation that has already been cut.
 */
export function consumeOverflowLatch(
  rc: RunContext,
  currentModel: string,
  lastCompactionSeq: number | null,
): LatchVerdict {
  const observation = rc.pendingOverflow;
  if (!observation) return { act: false, reason: 'none' };
  rc.pendingOverflow = null;

  if (!overflowSurvivesModelSwitch(observation, currentModel, resolveMaxContextTokens)) {
    return { act: false, reason: 'model_switch' };
  }
  if (!overflowSurvivesCompaction(observation, lastCompactionSeq)) {
    return { act: false, reason: 'post_compaction' };
  }
  return { act: true, observation };
}

/**
 * The `seq` of the most recent compaction boundary in a journal projection, or null.
 *
 * A projection that has been compacted LEADS with the summary entry the boundary
 * points at, so its seq is the boundary's position in the journal's total order —
 * the comparator Guard 2 needs (see overflow.ts on why seq, not the ISO timestamp).
 */
export function lastCompactionSeq(messages: JournalEntry[], summaryLeading: boolean | undefined): number | null {
  if (!summaryLeading) return null;
  const head = messages[0];
  return head ? head.seq : null;
}

/**
 * Strip the assistant message that FAILED from the wire view.
 *
 * The journal keeps everything — this filters the PROJECTION the next request is
 * built from. It exists for the truncated shape: the half-written assistant message
 * is real, journaled, and would be replayed on the retry, making the retry request
 * strictly LARGER than the one that just ran out of window. Removing it from the
 * wire view is the difference between a retry that can succeed and one that cannot.
 *
 * Identified by position (the newest assistant entry at or after the observation),
 * never by content.
 */
export function stripFailedAssistant(messages: JournalEntry[], observation: OverflowObservation): JournalEntry[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i];
    if (entry.seq < observation.seq) break;
    if (entry.payload.type === 'assistant') {
      const out = messages.slice();
      out.splice(i, 1);
      return out;
    }
  }
  return messages;
}

/**
 * Build the retry history for a deferred recovery: strip the failed assistant
 * message, then project through the elision seam so the retry rides the same wire
 * view every other projection in the turn does.
 */
export function retryHistory(
  transport: Transport,
  messages: JournalEntry[],
  observation: OverflowObservation,
  elision: FrozenElision | null,
): ProviderHistory {
  return transport.historyFromJournal(wireMessages(stripFailedAssistant(messages, observation), elision));
}
