/**
 * SubagentEvent — what a subagent's own loop hands the Agent tool (`onEvent`), the one emitter
 * (K3). Lifted out of subagent-runner.ts (which only ratchets down); re-exported from there.
 */
import type { HarnessEvent } from '../contract/events.js';

export type SubagentEvent =
  | { kind: 'text'; delta: string }
  | { kind: 'tool_use'; subToolUseId: string; toolName: string; toolInput: unknown }
  | { kind: 'tool_result'; subToolUseId: string; result: string; isError: boolean }
  /**
   * A raw HarnessEvent a tool INSIDE this subagent pushed, carried up verbatim.
   *
   * This is how a NESTED Agent tool speaks. Its emits are already stamped with its
   * own toolUseId (tool-dispatcher hands it `toolCallId`), so the event is relayed
   * unchanged — the caller must NOT re-stamp it or the depth-2 lane would be
   * attributed to its parent. Honours the EMISSION contract at the top of
   * subagent-runner.ts: the engine never touches the socket, it just widens what `onEvent`
   * can carry, and the Agent tool stays the sole emitter.
   */
  | { kind: 'raw'; event: HarnessEvent }
  /**
   * The per-tool ACTION fee for one call this subagent dispatched, built by toolBillingEvent
   * (isSubagent) once the call SETTLED: a refused, paused or fuel-denied call sends none, and
   * a call that ran sends exactly one. The Agent tool is the emitter: it buffers these per
   * attempt, so a child that falls back to another model is charged for one attempt only.
   */
  | { kind: 'billing'; event: Extract<HarnessEvent, { kind: 'raw' }> };
