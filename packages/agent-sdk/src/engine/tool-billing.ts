/**
 * tool-billing.ts — the per-tool ACTION billing frame, built in one place.
 *
 * `AGENT_TOOL_BILLING_EVENT` mirrors `EVENTS.AGENT_TOOL_BILLING` (@bash/shared events.ts =
 * 'agent:tool_billing'), inlined so the engine reads no `@bash/*`. The payload
 * `{ taskId, toolName, toolUseId, isSubagent }` is what the relay charges
 * (sandbox-relay onAgentToolBilling → checkAndDeductTool): the PRICE is the server's
 * (credit.service expensiveTools; today only `mcp__composio*` costs anything, the Composio
 * per-call fee), and `toolUseId` keys the charge, so a frame that arrives twice is one charge.
 *
 * Every path that dispatches a tool emits through `toolBillingEvent`: the native round loops
 * (round-tool-sequential.ts, round-tool-batch.ts), a native sub-agent's own loop (subagent-runner,
 * `isSubagent`, sent once each call settles and carried up to the Agent tool, which emits it),
 * and the CLI engines' bridge (apps/sandbox cli-common/bridge/bridge-session.ts). One frame and
 * one rule, so a tool costs the same on every engine and at every depth, and the price list
 * stays on the server.
 */
import type { HarnessEvent } from '../contract/events.js';
import type { ToolDispatchResult } from '../tools/tool-types.js';

export const AGENT_TOOL_BILLING_EVENT = 'agent:tool_billing';

/**
 * The billing frame for one dispatched call, or undefined when there is no action to charge:
 * a paused tool re-dispatches and bills on resume (billing it now would double-charge), and a
 * fuel-denied node or a refused call never ran (`ToolDispatchResult.refused`: the schema gate,
 * the policy gate or a hook said no, or the injection guard skipped it). A call that ran and
 * failed is charged: its vendor call may have happened.
 */
export function toolBillingEvent(
  call: { taskId: string; toolName: string; toolUseId: string; isSubagent?: boolean },
  res: Pick<ToolDispatchResult, 'pausedHalt' | 'fuelDenied' | 'refused'>,
): Extract<HarnessEvent, { kind: 'raw' }> | undefined {
  if (res.pausedHalt || res.fuelDenied || res.refused) return undefined;
  return {
    kind: 'raw',
    engine: 'native',
    event: AGENT_TOOL_BILLING_EVENT,
    data: { taskId: call.taskId, toolName: call.toolName, toolUseId: call.toolUseId, isSubagent: call.isSubagent === true },
  };
}
