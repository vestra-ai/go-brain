/**
 * tool-gate-verdict.ts — the PreToolUse verdict for one native tool call: the hook chain
 * (whose first callback is the security floor, `createNativeHookDispatcher`) or, with no
 * dispatcher, the legacy direct gate, folded into the one decision `gateAndDispatchTool`
 * acts on. Moved out of tool-dispatcher.ts verbatim (R3 file-size ratchet), plus the
 * X1 (HOOK_PARITY_V1) steps, all no-ops while the flag is off:
 *  - a hook's rewrite of an allowed call is re-gated on the rewritten input;
 *  - a permission card about to show may be answered by a PermissionRequest hook (a deny
 *    with `interrupt: true` refuses the call and stops the turn: `{ stop }`);
 *  - a hook's `additionalContext` is carried out to ride beside the tool result.
 * Per-call only: no module state.
 */

import type { HookDispatcher, PreToolUseHookInput } from '../kernel/index.js';
import type { GateResult, ToolCall } from '../contract/harness.js';
import { hookParityEnabled } from '../policy/feature-flags.js';
import { preToolUseBlockIsDeny, resolvePermissionCard } from './hook-parity.js';

/**
 * K6-P3-C7 — the deny `reasonType` carried onto PERMISSION_DENIED. Mirrors the
 * (optional) field on GateResult's deny branch.
 */
export type DenyReasonType = NonNullable<Extract<GateResult, { decision: 'deny' }>['reasonType']>;

export interface ToolGateVerdict {
  decision: 'allow' | 'deny' | 'ask' | 'defer';
  denyMessage?: string;
  pauseKind?: string;
  effInput: unknown;
  // K6-P3-C7: forward the deny ladder-stage (security/capability/rule/mode/floor)
  // so the caller can stamp it onto PERMISSION_DENIED. Undefined on allow/ask.
  denyReasonType?: DenyReasonType;
  /** X1: an ask no allow rule can silence (GateResult `unsilenceable`). */
  unsilenceable?: true;
  /** X1 (HOOK_PARITY_V1): the PreToolUse hooks' `additionalContext`, for beside the result. */
  context?: string;
}

type Harness = { gateTool(call: ToolCall): Promise<GateResult> };

/**
 * The verdict for `call` (its `toolInput` is the input the floor judges), `{ halt }` when a
 * PreToolUse hook stopped the turn, or `{ stop }` when a PermissionRequest hook refused the
 * call with `interrupt: true` (X1).
 */
export async function decideToolCall(
  call: ToolCall,
  harness: Harness,
  dispatcher: HookDispatcher | undefined,
  ids: { toolUseId: string; sessionId: string; signal: AbortSignal },
): Promise<ToolGateVerdict | { halt: string } | { stop: string }> {
  const input = call.toolInput;
  if (!dispatcher) return fromGateResult(await harness.gateTool(call), input);
  const { toolUseId, sessionId, signal } = ids;
  const pre = await dispatcher.dispatch(
    'PreToolUse',
    buildPreToolUseInput(call.toolName, input, toolUseId, sessionId),
    { toolUseId, signal },
  );
  let v: ToolGateVerdict;
  if (pre.decision === 'halt' && !preToolUseBlockIsDeny(pre)) {
    // A Stop-semantics halt from a PreToolUse hook is rare (the floor never
    // halts) — route to the same paused-halt stop the loop already finalizes on.
    return { halt: pre.stopReason ?? 'Stopped by hook.' };
  } else if (pre.decision === 'halt') {
    // X1 (HOOK_PARITY_V1): a top-level `decision:"block"` refuses this one tool.
    v = { decision: 'deny', effInput: input, ...(pre.stopReason !== undefined && { denyMessage: pre.stopReason }) };
  } else if (pre.permissionDecision === undefined) {
    // ABSENT permissionDecision = no hook decided → the loop's default gate IS the
    // floor we registered, which always decides; so on the floor-only path this is
    // unreachable. Defensively fall back to the direct gate (never an implicit allow).
    v = fromGateResult(await harness.gateTool(call), input);
  } else {
    // permissionDecisionReason is decision-polymorphic: deny → error message, ask → pause kind.
    const reason = pre.permissionDecisionReason;
    // K6-P3-C7: the floor folds the gate's deny reasonType onto the HookOutcome
    // (gateFloorToOutput → dispatcher merge), so the PRODUCTION (dispatcher-present)
    // deny path stamps reasonType on PERMISSION_DENIED. Narrow the contract's loose
    // string to the GateResult deny classifier (the floor only ever emits those
    // values). On an ask, the reserved 'floor' marks the X1 unsilenceable card.
    const stage = pre.permissionDecisionReasonType as DenyReasonType | undefined;
    v = {
      decision: pre.permissionDecision,
      effInput: pre.updatedInput !== undefined ? pre.updatedInput : input,
      ...(reason !== undefined && { denyMessage: reason, pauseKind: reason }),
      ...(stage !== undefined && { denyReasonType: stage }),
      ...(pre.permissionDecision === 'ask' && stage === 'floor' && { unsilenceable: true as const }),
    };
    // X1 (HOOK_PARITY_V1): a hook's rewrite of an allowed call is judged on its own
    // (Claude Code evaluates permission rules against the input a hook returns). A deny
    // stands; a card shows for the ORIGINAL call, the one its approval re-runs.
    if (v.decision === 'allow' && v.effInput !== input && hookParityEnabled()) {
      const regate = fromGateResult(await harness.gateTool({ ...call, toolInput: v.effInput }), v.effInput);
      if (regate.decision === 'deny') v = { ...regate, effInput: input };
      else if (regate.decision === 'ask') v = { ...regate, effInput: input };
      else v = regate;
    }
  }
  // X1 (HOOK_PARITY_V1): a permission card is about to show; hooks may answer it (hook-parity.ts).
  if (v.decision === 'ask' && v.pauseKind === 'tool_permission') {
    const answer = await resolvePermissionCard(call, v.effInput, harness, dispatcher, signal, sessionId, v.unsilenceable === true);
    if (answer !== undefined && 'stop' in answer) return answer;
    if (answer !== undefined) v = fromGateResult(answer, v.effInput);
  }
  // X1 (HOOK_PARITY_V1): what the PreToolUse hooks said "alongside the tool result" (documented;
  // ignored on a defer). Carried past every re-gate above, which rebuilds the verdict.
  const context = pre.decision === 'continue' && hookParityEnabled() ? pre.additionalContext?.trim() : undefined;
  return context && v.decision !== 'defer' ? { ...v, context } : v;
}

/** Collapse a GateResult into the loop's neutral decision shape. */
export function fromGateResult(gate: GateResult, input: unknown): ToolGateVerdict {
  if (gate.decision === 'deny') {
    // exactOptionalPropertyTypes: spread reasonType only when present (a deny may
    // carry none) — an explicit `denyReasonType: undefined` is not assignable to
    // the optional field under the SDK's stricter tsconfig.
    return {
      decision: 'deny',
      denyMessage: gate.message,
      effInput: input,
      ...(gate.reasonType !== undefined && { denyReasonType: gate.reasonType }),
    };
  }
  if (gate.decision === 'needs_human') {
    return {
      decision: 'ask',
      pauseKind: gate.interactionKind,
      effInput: input,
      ...(gate.unsilenceable === true && { unsilenceable: true as const }),
    };
  }
  return {
    decision: 'allow',
    effInput: gate.updatedInput !== undefined ? gate.updatedInput : input,
  };
}

/** Build the PreToolUse hook input. `transcript_path` is the SDK-compat placeholder
 *  the kernel never reads (history is the journal). */
function buildPreToolUseInput(toolName: string, toolInput: unknown, toolUseId: string, sessionId: string): PreToolUseHookInput {
  return {
    session_id: sessionId,
    cwd: process.cwd(),
    transcript_path: '',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
  };
}
