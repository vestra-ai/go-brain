/**
 * subagent-permissions.ts — Phase 4 (§1.7 AC-R2) path-scoped, deny-by-default
 * permissions for subagent types + Weave nodes.
 *
 * Reuses the EXISTING permission-rule engine + `decideToolGate` ladder (K6-P3) —
 * no second rule engine. A node's permission rules are evaluated as an
 * ADDITIONAL, node-scoped DENY layer that runs BEFORE the parent's real gate:
 * a node-level deny wins outright ("denied at the chokepoint, not paused" —
 * AC-R2), independent of whatever the parent session's mode/rules/credit-gate
 * would otherwise decide. Everything the node layer does NOT deny still falls
 * through to the parent's full policy, unchanged.
 *
 * ⚠️ SENSITIVE_DENY_RULES IS A BEST-EFFORT DENYLIST, NOT A SANDBOX BOUNDARY.
 * It pattern-matches known egress/exfiltration SHAPES (Bash curl/wget/ssh/…,
 * Composio, well-known secrets paths) — it CANNOT be exhaustive. A subagent
 * with Bash still has python/node/perl/ruby/git-over-https/pip-install-from-URL/
 * a thousand other ways to make an outbound request or read an unlisted secret
 * path; none of those are covered here. Treat this as raising the bar against
 * an UNSOPHISTICATED or ACCIDENTAL leak (e.g. an agent that reaches for `curl`
 * without thinking), NOT as a guarantee that a non-`general-purpose` subagent
 * has no network access. REAL network isolation (egress-deny-by-default at the
 * process/sandbox boundary, not a tool-call pattern match) is Phase 2b's
 * `egress-deny + intent-log + F1` work — this module is not a substitute for it.
 *
 * SCOPE: `wrapHarnessForNode` is applied only in `agent-tool.ts`'s `runOneChild`
 * (the `native`/`openai_responses` arms' `Agent`/`Weave` tools). It does NOT
 * apply to the Claude Agent SDK arm's own Task tool or the `openai` runtime
 * arm's `Agent.asTool()` subagents (openai-subagents.ts) — see agent-tool.ts's
 * file header for the full scope note.
 */
import type { GateResult, ToolCall } from '../contract/harness.js';
import type { PermissionRuleValue } from '../contract/permission.js';
import { decideToolGate, type ToolGateContext } from '../policy/decide-tool-gate.js';
import { GENERAL_PURPOSE_TYPE } from './subagent-type-registry.js';

/**
 * The sensitive set (email/Composio/secrets/known network-egress command
 * SHAPES) — deny-by-default for any non-`general-purpose` subagent type or
 * Weave node (AC-R2). A type's OWN `permissions` can only ADD to this set
 * (narrow further), never remove from it — see {@link buildNodeGateContext}.
 * BEST-EFFORT, not exhaustive — see the module header above. A role that
 * genuinely must not reach the network should be given a `toolset` that
 * excludes `Bash` entirely (AC-R6), not rely on this denylist alone.
 */
export const SENSITIVE_DENY_RULES: readonly PermissionRuleValue[] = [
  // Email + every other Composio-routed integration.
  { toolName: 'mcp__composio__*' },
  // Network egress via Bash.
  { toolName: 'Bash', ruleContent: 'curl *' },
  { toolName: 'Bash', ruleContent: 'wget *' },
  { toolName: 'Bash', ruleContent: 'ssh *' },
  { toolName: 'Bash', ruleContent: 'scp *' },
  { toolName: 'Bash', ruleContent: 'rsync *' },
  { toolName: 'Bash', ruleContent: 'nc *' },
  // Secrets paths.
  { toolName: 'Read', ruleContent: '.env' },
  { toolName: 'Read', ruleContent: '.env.*' },
  { toolName: 'Read', ruleContent: '*.pem' },
  { toolName: 'Read', ruleContent: 'id_rsa*' },
];

/** Opt-in write-denial for a genuinely read-only type (AC-R2's worked example:
 *  "a readonly node attempting a write ... is denied at the chokepoint"). Not
 *  baked into the base sensitive set — plenty of non-general-purpose types
 *  legitimately write files. */
export const READONLY_DENY_RULES: readonly PermissionRuleValue[] = [
  { toolName: 'Write' },
  { toolName: 'Edit' },
  { toolName: 'Patch' },
  { toolName: 'NotebookEdit' },
  { toolName: 'MultiEdit' },
];

/**
 * A subagent type's own permission narrowing — `deny` ONLY. There is
 * DELIBERATELY no `ask` field here (coordinator must-fix, 2026-07-01):
 * {@link wrapHarnessForNode} only ever acts on a `deny` decision from the
 * node-scoped ladder — a `needs_human` result from an isolated node-context
 * evaluation is intentionally discarded (see that function's doc), because
 * the node context has no session/credit/Composio state to make that a
 * TRUSTWORTHY decision on its own, and forwarding it to the wrong `onPause`
 * (a Weave node's side-effect-free `inCodePause`, vs a real subagent's
 * durable pause) risks either silently swallowing the prompt or mis-firing a
 * durable interaction from an incomplete context. An `ask` field here would
 * therefore be silently ignored — worse than not offering it at all. If a
 * `.forge` config author wants a type to be conservative about an action,
 * `deny` it outright; there is no node-level "prompt a human" primitive yet.
 */
export interface SubagentPermissions {
  deny?: PermissionRuleValue[];
}

/**
 * Build the node-scoped `ToolGateContext` a spawned subagent/Weave node gates
 * through. `isGeneralPurpose` types keep ONLY their own declared `permissions`
 * (the inline-prompt escape hatch is trusted like the main turn); every OTHER
 * type ALWAYS carries {@link SENSITIVE_DENY_RULES} regardless of what it
 * declares — a custom type's own deny rules can only ADD to this floor. There
 * is no `allow` (or `ask` — see {@link SubagentPermissions}) list here at
 * all: this context REPLACES the parent's for the deny step (AC-R2's "child
 * can only narrow"), never grants anything.
 */
export function buildNodeGateContext(
  base: Pick<ToolGateContext, 'mode' | 'cwd' | 'home'>,
  permissions: SubagentPermissions | undefined,
  isGeneralPurpose: boolean,
): ToolGateContext {
  const ownDeny = permissions?.deny ?? [];
  const deny = isGeneralPurpose ? ownDeny : [...SENSITIVE_DENY_RULES, ...ownDeny];
  return {
    ...base,
    // ARM the C2 ladder (it is dormant when `mode` is undefined) so the deny
    // rules above actually evaluate; 'default' makes no mode-level auto-decision
    // of its own, so this never changes behavior beyond running the deny step.
    mode: base.mode ?? 'default',
    permissionRules: { allow: [], ask: [], deny },
  };
}

/**
 * Wrap a harness so the node's OWN deny rules win BEFORE the parent's real
 * gate runs. A node-level deny is returned immediately (AC-R2: denied at the
 * chokepoint, not paused). Anything the node layer does NOT deny (allow /
 * needs_human from evaluating the node context in isolation) is DISCARDED —
 * the call still falls through to the parent's full policy (mode, session
 * rules, credit gating, Composio classification), so a node never gains a
 * permission the parent session didn't already have.
 */
export function wrapHarnessForNode(
  parent: { gateTool(call: ToolCall): Promise<GateResult> },
  nodeCtx: ToolGateContext,
): { gateTool(call: ToolCall): Promise<GateResult> } {
  return {
    async gateTool(call: ToolCall): Promise<GateResult> {
      const nodeDecision = decideToolGate(call, nodeCtx);
      if (nodeDecision.decision === 'deny') return nodeDecision;
      return parent.gateTool(call);
    },
  };
}

/** True when `typeName` is the trusted inline-prompt escape hatch (design
 *  §1.2.1) — the ONLY type that does not carry the structural sensitive-deny. */
export function isGeneralPurposeType(typeName: string): boolean {
  return typeName === GENERAL_PURPOSE_TYPE;
}

/**
 * P2.2 (§5) — network-capable tool names. An INLINE (on-the-fly) agent that
 * requests NONE of these is trusted like general-purpose for the sensitive-deny
 * floor; give it ANY of them and the standard non-general-purpose sensitive-deny
 * set applies. Bash counts as network-capable — curl/wget/… are one shell call
 * away (see the module header on why the denylist is best-effort, not a boundary,
 * so an inline agent handed network reach earns the extra scrutiny).
 *
 * `execute_code` counts too: it runs arbitrary Python/Node, so urllib/fetch/socket
 * ARE reachable from inside the interpreter. The subagent code-exec whitelist only
 * bounds which in-code TOOL STUBS the bridge advertises (e.g. no web_search()) — it
 * does NOT sandbox the interpreter's own network stack. Omitting it here would
 * misclassify an inline agent with {execute_code, Read} as general-purpose, skipping
 * the sensitive-deny floor and letting it Read .env/*.pem directly.
 */
export const NETWORK_CAPABLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'WebSearch',
  'WebFetch',
  'Bash',
  'execute_code',
]);

/**
 * P2.2 (§5) — whether an inline agent's RESOLVED toolset lets it be treated as
 * general-purpose for the sensitive-deny floor: true iff it carries NO
 * network-capable tool. `isGeneralPurposeType` stays slug-based — this is the
 * separate inline axis a spawn site combines with it (never overloading the slug
 * check). The per-tool parent gate still fires at dispatch either way.
 */
export function inlineAgentIsGeneralPurpose(resolvedToolNames: readonly string[]): boolean {
  return !resolvedToolNames.some((n) => NETWORK_CAPABLE_TOOL_NAMES.has(n));
}
