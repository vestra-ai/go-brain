/**
 * Pure Composio meta-tool naming helpers (ring 4b-2).
 *
 * Relocated from `apps/sandbox/src/utils/composio.ts` with the security engine
 * so the moved `tool-classifier.ts` imports only SDK siblings. These are pure
 * predicates over static data + the `COMPOSIO_TOOL_PREFIX` constant — no I/O,
 * no state. The product-side `utils/composio.ts` now re-exports them.
 */

import type { ToolCall } from '../contract/harness.js';
import { COMPOSIO_TOOL_PREFIX } from './engine-constants.js';

/**
 * Composio meta-tools. These NEVER trigger an auth prompt — they're how the
 * agent discovers tools and connects them. They auto-allow even for
 * unconnected toolkits (the auth prompt happens on the FIRST real tool call).
 *
 * Two mechanisms:
 *   - `COMPOSIO_META_TOOLS` — explicit whitelist of known names
 *   - `META_TOOL_PATTERNS` — namespace prefixes (`COMPOSIO_*`, `MY_*`) that
 *      match Composio's dynamic meta-tool families (e.g. `MY_CONNECTIONS`,
 *      `COMPOSIO_LIST_TRIGGERS`, etc.). Real per-service tools start with
 *      the toolkit name (`GMAIL_`, `SLACK_`, ...) so they never match.
 */
export const COMPOSIO_META_TOOLS = new Set([
  'mcp__composio__COMPOSIO_SEARCH_TOOLS',
  'mcp__composio__COMPOSIO_MANAGE_CONNECTIONS',
  'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL',
  'mcp__composio__COMPOSIO_CHECK_ACTIVE_CONNECTION',
]);

export const META_TOOL_PATTERNS: readonly RegExp[] = [
  /^mcp__composio__COMPOSIO_/i,
  /^mcp__composio__MY_/i,
];

export function isComposioMetaTool(toolName: string): boolean {
  if (COMPOSIO_META_TOOLS.has(toolName)) return true;
  return META_TOOL_PATTERNS.some(p => p.test(toolName));
}

/**
 * The WORKBENCH subset of the executor meta-tools: they run agent-authored CODE
 * (a `code`/`code_to_execute` payload, NOT a `tools[]` list) that can proxy real
 * tools via `run_composio_tool()`/`proxy_execute()`. The side-effect classifier
 * (`classifyMetaExecutor` → `classifyWorkbench`) scans that code — pure local
 * compute is a workspace_write, a proxied call classifies by its inner slug, and
 * an unreadable/dynamic slug fails toward 'unknown'.
 */
export const COMPOSIO_WORKBENCH_META_TOOLS: ReadonlySet<string> = new Set([
  'mcp__composio__COMPOSIO_REMOTE_WORKBENCH',
  'mcp__composio__COMPOSIO_WORKSPACE_EXECUTE',
  'mcp__composio__COMPOSIO_WORKSPACE_CREATE',
]);

export function isComposioWorkbenchMetaTool(toolName: string): boolean {
  return COMPOSIO_WORKBENCH_META_TOOLS.has(toolName);
}

/**
 * The doors into Composio's remote sandbox: the workbench subset plus the remote shell, which
 * runs in that same sandbox. What runs there can reach any connected app, and no reading of the
 * script can prove which, so the gate holds every per-app pin against them (remote-code-pins.ts).
 * Only the pin rule reads this set: the remote shell keeps its own classification.
 */
export const COMPOSIO_REMOTE_CODE_TOOLS: ReadonlySet<string> = new Set([
  ...COMPOSIO_WORKBENCH_META_TOOLS,
  'mcp__composio__COMPOSIO_REMOTE_BASH_TOOL',
]);

export function isComposioRemoteCodeTool(toolName: string): boolean {
  return COMPOSIO_REMOTE_CODE_TOOLS.has(toolName);
}

/**
 * The EXECUTOR subset of the meta-tools. CRITERION: any meta-tool that can
 * EXECUTE or PROXY another tool belongs here — its own name says nothing about
 * the side effect it will cause (incident 6aa39a0d: an inner GMAIL_SEND_EMAIL
 * rode MULTI_EXECUTE's harmless-looking name straight past external_send=ask).
 * This set is a floor of known members, not a completeness claim; audit it
 * whenever Composio ships a new meta-tool.
 *
 * Two payload shapes, each classified by what will ACTUALLY execute:
 *   - MULTI_EXECUTE_TOOL — runs the tools named in `toolInput.tools[]`; the
 *     classifier unwraps that payload and gates each inner tool.
 *   - the WORKBENCH subset (REMOTE_WORKBENCH / WORKSPACE_EXECUTE /
 *     WORKSPACE_CREATE) — runs agent-authored code; the classifier scans the
 *     code payload for proxied tool slugs (see COMPOSIO_WORKBENCH_META_TOOLS).
 *
 * SEARCH_TOOLS / MANAGE_CONNECTIONS / CHECK_ACTIVE_CONNECTION only discover
 * and connect — they are NOT executors.
 */
export const COMPOSIO_EXECUTOR_META_TOOLS: ReadonlySet<string> = new Set([
  'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL',
  ...COMPOSIO_WORKBENCH_META_TOOLS,
]);

export function isComposioExecutorMetaTool(toolName: string): boolean {
  return COMPOSIO_EXECUTOR_META_TOOLS.has(toolName);
}

/** One inner tool of an executor payload: UPPERCASE slug + lowercase toolkit. */
export interface InnerComposioTool {
  slug: string;
  toolkit: string;
}

/**
 * Per-entry slug tolerance — mirrors the sandbox display extractor
 * (apps/sandbox/src/sdk/tool-display.ts extractRealTool) so the gate reads the
 * same payload shapes the card renders.
 */
const INNER_SLUG_FIELDS = [
  'tool_slug', 'tool_name', 'toolName', 'name', 'action', 'action_name', 'slug',
] as const;

export function innerSlugOf(entry: unknown): string | null {
  if (typeof entry === 'string') return entry.trim() !== '' ? entry.trim() : null;
  if (entry && typeof entry === 'object') {
    for (const field of INNER_SLUG_FIELDS) {
      const v = (entry as Record<string, unknown>)[field];
      if (typeof v === 'string' && v.trim() !== '') return v.trim();
    }
  }
  return null;
}

/**
 * Toolkit slug of one inner-tool slug: text before the first `_`, whole slug
 * when none — the SAME split extractToolkitFromToolName applies to wire names,
 * so an inner slug resolves to the same app a direct call would. ONE home for
 * this derivation: the side-effect classifier (extractInnerComposioTools) and
 * the account-selection gate both read it.
 */
export function toolkitOfInnerSlug(rawSlug: string): string {
  const slug = rawSlug.toUpperCase();
  const underscore = slug.indexOf('_');
  return (underscore > 0 ? slug.slice(0, underscore) : slug).toLowerCase();
}

/**
 * The inner tools an executor meta-call will run, from its `toolInput.tools[]`
 * payload. Returns null when the call is not an executor meta-tool, the payload
 * is missing/unparseable/empty, or ANY entry lacks a resolvable slug — callers
 * must treat null as "could run anything" and fail toward asking. The toolkit
 * split (text before the first `_`, whole slug when none) matches
 * `extractToolkitFromToolName` so an inner slug resolves to the same app a
 * direct call would. A WORKBENCH call runs its code, never a list, so a
 * `tools[]` beside that code is a decoy the gate must not read: null. TOTAL —
 * never throws.
 */
export function extractInnerComposioTools(call: ToolCall): InnerComposioTool[] | null {
  try {
    if (
      !call ||
      typeof call.toolName !== 'string' ||
      !isComposioExecutorMetaTool(call.toolName) ||
      isComposioWorkbenchMetaTool(call.toolName)
    ) {
      return null;
    }
    const input = call.toolInput;
    if (!input || typeof input !== 'object') return null;
    const tools = (input as Record<string, unknown>).tools;
    if (!Array.isArray(tools) || tools.length === 0) return null;

    const inner: InnerComposioTool[] = [];
    for (const entry of tools) {
      const raw = innerSlugOf(entry);
      if (raw === null) return null; // one unreadable entry poisons the whole payload
      const slug = raw.toUpperCase();
      inner.push({ slug, toolkit: toolkitOfInnerSlug(raw) });
    }
    return inner;
  } catch {
    return null;
  }
}

/**
 * Why a MULTI_EXECUTE payload cannot run, in words the agent can act on, or null
 * when it can (or the call is not a tools[]-list executor; a WORKBENCH script is
 * code and is judged by the classifier). A payload with no usable list, or an
 * item that names no tool, cannot execute at all, so the gate hands it back to
 * the agent instead of asking a person to approve it (prod 2026-09-20, task
 * 46f85398: a sibling Notion row with no tool_slug became "Approve a payment").
 * TOTAL — never throws.
 */
export function unrunnableExecutorPayload(call: ToolCall): string | null {
  try {
    if (!call || typeof call.toolName !== 'string') return null;
    if (!isComposioExecutorMetaTool(call.toolName) || isComposioWorkbenchMetaTool(call.toolName)) return null;
    const shape = 'each item is {"tool_slug": "<TOOL>", "arguments": {...}}';
    const tools = call.toolInput && typeof call.toolInput === 'object'
      ? (call.toolInput as Record<string, unknown>).tools
      : undefined;
    if (!Array.isArray(tools) || tools.length === 0) {
      return `Nothing ran: "tools" must be a non-empty list, where ${shape}. Send the call again in that shape.`;
    }
    const index = tools.findIndex((entry) => innerSlugOf(entry) === null);
    if (index < 0) return null;
    const named = tools.map(innerSlugOf).find((slug): slug is string => slug !== null);
    return (
      `Nothing ran: item ${index + 1} of "tools" names no tool. Every item needs its own "tool_slug" and "arguments"` +
      (named ? ` (like item ${tools.findIndex((e) => innerSlugOf(e) === named) + 1}, "${named}")` : '') +
      `, and several rows or records for one tool go inside that item's own arguments, not as extra items. ` +
      `Send the call again with ${shape}.`
    );
  } catch {
    return null;
  }
}

export function extractToolkitFromToolName(toolName: string): string {
  if (!toolName.startsWith(COMPOSIO_TOOL_PREFIX)) return 'service';
  const suffix = toolName.slice(COMPOSIO_TOOL_PREFIX.length);
  const idx = suffix.indexOf('_');
  return (idx > 0 ? suffix.slice(0, idx) : suffix).toLowerCase();
}

/**
 * The toolkit slug for a permission card's brand icon ("gmail", "github", …),
 * or null when no single app names the call. Derived from the SAME unwrap the
 * gate uses, so the icon can never disagree with the decision:
 *   - direct Composio tool (`mcp__composio__GMAIL_SEND_EMAIL`)  -> "gmail"
 *   - executor meta-tool whose inner actions ALL share one toolkit -> that slug
 *     (a lone GMAIL_SEND_EMAIL laundered through MULTI_EXECUTE still shows Gmail)
 *   - executor meta-tool spanning several apps, or an opaque/unreadable payload
 *     (REMOTE_WORKBENCH), or the discovery meta-tools, or any non-Composio tool
 *     -> null (the card keeps its generic glyph). TOTAL — never throws.
 */
export function appSlugForToolCall(call: ToolCall): string | null {
  const toolName = call?.toolName;
  if (typeof toolName !== 'string' || toolName.length === 0) return null;
  if (isComposioExecutorMetaTool(toolName)) {
    const inner = extractInnerComposioTools(call);
    if (!inner || inner.length === 0) return null;
    const first = inner[0].toolkit;
    return inner.every((t) => t.toolkit === first) ? first : null;
  }
  // Discovery/connection meta-tools (SEARCH/MANAGE/CHECK, MY_*) name no app.
  if (isComposioMetaTool(toolName)) return null;
  if (toolName.startsWith(COMPOSIO_TOOL_PREFIX)) return extractToolkitFromToolName(toolName);
  return null;
}

/**
 * Human display names by lowercase toolkit slug — the ONE table every
 * user-facing surface in the SDK reads (`describeToolCall`/`describeRule`
 * humanization, the config-block deny copy). Mirrors the sandbox's
 * INTEGRATION_DISPLAY names (apps/sandbox/src/sdk/tool-display.ts) so a slug
 * renders identically on cards, grants, and deny messages.
 */
const TOOLKIT_DISPLAY_NAMES: Record<string, string> = {
  gmail: 'Gmail',
  github: 'GitHub',
  slack: 'Slack',
  notion: 'Notion',
  googledrive: 'Google Drive',
  googlecalendar: 'Google Calendar',
  googlesheets: 'Google Sheets',
  googledocs: 'Google Docs',
  trello: 'Trello',
  jira: 'Jira',
  linear: 'Linear',
  discord: 'Discord',
  twitter: 'Twitter',
  hubspot: 'HubSpot',
  salesforce: 'Salesforce',
  stripe: 'Stripe',
  airtable: 'Airtable',
  asana: 'Asana',
  figma: 'Figma',
  zoom: 'Zoom',
  dropbox: 'Dropbox',
  spotify: 'Spotify',
  youtube: 'YouTube',
  twilio: 'Twilio',
  mailchimp: 'Mailchimp',
  intercom: 'Intercom',
  reddit: 'Reddit',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  pinterest: 'Pinterest',
  shopify: 'Shopify',
  zendesk: 'Zendesk',
  clickup: 'ClickUp',
  monday: 'Monday',
  todoist: 'Todoist',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
};

/** "googledrive" → "Google Drive"; unknown slugs capitalize the first letter. */
export function toolkitDisplayName(slug: string): string {
  const key = slug.toLowerCase();
  return TOOLKIT_DISPLAY_NAMES[key] ?? (key.charAt(0).toUpperCase() + key.slice(1));
}
