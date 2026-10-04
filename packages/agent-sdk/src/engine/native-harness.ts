import { randomUUID } from 'node:crypto';
import type {
  Harness,
  HarnessContext,
  GateResult,
  ToolCall,
  UserTurn,
  MessageOrigin,
} from '../contract/harness.js';
import type { HarnessCapabilities } from '../contract/capabilities.js';
import type { HarnessEvent, RoundKind } from '../contract/events.js';
import type { ChildCostRecord } from '../contract/child-cost.js';
import type { TurnOutcome } from '../contract/turn-outcome.js';
import type { ContentBlock } from '../contract/blocks.js';
import type { InteractionKind } from '../contract/interaction.js';
import type { NewEntry } from '../contract/journal.js';
import type { SideCallResult } from './offloop-usage.js';
import { attachMediaWatch, mediaUsageEvent } from './media-watch.js';
import { runSideCallsInline, PostTurnOffPath, PostTurnEvents, postTurnCompaction, type PostTurnInputs } from './post-turn-off-path.js';
import { compactionPostTurnEnabled, postTurnOffPathEnabled } from '../policy/feature-flags.js';
import { resolveCapabilities } from '../contract/model-capabilities.js';
import { validateOutputSchema, validateOutputValue } from '../contract/validate-output.js';
import type { OutputFormat } from '../contract/output-format.js';
// Strict-compat check reused to fail structured output CLOSED at preflight for
// OpenAI (an optional field 400s under strict; Claude tolerates it). Pure/zero-zod
// in contract/ so the engine reuses it with no engine→transports import.
// History: docs/learnings/native-harness-history.md (structured-output epilogue).
import { NoopContextPort } from '../kernel/index.js';
import { wireMessages, type FrozenElision } from './context-elision.js';
import { buildContextUsageSnapshot } from './context-usage-snapshot.js';
import type { SubagentPathSegment } from '../contract/subagent-path.js';
import { subagentIdFromPath } from '../contract/subagent-path.js';
import { NATIVE_CAPABILITIES } from './native-capabilities.js';
import type { NativeConfig } from './native-config.js';
import { newRecallTurnState, epilogueRefusalShortCircuit } from './turn-decisions.js';
// Re-exported for tests that key off the abort recognizer / the epilogue refusal
// short-circuit (both live in turn-decisions.ts with the classifiers they serve).
export { isAbortShapedError, epilogueRefusalShortCircuit } from './turn-decisions.js';
import type { RunContext } from './run-context.js';
import { openRun, stageDeferredTurn, type RunPrologue } from './native-run-open.js';
import { openTurn, runCompactControlTurn, ingestUserTurn, ZERO_USAGE, type RunTurnDeps } from './native-run-turn.js';
import type { TurnIterationResult } from './turn-iteration-result.js';
// D01 — the iterate-turn phases, lifted out of the 570-line iterateTurn. TURN-level
// (open, round-state, epilogue, terminal catch, write-back) and ROUND-level (the five
// per-round policy phases inside the loop) split across two files; round WORK stays in
// round-engine.ts.
import {
  openIterateTurn,
  newRoundState,
  finalizeTurn,
  settleTerminalError,
  writeIterationResult,
  summarize,
} from './native-iterate-turn.js';
import {
  compactTurnHead,
  prepareRoundHead,
  recoverRoundFailure,
  settleEmptyRound,
  closeRoundBoundary,
  type RoundPhaseDeps,
  type RoundFailureResult,
} from './native-iterate-round.js';
import { attachToolSearch } from './tool-search-session.js';
import {
  createNativeHookDispatcher,
  dispatchLifecycle,
  buildSessionEndInput,
  buildStopInput,
} from './native-hooks.js';
import { hookStopOutcome, MAX_STOP_CONTINUE, sessionEndReason, stopContinuation, stopContinuedEvent } from './hook-parity.js';
import type { HookDispatcher } from '../kernel/index.js';
import { withMcpConnectRetry } from './mcp-retry.js';
import { PAUSED_HALT } from '../contract/paused-halt.js';
import { UnconfiguredInteractionPort } from '../ports/interaction-port.js';
import { AllowAllPolicyPort } from '../ports/policy-port.js';
import { EmptyToolHost } from '../ports/tool-host-port.js';
import { UnsetTransport } from './transport.js';
import type {
  NormalizedUsage,
  ProviderHistory,
  Transport,
} from './transport.js';
import {
  appendInjectedUserEntry,
  appendAssistantEntry,
  journalSubagentPause, flushTurnRecords,
} from './native-journal.js';
import { emitCaptureSignal } from './capture-signal-emit.js';
// Empty-completion decisions + OpenAI strict preflight (moved verbatim; the
// re-export below keeps every './native-harness.js' import path working).
import { openaiStrictPreflightFailure } from './empty-recovery.js';
export {
  MAX_EMPTY_RECOVERY_ATTEMPTS, EMPTY_RECOVERY_NUDGE, EMPTY_RECOVERY_SEAT,
  EMPTY_RESPONSE_FALLBACK_TEXT, isRecoverableEmptyStop, emptyRecoveryDecision,
  openaiStrictPreflightFailure, type EmptyRecoveryAction,
} from './empty-recovery.js';
// W3-3 — the parent loop's runaway guard (glue in parent-runaway.ts; counting
// core, thresholds and directive shared with the subagent loops' watchdog).
import { createParentRunawayGuard } from './parent-runaway.js';
import {
  turnCeilingReached, buildTurnCeilingOutcome,
  walletCapReached, buildWalletCapOutcome, type WalletCapSource,
} from './turn-ceiling-gate.js';
import { SUBAGENT_RUNAWAY_DIRECTIVE } from './subagent-watchdog.js';
import { structuredOutputRetryText } from '../contract/injected-user-text.js';
// P2.2 (Task 6) — the extracted per-round core (see round-engine.ts). iterateTurn
// delegates each round to runOneRound and shares the D1 RoundState with it.
import { runOneRound, type RoundState, type RoundResult } from './round-engine.js';
// Deploy-seam ladder 1 — the severed-stream re-issue (gate, seal, marker, backoff).
import type { SeveredRetryState } from './severed-stream.js';
// UNIT B — reactive compact-on-overflow + the shared CompactionResult shape.
// COMPACTION_V2 adds the deferred (truncated-stop) latch, armed after each round.
import { armOverflowLatchFromRound, type CompactionResult } from './compaction-recovery.js';
// The compaction BODY (trigger, plan, splice, summarize) — extracted so this file
// only ratchets down (R3). The harness keeps the seam, not the logic.
import { runManualCompaction, recordManualCompactionFailure, type CompactionDeps } from './compaction-run.js';
// UNIT C — the per-turn billing keystone check + its journal/emit promotion.
import { checkTurnBillingTripwire, emitBillingTripwire } from './billing-tripwire.js';
export { SEVERED_STREAM_MAX_REISSUES, STREAM_SEVERED_CONTINUE_MARKER } from './severed-stream.js';
import { mainRunCacheKey } from './main-run-cache-key.js';
import { healOnError } from './heal-on-error.js';
import { foldModelSpend } from './live-spend.js';

// The Stop re-feed budget (MAX_STOP_CONTINUE) lives in hook-parity.ts, shared with SubagentStop.


/**
 * NativeHarness — the provider-agnostic kernel loop (spec §3). It drives a
 * `Transport` (the provider seam) and NEVER imports a provider SDK. The default
 * transport is AnthropicMessagesTransport (native = Anthropic); the
 * `openai_responses` arm reuses this SAME loop with an OpenAIResponsesTransport.
 *
 * `run()` is decomposed into prologue → per-user-turn loop → iterate/epilogue
 * (internal clarity per spec §7). It
 * obeys the contract: exactly one terminal `turn_end` per user turn, never
 * throws out of run(), surfaces cumulative `billing` on every turn_end
 * (reportsCostUsd:false → the core bills off the event).
 *
 * HISTORY is durable when `cfg.journal` is present (resume-survives-restart via
 * the journal projection); absent → an in-memory ProviderHistory accumulated
 * across the turn loop (the transport owns its concrete history shape).
 */
export class NativeHarness implements Harness<NativeConfig> {
  readonly id = 'native' as const;
  readonly capabilities: HarnessCapabilities = NATIVE_CAPABILITIES;

  /** Tracked so gateTool can check isTaskStopping. Set on the FIRST line of run(). */
  private ctxTaskId = '';

  /**
   * The run's NativeConfig, captured on run()'s first line so gateTool can delegate to
   * the injected `cfg.policy`. Undefined before run() → gateTool falls back to
   * AllowAllPolicyPort (the SDK safe default; never hit in prod/tests).
   */
  private runConfig?: HarnessContext<NativeConfig>['config'];

  /**
   * The active ModelPort for THIS run (the REQUIRED cfg.transport), so
   * classifyTermination() delegates to the right provider's classifier. Before run()
   * it holds an inert UnsetTransport (classifyError → a generic failure, not an NPE).
   * History: docs/learnings/native-harness-history.md (Miscellaneous invariants).
   */
  private transport: Transport = new UnsetTransport();

  /**
   * W3-3 — the CURRENT turn's runaway trip latch (see parent-runaway.ts). On the
   * instance because the hook FLOOR captured `this` at dispatcher creation, so
   * the post-trip deny must sit in gateTool itself; re-assigned per turn,
   * cleared in run()'s finally. Undefined → no check → byte-identical.
   */
  private runawayTripped: (() => boolean) | undefined;

  // ── run() — the model-call loop ─────────────────────────────────────────────

  async *run(
    input: AsyncIterable<UserTurn>,
    ctx: HarnessContext<NativeConfig>,
  ): AsyncIterable<HarnessEvent> {
    // FIRST line: the stop-gate in gateTool no-ops until ctxTaskId is set; capture
    // the run's config so gateTool can delegate to the injected policy port.
    this.ctxTaskId = ctx.taskId;
    this.runConfig = ctx.config;
    // Seed THIS session's permission mode from the spawn env PERMISSION_MODE
    // (per-session by ctx.taskId; default/invalid → 'default'; idempotent) — this ARMS
    // the gateTool permission ladder for the native family. Delegated to the PolicyPort.
    // History: docs/learnings/native-harness-history.md (Miscellaneous invariants).
    (ctx.config.policy ?? new AllowAllPolicyPort()).seedModeFromEnv(ctx.taskId);
    // The ModelPort for this run — REQUIRED, supplied per arm (native → Anthropic,
    // openai_responses → OpenAI). The engine carries no concrete provider port, so an
    // absent transport is a programmer error (fail fast, don't run a wrong/null one).
    // History: docs/learnings/native-harness-history.md (Miscellaneous invariants).
    const transport = ctx.config.transport;
    if (!transport) throw new Error('NativeConfig.transport is required');
    this.transport = transport;

    // The open phase — todo buffer, prologue (never-throw), RunContext, round-counter
    // seed, instruction snapshot, SessionStart, the staged-turn buffers and the ambient
    // ledger. A prologue throw yields its own terminal turn_end and returns null.
    const opened = yield* openRun(ctx, transport, {
      buildPrologue: (c, t, onTodos) => this.buildPrologue(c, t, onTodos),
      runSignal: (c) => this.runSignal(c),
    });
    if (!opened) return;
    // The instance methods the extracted turn phases reach for. Passed in rather than
    // imported so the phase modules never import the class back (no runtime cycle).
    const turnDeps: RunTurnDeps = {
      terminalTurnEnd: (t, c, o, cum, tr, bo, ptb, ero, org) =>
        this.terminalTurnEnd(t, c, o, cum, tr, bo, ptb, ero, org),
      compactionDeps: (c, t, d) => this.compactionDeps(c, t, d),
      runSignal: (c) => this.runSignal(c),
    };
    const { pendingTodoBlocks, prologue, inMemoryHistory, rc, stagedTexts, stagedImages, stagedMedia } = opened;
    let seedChildUsagePending = opened.seedChildUsagePending;
    let ambientSpentUsd = opened.ambientSpentUsd;
    // POST_TURN_OFF_PATH_V1: the epilogue's side calls run while the next message is awaited
    // (post-turn-off-path.ts); their events arrive here between turns. Off: the bare input.
    const offPath = postTurnOffPathEnabled() ? new PostTurnOffPath() : undefined;

    for await (const item of offPath ? offPath.turns(input) : input) {
      if (item instanceof PostTurnEvents) { yield* item.events; continue; }
      const userTurn = item;
      // ── PER-USER-TURN: budget gate, then the iterate loop ──
      const cfg = ctx.config;

      // A staged turn (shouldQuery:false) does NOT drive an iterate-turn: buffer its
      // text/images/media and continue — they merge into the next querying turn. A
      // continue turn is never staged. Default (undefined/true) = query normally.
      if (userTurn.shouldQuery === false && !userTurn.continueInteraction) {
        stageDeferredTurn(userTurn, { texts: stagedTexts, images: stagedImages, media: stagedMedia });
        continue;
      }

      // Turn head: the billing baselines, then the two gates that can end this turn
      // before any model call (ambient fuel bucket, budget cap). Each yields its own
      // terminal turn_end; `stop` carries the loop keyword the phase would have run.
      const head = yield* openTurn(ctx, cfg, transport, rc, userTurn, seedChildUsagePending, ambientSpentUsd);
      seedChildUsagePending = false;
      if (head.stop === 'continue') continue;
      if (head.stop === 'break') break;
      const { perTurnBilling, isInitiative } = head;

      // The warm `/compact` CONTROL turn — a manual compaction at the turn boundary
      // instead of a model turn. Returns true when it handled the turn.
      if (yield* runCompactControlTurn(ctx, cfg, transport, prologue, rc, userTurn, perTurnBilling, turnDeps)) continue;

      // Ingest the user message: coalesce staged text/images, run UserPromptSubmit,
      // journal the entry. Returns true when a hook HALTED the prompt.
      if (yield* ingestUserTurn(ctx, cfg, transport, prologue, rc, userTurn, inMemoryHistory, stagedTexts, stagedImages, stagedMedia, perTurnBilling, turnDeps)) continue;

      // iterateTurn is an async generator — it yields the turn's streaming events live
      // and writes its terminal result into `out`; each yielded event forwards straight
      // through run()'s output. Stop re-feed loop: after the iterate-turn settles, a Stop
      // hook returning `additionalContext` forces ANOTHER iterate-turn (re-fed as a
      // synthetic user turn), capped at MAX_STOP_CONTINUE. No callback → byte-identical
      // single iterate. History: docs/learnings/native-harness-history.md (Hooks lifecycle).
      let turnResult: TurnIterationResult;
      let stopContinues = 0;
      for (;;) {
        const out = {} as TurnIterationResult;
        // Agent v2 (Task 4): thread the parent-own accumulator (in/out, like
        // cumulativeCostUsd) and the per-turn childUsage array (by reference — the
        // baseExecCtx addChildCost sink pushes into it). Across a Stop re-feed both
        // ACCUMULATE (same user turn → no reset between iterate-turns).
        try {
          yield* this.iterateTurn(ctx, prologue, transport, rc, inMemoryHistory, out, pendingTodoBlocks, isInitiative);
        } finally {
          // W3-3 — the trip latch dies WITH the turn, every exit path: the
          // continue path (materializeReExecute) pre-gates on THIS instance
          // before the next turn re-assigns it (fix round 1).
          this.runawayTripped = undefined;
        }
        turnResult = out;
        rc.billing.cumulativeCostUsd = turnResult.cumulativeCostUsd;
        rc.billing.parentOwnCostUsd = turnResult.parentOwnCostUsd;

        // A user abort or a paused-halt is a CLEAN stop that must finalize now —
        // never re-fed (re-feeding an aborting/paused turn would pollute its
        // journal: a synthetic user turn between a paused tool_use and its later
        // resolution corrupts the tool pairing). Skip the Stop dispatch entirely.
        if (turnResult.outcome.kind === 'user_aborted' || turnResult.pausedHalt) break;

        const stop = await dispatchLifecycle(
          prologue.dispatcher,
          buildStopInput(stopContinues > 0, summarize(turnResult.blocks) || undefined),
          this.runSignal(ctx),
          ctx.sessionId,
        );
        // Nothing to re-feed (a halt, no context) or the cap reached → finalize. X1: a block re-feeds.
        const forced = stopContinuation(stop, turnResult.outcome.kind === 'completed');
        if (!forced || stopContinues >= MAX_STOP_CONTINUE) break;

        // FORCED CONTINUATION: journal the injected context as a synthetic user
        // fact (so a resume replays it) and loop to drive another iterate-turn. Do
        // NOT yield the terminal turn_end — the continuation supersedes it.
        stopContinues += 1;
        yield* stopContinuedEvent(stop, stopContinues, ctx.taskId);
        if (cfg.journal) {
          await appendInjectedUserEntry(cfg.journal, ctx, forced, 'hook');
        } else {
          transport.pushUser(inMemoryHistory, forced);
        }
      }

      // Task 10: the turn's record — spawn stats counted, then the mirror drained (best-effort).
      await flushTurnRecords(cfg, ctx);

      // Weave Floor §1a item 5 — the billing tripwire. Positive-spend is asserted ONLY for
      // a genuine completion (the same `completed && !pausedHalt` signal the next-prompt
      // chip uses): an aborted/paused turn legitimately bills 0 (the paused subagent
      // re-bills on resume). The reconcile identity is checked unconditionally.
      const finalBilling = perTurnBilling();
      // P4 Task 2 — advance the ambient ledger by THIS initiative turn's delta so a
      // later initiative turn is denied once the bucket is spent (the foreground
      // cumulative is untouched). Only initiative turns under the knob accumulate →
      // byte-identical otherwise. Reached on every terminal path (normal/abort/pause),
      // so a partially-spent initiative turn still debits its bucket.
      if (isInitiative && cfg.ambientFuelTankUsd !== undefined) {
        ambientSpentUsd += finalBilling.turnDeltaUsd;
      }
      // UNIT C — a violation stays NO-THROW (a throw false-positives on resume-seed /
      // epilogue-fold), but is now PROMOTED from console-only to wire-visible (journal +
      // raw event, in billing-tripwire.ts). A clean turn returns null → byte-identical.
      const tripwire = checkTurnBillingTripwire(
        finalBilling,
        turnResult.outcome.kind === 'completed' && !turnResult.pausedHalt,
      );
      if (tripwire) yield* emitBillingTripwire(cfg.journal, ctx, rc, tripwire);
      // Write-on-surprise capture signal (capture-signal-emit.ts): BEFORE the terminal
      // turn_end so a tearing-down driver still forwards it; journal-gated; never-throw.
      yield* emitCaptureSignal(cfg, ctx, turnResult);
      yield this.terminalTurnEnd(transport, ctx, turnResult.outcome, rc.billing.cumulativeCostUsd, turnResult, undefined, finalBilling, turnResult.exitReason, userTurn.origin);

      // VIDEO_UNDERSTANDING_V1 — this turn's `watch` describe spend → ONE `vision`
      // lane row (drained; UNGATED on outcome — an unreported side call is the exact
      // vanishing act the lane rail exists to end). See media-watch.ts.
      const mediaUsage = mediaUsageEvent(
        prologue.mediaRecords.splice(0), ctx.taskId, rc.billing.roundCounter.value);
      if (mediaUsage) yield mediaUsage;

      // The epilogue side calls (next-prompt chip, memory sweep; post-turn-off-path.ts). Off: awaited before the next
      // message. POST_TURN_OFF_PATH_V1: the idle lane, which alone also runs COMPACTION_POST_TURN_V1's compaction.
      const post: PostTurnInputs = {
        cfg, taskId: ctx.taskId, model: ctx.model || transport.defaultModel(), transport,
        system: prologue.system, wireTools: () => prologue.wireTools(), elision: rc.elision, loopRequest: rc.lastRequest, loopInput: rc.lastRoundInput,
        signal: this.runSignal(ctx), turnNumber: rc.billing.roundCounter.value, userTurn,
        clean: turnResult.outcome.kind === 'completed' && !turnResult.pausedHalt,
      };
      if (post.clean && offPath && compactionPostTurnEnabled() && !cfg.hasPendingInput?.()) post.compact = await postTurnCompaction(this.compactionDeps(ctx, transport, prologue.dispatcher), rc, prologue.system, prologue.wireTools(), rc.elision);
      if (offPath) offPath.schedule(post);
      else yield* runSideCallsInline(post);

      // A user interrupt ENDS the run (the signal is one-shot). A HITL pause ALSO ends
      // the run: the tool slot is left UNANSWERED and the durable interaction row (not a
      // frozen turn) bridges human-time, so resume is a FRESH turn off the materialized
      // journal. A normal turn still loops back and awaits the next message, so warm
      // multi-turn conversations are unaffected (the load-bearing safety invariant).
      // History: docs/learnings/native-harness-history.md (HITL pause / continue).
      // Pinned by: native-harness.pause-ends-run.test.ts.
      if (turnResult.outcome.kind === 'user_aborted' || turnResult.pausedHalt) break;
    }

    // SessionEnd seam — fires ONCE per run, after the user-turn loop drains. No-op when
    // no callback; best-effort observability, its outcome is not acted on (run is over).
    // History: docs/learnings/native-harness-history.md (Hooks lifecycle → SessionEnd).
    await dispatchLifecycle(
      prologue.dispatcher,
      buildSessionEndInput(sessionEndReason()), // X1: the documented "other" under HOOK_PARITY_V1
      this.runSignal(ctx),
      ctx.sessionId,
    );
  }

  /**
   * Build the ONE terminal turn_end for a settled iterate-turn. Extracted so the normal
   * and UserPromptSubmit-refused paths share the same billing + stopReason coercion:
   * never yield a 'tool_use' stopReason (the driver would skip finalization → UI hang).
   * History: docs/learnings/native-harness-history.md (Miscellaneous → BUG-1).
   */
  private terminalTurnEnd(
    transport: Transport,
    ctx: HarnessContext<NativeConfig>,
    outcome: TurnOutcome,
    cumulativeCostUsd: number,
    turnResult?: TurnIterationResult,
    blocksOverride?: ContentBlock[],
    // The per-turn reconciliation triple from run()'s perTurnBilling(). Spread onto
    // billing when present; absent → byte-identical to `{ cumulativeCostUsd, modelUsage }`.
    perTurnBilling?: { turnDeltaUsd: number; parentOwnCostUsd: number; childUsage: ChildCostRecord[] },
    // Override the default `stop(${stopReason})` exitReason (e.g. 'preempted_by_human').
    // Absent → the default → byte-identical.
    exitReasonOverride?: string,
    // The turn's origin. An `initiative` origin stamps the terminal turn_end with
    // `initiative`; every other origin (or absent) → no `initiative` key → byte-identical.
    origin?: MessageOrigin,
  ): HarnessEvent {
    const stopReason = turnResult ? turnResult.stopReason : 'end_turn';
    const terminalStopReason = stopReason === 'tool_use' ? 'end_turn' : stopReason;
    const usage = turnResult ? turnResult.lastUsage : ZERO_USAGE;
    const usageModel = turnResult ? turnResult.lastUsageModel : ctx.model;
    // L5 — the turn's ONE end, recorded on its owner as its terminal is built (idempotent).
    ctx.config.budget?.end(exitReasonOverride ?? outcome.kind);
    return {
      kind: 'turn_end',
      outcome,
      // blocksOverride lets a control turn (warm /compact no-op) carry a notice block
      // on an otherwise turnResult-less finalize; default = the turn's own blocks.
      blocks: blocksOverride ?? (turnResult ? turnResult.blocks : []),
      stopReason: terminalStopReason,
      exitReason: exitReasonOverride ?? `stop(${terminalStopReason})`,
      // A HITL pause ends the run but is a SUSPENSION, not a completion — the binding
      // interaction is still pending. Stamp it so the consumer + the server's orphan
      // sweep never treat this turn_end as an abandoned block. Omitted on a normal
      // completion → byte-identical.
      ...(turnResult?.pausedHalt === true ? { paused: true } : {}),
      // P4 Task 4: classify a self-initiated turn's result. Conditional spread from the
      // turn's origin — absent for every human/default origin → byte-identical.
      ...(origin?.kind === 'initiative'
        ? { initiative: { trigger: origin.trigger, politeness: origin.politeness } }
        : {}),
      billing: {
        cumulativeCostUsd,
        modelUsage: transport.buildModelUsage(usage, usageModel),
        // A run-constant marker — set iff the product plane seeded this run's cumulative
        // from the journal. Rides every terminal turn_end so the server suppresses the
        // restart-branch reset on a seeded resume. Absent → byte-identical.
        ...(ctx.config.journalSeedUsd ? { journalSeedUsd: ctx.config.journalSeedUsd } : {}),
        ...(perTurnBilling !== undefined && {
          turnDeltaUsd: perTurnBilling.turnDeltaUsd,
          parentOwnCostUsd: perTurnBilling.parentOwnCostUsd,
          childUsage: perTurnBilling.childUsage,
        }),
      },
    };
  }

  /** The per-run abort signal lifecycle dispatches race. Falls back to a never-
   *  aborting signal when the config omits one (tests / no-interrupt callers). */
  private runSignal(ctx: HarnessContext<NativeConfig>): AbortSignal {
    return ctx.config.signal ?? new AbortController().signal;
  }

  // ── PROLOGUE: tools + onPause, assembled once per run() ──────────────────────

  private async buildPrologue(
    ctx: HarnessContext<NativeConfig>,
    transport: Transport,
    onTodos: (todos: import('../ports/index.js').TodoSnapshot) => void,
  ): Promise<RunPrologue> {
    const cfg = ctx.config;

    // Pause-for-human: when a gated tool returns needs_human, fire the substrate
    // interaction (durable row + INTERACTION_REQUIRED) and halt. The engine consumes
    // cfg.interaction (the InteractionPort; the SDK default throws loudly). Built ONCE
    // here. Captures the minted interactionId and journal-binds the PENDING interaction
    // to the tool_use so the continue path can materialize it.
    // History: docs/learnings/native-harness-history.md (HITL pause / continue).
    const onPause = async (
      call: ToolCall,
      kind: string,
      subagentPath?: SubagentPathSegment[],
      // The Weave tool's captured-leaf hash (4th arg; extra optional params flow
      // structurally through the 2-arg ToolHost port type). Frozen onto the PENDING
      // marker as the resume's one-shot match key; absent on every non-Weave pause.
      // History: docs/learnings/native-harness-history.md (HITL → durable Weave pause).
      weavePending?: { contentHash: string; nodeSpecHash?: string; scopeId?: string },
    ): Promise<string> => {
      // A pause bubbled up from a nested subagent carries a root→leaf `subagentPath`;
      // `call` is then the LEAF inner tool that paused (the bubble PRESERVES it, not
      // collapsed to the top Agent tool_use). The leaf subagentId is derived the SAME
      // way `journalSubagentPause` does so wire + journal agree. Absent path → a
      // main-agent pause → byte-identical.
      // History: docs/learnings/native-harness-history.md (HITL → subagent-depth pause).
      const subagentId =
        subagentPath !== undefined && subagentPath.length > 0 ? subagentIdFromPath(subagentPath) : undefined;
      const interactionId = await (cfg.interaction ?? new UnconfiguredInteractionPort()).requestInteraction({
        taskId: ctx.taskId,
        call,
        kind: kind as InteractionKind,
        // exactOptionalPropertyTypes (SDK): spread each optional only when present so an
        // absent value omits the key rather than passing `undefined` (runtime-identical).
        ...(cfg.signal !== undefined && { signal: cfg.signal }),
        // P2.4 — thread the child's identity so the host persists it on the durable row +
        // rides it onto INTERACTION_REQUIRED; the resolved continue then routes to THAT lane.
        ...(subagentId !== undefined && { subagentId }),
        ...(subagentPath !== undefined && { subagentPath }),
      });
      // The PENDING marker + per-ancestor {status:'deferred'} placeholders are written by
      // the shared `journalSubagentPause` so the CONTINUE path (which mints its
      // interactionId via a different gateway) persists the bubble IDENTICALLY — the two
      // can never drift. Absent path → byte-identical to a plain main-agent pause.
      await journalSubagentPause(
        cfg.journal, ctx.taskId, interactionId, kind as InteractionKind, call.toolCallId, call.toolName,
        cfg.runtimeConfig?.userId ?? '', subagentPath, weavePending,
      );
      return PAUSED_HALT;
    };

    const mintId = () => randomUUID();
    // Bounded MCP-connect retry: a Composio MCP cold-wake hiccup (`-32001 timed out`)
    // must NOT abort the turn into PREWARM_STARTUP_FAILED — the remote MCP path warms up
    // on a retry (3 attempts, 750ms backoff); a persistent failure rethrows rather than
    // silently dropping tools. Extracted to withMcpConnectRetry so the continue path
    // reuses it. The engine consumes the tool list via the ToolHost port (NativeToolHost
    // wraps buildNativeToolList) so it imports no tool factory; order stays byte-identical.
    // (ctx.taskId so tool entries use the real per-request task id, not env SESSION_ID.)
    // History: docs/learnings/native-harness-history.md (HITL → MCP-connect retry).
    // Pinned by: native-tools.toolorder.test.ts.
    const built = await withMcpConnectRetry(
      () =>
        (cfg.toolHost ?? new EmptyToolHost()).buildTools({
          taskId: ctx.taskId,
          abilities: cfg.abilities ?? [],
          contextPort: cfg.contextPort ?? NoopContextPort,
          model: ctx.model,
          gateTool: this.gateTool.bind(this),
          onPause,
          onTodos,
          mintId,
        }),
      // exactOptionalPropertyTypes (SDK): omit `signal` when undefined.
      { ...(cfg.signal !== undefined && { signal: cfg.signal }) },
    );
    // Provider-neutral tool build (the loop never sees a provider tool type), plus
    // the TOOL_SEARCH_V1 client rail when this model rides it — see tool-search-session.
    const { onAuthHalt } = built;
    // VIDEO_UNDERSTANDING_V1 — a video-blind model gains the resident `watch` tool,
    // appended BEFORE attachToolSearch so the index-aligned shaping covers it; the records
    // array feeds the epilogue's `vision` lane row. Inert paths return the catalog by reference.
    const mediaRecords: SideCallResult[] = [];
    const withWatch = attachMediaWatch({
      model: ctx.model, catalog: built.tools, journal: cfg.journal, video: cfg.video,
      records: mediaRecords, workspaceDir: cfg.workingDir ?? process.cwd(),
      ...(cfg.signal !== undefined && { signal: cfg.signal }),
    });
    const { tools, wireTools, system, toolIndex } = await attachToolSearch(ctx, withWatch, cfg.journal, transport, cfg.systemPrompt ?? '');

    // The per-run HookDispatcher (per-run, NOT global — respects the multi-session
    // model). The security FLOOR (gateTool → security → capability → classifier) is the
    // first PreToolUse matcher; registered callbacks come AFTER it. cfg.emitHookEvent is
    // the GATED observability sink (default OFF → byte-identical); when present it maps
    // each callback phase → a `hook` HarnessEvent through the K3 sink.
    // History: docs/learnings/native-harness-history.md (Hooks lifecycle).
    const dispatcher = createNativeHookDispatcher(this, cfg.emitHookEvent, { workingDir: cfg.workingDir, taskId: ctx.taskId });

    // The registration seam — callbacks plug in here, AFTER the floor so security stays
    // first. Absent → only the floor → every lifecycle seam is a no-op (fires but folds
    // to a no-field continue) → byte-identical.
    cfg.registerHooks?.(dispatcher);

    // Fire onAttached so QueryManager can emit AGENT_START (parity with the other
    // arms). The handle is opaque (the native onAttached ignores it); pass the
    // transport so a future consumer could introspect the active ModelPort.
    cfg.onAttached(transport);

    return { tools, onAuthHalt, wireTools, system, toolIndex, onPause, dispatcher, mediaRecords };
  }

  // ── ITERATE + EPILOGUE: model ↔ tools until stop, then classify ──────────────

  private async *iterateTurn(
    ctx: HarnessContext<NativeConfig>,
    prologue: Awaited<ReturnType<NativeHarness['buildPrologue']>>,
    transport: Transport,
    // RunContext — the ONE owner of this run's billing state. rc.billing is mutated IN
    // PLACE: cumulative + parentOwn accumulate and write back via out.* (run() reads
    // them off the result); roundCounter + childUsage persist across user turns + Stop
    // re-feeds because rc outlives each iterate-turn (run() resets childUsage at the
    // boundary, never here). History: docs/learnings/native-harness-history.md (Billing).
    rc: RunContext,
    inMemoryHistory: ProviderHistory,
    out: TurnIterationResult,
    pendingTodoBlocks: ContentBlock[],
    // True when THIS turn's origin is `initiative`. Gates round-boundary preemption (an
    // initiative turn yields to a staged human turn); false → byte-identical round loop.
    isInitiative: boolean,
  ): AsyncIterable<HarnessEvent> {
    const cfg = ctx.config;
    const { tools, onAuthHalt, wireTools, system, onPause, dispatcher } = prologue;

    // Turn open (native-iterate-turn.ts): freeze this turn's elision, seat the
    // provider history from whichever source owns it, and emit the one
    // context-usage snapshot per user turn.
    const opened = yield* openIterateTurn(
      ctx, cfg, transport, rc, system, wireTools, inMemoryHistory,
      buildContextUsageSnapshot,
    );
    const elision = opened.elision;
    let history: ProviderHistory = opened.history;

    const turnStart = Date.now();
    const turnBlocks: ContentBlock[] = [];
    // rc.billing.parentOwnCostUsd is advanced in lockstep with cumulative at every PARENT
    // model site below (round cost, compaction, epilogue) — DELIBERATELY NOT by the child
    // fold — so it measures only the parent's own spend, written back via out.* at the end.
    // History: docs/learnings/native-harness-history.md (Billing).
    let iterations = 0;
    // True once a needs-human / Composio-auth halt ends the turn (a CLEAN stop
    // distinct from running the iterate loop out of budget) — used by the epilogue
    // to tell a paused-halt exhaustion apart from a max_turns exhaustion.
    let pausedHalt = false;
    // Set true when an initiative turn is PREEMPTED by a staged human turn at a round
    // boundary. Finalizes as `completed` (work-so-far streamed) with exitReason
    // `preempted_by_human`. False on every non-initiative / non-preempted path.
    let preempted = false;
    let hookStop: string | undefined; // X1: a hook refused a call with interrupt:true (hook_blocked)
    // Provider-NEUTRAL exhaustion signal: set once a round emits tool calls; if the loop
    // runs off the end of the for with this still set, it exhausted maxTurns mid-tool-loop
    // → max_turns. Replaces the old `stopReason === 'tool_use'` check (OpenAI reports
    // `completed` even when it emitted function calls).
    // History: docs/learnings/native-harness-history.md (empty-completion recovery).
    let wantedMoreTools = false;
    // Per-turn empty-completion recovery counter. Bounds the re-call ladder so a model
    // stuck returning empty can't loop; reset on any productive (text or tool) round so
    // transient empties don't accumulate.
    let emptyRecoveryAttempts = 0;
    // Deploy-seam ladder 1: per-turn severed-stream re-issue counter (severed-stream.ts).
    const severedRetry: SeveredRetryState = { reissues: 0 };
    // UNIT B: per-turn latch for reactive compact-on-overflow. A `context_exceeded`
    // round self-heals ONCE per turn (run the manual compaction path, bypassing the
    // 80% gate, then retry); a SECOND overflow is terminal exactly as today.
    let reactiveCompactionAttempted = false;
    // Honest-TTFT observability: what kind of round the NEXT model call serves. Seeded
    // 'fresh' (the turn's first request = the user-perceived TTFT), flips to
    // 'continuation' after each completed round and 'steer' at the steer sites, so the
    // per-round usage event tags its TTFT with its cause. Pure observability.
    let nextRoundKind: RoundKind = 'fresh';
    // Once in-place empty-recovery is EXHAUSTED on the primary model, switch to the
    // configured fallback model for the rest of the turn (a wedged model's escape hatch).
    // Set ONCE → no loop; overrides requestedModel when present, unset → byte-identical.
    // History: docs/learnings/native-harness-history.md (empty-completion recovery).
    let emptyFallbackModel: string | undefined;
    // Set once the per-turn spend ceiling stops the round loop (turn-ceiling-gate.ts).
    let turnCeilingTripped = false;
    // Set once the WALLET CAP stops it — which constraint bound (same module).
    let walletCapTripped: WalletCapSource | null = null;
    let outcome: TurnOutcome;
    // W3-3 parent runaway guard — per-turn closure; mechanics + doc live in
    // parent-runaway.ts. pushDirective reads the LIVE `history` binding.
    const runaway = createParentRunawayGuard({
      taskId: ctx.taskId,
      model: ctx.model,
      pushDirective: async () => {
        if (cfg.journal) await appendInjectedUserEntry(cfg.journal, ctx, SUBAGENT_RUNAWAY_DIRECTIVE, 'engine');
        else transport.pushUser(history, SUBAGENT_RUNAWAY_DIRECTIVE);
      },
    });
    this.runawayTripped = runaway.tripped;

    // The hoisted D1 round accumulators the abort catch reads (native-iterate-turn.ts).
    const st: RoundState = newRoundState(ctx.model, ZERO_USAGE);

    // ── Per-round Nami consult — turn-scoped state ─────────────────────────
    // Active when the product seam (cfg.recall — the NAMI_RETRIEVAL_ENABLED
    // 'server' arm) AND a
    // journal are present (the fence is delivered as a journal entry). The consult +
    // short-circuit/dedupe policy live in turn-decisions.consultRecall; recallState
    // carries the per-turn bounds it mutates in place.
    const recallSeam = cfg.recall && cfg.journal ? cfg.recall : undefined;
    const recallState = newRecallTurnState();

    // The context every round phase reads (native-iterate-round.ts), assembled once
    // per turn. The two harness-private seams are handed over as closures rather than
    // reached off `this` — the same shape compactionDeps already uses.
    const phase: RoundPhaseDeps = {
      ctx, cfg, transport, rc, elision,
      makeCompactionDeps: () => this.compactionDeps(ctx, transport, dispatcher),
      runSignal: (c) => this.runSignal(c),
    };
    // The shared seal, bound to this turn — used by BOTH the round-abort steer path
    // (which continues the turn) and the terminal catch (which ends it).
    const seal = (s: RoundState, blocks: ContentBlock[], userAborted: boolean): Promise<void> =>
      this.sealAbortedRound(cfg, ctx, transport, s, blocks, userAborted);

    try {
      // The whole iterate body is wrapped so NOTHING throws out of run().
      for (let step = 0; step < cfg.maxTurns; step++) {
        // W3-3 — force-complete once the runaway grace is spent (before the
        // iteration bump: no model call happens, so the round doesn't count).
        if (runaway.graceExhausted()) {
          wantedMoreTools = false;
          break;
        }
        // L5 — the owner mirrors the loop's own counters at the one place a round
        // begins: the round count, and the live ledger's reading of this turn's spend.
        // The gates below stay the deciders; the budget is where the verdict is READ.
        if (cfg.budget) {
          cfg.budget.noteRound();
          if (cfg.liveSpend) cfg.budget.observeSpend(cfg.liveSpend.readTurnUsd());
        }
        // PER-TURN SPEND CEILING (2026-08-24 burn) — stop BEFORE the next model
        // call once THIS TURN's live spend reaches it; rationale, the separation
        // from maxBudgetUsd and the resumability contract: turn-ceiling-gate.ts.
        if (turnCeilingReached(cfg)) {
          turnCeilingTripped = true;
          wantedMoreTools = false;
          break;
        }
        // THE WALLET CAP (founder 09-03) — the same head, the same discipline: once
        // THIS TURN's live spend reaches what the balance (or the user's per-task
        // limit) can afford, stop BEFORE the next model call. The turn-head-only
        // reading in openTurn compared $0 against the cap and let a funded-but-thin
        // turn run unbounded (four drills, one 51-step production turn).
        const walletBound = walletCapReached(cfg);
        if (walletBound !== null) {
          walletCapTripped = walletBound;
          wantedMoreTools = false;
          break;
        }
        iterations = step + 1;

        // D1: fresh accumulators per round (they are hoisted for the abort catch).
        st.assistantText = '';
        st.thinkingBlocks = [];
        st.toolUses = [];
        st.roundAppended = false;

        // Round-head auto-compaction (native-iterate-round.ts): journal- and
        // threshold-gated, folds its own cost, and hands back the re-projected
        // history when it fired (the SAME object when it did not).
        history = yield* compactTurnHead(phase, system, wireTools, history);

        // Reset the neutral exhaustion signal each round: it must reflect ONLY
        // the most recent round's tool intent. A clean break (no tool calls)
        // leaves it false; running off the end of the for-loop while the last
        // round wanted tools leaves it true → max_turns.
        wantedMoreTools = false;
        // The rest of the round head (native-iterate-round.ts): the requested model,
        // the adaptive-cache hint, the Nami consult and the armed steer drain.
        const head = await prepareRoundHead(
          phase, recallSeam, recallState, emptyFallbackModel, history, nextRoundKind,
        );
        const { requestedModel, cachePrefixHint } = head;
        history = head.history;
        nextRoundKind = head.nextRoundKind;

        // The per-round core — model call (bounded retry + fallback), the normalized
        // stream drive, the cost fold, the settlement-ordered journal appends, the
        // per-round usage event, and the tool batch — lives in round-engine.runOneRound.
        // `yield*` forwards its events to the K3 sink and evaluates to the round summary;
        // `st` is mutated in place (the abort catch below reads the in-flight round off it).
        let round: RoundResult;
        try {
          round = yield* runOneRound(
            {
              ctx, cfg, transport, rc, harness: this, tools, providerTools: wireTools(), system,
              onPause, onAuthHalt, dispatcher, requestedModel, cachePrefixHint,
              ...(cfg.systemFleetPrefixChars !== undefined ? { systemFleetPrefixChars: cfg.systemFleetPrefixChars } : {}),
              roundKind: nextRoundKind, history, elision, turnBlocks, pendingTodoBlocks,
            },
            st,
          );
        } catch (err) {
          // The round catch (native-iterate-round.ts): round-abort steer, severed
          // re-issue, reactive compact-on-overflow, pill heal. `continue` and `throw`
          // cannot cross the boundary, so it RETURNS the keyword and we execute it.
          const recovered: RoundFailureResult = yield* recoverRoundFailure(
            phase, err, st, turnBlocks, severedRetry, seal,
            reactiveCompactionAttempted, history, nextRoundKind,
          );
          reactiveCompactionAttempted = recovered.reactiveCompactionAttempted;
          if (recovered.stop === 'rethrow') throw err;
          history = recovered.history;
          nextRoundKind = recovered.nextRoundKind;
          continue;
        }
        // The round completed → any FURTHER call in this turn is a tool-loop
        // continuation unless a steer site below re-tags it.
        nextRoundKind = 'continuation';
        // COMPACTION_V2: a round that TRUNCATED on context succeeded at the API level
        // (no throw, so the overflow catch above never sees it) but left a half-written
        // assistant turn the next request would replay — making that request strictly
        // LARGER than the one that just ran out of window. Latch the observation; the
        // round head consumes it behind both staleness guards, force-compacts, and
        // rebuilds the history without the failed message.
        await armOverflowLatchFromRound(rc, cfg.journal, st.stopReason, requestedModel);
        // A truncating round that emitted NO tool calls would end the turn here, so the
        // latch would never reach a round head. Drive ONE more round to spend it — the
        // same per-turn latch that bounds the thrown path bounds this one, so a turn
        // recovers at most once and a context that keeps truncating still terminates.
        // With tool calls present the normal loop already reaches the next round head.
        if (rc.pendingOverflow && st.toolUses.length === 0 && !reactiveCompactionAttempted) {
          reactiveCompactionAttempted = true;
          continue;
        }
        const results = round.results;

        // W3-3 — the ONE runaway settle call site (observe + once-only directive).
        await runaway.settleRound(st.toolUses, results);

        // Provider-NEUTRAL tool-continuation: continue iff the model emitted tool calls,
        // regardless of the provider's stopReason string (OpenAI reports 'completed' even
        // when it emitted function calls, so keying on the Anthropic 'tool_use' string
        // broke the OpenAI port). No tool calls → a genuine completion OR an empty round;
        // an empty round is re-called up to MAX_EMPTY_RECOVERY_ATTEMPTS (never finalized
        // as a blank turn), visible text → break.
        // History: docs/learnings/native-harness-history.md (empty-completion recovery).
        if (st.toolUses.length === 0) {
          // The empty-completion recovery ladder (native-iterate-round.ts): re-call,
          // then ONE switch to the fallback model, then finalize.
          const empty = settleEmptyRound(
            phase, st, requestedModel, emptyRecoveryAttempts, emptyFallbackModel,
          );
          emptyRecoveryAttempts = empty.emptyRecoveryAttempts;
          emptyFallbackModel = empty.emptyFallbackModel;
          if (empty.stop === 'continue') continue;
          break;
        }

        // The model wants tools → it would iterate again if maxTurns allows. Mark
        // the neutral exhaustion signal so the epilogue can detect "ran out of
        // turns while still wanting tools" without inspecting the stopReason string.
        // PR1: a productive (tool-calling) round resets the empty-recovery counter.
        emptyRecoveryAttempts = 0;
        wantedMoreTools = true;

        // The post-tool-batch boundary (native-iterate-round.ts): history re-project,
        // the PostToolBatch hook, the paused-halt break, initiative preemption and the
        // mid-turn steer poll. Every break path clears wantedMoreTools, as inline.
        const boundary = await closeRoundBoundary(phase, prologue, st, results, isInitiative, history, iterations);
        history = boundary.history;
        nextRoundKind = boundary.nextRoundKind;
        pausedHalt = boundary.pausedHalt;
        preempted = boundary.preempted;
        wantedMoreTools = boundary.wantedMoreTools;
        hookStop = boundary.hookStop;
        if (boundary.stop === 'break') break;
      }

      if (hookStop !== undefined) {
        outcome = hookStopOutcome(hookStop); // X1: ends as a stop with the hook's words, never a pause
      } else if (turnCeilingTripped) {
        // Routes AROUND finalizeTurn so the epilogue cannot drive one more model
        // call — the outcome shape and its billing contract: turn-ceiling-gate.ts.
        outcome = buildTurnCeilingOutcome(rc);
      } else if (walletCapTripped !== null) {
        // Same route, the wallet's name on it — a cap that buys one more request
        // is not a cap (turn-ceiling-gate.ts).
        outcome = buildWalletCapOutcome(rc, walletCapTripped);
      } else {
        // EPILOGUE (native-iterate-turn.ts): max_turns vs the transport classifier, the
        // never-blank fallback, and the bounded structured-output epilogue with its
        // additive billing fold.
        const finalized = await finalizeTurn(
          ctx, cfg, transport, rc, st, turnBlocks, elision,
          wantedMoreTools, pausedHalt, iterations, turnStart, history,
          (f, c, cx, tr, h, cost, el) => this.applyStructuredOutputEpilogue(f, c, cx, tr, h, cost, el, system),
        );
        outcome = finalized.outcome;
        history = finalized.history;
      }
    } catch (err) {
      // never-throw (native-iterate-turn.ts): classify the terminal error, log the RAW
      // provider string, seal the in-flight round and fsync the heal.
      outcome = await settleTerminalError(cfg, transport, st, turnBlocks, err, seal);
    }

    // The out-param write-back run() reads this turn off (native-iterate-turn.ts).
    writeIterationResult(out, outcome, turnBlocks, st, rc, pausedHalt, preempted, turnCeilingTripped, walletCapTripped !== null);
  }

  /**
   * Seal an ABORTED round so the journal + turn blocks stay replay-safe: append the
   * in-flight round's partial assistant text/thinking (guard double-append via
   * `roundAppended`); mark any dispatched-but-unfinished tool card 'interrupted' (scoped
   * to a real user abort); heal orphaned tool_use entries (the provider requires every
   * tool_use to have a tool_result). Shared by the terminal abort catch and the
   * round-abort steer path — one seal discipline, no drift.
   * History: docs/learnings/native-harness-history.md (Steer & abort → D1/D3/D4 seal).
   */
  private async sealAbortedRound(
    cfg: NativeConfig,
    ctx: HarnessContext<NativeConfig>,
    transport: Transport,
    st: RoundState,
    turnBlocks: ContentBlock[],
    userAborted: boolean,
  ): Promise<void> {
    if (cfg.journal && !st.roundAppended && (st.assistantText || st.thinkingBlocks.length > 0)) {
      const sealBlocks: ContentBlock[] = [
        ...st.thinkingBlocks,
        ...(st.assistantText ? [{ type: 'text', text: st.assistantText } as ContentBlock] : []),
      ];
      turnBlocks.push(...sealBlocks);
      await appendAssistantEntry(cfg.journal, ctx, sealBlocks, st.lastUsageModel, transport.api, transport.provider);
    }
    if (userAborted) {
      for (const b of turnBlocks) {
        if (b.type === 'tool_use' && (b as { status?: string }).status === 'running') {
          (b as unknown as Record<string, unknown>).status = 'interrupted';
        }
      }
    }
    await healOnError(cfg.journal, userAborted); // heal-on-error.ts: a failed heal is an integrity event, never a silent catch
  }

  // ── Auto-compaction ──────────────────────────────────────────────────────────
  //
  // The BODY (trigger, plan, splice, summarize) lives in compaction-run.ts — the
  // loop file only ratchets DOWN (R3), and the compaction body had grown to a
  // third of it. This is the only seam left here: the two harness-private helpers
  // the body needs, handed over explicitly instead of captured off `this`.
  private compactionDeps(
    ctx: HarnessContext<NativeConfig>,
    transport: Transport,
    dispatcher: HookDispatcher,
  ): CompactionDeps {
    return {
      ctx,
      transport,
      dispatcher,
      compactionBase: (c) => this.compactionBase(c),
      runSignal: (c) => this.runSignal(c),
    };
  }

  /**
   * `/compact` — force an immediate MANUAL compaction of the current (idle) conversation,
   * BYPASSING the auto trigger's 80% threshold. Shares runCompaction with the auto path
   * but with `trigger:'manual'` and a keep-window sized to the most recent turn (so a
   * short conversation still has something to cut). Never-throw (the caller is a control
   * command): no journal/config, nothing to cut, a summary no smaller than its span, an
   * aborted or failed summarize, or ANY other throw → null, recorded BY NAME. Caller emits.
   * History: docs/learnings/native-harness-history.md (Compaction → manual keep-window).
   */
  async compactNow(
    ctx: HarnessContext<NativeConfig>,
    cfg: NativeConfig,
    transport: Transport,
  ): Promise<CompactionResult | null> {
    const journal = cfg.journal;
    // Journal-gated AND config-gated: a manual compact needs a journal to splice
    // and a compaction config (an explicit opt-in to the K4 compactor on this arm).
    if (!journal || !cfg.compaction) return null;

    // Build a per-call HookDispatcher mirroring buildPrologue's (the security floor
    // first, then the registered B5 callbacks) so PreCompact/PostCompact observers
    // fire on the manual path too. We do NOT build the tool list or fire onAttached
    // here — compaction needs neither, and the control handler owns AGENT_START/END.
    const dispatcher = createNativeHookDispatcher(this, cfg.emitHookEvent, { workingDir: cfg.workingDir, taskId: ctx.taskId });
    cfg.registerHooks?.(dispatcher);

    const deps = this.compactionDeps(ctx, transport, dispatcher);
    try {
      return await runManualCompaction(deps);
    } catch (err) {
      // Every refusal degrades to null (the caller notices) and is recorded BY NAME.
      if (cfg.signal?.aborted) throw err; // an abort still routes to user_aborted upstream
      await recordManualCompactionFailure(deps, err);
      return null;
    }
  }


  /**
   * The bounded structured-output epilogue. After a CLEAN completion, make ONE terminal
   * model call WITH `outputFormat` (constrained decoding, NO tools) and validate its text.
   * Success → set `structuredOutput`; a validation failure appends the error as a synthetic
   * user turn and REGENERATES up to `maxStructuredOutputRetries` (default 2); exhaustion →
   * `max_structured_output_retries`. Preflight rejects a non-constrainable schema before any
   * provider call. Every constrained call is priced once (no double-bill); single turn_end.
   * History: docs/learnings/native-harness-history.md (structured-output epilogue).
   * Pinned by: structured-output-epilogue.refusal.test.ts, .strict-preflight.test.ts.
   */
  private async applyStructuredOutputEpilogue(
    format: OutputFormat,
    completed: Extract<TurnOutcome, { kind: 'completed' }>,
    ctx: HarnessContext<NativeConfig>,
    transport: Transport,
    historyIn: ProviderHistory,
    cumulativeCostUsdIn: number,
    elision: FrozenElision | null,
    system: string, // the prologue's, so the epilogue shares the rounds' prompt (and cache)
  ): Promise<{ outcome: TurnOutcome; cumulativeCostUsd: number; history: ProviderHistory; usage: NormalizedUsage; model: string }> {
    const cfg = ctx.config;
    const maxRetries = cfg.maxStructuredOutputRetries ?? 2;
    let history = historyIn;
    let cumulativeCostUsd = cumulativeCostUsdIn;
    // The epilogue's TOTAL model work (summed across constrained attempts), returned so
    // the caller journals ONE source:'epilogue' usage entry. Stays ZERO on a fail-closed
    // preflight → the caller emits nothing (guarded on a positive fold delta).
    let epilogueUsage: NormalizedUsage = { ...ZERO_USAGE };
    const epilogueModel = ctx.model || transport.defaultModel();

    // PREFLIGHT — a schema outside the constrainable subset must NEVER be forwarded
    // to a provider (validateOutputValue does NOT re-check subset validity). Fail
    // closed WITHOUT a constrained call so we never bill a doomed request.
    const subset = validateOutputSchema(format.schema);
    if (!subset.ok) {
      return {
        outcome: {
          kind: 'max_structured_output_retries',
          raw: { subtype: 'max_structured_output_retries', errors: subset.errors },
        },
        cumulativeCostUsd,
        history,
        usage: epilogueUsage,
        model: epilogueModel,
      };
    }

    // Provider-aware STRICT preflight: the terminal constrained call sends strict:true, on
    // which OpenAI 400s a non-strict schema that Claude tolerates. Gate on the PROVIDER
    // VALUE of the model THIS epilogue will call so the Anthropic path is byte-identical.
    // Fail closed BEFORE the loop → the doomed request makes ZERO provider call.
    // History: docs/learnings/native-harness-history.md (structured-output epilogue).
    const provider = resolveCapabilities(ctx.model || transport.defaultModel()).provider;
    const strictFail = openaiStrictPreflightFailure(provider, format.schema);
    if (strictFail) {
      return { outcome: strictFail, cumulativeCostUsd, history, usage: epilogueUsage, model: epilogueModel };
    }

    let lastError = 'no structured output produced';

    // attempt 0 = the initial constrained call; up to `maxRetries` further attempts.
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // ONE dedicated terminal constrained call: the schema rides ONLY this call
      // (cache-bust once); no tools so the model can only answer.
      const requestedModel = ctx.model || transport.defaultModel();
      const stream = transport.callModel({
        model: requestedModel,
        maxTokens: resolveCapabilities(requestedModel).maxOutputTokens,
        system,
        ...(cfg.systemFleetPrefixChars !== undefined ? { systemFleetPrefixChars: cfg.systemFleetPrefixChars } : {}),
        tools: [], history,
        outputFormat: format,
        // exactOptionalPropertyTypes (SDK): omit `signal` when undefined.
        ...(cfg.signal !== undefined && { signal: cfg.signal }),
        // OpenAI prompt-cache: the terminal constrained call is a BILLED main turn
        // → share its cache route with the loop rounds above (the SAME
        // user+model anchor, via the shared helper — see mainRunCacheKey).
        // Anthropic ignores it → byte-identical there.
        cacheKey: mainRunCacheKey(ctx.config.runtimeConfig, ctx.taskId, requestedModel),
      });

      let text = '';
      let usage: NormalizedUsage = { ...ZERO_USAGE };
      let stopReason: string | null = null;
      for await (const ev of transport.readStream(stream)) {
        if (ev.kind === 'text') text += ev.text;
        else if (ev.kind === 'done') {
          usage = ev.usage;
          stopReason = ev.stopReason;
        }
      }
      // Bill this constrained call ONCE — folded into the run's cumulative so the single
      // turn_end carries it (the server dedups delta billing). Price with `requestedModel`
      // so a fallback path can't attribute the epilogue's cost to the wrong model.
      const epilogueCostUsd = transport.computeCostUsd(usage, requestedModel);
      cumulativeCostUsd += epilogueCostUsd;
      // Same money, seen live (live-spend.ts): the epilogue can retry, so each attempt folds as priced.
      foldModelSpend(ctx.config.liveSpend, transport, epilogueCostUsd, requestedModel);
      // P2.1 (Task 4): sum this constrained attempt into the epilogue's usage total.
      epilogueUsage = {
        inputTokens: epilogueUsage.inputTokens + usage.inputTokens,
        outputTokens: epilogueUsage.outputTokens + usage.outputTokens,
      };

      // SHORT-CIRCUIT a genuine refusal BEFORE the parse loop: retrying a refusal just
      // re-bills the same doomed call and mis-reports it. Surface a refused outcome instead.
      // Refusal-ONLY (not bare emptiness) so the retry paths are untouched for every arm.
      // Pinned by: structured-output-epilogue.refusal.test.ts.
      const refused = epilogueRefusalShortCircuit(stopReason, text);
      if (refused) {
        return { outcome: refused, cumulativeCostUsd, history, usage: epilogueUsage, model: epilogueModel };
      }

      // Validate: parse the JSON text, then check the value against the schema.
      let parsed: unknown;
      try {
        parsed = JSON.parse(text.trim());
      } catch {
        lastError = `Output was not valid JSON: ${text.slice(0, 200)}`;
        if (attempt < maxRetries) {
          await this.appendStructuredOutputError(cfg, ctx, transport, history, lastError);
          history = cfg.journal
            ? transport.historyFromJournal(wireMessages((await cfg.journal.project()).messages, elision))
            : history;
        }
        continue;
      }
      const verdict = validateOutputValue(parsed, format.schema);
      if (verdict.ok) {
        // Success: ride the validated object out ON the completed outcome.
        return {
          outcome: { ...completed, structuredOutput: parsed },
          cumulativeCostUsd,
          history,
          usage: epilogueUsage,
          model: epilogueModel,
        };
      }
      lastError = verdict.errors.join('; ');
      if (attempt < maxRetries) {
        await this.appendStructuredOutputError(cfg, ctx, transport, history, lastError);
        history = cfg.journal
          ? transport.historyFromJournal(wireMessages((await cfg.journal.project()).messages, elision))
          : history;
      }
    }

    // Exhausted the bounded loop → reuse the existing failure kind (terminal-reason
    // surfaced via K6-P4). Never emit a partial/invalid object as the answer.
    return {
      outcome: {
        kind: 'max_structured_output_retries',
        raw: { subtype: 'max_structured_output_retries', errors: [lastError] },
      },
      cumulativeCostUsd,
      history,
      usage: epilogueUsage,
      model: epilogueModel,
    };
  }

  /**
   * Append a validation error as a synthetic user turn so the NEXT constrained call sees
   * it (the feed-the-error-back step). Journal path appends a user entry; in-memory path
   * pushes it onto the provider history.
   */
  private async appendStructuredOutputError(
    cfg: NativeConfig,
    ctx: HarnessContext<NativeConfig>,
    transport: Transport,
    history: ProviderHistory,
    error: string,
  ): Promise<void> {
    const feedback = structuredOutputRetryText(error);
    if (cfg.journal) {
      await appendInjectedUserEntry(cfg.journal, ctx, feedback, 'engine');
    } else {
      transport.pushUser(history, feedback);
    }
  }

  /** The common JournalEntry fields for compaction appends (mirror native-journal base). */
  private compactionBase(ctx: HarnessContext<NativeConfig>): Omit<NewEntry, 'payload'> {
    return {
      taskId: ctx.taskId,
      rootTaskId: ctx.taskId,
      spawnDepth: 0,
      workspaceId: ctx.config.runtimeConfig?.userId || 'sandbox',
      agentId: 'native',
      principal: { kind: 'agent', agentId: 'native' },
      timestamp: '',
    };
  }

  // ── Public contract methods ─────────────────────────────────────────────────

  async gateTool(call: ToolCall): Promise<GateResult> {
    // W3-3 parent runaway guard — post-trip, EVERY gate is refused with the
    // terminal directive (subagent-runner's guardedHarness discipline). Checked
    // FIRST so a tripped turn's grace rounds can never execute another tool.
    if (this.runawayTripped?.() === true) return { decision: 'deny', message: SUBAGENT_RUNAWAY_DIRECTIVE };
    // The gate ladder (stop-gate → mode → security → capability → composio-classifier)
    // lives in the host NativePolicyPort (ports/policy-port.impl.ts) in EXACTLY ONE place;
    // the engine delegates to the injected `cfg.policy` (the thin PolicyGateContext carries
    // only taskId; the impl re-derives mode/rules/cwd/toolkits/capabilities). Falls back to
    // AllowAllPolicyPort only when no policy is configured (never hit in prod/tests).
    // History: docs/learnings/native-harness-history.md (Miscellaneous → ring 4c.6).
    return (this.runConfig?.policy ?? new AllowAllPolicyPort()).gate(call, {
      taskId: this.ctxTaskId,
      isTaskStopping: false,
      connectedApps: new Set(),
      grantedCapabilities: new Set(),
    });
  }

  classifyTermination(raw: unknown): TurnOutcome {
    // Delegate to the active ModelPort's error classifier (covers errors, abort,
    // clean stops). Defaults to Anthropic before run() sets the run's transport.
    return this.transport.classifyError(raw);
  }
}

