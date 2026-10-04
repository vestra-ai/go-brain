// packages/agent-sdk/src/engine/native-iterate-turn.ts
//
// The TURN-level phases of NativeHarness.iterateTurn, lifted verbatim out of the
// 570-line method — the work that happens once per iterate-turn, on either side of
// the round loop. The per-ROUND phases inside that loop live next door in
// native-iterate-round.ts; round WORK (model call, stream, cost fold, tool batch)
// lives in round-engine.ts. Three layers, three files, one job each.
//
// The phases in turn order:
//
//   openIterateTurn      freeze the elision, seat the provider history, emit the
//                        per-turn context-usage snapshot.
//   newRoundState        the hoisted D1 round accumulators the abort catch reads.
//   finalizeTurn         the epilogue — max_turns vs classifier, the blank-turn
//                        fallback, and the bounded structured-output epilogue.
//   settleTerminalError  the never-throw terminal catch — classify, log, seal, fsync.
//   writeIterationResult the out-param write-back run() reads the turn off.
//
// WHAT IS NOT VERBATIM, declared at each site: `this.` is gone — the harness-private
// helpers (`buildContextUsageSnapshot`, `applyStructuredOutputEpilogue`,
// `sealAbortedRound`) arrive as explicit closures, the same way `compactionDeps`
// already hands `compactionBase`/`runSignal` to the compaction body. Every phase that
// used to assign a loop variable declares a LOCAL WITH THE SAME NAME, seeded from a
// parameter and returned, so the assignment lines themselves never changed.
//
// No module-scope mutable state (R2's rule): every phase takes the state it touches
// as an argument, so two sessions sharing this process never share a byte of it.

import type { HarnessContext } from '../contract/harness.js';
import type { HarnessEvent, ContextUsageSnapshot } from '../contract/events.js';
import type { ContentBlock } from '../contract/blocks.js';
import type { OutputFormat } from '../contract/output-format.js';
import type { TurnOutcome } from '../contract/turn-outcome.js';
import type { NativeConfig } from './native-config.js';
import type { RunContext } from './run-context.js';
import type { RoundState } from './round-engine.js';
import type { TurnIterationResult } from './turn-iteration-result.js';
import type { FrozenElision } from './context-elision.js';
import type {
  NormalizedUsage,
  ProviderHistory,
  ProviderTool,
  Transport,
} from './transport.js';
import { prepareElision, wireMessages } from './context-elision.js';
import { classifyTerminalAbort } from './turn-decisions.js';
import { appendUsageEntry } from './native-journal.js';
import { EMPTY_RESPONSE_FALLBACK_TEXT, isRecoverableEmptyStop } from './empty-recovery.js';

/** Join the text blocks of a turn into a single summary string. */
export function summarize(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/**
 * The turn's answer: the text of its last round that produced text (each round lays down its words as one text
 * block, round-stream.ts), what the person reads as the reply. summarize() joins every round's narration onto it
 * with no separator. Null when no round produced text.
 */
export function finalAnswer(blocks: ContentBlock[]): string | null {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i]!;
    if (block.type === 'text' && block.text.trim()) return block.text;
  }
  return null;
}

/** What the turn open seated: the frozen elision and the history the loop drives. */
export interface IterateTurnOpen {
  elision: FrozenElision | null;
  history: ProviderHistory;
}

/**
 * Open the iterate-turn: freeze this turn's elision, seat the provider history from
 * whichever source owns it, and emit the one context-usage snapshot per user turn.
 *
 * `buildContextUsageSnapshot` is the harness-private builder, passed in rather than
 * reached off `this`.
 */
export async function* openIterateTurn(
  ctx: HarnessContext<NativeConfig>,
  cfg: NativeConfig,
  transport: Transport,
  rc: RunContext,
  system: string,
  wireTools: () => ProviderTool[],
  inMemoryHistory: ProviderHistory,
  buildContextUsageSnapshot: (
    ctx: HarnessContext<NativeConfig>,
    cfg: NativeConfig,
    system: string,
    providerTools: ProviderTool[],
    history: ProviderHistory,
    elision: FrozenElision | null,
  ) => Promise<ContextUsageSnapshot | null>,
): AsyncGenerator<HarnessEvent, IterateTurnOpen> {
  // The provider history for the iterate loop. Journal path: re-project from the
  // journal after each tool batch (durable, survives recycles). In-memory path:
  // the persistent ProviderHistory threaded from run() (mutated in place by the
  // transport's pushAssistant/pushToolResult — both the working AND persistent copy).
  // CONTEXT_ELISION_V1 — decided ONCE per turn, frozen; wire AND ledger share it.
  const elision = await prepareElision(ctx, cfg, rc);

  const history: ProviderHistory = cfg.journal
    ? transport.historyFromJournal(wireMessages((await cfg.journal.project()).messages, elision))
    : inMemoryHistory;

  // ── Native context-meter parity ──────────────────────────────────────────
  // Yield ONE context_usage snapshot per user turn (before the round loop) so native
  // runs get the same context-fullness meter the Claude arm emits. The engine never
  // touches sockets — it yields a HarnessEvent the core sink maps onto
  // AGENT_CONTEXT_USAGE. Best-effort: a failure never aborts the turn.
  // History: docs/learnings/native-harness-history.md (Context-usage meter).
  const usageSnapshot = await buildContextUsageSnapshot(ctx, cfg, system, wireTools(), history, elision);
  if (usageSnapshot) yield { kind: 'context_usage', snapshot: usageSnapshot };
  return { elision, history };
}

/**
 * Round accumulators HOISTED onto a RoundState (mutated in place by runOneRound) so
 * the abort catch can read the IN-FLIGHT round. A clean round appends and sets
 * `roundAppended`; the catch appends only text/thinking the clean append never
 * reached (mid-stream abort). stopReason/lastUsage/lastUsageModel ride the same state.
 * History: docs/learnings/native-harness-history.md (Steer & abort → D1).
 */
export function newRoundState(model: string, zeroUsage: NormalizedUsage): RoundState {
  return {
    assistantText: '',
    thinkingBlocks: [],
    toolUses: [],
    roundAppended: false,
    inToolBatch: false,
    stopReason: null,
    lastUsage: { ...zeroUsage },
    lastUsageModel: model,
  };
}

/** The epilogue's result: the classified outcome and the (possibly extended) history. */
export interface FinalizedTurn {
  outcome: TurnOutcome;
  history: ProviderHistory;
}

/** The harness-private structured-output epilogue, handed over as a closure. */
export type ApplyStructuredOutputEpilogue = (
  format: OutputFormat,
  completed: Extract<TurnOutcome, { kind: 'completed' }>,
  ctx: HarnessContext<NativeConfig>,
  transport: Transport,
  historyIn: ProviderHistory,
  cumulativeCostUsdIn: number,
  elision: FrozenElision | null,
) => Promise<{
  outcome: TurnOutcome;
  cumulativeCostUsd: number;
  history: ProviderHistory;
  usage: NormalizedUsage;
  model: string;
}>;

/**
 * EPILOGUE: classify the terminal outcome, then run the bounded structured-output
 * epilogue when a schema was requested and the turn cleanly completed.
 */
export async function finalizeTurn(
  ctx: HarnessContext<NativeConfig>,
  cfg: NativeConfig,
  transport: Transport,
  rc: RunContext,
  st: RoundState,
  turnBlocks: ContentBlock[],
  elision: FrozenElision | null,
  wantedMoreTools: boolean,
  pausedHalt: boolean,
  iterations: number,
  turnStart: number,
  historyIn: ProviderHistory,
  applyStructuredOutputEpilogue: ApplyStructuredOutputEpilogue,
): Promise<FinalizedTurn> {
  let history = historyIn;
  let outcome: TurnOutcome;
  // EPILOGUE: classify the terminal outcome.
  // If the loop fell through still WANTING tools without a pause-for-human halt, it
  // exhausted cfg.maxTurns mid-tool-loop → max_turns (recoverable), not completed.
  // PROVIDER-NEUTRAL: gate on `wantedMoreTools`, not `stopReason === 'tool_use'`
  // (OpenAI reports 'completed' even while wanting tools). A paused-halt clears
  // wantedMoreTools and falls through to the classifier.
  if (wantedMoreTools && !pausedHalt) {
    outcome = {
      kind: 'max_turns',
      numTurns: iterations,
      raw: { subtype: 'max_turns', errors: [] },
    };
  } else {
    // The answer is read before the fallback below: an empty turn's fallback line is not an answer (null).
    const answer = finalAnswer(turnBlocks);
    // Never finalize a SILENT blank turn: if the turn produced no visible text,
    // surface a short fallback so the assistant bubble is never empty. Guarded OFF for
    // a paused-halt (legitimately text-free) and when a structured-output epilogue
    // will produce the terminal text itself.
    if (
      !pausedHalt &&
      !cfg.outputFormat &&
      isRecoverableEmptyStop(st.stopReason) &&
      summarize(turnBlocks).trim() === ''
    ) {
      turnBlocks.push({ type: 'text', text: EMPTY_RESPONSE_FALLBACK_TEXT });
    }
    outcome = transport.classifyTermination({
      stopReason: st.stopReason,
      costUsd: rc.billing.cumulativeCostUsd,
      numTurns: iterations,
      durationMs: Date.now() - turnStart,
      modelUsage: transport.buildModelUsage(st.lastUsage, st.lastUsageModel),
      summaryText: summarize(turnBlocks),
    });
    if (outcome.kind === 'completed') outcome = { ...outcome, answer };
  }

  // ── Bounded structured-output epilogue ───────────────────────────────
  // ONLY when a schema was requested AND the turn cleanly completed: one dedicated
  // constrained terminal call (cache-bust once) wrapped in a bounded
  // validate→feed-error-back loop. Retries accumulate into cumulativeCostUsd (single
  // turn_end, no double-bill). Absent outputFormat / non-completed → no-op → byte-id.
  // History: docs/learnings/native-harness-history.md (structured-output epilogue).
  if (cfg.outputFormat && outcome.kind === 'completed') {
    // Accumulator invariant: snapshot cumulative BEFORE the await, then apply the
    // epilogue's own increment (E = epilogue.cumulative − snapshot) ADDITIVELY to both
    // accumulators. The previous overwrite was byte-identical today but would CLOBBER a
    // future concurrent fold during the epilogue await; additive folds preserve it.
    // History: docs/learnings/native-harness-history.md (Billing → epilogue invariant).
    const preEpilogueCumulative = rc.billing.cumulativeCostUsd;
    const epilogue = await applyStructuredOutputEpilogue(
      cfg.outputFormat,
      outcome,
      ctx,
      transport,
      history,
      rc.billing.cumulativeCostUsd,
      elision,
    );
    outcome = epilogue.outcome;
    const epilogueDeltaUsd = epilogue.cumulativeCostUsd - preEpilogueCumulative;
    // The constrained terminal call(s) are the PARENT's own model work.
    rc.billing.parentOwnCostUsd += epilogueDeltaUsd;
    rc.billing.cumulativeCostUsd += epilogueDeltaUsd;
    // Journal the epilogue's constrained model work as ONE usage entry — only when a
    // call was made. A fail-closed preflight folds nothing (delta 0), so a positive
    // delta is the "a billed call happened" gate.
    if (epilogueDeltaUsd > 0) {
      await appendUsageEntry(cfg.journal, ctx, {
        costUsd: epilogueDeltaUsd,
        model: epilogue.model,
        source: 'epilogue',
        inputTokens: epilogue.usage.inputTokens,
        outputTokens: epilogue.usage.outputTokens,
      });
    }
    history = epilogue.history;
  }
  return { outcome, history };
}

/**
 * never-throw: an abort is a CLEAN stop (user_aborted + streaming/tools phase); any
 * other throw maps onto the shared taxonomy (classifyError) so errors get the same
 * Retry UX as the other arms. `sealAbortedRound` is the harness-private seal, passed
 * in — it is shared with the round-abort steer path, which seals the same way but
 * CONTINUES the turn.
 */
export async function settleTerminalError(
  cfg: NativeConfig,
  transport: Transport,
  st: RoundState,
  turnBlocks: ContentBlock[],
  err: unknown,
  sealAbortedRound: (st: RoundState, turnBlocks: ContentBlock[], userAborted: boolean) => Promise<void>,
): Promise<TurnOutcome> {
  // never-throw: an abort is a CLEAN stop (user_aborted + streaming/tools
  // phase); any other throw maps onto the shared taxonomy (classifyError) so
  // errors get the same Retry UX as the other arms. The classification +
  // userAborted decision lives in turn-decisions.classifyTerminalAbort.
  const terminal = classifyTerminalAbort({
    err,
    signalAborted: cfg.signal?.aborted,
    inToolBatch: st.inToolBatch,
    classifyError: (e) => transport.classifyError(e),
  });
  const outcome = terminal.outcome;
  // Observability: a non-abort terminal error is sanitized downstream to a generic
  // label and the DB stores only that — the RAW provider error string (the one that
  // says WHY) is dropped, leaving every model_error a black box. This is the one place
  // that still holds it, so log it (a recurrence is diagnosable from sandbox stdout).
  // History: docs/learnings/native-harness-history.md (Steer & abort → model_error).
  if (outcome.kind !== 'user_aborted') {
    console.warn(
      `[NativeHarness] terminal error kind=${outcome.kind} provider=${transport.provider} api=${transport.api}:`,
      err,
    );
  }
  // Seal via sealAbortedRound (shared with the round-abort steer path, which seals the
  // same way but CONTINUES the turn). `userAborted` scopes the seal: only a genuine
  // user-abort seals with "Interrupted by user."; a non-abort crash heals with a
  // neutral empty-blocks result. History: docs/learnings/native-harness-history.md.
  await sealAbortedRound(st, turnBlocks, terminal.userAborted);
  // Durability barrier: heal appends go through the Journal serialized tail-chain,
  // then fsync forces the sealed bytes to disk so a recycle/power-loss after the
  // interrupt cannot lose the seal (single-writer → no concurrent race). Best-effort.
  await cfg.journal?.fsync();
  return outcome;
}

/**
 * Write the turn's terminal state into run()'s out-param. Every field is set on every
 * path (success, error, abort) — see TurnIterationResult.
 */
export function writeIterationResult(
  out: TurnIterationResult,
  outcome: TurnOutcome,
  turnBlocks: ContentBlock[],
  st: RoundState,
  rc: RunContext,
  pausedHalt: boolean,
  preempted: boolean,
  turnCeilingTripped: boolean,
  walletCapTripped = false,
): void {
  out.outcome = outcome;
  out.blocks = turnBlocks;
  out.stopReason = st.stopReason;
  out.cumulativeCostUsd = rc.billing.cumulativeCostUsd;
  // Agent v2 (Task 4): the parent-own accumulator AFTER this iterate-turn, threaded
  // back to run() (mirror of cumulativeCostUsd). Set on every path (try + catch).
  out.parentOwnCostUsd = rc.billing.parentOwnCostUsd;
  out.lastUsage = st.lastUsage;
  out.lastUsageModel = st.lastUsageModel;
  // K6-P2 B3: surface whether this turn ended on a pause-for-human so run()'s
  // Stop re-feed never injects a synthetic turn between a paused tool_use and
  // its resolution. The catch path leaves `pausedHalt` false (an error/abort is
  // not a pause). Defaults false on the success path (set true only by the
  // results.some(r => r.pausedHalt) break above).
  out.pausedHalt = pausedHalt;
  // P4 Task 3 — surface the preemption exitReason to run()'s terminal turn_end. Set
  // ONLY when preempted (leaving the field ABSENT otherwise, per exactOptionalPropertyTypes)
  // → run() uses the default stop() reason for every non-preempted turn (byte-identical).
  if (preempted) out.exitReason = 'preempted_by_human';
  // The per-turn spend ceiling's exitReason. Mutually exclusive with preemption
  // (each breaks the round loop outright), and left ABSENT otherwise → every other
  // turn keeps the default `stop(${stopReason})` (byte-identical).
  if (turnCeilingTripped) out.exitReason = 'turn_spend_ceiling';
  // The wallet cap's exitReason — the same name the turn-head gate yields
  // (native-run-turn.ts), so the driver finalizes both trips identically.
  if (walletCapTripped) out.exitReason = 'max_budget';
}
