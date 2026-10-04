// packages/agent-sdk/src/engine/compaction-refusal.ts
//
// THE REFUSAL SEAM, lifted verbatim out of compaction-run.ts under the 1100-line
// file-size ratchet. A PURE MOVE: every body below is byte-identical to the one that was
// there, and `compaction-run.ts` re-exports all of them, so every import site and every
// test still reads them from where they always did.
//
// Why THIS seam is the cohesive one to cut. Everything here answers a single question —
// "a compaction refused; what does the rest of the system get told?" — and nothing here
// participates in planning, summarizing or splicing:
//
//   COMPACTION_FAILED_EVENT / _JOURNAL_KEY   the two names a refusal is published under
//   BilledCompactionSpend / withBilledSpend  a refusal that already PAID carries its spend
//   billedSpendOf / foldRefusedCompactionSpend   …and the ledger folds it
//   refusalEvents                            the yieldable pair (record + billed usage)
//   recordCompactionFailure                  the durable `custom` entry + its usage row
//   recordManualCompactionFailure            the `/compact` arm's warn-then-record
//   armCompactionRetry / compactionRetryPending / openCompactionRetryForTurn
//                                            the bound on paying again (added since)
//
// IMPORT DIRECTION. This module imports NO runtime value from `compaction-run.ts`; the
// only edge back is `import type { CompactionDeps }`, which TypeScript erases, so the
// runtime graph stays one-way (compaction-run → compaction-refusal) and the existing
// one-way edge to `compaction-recovery.ts` is untouched.

import type { HarnessEvent } from '../contract/events.js';
import type { NormalizedUsage } from './transport.js';
import type { RunContext } from './run-context.js';
import type { CompactionDeps } from './compaction-run.js';
import { compactionFailureReason } from '../kernel/index.js';
import { laneUsageEvent } from './offloop-usage.js';
import { deterministicUsageId } from './round-stream.js';
import { appendUsageEntry } from './native-journal.js';
import { compactionV2Enabled } from '../policy/feature-flags.js';

/**
 * Inlined literal, mirroring {@link SESSION_COMPACTED_EVENT}: the raw event a
 * REFUSED compaction emits.
 */
export const COMPACTION_FAILED_EVENT = 'session:compaction_failed';

/** The journal `custom` key the same refusal is recorded under. */
export const COMPACTION_FAILED_JOURNAL_KEY = 'compaction_failed';

/**
 * Billed model work a REFUSED compaction already spent, carried on the error it threw.
 *
 * A refusal can land AFTER the summarize (Hermes's `summary_not_smaller`), and that call
 * is real money — `summarizeSpan` has already charged `liveSpend`. Without this the
 * accumulated cost died with the throw and the two billing legs disagreed by exactly it.
 */
export interface BilledCompactionSpend {
  costUsd: number;
  usage: NormalizedUsage;
  model: string;
}

/** Property name the spend rides under. A field, not a symbol: it crosses module edges. */
const BILLED_SPEND_KEY = 'billedCompactionSpend';

/** Attach the spend to a refusal — only when a summarize actually ran and cost something. */
export function withBilledSpend(err: unknown, spend: BilledCompactionSpend): unknown {
  const spent =
    spend.costUsd !== 0 || spend.usage.inputTokens !== 0 || spend.usage.outputTokens !== 0;
  if (spent && err !== null && typeof err === 'object') {
    (err as Record<string, unknown>)[BILLED_SPEND_KEY] = spend;
  }
  return err;
}

/** The billed spend a refusal carries, or undefined when no summarize was billed. */
export function billedSpendOf(err: unknown): BilledCompactionSpend | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  return (err as Record<string, unknown>)[BILLED_SPEND_KEY] as BilledCompactionSpend | undefined;
}

/**
 * COMPACTION_POST_TURN_V1 — what a summarize cut before its `done` most likely cost: the request
 * it sent (the span and the prompt, at the ledger's estimate) and the text that streamed. The
 * provider bills a cut request; reporting zero under-meters it (the sweep's cut rail does the
 * same, memory-sweep.ts estimateSweepSpend). A throw after `done` carries that call's real usage
 * instead (it never reached the billed spend: the summarize did not return). Carried on the
 * summarize's own throw, which the planner wraps as its `cause`.
 */
const INFLIGHT_ESTIMATE_KEY = 'inflightCompactionEstimate';

export function withInflightEstimate(err: unknown, usage: NormalizedUsage): unknown {
  if (err !== null && typeof err === 'object') (err as Record<string, unknown>)[INFLIGHT_ESTIMATE_KEY] = usage;
  return err;
}

/** The cut summarize's estimate, on the error or its cause (the planner's wrap), or undefined. */
export function inflightEstimateOf(err: unknown): NormalizedUsage | undefined {
  let e: unknown = err;
  for (let depth = 0; depth < 3 && e !== null && typeof e === 'object'; depth++) {
    const usage = (e as Record<string, unknown>)[INFLIGHT_ESTIMATE_KEY];
    if (usage) return usage as NormalizedUsage;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Fold a refusal's billed summarize into the turn's accumulators, exactly as
 * `foldCompactionResult` does on a success. The JOURNAL leg is written by
 * {@link recordCompactionFailure}, which every refusing site calls — so each fact lands
 * once, and the cold `/compact` path (which has no turn accumulator at all, by
 * construction: `compactNow` returns a value and its caller does the billing) still gets
 * the durable half. No-op when nothing was billed.
 */
export function foldRefusedCompactionSpend(rc: RunContext, err: unknown): void {
  const spend = billedSpendOf(err);
  if (!spend) return;
  rc.billing.cumulativeCostUsd += spend.costUsd;
  rc.billing.parentOwnCostUsd += spend.costUsd;
  // IDEMPOTENT: the spend can be claimed once. No path folds an error twice today, but this
  // is an error object crossing catch sites — the guarantee should not rest on that audit.
  delete (err as Record<string, unknown>)[BILLED_SPEND_KEY];
}

/**
 * The whole observable record of a REFUSED compaction, in one place so the four sites cannot
 * drift: the journal legs (`recordCompactionFailure`), the turn accumulators
 * (`foldRefusedCompactionSpend`), and the EVENTS the caller must yield.
 *
 * The usage event is the leg the round head's success path already emits and the refusal path
 * was missing: `turn-reprice.service.ts` re-prices from the socket's `AgentUsageEvent`s
 * (`task_turn_usage`), never from journal entries — so without it a billed summarize that
 * ended in a refusal reached the accumulator and the journal but NOT the re-price leg.
 *
 * ID: `laneUsageEvent` derives its `messageId` from (taskId, round, lane), and
 * `agent-usage-handler.ts:195` elides a duplicate — so a refusal and a SUCCESS in the same
 * round would collide and one row would be dropped, which is exactly the new
 * refuse-then-fall-through-to-maybeCompact path. The refusal's id is therefore derived from a
 * distinct lane STRING while the event's `lane` stays `compaction` (what the repricer reads).
 *
 * It also arms the RETRY BOUND ({@link armCompactionRetry}) — here, because every runtime
 * refusal site already comes through here, so no site can refuse without being bounded.
 */
export async function refusalEvents(
  deps: CompactionDeps,
  rc: RunContext,
  trigger: 'auto' | 'manual',
  err: unknown,
  /**
   * Which refusal site, for the usage id only (never recorded); the trigger by default. A
   * recovery records `auto`, the trigger its own compaction runs on since X1, yet it must keep
   * an id of its own: a refused recovery falls through to the proactive trigger, which can refuse
   * too in the same round (review of #4284, LOW-4).
   */
  site: string = trigger,
): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [await recordCompactionFailure(deps, trigger, err)];
  const spend = billedSpendOf(err); // read BEFORE the fold, which drops the key
  foldRefusedCompactionSpend(rc, err);
  armCompactionRetry(rc, err);
  if (spend && compactionV2Enabled()) {
    const round = rc.billing.roundCounter.value;
    const usage = laneUsageEvent(
      'compaction',
      { status: 'ok', usage: spend.usage, model: spend.model },
      deps.ctx.taskId,
      round,
    );
    if (usage?.kind === 'usage') {
      events.push({
        ...usage,
        messageId: deterministicUsageId(
          deps.ctx.taskId,
          round,
          `${REFUSED_COMPACTION_LANE_ID}:${site}`,
        ),
      });
    }
  }
  return events;
}

/** The lane STRING the refusal's usage id is derived from — never the lane it reports. The
 *  SITE is appended (auto, manual, recovery, reactive), so a refused recovery and an auto
 *  refusal in ONE round cannot collide; only same-site duplicates remain (the stated limitation). */
const REFUSED_COMPACTION_LANE_ID = 'compaction:refused';

/**
 * THE RETRY BOUND. After a refusal that reached the summarize, the proactive trigger waits
 * 2^failures rounds before it pays for another one: 2, 4, 8, 16, then every 32.
 *
 * Why rounds, and why it never stops: the trigger used to re-fire EVERY round head (task
 * 9472b042: 42 paid attempts on 09-27, its context stuck at 449K). A bound on ledger GROWTH
 * would park a flat context above OpenAI's 272K premium line for good, and that premium (2x
 * input, 1.5x output on every later request) cost more than the retries did. A backoff in
 * rounds keeps a way out: those 42 rounds would have paid for 5 attempts. The cap is 32
 * because a summarize reads about the whole context once, roughly one round's input, so one
 * attempt per 32 rounds holds the retry spend near 3% of what the stuck rounds spend on input.
 * A new user turn ends the wait early ({@link openCompactionRetryForTurn}).
 */
const COMPACTION_RETRY_MAX_ROUNDS = 32;

/**
 * Arm the bound after a refusal, unless no summarize was reached. `no_valid_cut` is decided
 * before any model call, and the next round can bring a cut into being; `aborted` is a steer,
 * not a failure. Neither paid, so neither waits. Everything else (`empty_summary`,
 * `summary_not_smaller`, `summarize_failed`, an unnamed throw) arms it, and so does
 * `hook_blocked` (X1): a PreCompact hook that refuses is asked again on this same clock, not at
 * every round head, where each refusal is a shell run, a journal record and an event.
 */
export function armCompactionRetry(rc: RunContext, err: unknown): void {
  const reason = compactionFailureReason(err);
  if (reason === 'no_valid_cut' || reason === 'aborted') return;
  const failures = (rc.compactionRetry?.failures ?? 0) + 1;
  rc.compactionRetry = {
    failures,
    notBeforeRound: rc.billing.roundCounter.value + Math.min(2 ** failures, COMPACTION_RETRY_MAX_ROUNDS),
  };
}

/**
 * A new USER turn gets one attempt at its head: the WAIT ends, the failure COUNT stays, so
 * if that attempt fails too the wait carries on doubling from where it was. Rounds are the
 * wrong clock for a chat — one round per turn — and without this a task with five paid
 * refusals would sit 32 user turns above the premium line before trying again.
 */
export function openCompactionRetryForTurn(rc: RunContext): void {
  if (rc.compactionRetry) {
    rc.compactionRetry = { ...rc.compactionRetry, notBeforeRound: rc.billing.roundCounter.value };
  }
}

/** Is the proactive trigger still waiting out a refusal? */
export function compactionRetryPending(rc: RunContext): boolean {
  return !!rc.compactionRetry && rc.billing.roundCounter.value < rc.compactionRetry.notBeforeRound;
}

/**
 * Make a refused compaction OBSERVABLE, on both compaction paths.
 *
 * Every site that compacts is never-throw: a refusal degrades to no-compaction and
 * the turn continues. That contract is right — a run must not die because it could
 * not shrink itself — but until T9b the ONLY trace was
 * `console.warn('[NativeHarness] compaction failed', …)`, which is why an agentic
 * loop that could never compact went unnoticed for months while those runs died of
 * `context_exceeded` instead.
 *
 * TWO LEGS, deliberately:
 *   · the returned raw event — a live host can meter and alert on it (T11o);
 *   · a `custom` journal entry — the DURABLE leg, and the only one available to the
 *     manual `/compact` path, which returns a value rather than yielding events.
 *
 * BEST-EFFORT and never-throws, exactly like the elision-shape entry: observing a
 * failure must not be able to turn a degraded compaction into a failed turn.
 */
export async function recordCompactionFailure(
  deps: CompactionDeps,
  trigger: 'auto' | 'manual',
  err: unknown,
  /** COMPACTION_POST_TURN_V1: false when the spend is charged on a laned off-loop row instead. */
  opts: { journalUsage?: boolean } = {},
): Promise<HarnessEvent> {
  const { ctx } = deps;
  const reason = compactionFailureReason(err);
  const spend = billedSpendOf(err);
  const data = {
    taskId: ctx.taskId,
    trigger,
    reason,
    detail: String(err),
    // A refusal that already paid for a summarize says so, in the same record.
    ...(spend && { costUsd: spend.costUsd, model: spend.model, usage: spend.usage }),
  };
  try {
    await ctx.config.journal?.append({
      ...deps.compactionBase(ctx),
      principal: { kind: 'system' },
      payload: { type: 'custom', key: COMPACTION_FAILED_JOURNAL_KEY, data },
    });
    // The billed call lands on the `compaction` lane like any other — this is the leg the
    // server's re-price reads, and the ONLY one the cold `/compact` path can reach. Not for a
    // post-turn refusal: its off-loop row carries the money, and the journal's cost total
    // (the cold-start seed, the legacy reconstruction) must not count it a second time.
    if (spend && opts.journalUsage !== false) {
      await appendUsageEntry(ctx.config.journal, ctx, {
        costUsd: spend.costUsd,
        model: spend.model,
        source: 'compaction',
        inputTokens: spend.usage.inputTokens,
        outputTokens: spend.usage.outputTokens,
      });
    }
  } catch {
    /* best-effort: the record must never cost the turn the compaction already lost */
  }
  return { kind: 'raw', engine: 'native', event: COMPACTION_FAILED_EVENT, data };
}

/**
 * The MANUAL `/compact` refusal path — warn as before, then record the refusal by name.
 *
 * It lives here rather than inline in the loop file for the R3 reason compaction-run.ts
 * exists at all (native-harness.ts only ratchets down), and the returned event is
 * discarded ON PURPOSE: `compactNow` returns a value instead of yielding events, so the
 * journal entry is this path's durable leg.
 */
export async function recordManualCompactionFailure(
  deps: CompactionDeps,
  err: unknown,
): Promise<void> {
  console.warn('[NativeHarness] manual compaction failed', err);
  await recordCompactionFailure(deps, 'manual', err);
}
