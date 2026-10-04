/**
 * hook-parity.ts — X1 (harness to nine): the native arm answers hooks the way the Claude
 * Code hooks reference documents them, behind HOOK_PARITY_V1.
 *
 * Each helper is one documented behaviour the tool dispatcher or the loop asks about, and
 * each answers "nothing to do" while the flag is off, so every call site stays
 * byte-identical off. Source of truth: https://code.claude.com/docs/en/hooks (fetched
 * 2026-09-30, covering Claude Code up to v2.1.274). The fixtures and every named exception
 * (a documented behaviour the native arm does not match, and why) live in
 * kernel/hooks/__tests__/fixtures/claude-code-hook-events.ts.
 *
 * PER-CALL ONLY: nothing here holds state between calls (one process serves many sessions).
 */

import type { GateResult, HarnessContext, ToolCall } from '../contract/harness.js';
import type { TurnOutcome } from '../contract/turn-outcome.js';
import type { HarnessEvent } from '../contract/events.js';
import type { JournalEntry } from '../contract/journal.js';
import type { Journal } from '../kernel/index.js';
import type { NativeConfigLike } from './native-config-like.js';
import { appendInjectedUserEntry } from './native-journal.js';
import {
  CompactionPlanError,
  compactionFailureReason,
  type HookDispatcher,
  type HookOutcome,
  type PermissionRequestHookInput,
} from '../kernel/index.js';
import { isLadderBypassedAsk } from '../policy/decide-tool-gate.js';
import { hookParityEnabled } from '../policy/feature-flags.js';
import { buildNotificationInput, buildSessionStartInput, continueContext, dispatchLifecycle } from './native-hooks.js';

/**
 * A `tool_permission` card is about to show. Returns the verdict that replaces the card,
 * or undefined when the card shows as it would have — in which case the
 * `permission_prompt` Notification has just fired (observers only: its output cannot stop
 * or change the card).
 *
 * The PermissionRequest chain answers FOR the person: `deny` refuses the tool with its
 * message; `allow` runs it. An `allow` whose input is not the one the floor judged is
 * re-gated first (documented: "the modified input is re-evaluated against deny and ask
 * rules"): a deny stands, a card for the new input keeps the ORIGINAL card (the approval
 * re-runs the journaled call, so the card must be for that call), only an allow runs it.
 * A halt is not an answer.
 *
 * A hook may silence a card only where a standing allow rule could. So the chain never
 * runs for an `unsilenceable` card (the person's own ask rules, and the hard floor:
 * payments and dangerous deletes, decide-tool-gate.ts) nor for a ladder-bypassed ask
 * (release_browser, os_takeover): the card shows and the Notification fires.
 *
 * A `deny` with `interrupt: true` also stops the agent (documented): `{ stop }`. The call is
 * refused like any deny and the turn then ends as `hook_blocked` with the hook's message
 * (hookStopOutcome), never as a pause: no one is being asked anything.
 */
export async function resolvePermissionCard(
  call: ToolCall,
  input: unknown,
  harness: { gateTool(call: ToolCall): Promise<GateResult> },
  dispatcher: HookDispatcher,
  signal: AbortSignal,
  sessionId: string,
  unsilenceable: boolean,
): Promise<GateResult | { stop: string } | undefined> {
  if (!hookParityEnabled()) return undefined;
  const answer = unsilenceable || isLadderBypassedAsk(call.toolName)
    ? undefined
    : await answerPermissionRequest(call, input, harness, dispatcher, signal, sessionId);
  if (answer === undefined) {
    await dispatchLifecycle(
      dispatcher,
      buildNotificationInput(`Needs your permission to use ${call.toolName}`, 'permission_prompt', 'Permission needed'),
      signal,
      sessionId,
    );
  }
  return answer;
}

async function answerPermissionRequest(
  call: ToolCall,
  input: unknown,
  harness: { gateTool(call: ToolCall): Promise<GateResult> },
  dispatcher: HookDispatcher,
  signal: AbortSignal,
  sessionId: string,
): Promise<GateResult | { stop: string } | undefined> {
  const out = await dispatcher.dispatch('PermissionRequest', buildPermissionRequestInput(call.toolName, input, sessionId), { signal });
  if (out.decision !== 'continue') return undefined;
  if (out.permissionDecision === 'deny' && out.interrupt === true) return { stop: out.permissionDecisionReason ?? 'Stopped by a hook.' };
  if (out.permissionDecision === 'deny') return { decision: 'deny', message: out.permissionDecisionReason ?? 'Denied.' };
  if (out.permissionDecision !== 'allow') return undefined;
  const runInput = out.updatedInput ?? input;
  if (runInput === call.toolInput) return { decision: 'allow' };
  const gate = await harness.gateTool({ ...call, toolInput: runInput });
  if (gate.decision === 'needs_human') return undefined;
  return gate.decision === 'allow' ? { decision: 'allow', updatedInput: gate.updatedInput ?? runInput } : gate;
}

/** The PermissionRequest input: PreToolUse's tool fields WITHOUT `tool_use_id`, as documented. */
export function buildPermissionRequestInput(toolName: string, toolInput: unknown, sessionId: string): PermissionRequestHookInput {
  return {
    session_id: sessionId,
    cwd: process.cwd(),
    transcript_path: '',
    hook_event_name: 'PermissionRequest',
    tool_name: toolName,
    tool_input: toolInput,
  };
}

/** PreToolUse: the deprecated top-level `decision:"block"` maps to deny (documented), so the
 *  one tool is refused and the turn goes on. Off: every halt stops the turn, as today. */
export function preToolUseBlockIsDeny(pre: HookOutcome): boolean {
  return pre.decision === 'halt' && pre.blocked === true && hookParityEnabled();
}

/**
 * PreToolUse / PostToolUse: a hook's `additionalContext` reaches the model "alongside the tool
 * result" (documented), joined onto the trailer after any block reason, outside any untrusted
 * fence. A contained hook never carries one (contained-hooks.ts drops it). Off: unchanged.
 */
export function withHookContext(trailer: string | null, context: string | undefined): string | null {
  const said = context?.trim();
  if (!said || !hookParityEnabled()) return trailer;
  return trailer === null ? said : `${trailer}\n${said}`;
}

/** PostToolUse: a block (or exit 2) cannot undo a tool that already ran; its reason rides
 *  beside the result, joined onto the tool's own trailer. Off: the trailer, unchanged. */
export function withPostToolUseFeedback(trailer: string | null, post: HookOutcome): string | null {
  if (post.decision !== 'halt' || post.blocked !== true || !post.stopReason || !hookParityEnabled()) return trailer;
  return trailer === null ? post.stopReason : `${trailer}\n${post.stopReason}`;
}

/**
 * Stop: what the next forced iterate-turn is told, or undefined to finish the turn. A hook's
 * `additionalContext` re-feeds (today's behaviour). X1: a `decision:"block"` (or exit 2)
 * prevents stopping, its reason becoming the next instruction; `continue:false` still stops.
 * Off: every halt finishes the turn, as today. On: only a COMPLETED turn is ever re-fed; a
 * turn that ended at max_turns or on an error is never extended by a Stop hook (each
 * continuation would start a fresh max_turns loop and bill it).
 */
export function stopContinuation(stop: HookOutcome, completed = true): string | undefined {
  if (!completed && hookParityEnabled()) return undefined;
  if (stop.decision === 'continue') return continueContext(stop);
  const reason = stop.blocked === true && hookParityEnabled() ? stop.stopReason?.trim() : undefined;
  return reason ? reason : undefined;
}

/**
 * Mirrors `EVENTS.AGENT_HOOK_STOP_CONTINUED` in @bash/shared (the engine imports no
 * @bash/*; a sandbox test pins the two equal). Server-consumed, never forwarded.
 */
export const HOOK_STOP_CONTINUED_EVENT = 'agent:hook_stop_continued';

/**
 * Stop: the signal for a continuation a hook's block forced (HOOK_PARITY_V1), yielded as
 * the loop drives the extra round, so the rounds it bills are never silent: the server
 * records why the agent kept going. An `additionalContext` re-feed (today's path) and
 * flag off yield nothing.
 */
export function* stopContinuedEvent(stop: HookOutcome, n: number, taskId: string): Generator<HarnessEvent> {
  if (stop.decision !== 'halt' || stop.stopReason === undefined) return;
  yield { kind: 'raw', engine: 'native', event: HOOK_STOP_CONTINUED_EVENT, data: { taskId, n, reason: stop.stopReason.trim().slice(0, 500) } };
}

/**
 * SessionStart's `source`: "resume" when the run opens on a conversation that already holds a
 * reply (a later message, a card's answer, a wake), else "startup". Off: always "startup".
 * The native arm has no `/clear` (a fresh conversation is a new task, so "startup") and no
 * fork yet (R3), so those two sources never occur.
 */
export function sessionStartSource(opened: readonly JournalEntry[]): 'startup' | 'resume' {
  return hookParityEnabled() && opened.some((e) => e.payload.type === 'assistant') ? 'resume' : 'startup';
}

/**
 * After a compaction the conversation starts again from the summary, so SessionStart fires
 * with source "compact" (documented; Codex queues the same, codex-rs/core/src/session/mod.rs).
 * With `keep` (a turn resumes after the cut), the context its hooks add is journaled as a
 * hook entry for the next call. Without it (`/compact`, a control turn that ends at once) the
 * hooks still fire but their words are not kept: a hook paragraph would otherwise be the last
 * user-role entry and merge into the person's next message, the shape the continuation marker
 * is withheld from on `/compact` for the same reason. Returns the context. Off: nothing fires.
 */
export async function sessionStartAfterCompaction(
  dispatcher: HookDispatcher,
  signal: AbortSignal,
  sessionId: string,
  keep?: { journal: Journal; ctx: HarnessContext<NativeConfigLike> },
): Promise<string | undefined> {
  if (!hookParityEnabled()) return undefined;
  const said = continueContext(await dispatchLifecycle(dispatcher, buildSessionStartInput('compact'), signal, sessionId));
  if (said && keep) await appendInjectedUserEntry(keep.journal, keep.ctx, said, 'hook');
  return said;
}

/** SessionEnd's `reason`: the documented "other" (the run's input drained). Off: "input_exhausted". */
export function sessionEndReason(): string {
  return hookParityEnabled() ? 'other' : 'input_exhausted';
}

/**
 * PreCompact: a block (`decision:"block"` or exit 2) refuses the compaction (documented:
 * "Blocks compaction"); returns its reason, or undefined to compact. `continue:false` (the
 * reference: "abort compaction, but that stops Claude entirely") is NOT honoured: the
 * compaction proceeds and the turn is not stopped, a named exception
 * (PRE_COMPACT_CONTINUE_FALSE_COMPACTS). Off: never blocks (today's path compacts).
 */
export function preCompactBlock(pre: HookOutcome): string | undefined {
  if (pre.decision !== 'halt' || pre.blocked !== true || !hookParityEnabled()) return undefined;
  return pre.stopReason?.trim() || 'A hook blocked the compaction.';
}

/**
 * Throw the named refusal a blocked compaction ends in (`hook_blocked`, the hook's reason as
 * the message), so the compaction site handles it as any refusal: the proactive trigger skips
 * and the conversation goes on uncompacted (asked again on the retry bound's clock), a warm
 * `/compact` says why. On a `recovery` (the provider already refused the request) a block is
 * logged and the compaction proceeds: Claude Code falls back to a smaller model or the
 * person's `/delete` there, the box has neither, and an honoured block would kill every later
 * turn at the context limit. No-op unless {@link preCompactBlock}.
 */
export function refuseIfPreCompactBlocked(pre: HookOutcome, recovery = false): void {
  const reason = preCompactBlock(pre);
  if (reason === undefined) return;
  if (recovery) {
    console.warn(`[hooks] a PreCompact hook blocked a context-limit recovery; compacting anyway: ${reason.slice(0, 200)}`);
    return;
  }
  throw new CompactionPlanError('hook_blocked', reason);
}

/** A warm `/compact` a PreCompact hook blocked shows the hook's reason (documented: "the stderr
 *  message is shown to the user"); undefined for every other refusal. */
export function blockedCompactionNotice(err: unknown): string | undefined {
  return compactionFailureReason(err) === 'hook_blocked' ? (err as Error).message : undefined;
}

/**
 * SubagentStart: the words a hook adds to the helper's context "at the start of its
 * conversation, before its first prompt", or undefined. Off: none (the dispatch stays an
 * observer, as today).
 */
export function subagentStartContext(start: HookOutcome): string | undefined {
  return hookParityEnabled() ? continueContext(start) : undefined;
}

/**
 * SubagentStop: what the helper is told next instead of stopping (a block's reason, or an
 * `additionalContext`), or undefined to let it stop; the same rule as {@link stopContinuation}.
 * Off: undefined (SubagentStop observes, as today).
 */
export function subagentStopContinuation(stop: HookOutcome): string | undefined {
  return hookParityEnabled() ? stopContinuation(stop) : undefined;
}

/** The Notification types the native arm sources (X1). `permission_prompt` lives in
 *  {@link resolvePermissionCard}; these two are the MCP question card's (X5). */
export type NativeNotificationType = 'elicitation_dialog' | 'elicitation_response';

/**
 * Fire a Notification hook (observers only: its output cannot change anything, as
 * documented). Off: nothing fires. Never throws.
 */
export async function notifyHooks(
  dispatcher: HookDispatcher | undefined,
  signal: AbortSignal,
  sessionId: string,
  n: { type: NativeNotificationType; message: string; title: string },
): Promise<void> {
  if (dispatcher === undefined || !hookParityEnabled()) return;
  await dispatchLifecycle(dispatcher, buildNotificationInput(n.message, n.type, n.title), signal, sessionId);
}

/**
 * The turn a hook stopped (a PermissionRequest deny with `interrupt: true`): ends as the
 * `hook_blocked` stop the server already files as stopped ("Blocked by policy"), carrying
 * the hook's message, so the person sees why; never the paused shape a card leaves.
 */
export function hookStopOutcome(reason: string): TurnOutcome {
  return { kind: 'hook_blocked', hookKind: 'other', stopReason: reason, raw: { subtype: 'hook_interrupt', errors: [] } };
}

/**
 * The most forced continuations a Stop hook (and, per helper, a SubagentStop hook) may buy
 * (Claude Code allows eight; each one is a paid model call). One constant for both sites.
 */
export const MAX_STOP_CONTINUE = 3;
