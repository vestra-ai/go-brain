/**
 * tool-arg-coerce.ts — model-agnostic tool-argument normalization (ring 4c).
 *
 * WHY: the native arm is model-agnostic, but models disagree on how they serialize
 * a nested object/array tool argument. Anthropic emits it as a real object; open
 * models (DeepSeek/GLM via Fireworks) emit the *whole field* as a STRINGIFIED JSON
 * value inside the tool call — e.g. mcp_invoke's `args` arrives as
 *   "{\"path\": \"/app/workspace\"}"   instead of   { path: "/app/workspace" }.
 * The tool's execute() (and the MCP server behind it) then rejects it with
 * "expected record, received string". This is not a per-tool bug — every native tool
 * with an object/array/record/tuple param is exposed the same way (mcp_invoke,
 * task metadata, ask_user_question questions, agent tools, weave phases/budget,
 * web_fetch urls, web_search domains, …). So the fix lives at the ONE dispatch
 * boundary (tool-dispatcher.ts), not in any single tool.
 *
 * WHAT: schema-driven and conservative. A top-level field is JSON.parsed ONLY when
 *   (a) the tool's Zod param schema declares it object/array/record/tuple, AND
 *   (b) the model sent a string that visibly looks like JSON ('{' or '['), AND
 *   (c) it parses to the matching kind.
 * Anything else — an already-parsed object, a genuinely-string field, a non-JSON
 * string, or a kind mismatch — is left untouched so the tool/schema errors clearly
 * instead of us masking it. The Anthropic object path is byte-identical (the SAME
 * input reference is returned when nothing is coerced).
 *
 * Zod is duck-typed via `_def` (NO zod import) so this stays version-agnostic —
 * `RawToolOptions.parameters` is deliberately typed `unknown` (tool-types.ts). Both
 * shapes are read: zod 4 uses `_def.type` ('object'|'optional'|'record'|…); zod 3
 * used `_def.typeName` ('ZodObject'|…). Wrappers hold the inner schema in
 * `innerType` (zod 4 + zod 3) or `schema` (zod 3 effects).
 */

type StructuredKind = 'object' | 'record' | 'array' | 'tuple';

interface ZodDefLike {
  type?: string; // zod 4
  typeName?: string; // zod 3
  innerType?: unknown;
  schema?: unknown;
  shape?: unknown;
}

const WRAPPER_TAGS = new Set([
  // zod 4 (_def.type)
  'optional',
  'nullable',
  'default',
  'prefault',
  'nonoptional',
  'readonly',
  'catch',
  // zod 3 (_def.typeName)
  'ZodOptional',
  'ZodNullable',
  'ZodDefault',
  'ZodReadonly',
  'ZodCatch',
  'ZodEffects',
  'ZodBranded',
]);

function defOf(schema: unknown): ZodDefLike | undefined {
  const s = schema as { _def?: ZodDefLike; _zod?: { def?: ZodDefLike } } | null | undefined;
  return s?._def ?? s?._zod?.def;
}

// The base tag, normalized so callers compare against lowercase zod-4 names.
function tagOf(def: ZodDefLike | undefined): string | undefined {
  return def?.type ?? def?.typeName;
}

function zodObjectShape(schema: unknown): Record<string, unknown> | null {
  const def = defOf(schema);
  const tag = tagOf(def);
  if (tag !== 'object' && tag !== 'ZodObject') return null;
  const s = schema as { shape?: unknown };
  const raw = s.shape ?? (typeof def?.shape === 'function' ? (def.shape as () => unknown)() : def?.shape);
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
}

function structuredKind(field: unknown): StructuredKind | null {
  let def = defOf(field);
  let guard = 0;
  while (def && WRAPPER_TAGS.has(tagOf(def) as string) && guard++ < 12) {
    def = defOf(def.innerType ?? def.schema);
  }
  switch (tagOf(def)) {
    case 'object':
    case 'ZodObject':
      return 'object';
    case 'record':
    case 'ZodRecord':
      return 'record';
    case 'array':
    case 'ZodArray':
      return 'array';
    case 'tuple':
    case 'ZodTuple':
      return 'tuple';
    default:
      return null;
  }
}

/**
 * Normalize a model's tool input against the tool's Zod param schema: coerce a
 * stringified-JSON value into the object/array the schema declares. Returns the
 * SAME reference when nothing is coerced (byte-identical for the object path).
 */
export function coerceStringifiedToolArgs(input: unknown, parameters: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;
  const shape = zodObjectShape(parameters);
  if (!shape) return input;

  const src = input as Record<string, unknown>;
  let out: Record<string, unknown> | undefined;

  for (const key of Object.keys(src)) {
    const value = src[key];
    if (typeof value !== 'string') continue;
    const kind = structuredKind(shape[key]);
    if (kind === null) continue;

    const trimmed = value.trim();
    const first = trimmed.charCodeAt(0);
    const looksArray = first === 0x5b; // '['
    const looksObject = first === 0x7b; // '{'
    if (!looksArray && !looksObject) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // not valid JSON — leave it; the tool/schema will report clearly.
    }

    const parsedIsArray = Array.isArray(parsed);
    const parsedIsObject = parsed !== null && typeof parsed === 'object' && !parsedIsArray;
    const matches = kind === 'array' || kind === 'tuple' ? parsedIsArray : parsedIsObject;
    if (!matches) continue;

    if (!out) out = { ...src };
    out[key] = parsed;
  }

  return out ?? input;
}
