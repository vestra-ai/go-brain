/**
 * A company action waits for the customer's yes (Platform API v1; Keshav's ruling of 2 Oct, which reversed master
 * ruling 24). Every tool of a company's own MCP servers asks before it runs, in live and test mode alike, unless
 * the company's server declares it read-only (MCP `readOnlyHint: true`) or the deployment's version lets it run
 * without asking (`run_without_asking` in vestra.yaml). The safety class comes from those explicit flags, defaulting
 * to asking: never from the words in a tool's name. Since 3 Oct a company's function tool (one its own code
 * answers, `tools:` in vestra.yaml) is a company action too, by the same rule: its `read_only` and
 * `run_without_asking` marks are the two flags.
 *
 * The box resolves the call into a CompanyAction (apps/sandbox mcp/company-actions.ts: which servers are the
 * company's, what the server declared, what the version allows) and hands it to decideToolGate, whose ladder asks
 * on it (step 5b) below the deny and ask rules (a deny still wins; require_approval asks the same) and plan (which
 * steers to the plan instead), and above the floor, the other modes and every allow rule: nothing the person or a
 * permissive mode does silences it. Its own module because
 * decide-tool-gate.ts sits near the file-size ratchet. PURE / TOTAL.
 */
import type { ToolCall } from '../contract/harness.js';
import { mcpInvokeTarget } from './inner-rule-views.js';

/** A call to one of the company's own tools, as the box resolved it. */
export interface CompanyAction {
  /** The server's slug, as mcp_invoke names it. Absent: one of the company's function tools, which its own code answers. */
  server?: string;
  tool: string;
  /** The company declared the tool read-only (its server's MCP `readOnlyHint: true`, or a function's `read_only: true`). */
  readOnly: boolean;
  /** The company lets the tool run without the yes (the version's `run_without_asking`, or a function's own mark). */
  runsWithoutAsking: boolean;
}

/** Does this company action wait for the customer's yes? Undefined (not a company tool) never does. */
export function companyActionAsks(action: CompanyAction | undefined): boolean {
  return action !== undefined && !action.readOnly && !action.runsWithoutAsking;
}

/**
 * The company server and tool a call runs, when `servers` (the company's slugs) names its server: an mcp_invoke
 * (the native arm) or a direct `mcp__<server>__<tool>` call. null for any other call.
 */
export function companyToolOf(call: ToolCall, servers: readonly string[]): { server: string; tool: string } | null {
  const invoked = mcpInvokeTarget(call);
  if (invoked !== null) return servers.includes(invoked.server) ? { server: invoked.server, tool: invoked.tool } : null;
  const name = typeof call?.toolName === 'string' ? call.toolName : '';
  for (const server of servers) {
    const prefix = `mcp__${server}__`;
    if (name.startsWith(prefix) && name.length > prefix.length) return { server, tool: name.slice(prefix.length) };
  }
  return null;
}
