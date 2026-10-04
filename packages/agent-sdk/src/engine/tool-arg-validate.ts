/**
 * tool-arg-validate.ts — the dispatcher's schema gate (ring 4d; sits right after
 * tool-arg-coerce's normalization).
 *
 * WHY: every native tool declares a Zod param schema and every model occasionally
 * violates it (a missing required field, a number as a string, an enum typo). Until
 * now the call went straight to execute(): the tool either threw deep inside (an
 * opaque stack the model cannot act on) or silently did the wrong thing. A violating
 * call is now refused at the ONE dispatch boundary with the exact issues, so the model
 * self-corrects next round and no tool ever sees input it did not declare.
 *
 * VALIDATE-ONLY: on success the caller passes its ORIGINAL input on — never
 * `parsed.data` (Zod strips unknown keys and applies defaults; every call that is
 * valid today must stay byte-identical). Top-level `null` values are dropped from the
 * VALIDATED VIEW only: models send null for optional fields, Zod's .optional()
 * rejects null, and today's tools already receive and tolerate it.
 *
 * The null-strip assumes `.nullable()` always rides with `.optional()` — true for every
 * native schema today (strict:true tools need `.nullable().optional()` for OpenAI
 * constrained decoding; see apps/sandbox/src/harness/tools/mcp-search-tool.ts). A
 * required-but-nullable field sent as null would be refused as missing.
 *
 * Duck-typed like tool-arg-coerce.ts — anything exposing `safeParse` is validated;
 * JSON-Schema parameters (MCP tools) have none and pass through. Never imports zod.
 */

interface SafeParseIssue { path?: PropertyKey[]; message?: string }
interface SafeParseResult { success: boolean; error?: { issues?: SafeParseIssue[] } }
interface SafeParseLike { safeParse: (input: unknown) => SafeParseResult }

export type ToolArgValidation = { ok: true } | { ok: false; issues: string[] };

const MAX_ISSUES = 5;

function hasSafeParse(p: unknown): p is SafeParseLike {
  return typeof p === 'object' && p !== null && typeof (p as { safeParse?: unknown }).safeParse === 'function';
}

function withoutTopLevelNulls(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (v !== null) out[k] = v;
  }
  return out;
}

export function validateToolArgs(input: unknown, parameters: unknown): ToolArgValidation {
  if (!hasSafeParse(parameters)) return { ok: true };
  let result: SafeParseResult | undefined;
  try {
    result = parameters.safeParse(withoutTopLevelNulls(input));
  } catch {
    return { ok: true };
  }
  // A non-result (anything without `success: false`) is the schema's bug too — never refuse on it.
  if (result?.success !== false) return { ok: true };
  const issues = (result.error?.issues ?? []).slice(0, MAX_ISSUES).map((i) => {
    const path = (i.path ?? []).map(String).join('.');
    const msg = i.message ?? 'invalid';
    return path ? `${path}: ${msg}` : msg;
  });
  return { ok: false, issues: issues.length ? issues : ['input does not match the tool schema'] };
}

/** What the model reads back: the tool, the issues, the next move. */
export function formatToolArgIssues(toolName: string, issues: string[]): string {
  return `Invalid arguments for ${toolName}: ${issues.join('; ')}. Fix the arguments and call the tool again.`;
}
