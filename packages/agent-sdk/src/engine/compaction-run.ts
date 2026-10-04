/**
 * compaction-run.ts — the compaction BODY: trigger, plan, splice, summarize.
 *
 * Extracted from native-harness.ts under the R3 file-size ratchet (grow a new
 * module, never the loop file), the same way compaction-recovery.ts was. The
 * pre-existing behavior is moved VERBATIM; everything COMPACTION_V2 adds is
 * behind `compactionV2Enabled()` so the flag-off path stays byte-identical,
 * including the measurement it reads and the bytes it sends.
 *
 * WHAT V2 CHANGES, in one place so the diff is legible:
 *
 *   TRIGGER  — fires on `min(80% of the window, the model's preferred input ceiling)` measured
 *              off the WIRE view, instead of 80% of the window measured off a
 *              pruned copy nobody sends. See kernel/compaction/trigger.ts.
 *   PRUNE    — the measurement-only prune tier is not consulted at all. See the
 *              note on `measureLedger` (compaction-ledger.ts).
 *   SUMMARY  — a previous summary is handed to the summarizer as a LABELLED
 *              previous summary over only the new span, and the read/modified
 *              file lists are appended mechanically and accumulate.
 *   BOOKS    — the summarize call reports usage on the `compaction` lane and asks
 *              the transport not to write it into the prompt cache.
 */

import type { HarnessContext } from '../contract/harness.js';
import type { ContentBlock } from '../contract/blocks.js';
import type { CompactionInfo, HarnessEvent, NormalizedUsage } from '../contract/events.js';
import type { JournalEntry, NewEntry } from '../contract/journal.js';

import type { NativeConfig } from './native-config.js';
import type { ProviderHistory, ProviderTool, Transport } from './transport.js';
import type { RunContext } from './run-context.js';
import type { OverflowObservation } from '../kernel/index.js';
import {
  type CompactionResult,
  consumeOverflowLatch,
  lastCompactionSeq,
  retryHistory,
} from './compaction-recovery.js';
import type { FrozenElision } from './context-elision.js';
import {
  planCompaction,
  measuredInputTokens,
  projectTokenCount,
  estimateTokens,
  extractFileTrail,
  mergeFileTrail,
  renderFileTrail,
  parseFileTrail,
  NoopContextPort,
  type HookDispatcher,
  type FileTrail,
  type TrailEffect,
} from '../kernel/index.js';
import { wireMessages } from './context-elision.js';
import { measureLedger } from './compaction-ledger.js';
import { resolveCompactionBudget } from './compaction-budget.js';
import {
  boundSummarizeSpan,
  reportedInputSince,
  summarizeInputBudget,
  withoutReplayedReasoning,
  withTrimmedSpanNote,
} from './compaction-input.js';
import { laneUsageEvent } from './offloop-usage.js';
import { archiveDroppedEntries } from './compaction-archive.js';
import { dispatchLifecycle, buildPreCompactInput, buildPostCompactInput, continueContext } from './native-hooks.js';
import { refuseIfPreCompactBlocked, sessionStartAfterCompaction } from './hook-parity.js';
import { appendInjectedUserEntry } from './native-journal.js';
import { reassertSessionContext } from './context-append.js';

import { classifySideEffect } from '../policy/side-effect-classifier.js';
import { compactionPostTurnEnabled, compactionV2Enabled } from '../policy/feature-flags.js';
import { resolveCapabilities } from '../contract/model-capabilities.js';
import {
  COMPACTION_SYSTEM,
  COMPACTION_USER,
  fencePreviousSummary,
  withOperatorCompactionInstructions,
  withIterativeCompactionInstructions,
  withSplitTurnInstructions,
} from '../contract/compaction-prompt.js';
import {
  COMPACTION_SPLIT_TURN_CONTINUE_MARKER,
  isRealUserTurn,
} from '../contract/injected-user-text.js';
import { isLiveSplitTurn } from '../contract/compaction-prompt.js';

const ZERO_USAGE: NormalizedUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * Default auto-compaction policy. `keepWindowTokens` is the pre-V2 value,
 * unchanged. `prune` is retained ONLY for the flag-off path (see `measureLedger`).
 *
 * `thresholdPct` is NOT here: it was a second copy of
 * `DEFAULT_TRIGGER_POLICY.thresholdPct`, and the two had to stay equal or the
 * trigger and the elision budget would disagree by exactly the amount they
 * drifted. `resolveCompactionBudget` reads the trigger policy's copy, which is
 * now the only one.
 */
export const DEFAULT_COMPACTION = {
  keepWindowTokens: 20_000,
  prune: { ageThresholdEntries: 40, sizeThresholdTokens: 2_000 },
} as const;

/**
 * The SUMMARY's own output budget — what the compaction-eval calibrated the prompt against
 * (a no-thinking call, scripts/compaction-eval driver.ts). A model that reasons gets
 * {@link COMPACTION_REASONING_HEADROOM_TOKENS} on top; see {@link compactionMaxTokens}.
 */
export const COMPACTION_MAX_TOKENS = 4096;

/**
 * The reasoning FLOOR for the summarize call (Transport.callModel `reasoningEffort`), the
 * same floor the memory sweep pins. The call rides the task's model, so on gpt-6-luna it
 * inherited effort 'max': every luna compaction prod ever metered (16 of 16) ended at exactly
 * the 4096 cap, and the unmetered ones came back with no text at all (OpenAI's usage buckets:
 * +4096 output per extra request). Condensing a transcript it has already read needs no
 * deliberation. A model that takes no effort param gets nothing new on the wire (the
 * transports apply it only where the row already sends an effort).
 */
export const COMPACTION_REASONING_EFFORT = 'low';

/**
 * Output tokens added to the cap on a model that reasons. Every provider here counts
 * reasoning INSIDE the output cap (OpenAI Responses `max_output_tokens`, Anthropic
 * `max_tokens`, Gemini `max_output_tokens`, Chat Completions `max_tokens`), so a bare 4096
 * is shared between thinking and the summary and the summary loses.
 *
 * Sized from the sweep, the one side call already at effort 'low' on luna over a whole
 * projection: staging p95 1,106 / max 1,185 output tokens (n=22); prod p50 64 but 3 of 22
 * ended AT that call's 2,048 cap, so the tail passes 2,048. 4,096 is twice the cap the tail
 * already reached, and a cap is a ceiling: only tokens actually produced are billed.
 */
export const COMPACTION_REASONING_HEADROOM_TOKENS = 4096;

/**
 * The summarize call's output cap: the summary's budget, plus reasoning headroom only on a
 * row that reasons. A `thinking.mode: 'none'` row keeps exactly {@link COMPACTION_MAX_TOKENS},
 * so its request is byte-identical.
 *
 * Keyed on the ROW, not on the env kill switches (OPENAI_REASONING / NATIVE_THINKING /
 * GEMINI_THINKING), on purpose. Those switches do not mean "no reasoning": an `always_on`
 * Anthropic row thinks with NATIVE_THINKING off, and a DeepSeek row thinks server-side with no
 * switch at all, so a cap keyed on them would starve exactly those models again. Where a switch
 * does stop reasoning, 8192 is harmless: a cap is a ceiling, only produced tokens are billed,
 * and a summary allowed past 4096 is still refused unless it is smaller than its span (rule 6).
 * Neither env forwards any of the switches to a runner today.
 */
export function compactionMaxTokens(model: string): number {
  return resolveCapabilities(model).thinking.mode === 'none'
    ? COMPACTION_MAX_TOKENS
    : COMPACTION_MAX_TOKENS + COMPACTION_REASONING_HEADROOM_TOKENS;
}

/**
 * Inlined literal (the engine reads no `@bash/*`); equals `EVENTS.SESSION_COMPACTED`.
 * Pinned by: native-harness.compaction.test.ts ("SDK SESSION_COMPACTED_EVENT literal
 * equals EVENTS.SESSION_COMPACTED").
 */
const SESSION_COMPACTED_EVENT = 'session:compacted';

/**
 * What the compaction body needs from the harness. Passed explicitly rather than
 * captured off `this` so every function here is testable without a harness and the
 * loop file keeps no compaction logic.
 */
export interface CompactionDeps {
  ctx: HarnessContext<NativeConfig>;
  transport: Transport;
  dispatcher: HookDispatcher;
  /** `NativeHarness.compactionBase` — the journal-append base for spliced entries. */
  compactionBase: (ctx: HarnessContext<NativeConfig>) => Omit<NewEntry, 'payload'>;
  /** `NativeHarness.runSignal` — the run's abort signal (or a never-aborting one). */
  runSignal: (ctx: HarnessContext<NativeConfig>) => AbortSignal;
}

// ─── Metering ────────────────────────────────────────────────────────────────

/**
 * The compaction summarize call's usage event, or undefined when V2 is off.
 *
 * WHY IT WAS MISSING AND WHY IT MATTERS: the summarize is a real, billed model
 * call whose cost has always been folded into `cumulativeCostUsd` — but it emitted
 * no usage MESSAGE, and the server's L1 re-price sums per-message prices into a
 * total it holds beside the claimed one (turn-reprice.service.ts). So the two
 * billing legs disagreed by exactly the compaction cost on every task that ever
 * compacted, and nothing in `task_turn_usage` showed the call had happened.
 *
 * Tagged `compaction` rather than left main-lane so the row is IDENTIFIABLE in the
 * books; deliberately NOT added to the server's `isOffloopLane`, because unlike
 * sweep/suggestion this cost is already charged and must keep reaching the
 * repricer. Metering it does not change what is billed — it makes the two legs
 * agree on it.
 *
 * `status:'ok'` unconditionally: this is only called with a CompactionResult in
 * hand, which means the summarize returned. A failed summarize throws out of
 * `runCompaction` and produces no result to meter.
 */
export function compactionUsageEvent(
  result: CompactionResult,
  taskId: string,
  turnNumber: number,
  lane: 'compaction' | 'post_turn_compaction' = 'compaction',
): HarnessEvent | undefined {
  if (!compactionV2Enabled()) return undefined;
  const event = laneUsageEvent(lane, { status: 'ok', usage: result.compactionUsage, model: result.compactionModel }, taskId, turnNumber);
  // COMPACTION_POST_TURN_V1: what the compaction did rides its usage event to the O1 rail.
  return event && result.info && compactionPostTurnEnabled() ? { ...event, compaction: result.info } as HarnessEvent : event;
}

/**
 * Two usages summed bucket by bucket. The compaction fold used to keep only input/output, so
 * a summarize's cache reads and writes were priced into `costUsd` (computeCostUsd sees the
 * whole usage) but never reached the usage EVENT the server re-prices from. `reasoningTokens`
 * rides too: it is the number that shows whether reasoning ate the summary's budget. So does
 * Anthropic's 5m/1h split of the writes (a 1h write bills 2x input; the aggregate alone would
 * reprice it at 5m). A bucket neither side reported stays absent, so a usage that never had
 * it keeps its shape.
 */
function addUsage(a: NormalizedUsage, b: NormalizedUsage): NormalizedUsage {
  const sum: NormalizedUsage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
  for (const k of [
    'cacheReadInputTokens',
    'cacheCreationInputTokens',
    'cacheCreation5mInputTokens',
    'cacheCreation1hInputTokens',
    'reasoningTokens',
  ] as const) {
    if (a[k] !== undefined || b[k] !== undefined) sum[k] = (a[k] ?? 0) + (b[k] ?? 0);
  }
  return sum;
}

/** `yield*` over an optional event — one line at each call site instead of an if. */
export function* yieldIfPresent(event: HarnessEvent | undefined): Generator<HarnessEvent> {
  if (event) yield event;
}
// ─── Refusals ────────────────────────────────────────────────────────────────
//
// MOVED to `compaction-refusal.ts` under the 1100-line file-size ratchet — a pure move,
// bodies unchanged. Re-exported here so every import site and every test keeps reading
// them from `compaction-run.js`, which is where they have always lived.
// The two the body below still CALLS. A re-export publishes a name; it does not bind
// one, so these are imported as values as well.
import { compactionRetryPending, refusalEvents, withBilledSpend, withInflightEstimate } from './compaction-refusal.js';
import { foldModelSpend } from './live-spend.js';

export {
  COMPACTION_FAILED_EVENT,
  COMPACTION_FAILED_JOURNAL_KEY,
  billedSpendOf,
  foldRefusedCompactionSpend,
  refusalEvents,
  recordCompactionFailure,
  recordManualCompactionFailure,
  type BilledCompactionSpend,
} from './compaction-refusal.js';


// ─── Trigger ─────────────────────────────────────────────────────────────────

/**
 * The prune-then-trigger seam, called at the top of each iterate round. Returns
 * null (changing nothing) with no journal/config or a below-threshold ledger,
 * keeping the conformance suite + the other arms byte-identical.
 *
 * `rc` (V2) carries the provider's own count of the last request; with it the trigger
 * reads real input, not only the estimate (compaction-input.ts). Absent, it is the
 * estimate alone, exactly as before.
 */
export async function maybeCompact(
  deps: CompactionDeps,
  system: string,
  providerTools: ProviderTool[],
  elision: FrozenElision | null,
  rc?: RunContext,
): Promise<CompactionResult | null> {
  const m = await measureTriggerInput(deps, system, providerTools, elision, rc);
  if (!m || m.measured < m.budget) return null;
  return runCompaction(deps, m.messages, {
    trigger: 'auto',
    keepWindowTokens: deps.ctx.config.compaction?.keepWindowTokens ?? DEFAULT_COMPACTION.keepWindowTokens,
    // The round head: the turn continues into the very next model call.
    resumesTurn: true,
  });
}

/**
 * The trigger's reading of the next request (the measured input) and the budget it is held
 * to, or null with no journal or no compaction config. maybeCompact's predicate, and
 * COMPACTION_POST_TURN_V1's check at a turn's end (compaction-post-turn.ts).
 */
export async function measureTriggerInput(
  deps: CompactionDeps,
  system: string,
  providerTools: ProviderTool[],
  elision: FrozenElision | null,
  rc?: RunContext,
): Promise<{ measured: number; budget: number; messages: JournalEntry[] } | null> {
  const { ctx } = deps;
  const journal = ctx.config.journal;
  const compaction = ctx.config.compaction;
  // Journal-gated AND config-gated: absent → never fires.
  if (!journal || !compaction) return null;

  // Project ONCE per round (warm = O(1) from the journal projection cache).
  const projection = await journal.project();
  const messages = projection.messages;

  const ledgerTotal =
    measureLedger(messages, elision, { ...DEFAULT_COMPACTION.prune, ...compaction.prune }) +
    estimateTokens(system) +
    estimateTokens(JSON.stringify(providerTools));
  const reported =
    rc && compactionV2Enabled()
      ? reportedInputSince(rc, messages, projection.compactionSummaryLeading, ctx.model || deps.transport.defaultModel())
      : undefined;

  // The budget is resolved by the ONE resolver elision also reads, so the two
  // mechanisms cannot size themselves against different numbers again (they did:
  // see compaction-budget.ts). V2 OFF still yields `thresholdPct x contextWindow`,
  // which is the pre-V2 predicate `ledgerTotal / maxTokens < thresholdPct`
  // rearranged — same decision, one multiplication instead of one division.
  return { measured: measuredInputTokens(ledgerTotal, reported), budget: resolveCompactionBudget(ctx.model, compaction), messages };
}

/**
 * What the round head decided. `observation` is set ONLY when a DEFERRED overflow
 * (a previous round that truncated on context) forced this compaction — the caller
 * uses it to strip the failed assistant message from the retry's wire view.
 */
export interface HeadCompaction {
  result: CompactionResult | null;
  observation: OverflowObservation | null;
  /** Events the caller must yield — a REFUSED deferred recovery's record + its billed spend.
   *  Empty on every other path. `compactAtRoundHead` cannot yield (it returns a verdict). */
  pendingEvents: HarnessEvent[];
}

/**
 * The single compaction decision made at each round head.
 *
 * TWO ways to get here, and the difference is the whole point of the latch:
 *
 *  DEFERRED — a previous round truncated on context (a SUCCEEDING request that ran
 *    out of window mid-generation). That observation is consumed here, behind both
 *    staleness guards, and forces a compaction the way `/compact` does — bypassing
 *    the threshold, because the provider has already told us the context does not
 *    fit and no ledger estimate outranks that.
 *
 *  PROACTIVE — the ordinary economic trigger.
 *
 * A latch that fails either guard falls through to the proactive path rather than
 * short-circuiting: the guards say "this OBSERVATION is stale", never "do not
 * compact", and the ledger still gets its say.
 */
export async function compactAtRoundHead(
  deps: CompactionDeps,
  rc: RunContext,
  system: string,
  providerTools: ProviderTool[],
  elision: FrozenElision | null,
): Promise<HeadCompaction> {
  const cfg = deps.ctx.config;
  let pendingEvents: HarnessEvent[] = [];
  if (compactionV2Enabled() && rc.pendingOverflow && cfg.journal && cfg.compaction) {
    const projection = await cfg.journal.project();
    const verdict = consumeOverflowLatch(
      rc,
      deps.ctx.model,
      lastCompactionSeq(projection.messages, projection.compactionSummaryLeading),
    );
    if (verdict.act) {
      // A recovery makes the next request FIT (see runRecoveryCompaction) — the manual
      // window is a UX rule and kept far too much here.
      try {
        const result = await runRecoveryCompaction(deps);
        if (result) {
          rc.compactionRetry = null;
          return { result, observation: verdict.observation, pendingEvents: [] };
        }
      } catch (err) {
        if (cfg.signal?.aborted) throw err; // → user_aborted, unchanged
        // A REFUSED deferred compaction falls through to the ordinary trigger, exactly as
        // this function already promises for a stale latch — the ledger still gets its say,
        // and the refusal is recorded rather than lost on the way past.
        // Recorded `auto` like the recovery's own PreCompact input and boundary; its own usage id.
        pendingEvents = await refusalEvents(deps, rc, 'auto', err, 'recovery');
        // …and meets the retry bound just below. The recovery window EQUALS the auto window,
        // so after any refusal that reached the summarize, `maybeCompact` would re-run the
        // identical plan and buy a second paid summarize in the same round. The bound (armed
        // by `refusalEvents`) generalizes what used to be a `summary_not_smaller`-only exit;
        // `no_valid_cut` arms nothing, so that fall-through still gets its re-plan.
      }
    }
  }
  // THE RETRY BOUND (compaction-refusal.ts). Only the PROACTIVE trigger waits it out: the
  // deferred recovery above and the reactive `context_exceeded` one run because the
  // provider already said the context does not fit, and `/compact` is the user asking.
  if (compactionRetryPending(rc)) return { result: null, observation: null, pendingEvents };
  // `maybeCompact` must run INSIDE the try. It uses the same window over the same
  // projection as the recovery above, so when the recovery refused and the ledger is still
  // over the trigger it refuses IDENTICALLY — the ordinary case, not a race. Awaiting it in
  // the returned object literal let that throw escape and take `pendingEvents` with it: two
  // paid summarizes, one reaching the re-price leg.
  try {
    const result = await maybeCompact(deps, system, providerTools, elision, rc);
    // A compaction that LANDS resets the backoff. The reactive and `/compact` successes do
    // not need to: they leave the ledger under the trigger, where the bound is never read.
    if (result) rc.compactionRetry = null;
    return { result, observation: null, pendingEvents };
  } catch (err) {
    if (cfg.signal?.aborted) throw err; // → user_aborted, unchanged
    console.warn('[NativeHarness] compaction failed', err);
    // BOTH refusals are real and either may have paid to summarize. Carry the first one's
    // events out beside the second's, each recorded exactly once — this returns rather than
    // rethrows precisely so the round head's catch does not record the second a second time.
    return {
      result: null,
      observation: null,
      pendingEvents: [...pendingEvents, ...(await refusalEvents(deps, rc, 'auto', err))],
    };
  }
}

/**
 * Re-project after a compaction so the next model call sees the compacted context.
 *
 * With an `observation` in hand (a deferred-overflow recovery) the failed assistant
 * message is dropped from the WIRE view first — the journal keeps it. Without that,
 * the retry would replay a half-written assistant turn and send a request strictly
 * LARGER than the one that just ran out of window.
 */
export async function rebuildAfterCompaction(
  deps: CompactionDeps,
  elision: FrozenElision | null,
  observation: OverflowObservation | null,
): Promise<ProviderHistory> {
  const messages = (await deps.ctx.config.journal!.project()).messages;
  return observation
    ? retryHistory(deps.transport, messages, observation, elision)
    : deps.transport.historyFromJournal(wireMessages(messages, elision));
}

// ─── The shared compaction body ──────────────────────────────────────────────

/**
 * The shared compaction body — splice + reflect + lifecycle dispatch + emit —
 * that BOTH the auto trigger and manual `/compact` run, so the two never drift.
 * Returns the SESSION_COMPACTED event. Every refusal propagates as a named throw carrying
 * any billed spend — an empty summary included (`empty_summary`): it used to return null
 * here, which declined to compact to nothing but dropped the summarize's spend on the floor.
 */
export async function runCompaction(
  deps: CompactionDeps,
  messages: JournalEntry[],
  opts: {
    trigger: 'auto' | 'manual';
    keepWindowTokens: number;
    /**
     * Does a turn CONTINUE after this compaction? Only the caller knows, and
     * `trigger` cannot answer it: a recovery is `'auto'` like the round head (see
     * {@link runRecoveryCompaction}). True for the round-head auto trigger and both
     * recoveries — a live turn about to re-issue its round. False for `/compact`,
     * cold or warm, which is a control turn that ends immediately.
     */
    resumesTurn: boolean;
    recovery?: boolean; // X1: the provider already refused the request: a PreCompact block is logged, never honoured
    /** COMPACTION_POST_TURN_V1: a post-turn compaction's own signal (cut by the next message), and its reason. */
    signal?: AbortSignal;
    reason?: CompactionInfo['reason'];
  },
): Promise<CompactionResult> {
  const { ctx, transport, dispatcher } = deps;
  const cfg = ctx.config;
  const journal = cfg.journal!;

  // PreCompact seam — fires once we COMMIT to compacting, before the summarize.
  const preCompact = await dispatchLifecycle(
    dispatcher,
    buildPreCompactInput(opts.trigger, null),
    deps.runSignal(ctx),
    ctx.sessionId,
  );
  refuseIfPreCompactBlocked(preCompact, opts.recovery === true); // X1: refuses by name ('hook_blocked'), before any spend
  const operatorInstructions = continueContext(preCompact);

  cfg.emitStatus?.('compacting');
  const preTokens = projectTokenCount(messages).messages;
  // K5 §8.7 — THE PIN. A tool_use paused on an unresolved interaction (the agent asked,
  // the user has not answered yet) must survive the cut, or its future materialized
  // result lands on the kept side with no call to pair with and the answer is dropped
  // on the wire: the user answers a question the agent no longer remembers asking.
  // `planCompaction` implements the retreat but was never handed the ids — and could
  // not have pinned on `messages` anyway, because `project()` SUSPENDS a paused tool_use
  // out of the projection. So: the LIVE paused set (`liveSuspendedIds`, the raw-journal
  // `computePausedToolUseIds` narrowed to tool_uses a prior compaction has not already
  // dropped — never the raw set, or an abandoned pause would pin every cut forever),
  // and the projection with those tool_uses re-seated so the planner can see them.
  const pausedToolUseIds = await journal.liveSuspendedIds();
  const entries =
    pausedToolUseIds.size === 0
      ? messages
      : reseatPausedToolUses(messages, await journal.snapshot(), pausedToolUseIds);
  let plan: Awaited<ReturnType<typeof planCompaction>>;
  let compactionCostUsd = 0;
  let compactionUsage: NormalizedUsage = { ...ZERO_USAGE };
  let compactionModel = ctx.model || transport.defaultModel();
  try {
    plan = await planCompaction({
      entries,
      pausedToolUseIds,
      keepWindowTokens: opts.keepWindowTokens,
      preTokens,
      summarize: async (toSummarize, signal, meta) => {
        const r = await summarizeSpan(
          deps,
          toSummarize,
          signal,
          operatorInstructions,
          // The section makes the SAME claim the marker does, so it is gated the same way
          // (see isLiveSplitTurn). Told off `meta.splitTurn` alone, the summarizer was
          // instructed that a COMPLETED turn "is still in progress" on both shapes the
          // marker refuses, and the summary then misreported state to the next call.
          meta !== undefined && isLiveSplitTurn(meta, opts.resumesTurn),
        );
        compactionCostUsd += r.costUsd;
        compactionUsage = addUsage(compactionUsage, r.usage);
        compactionModel = r.model;
        return r.text;
      },
      // exactOptionalPropertyTypes (SDK): omit `signal` when undefined.
      ...((opts.signal ?? cfg.signal) !== undefined && { signal: opts.signal ?? cfg.signal }),
    });
  } catch (e) {
    cfg.emitStatus?.(null);
    // The summarize is a REAL, billed model call, and a refusal can happen AFTER it ran
    // (Hermes's `summary_not_smaller` is the reachable case, on a short `/compact` span).
    // Rethrowing bare discarded that spend: the money was charged to the live ledger and
    // nothing ever reached turn_end.billing or the journal. Carry it on the error so the
    // catching site can meter it exactly like a success.
    throw withBilledSpend(e, {
      costUsd: compactionCostUsd,
      usage: compactionUsage,
      model: compactionModel,
    });
  }

  let summaryText = plan.summaryText;

  // V2 — the mechanical file trail, appended AFTER the model's text and BEFORE the
  // archive note. Accumulates: the previous summary's trail (if any) is parsed back
  // out of the entry this compaction is about to drop and unioned with this span's.
  if (compactionV2Enabled()) {
    const trail = mergeFileTrail(
      previousTrailOf(plan.droppedEntries),
      extractFileTrail(plan.droppedEntries, trailEffectOf(cfg)),
    );
    const rendered = renderFileTrail(trail);
    if (rendered) summaryText = `${summaryText}\n\n${rendered}`;
  }

  // Archive the FULL dropped span to a durable file before it is replaced by the
  // summary, and note the path in the summary text so a later turn can Read it.
  if (cfg.workingDir) {
    const archive = await archiveDroppedEntries({
      droppedEntries: plan.droppedEntries,
      workingDir: cfg.workingDir,
      taskId: ctx.taskId,
      thread: plan.firstKeptId,
    });
    if (archive.path) {
      summaryText = `${summaryText}\n\n(Full pre-compaction transcript archived at ${archive.path} — use Read to page through it.)`;
    }
  }

  // Record the splice: append the summary as a `user` entry, capture its uuid,
  // then write the single compact_boundary referencing it. No schema change.
  const summaryEntry = await journal.append({
    ...deps.compactionBase(ctx),
    principal: { kind: 'user', userId: cfg.runtimeConfig?.userId ?? '' },
    payload: { type: 'user', blocks: [{ type: 'text', text: summaryText } as ContentBlock] },
  });
  // Decided BEFORE the splice so `postTokens` can count what the projection will
  // actually hold — the marker is appended a few lines below, and a record that
  // omitted it would under-report the post-compaction size by the marker's own bytes.
  const mintsContinuation = shouldMintContinuation(messages, plan, opts.resumesTurn);
  const postTokens = plan.postTokens + (mintsContinuation ? estimateTokens(COMPACTION_SPLIT_TURN_CONTINUE_MARKER) : 0);
  await journal.compact({
    summaryUuid: summaryEntry.uuid,
    preservedUuids: plan.preservedUuids,
    firstKeptId: plan.firstKeptId,
    trigger: opts.trigger,
    preTokens,
    postTokens,
    base: deps.compactionBase(ctx),
  });

  // T9c — A SPLIT-TURN RESUME GETS AN EXPLICIT CONTINUATION.
  //
  // The splice above leaves the projection as [summary(user), retained rounds…]. On a
  // split turn the retained work holds NO user message — the ask was summarized away —
  // so the only user-role entry the next round can read as its objective is a document
  // whose first section is titled "Open request" ("Latest request" when the drill ran,
  // and in journals written before the rename). The drill (staging task fe222a7a) is
  // what that costs: the model answered with a structured summary and the turn ended
  // `completed` at file 23 of 30.
  //
  // HERE, and not in `compactTurnHead`, because this is the ONE body every compaction
  // runs — the round-head auto trigger, the manual `/compact` control turn, and both
  // recovery paths — so the four cannot drift, and `plan.splitTurn` is already in hand
  // (surfacing it to the round head would mean a new field on CompactionResult for a
  // decision that belongs beside the splice). Every caller re-projects AFTER this
  // (`rebuildAfterCompaction`, `retryHistory`), so the entry rides the next wire view;
  // the round head's `consultRecall` runs later still, which is why a recall fence lands
  // AFTER the marker rather than between it and the retained work.
  //
  // …AND ONLY WHEN A TURN ACTUALLY RESUMES. `/compact` is a control turn: it ends
  // immediately, nothing continues, and the marker would be left as the journal's last
  // user-role entry — so the user's NEXT real message would land after a standing "do
  // not end the turn until the original request is complete". `plan.splitTurn` is still
  // true there (on the one-ask shape the cut lands on an assistant), which is why the
  // gate needs the caller's answer and not just the plan's.
  //
  // Either condition false appends nothing, so a chat-shaped cut and every `/compact`
  // stay byte-identical.
  // X1 (HOOK_PARITY_V1): the conversation restarts from the summary: SessionStart "compact" (its words kept only where a turn resumes).
  await sessionStartAfterCompaction(dispatcher, deps.runSignal(ctx), ctx.sessionId, opts.resumesTurn ? { journal, ctx } : undefined);
  // CONTEXT_APPEND_V1: a context update the cut summarized away is told again, BEFORE the
  // continuation marker so the marker stays the last word. Inert off / on an unfrozen session.
  await reassertSessionContext(journal, ctx);
  if (mintsContinuation) {
    await appendInjectedUserEntry(journal, ctx, COMPACTION_SPLIT_TURN_CONTINUE_MARKER, 'engine');
  }

  // Nami reflect seam — best-effort; a throwing port must never abort the turn.
  const namiPort = cfg.contextPort ?? NoopContextPort;
  try {
    await namiPort.onPreCompact({ dropped: plan.droppedEntries, summaryText: plan.summaryText });
  } catch {
    // best-effort: a failed P-Nami write must never abort the compaction or turn.
  }

  // PostCompact seam — fires AFTER the splice is recorded, carrying the summary.
  await dispatchLifecycle(
    dispatcher,
    buildPostCompactInput(opts.trigger, plan.summaryText),
    deps.runSignal(ctx),
    ctx.sessionId,
  );

  cfg.emitStatus?.(null);

  return {
    event: {
      kind: 'raw',
      engine: 'native',
      event: SESSION_COMPACTED_EVENT,
      data: { taskId: ctx.taskId, trigger: opts.trigger, summary: summaryText },
    },
    compactionCostUsd,
    compactionUsage,
    compactionModel,
    info: { reason: opts.reason ?? (opts.recovery ? 'recovery' : opts.trigger === 'auto' ? 'round_head' : 'manual'), strategy: 'local', tokensBefore: preTokens, tokensAfter: postTokens },
  };
}

/**
 * K5 §8.7 — the planner's entries WITH the live paused tool_uses put back.
 *
 * `planCompaction`'s pin can only retreat the cut for a tool_use it can SEE in `entries`
 * (its contract on `pausedToolUseIds` says so: hand it the non-suspended projection). Each
 * live paused tool_use goes straight after the projected entry that precedes it in the
 * journal — its own round's assistant entry — which is where the raw journal holds it.
 * The predecessor is found by scanning BACK for a smaller `seq`, not by sorting: a prior
 * compaction's summary LEADS the projection with a seq HIGHER than the span it replaced,
 * and a sort would move it off the head. A tool_use older than everything projected is
 * compacted away and stays gone. Subagent-scoped entries never enter the main list
 * (T11a). The planner's output is unchanged in kind — `firstKeptId` is still a
 * user/assistant boundary the projection holds; a tool_use is never a boundary.
 */
function reseatPausedToolUses(
  messages: JournalEntry[],
  raw: readonly JournalEntry[],
  paused: ReadonlySet<string>,
): JournalEntry[] {
  const out = [...messages];
  for (const e of raw) {
    if (e.payload.type !== 'tool_use' || !paused.has(e.payload.toolUseId)) continue;
    if (e.agentPath !== undefined) continue;
    let at = out.length - 1;
    while (at >= 0 && out[at].seq >= e.seq) at--;
    if (at < 0) continue;
    out.splice(at + 1, 0, e);
  }
  return out;
}

/** The text of a `user` entry's blocks, concatenated — the marker is matched exactly. */
function userEntryText(e: JournalEntry): string {
  if (e.payload.type !== 'user') return '';
  return e.payload.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

/**
 * Should this compaction mint the split-turn continuation marker?
 *
 * The marker ASSERTS A PRECONDITION — "a turn was in progress and it continues from the
 * retained work" — so it may only be written where that is true. Three conditions, and
 * each one is a shape that was getting a false marker before it existed:
 *
 *  1. `plan.splitTurn` — the cut landed inside a turn rather than on a real user turn.
 *
 *  2. `resumesTurn` — the CALLER says a turn is live. Stated, never inferred: `trigger`
 *     cannot answer it (a recovery is `'auto'` like the round head), and `/compact` is a control
 *     turn that ends immediately, so a marker there would sit in the journal as a
 *     standing note about a turn that is over.
 *
 *  3. THE RETAINED SPAN HOLDS NO REAL USER TURN. `plan.splitTurn` does NOT mean "the LIVE
 *     turn was split": a turn ends on a text reply and has no next round head, so the
 *     previous turn's growth is first noticed at the NEXT turn's first round head. The cut
 *     then lands inside the COMPLETED previous turn — `splitTurn` true, `resumesTurn` true,
 *     both honestly — while the user's fresh ask sits in the retained span. A marker there
 *     tells the model to continue the PREVIOUS request immediately after the user asked for
 *     something else. If a real user turn survived the cut the model already has its
 *     request, so the marker is at best noise. Only the retained span can answer this.
 *
 *  4. …and no marker is already retained. The marker is a user-role entry, hence a legal
 *     cut boundary, so a second compaction can cut ON it — leaving the old one leading the
 *     retained span, already saying what a new one would say. Minting again put two in the
 *     projection.
 *
 * Read from the projection rather than widened into `CompactionPlan`: the planner would
 * have to carry two more booleans for a decision only this site makes.
 */
function shouldMintContinuation(
  messages: JournalEntry[],
  plan: { splitTurn: boolean; retainedHasRealUserTurn: boolean; firstKeptId: string },
  resumesTurn: boolean,
): boolean {
  if (!isLiveSplitTurn(plan, resumesTurn)) return false;
  const keptIdx = messages.findIndex((e) => e.uuid === plan.firstKeptId);
  // No first-kept entry means no retained span to reason about — decline rather than guess.
  if (keptIdx < 0) return false;
  // The ONE condition the section does not share: a marker already leading the retained
  // span is already saying this, so a second would just duplicate it.
  return !messages
    .slice(keptIdx)
    .some((e) => userEntryText(e) === COMPACTION_SPLIT_TURN_CONTINUE_MARKER);
}

/**
 * The shared MANUAL-compaction body — project + keep-window sizing + runCompaction
 * with trigger:'manual'. The COLD `/compact`, the WARM `/compact` control turn AND the
 * deferred-overflow (`context_exceeded`) reactive recovery all call this, so the three
 * never drift. Throws when no cut exists — the caller degrades to null.
 *
 * ─── THE WINDOW IS A TURN, OR A ROUND (T9b fix round 1) ───────────────────────
 *
 * "The most recent user turn" is a CHAT window, and it silently disabled all three
 * paths on the shape T9b exists to fix. A one-ask agentic journal's only `user` entry
 * is the HEAD (the ask; after a prior compaction, the summary), so `lastUserBoundary`
 * returned 0, the window covered the WHOLE projection, the token walk never exceeded
 * it, and `planCompaction` refused with `no_valid_cut`. `/compact` answered "Nothing to
 * compact yet" on a 200k-token task, and the `context_exceeded` recovery — the OOM path
 * — re-died on the next round.
 *
 * So the window is the most recent turn, or the most recent ROUND when the only `user`
 * entry is the head. Same two-unit shape as the elision floor, for the same reason.
 *
 * NOT "the last boundary of either kind": on a chat that ENDS on an assistant entry
 * that picks the trailing assistant, giving a strictly SMALLER window that keeps LESS
 * context than today — a rule-5 regression. The `lastUserIdx > 0` test is what keeps
 * every chat byte-identical.
 */
export async function runManualCompaction(deps: CompactionDeps): Promise<CompactionResult | null> {
  const journal = deps.ctx.config.journal!;
  const messages = (await journal.project()).messages;
  const keepIdx = manualKeepIndex(messages);
  const keepWindowTokens =
    keepIdx < 0 ? 0 : projectTokenCount(messages.slice(keepIdx)).messages;
  // A control turn — `/compact` finalizes immediately, nothing resumes.
  return await runCompaction(deps, messages, { trigger: 'manual', keepWindowTokens, resumesTurn: false });
}

/**
 * The RECOVERY compaction — the deferred-overflow latch and the reactive `context_exceeded`
 * handler. Same body as the manual path, DIFFERENT window, and the difference is the point.
 *
 * `runManualCompaction`'s window is a UX rule: "keep what you were just doing". A recovery
 * has no such luxury — the provider has already refused the request, so the only question is
 * whether the NEXT one fits. Sharing the manual window made recovery ineffective on the
 * ordinary long task: `[ask, round, steer, rounds…]` has two `user` entries, so the manual
 * rule sized the window from the steer onward and kept nearly the whole projection — the
 * retry overflowed again and the turn died of the error the recovery exists to clear. On
 * `[ask, one round]` it refused outright, though cutting at the assistant fits.
 *
 * So a recovery uses the AUTO trigger's window (`compaction.keepWindowTokens`): make it fit.
 */
export async function runRecoveryCompaction(deps: CompactionDeps): Promise<CompactionResult | null> {
  const cfg = deps.ctx.config;
  const messages = (await cfg.journal!.project()).messages;
  const keepWindowTokens = cfg.compaction?.keepWindowTokens ?? DEFAULT_COMPACTION.keepWindowTokens;
  // A recovery fires INSIDE a live turn about to re-issue its round; the engine decided it, so `auto` (X1).
  return await runCompaction(deps, messages, { trigger: 'auto', keepWindowTokens, resumesTurn: true, recovery: true });
}

/**
 * Where the manual keep-window starts: the most recent TURN, else the most recent ROUND.
 * -1 means "no window" — the caller sizes it to 0 and the plan refuses, which is the
 * "Nothing to compact yet" the control handler surfaces.
 *
 * The ROUND fallback needs a whole round left on the DROPPED side. With a single round
 * the only thing there is the user's own ask, and summarizing the user's words while
 * keeping the assistant's reply is strictly worse than doing nothing — so a short
 * conversation still answers "nothing to compact", exactly as it always has.
 */
function manualKeepIndex(messages: JournalEntry[]): number {
  const lastUserIdx = lastBoundaryOfType(messages, 'user');
  if (lastUserIdx > 0) return lastUserIdx;
  const lastAssistantIdx = lastBoundaryOfType(messages, 'assistant');
  if (lastAssistantIdx < 0) return -1;
  const priorRound = lastBoundaryOfType(messages.slice(0, lastAssistantIdx), 'assistant');
  return priorRound >= 0 ? lastAssistantIdx : -1;
}

/**
 * Index of the LAST entry of `type` in a projection, or -1 when none exists. The one
 * primitive {@link manualKeepIndex} reads for both of its units — a turn, then a round
 * (and once more to check a prior round exists) — so the two cannot drift apart.
 */
function lastBoundaryOfType(entries: JournalEntry[], type: 'user' | 'assistant'): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    // D4 — the `user` arm asks for a real TURN, not merely a user-role payload. A recall
    // fence sitting after the ask made `lastUserIdx > 0` true on a two-entry chat, sized
    // the window from the fence, and billed a summarize for a span Hermes then refused.
    // The `assistant` arm is unchanged: a round start is a round start.
    const hit =
      type === 'user' ? isRealUserTurn(entries[i]) : entries[i].payload.type === 'assistant';
    if (hit) return i;
  }
  return -1;
}

// ─── The summarize call ──────────────────────────────────────────────────────

/**
 * The injected `summarize` callback (the harness owns the model call; the
 * Compactor is provider-free): renders the span, calls the model ONE-shot with
 * COMPACTION_SYSTEM and NO tools, and concatenates the streamed text.
 *
 * V2 adds two things to this call and nothing else:
 *
 *  ITERATIVE — when the span leads with a previous compaction summary (the
 *    compactor deliberately includes it so the new summary SUBSUMES the old), that
 *    entry is re-rendered under an explicit label and the system prompt gains a
 *    section telling the model to carry its facts forward rather than re-derive
 *    them from a conversation it can no longer see. The span itself is already
 *    bounded — it is only ever "since the last compaction" — so summarize cost is
 *    flat in session length; what was missing was telling the model that the
 *    leading wall of text IS the previous summary.
 *
 *  NO CACHE WRITE — the summarize is a ONE-SHOT over a span that is about to be
 *    deleted. Letting the provider write it into the prompt cache pays the write
 *    premium on a prefix that can never be read again, and worse, can evict the
 *    live task prefix and force a cold re-write on the very next real round.
 *
 *  UNDER THE PRICING LINE (B1) — replayed reasoning is stripped and, on a model with a
 *    long-context pricing line, the oldest rounds after the head are left out until the
 *    request fits (compaction-input.ts). Task 9472b042's attempts averaged ~443K.
 *
 * T9b adds the SPLIT-TURN instruction: when the planner's cut landed inside a turn,
 * this span is that turn's prefix and its recent work is retained verbatim after the
 * summary. `splitTurn === false` leaves the system prompt byte-identical.
 */
export async function summarizeSpan(
  deps: CompactionDeps,
  toSummarize: JournalEntry[],
  signal?: AbortSignal,
  operatorInstructions?: string,
  splitTurn = false,
): Promise<{ text: string; costUsd: number; usage: NormalizedUsage; model: string }> {
  const { ctx, transport } = deps;
  const v2 = compactionV2Enabled();
  const model = ctx.model || transport.defaultModel();
  const previous = v2 ? previousSummaryIndex(toSummarize) : -1;
  let span = previous >= 0 ? withLabelledPreviousSummary(toSummarize, previous) : toSummarize;
  let system = withSplitTurnInstructions(
    withIterativeCompactionInstructions(
      withOperatorCompactionInstructions(COMPACTION_SYSTEM, operatorInstructions),
      previous >= 0,
    ),
    splitTurn,
  );
  if (v2) {
    const bounded = boundSummarizeSpan(
      withoutReplayedReasoning(span),
      summarizeInputBudget(model),
      estimateTokens(system) + estimateTokens(COMPACTION_USER),
    );
    span = bounded.span;
    system = withTrimmedSpanNote(system, bounded.omitted);
  }

  const history = buildSummarizeHistory(transport, span);
  // COMPACTION_POST_TURN_V1: a cut that came first (a Stop, the next message) sends nothing, so it
  // carries no estimate and bills nothing (memory-sweep.ts does the same before its call).
  if (signal?.aborted && compactionPostTurnEnabled()) throw Object.assign(new Error('summarize cut before send'), { name: 'AbortError' });
  const stream = transport.callModel({
    model,
    maxTokens: compactionMaxTokens(model),
    // Never the task's own effort: on a 'max' row reasoning took the whole cap and the
    // summary came back empty (see COMPACTION_REASONING_EFFORT).
    reasoningEffort: COMPACTION_REASONING_EFFORT,
    system,
    tools: [],
    history,
    // exactOptionalPropertyTypes (SDK): omit when undefined / not requested.
    ...(signal !== undefined && { signal }),
    ...(v2 && { noCacheWrite: true as const }),
  });
  let summary = '';
  let costUsd = 0;
  let usage: NormalizedUsage = { ...ZERO_USAGE };
  let done = false;
  // A cut before `done` still sent the request: say what it most likely cost (withInflightEstimate).
  const sent = (): NormalizedUsage => ({ ...ZERO_USAGE, inputTokens: estimateTokens(system) + estimateTokens(COMPACTION_USER) + projectTokenCount(span).messages, outputTokens: estimateTokens(summary) });
  try {
    for await (const ev of transport.readStream(stream)) {
      if (ev.kind === 'text') summary += ev.text;
      else if (ev.kind === 'done') {
        done = true;
        usage = ev.usage;
        const callCostUsd = transport.computeCostUsd(ev.usage, model);
        costUsd += callCostUsd;
        // The summarize is a real billed call — it lands in the live ledger like any
        // other priced model call (live-spend.ts).
        foldModelSpend(ctx.config.liveSpend, transport, callCostUsd, model);
      }
    }
  } catch (e) {
    throw withInflightEstimate(e, done ? usage : sent()); // after `done`, the provider's own bill
  }
  if (!done && signal?.aborted) throw withInflightEstimate(Object.assign(new Error('summarize aborted'), { name: 'AbortError' }), sent());
  return { text: summary, costUsd, usage, model };
}

/**
 * Project a to-summarize span onto the provider's request shape, ENDING ON A USER
 * TURN. Exported so the per-transport wire pins exercise the real path.
 *
 * The trailing user turn is REQUIRED for correctness, not style: a request that ends
 * on an assistant message is read as assistant prefill, which modern Claude models
 * and anything with extended thinking on REJECT (400 "must end with a user message").
 *
 * IT ALWAYS RIDES THROUGH THE PROJECTION, as a synthetic trailing `user` ENTRY, so
 * every transport's own validity floor sees it. `pushUser` bypasses that floor on every
 * arm, and Gemini's is the one that matters: `ensureValidGeminiRequest` MERGES
 * consecutive user-role contents ("Gemini wants those in a SINGLE content" —
 * engine/request-validity.ts:749-767) while `gemini-transport.ts:305` sends the history
 * verbatim. A span that already ends user-side — a `tool_result`, the ordinary shape once
 * the cut may land on an `assistant` boundary — would otherwise ship two consecutive user
 * contents the repo's own floor exists to prevent.
 *
 * NO BRANCH ON THE SPAN'S LAST ENTRY. There used to be one, taking `pushUser` when the
 * span ended assistant-side, and it was dead weight that kept the hole open: it guessed
 * the wire role from the ENTRY TYPE, so a span ending on a `system` entry (which every
 * projection DROPS — it reaches one only via the mirror clamp, `journal.ts:1190`) whose
 * predecessor is a `tool_result` still took `pushUser` and still shipped `[…, user, user]`
 * on Anthropic and Gemini. The projected form is byte-identical to `pushUser` for an
 * assistant-ending span on all four transports (pinned), so the branch bought nothing.
 *
 * The synthetic entry is local to this request — it is never appended to the journal.
 *
 * DEPENDS ON: `stripInvisibleControlTurns` (journal.ts:336-341) sparing the LAST marked
 * entry. If that rule ever changed, a span whose tail is a marked control turn would lose it
 * from the projection and the summarize request would end on an ASSISTANT message — the
 * prefill 400 this trailing turn exists to prevent.
 */
export function buildSummarizeHistory(
  transport: Pick<Transport, 'historyFromJournal' | 'pushUser'>,
  span: JournalEntry[],
): ProviderHistory {
  // An EMPTY span has no entry to hang the synthetic one off, and nothing to project: the
  // request IS the instruction. This is a degenerate-input guard, not the entry-type branch
  // that was deleted — an empty span has no `tool_result` for the instruction to follow, so
  // it cannot reintroduce the consecutive-user-turns hole. `planCompaction` never produces
  // one (the cut is always > 0), but `summarizeSpan` is exported and must be total.
  if (span.length === 0) {
    const history = transport.historyFromJournal(span);
    transport.pushUser(history, COMPACTION_USER);
    return history;
  }
  return transport.historyFromJournal(withTrailingUserEntry(span, COMPACTION_USER));
}

/**
 * The span carrying the instruction on its tail. Pure — the journal is untouched.
 *
 * When the span already ENDS on a `user` entry the instruction is appended as a second text
 * block ON that entry rather than as a new one. T9b makes that the ORDINARY chat split-turn
 * shape (the cut lands on a turn's first `assistant`, so the span ends on the user's
 * message), and a separate entry projects to `assistant > user > user` — which Anthropic and
 * Gemini merge back into one message anyway, but Chat Completions and OpenAI Responses have
 * no merge rule in their floors (`request-validity.ts:516-593`, `:336-346`). DeepSeek's
 * first-party reasoner documents a 400 for successive user messages, so on such a lane every
 * mid-turn chat compaction would become `summarize_failed` at every round head and the OOM
 * class would come back for it. Appending to the entry makes the tail single-user by
 * construction on all four, and leaves the Anthropic/Gemini bytes exactly as they were.
 */
function withTrailingUserEntry(span: JournalEntry[], text: string): JournalEntry[] {
  const last = span[span.length - 1];
  if (last.payload.type === 'user') {
    const blocks = [...last.payload.blocks, { type: 'text', text } as ContentBlock];
    return [...span.slice(0, -1), { ...last, payload: { ...last.payload, blocks } }];
  }
  return [
    ...span,
    {
      ...last,
      uuid: `${last.uuid}-compaction-instruction`,
      parentUuid: last.uuid,
      seq: last.seq + 1,
      payload: { type: 'user', blocks: [{ type: 'text', text } as ContentBlock] },
    },
  ];
}

/**
 * Index of the leading previous-compaction summary in a to-summarize span, or -1.
 *
 * The compactor's rule 5 puts it FIRST when one exists (a prior compaction's
 * summary entry leads the projection, and the new cut includes it so the new
 * summary subsumes the old), so this is a head check, not a scan. Identified by
 * the trail header or the archive note — both are strings THIS module writes, so
 * the recognizer can never match a user's own message by coincidence.
 */
function previousSummaryIndex(entries: JournalEntry[]): number {
  const head = entries[0];
  if (!head || head.payload.type !== 'user') return -1;
  const text = textOf(head);
  return text.includes('Full pre-compaction transcript archived at') ||
    text.includes('Context trail (recorded mechanically from tool calls')
    ? 0
    : -1;
}

/** Re-render the previous summary entry labelled AND fenced (contract/compaction-prompt.ts
 *  fencePreviousSummary — the one assembler). Pure — the journal is untouched. */
function withLabelledPreviousSummary(entries: JournalEntry[], idx: number): JournalEntry[] {
  const out = entries.slice();
  const entry = out[idx];
  out[idx] = {
    ...entry,
    payload: {
      type: 'user',
      blocks: [{ type: 'text', text: fencePreviousSummary(textOf(entry)) } as ContentBlock],
    },
  };
  return out;
}

/** The previous summary's accumulated file trail, or the empty trail. */
function previousTrailOf(droppedEntries: JournalEntry[]): FileTrail {
  const idx = previousSummaryIndex(droppedEntries);
  return idx >= 0 ? parseFileTrail(textOf(droppedEntries[idx])) : { read: [], modified: [] };
}

/**
 * Map a tool call to its trail effect via the side-effect CLASSIFIER — the repo's
 * capability metadata — so a tool added tomorrow is classified without being
 * registered anywhere. `readonly` reads; anything that mutates the workspace
 * counts as modified; purely external effects (an email, a payment) touch no file
 * and are not a file trail at all.
 */
function trailEffectOf(cfg: NativeConfig): (name: string, input: unknown) => TrailEffect {
  const workspaceRoot = cfg.workingDir ?? '/';
  return (name, input) => {
    // toolCallId is required by the ToolCall shape but never read by the classifier
    // (it classifies what a call DOES, not which call it was).
    const family = classifySideEffect({ toolName: name, toolInput: input, toolCallId: '' }, { workspaceRoot });
    if (family === 'readonly') return 'read';
    if (family === 'workspace_write' || family === 'dangerous_delete') return 'modified';
    return 'ignore';
  };
}

/** Concatenated text of a user/assistant entry's text blocks. */
function textOf(entry: JournalEntry): string {
  const payload = entry.payload;
  if (payload.type !== 'user' && payload.type !== 'assistant') return '';
  return payload.blocks
    .map((b: { type: string; text?: string }) => (b.type === 'text' && b.text ? b.text : ''))
    .join('');
}
