// packages/agent-sdk/src/engine/native-iterate-round.ts
//
// The per-ROUND phases of NativeHarness.iterateTurn's loop, lifted verbatim out of
// the 570-line method. These are loop-level POLICY — deliberately not round work,
// which lives in round-engine.ts. The split line is the one round-engine's header
// already draws: runOneRound owns the model call, the stream, the cost fold and the
// tool batch; everything the loop decides AROUND that round is here.
//
// The phases in loop order:
//
//   compactTurnHead      the round-head auto-compaction trigger (journal + threshold
//                        gated), its billing fold and the post-compaction re-project.
//   prepareRoundHead     the requested model, the adaptive-cache hint, the Nami
//                        recall consult and the round-HEAD steer drain.
//   recoverRoundFailure  the round catch — round-abort steer, severed re-issue,
//                        reactive compact-on-overflow, the pill heal.
//   settleEmptyRound     the empty-completion recovery ladder (recover → fallback
//                        model → finalize).
//   closeRoundBoundary   the post-tool-batch boundary — history re-project, the
//                        PostToolBatch hook, the paused-halt break, initiative
//                        preemption and the mid-turn steer poll.
//
// WHAT IS NOT VERBATIM. Two things cannot cross a function boundary, and both are
// declared at the site that does it:
//
//   1. `continue` / `break` / `throw` — each phase RETURNS the control signal and
//      the caller executes the keyword. Same discipline as native-run-turn.ts.
//   2. `this.` — the harness-private helpers (`compactionDeps`, `runSignal`,
//      `sealAbortedRound`) are handed over as explicit closures, exactly the way
//      `compactionDeps` already hands `compactionBase`/`runSignal` to the
//      compaction body.
//
// Everything else is byte-identical, including the mutations: each phase declares a
// LOCAL with the SAME NAME as the loop variable it used to assign (`history`,
// `nextRoundKind`, `pausedHalt`, `wantedMoreTools`, `emptyRecoveryAttempts`, …),
// seeded from a parameter and returned at the end. The assignment lines inside the
// bodies never changed, so the verbatim proof reads clean.
//
// `yield*` forwards `.return()` and `.throw()` to the delegate, so an aborting
// driver unwinds the generator phases exactly as it did when they were inline.
//
// No module-scope mutable state (R2's rule): every phase takes the state it touches
// as an argument, so two sessions sharing this process never share a byte of it.

import type { HarnessContext } from '../contract/harness.js';
import type { HarnessEvent, RoundKind } from '../contract/events.js';
import type { ContentBlock } from '../contract/blocks.js';
import type { CachePrefixHint } from '../contract/cache-prefix-hint.js';
import type { HookDispatcher } from '../kernel/index.js';
import type { NativeConfig } from './native-config.js';
import type { RecallSeam } from './recall.js';
import type { RunContext } from './run-context.js';
import type { RoundState } from './round-engine.js';
import type { SeveredRetryState } from './severed-stream.js';
import type { ToolDispatchResult } from '../tools/tool-types.js';
import type { RecallTurnState } from './turn-decisions.js';
import type { CompactionDeps } from './compaction-run.js';
import type { FrozenElision } from './context-elision.js';
import type { ProviderHistory, ProviderTool, Transport } from './transport.js';
import { wireMessages } from './context-elision.js';
import {
  compactAtRoundHead,
  rebuildAfterCompaction,
  runRecoveryCompaction,
  compactionUsageEvent,
  refusalEvents,
  yieldIfPresent,
} from './compaction-run.js';
import {
  isRoundAbort,
  collectRunningToolUseIds,
  foldCompactionResult,
  consultRecall,
  appendSteerEntry,
  injectStagedSteer,
} from './turn-decisions.js';
import { reissueSeveredRound } from './severed-stream.js';
import { recoverFromOverflow } from './compaction-recovery.js';
import { appendInjectedUserEntry, appendUsageEntry } from './native-journal.js';
import { TURN_CAP_DIRECTIVE } from './subagent-walls.js';
import { dispatchLifecycle, buildPostToolBatchInput, continueContext } from './native-hooks.js';
import { MAX_EMPTY_RECOVERY_ATTEMPTS, emptyRecoveryDecision } from './empty-recovery.js';

/** The context every round phase reads. One object, assembled once per turn. */
export interface RoundPhaseDeps {
  ctx: HarnessContext<NativeConfig>;
  cfg: NativeConfig;
  transport: Transport;
  rc: RunContext;
  /** The turn's FROZEN elision — decided once in iterateTurn, shared by wire AND ledger. */
  elision: FrozenElision | null;
  /**
   * The harness-private compaction seam, pre-bound to this run's ctx/transport/
   * dispatcher. A factory (not a value) because the original built it INSIDE the
   * round-head try, where a throw routes to the compaction catch.
   */
  makeCompactionDeps: () => CompactionDeps;
  /** The harness-private per-run abort signal (`this.runSignal`). */
  runSignal: (ctx: HarnessContext<NativeConfig>) => AbortSignal;
}

/**
 * Auto-compaction trigger (journal-gated + threshold-gated), run at the head of every
 * round. Returns the history the next model call should see — the SAME object when
 * nothing compacted, the re-projected one when it did.
 *
 * `system` and `wireTools` are threaded as the prologue supplies them; `wireTools` stays
 * a function so it is still invoked in the exact argument position it always was.
 */
export async function* compactTurnHead(
  deps: RoundPhaseDeps,
  system: string,
  wireTools: () => ProviderTool[],
  historyIn: ProviderHistory,
): AsyncGenerator<HarnessEvent, ProviderHistory> {
  const { ctx, cfg, rc, elision, makeCompactionDeps } = deps;
  let history = historyIn;
  // ── Auto-compaction trigger (journal-gated + threshold-gated) ─────────
  // Checked BEFORE each model call so a long tool batch that grows context
  // triggers on the NEXT round. maybeCompact returns null (changes nothing) with
  // no journal/config or a below-threshold ledger → byte-identical. Never-throw
  // (inner + outer try) → degrade to no-compaction; an abort re-throws to the
  // outer user_aborted path, so we re-check the signal and swallow only non-aborts.
  // History: docs/learnings/native-harness-history.md (Compaction).
  try {
    // Was `this.compactionDeps(ctx, transport, dispatcher)` — same object, built at
    // the same point inside the try.
    const deps = makeCompactionDeps();
    const head = await compactAtRoundHead(deps, rc, system, wireTools(), elision);
    // A refused DEFERRED recovery records itself and falls through to the ordinary trigger;
    // its events ride out here because compactAtRoundHead returns a verdict, it cannot yield.
    for (const ev of head.pendingEvents) yield ev;
    if (head.result) {
      // Fold the summarize cost into BOTH accumulators (cumulative → the next
      // turn_end's billing; parentOwn in lockstep) and journal the summarize
      // round's usage at the fold.
      const fold = foldCompactionResult(head.result);
      rc.billing.cumulativeCostUsd += fold.cumulativeDeltaUsd;
      rc.billing.parentOwnCostUsd += fold.parentOwnDeltaUsd;
      await appendUsageEntry(cfg.journal, ctx, fold.usageEntry);
      // Re-project so the next model call sees the compacted context (and, on a
      // deferred-overflow recovery, NOT the assistant message that overflowed).
      history = await rebuildAfterCompaction(deps, elision, head.observation);
      yield* yieldIfPresent(compactionUsageEvent(head.result, ctx.taskId, rc.billing.roundCounter.value));
      yield head.result.event;
    }
  } catch (compactErr) {
    if (cfg.signal?.aborted) throw compactErr; // route to user_aborted
    console.warn('[NativeHarness] compaction failed', compactErr);
    // T9b — never-throw stays, SILENCE does not. `console.warn` alone is how "an
    // agentic loop can never compact" survived for months: the trigger fired, the
    // planner refused, and the run continued uncompacted until it died of
    // context_exceeded with nothing durable to read. Emit the refusal with the
    // planner's NAMED reason and journal it. `makeCompactionDeps` is a plain object
    // construction (native-harness.ts compactionDeps), and recordCompactionFailure
    // swallows its own append failure, so this cannot cost the turn.
    // Record it, fold any summarize it already paid for, and emit BOTH legs — the usage
    // event is what reaches the server's re-price (it reads socket usage events, never the
    // journal), so without it a billed-then-refused compaction was invisible to billing.
    for (const ev of await refusalEvents(makeCompactionDeps(), rc, 'auto', compactErr)) yield ev;
  }
  return history;
}

/** What the round head decided before the model call. */
export interface RoundHeadResult {
  requestedModel: string;
  cachePrefixHint: CachePrefixHint | undefined;
  history: ProviderHistory;
  nextRoundKind: RoundKind;
}

/**
 * The round head AFTER compaction: pick the model, read the adaptive-cache hint,
 * consult Nami, and pull the armed steer drain. Returns everything the round call
 * needs plus the (possibly steered) history and round kind.
 */
export async function prepareRoundHead(
  deps: RoundPhaseDeps,
  recallSeam: RecallSeam | undefined,
  recallState: RecallTurnState,
  emptyFallbackModel: string | undefined,
  historyIn: ProviderHistory,
  nextRoundKindIn: RoundKind,
): Promise<RoundHeadResult> {
  const { ctx, cfg, transport, elision } = deps;
  let history = historyIn;
  let nextRoundKind = nextRoundKindIn;
  // Belt-and-suspenders: ctx.model is populated by the builder in query-manager,
  // but guard here too (the loop has no other downstream fallback — an empty model
  // string → a provider 400). The empty-recovery fallback model, once activated,
  // overrides the per-task model for the rest of the turn; the `||` keeps an
  // empty-string ctx.model falling to default.
  const requestedModel = emptyFallbackModel ?? (ctx.model || transport.defaultModel());
  // A CHEAP per-round check for the adaptive-cache hint. `history` was just rebuilt
  // from `journal.project()` and no append has happened since, so this project()
  // hits the WARM O(1) cache. When the projection leads with a compaction summary,
  // hint the transport to anchor a cache breakpoint on the stable prefix. Journal
  // path only → in-memory hint always absent → byte-identical.
  // History: docs/learnings/native-harness-history.md (Cache prefix hint).
  const cachePrefixHint = cfg.journal
    ? (await cfg.journal.project()).compactionSummaryLeading
      ? { summaryLeading: true as const }
      : undefined
    : undefined;
  // ── Per-round Nami consult (read-on-relevance) ───────────────────────
  // At the round head, AFTER the compaction re-project + cachePrefixHint read and
  // AFTER the previous boundary's preemption/steer consults, so the query sees the
  // freshest working set (a just-landed steer is a first-class user entry). The
  // consult (deadline race, dedupe, journaled fence) lives in consultRecall; the
  // seam-present gate stays here so the no-seam path never touches it.
  if (recallSeam) {
    history = await consultRecall(recallSeam, cfg, ctx, transport, recallState, history, elision);
  }
  // Round-HEAD steer consult: an ESC+queue that lands while NO round is in flight
  // has nothing to abort, so the armed drain is pulled HERE (before the model call
  // captures the run scope) or the steer would wait out a whole round ("an interrupt
  // must never wait on anything"). No poll at the head. Not armed → byte-identical.
  // History: docs/learnings/native-harness-history.md (Steer & abort).
  const headSteer = await injectStagedSteer(cfg, ctx, transport, history, false, elision);
  history = headSteer.history;
  if (headSteer.steered) nextRoundKind = 'steer';
  return { requestedModel, cachePrefixHint, history, nextRoundKind };
}

/**
 * What the round-failure recovery decided. `continue` and `throw err` are the caller's
 * keywords, returned rather than executed because they cannot cross a function
 * boundary. `reactiveCompactionAttempted` rides BOTH arms because the original latched
 * it before the terminal throw.
 */
export type RoundFailureResult = { reactiveCompactionAttempted: boolean } & (
  | { stop: 'continue'; history: ProviderHistory; nextRoundKind: RoundKind }
  | { stop: 'rethrow' }
);

/**
 * The round catch. Three ladders in priority order — round-abort steer (continue the
 * same turn), severed-stream re-issue, reactive compact-on-overflow — and a terminal
 * rethrow when none of them owns the error.
 */
export async function* recoverRoundFailure(
  deps: RoundPhaseDeps,
  err: unknown,
  st: RoundState,
  turnBlocks: ContentBlock[],
  severedRetry: SeveredRetryState,
  sealAbortedRound: (st: RoundState, turnBlocks: ContentBlock[], userAborted: boolean) => Promise<void>,
  alreadyAttempted: boolean,
  historyIn: ProviderHistory,
  nextRoundKindIn: RoundKind,
): AsyncGenerator<HarnessEvent, RoundFailureResult> {
  const { ctx, cfg, transport, rc, elision, makeCompactionDeps } = deps;
  let history = historyIn;
  let nextRoundKind = nextRoundKindIn;
  let reactiveCompactionAttempted = alreadyAttempted;
  // Round-abort steer — "abort now, continue same stream". The steer-interrupt
  // swaps the LIVE run scope BEFORE aborting the old one, so an AbortError whose
  // live cfg.signal is NOT aborted is a round-abort, not a stop: seal the aborted
  // round, inject the drained text as a marker-tagged user entry, and CONTINUE
  // the same turn (no user_aborted/AGENT_END/re-drive). Everything else rethrows
  // to the terminal catch → the plain hard stop is byte-identical.
  // History: docs/learnings/native-harness-history.md (Steer & abort → P3.5).
  // Pinned by: native-harness.steer-drain.test.ts, abort-drain.test.ts.
  const steerText =
    isRoundAbort(err, cfg.signal?.aborted) && cfg.journal ? cfg.drainSteerText?.() : undefined;
  if (!steerText) {
    // Deploy-seam ladder 1 (flag-gated): a SEVERED model stream is re-issued
    // instead of burning the turn — the gate, partial seal, continuation
    // marker, backoff, and abort-wins discipline live in severed-stream.ts.
    const severed = await reissueSeveredRound(err, cfg, ctx, transport, st, turnBlocks, history, severedRetry, elision);
    if (severed.reissue) {
      history = severed.history;
      nextRoundKind = 'continuation';
      return { stop: 'continue', history, nextRoundKind, reactiveCompactionAttempted };
    }
    // UNIT B — reactive compact-on-overflow (compaction-recovery.ts): a
    // `context_exceeded` round self-heals ONCE per turn, else falls through to the
    // terminal `throw err` exactly as today (an abort mid-compaction re-throws).
    const recovery = await recoverFromOverflow({
      err, ctx, cfg, transport, rc, elision,
      alreadyAttempted: reactiveCompactionAttempted,
      runRecovery: () => runRecoveryCompaction(makeCompactionDeps()),
      // A refused reactive recovery is the OOM path's own failure — journal it with the
      // planner's named reason, keep any summarize it already paid for, and hand the EVENTS
      // back: `recoverFromOverflow` returns a verdict rather than a stream, so it carries
      // them out on `refusalEvents` and this function yields them a few lines below.
      onRefused: (err) => refusalEvents(makeCompactionDeps(), rc, 'auto', err, 'reactive'),
    });
    if (recovery.attempted) reactiveCompactionAttempted = true;
    // The refused-recovery legs (record + billed spend + usage), yielded here because
    // recoverFromOverflow returns a verdict rather than a stream.
    if (!recovery.retry) for (const ev of recovery.refusalEvents ?? []) yield ev;
    if (recovery.retry) {
      history = recovery.history;
      nextRoundKind = 'continuation';
      yield recovery.event;
      return { stop: 'continue', history, nextRoundKind, reactiveCompactionAttempted };
    }
    return { stop: 'rethrow', reactiveCompactionAttempted };
  }
  // Pill heal: the killed round's still-running tool cards would otherwise spin
  // until the turn's terminal (a steered continuation can run for minutes).
  // Capture them BEFORE the seal flips their status, then emit each one's
  // interrupted tool_result through the SAME block→sink path a settled tool uses.
  // History: docs/learnings/native-harness-history.md (Steer & abort → pill heal).
  const killedToolUseIds = collectRunningToolUseIds(turnBlocks);
  await sealAbortedRound(st, turnBlocks, true);
  for (const toolUseId of killedToolUseIds) {
    yield {
      kind: 'block',
      block: {
        type: 'tool_result',
        toolUseId,
        content: 'Interrupted by user.',
        isError: false,
      } as ContentBlock,
    };
  }
  history = await appendSteerEntry(cfg, ctx, transport, history, steerText, elision);
  // The aborted batch never cleared the in-batch flag — reset it so a
  // LATER abort's phase classification doesn't read a stale 'tools'.
  st.inToolBatch = false;
  nextRoundKind = 'steer';
  return { stop: 'continue', history, nextRoundKind, reactiveCompactionAttempted };
}

/**
 * What the empty-completion ladder decided. `continue`/`break` are the caller's
 * keywords; the two counters ride back because the ladder is what advances them.
 */
export interface EmptyRoundResult {
  stop: 'continue' | 'break';
  emptyRecoveryAttempts: number;
  emptyFallbackModel: string | undefined;
}

/**
 * A round that emitted NO tool calls: real text completes the turn, an empty round is
 * re-called up to MAX_EMPTY_RECOVERY_ATTEMPTS, and an exhausted ladder gets ONE switch
 * to the configured fallback model before finalizing a blank turn.
 */
export function settleEmptyRound(
  deps: RoundPhaseDeps,
  st: RoundState,
  requestedModel: string,
  attemptsIn: number,
  fallbackModelIn: string | undefined,
): EmptyRoundResult {
  const { cfg } = deps;
  let emptyRecoveryAttempts = attemptsIn;
  let emptyFallbackModel = fallbackModelIn;
  const decision = emptyRecoveryDecision({
    hasVisibleText: st.assistantText.trim() !== '',
    hasThinking: st.thinkingBlocks.length > 0,
    stopReason: st.stopReason,
    attemptsSoFar: emptyRecoveryAttempts,
    maxAttempts: MAX_EMPTY_RECOVERY_ATTEMPTS,
  });
  if (decision === 'recover') {
    emptyRecoveryAttempts += 1;
    // In-memory ONLY (never journaled): changes THIS re-call's input without
    // persisting a placeholder a resume could replay (the "(no content)" parrot).
    // Seat a minimal assistant turn BEFORE the nudge so role-alternation holds
    // (Anthropic 400s on a user message following a user/tool_result turn).
    //
    // ARMED, NOT PUSHED: the seat+nudge are built onto a COPY at the next round's
    // request site (withEmptyRecoverySeat), so `history` stays equal to what the
    // journal re-derives. Pushing them here made every later round of the turn fail
    // the reconstruction invariant — the four recorded `wire_reconstruction_desync`
    // rows are exactly this. The re-call still sees both items.
    deps.rc.recoverySeatArmed = true;
    return { stop: 'continue', emptyRecoveryAttempts, emptyFallbackModel };
  }
  // 'giveup' (in-place recovery exhausted): before finalizing a blank turn, if a
  // fallback model is configured and not yet activated, switch to it and reset the
  // counter so the wedged model gets ONE escape hatch. Set once → no second switch;
  // unset fallback → byte-identical.
  if (decision === 'giveup' && cfg.retry?.fallbackModel && emptyFallbackModel === undefined) {
    emptyFallbackModel = cfg.retry.fallbackModel;
    emptyRecoveryAttempts = 0;
    console.warn(
      `[NativeHarness] empty-recovery exhausted on ${requestedModel} — switching to fallback model ${emptyFallbackModel}`,
    );
    return { stop: 'continue', emptyRecoveryAttempts, emptyFallbackModel };
  }
  // 'complete' (real text) or 'giveup' with no fallback left → finalize.
  return { stop: 'break', emptyRecoveryAttempts, emptyFallbackModel };
}

/** What the post-tool-batch boundary decided. `break` is the caller's keyword. */
export interface RoundBoundaryResult {
  stop: 'break' | 'proceed';
  history: ProviderHistory;
  nextRoundKind: RoundKind;
  pausedHalt: boolean;
  preempted: boolean;
  wantedMoreTools: boolean;
  /** X1: a hook refused a call with `interrupt: true`; the turn ends as `hook_blocked` with this. */
  hookStop?: string;
}

/**
 * The safe round boundary: every tool_use is paired and history is API-valid. Rebuild
 * the history, fire the batch-level hook, then the three things that can end the turn
 * here (a hook halt, a needs-human pause, an initiative preemption) and finally the
 * mid-turn steer poll.
 *
 * Enters with `wantedMoreTools` TRUE (the caller set it the instant the round emitted
 * tool calls) — every break path clears it, exactly as the inline code did.
 */
export async function closeRoundBoundary(
  deps: RoundPhaseDeps,
  prologue: { dispatcher: HookDispatcher },
  st: RoundState,
  results: ToolDispatchResult[],
  isInitiative: boolean,
  historyIn: ProviderHistory,
  iterations: number,
): Promise<RoundBoundaryResult> {
  const { ctx, cfg, transport, rc, elision, runSignal } = deps;
  let history = historyIn;
  let nextRoundKind: RoundKind = 'continuation';
  let pausedHalt = false;
  let preempted = false;
  let wantedMoreTools = true;
  // Follow-up B item 2 — the WRAP-UP nudge, for a caller that named a round to land it on
  // (a background helper's actor: it runs here, not through runSubagentLoop, so follow-up
  // A's per-type nudge never reached it). Pushed ONCE, here at the settle boundary and
  // BEFORE the re-project below, so it lands behind this round's tool_results exactly as
  // the runaway directive does. It steers and gates nothing: `cfg.maxTurns` is still the
  // hard stop, and the rounds between the two are the room to write the report in.
  if (cfg.turnWrapUpAt !== undefined && !rc.turnWrapUpPushed && iterations >= cfg.turnWrapUpAt) {
    rc.turnWrapUpPushed = true;
    if (cfg.journal) await appendInjectedUserEntry(cfg.journal, ctx, TURN_CAP_DIRECTIVE, 'engine');
    else transport.pushUser(history, TURN_CAP_DIRECTIVE);
  }
  // After the tool batch, rebuild the history for the next model call.
  // Journal path: re-project (includes the tool_result entries just appended).
  // In-memory path: `history` already has the appended tool_results above.
  if (cfg.journal) {
    history = transport.historyFromJournal(wireMessages((await cfg.journal.project()).messages, elision));
  }

  // PostToolBatch seam — fires ONCE per tool round (the batch-level barrier), after
  // every tool_use resolved + history rebuilt. Observed for ADDITIONAL CONTEXT only
  // (per-tool gating is PreToolUse); a halt stops the iterate loop cleanly. No-op
  // when no callbacks; passes the full round so a batch hook sees what ran.
  // History: docs/learnings/native-harness-history.md (Hooks lifecycle → PostToolBatch).
  const batch = await dispatchLifecycle(
    prologue.dispatcher,
    buildPostToolBatchInput(
      st.toolUses.map((tu, i) => ({
        tool_name: tu.name,
        tool_input: tu.input,
        tool_use_id: tu.id,
        tool_response: results[i]?.text,
      })),
    ),
    runSignal(ctx),
    ctx.sessionId,
  );
  if (batch.decision === 'halt') {
    pausedHalt = true;
    wantedMoreTools = false;
    return { stop: 'break', history, nextRoundKind, pausedHalt, preempted, wantedMoreTools };
  }
  const batchCtx = continueContext(batch);
  if (batchCtx) {
    // The batch hook injected context for the NEXT model call — append it as
    // a user fact (journal path) / push it (in-memory) so the next round sees
    // it. Empty when no callback → byte-identical.
    if (cfg.journal) {
      await appendInjectedUserEntry(cfg.journal, ctx, batchCtx, 'hook');
      history = transport.historyFromJournal(wireMessages((await cfg.journal.project()).messages, elision));
    } else {
      transport.pushUser(history, batchCtx);
    }
  }

  // A needs-human / Composio-auth halt ENDS the turn (the model resumes later). A
  // CLEAN stop, not exhaustion — clear the neutral exhaustion signal so the epilogue
  // routes it through the normal classifier. `stopReason` stays at the provider's
  // actual value (the classifier handles both arms as completed). Checked BEFORE an
  // interrupt: a batch that also raised a card has a person being asked, and its turn
  // must say paused while that card is open (review of #4284, LOW-5). The interrupted
  // call's refusal is journaled, so the model reads it when the turn resumes.
  if (results.some((r) => r.pausedHalt)) {
    pausedHalt = true;
    wantedMoreTools = false;
    return { stop: 'break', history, nextRoundKind, pausedHalt, preempted, wantedMoreTools };
  }

  // X1 (HOOK_PARITY_V1): a PermissionRequest hook refused a call with `interrupt: true`. The
  // refusal is journaled like any result; the turn ends here, as a stop, not a pause.
  const hookStop = results.find((r) => r.hookStop !== undefined)?.hookStop;
  if (hookStop !== undefined) {
    wantedMoreTools = false;
    return { stop: 'break', history, nextRoundKind, pausedHalt, preempted, wantedMoreTools, hookStop };
  }

  // ── PREEMPTION — a human turn always wins ────────────────────────────
  // At this safe round boundary (all tool_results paired, AFTER the pausedHalt
  // break, BEFORE the next model call) an INITIATIVE turn yields the floor the
  // instant a human turn is staged: finalize NOW as `completed` with exitReason
  // `preempted_by_human`; the staged turn is picked up next iteration. Placed
  // BEFORE the steer consult deliberately (a human message preempts ambient work,
  // it is not folded in as a mid-turn steer). Initiative-only, unconditional.
  // History: docs/learnings/native-harness-history.md (Preemption & ambient fuel).
  // Pinned by: initiative-preemption.test.ts.
  if (isInitiative && cfg.hasPendingInput?.()) {
    preempted = true;
    wantedMoreTools = false;
    return { stop: 'break', history, nextRoundKind, pausedHalt, preempted, wantedMoreTools };
  }

  // ── priority:'now' mid-turn STEER injection ──────────────────────────
  // THE BOUNDARY: every tool_use in this round is paired and history is API-valid,
  // AFTER the pausedHalt break (so a steer can never land between a paused tool_use
  // and its resolution) and BEFORE the next model call. Poll the steer seam
  // NON-BLOCKINGLY: a `priority:'now'` message is injected as a user message so the
  // NEXT model call sees it (STEERS, does not abort). Skipped when the signal
  // already aborted. The drain (interrupt-with-queued-message) is consulted FIRST
  // and lands as a marker-tagged user entry so the SAME turn continues (no restart,
  // no re-billed rounds). Drain-then-poll + marker discipline live in injectStagedSteer.
  // History: docs/learnings/native-harness-history.md (Steer & abort → now-steer).
  // Pinned by: native-harness.steer-drain.test.ts.
  const boundarySteer = await injectStagedSteer(cfg, ctx, transport, history, true, elision);
  history = boundarySteer.history;
  if (boundarySteer.steered) nextRoundKind = 'steer';
  return { stop: 'proceed', history, nextRoundKind, pausedHalt, preempted, wantedMoreTools };
}
