/**
 * K5-T3 — the CONTINUE path's composio RE-EXECUTE (spec §6/§7).
 *
 * `reconcileInteractions` (kernel, T1) materializes `resolution_is_result` kinds in
 * place and returns `re_execute` directives for `composio_auth`. This module runs a
 * directive: re-dispatch the original tool now that the connector is live, then
 * append its real result + settle the interaction. The kernel can't do this — it's
 * pure and has no tool registry; this is the sandbox's job.
 *
 * EXACTLY-ONCE-EXECUTION (spec §7 step 1/3):
 *  - Idempotent: if the tool_use already has a tool_result (replay / double-trigger)
 *    → no-op. This is the within-process once-token.
 *  - Crash or failure after dispatch: the LAST journal write before every dispatch is
 *    the intent `{ key: 'reexecute_started', data: { toolUseId } }`. A later delivery of
 *    the same continue (the server's bounded retry, or a fresh process after a crash) that
 *    finds the intent and no tool_result NEVER re-executes (the email may already be sent,
 *    the payment made): it settles an `execution_interrupted` error and the model
 *    re-decides. If the intent itself cannot be written, the tool never runs.
 *
 * RE-PAUSE SAFETY (closes the T3-review HIGH gap): the re-dispatch goes through
 * `gateAndDispatchTool`, which can re-pause WITHOUT throwing on two vectors — the
 * pre-gate (`harness.gateTool` reading the run-frozen `ctx.connectedComposioToolkits`)
 * and the post-scan (a still-auth-required tool result). We (a) re-dispatch with a
 * NON-firing pause sentinel so a residual re-pause does NOT spawn a second interaction
 * loop, and (b) NEVER settle a `pausedHalt` body — we settle a structured
 * `connector_not_ready` retryable error the model can act on, never a garbage halt
 * string. **T5b CONTRACT (§7 step 2):** continueFromInteraction MUST refresh the
 * connected-apps snapshot (await refreshFromServer) BEFORE rebuilding the run ctx, so
 * the pre-gate sees the just-connected toolkit and the FIRST re-dispatch succeeds; the
 * `connector_not_ready` settle here is the rare residual fallback, not the happy path.
 *
 * ring 4c — RELOCATED into the SDK engine. The post-connect connected-apps refresh is
 * no longer the product `refreshConnectedAppsCache` import; it arrives via the injected
 * `StatePort.refreshConnectedApps()` (the product `SandboxStatePort` wraps the live
 * `refreshConnectedAppsCache`, a fetch-AND-commit — byte-identical).
 */

import type { InteractionKind, InteractionOutcome } from '../contract/interaction.js';
import type { GateResult, ToolCall } from '../contract/harness.js';
import type { HarnessEvent } from '../contract/events.js';
import type { JournalEntry } from '../contract/journal.js';
import { subagentIdFromPath, type SubagentPathSegment } from '../contract/subagent-path.js';
import type { Journal } from '../kernel/index.js';
import { REEXECUTE_BOUND_TOOLS, WEAVE_REEXECUTE_TOOL, planMaterialization, projectScope, keepLastToolResultPerId, liveSuspendedToolUseIds } from '../kernel/index.js';
import { COMPOSIO_MANAGE_CONNECTIONS_TOOL } from '../policy/engine-constants.js';
import type { RawToolOptions } from '../tools/tool-types.js';
import type { InjectionScreenSeam } from '../policy/injection-screen.js';
import { gateAndDispatchTool } from './tool-dispatcher.js';
import { toolBillingEvent } from './tool-billing.js';
import { withMcpConnectRetry, type McpRetryOptions } from './mcp-retry.js';
import { appendToolResultByTaskId, appendResolvedInteractionEntry, appendSubagentToolResultEntry } from './native-journal.js';
import { baseFromTaskId } from './journal-entry-base.js';
import type { StatePort } from '../ports/index.js';
import { type WorldDelta, worldDeltaMeetsThreshold, buildWorldDeltaChildPreamble } from './world-delta.js';

export interface ReExecuteDirective {
  toolUseId: string;
  interactionId: string;
  kind: InteractionKind;
  toolName: string;
  /**
   * T11b (durable subagent deep-HITL, Phase B) — the bound tool_use's scope path (copied
   * by `reconcileInteractions` from the leaf inner tool's scope-tagged journal entry).
   * PRESENT ⇒ the pause was raised by a subagent at depth ≥ 1 ⇒ route to subagent
   * RE-ENTRY (`materializeSubagentReEntry`). ABSENT ⇒ main-agent leaf re-dispatch or the
   * flag-OFF `Agent` collapse-replay (both untouched).
   */
  agentPath?: SubagentPathSegment[];
  /**
   * P3.3 (durable Weave pause) — the PENDING marker's captured-leaf hash on a
   * Weave-bound directive; threaded into the script re-dispatch as the one-shot
   * approval/deny match key. Absent on every non-Weave directive.
   */
  weavePending?: { contentHash: string; nodeSpecHash?: string; scopeId?: string };
}

export interface MaterializeReExecuteOptions {
  directive: ReExecuteDirective;
  /** The rebuilt tool registry for this continue (may not contain the tool if MCP didn't load). */
  tools: RawToolOptions[];
  /** The original tool_use input (from the journal's tool_use entry). */
  originalInput: unknown;
  /** The resolution outcome to settle the interaction with. */
  outcome: InteractionOutcome;
  journal: Journal;
  taskId: string;
  harness: { gateTool(call: ToolCall): Promise<GateResult> };
  /**
   * ring 4c — the injected per-session state port. The composio re_execute path
   * fetch-AND-commits the connected-apps snapshot via `state.refreshConnectedApps()`
   * BEFORE the first re-dispatch (the product `SandboxStatePort` wraps the live
   * `refreshConnectedAppsCache`, so this is byte-identical to the prior import).
   */
  state: StatePort;
  /** Composio toolkit slug, for the post-connect cache invalidation. */
  toolkit?: string;
  /** MCP-connect retry tuning (tests pass baseDelayMs:0). */
  retryOpts?: McpRetryOptions;
  /**
   * native-redrive — the live socket sink for the re-dispatched SUBAGENT's SUBAGENT_*
   * progress events. The Agent tool emits via `ctx.pushEvent`; on the continue path
   * the QueryManager wires this so the re-spawned subagent renders in the UI exactly
   * like the original run. Absent (tests) → the re-dispatch simply emits nothing live.
   * Every settle of the held call also streams its `tool_result` block through it
   * (streamSettledResult), whatever tool was held.
   */
  pushEvent?: (ev: HarnessEvent) => void;
  /**
   * native-redrive — bill the re-spawned subagent's model cost onto the continue
   * turn (the Agent tool calls `ctx.addCostUsd`). Threaded so the replay bills only
   * the rounds actually run. Absent (composio path / tests) → unbilled here.
   */
  addCostUsd?: (usd: number) => void;
  /**
   * Agent v2 (Task 6) — the ATTRIBUTED per-child cost sink (parallel to addCostUsd).
   * Threaded into the re-spawned subagent's execCtx so the Agent tool's
   * `ctx.addChildCost` per re-spawn reaches the continue's replay-attribution list.
   * Absent (composio path / tests) → dropped here, byte-identical.
   */
  addChildCost?: (rec: import('../contract/child-cost.js').ChildCostRecord) => void;
  /**
   * ring 4c — the tenant boundary (workspaceId) the journal stamps on the settle
   * entries (tool_result + resolved interaction). Threaded from the orchestrator as
   * `cfg.runtimeConfig?.userId ?? ''`. Absent (legacy / tests) → `''` → `'sandbox'`,
   * byte-identical to the prior inline `process.env.USER_ID ?? 'sandbox'` read.
   */
  userId?: string;
  /**
   * HITL world-delta (T3) — the elapsed-time + runner-recycle context for THIS resume,
   * threaded from orchestrateContinue. When it meets the threshold, a re-spawned SUBAGENT
   * (`dispatchAgentScope`) gets a second-person preamble PREPENDED to its re-read prompt so
   * the child does not assume its pre-pause filesystem/process state survived. Absent
   * (legacy / short resume / tests) → the child prompt is byte-identical to today.
   */
  worldDelta?: WorldDelta;
  /**
   * W4-2 (shadow injection screen) — the SAME seam the cold path carries on
   * `NativeConfig.injectionScreen`, threaded here so a RE-DISPATCH is screened like a
   * first dispatch. Without it this whole module was the rail's one uncovered lane: a
   * side-effecting call on a tainted turn that hit a Composio auth wall (or a
   * `tool_permission` gate), got resolved by the user, and was then re-executed
   * produced no ask, no verdict and NO ROW — and a turn that is never screened writes
   * no row, so its silence read as coverage rather than as a blind spot (the exact
   * class `policy/injection-screen.ts`'s own header names).
   *
   * Threaded UNIFORMLY into all five re-dispatch sites rather than into the two that
   * look side-effecting today. The seam owns the whole policy — it collects the turn's
   * taint, classifies the family, and short-circuits on either — so a per-site
   * judgement here would be a hand list that the classifier could silently outgrow.
   *
   * SHADOW, and fail-open by CONSTRUCTION rather than by a second discipline: it rides
   * `execCtx.injectionScreen`, which means the SAME `screenBeltedNeverThrow` belt at the
   * SAME point in the SAME function as the cold path. Nothing in this module reads the
   * verdict. Absent (flag dark / legacy caller / tests) → no key → byte-identical.
   */
  injectionScreen?: InjectionScreenSeam;
  /**
   * Continue anywhere (spec §6.3) — awaited right after the REEXECUTE_STARTED intent is fsynced and
   * BEFORE the approved tool runs, with its name. A re-execute never meets the policy port (it runs
   * under the one-shot allow), so this is where the Mac lane mirrors the journal through the intent:
   * a lid closed mid-send then leaves the next computer the marker that stops a second run. Must not
   * throw (a throw here, like a failed intent write, means the tool never runs). Absent (the cloud
   * lane, the flag off, tests) → nothing runs between the fsync and the dispatch, byte-identical.
   */
  afterReExecuteMarked?: (toolName: string) => Promise<void>;
}

/**
 * W4-2 — the screen seam as a dispatch `execCtx` fragment, or `undefined` when there
 * is none. `undefined` (not `{}`) so the two sites that pass no execCtx today keep
 * passing none: every read in the dispatcher is `execCtx?.x`, so the shapes behave
 * identically, but a literal absence is the thing a reader can check.
 *
 * S4: both callers re-execute a call the PERSON just answered a card for, so a `block`
 * stamp is dropped here and the call runs. The reading itself is kept (the screen is
 * still asked, its row and meter still land); only the refusal is withheld.
 */
function screenCtx(opts: MaterializeReExecuteOptions): { injectionScreen: InjectionScreenSeam } | undefined {
  const seam = opts.injectionScreen;
  if (seam === undefined) return undefined;
  return {
    injectionScreen: {
      maybeScreen: async (call, signal) => {
        const r = await seam.maybeScreen(call, signal);
        return r?.verdict === 'instructed' && r.block ? { verdict: 'instructed', reason: r.reason } : r;
      },
      ...(seam.onBeltTimeout && { onBeltTimeout: (call: ToolCall) => seam.onBeltTimeout?.(call) }),
    },
  };
}

/** native-redrive — does this directive re-dispatch a SUBAGENT (Agent) tool? */
function isSubagentReExecute(toolName: string): boolean {
  return REEXECUTE_BOUND_TOOLS.has(toolName);
}

/**
 * The intent a re-execute journals as its LAST write before it dispatches the tool (see the
 * header). Nothing else is journaled between a dispatch and its settle, so without it a
 * continue that ran the approved tool and then failed to settle reads, on its next delivery,
 * exactly like one that never started. A `custom` entry (CONTEXT_POLICY:false): never
 * projected into any model history, like construction_params.
 *
 * Keyed on the tool_use AND the interaction: a Weave or `Agent` re-execute can RE-PAUSE by
 * design, binding a FRESH interaction to the SAME tool_use, and approving that fresh one is a
 * new approval that must run. Retries of one continue reuse its interactionId, so the
 * double-run guard holds for them.
 */
export const REEXECUTE_STARTED_KEY = 'reexecute_started';

async function markReExecuteStarted(opts: MaterializeReExecuteOptions): Promise<void> {
  const { toolUseId, interactionId } = opts.directive;
  await opts.journal.append({
    ...baseFromTaskId(opts.taskId, opts.userId ?? ''),
    principal: { kind: 'system' },
    payload: { type: 'custom', key: REEXECUTE_STARTED_KEY, data: { toolUseId, interactionId } },
  });
  // Durable BEFORE the side-effect: a box killed mid-send must still find the intent on the
  // next delivery. One fsync per approval (best-effort, never throws), not per journal write.
  await opts.journal.fsync();
  // ... and, on a computer whose disk can vanish, on the mirror too (spec §6.3).
  await opts.afterReExecuteMarked?.(opts.directive.toolName);
}

async function reExecuteStarted(journal: Journal, directive: ReExecuteDirective): Promise<boolean> {
  for await (const e of journal.read()) {
    const p = e.payload;
    const d = p.type === 'custom' && p.key === REEXECUTE_STARTED_KEY ? (p.data as { toolUseId?: unknown; interactionId?: unknown } | undefined) : undefined;
    if (d?.toolUseId === directive.toolUseId && d.interactionId === directive.interactionId) return true;
  }
  return false;
}

/** What a re-execute that may already have run settles with, instead of a second execute(). */
const EXECUTION_INTERRUPTED = { text: JSON.stringify({ status: 'error', reason: 'execution_interrupted' }), isError: true };

async function alreadyAnswered(journal: Journal, toolUseId: string): Promise<boolean> {
  for await (const e of journal.read()) {
    if (e.payload.type === 'tool_result' && e.payload.toolUseId === toolUseId) return true;
  }
  return false;
}

async function settle(
  opts: MaterializeReExecuteOptions,
  result: { text: string; isError: boolean; taint?: 'external' },
): Promise<void> {
  await appendToolResultByTaskId(opts.journal, opts.taskId, {
    toolUseId: opts.directive.toolUseId,
    text: result.text,
    isError: result.isError,
    // W4-1: a re-dispatched declaring tool's result stays tainted on the continue
    // path (the Composio auth-halt resume is exactly a connector READ landing).
    ...(result.taint !== undefined && { taint: result.taint }),
  }, opts.userId ?? '');
  await appendResolvedInteractionEntry(
    opts.journal, opts.taskId, opts.directive.interactionId, opts.outcome, undefined, opts.userId ?? '',
  );
  streamSettledResult(opts, opts.directive.toolUseId, opts.directive.toolName, result);
}

/**
 * The held call's result, streamed the way the live round streams every result (round-tool-
 * sequential's `tool_result` block, which the host's core sink turns into AGENT_TOOL_RESULT),
 * on the SAME toolUseId as the held tool_use, so the browser folds it onto the block it has.
 *
 * Before this, an approved call ran here and its real output reached the journal and the
 * model, but the browser only ever saw the paused placeholder from before the ask: the card
 * stayed "paused" over a command that ran, and the story's step never settled (#4183's
 * scenario D found it). Called after both journal writes, so nothing is shown that the
 * journal does not hold. No sink (tests, a caller with no socket) means nothing streams.
 */
function streamSettledResult(
  opts: MaterializeReExecuteOptions,
  toolUseId: string,
  toolName: string,
  result: { text: string; isError: boolean },
): void {
  opts.pushEvent?.({
    kind: 'block',
    block: { type: 'tool_result', toolUseId, content: result.text, isError: result.isError, toolName },
  });
}

/**
 * native-redrive — settle ONLY the resolved-interaction row, appending NO tool_result.
 * Used when a SUBAGENT re-execute RE-PAUSED: the re-dispatch already fired a FRESH
 * pending interaction bound to the SAME parent Agent tool_use, so the tool_use must
 * stay UNANSWERED (orchestrateContinue's liveSuspendedToolUseIds then re-suspends and
 * the user approves the fresh run). Appending a tool_result here would mark the
 * tool_use answered and strand the fresh interaction — the exact hollow-result bug.
 */
async function settleInteractionOnly(opts: MaterializeReExecuteOptions): Promise<void> {
  await appendResolvedInteractionEntry(
    opts.journal, opts.taskId, opts.directive.interactionId, opts.outcome, undefined, opts.userId ?? '',
  );
}

/**
 * The re-dispatch's pause sentinel: a re-pause here (connector still not visible to
 * the gate) must NOT fire a second substrate interaction — we detect the pausedHalt
 * and settle a structured retryable error instead. So this returns a sentinel and
 * the dispatcher's `onAuthHalt` is intentionally NOT passed.
 */
const reExecPauseSentinel = async (): Promise<string> => 'AWAITING_CONNECTOR';

/**
 * Which connector the resolve was about: the server stamps `{ toolkit, connected }`
 * on the allow outcome; the tool's own input names it otherwise.
 */
function resolvedToolkit(updatedInput: unknown, originalInput: unknown): string {
  const stamped = (updatedInput as { toolkit?: unknown } | undefined)?.toolkit;
  if (typeof stamped === 'string' && stamped) return stamped;
  const named = (originalInput as { toolkits?: Array<{ name?: unknown }> } | undefined)?.toolkits?.[0]?.name;
  return typeof named === 'string' && named ? named : 'connector';
}

export async function materializeReExecute(opts: MaterializeReExecuteOptions): Promise<void> {
  const { directive, tools, originalInput, journal, harness, retryOpts } = opts;

  // Idempotent: an already-answered tool_use is complete — never re-execute.
  if (await alreadyAnswered(journal, directive.toolUseId)) return;

  // An earlier delivery dispatched this tool and no result landed (it failed to settle, or the
  // runner died): the side-effect may already have fired; re-executing could re-send it.
  // Settle a structured error the model reads and re-decides on — never a second execute().
  const interrupted = await reExecuteStarted(journal, directive);

  // T11b — a scope-tagged (agentPath) bound tool_use means the pause was raised by a
  // subagent at depth ≥ 1. The resolution must RE-ENTER that subagent from journaled
  // state (re-execute the leaf once, then continue the subagent SEEDED from its scope
  // projection — zero replayed model rounds), NOT re-dispatch the leaf at the main level.
  // Absent agentPath ⇒ the historic leaf / `Agent`-collapse paths below run unchanged.
  if (directive.agentPath && directive.agentPath.length > 0) {
    return materializeSubagentReEntry(opts, interrupted);
  }
  if (interrupted) {
    await settle(opts, EXECUTION_INTERRUPTED);
    return;
  }

  const tool = tools.find((t) => t.name === directive.toolName);
  if (!tool) {
    await settle(opts, { text: JSON.stringify({ status: 'error', reason: 'tool_unavailable' }), isError: true });
    return;
  }

  // native-redrive — the SUBAGENT (Agent) re-execute is NOT a composio side-effect:
  // re-running the Agent tool re-spawns the subagent, which replays under the now-
  // persisted auto-allow rule and returns its REAL output. It must NOT refresh the
  // connected-apps cache, and its RE-PAUSE semantics differ (a residual re-pause
  // re-suspends with a FRESH interaction rather than settling a connector error).
  if (isSubagentReExecute(directive.toolName)) {
    return materializeSubagentReExecute(opts, tool);
  }

  // P3.3 (durable Weave pause — fleet C1) — a Weave-bound resolution re-dispatches the
  // SCRIPT, never the captured leaf. Before this branch, an approved Weave-bound
  // `tool_permission` fell through to materializeLeafReExecute: the captured leaf
  // (e.g. `Bash`) ran DETACHED at main scope under the one-shot allow and its raw
  // stdout settled as the WEAVE tool_result — the script never completed, the model
  // got bash-stdout where it expected WeaveOutput JSON, and a plausible re-call
  // double-fired the side-effect. Keyed on the directive toolName the kernel rewrote
  // from the JOURNALED tool_use name (NOT REEXECUTE_BOUND_TOOLS — pinned invariant:
  // Weave stays out of that set).
  if (directive.toolName === WEAVE_REEXECUTE_TOOL) {
    return materializeWeaveReExecute(opts, tool);
  }

  // native-perm-reexec — a LEAF action tool (Bash/Write/Edit/Glob/Grep/Composio/
  // WebFetch/…) whose `tool_permission` the user APPROVED. The tool was paused via
  // needs_human BEFORE it executed (no tool_result journaled), so this re-run is its
  // FIRST and ONLY execution — run it ONCE under a one-shot allow and settle its real
  // output. NOT a composio_auth resolution → it must NOT refresh the connector cache
  // and must NOT re-gate (the approval IS the gate decision for this call).
  if (directive.kind === 'tool_permission') {
    return materializeLeafReExecute(opts, tool);
  }

  // The connector just connected — refresh AND COMMIT the connected-apps cache so the gate's
  // live snapshot reflects it on the FIRST re-dispatch (F2, §7 step 2). A bare invalidate would
  // null the cache → getConnectedAppsSnapshot re-seeds from ENV (toolkit absent) → re-pause.
  await opts.state.refreshConnectedApps();

  // The connection-management meta tool IS the connect action. Re-executing it after
  // the user connected asks Composio to connect AGAIN: it mints a fresh link, the
  // post-scan reads that as a new auth wall, and this path settles connector_not_ready
  // — the model re-calls, and the roster (now active) turns the third link into an
  // ADD-account ask (founder trace 2026-08-26, task 2d8debb0). For this one tool the
  // resolve IS the result: settle a structured success and let the model move on.
  if (opts.outcome.behavior === 'allow' && directive.toolName === COMPOSIO_MANAGE_CONNECTIONS_TOOL) {
    const toolkit = resolvedToolkit(opts.outcome.updatedInput, originalInput);
    await settle(opts, {
      text: JSON.stringify({
        status: 'ok',
        toolkit,
        connected: true,
        message: `${toolkit} is connected. Continue with the task — do not call COMPOSIO_MANAGE_CONNECTIONS for it again.`,
      }),
      isError: false,
    });
    return;
  }

  // Re-dispatch the original tool, retrying the MCP cold-wake hiccup so a not-yet-
  // propagated connector does not re-fire a second auth halt (the extracted retry).
  await markReExecuteStarted(opts);
  const res = await withMcpConnectRetry(
    () => gateAndDispatchTool(
      tool, originalInput, directive.toolUseId, harness, reExecPauseSentinel, undefined, screenCtx(opts),
    ),
    retryOpts,
  );

  // RE-PAUSE: the gate/scan still sees the connector as not-connected (the run ctx's
  // snapshot was frozen pre-connect — T5b must refresh it; this is the residual case).
  // NEVER settle the pausedHalt body (a garbage 'AWAITING' string) — settle a clear,
  // structured retryable error so the model can re-call the tool, and never a silent
  // non-execution dressed up as a result.
  if (res.pausedHalt) {
    await settle(opts, {
      text: JSON.stringify({
        status: 'error',
        reason: 'connector_not_ready',
        message: 'The connector is connected but not yet visible to this turn. Re-call the tool to complete the action.',
      }),
      isError: true,
    });
    return;
  }

  // The call ran now, its auth wall behind it; the halted attempt sent no fee, so its frame goes out here.
  const fee = toolBillingEvent({ taskId: opts.taskId, toolName: tool.name, toolUseId: directive.toolUseId }, res);
  if (fee) opts.pushEvent?.(fee);
  await settle(opts, { text: res.text, isError: res.isError, ...(res.taint !== undefined && { taint: res.taint }) });
}

/**
 * native-perm-reexec — the one-shot ALLOW harness for a leaf-tool re-execute. The
 * user already approved THIS call, so the re-run must NOT be re-classified by the real
 * gate (which would re-pause → an infinite-approve loop). This harness unconditionally
 * allows, so `gateAndDispatchTool` runs the tool's `execute` exactly once. It is a
 * per-call object (no shared state) → the allow is scoped to this single re-dispatch,
 * never persisted, never leaking to any other tool call.
 */
const ONE_SHOT_ALLOW_HARNESS: { gateTool(call: ToolCall): Promise<GateResult> } = {
  gateTool: async (): Promise<GateResult> => ({ decision: 'allow' }),
};

/** The leaf re-run's pause sentinel — defensive only: ONE_SHOT_ALLOW_HARNESS never asks. */
const leafReExecPauseSentinel = async (): Promise<string> => 'AWAITING_APPROVAL';

/**
 * native-perm-reexec — re-execute a LEAF action tool (Bash/Write/Edit/Composio/…) on
 * the continue path after the user APPROVED its `tool_permission` (spec: the approval
 * re-executes the approved tool with a one-shot allow).
 *
 * EXACTLY-ONCE: the caller (`materializeReExecute`) already short-circuited an
 * already-answered tool_use (idempotent) and the crash-after-deliver retry. The tool
 * was paused BEFORE it executed (PAUSED_HALT, no tool_result), so this dispatch is the
 * tool's FIRST and ONLY run — no double side-effect (no double curl/POST/bill).
 *
 * NO RE-PAUSE LOOP: the re-dispatch runs through `ONE_SHOT_ALLOW_HARNESS` (always
 * allow), so the gate can never re-classify the call as needs_human. A persisted
 * "always allow" rule, if the user chose it, is applied independently up-front by the
 * orchestrator's `onResolved` writeback; for a ONE-TIME approve the one-shot allow here
 * runs the tool exactly once and the gate is never consulted again. Either way: one run,
 * no re-pause.
 *
 * DENY: a declined/blocked outcome NEVER reaches here in production (the kernel's
 * `planMaterialization` deny branch settles a structured `result`, never a `re_execute`
 * directive). Defensively, if a deny outcome is handed in directly, we settle the
 * kernel's structured declined result and DO NOT run the tool.
 */
async function materializeLeafReExecute(
  opts: MaterializeReExecuteOptions,
  tool: RawToolOptions,
): Promise<void> {
  // NOTE: `res.blocks` (e.g. the screenshot from a credit-gated browser-control tool)
  // is intentionally dropped here — `settle()` records only text — mirroring the
  // pausedHalt note above; the image isn't threaded onto this non-default re-execute
  // resolution path (accepted risk), so this is by design, not an oversight.
  const result = await computeLeafResult(opts, tool, false);
  // RE-PAUSE BY THE TOOL ITSELF: an approved tool whose run raises its own pause (a
  // company's client tool: its call goes to the company's code and waits on the answer;
  // an MCP server's question) bound a FRESH interaction to this tool_use through the
  // continue's real onPause. Settle ONLY the approval, so the tool_use stays unanswered
  // and the continue re-suspends on the fresh one: the Agent and Weave re-pause shape.
  // Settling the pause sentinel as the result would answer the call before the tool did.
  // Nothing streams for the approval here: the fresh card is what the person sees next.
  if (result.reRaised) {
    await settleInteractionOnly(opts);
    return;
  }
  await settle(opts, result);
}

/**
 * The PURE resolution-of-a-leaf-pause: the tool_result an approved/declined
 * `tool_permission` produces, WITHOUT settling anything. Shared by
 * `materializeLeafReExecute` (which settles it onto the MAIN journal) and the T11b
 * subagent RE-ENTRY (which injects it SCOPE-TAGGED into the subagent's history).
 *
 *  - DENY → the kernel's structured declined message (the tool is NOT run).
 *  - ALLOW → re-run the approved tool ONCE under the one-shot allow (no re-gate, no
 *    re-pause); its real output is the result. A missing tool (only possible on the
 *    re-entry fallback) degrades to a structured `tool_unavailable` error.
 *
 * The action fee: the pause sent none (toolBillingEvent skips a paused call), and this
 * is the call's first and only run, so its frame goes out here through the live sink,
 * on the main turn or as the subagent's (`isSubagent`) it paused inside. A deny runs
 * nothing and sends nothing.
 */
async function computeLeafResult(
  opts: MaterializeReExecuteOptions,
  tool: RawToolOptions | undefined,
  isSubagent: boolean,
): Promise<{ text: string; isError: boolean; taint?: 'external'; reRaised?: true }> {
  const { directive, originalInput, outcome } = opts;
  // Defense-in-depth: a DENY must never run the tool. The kernel's deny branch yields
  // the same structured result the resolution_is_result deny path would have settled.
  if (outcome.behavior === 'deny') {
    const plan = planMaterialization(directive.kind, outcome, directive.toolName);
    // The deny branch always yields a `result` plan (never re_execute).
    return plan.action === 'result'
      ? { text: plan.content, isError: plan.isError }
      : { text: JSON.stringify({ status: 'declined' }), isError: false };
  }
  if (!tool) return { text: JSON.stringify({ status: 'error', reason: 'tool_unavailable' }), isError: true };
  // ALLOW — re-run the approved tool ONCE under the one-shot allow (no re-gate, no
  // re-pause). Its real output becomes the tool_result.
  await markReExecuteStarted(opts);
  const res = await gateAndDispatchTool(
    tool,
    originalInput,
    directive.toolUseId,
    ONE_SHOT_ALLOW_HARNESS,
    leafReExecPauseSentinel,
    undefined,
    // The one-shot allow bypasses the GATE, never the screen: the user approved this
    // call, which is a statement about permission and not about who authored the
    // intent. A `tool_permission` re-execute is in fact the sharper of the two lanes —
    // it is the one where a person is told "the agent wants to do X" and says yes.
    // On the main journal it also opts in to markPausedHalt, so a tool that raises its
    // own pause says so (materializeLeafReExecute). A subagent's leaf stays as it was.
    isSubagent ? screenCtx(opts) : { ...screenCtx(opts), markPausedHalt: () => {} },
  );
  // The tool marked its own pause. The invariant: ONE_SHOT_ALLOW_HARNESS never halts, so
  // the dispatcher's no-error pauses from the gate (ask, defer) cannot happen here, and a
  // hook halt and a connector wall are errors; a no-error pause can only be the tool's own
  // mark. Hand this path a harness that can halt and that no longer holds.
  if (!isSubagent && res.pausedHalt === true && !res.isError) return { text: res.text, isError: false, reRaised: true };
  const fee = toolBillingEvent({ taskId: opts.taskId, toolName: tool.name, toolUseId: directive.toolUseId, ...(isSubagent && { isSubagent: true }) }, res);
  if (fee) opts.pushEvent?.(fee);
  // W4-1: an approved-then-re-run declaring tool stays tainted.
  return { text: res.text, isError: res.isError, ...(res.taint !== undefined && { taint: res.taint }) };
}

/**
 * native-redrive — re-execute the SUBAGENT (Agent) tool on the continue path.
 *
 * Re-dispatches the `Agent` tool with the original input (`{subagent_type, prompt}`),
 * re-spawning the subagent. The Agent tool's own captured onPause (a REAL one wired
 * by the continue's buildToolset) means a residual inner-tool re-pause fires a FRESH
 * interaction bound to the SAME parent Agent tool_use.
 *
 *  - COMPLETED (the common path: the previously-paused inner tool auto-allows under
 *    the persisted rule): append the subagent's REAL output as the Agent tool_use's
 *    tool_result + settle the OLD interaction. The continue then drives a real turn
 *    and the parent model sees the genuine subagent answer.
 *  - RE-PAUSED (the user approved ONCE, no rule → the inner tool re-pauses on the
 *    fresh run): the re-dispatch already journal-bound a FRESH pending interaction to
 *    this tool_use. Settle ONLY the OLD interaction (NO tool_result) so the tool_use
 *    stays unanswered; orchestrateContinue's liveSuspendedToolUseIds re-suspends and
 *    the user is re-prompted. NEVER settles a hollow `{"status":"allowed"}` result.
 *
 * Billing: the Agent tool calls `ctx.addCostUsd` per re-spawn, so the replay bills
 * only the rounds actually run (threaded from opts.addCostUsd).
 */
async function materializeSubagentReExecute(
  opts: MaterializeReExecuteOptions,
  tool: RawToolOptions,
): Promise<void> {
  const { directive, originalInput, harness } = opts;

  // Re-dispatch the Agent tool. OPT IN to markPausedHalt so a re-pause surfaces, and
  // thread the live socket sink + cost sink so the re-spawned subagent renders + bills
  // exactly like the original run. The `reExecPauseSentinel` here gates the Agent tool
  // ITSELF (auto-allowed → unused); the inner re-pause uses the Agent tool's own
  // captured onPause (the REAL one from the continue's buildToolset).
  await markReExecuteStarted(opts);
  const res = await gateAndDispatchTool(
    tool,
    originalInput,
    directive.toolUseId,
    harness,
    reExecPauseSentinel,
    undefined,
    {
      markPausedHalt: () => {},
      ...(opts.pushEvent !== undefined && { pushEvent: opts.pushEvent }),
      ...(opts.addCostUsd !== undefined && { addCostUsd: opts.addCostUsd }),
      ...(opts.addChildCost !== undefined && { addChildCost: opts.addChildCost }),
      // ring 4c.7: thread the real task/session id so a (rare) deny on the
      // re-dispatched subagent stamps PERMISSION_DENIED.taskId from the live id
      // rather than the dispatcher's env-free '' fallback (the dispatcher no longer
      // reads process.env.SESSION_ID).
      sessionId: opts.taskId,
      // W4-2 — the shadow screen, threaded uniformly (see MaterializeReExecuteOptions).
      // The `Agent` wrapper classifies as workspace_write, so the real seam short-
      // circuits here today; the re-spawned subagent's INNER tools screen through the
      // toolset the continuation already builds from the same config.
      ...(opts.injectionScreen !== undefined && { injectionScreen: opts.injectionScreen }),
    },
  );

  // RE-PAUSE: the fresh run hit a genuine new permission gate and a FRESH interaction
  // is now pending on this tool_use. Settle ONLY the old row — leave the tool_use
  // UNANSWERED so the continue re-suspends and the user approves the fresh run.
  if (res.pausedHalt) {
    await settleInteractionOnly(opts);
    return;
  }

  // COMPLETED — the subagent re-ran to completion; its real output is the tool_result.
  await settle(opts, { text: res.text, isError: res.isError, ...(res.taint !== undefined && { taint: res.taint }) });
}

/**
 * P3.3 (durable Weave pause) — re-execute the WEAVE tool on the continue path.
 *
 * Re-dispatches the Weave tool with the ORIGINAL script input (content-derived
 * replay identity unchanged, so settled sibling nodes replay from their
 * `step_result` memos at $0), threading the one-shot leaf decision
 * (`execCtx.weaveResume = { contentHash, decision }`) derived from the resolved
 * outcome + the directive's frozen `weavePending` hash:
 *
 *  - ALLOW → the re-run's regenerated leaf call auto-allows IFF its contentHash
 *    matches what the user approved (one-shot); the previously-paused node
 *    executes its leaf, the script COMPLETES, and the real WeaveOutput JSON
 *    settles as the tool_result. A hash MISMATCH re-pauses fresh (see below).
 *  - DENY → the matching node settles dropped{permission_denied} inside the run
 *    and the script COMPLETES PAST it (other nodes run; the output notes the
 *    denial). Never the deny prose as the Weave result. A deny with NO frozen
 *    hash (defensive — the pause always records one) cannot target a node, so it
 *    settles the kernel's structured declined message WITHOUT re-dispatching.
 *  - RE-PAUSE (mismatch or a different node gating): the re-dispatch already
 *    fired a FRESH interaction bound to this same Weave tool_use (the continue
 *    toolset threads the real onPause). Settle ONLY the old row — the tool_use
 *    stays unanswered and orchestrateContinue re-suspends (the Agent-tool shape).
 *
 * NOT a composio side-effect: never refreshes the connected-apps cache. Billing
 * flows through opts.addCostUsd/addChildCost exactly like a subagent re-execute
 * (only the rounds actually run on the resume bill; memo replays bill $0).
 */
async function materializeWeaveReExecute(
  opts: MaterializeReExecuteOptions,
  tool: RawToolOptions,
): Promise<void> {
  const { directive, originalInput, outcome, harness } = opts;
  const contentHash = directive.weavePending?.contentHash;
  // P3.5b (Fix 1) — the paused node's identity + journal scope, frozen on the marker
  // at pause time; threaded so the re-dispatch seeds THAT node's re-entry from its
  // journaled rounds (byte-stable leaf continuation). Absent on older markers.
  const nodeSpecHash = directive.weavePending?.nodeSpecHash;
  const scopeId = directive.weavePending?.scopeId;
  const decision: 'allow' | 'deny' = outcome.behavior === 'deny' ? 'deny' : 'allow';

  // Defensive: a deny with no frozen hash cannot target the paused node inside a
  // re-run — settle the structured declined message instead of re-dispatching
  // (which would just re-pause and re-prompt the user they already said no to).
  if (decision === 'deny' && contentHash === undefined) {
    const plan = planMaterialization(directive.kind, outcome, directive.toolName);
    await settle(opts, plan.action === 'result'
      ? { text: plan.content, isError: plan.isError }
      : { text: JSON.stringify({ status: 'declined' }), isError: false });
    return;
  }

  await markReExecuteStarted(opts);
  const res = await gateAndDispatchTool(
    tool,
    originalInput,
    directive.toolUseId,
    harness,
    reExecPauseSentinel,
    undefined,
    {
      markPausedHalt: () => {},
      ...(opts.pushEvent !== undefined && { pushEvent: opts.pushEvent }),
      ...(opts.addCostUsd !== undefined && { addCostUsd: opts.addCostUsd }),
      ...(opts.addChildCost !== undefined && { addChildCost: opts.addChildCost }),
      sessionId: opts.taskId,
      // W4-2 — the shadow screen (see MaterializeReExecuteOptions). Same story as the
      // subagent site: `Weave` itself is workspace_write, and the script's own leaf
      // calls screen inside the run.
      ...(opts.injectionScreen !== undefined && { injectionScreen: opts.injectionScreen }),
      ...(contentHash !== undefined && {
        weaveResume: {
          contentHash,
          decision,
          ...(nodeSpecHash !== undefined && { nodeSpecHash }),
          ...(scopeId !== undefined && { scopeId }),
        },
      }),
    },
  );

  // RE-PAUSE: a FRESH interaction is now pending on this tool_use (hash mismatch, or
  // a different node hit a genuine new gate). Settle ONLY the old row — leave the
  // tool_use UNANSWERED so the continue re-suspends and the user decides the fresh run.
  if (res.pausedHalt) {
    await settleInteractionOnly(opts);
    return;
  }

  // COMPLETED — the script ran to completion; the real WeaveOutput is the tool_result.
  await settle(opts, { text: res.text, isError: res.isError, ...(res.taint !== undefined && { taint: res.taint }) });
}

// ── T11b: depth-1 subagent RE-ENTRY (billing-minimal resume) ───────────────────

async function readAllEntries(journal: Journal): Promise<JournalEntry[]> {
  const out: JournalEntry[] = [];
  for await (const e of journal.read()) out.push(e);
  return out;
}

/** T12 — toolUseId → its scope path (from the tool_use entries) for the sibling gate. */
function toolUsePathsById(all: JournalEntry[]): Map<string, SubagentPathSegment[]> {
  const m = new Map<string, SubagentPathSegment[]>();
  for (const e of all) {
    if (e.payload.type === 'tool_use') m.set(e.payload.toolUseId, e.agentPath ?? []);
  }
  return m;
}

/** T12 — is `descendant` inside `ancestor`'s subtree (ancestor is an agentToolUseId-prefix)? */
function isWithinScope(descendant: SubagentPathSegment[], ancestor: SubagentPathSegment[]): boolean {
  if (descendant.length < ancestor.length) return false;
  for (let i = 0; i < ancestor.length; i++) {
    if (descendant[i].agentToolUseId !== ancestor[i].agentToolUseId) return false;
  }
  return true;
}

/** The input of a specific tool_use (the parent `Agent` tool_use here — its
 *  `{subagent_type, prompt}`). The orchestrator only reads the LEAF tool_use's input. */
async function readToolUseInputById(journal: Journal, toolUseId: string): Promise<unknown> {
  let input: unknown;
  for await (const e of journal.read()) {
    if (e.payload.type === 'tool_use' && e.payload.toolUseId === toolUseId) input = e.payload.input;
  }
  return input;
}

/**
 * T11b/T12 — RE-ENTER the paused subagent from journaled state instead of replaying it,
 * then BUBBLE the resolution UP the ancestor chain (depth 2-3).
 *
 * The pause was raised by the subagent's LEAF inner tool (`directive.toolUseId`), whose
 * journal entry is scope-tagged with `directive.agentPath` (T10). The deepest subagent's
 * id is the path leaf (`subagentIdFromPath`).
 *
 *  1. Re-execute the paused leaf ONCE (allow → run; deny → declined message) and journal
 *     its resolved result SCOPE-TAGGED, so the subagent's scope record is complete and
 *     re-projectable (a subsequent pause re-projects correctly).
 *  2/3. Re-enter the DEEPEST subagent SEEDED from its scope projection (`driveReEntryChain`)
 *     and bubble up: each completed level settles its parent `Agent` tool_use with the
 *     child's real output, then re-enters the parent (zero replay at every level), until
 *     the parent is the MAIN agent — at which point A1 settles in the main scope and
 *     orchestrateContinue drives. For DEPTH 1 the chain is a single hop (parent IS main),
 *     byte-identical to T11b.
 *
 * FAIL-LOUD (deep-HITL hardening): a scope-tagged subagent leaf is ALWAYS a
 * `tool_permission` today (subagents carry no Composio/MCP/AskUserQuestion tools, and
 * `runSubagentLoop` passes `onAuthHalt: undefined`, so `composio_auth`/`ask_question`
 * never journal in a subagent scope). A future non-`tool_permission` leaf would be
 * MIS-HANDLED by `computeLeafResult` (a `composio_auth` leaf skips the refreshConnectedApps
 * + MCP retry; an `ask_question` leaf discards the answer-is-result), so we refuse to
 * re-run it: settle an explicit, scope-tagged unsupported-kind error and re-enter the
 * subagent so it reacts and the parent settles — the resume completes, never hangs.
 *
 * FALLBACK (defensive): no journaled scope rounds (pre-T10), the `Agent` tool missing, or
 * an ALLOW whose leaf tool isn't in the rebuilt toolset → re-dispatch the `Agent` FRESH
 * (no seed = the Phase-A replay) rather than crash.
 */
async function materializeSubagentReEntry(opts: MaterializeReExecuteOptions, interrupted: boolean): Promise<void> {
  const { directive, tools, journal, outcome } = opts;
  const agentPath = directive.agentPath ?? [];
  const scopeId = subagentIdFromPath(agentPath);
  const agentTool = tools.find((t) => REEXECUTE_BOUND_TOOLS.has(t.name));

  // Without the Agent tool (or a derivable scope) we cannot re-enter — settle only the
  // row so the continue is not stranded forever (defensive: the rebuilt toolset always
  // carries the Agent tool for a subagent pause).
  if (!agentTool || scopeId === undefined) {
    await settleInteractionOnly(opts);
    return;
  }

  // An earlier delivery dispatched this leaf (or the fallback replay) and no result landed:
  // never a second run. Settle the interrupted result IN THE SUBAGENT'S SCOPE and re-enter it,
  // so the subagent re-decides (a main-scope result would orphan the scope-tagged leaf).
  // FAIL-LOUD guard (see header): never silently re-run a non-`tool_permission` leaf either.
  if (interrupted || directive.kind !== 'tool_permission') {
    if (!interrupted) {
      console.warn(
        `[deep-HITL] subagent re-entry for interaction kind "${directive.kind}" is not ` +
          'supported; settling an explicit error result (the leaf is NOT re-run).',
      );
    }
    await appendSubagentToolResultEntry(journal, agentPath, {
      toolUseId: directive.toolUseId,
      ...(interrupted
        ? EXECUTION_INTERRUPTED
        : { text: JSON.stringify({ status: 'error', reason: 'deep_hitl_reentry_unsupported_kind', kind: directive.kind }), isError: true }),
    });
    await driveReEntryChain(opts, agentTool, agentPath, {
      seedEntries: keepLastToolResultPerId(projectScope(await readAllEntries(journal), scopeId)),
    });
    return;
  }

  const scopedBefore = projectScope(await readAllEntries(journal), scopeId);
  const leafTool = tools.find((t) => t.name === directive.toolName);
  const isDeny = outcome.behavior === 'deny';

  // FALLBACK to a fresh replay when there is nothing to re-enter from, or no leaf tool to
  // re-run an ALLOW. A deny needs no leaf tool (the declined message is synthesized).
  if (scopedBefore.length === 0 || (!isDeny && !leafTool)) {
    await markReExecuteStarted(opts);
    await driveReEntryChain(opts, agentTool, agentPath, undefined);
    return;
  }

  // 1. Re-execute the paused leaf once; journal its resolved result scope-tagged.
  const leafResult = await computeLeafResult(opts, leafTool, true);
  await appendSubagentToolResultEntry(journal, agentPath, {
    toolUseId: directive.toolUseId,
    text: leafResult.text,
    isError: leafResult.isError,
    ...(leafResult.taint !== undefined && { taint: leafResult.taint }),
  });

  // 2/3. Re-enter the DEEPEST subagent SEEDED from its scope projection, then bubble up.
  // keep-last: an ancestor's deferred placeholder now lives CO-SCOPED with its tool_use
  // (journalSubagentPause), so a re-entered scope can carry BOTH the placeholder and the
  // bubbled real result for the same id — the real one must win, or the subagent's request
  // is malformed (two results for one tool_use). Identity when no id has >1 result.
  const seedEntries = keepLastToolResultPerId(projectScope(await readAllEntries(journal), scopeId));
  await driveReEntryChain(opts, agentTool, agentPath, { seedEntries });
}

/**
 * HITL world-delta (T3) — prepend the second-person child preamble to an `Agent` tool
 * input's `prompt`, IMMUTABLY (never mutate the journal's resident read-model entry).
 * Only a well-formed `{prompt: string}` input is touched; anything else passes through
 * unchanged (defensive — a malformed input still re-dispatches).
 */
function withWorldDeltaPreamble(input: unknown, worldDelta?: WorldDelta): unknown {
  if (!input || typeof input !== 'object') return input;
  const prompt = (input as { prompt?: unknown }).prompt;
  if (typeof prompt !== 'string') return input;
  return {
    ...(input as Record<string, unknown>),
    prompt: `${buildWorldDeltaChildPreamble(worldDelta?.elapsedMs)}\n\n${prompt}`,
  };
}

/**
 * Re-dispatch the `Agent` tool keyed to ONE scope (`scopeId` = the path leaf), threading
 * the live sinks + (when re-entering) the resume seed. Returns the dispatch result so the
 * caller settles the parent. `opts.originalInput` is the LEAF tool's input, so the parent
 * `Agent` tool_use input (`{subagent_type, prompt}`) is re-read from the journal here.
 */
async function dispatchAgentScope(
  opts: MaterializeReExecuteOptions,
  agentTool: RawToolOptions,
  scopeId: string,
  resume: { seedEntries: JournalEntry[] } | undefined,
): Promise<{ text: string; isError: boolean; pausedHalt?: boolean }> {
  const { journal, taskId, harness } = opts;
  const agentInput = await readToolUseInputById(journal, scopeId);
  // HITL world-delta (T3): when this resume lands long after the pause (or on a recycled
  // runner), prepend a second-person preamble to the re-spawned child's prompt so it
  // re-verifies state instead of trusting pre-pause /tmp. Below threshold → the original
  // input, byte-identical. Immutable — never mutate the journal's resident read-model.
  const dispatchInput = worldDeltaMeetsThreshold(opts.worldDelta)
    ? withWorldDeltaPreamble(agentInput, opts.worldDelta)
    : agentInput;
  return gateAndDispatchTool(
    agentTool,
    dispatchInput,
    scopeId,
    harness,
    reExecPauseSentinel,
    undefined,
    {
      markPausedHalt: () => {},
      ...(opts.pushEvent !== undefined && { pushEvent: opts.pushEvent }),
      ...(opts.addCostUsd !== undefined && { addCostUsd: opts.addCostUsd }),
      ...(opts.addChildCost !== undefined && { addChildCost: opts.addChildCost }),
      sessionId: taskId,
      // W4-2 — the shadow screen (see MaterializeReExecuteOptions).
      ...(opts.injectionScreen !== undefined && { injectionScreen: opts.injectionScreen }),
      ...(resume !== undefined && { resume }),
    },
  );
}

/**
 * T12 — the RECURSIVE forward-resume driver. Re-enter the subagent at `path` from its
 * scope projection, settle its parent `Agent` tool_use with the real output, and bubble
 * the resolution UP the ancestor chain (re-billing only forward-progress rounds at each
 * level, never replaying ancestors) until the parent is the MAIN agent.
 *
 *  - RE-PAUSE (a forward round hit a NEW gate): a FRESH interaction is now pending on its
 *    leaf. Settle ONLY the original row (once) so this scope's `Agent` tool_use stays
 *    unanswered and orchestrateContinue re-suspends.
 *  - COMPLETED, parent is MAIN (path length 1): settle the `Agent` tool_use in the MAIN
 *    scope + resolve the row → orchestrateContinue's step-3 sees no live-suspended
 *    tool_use and drives. (Depth-1 behaves EXACTLY as T11b.)
 *  - COMPLETED, parent is a SUBAGENT: settle this scope's `Agent` tool_use SCOPE-TAGGED
 *    into the parent's scope (so the parent's projection supersedes the deferred
 *    placeholder), resolve the row once, then GATE on `liveSuspendedToolUseIds` (the
 *    single whole-journal dependency check): if any tool_use is STILL suspended anywhere
 *    (an independent sibling at an ancestor level is still paused), do NOT bubble into the
 *    parent yet — it can only continue once ALL its children resolve, so we return and let
 *    step-3 re-suspend. Otherwise re-enter the parent SEEDED from its (now child-complete)
 *    scope projection.
 *
 * Bounded by `MAX_SUBAGENT_DEPTH`: `path` shrinks by one segment per recursion and the
 * recursion stops at the main parent, so it can never exceed the path length.
 */
async function driveReEntryChain(
  opts: MaterializeReExecuteOptions,
  agentTool: RawToolOptions,
  path: SubagentPathSegment[],
  resume: { seedEntries: JournalEntry[] } | undefined,
  interactionResolved = false,
): Promise<void> {
  const { directive, journal, taskId, outcome } = opts;
  const scopeId = subagentIdFromPath(path);
  if (scopeId === undefined) return; // unreachable: the caller never passes an empty path.

  const res = await dispatchAgentScope(opts, agentTool, scopeId, resume);

  const resolveRow = async (): Promise<void> => {
    if (interactionResolved) return;
    await appendResolvedInteractionEntry(
      journal, taskId, directive.interactionId, outcome, undefined, opts.userId ?? '',
    );
  };

  // RE-PAUSE: leave this scope's Agent tool_use unanswered; settle ONLY the old row.
  if (res.pausedHalt) {
    await resolveRow();
    return;
  }

  const parentPath = path.slice(0, -1);
  const parentScopeId = subagentIdFromPath(parentPath);

  // Parent is the MAIN agent → settle in the main scope; orchestrateContinue then drives.
  if (parentScopeId === undefined) {
    await appendToolResultByTaskId(
      journal, taskId, { toolUseId: scopeId, text: res.text, isError: res.isError }, opts.userId ?? '',
    );
    await resolveRow();
    // The main-scope Agent tool_use settled: its card gets the child's real output too.
    streamSettledResult(opts, scopeId, agentTool.name, res);
    return;
  }

  // Parent is a SUBAGENT → settle the child's real output scope-tagged into the parent's
  // scope (keep-last supersedes the deferred placeholder there), then resolve the row once.
  await appendSubagentToolResultEntry(journal, parentPath, {
    toolUseId: scopeId, text: res.text, isError: res.isError,
  });
  await resolveRow();

  // SIBLING GATE (the dependency model): the parent can only re-enter once ALL of its
  // pending children (any depth in ITS subtree) resolve. The whole-journal
  // `liveSuspendedToolUseIds` (kept depth-blind) is the single source — we INTERSECT it
  // with the parent's subtree (its scope + descendants) so an independent sibling paused
  // at a DEEPER, unrelated branch doesn't block this bubble. A still-suspended tool_use in
  // the parent's subtree ⇒ re-suspend (orchestrateContinue's step-3 then re-suspends).
  const all = await readAllEntries(journal);
  const suspended = liveSuspendedToolUseIds(all);
  if (suspended.size > 0) {
    const paths = toolUsePathsById(all);
    if ([...suspended].some((id) => isWithinScope(paths.get(id) ?? [], parentPath))) return;
  }

  // Re-enter the parent SEEDED from its now-child-complete scope projection (zero replay).
  // keep-last drops the child's deferred placeholder (now co-scoped here) so the bubbled
  // real result is the only one for that id (see materializeSubagentReEntry).
  await driveReEntryChain(
    opts, agentTool, parentPath,
    { seedEntries: keepLastToolResultPerId(projectScope(all, parentScopeId)) },
    true,
  );
}
