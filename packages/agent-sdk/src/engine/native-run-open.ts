// packages/agent-sdk/src/engine/native-run-open.ts
//
// run()'s OPEN phase — everything between "the transport is valid" and the first
// user turn. Lifted verbatim out of NativeHarness.run (which was 594 lines) so the
// method reads as the loop it actually is.
//
// It stays an async generator for one reason: the prologue never-throw guard YIELDS
// a classified terminal turn_end and then abandons the run. `yield*` in the caller
// forwards that event, and the `null` return is the caller's signal to return —
// which is exactly what the old inline `return;` did.
//
// No module-scope mutable state (R2's rule, honoured here even though that lint
// only scans apps/server/src/services): every value this phase owns is created per
// call and handed back to the caller, so two sessions in one process never share it.

import type { HarnessContext, ToolCall, UserTurn } from '../contract/harness.js';
import type { HarnessEvent } from '../contract/events.js';
import type { ContentBlock, ImageBlock, MediaBlock } from '../contract/blocks.js';
import type { NativeConfig } from './native-config.js';
import type { Transport, ProviderHistory, ProviderTool } from './transport.js';
import type { RawToolOptions, OnAuthHalt } from '../tools/tool-types.js';
import type { HookDispatcher } from '../kernel/index.js';
import type { SideCallResult } from './offloop-usage.js';
import { createRunContext, type RunContext } from './run-context.js';
import { appendInstructionSnapshot } from './native-journal.js';
import { dispatchLifecycle, buildSessionStartInput, continueContext } from './native-hooks.js';
import { sessionStartSource } from './hook-parity.js';
import type { JournalEntry } from '../contract/journal.js';
import { holdSession } from './context-append.js';
import { memorySpan } from '../contract/instruction-stack.js';

/**
 * What `buildPrologue` assembles once per run. Named here (it was an inline return
 * type on the method) so the extracted phases can be typed without importing the
 * class back — that import would close a runtime cycle.
 */
export type RunPrologue = {
  tools: RawToolOptions[];
  onAuthHalt: OnAuthHalt;
  wireTools: () => ProviderTool[]; // read at USE: grows mid-turn (ToolSearchSession)
  system: string;
  /** TOOL_DEFER_WIDE_V1's index as appended to `system` ('' or absent when none); CONTEXT_APPEND_V1 freezes it. */
  toolIndex?: string;
  onPause: (call: ToolCall, kind: string) => Promise<string>;
  dispatcher: HookDispatcher;
  /** VIDEO_UNDERSTANDING_V1 — `watch` describe-spend records, drained by the epilogue. */
  mediaRecords: SideCallResult[];
};

/** The two instance methods this phase reaches for, passed in rather than imported. */
export type RunOpenDeps = {
  buildPrologue: (
    ctx: HarnessContext<NativeConfig>,
    transport: Transport,
    onTodos: (todos: import('../ports/index.js').TodoSnapshot) => void,
  ) => Promise<RunPrologue>;
  runSignal: (ctx: HarnessContext<NativeConfig>) => AbortSignal;
};

/** Everything the user-turn loop needs, created once per run. */
export type RunOpenState = {
  pendingTodoBlocks: ContentBlock[];
  prologue: RunPrologue;
  inMemoryHistory: ProviderHistory;
  rc: RunContext;
  seedChildUsagePending: boolean;
  stagedTexts: string[];
  stagedImages: ImageBlock[];
  stagedMedia: MediaBlock[];
  ambientSpentUsd: number;
};

/**
 * Open the run. Yields at most ONE event (the prologue-error terminal turn_end) and
 * returns `null` in that case — the caller must return. Otherwise returns the state
 * the loop owns.
 */
export async function* openRun(
  ctx: HarnessContext<NativeConfig>,
  transport: Transport,
  deps: RunOpenDeps,
): AsyncGenerator<HarnessEvent, RunOpenState | null> {
  // The native Todo* tools run execute() synchronously inside dispatchTool (a context
  // that can't yield). They push a todo block onto this buffer via onTodos; iterateTurn
  // drains it after each tool dispatch and yields it for the CORE sink → AGENT_TODO.
  const pendingTodoBlocks: ContentBlock[] = [];
  const onTodos = (todos: import('../ports/index.js').TodoSnapshot): void => {
    pendingTodoBlocks.push({ type: 'todo', todos } as ContentBlock);
  };

  // Prologue never-throw guard: the prologue runs BEFORE the first turn; an
  // unguarded throw would reject run() → no terminal turn_end → AGENT_END never fires
  // → UI hang. Wrap it so a throw becomes EXACTLY ONE classified terminal turn_end
  // (cumulative 0, but billing still REQUIRED on the event — the core bills off it).
  // History: docs/learnings/native-harness-history.md (Miscellaneous → BUG-2).
  let prologue: RunPrologue;
  try {
    prologue = await deps.buildPrologue(ctx, transport, onTodos);
  } catch (err) {
    ctx.config.budget?.end('prologue_error');
    yield {
      kind: 'turn_end',
      outcome: transport.classifyError(err),
      blocks: [],
      // Terminal: never 'tool_use' (Bug 1 invariant) so the driver finalizes.
      stopReason: 'end_turn',
      exitReason: 'prologue_error',
      billing: { cumulativeCostUsd: 0, modelUsage: {} },
    };
    return null;
  }

  // Engines T5 — the host's one call per run open (NativeConfig.beforeFirstTurn), after the prologue
  // and before the round-counter seed: what the host appends is part of what the first turn sees.
  // Guarded like the prologue: a throw here would reject run() with no terminal turn_end (a hung
  // turn), so a failing host seam costs what it would have added, never the run.
  if (ctx.config.journal && ctx.config.beforeFirstTurn) {
    try {
      await ctx.config.beforeFirstTurn(ctx.config.journal, ctx);
    } catch (err) {
      console.warn(`[NativeHarness] beforeFirstTurn failed — the run continues without it: ${String(err)}`);
    }
  }

  // IN-MEMORY history fallback (used when cfg.journal is absent). The transport
  // owns the concrete history shape; the loop treats it as opaque. When
  // cfg.journal IS present, historyFromJournal projects from the journal instead.
  const inMemoryHistory: ProviderHistory = transport.emptyHistory();
  // RunContext — the ONE owner of this run's billing state (cumulative, parentOwn,
  // childUsage, roundCounter). createRunContext seeds cumulative from initialCostUsd
  // (cost incurred BEFORE this run — the continue-path re_execute replay) so the
  // terminal turn_end bills it exactly once; defaults to 0 → cold/warm byte-identical.
  // History: docs/learnings/native-harness-history.md (Billing → P1 / native-redrive).
  const rc = createRunContext(ctx.taskId, ctx.config.initialCostUsd);

  // Billing keystone: the server charges only the per-turn DELTA. Alongside
  // run-monotonic cumulative we carry parentOwnCostUsd (advanced only at the parent's
  // own model sites, NEVER derived as cumulative−Σchild) and per-turn childUsage, so
  // `parentOwn + Σchild === turnDelta` detects a child mis-count; a HITL re_execute
  // replay seeds childUsage once via config.initialChildUsage.
  // History: docs/learnings/native-harness-history.md (Billing).
  // Pinned by: native-harness.reconcile.test.ts.
  const seedChildUsagePending = (ctx.config.initialChildUsage?.length ?? 0) > 0;

  // Run-scoped per-round counter for AGENT_USAGE turn_number (monotonic per task for
  // server grouping). Seeded from the journal's MAX append `seq` — append-only and
  // never-regressing, including across compaction (unlike the earlier assistant-COUNT
  // seed, which a compaction could lower → turn_number reuse). Cold runs start at 0;
  // never-throw (a journal read failure degrades to 0).
  // History: docs/learnings/native-harness-history.md (Billing → turn_number counter).
  // X1: what the run opens on also says whether SessionStart reports "startup" or "resume".
  let opened: readonly JournalEntry[] = [];
  if (ctx.config.journal) {
    try {
      const projected = await ctx.config.journal.project();
      opened = projected.messages;
      rc.billing.roundCounter.value = projected.messages.reduce(
        (max, e) => (e.seq > max ? e.seq : max),
        0,
      );
    } catch {
      rc.billing.roundCounter.value = 0;
    }
  }

  // Record the instruction snapshot ONCE per fresh session (replay-audit of the
  // assembled InstructionStack). Reuses the frozen `custom` payload kind
  // (CONTEXT_POLICY:false → never replays). Best-effort; never throws into the run.
  await appendInstructionSnapshot(ctx.config.journal, ctx, ctx.config.instructionSnapshot);

  // SessionStart seam — fires ONCE per run, after the prologue and before the
  // user-turn loop. A hook's `additionalContext` PREPENDS to the system context for
  // every model call this run; no callback → no-field continue → byte-identical.
  // X1 (HOOK_PARITY_V1): `source` is "resume" when the conversation already holds a reply.
  // History: docs/learnings/native-harness-history.md (Hooks lifecycle → SessionStart).
  const sessionStart = await dispatchLifecycle(
    prologue.dispatcher,
    buildSessionStartInput(sessionStartSource(opened)),
    deps.runSignal(ctx),
    ctx.sessionId,
  );
  const startCtx = continueContext(sessionStart);
  // CONTEXT_APPEND_V1 (context-append.ts): the session's first system prompt is served again
  // and what changed since, SessionStart context included, is appended ahead of the turn.
  // Inert (undefined) → today's system prompt and prepend, byte-identical.
  // C7: a model change serves a fresh prompt; the effort its wire resolves is told when it changes.
  const model = ctx.model || transport.defaultModel();
  const settings = { model, effort: transport.reasoningEffort?.(model) };
  const held = await holdSession(ctx, { system: prologue.system, toolIndex: prologue.toolIndex ?? '', sessionStart: startCtx ?? '', settings });
  if (held !== undefined) {
    prologue.system = held.system;
  } else if (startCtx) {
    prologue.system = prologue.system ? `${startCtx}\n\n${prologue.system}` : startCtx;
  }
  // Where the memory sits in what this run serves, from the layers it was rendered from: the
  // round request carries it on a lane whose flag is on (round-stream.ts buildRoundRequest).
  const servedLayers = held?.layers ?? ctx.config.instructionLayers;
  const span = servedLayers ? memorySpan(prologue.system, servedLayers) : undefined;
  if (span) rc.systemMemorySpan = { span, system: prologue.system };

  // Staged-turn coalescing: text of staged turns (shouldQuery:false) is buffered
  // here until the next querying turn, where it merges into that turn's SINGLE user
  // entry (one entry keeps the projected message array API-valid on both arms — the
  // Anthropic API rejects consecutive same-role messages). Empty → byte-identical.
  // History: docs/learnings/native-harness-history.md (Coalescing staged turns).
  const stagedTexts: string[] = [];
  // Images carried by staged turns coalesce into the next querying turn alongside
  // stagedTexts. Empty on the normal (non-staged) path → byte-identical.
  const stagedImages: ImageBlock[] = [];
  // VIDEO_UNDERSTANDING_V1 — media (video/audio/PDF) carried by staged turns
  // coalesces with them. Empty on every flag-off path → byte-identical.
  const stagedMedia: MediaBlock[] = [];

  // Run-local ambient (initiative-turn) spend ledger. The ambient fuel tank holds the
  // CEILING; this is the live spend it reads (the tank keeps no counter of its own).
  // Per-process-run (a fresh process starts at 0); only initiative turns advance it.
  // History: docs/learnings/native-harness-history.md (Preemption & ambient fuel).
  const ambientSpentUsd = 0;

  return {
    pendingTodoBlocks,
    prologue,
    inMemoryHistory,
    rc,
    seedChildUsagePending,
    stagedTexts,
    stagedImages,
    stagedMedia,
    ambientSpentUsd,
  };
}

/**
 * Fill the staged buffers from one deferred turn (shouldQuery:false, not a
 * continue). Text always; images and media only when the turn carries them, so a
 * turn without either leaves those arrays untouched → byte-identical.
 *
 * Lives beside the buffers it fills rather than in the loop that calls it: the
 * harness only decides WHETHER a turn is staged, this owns WHAT staging means.
 */
export function stageDeferredTurn(
  userTurn: UserTurn,
  staged: { texts: string[]; images: ImageBlock[]; media: MediaBlock[] },
): void {
  staged.texts.push(userTurn.text);
  if (userTurn.images?.length) staged.images.push(...userTurn.images);
  if (userTurn.media?.length) staged.media.push(...userTurn.media);
}
