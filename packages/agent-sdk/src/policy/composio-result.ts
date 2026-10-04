/**
 * Composio tool RESULT / FAILURE classification — shared policy.
 *
 * The PRE decision (classifyToolCall) already lives in the shared policy layer.
 * The two POST decisions used to live ONLY inside Claude-SDK hooks
 * (`composio-posttool-auth-hook.ts` + the PostToolUseFailure hook in
 * `hooks/index.ts`), so a non-Claude harness physically could not run them —
 * the OpenAI arm had no auth-URL result scan and no failure classification,
 * which is how a Composio auth flow could reach the user with no substrate row
 * (deadlock) and a tool failure had no recoverable signal.
 *
 * These pure functions are the single home for both POST decisions, consumed
 * identically by every harness (Claude hooks re-point here; the OpenAI MCP
 * wrapper calls them after `server.callTool`). No I/O, no SDK types — just
 * input → verdict.
 */

import { COMPOSIO_TOOL_PREFIX } from './engine-constants.js';
import { extractToolkitFromToolName } from './composio-naming.js';

/**
 * Composio's hosted OAuth surfaces. Restricting to these hosts prevents
 * misfiring on tool results that merely mention the platform — only an actual
 * connection shortlink should trigger an auth gate.
 * `(platform|connect|app).composio.dev/link/*` are the user-facing shortlinks
 * `INITIATE_CONNECTION` returns. We deliberately do NOT match
 * `backend.composio.dev/api/v1/auth-apps/add` (a raw provider redirect URI).
 */
export const COMPOSIO_AUTH_URL_PATTERN =
  /https?:\/\/(?:platform|connect|app)\.composio\.dev\/link\/[A-Za-z0-9_-]+/;

/**
 * Object keys that, alongside a value matching the auth-URL pattern, are taken
 * as auth signals. Multiple keys because Composio tool shapes are inconsistent.
 */
const AUTH_URL_FIELD_KEYS = new Set([
  'auth_url',
  'authUrl',
  'redirectUrl',
  'redirect_url',
]);

/**
 * Recursively scan a value for a Composio auth URL. Returns the first match or
 * null. The host-pattern check applies to both the free-string and keyed paths
 * so a `redirectUrl` pointing elsewhere never triggers. Depth-capped (8) so a
 * circular structure can't loop.
 */
export function findComposioAuthUrl(value: unknown, depth = 0): string | null {
  if (depth > 8) return null;
  if (typeof value === 'string') {
    const m = value.match(COMPOSIO_AUTH_URL_PATTERN);
    return m ? m[0] : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findComposioAuthUrl(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (AUTH_URL_FIELD_KEYS.has(k) && typeof v === 'string') {
        const m = v.match(COMPOSIO_AUTH_URL_PATTERN);
        if (m) return m[0];
      }
      const found = findComposioAuthUrl(v, depth + 1);
      if (found) return found;
    }
    return null;
  }
  return null;
}

/**
 * Unwrap a tool result into something scannable. Tool results arrive as a raw
 * string (often stringified JSON), an MCP content-block array
 * `[{type:'text',text}]`, or a structured object. JSON-y strings are parsed so
 * the URL-key heuristic can match; failed parses fall through to the raw scan.
 */
export function normalizeToolResponse(toolResponse: unknown): unknown {
  if (typeof toolResponse === 'string') {
    const trimmed = toolResponse.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { return JSON.parse(trimmed); } catch { /* fall through */ }
    }
    return toolResponse;
  }
  if (Array.isArray(toolResponse)) {
    const textParts = toolResponse
      .filter((b): b is { type: string; text: string } =>
        !!b && typeof b === 'object'
        && (b as Record<string, unknown>).type === 'text'
        && typeof (b as Record<string, unknown>).text === 'string',
      )
      .map(b => b.text);
    if (textParts.length > 0) {
      const joined = textParts.join('\n');
      const trimmed = joined.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try { return JSON.parse(trimmed); } catch { return joined; }
      }
      return joined;
    }
    return toolResponse;
  }
  return toolResponse;
}

/**
 * Best-effort toolkit extraction. Order: result keys → input keys →
 * tool-name-derived. Returns null when no confident toolkit (meta-tool names
 * like `COMPOSIO_INITIATE_CONNECTION` derive 'composio', which we reject so the
 * caller declines rather than registering an orphan auth interaction).
 */
export function extractToolkitFromContext(
  toolResponse: unknown,
  toolInput: unknown,
  toolName: string,
): string | null {
  const RESULT_KEYS = ['toolkit', 'toolkitSlug', 'app', 'appName', 'appUniqueId'];
  const INPUT_KEYS = ['toolkit', 'app', 'appName'];

  const scanFor = (value: unknown, keys: string[], depth = 0): string | null => {
    if (depth > 5) return null;
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = scanFor(item, keys, depth + 1);
        if (found) return found;
      }
      return null;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (keys.includes(k) && typeof v === 'string' && v.length > 0 && v.length < 50) {
        return v.toLowerCase();
      }
      const found = scanFor(v, keys, depth + 1);
      if (found) return found;
    }
    return null;
  };

  const fromResult = scanFor(toolResponse, RESULT_KEYS);
  if (fromResult) return fromResult;
  const fromInput = scanFor(toolInput, INPUT_KEYS);
  if (fromInput) return fromInput;
  const fromName = extractToolkitFromToolName(toolName);
  if (fromName === 'composio' || fromName === 'service' || fromName === 'my') return null;
  return fromName;
}

/** A Composio tool result that carries an OAuth shortlink → needs a substrate auth row. */
export interface ComposioAuthRequired {
  kind: 'auth_required';
  toolkit: string;
  authUrl: string;
}

/**
 * Classify a Composio tool RESULT. Returns `auth_required` when the result
 * contains a Composio auth shortlink AND a toolkit can be confidently derived
 * (so a substrate row can be registered and resolved); otherwise null.
 *
 * Used by BOTH arms: the Claude PostToolUse hook and the OpenAI MCP wrapper
 * (after `server.callTool`). Keeping it pure means the two arms can't diverge.
 */
export function classifyComposioToolResult(
  toolName: string,
  toolInput: unknown,
  toolResponse: unknown,
): ComposioAuthRequired | null {
  if (!toolName?.startsWith(COMPOSIO_TOOL_PREFIX)) return null;
  const normalized = normalizeToolResponse(toolResponse);
  const authUrl = findComposioAuthUrl(normalized);
  if (!authUrl) return null;
  const toolkit = extractToolkitFromContext(normalized, toolInput, toolName);
  if (!toolkit) return null;
  return { kind: 'auth_required', toolkit, authUrl };
}

/** A Composio tool that threw → a recoverable failure the UI should surface. */
export interface ComposioRecoverableFailure {
  kind: 'recoverable';
  category: 'mcp';
  message: string;
}

/**
 * Classify a THROWN Composio tool error (the PostToolUseFailure path on Claude;
 * the `server.callTool` catch on the OpenAI arm). Returns a recoverable failure
 * for any `mcp__composio__*` tool, else null. The message matches the existing
 * Claude failure-hook copy so behavior is identical across arms.
 */
export function classifyComposioToolFailure(
  toolName: string,
  _error: string,
): ComposioRecoverableFailure | null {
  if (!toolName?.startsWith(COMPOSIO_TOOL_PREFIX)) return null;
  return {
    kind: 'recoverable',
    category: 'mcp',
    message: 'Composio integration tools failed to connect. This usually resolves by sending another message.',
  };
}

/**
 * A COMPOSIO_MANAGE_CONNECTIONS that minted no connect flow for one or more
 * toolkits. Composio reports this as `status: 'failed'` per toolkit with no
 * shortlink: most often the toolkit has no Composio-managed auth and we hold no
 * auth config of our own for it (Spotify, 2026-09-21), so there is nothing the
 * person could click. Left alone, the agent drops to the browser and the person
 * never hears why.
 */
export interface ComposioConnectUnavailable {
  kind: 'connect_unavailable';
  toolkits: string[];
}

const MANAGE_CONNECTIONS_TOOL = `${COMPOSIO_TOOL_PREFIX}COMPOSIO_MANAGE_CONNECTIONS`;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Classify a MANAGE_CONNECTIONS result by its structured per-toolkit status
 * (`data.results[slug].status`), never by its prose. The raw MCP result
 * (`{ content: [...] }`, the native arm), a content-block array or a JSON
 * string (the Claude hook) all read the same. Null for any other tool, any
 * unparseable result, or a batch with no failed toolkit.
 */
export function classifyComposioConnectUnavailable(
  toolName: string,
  toolResponse: unknown,
): ComposioConnectUnavailable | null {
  if (toolName !== MANAGE_CONNECTIONS_TOOL) return null;
  const unwrapped = isRecord(toolResponse) && Array.isArray(toolResponse.content) ? toolResponse.content : toolResponse;
  const parsed = normalizeToolResponse(unwrapped);
  const data = isRecord(parsed) ? parsed.data : undefined;
  const results = isRecord(data) ? data.results : undefined;
  if (!isRecord(results)) return null;
  const toolkits: string[] = [];
  for (const [slug, entry] of Object.entries(results)) {
    if (!isRecord(entry) || entry.status !== 'failed' || findComposioAuthUrl(entry) !== null) continue;
    toolkits.push(typeof entry.toolkit === 'string' && entry.toolkit.length > 0 ? entry.toolkit : slug);
  }
  return toolkits.length > 0 ? { kind: 'connect_unavailable', toolkits } : null;
}

const appName = (slug: string): string => {
  const brand = slug.replace(/_mcp$/i, '');
  return brand.length > 0 ? brand.charAt(0).toUpperCase() + brand.slice(1) : 'This app';
};

/**
 * The harness's own note for the agent after an unavailable connect: tell the
 * person in one plain line, and ask before driving the browser instead. It is
 * harness text, so both arms deliver it OUTSIDE the untrusted-content fence
 * (the native dispatcher appends it after the close marker; the Claude hook
 * returns it as additionalContext), never inside the tool's own result.
 */
export function connectUnavailableTrailer(toolkits: string[]): string {
  const names = toolkits.map(appName);
  const apps = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  return (
    `[Vestra harness note] ${apps} could not be connected here right now. Tell the person in one plain line, ` +
    `without guessing at a cause, and ask before using the browser instead, e.g. "${apps} could not be connected ` +
    `here right now, so I would need to use the browser for it; say yes if that is okay." Wait for their answer ` +
    `before opening the browser.`
  );
}
