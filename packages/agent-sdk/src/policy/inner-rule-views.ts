/**
 * L6 (master ruling 12; ruling, 28 Sep): the tools a call runs besides
 * itself, for the deny and ask rules the product passes as
 * `ToolGateContext.innerViewRules` (server-pushed rules only; allow rules never
 * see inner tools). Its own module because decide-tool-gate.ts sits at the
 * file-size ratchet: new work goes into new modules.
 */
import type { ToolCall } from '../contract/harness.js';
import type { PermissionRuleValue } from '../contract/permission.js';
import { COMPOSIO_TOOL_PREFIX } from './engine-constants.js';
import { extractInnerComposioTools } from './composio-naming.js';
import { matchRule, type PathAnchors } from './permission-rule-engine.js';

/**
 * The native arm's MCP meta-tool (apps/sandbox/src/mcp/mcp-tool-defs.ts,
 * MCP_INVOKE_TOOL_NAME; the sandbox test company-rule-naming.test.ts pins the two).
 */
const MCP_INVOKE_TOOL = 'mcp_invoke';

/**
 * The tools a call runs besides itself, as the calls a permission rule would see
 * had the agent called them directly, in the tool-specifier spelling of
 * company rules and app-tool rules (`mcp__<server>__<tool>`):
 *   - mcp_invoke({ server, tool, args }) runs one MCP tool;
 *   - a Composio executor meta-call (MULTI_EXECUTE) runs every tool of its tools[]
 *     payload, read by extractInnerComposioTools, the unwrap the classifier and
 *     the app pins already use.
 * [] when the call runs nothing else or its payload cannot be read (an unreadable
 * MULTI_EXECUTE never runs: unrunnableExecutorPayload denies it earlier).
 */
export function innerRuleViewsOf(call: ToolCall): ToolCall[] {
  const composio = extractInnerComposioTools(call);
  if (composio) {
    return composio.map(({ slug }) => ({ toolName: `${COMPOSIO_TOOL_PREFIX}${slug}`, toolInput: {}, toolCallId: call.toolCallId }));
  }
  const target = mcpInvokeTarget(call);
  return target === null ? [] : [target.view];
}

/** The MCP tool an mcp_invoke call runs: its server, its tool name and the call a rule sees. */
export interface McpInvokeTarget {
  server: string;
  tool: string;
  /** `mcp__<server>__<tool>` with the call's own args, as innerRuleViewsOf hands it to the rules. */
  view: ToolCall;
}

/**
 * THE one reading of an mcp_invoke call, shared by the rule views above and the side-effect
 * classifier (MCP_INVOKE_RESOLVED_GATE_V1), so a rule and a family can never name different
 * tools. null for any other call, or one whose server or tool is not a non-empty string (such a
 * call runs nothing: the registry answers it with an error).
 */
export function mcpInvokeTarget(call: ToolCall): McpInvokeTarget | null {
  if (call.toolName !== MCP_INVOKE_TOOL || !call.toolInput || typeof call.toolInput !== 'object') return null;
  const { server, tool, args } = call.toolInput as { server?: unknown; tool?: unknown; args?: unknown };
  if (typeof server !== 'string' || typeof tool !== 'string' || server === '' || tool === '') return null;
  return { server, tool, view: { toolName: `mcp__${server}__${tool}`, toolInput: args ?? {}, toolCallId: call.toolCallId } };
}

/** Does ANY of `rules` match ANY tool the call runs (innerRuleViewsOf)? Deny and ask only. */
export function innerViewMatches(call: ToolCall, rules: PermissionRuleValue[] | undefined, anchors?: PathAnchors): boolean {
  if (!Array.isArray(rules) || rules.length === 0) return false;
  return innerRuleViewsOf(call).some((c) => rules.some((r) => matchRule(c, r, anchors)));
}
