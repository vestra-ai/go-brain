/**
 * K6-P2 B2 — native-arm hook registration.
 *
 * Creates the per-run {@link HookDispatcher} and registers the SECURITY FLOOR:
 * the existing `harness.gateTool` (→ `decideToolGate` → security → capability →
 * classifier) wrapped as the FIRST `PreToolUse` matcher. Its {@link GateResult}
 * translates into a `PreToolUse` permission decision so the native loop routes
 * allow/deny/needs_human through the SAME hook surface the 11 SDK callbacks use.
 *
 * SCOPE FENCE (B2): only the floor is registered here. The other 11 PreToolUse
 * callbacks + the PostToolUse/PostToolUseFailure callbacks (screenshot-prune,
 * composio-failure, notification, …) are ported by Task B5 via `registerNativeHooks`
 * — this module is that registration SEAM, not the port. Floor-only behavior MUST
 * be byte-identical to today's direct `gateTool` gating (the gate-parity +
 * conformance suites are the proof).
 *
 * The floor maps GateResult → permissionDecision:
 *   - allow       → 'allow'  (carries `updatedInput` if the gate rewrote args)
 *   - deny        → 'deny'   (`message` carried on `permissionDecisionReason`)
 *   - needs_human → 'ask'    (`interactionKind` carried on `permissionDecisionReason`)
 *
 * The loop (gateAndDispatchTool) reads the folded {@link HookOutcome} back and
 * reconstructs today's behavior: 'deny' → error tool_result with the reason;
 * 'ask' → the onPause(call, kind) pause path; 'allow' → execute (with updatedInput).
 *
 * ring 4c.3 — relocated into `@vestra/agent-sdk/engine`. The SDK reads NO
 * environment: the per-run `session_id` is INJECTED at the single
 * `dispatchLifecycle` chokepoint — the run's own `HarnessContext.sessionId`, never a
 * process-wide value (one runner serves many sessions; the env SESSION_ID is the one
 * that started it). `process.cwd()` stays — it is a node
 * runtime primitive (NOT env config; it returns the process CWD, e.g. `/app`,
 * which differs from `WORKING_DIR` by design, so rebinding it would change the
 * hook-input `cwd` byte-for-byte).
 */

import type { GateResult, ToolCall } from '../contract/harness.js';
import type { HarnessEvent } from '../contract/events.js';
import {
  HookDispatcher,
  type HookCallback,
  type HookExecutionEvent,
  type HookOutcome,
  type PreToolUseHookInput,
  type PostToolBatchHookInput,
  type PostToolBatchToolCall,
  type NotificationHookInput,
  type StopHookInput,
  type SubagentStartHookInput,
  type SubagentStopHookInput,
  type SubagentStopStatus,
  type PreCompactHookInput,
  type PostCompactHookInput,
  type UserPromptSubmitHookInput,
  type SessionStartHookInput,
  type SessionEndHookInput,
  type SyncHookJSONOutput,
} from '../kernel/index.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hookParityEnabled } from '../policy/feature-flags.js';

/**
 * The product socket-event name a routed notification carries. Kept as a literal
 * here (NOT imported from the product `EVENTS` vocabulary) because the SDK
 * contract intentionally stays free of Vestra's socket-event constants — the
 * `raw` HarnessEvent's `event` field is a plain `string` (see contract/events.ts:
 * "the SDK contract stays free of Vestra's product socket-event vocabulary").
 * This literal is byte-identical to `EVENTS.AGENT_NOTIFICATION`.
 */
const AGENT_NOTIFICATION_EVENT = 'agent:notification';

/** The minimal harness slice the floor consults — exactly `gateTool`. */
export type GateFloorHarness = { gateTool(call: ToolCall): Promise<GateResult> };

/**
 * Translate a {@link GateResult} into a `PreToolUse` hook output. PURE + TOTAL:
 * every GateResult branch yields a `permissionDecision`, carrying the gate's
 * model-visible payload (deny `message` / needs_human `interactionKind`) on
 * `permissionDecisionReason` so the loop reconstructs byte-identical behavior.
 */
export function gateFloorToOutput(gate: GateResult): SyncHookJSONOutput {
  if (gate.decision === 'deny') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: gate.message,
        // K6-P3-C7: carry the deny ladder-stage classifier through the floor →
        // HookOutcome → the PERMISSION_DENIED event (observability). Omitted when
        // the gate set no reasonType (additive; byte-identical to pre-C7).
        ...(gate.reasonType !== undefined && { permissionDecisionReasonType: gate.reasonType }),
      },
    };
  }
  if (gate.decision === 'needs_human') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        // Carry the interactionKind so the loop reconstructs onPause(call, kind).
        permissionDecisionReason: gate.interactionKind,
        // X1: an ask no allow rule can silence rides as the reserved 'floor' stage, so
        // no hook answers the card for the person (engine/tool-gate-verdict.ts).
        ...(gate.unsilenceable === true && { permissionDecisionReasonType: 'floor' }),
      },
    };
  }
  // allow — carry the gate's input rewrite (inlineToolArgRewrite) when present.
  const out: SyncHookJSONOutput = {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
  };
  if (gate.updatedInput !== undefined && out.hookSpecificOutput?.hookEventName === 'PreToolUse') {
    out.hookSpecificOutput.updatedInput = gate.updatedInput as Record<string, unknown>;
  }
  return out;
}

/**
 * The security-floor callback: re-derives the ToolCall from the PreToolUse input
 * and consults `harness.gateTool`, returning the translated permission decision.
 * Registered as the FIRST PreToolUse matcher so it ALWAYS runs first (security
 * wins); B5's callbacks register AFTER it.
 */
export function buildGateFloorHook(harness: GateFloorHarness): HookCallback {
  return async (input): Promise<SyncHookJSONOutput> => {
    // The floor only speaks for tool events. A non-PreToolUse input never reaches
    // here (it's registered only on PreToolUse), but guard defensively → fall through.
    if (input.hook_event_name !== 'PreToolUse') return {};
    const pre = input as PreToolUseHookInput;
    const call: ToolCall = {
      toolName: pre.tool_name,
      toolInput: pre.tool_input,
      toolCallId: pre.tool_use_id,
    };
    const gate = await harness.gateTool(call);
    return gateFloorToOutput(gate);
  };
}

/**
 * K6-P2 B4 — build the HOST observer the kernel dispatcher calls around each hook
 * callback. The kernel is clock-free + sink-blind: it hands us provider-neutral
 * {@link HookExecutionEvent}s; HERE (the sandbox host) we stamp `durationMs` (this
 * is the only place a wall clock is allowed) and map each to a `hook`
 * {@link HarnessEvent} routed through `emitHookEvent` — the host's closure over the
 * ONE K3 sink (`emitHarnessEvent`). NO new direct socket emit: the observer→sink
 * path is the only route (the arm-no-streaming-emit lint wall stays green).
 *
 * Duration: stamped from a per-observer `Map<hookId, startMs>`. `started` records
 * the start; the terminal phase (completed/error/cancelled) reads + clears it and
 * stamps the elapsed ms. The `started` event itself carries no duration.
 */
export function buildHookExecutionObserver(
  emitHookEvent: (ev: HarnessEvent) => void,
  now: () => number = () => Date.now(),
): (ev: HookExecutionEvent) => void {
  const starts = new Map<string, number>();
  return (ev: HookExecutionEvent): void => {
    if (ev.phase === 'started') {
      starts.set(ev.hookId, now());
      emitHookEvent({
        kind: 'hook',
        hookId: ev.hookId,
        hookEvent: ev.hookEvent,
        ...(ev.matcher !== undefined ? { matcher: ev.matcher } : {}),
        phase: 'started',
      });
      return;
    }
    // Terminal phase — stamp the elapsed ms (if we saw the start) and clear it.
    const startedAt = starts.get(ev.hookId);
    starts.delete(ev.hookId);
    const out: Extract<HarnessEvent, { kind: 'hook' }> = {
      kind: 'hook',
      hookId: ev.hookId,
      hookEvent: ev.hookEvent,
      ...(ev.matcher !== undefined ? { matcher: ev.matcher } : {}),
      phase: ev.phase,
    };
    if (startedAt !== undefined) out.durationMs = Math.max(0, now() - startedAt);
    if (ev.error !== undefined) out.error = ev.error;
    emitHookEvent(out);
  };
}

/**
 * Create the per-run native HookDispatcher with the security floor registered as
 * the FIRST PreToolUse matcher. Per-run (NOT global) so each native run owns its
 * dispatcher — matching the multi-session model (a global would leak state across
 * concurrent sessions in the shared sandbox process).
 *
 * K6-P2 B4: when `emitHookEvent` is supplied (the host's gated sink closure — only
 * present with the includeHookEvents flag ON), the dispatcher is constructed with a
 * HOST observer that maps each callback's phase transitions to a `hook` HarnessEvent
 * through that sink. ABSENT (flag OFF, the default) → no observer → the dispatcher
 * makes zero observability calls → byte-identical.
 *
 * B5 will extend this with `registerNativeHooks(dispatcher, …)` to add the 11
 * ported callbacks AFTER the floor; here only the floor is registered.
 *
 * X1 (HOOK_PARITY_V1): matchers are read the way the Claude Code hooks reference reads
 * them (HookDispatcherOptions.claudeCodeMatchers), and a hook's oversized added context is
 * saved to a file under the run's task (makeHookContextSpill). Off: neither, byte-identical.
 */
export function createNativeHookDispatcher(
  harness: GateFloorHarness,
  emitHookEvent?: (ev: HarnessEvent) => void,
  where?: { workingDir?: string | undefined; taskId: string },
): HookDispatcher {
  const dispatcher = new HookDispatcher({
    ...(emitHookEvent !== undefined && { onHookExecution: buildHookExecutionObserver(emitHookEvent) }),
    ...(hookParityEnabled() && { claudeCodeMatchers: true, spillContext: makeHookContextSpill(where) }),
  });
  dispatcher.register('PreToolUse', {}, buildGateFloorHook(harness));
  return dispatcher;
}

/** X1: the most of one hook's added context the model reads whole (the Claude Code reference's 10,000). */
export const HOOK_CONTEXT_MAX_CHARS = 10_000;
/** X1: how much of an oversized one it reads instead, beside the path to the rest. */
export const HOOK_CONTEXT_PREVIEW_CHARS = 2_000;

/**
 * X1 (HOOK_PARITY_V1): one hook's added context over HOOK_CONTEXT_MAX_CHARS is written in full
 * to the task's offload folder (`.kernel-offload/<taskId>/`, where an oversized tool result
 * goes) and replaced by its first HOOK_CONTEXT_PREVIEW_CHARS characters and the file's path,
 * the reference's rule ("writes the text to a file ... passes Claude the file path with a
 * preview of up to the first 2,000 characters"). Codex caps it the same way, at 2,500 tokens
 * (codex-rs/hooks/src/output_spill.rs). With no working directory, or a failed write, the
 * preview alone, saying how much was cut. Synchronous: the kernel's fold is. Per dispatcher:
 * the counter is the only state.
 */
export function makeHookContextSpill(where?: { workingDir?: string | undefined; taskId: string }): (text: string) => string {
  let n = 0;
  return (text) => {
    if (text.length <= HOOK_CONTEXT_MAX_CHARS) return text;
    const head = text.slice(0, HOOK_CONTEXT_PREVIEW_CHARS);
    const cut = `[hook output cut: ${text.length} characters, the first ${HOOK_CONTEXT_PREVIEW_CHARS} shown`;
    if (!where?.workingDir) return `${head}\n${cut}]`;
    const path = resolve(where.workingDir, '.kernel-offload', where.taskId, `hook-context-${Date.now()}-${++n}.txt`);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, 'utf8');
    } catch {
      return `${head}\n${cut}]`;
    }
    return `${head}\n${cut}; the full text is in ${path}]`;
  };
}

// =============================================================================
// K6-P2 B3 — TURN / SESSION / COMPACTION lifecycle dispatch helpers.
//
// Thin, pure builders for the lifecycle hook inputs + a single `dispatchLifecycle`
// the native loop calls at each seam. Centralized here (next to the dispatcher
// factory) so native-harness.ts stays a loop, not a hook-plumbing file, and so the
// SDK-compat `transcript_path` placeholder + `session_id` derivation live in ONE
// place. Every builder sets `transcript_path: ''` (the kernel reaches history via
// the journal, never a file) — see contract.ts header.
// =============================================================================

/**
 * The fields every lifecycle input shares (mirrors the tool-event builders).
 *
 * ring 4c.3 — `session_id` is a PLACEHOLDER (`''`) here; the run's own session id
 * (`HarnessContext.sessionId`) is injected at the single `dispatchLifecycle`
 * chokepoint.
 * `cwd` keeps `process.cwd()` verbatim (a node runtime primitive, not env config).
 */
function lifecycleBase(): { session_id: string; cwd: string; transcript_path: string } {
  return { session_id: '', cwd: process.cwd(), transcript_path: '' };
}

/** Run a lifecycle dispatch with no tool id (lifecycle events carry none). The
 *  signal races every callback (per-run abort). Never throws (the dispatcher
 *  isolates callback errors); absent callbacks → a no-field `continue` outcome.
 *
 *  ring 4c.3 — `sessionId` is injected here (the single chokepoint) and overwrites
 *  the builder's `session_id: ''` placeholder BEFORE dispatch. Callers pass the
 *  run's own `ctx.sessionId` (the task id); a process-wide value here would stamp
 *  the runner-starting session onto every parallel session's hooks. */
export function dispatchLifecycle(
  dispatcher: HookDispatcher,
  input:
    | PostToolBatchHookInput
    | NotificationHookInput
    | StopHookInput
    | SubagentStartHookInput
    | SubagentStopHookInput
    | PreCompactHookInput
    | PostCompactHookInput
    | UserPromptSubmitHookInput
    | SessionStartHookInput
    | SessionEndHookInput,
  signal: AbortSignal,
  sessionId: string,
): Promise<HookOutcome> {
  const withSession = { ...input, session_id: sessionId };
  return dispatcher.dispatch(withSession.hook_event_name, withSession, { signal });
}

export function buildSessionStartInput(source: SessionStartHookInput['source']): SessionStartHookInput {
  return { ...lifecycleBase(), hook_event_name: 'SessionStart', source };
}

export function buildSessionEndInput(reason: string): SessionEndHookInput {
  return { ...lifecycleBase(), hook_event_name: 'SessionEnd', reason };
}

export function buildUserPromptSubmitInput(prompt: string): UserPromptSubmitHookInput {
  return { ...lifecycleBase(), hook_event_name: 'UserPromptSubmit', prompt };
}

/** `stop_hook_active` is true on a FORCED continuation (a prior Stop re-fed
 *  context). The Stop hook reads it to self-limit — the SDK's own loop-guard. */
export function buildStopInput(stopHookActive: boolean, lastAssistantMessage?: string): StopHookInput {
  const input: StopHookInput = {
    ...lifecycleBase(),
    hook_event_name: 'Stop',
    stop_hook_active: stopHookActive,
  };
  if (lastAssistantMessage !== undefined) input.last_assistant_message = lastAssistantMessage;
  return input;
}

/**
 * K6-P2 B3b — SubagentStart input. Fired on the PARENT run's dispatcher when a
 * subagent is spawned (the parent OBSERVES the child; this is NOT the child's own
 * SessionStart). `agent_id` is a per-subagent id the host mints; `agent_type` is
 * the agent's slug — it doubles as the dispatcher's MATCHER KEY so a B6 hook can
 * filter on a specific agent. `agent_id` is ALSO threaded onto the BASE input so a
 * hook firing inside the child detects subagent-context via `agent_id` PRESENCE.
 */
export function buildSubagentStartInput(agentId: string, agentType: string): SubagentStartHookInput {
  return {
    ...lifecycleBase(),
    agent_id: agentId,
    agent_type: agentType,
    hook_event_name: 'SubagentStart',
  };
}

/**
 * K6-P2 B3b — SubagentStop input. Fired on the PARENT run's dispatcher when the
 * subagent finishes. `status` is HOW it ended; `durationMs` is the child's
 * wall-clock STAMPED BY THE HOST (the Agent tool, never the kernel). Carries the
 * same `agent_id`/`agent_type` as the matching Start (correlation + matcher key)
 * and an optional `child_summary` (the child's last answer, when readily available).
 * `stop_hook_active:false` — the native subagent runner has no Stop re-feed loop.
 */
export function buildSubagentStopInput(args: {
  agentId: string;
  agentType: string;
  status: SubagentStopStatus;
  durationMs: number;
  childSummary?: string;
}): SubagentStopHookInput {
  const input: SubagentStopHookInput = {
    ...lifecycleBase(),
    agent_id: args.agentId,
    agent_type: args.agentType,
    hook_event_name: 'SubagentStop',
    stop_hook_active: false,
    status: args.status,
    duration_ms: args.durationMs,
  };
  if (args.childSummary !== undefined) {
    input.child_summary = args.childSummary;
    input.last_assistant_message = args.childSummary;
  }
  return input;
}

export function buildPostToolBatchInput(toolCalls: PostToolBatchToolCall[]): PostToolBatchHookInput {
  return { ...lifecycleBase(), hook_event_name: 'PostToolBatch', tool_calls: toolCalls };
}

export function buildNotificationInput(
  message: string,
  notificationType: string,
  title?: string,
): NotificationHookInput {
  const input: NotificationHookInput = {
    ...lifecycleBase(),
    hook_event_name: 'Notification',
    message,
    notification_type: notificationType,
  };
  if (title !== undefined) input.title = title;
  return input;
}

export function buildPreCompactInput(
  trigger: PreCompactHookInput['trigger'],
  customInstructions: string | null = null,
): PreCompactHookInput {
  return { ...lifecycleBase(), hook_event_name: 'PreCompact', trigger, custom_instructions: customInstructions };
}

export function buildPostCompactInput(
  trigger: PostCompactHookInput['trigger'],
  compactSummary: string,
): PostCompactHookInput {
  return { ...lifecycleBase(), hook_event_name: 'PostCompact', trigger, compact_summary: compactSummary };
}

/**
 * K6-P2 B3 — Notification routing. Routes a notification THROUGH the per-run
 * dispatcher (a Notification hook can observe/transform/SUPPRESS it) and returns a
 * SINGLE `raw` AGENT_NOTIFICATION HarnessEvent for the LOOP to YIELD — the core
 * sink does the actual socket emit (K3 invariant: the arm is socket-blind; it
 * never calls socket.emit directly, it yields a `raw` event the sink emits, exactly
 * as the native compaction does for SESSION_COMPACTED).
 *
 * - A `halt` outcome (a Notification hook returning continue:false / block)
 *   SUPPRESSES the notification → returns null (the loop yields nothing).
 * - `additionalContext` is appended to the message (a hook can augment it).
 * - With NO Notification callback the chain folds to a no-field continue → the
 *   notification passes through unchanged.
 *
 * There is NO live caller in the native loop today (the native arm has no
 * notification source yet — the Claude SDK arm owns the only notification emit,
 * in hooks/index.ts) → this is a pure SEAM. B5/B6 wire the source (e.g. a
 * long-running-tool nudge) and yield the returned event. Lives here, next to the
 * input builders, so native-harness.ts stays loop-only.
 *
 * ring 4c.3 — this seam has no live caller, so its `session_id` carries the
 * placeholder (`''`); the routed `raw` event carries no session_id field anyway.
 */
export async function routeNotification(
  dispatcher: HookDispatcher,
  signal: AbortSignal,
  args: { message: string; notificationType: string; title?: string; taskId: string },
): Promise<HarnessEvent | null> {
  const outcome = await dispatcher.dispatch(
    'Notification',
    buildNotificationInput(args.message, args.notificationType, args.title),
    { signal },
  );
  if (outcome.decision === 'halt') return null; // a hook suppressed it
  const extra =
    outcome.additionalContext && outcome.additionalContext.trim()
      ? outcome.additionalContext.trim()
      : undefined;
  return {
    kind: 'raw',
    engine: 'native',
    event: AGENT_NOTIFICATION_EVENT,
    data: {
      taskId: args.taskId,
      type: args.notificationType,
      title: args.title,
      message: extra ? `${args.message}\n${extra}` : args.message,
    },
  };
}

/**
 * Extract a `continue` outcome's non-empty `additionalContext`. Returns undefined on a
 * `halt` or absent/blank context. The load-bearing guard: only a hook that actually
 * returned context triggers the SessionStart prepend / UserPromptSubmit augment / Stop
 * re-feed / PreCompact operator instructions.
 *
 * Lives here (with the lifecycle-input builders it is always paired with) rather than in
 * native-harness.ts so the compaction body can read a PreCompact hook's context without
 * importing the loop file back.
 */
export function continueContext(outcome: HookOutcome): string | undefined {
  if (outcome.decision !== 'continue') return undefined;
  const ctx = outcome.additionalContext?.trim();
  return ctx ? ctx : undefined;
}
