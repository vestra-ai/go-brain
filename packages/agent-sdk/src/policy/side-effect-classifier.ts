/**
 * THE SIDE-EFFECT CLASSIFIER (permissions v2 — access levels).
 *
 * Maps every tool call to ONE side-effect family. The access-level ladder
 * (decide-tool-gate → hardFloors + levelAsks) then decides ask vs run per the
 * user's level. This is the single deterministic artifact that defines, in
 * production, what each level asks about (spec §2.1).
 *
 * REUSE, NOT REINVENTION. The dangerous-delete + payment/delete taxonomy already
 * lives in the sensitivity floor; this module consumes it verbatim
 * (`classifyBashCommand`, the Composio payment/delete toolkit sets + verb lists,
 * `patchFloors`, `hasVerbWord`) so the classifier and the floor can NEVER drift
 * on what is dangerous. The NEW knowledge here is the finer split of the
 * non-flooring remainder: SEND vs READ vs generic external MUTATION.
 *
 *   Bash/PowerShell → readonly | workspace_write | external_mutation |
 *                     dangerous_delete | protected_remote
 *                     (classifyBashCommand — the floor's exact analysis; the
 *                     git and gh catalog supplies the last three for git).
 *   Edit/Write/NotebookEdit/MultiEdit → workspace_write.
 *   Patch → dangerous_delete if a Delete/Move envelope, else workspace_write.
 *   Composio/MCP → payment | dangerous_delete (existing taxonomy) else
 *                  external_send (SEND_VERBS) | readonly (READ_VERBS) |
 *                  external_mutation (anything else external — safe default).
 *   Read/Glob/Grep/WebFetch/WebSearch/progress + interactive tools → readonly.
 *   Any other builtin → workspace_write (conservative — never readonly).
 *
 * MONOTONE with the floor at Relaxed: a call the floor asks about classifies to
 * `payment` or `dangerous_delete` (both hard-floored below Autopilot), and a call
 * the floor admits never does — so ACCESS_LEVELS_V1 at Relaxed is byte-equivalent
 * to today's floor (pinned by the gate equivalence test).
 *
 * PURE / TOTAL / NEVER-THROWS. No I/O, no state.
 */

import type { ToolCall } from '../contract/harness.js';
import { COMPOSIO_TOOL_PREFIX } from './engine-constants.js';
import { TOOL_SEARCH_TOOL_NAME } from '../engine/tool-search.js';
import {
  isComposioExecutorMetaTool,
  isComposioWorkbenchMetaTool,
  extractInnerComposioTools,
} from './composio-naming.js';
import {
  classifyBashCommand,
  patchFloors,
  hasVerbWord,
  composioVerdict,
  PAYMENT_VERBS,
  DELETE_VERBS,
  type ComposioToolHints,
} from './sensitivity-floor.js';
import { mcpInvokeResolvedGateEnabled } from './feature-flags.js';
import { mcpInvokeTarget } from './inner-rule-views.js';

export type SideEffectFamily =
  | 'readonly'
  | 'workspace_write'
  | 'external_send'
  | 'external_mutation'
  | 'dangerous_delete'
  /**
   * The gate CANNOT READ this call — an executor payload it cannot resolve, a
   * workbench script whose proxied slug is dynamic. It carries payment-strength
   * floors (hard-asks at every level, not configurable) WITHOUT the payment
   * words: prod 2026-09-20 task 46f85398 asked a person to "Approve a payment"
   * for a Notion write because unreadable had no family of its own.
   */
  | 'unknown'
  /**
   * A rewrite or delete of shared git history that cannot be undone and that other
   * people's work depends on: a force push, a remote branch delete, --prune,
   * --mirror, a repository or release delete (git-command-catalog). Asks at EVERY
   * level, Autopilot included, and is never configurable, like a payment.
   */
  | 'protected_remote'
  | 'payment';

/** Context the classifier needs — only Bash consumes it (delete-target containment). */
export interface SideEffectContext {
  /** Absolute workspace root (the gate cwd) delete targets are contained against. */
  workspaceRoot: string;
  /** Live persisted terminal cwd relative deletes resolve from (see sensitivity-floor). */
  shellCwd?: string | null | undefined;
  /**
   * The VENDOR's MCP hints for this call's Composio slugs — the classification
   * itself for Composio tools (sensitivity-floor `composioVerdict`). Absent, or
   * silent on a slug ⇒ byte-identical name-rule classification.
   */
  composioToolHints?: ComposioToolHints | undefined;
  /**
   * B6 (MCP_INVOKE_RESOLVED_GATE_V1): the declarations of the MCP tools an mcp_invoke call
   * runs, as this session's MCP registry listed them. Absent, or silent on the tool ⇒ the
   * name rule alone.
   */
  mcpToolHints?: McpToolHints | undefined;
}

/**
 * An MCP server's own declaration for one of its tools (MCP `ToolAnnotations`): `readOnly` is
 * `readOnlyHint`, `destructive` is `destructiveHint`. Only a key the server SET is present: the
 * spec's default (destructive when unsaid) is never assumed, so silence means the name rule.
 * The producer decides trust: `readOnly: true` is passed only for a first-party Vestra server;
 * `readOnly: false` and `destructive` only tighten, so they pass from any server.
 */
export interface McpToolHint {
  readOnly?: boolean;
  destructive?: boolean;
}
/** `mcp__<server>__<tool>` (the inner view's name) → that tool's declaration. Absent = silent. */
export type McpToolHints = ReadonlyMap<string, McpToolHint>;

// ── verb taxonomy — the NEW lists that split the non-flooring external remainder ──

/**
 * SEND verbs — a Composio/MCP action carrying one of these (and no payment/delete
 * verb) acts on the OUTSIDE WORLD irreversibly: an email, a message, a post, a
 * published artifact. Asks at Careful + Balanced. Whole-word matched.
 */
const SEND_VERBS: readonly string[] = [
  'SEND', 'REPLY', 'POST', 'PUBLISH', 'COMMENT', 'MESSAGE', 'ANNOUNCE', 'TWEET',
];

/**
 * READ verbs — a Composio/MCP action carrying one of these (and no payment/delete/
 * send verb) only observes. Runs at every level. Whole-word matched.
 */
const READ_VERBS: readonly string[] = [
  'GET', 'LIST', 'SEARCH', 'FETCH', 'READ', 'RETRIEVE', 'LOOKUP', 'DOWNLOAD',
];

// ── builtin tool sets ─────────────────────────────────────────────────────────

/**
 * Builtin tools that only observe (+ the interactive tools, which mint their own
 * typed interaction downstream and must never be level-gated). `web_search` is
 * the native tool name; `WebSearch` the Claude-SDK name — both are reads.
 * ToolSearch only loads deferred tools' definitions into the session (the tool it
 * loads is classified on its own when called), so Careful never asks about it.
 */
const READONLY_BUILTINS: ReadonlySet<string> = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'web_search', 'TodoWrite',
  'AskUserQuestion', 'ExitPlanMode', TOOL_SEARCH_TOOL_NAME,
  // Past-session search: reads only (see write-tool-taxonomy.ts READ_TOOLS). A literal,
  // as in apps/sandbox harness/tools/session-tools.ts; the SDK cannot import the product.
  'session_search',
  // X5b: lists or reads a connected MCP server's resources, never runs a tool (apps/sandbox
  // mcp/mcp-tool-defs.ts MCP_RESOURCES_TOOL_NAME; a literal for the same reason).
  'mcp_resources',
]);

/**
 * The pull-request tool (engineer teammates, Git train G3; apps/sandbox harness/tools/
 * github-pr-tool.ts — a literal, as for session_search: the SDK cannot import the product).
 * Opening a pull request or commenting on one is an external action that follows the access
 * level exactly like a push to a feature branch (git-command-catalog `external`): it asks at
 * Careful and Balanced and runs at Relaxed and Autopilot, never "always asks" (the founder's
 * Relaxed ruling). view and list only read; merge does nothing (the server answers it with a
 * sentence and the link); connect only asks whether Vestra reaches the repository and, if not,
 * shows the person the Connect GitHub card. None of the four asks. Any other action is the
 * safe default.
 */
export const GITHUB_PULL_REQUEST_TOOL = 'github_pull_request';
const GITHUB_PULL_REQUEST_READS: ReadonlySet<string> = new Set(['view', 'list', 'merge', 'connect']);

/** The native arm's MCP meta-tool (inner-rule-views.ts names it too; a sandbox test pins both). */
const MCP_INVOKE_TOOL = 'mcp_invoke';

/** Builtin file-edit tools — always a workspace write. (Patch is handled separately.) */
const WORKSPACE_WRITE_BUILTINS: ReadonlySet<string> = new Set([
  'Write', 'Edit', 'NotebookEdit', 'MultiEdit',
]);

/**
 * Classify a tool call into its side-effect family. Total — any unexpected shape
 * degrades to a safe, non-readonly family (never silently downgrades a possible
 * mutation to readonly).
 */
export function classifySideEffect(call: ToolCall, ctx: SideEffectContext): SideEffectFamily {
  try {
    if (!call || typeof call.toolName !== 'string') return 'workspace_write';
    const tool = call.toolName;

    if (READONLY_BUILTINS.has(tool)) return 'readonly';
    if (WORKSPACE_WRITE_BUILTINS.has(tool)) return 'workspace_write';

    // Patch — a Delete/Move envelope removes a file (a delete); pure Update/Add is a write.
    if (tool === 'Patch') {
      return patchFloors(getPatchInput(call.toolInput)) ? 'dangerous_delete' : 'workspace_write';
    }

    // Bash — the floor's exact analysis, the git and gh catalog included.
    if (tool === 'Bash' || tool === 'PowerShell') {
      return classifyBashCommand(getCommand(call.toolInput), ctx.workspaceRoot, ctx.shellCwd);
    }

    // Composio tools (`mcp__composio__TOOLKIT_ACTION`) — toolkit-aware taxonomy.
    // Meta-EXECUTORS run OTHER tools named in their payload, so they classify
    // by what will actually execute, never by the wrapper's name (which reads
    // as a harmless external_mutation and let a real Gmail send ride an
    // external_mutation allow — incident 6aa39a0d).
    if (tool.startsWith(COMPOSIO_TOOL_PREFIX)) {
      if (isComposioExecutorMetaTool(tool)) return classifyMetaExecutor(call, ctx.composioToolHints);
      return classifyComposio(tool, ctx.composioToolHints);
    }

    if (tool === GITHUB_PULL_REQUEST_TOOL) {
      const action = (call.toolInput as { action?: unknown } | undefined)?.action;
      return typeof action === 'string' && GITHUB_PULL_REQUEST_READS.has(action) ? 'readonly' : 'external_mutation';
    }

    // B6 (MCP_INVOKE_RESOLVED_GATE_V1): mcp_invoke runs ANOTHER tool, so it classifies as
    // that tool, never by the wrapper's name (the meta-executor rule above). Off, the wrapper
    // falls to the builtin default below: every MCP send or delete read as a workspace write,
    // which the injection screen never screens. A call naming no server or tool runs nothing.
    if (tool === MCP_INVOKE_TOOL && mcpInvokeResolvedGateEnabled()) {
      const target = mcpInvokeTarget(call);
      return target === null ? 'workspace_write' : classifyDeclaredMcp(target.tool, ctx.mcpToolHints?.get(target.view.toolName));
    }

    // Generic (non-composio) MCP tools (`mcp__server__action`) — no toolkit
    // knowledge, so payment/delete come straight off the verb.
    if (tool.startsWith('mcp__')) {
      return classifyMcpAction(mcpActionSegment(tool));
    }

    // Any other builtin we don't recognize → conservative workspace write (asks
    // only at Careful; never readonly, so an unknown mutator can't slip through).
    return 'workspace_write';
  } catch {
    return 'workspace_write';
  }
}

/**
 * The lowercased toolkit slug of a Composio tool name — `mcp__composio__GMAIL_SEND_EMAIL`
 * → 'gmail' — or null for anything else (non-Composio tools, or a name with no action
 * segment, which classifyComposio treats as an unknown external). THE one toolkit split:
 * the gate's per-app access-config lookup (decide-tool-gate, B1b) reuses it, so the
 * config and the classifier can never disagree on which app a call belongs to. Total.
 */
export function composioToolkitOf(toolName: string): string | null {
  return splitComposio(toolName)?.toolkit ?? null;
}

/**
 * Severity order for the strictest-wins fold over an executor payload:
 * payment > dangerous_delete > external_send > external_mutation >
 * workspace_write > readonly.
 */
const FAMILY_SEVERITY: Record<SideEffectFamily, number> = {
  readonly: 0,
  workspace_write: 1,
  external_mutation: 2,
  external_send: 3,
  dangerous_delete: 4,
  // Only Bash carries it, never an executor payload; ranked with the always-ask families.
  protected_remote: 5,
  // Below payment on purpose: a payload with a READABLE charge in it says
  // payment (the truer word); one we cannot read at all says unknown.
  unknown: 6,
  payment: 7,
};

/**
 * The inner tools of an executor meta-call, each classified exactly as the
 * equivalent direct call (`mcp__composio__<SLUG>`) would be. The gate's
 * per-app pin walk (decide-tool-gate resolveAppAction) consumes this too, so
 * the pins and the classifier can never disagree on an inner tool's family.
 * Null when the payload cannot be read. Total.
 */
export function classifyMetaExecutorTools(
  call: ToolCall,
  hints?: ComposioToolHints,
): Array<{ slug: string; toolkit: string; family: SideEffectFamily }> | null {
  const inner = extractInnerComposioTools(call);
  if (inner === null) return null;
  return inner.map(({ slug, toolkit }) => ({
    slug,
    toolkit,
    family: classifyComposio(COMPOSIO_TOOL_PREFIX + slug, hints),
  }));
}

/**
 * Every Composio slug this classifier would examine for `call`: the direct
 * tool's own slug, a MULTI_EXECUTE payload's inner slugs, a workbench script's
 * literal proxied slugs. The sandbox resolves VENDOR hints for exactly these
 * (composio-vendor-hints.ts), so the lookup and the classification can never
 * disagree on which slugs matter. Unreadable payloads → [] (the classifier
 * fails toward 'unknown' on those by itself). Total.
 */
export function collectComposioSlugs(call: ToolCall): string[] {
  try {
    if (!call || typeof call.toolName !== 'string' || !call.toolName.startsWith(COMPOSIO_TOOL_PREFIX)) return [];
    if (isComposioWorkbenchMetaTool(call.toolName)) {
      const code = extractWorkbenchCode(call.toolInput);
      return code === null ? [] : (workbenchProxySlugs(code) ?? []);
    }
    if (isComposioExecutorMetaTool(call.toolName)) {
      return (extractInnerComposioTools(call) ?? []).map(({ slug }) => slug);
    }
    return [call.toolName.slice(COMPOSIO_TOOL_PREFIX.length).toUpperCase()];
  } catch {
    return [];
  }
}

// ── internals ─────────────────────────────────────────────────────────────────

/**
 * An executor meta-call's family, from what will ACTUALLY execute — never the
 * wrapper's name. Two payload shapes:
 *   - WORKBENCH executors run agent-authored code → scan the code (classifyWorkbench).
 *   - MULTI_EXECUTE runs a `tools[]` list → STRICTEST of its inner tools' families;
 *     an unreadable tools[] payload returns 'unknown' (hard-asks at every level
 *     including Autopilot, like payment — when we cannot see inside, assume the
 *     worst rather than let a charge/delete/send run silent — but without the
 *     payment words; the gate denies such a list back to the agent anyway).
 */
function classifyMetaExecutor(call: ToolCall, hints?: ComposioToolHints): SideEffectFamily {
  if (isComposioWorkbenchMetaTool(call.toolName)) return classifyWorkbench(call, hints);

  const inner = classifyMetaExecutorTools(call, hints);
  if (inner === null) return 'unknown';
  let strictest: SideEffectFamily = 'readonly';
  for (const { family } of inner) {
    if (FAMILY_SEVERITY[family] > FAMILY_SEVERITY[strictest]) strictest = family;
  }
  return strictest;
}

// ── workbench executors: classify by the proxied slugs in the code payload ──────

/**
 * Field names the workbench code payload arrives under — the sandbox display
 * extractor reads `code_to_execute` (tool-display.ts); recorded calls also use
 * `code`. Tolerant like INNER_SLUG_FIELDS.
 */
const WORKBENCH_CODE_FIELDS = ['code_to_execute', 'code', 'code_to_run'] as const;

/** The proxy helpers a workbench script uses to run a REAL Composio tool. */
const PROXY_MARKERS = ['run_composio_tool', 'proxy_execute'] as const;

/** Each proxy CALL site — a marker immediately followed by `(`. */
const PROXY_CALL_RE = /(?:run_composio_tool|proxy_execute)\s*\(/g;

/**
 * Keyword-argument names that carry the slug, so `run_composio_tool(tool_slug="X")`
 * resolves like the positional `run_composio_tool("X")`. A leading keyword NOT in
 * this set means the slug is not the first argument → we cannot vouch for it → the
 * caller fails toward 'unknown'.
 */
const SLUG_KEYWORDS: ReadonlySet<string> = new Set([
  'tool_slug', 'action', 'slug', 'tool', 'tool_name', 'action_name', 'name',
]);

/**
 * The slug argument of a proxy call, given the code and the index just past its
 * `(`. Resolves ONLY a first-positional or slug-keyworded STRING LITERAL; a
 * variable / expression / f-string / non-slug leading keyword returns null (the
 * caller then fails toward 'unknown'). Never throws.
 */
function proxyCallSlug(code: string, afterParen: number): string | null {
  const m = /^\s*(?:([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)\s*)?(["'])([^"']*)\2/.exec(
    code.slice(afterParen),
  );
  if (m === null) return null;
  const keyword = m[1];
  if (keyword !== undefined && !SLUG_KEYWORDS.has(keyword.toLowerCase())) return null;
  const slug = m[3].trim();
  return slug.length > 0 ? slug : null;
}

/** The workbench code string, or null when no readable code field is present. */
function extractWorkbenchCode(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const rec = input as Record<string, unknown>;
  for (const field of WORKBENCH_CODE_FIELDS) {
    const v = rec[field];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * A WORKBENCH executor's family, from the agent-authored code it runs. THE RULING
 * (founder 2026-07-15 — at Relaxed only deletes and payments ask): a proxied send
 * must run as silently as a direct send; a proxied delete/payment must ask.
 *   - missing / unreadable code           → 'unknown' (fail-closed).
 *   - no proxy markers                     → 'workspace_write' (pure local compute).
 *   - proxied calls, every slug a literal  → the STRICTEST inner family.
 *   - any proxied slug dynamic, or markers
 *     present with no resolvable call site → 'unknown' (fail-closed — could be a payment).
 * Total — never throws.
 */
function classifyWorkbench(call: ToolCall, hints?: ComposioToolHints): SideEffectFamily {
  const code = extractWorkbenchCode(call.toolInput);
  if (code === null) return 'unknown';
  if (!PROXY_MARKERS.some((mk) => code.includes(mk))) return 'workspace_write';

  // null = one dynamic call poisons the whole payload; [] = markers present with
  // no resolvable call site. Both fail closed.
  const slugs = workbenchProxySlugs(code);
  if (slugs === null || slugs.length === 0) return 'unknown';
  let strictest: SideEffectFamily = 'readonly';
  for (const slug of slugs) {
    const family = classifyComposio(COMPOSIO_TOOL_PREFIX + slug, hints);
    if (FAMILY_SEVERITY[family] > FAMILY_SEVERITY[strictest]) strictest = family;
  }
  return strictest;
}

/**
 * The UPPERCASED literal slugs of every proxy call site in a workbench script,
 * or null when any site's slug is dynamic (a variable / expression / f-string /
 * non-slug keyword) — the caller cannot vouch for what will run.
 */
function workbenchProxySlugs(code: string): string[] | null {
  const slugs: string[] = [];
  for (const m of code.matchAll(PROXY_CALL_RE)) {
    const slug = proxyCallSlug(code, (m.index ?? 0) + m[0].length);
    if (slug === null) return null;
    slugs.push(slug.toUpperCase());
  }
  return slugs;
}

/**
 * Split a Composio tool name (`mcp__composio__TOOLKIT_ACTION`) into its lowercased
 * toolkit slug + UPPERCASED action segment, or null when the name is not a Composio
 * tool or has no action segment.
 */
function splitComposio(tool: string): { toolkit: string; action: string } | null {
  if (typeof tool !== 'string' || !tool.startsWith(COMPOSIO_TOOL_PREFIX)) return null;
  const suffix = tool.slice(COMPOSIO_TOOL_PREFIX.length); // 'STRIPE_CREATE_CHARGE'
  const underscore = suffix.indexOf('_');
  if (underscore <= 0) return null; // no action segment
  return {
    toolkit: suffix.slice(0, underscore).toLowerCase(), // 'stripe'
    action: suffix.slice(underscore + 1).toUpperCase(), // 'CREATE_CHARGE'
  };
}

/**
 * A Composio tool's family: the floor's own verdict table (sensitivity-floor
 * `composioVerdict` — the vendor's word first, money by name, then today's
 * toolkit-aware name rule), so the classifier asks at Relaxed on precisely the
 * calls the floor floors; a 'remainder' splits into send/read/mutation by name.
 */
function classifyComposio(tool: string, hints?: ComposioToolHints): SideEffectFamily {
  const split = splitComposio(tool);
  if (split === null) return 'external_mutation'; // no action segment → unknown external
  const verdict = composioVerdict(tool.slice(COMPOSIO_TOOL_PREFIX.length), hints);
  return verdict === 'remainder' ? classifyExternalRemainder(split.action) : verdict;
}

/**
 * The family of the MCP tool an mcp_invoke call runs. In order:
 *   1. a payment word → payment (no annotation speaks for money; composioVerdict's order).
 *   2. declared destructive → dangerous_delete. Believed from any server: it only tightens.
 *   3. declared read-only → readonly. Only a first-party Vestra server's read-only claim ever
 *      reaches here: the registry passes `readOnly: true` for `vestra: true` servers alone
 *      (user-mcp-registry.ts toolHint), so trust is exact membership, never a reading of names.
 *   4. the name rule (classifyMcpAction); a declared `readOnly: false` overrides a read verb in
 *      the name (search_and_update is not a read because it starts with one).
 * Words split on every non-alphanumeric run and camelCase boundary, so `notion-search` and
 * `deleteRepo` read as the verbs they are, not as one unknown word.
 */
function classifyDeclaredMcp(tool: string, hint: McpToolHint | undefined): SideEffectFamily {
  const action = tool
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .join('_')
    .toUpperCase();
  if (hasVerbWord(action, PAYMENT_VERBS)) return 'payment';
  if (hint?.destructive === true) return 'dangerous_delete';
  if (hint?.readOnly === true) return 'readonly';
  const family = classifyMcpAction(action);
  return hint?.readOnly === false && family === 'readonly' ? 'external_mutation' : family;
}

/**
 * A generic MCP action with NO toolkit knowledge: payment/delete come straight
 * off the verb (mirroring the floor's generic-MCP fallback), then the
 * send/read/mutation remainder.
 */
function classifyMcpAction(action: string): SideEffectFamily {
  if (!action) return 'external_mutation';
  if (hasVerbWord(action, PAYMENT_VERBS)) return 'payment';
  if (hasVerbWord(action, DELETE_VERBS)) return 'dangerous_delete';
  return classifyExternalRemainder(action);
}

/**
 * The send/read/mutation split of an external action whose payment/delete
 * disposition the CALLER already decided: SEND verb → external_send, READ verb →
 * readonly, anything else → external_mutation (safe default — asks at Careful +
 * Balanced, runs at Relaxed).
 */
function classifyExternalRemainder(action: string): SideEffectFamily {
  if (!action) return 'external_mutation';
  if (hasVerbWord(action, SEND_VERBS)) return 'external_send';
  if (hasVerbWord(action, READ_VERBS)) return 'readonly';
  return 'external_mutation';
}

/** The ACTION segment of a generic MCP tool name, UPPERCASED. `mcp__server__send_msg` → 'SEND_MSG'. */
function mcpActionSegment(tool: string): string {
  const parts = tool.slice('mcp__'.length).split('__');
  if (parts.length < 2) return '';
  return parts.slice(1).join('__').toUpperCase();
}

function getCommand(input: unknown): string | null {
  if (input && typeof input === 'object' && 'command' in (input as Record<string, unknown>)) {
    const v = (input as Record<string, unknown>).command;
    return typeof v === 'string' ? v : null;
  }
  return null;
}

function getPatchInput(input: unknown): string | null {
  if (input && typeof input === 'object' && 'input' in (input as Record<string, unknown>)) {
    const v = (input as Record<string, unknown>).input;
    return typeof v === 'string' ? v : null;
  }
  return null;
}
