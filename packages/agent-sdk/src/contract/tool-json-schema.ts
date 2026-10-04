/**
 * tool-json-schema — the ONE Zod → JSON Schema conversion for tool parameters,
 * shared by every provider lane.
 *
 * `RawToolOptions.parameters` is a Zod schema OBJECT at runtime. A transport that
 * ships it straight through sends a Zod-internal blob (`{def:...}`) with NO
 * `properties`/`required` and — because `.describe()` text lives inside the Zod
 * internals the serializer never reaches — none of the per-field docs the tool
 * authored. The model then invents argument keys, and pays for the `def` wrappers.
 *
 * This lived in `transports/openai-tool-schema.ts` while OpenAI was the only lane
 * that converted. Every lane converts now — the narration injector runs this on the
 * way to EVERY provider — and the engine may not import from `transports/`
 * (engine-neutrality invariant), so the converter moves here, mirroring the earlier
 * relocation of `isOpenAIStrictCompatible` to `contract/openai-strict-schema.ts`.
 * Provider-specific massaging (OpenAI's per-tool strict gate, Gemini's key
 * allowlist) stays in each lane; the conversion itself is provider-neutral.
 */
import { z } from 'zod';
import { toolDescLeanEnabled, toolDescTrimEnabled, toolSchemaCompactEnabled } from '../policy/feature-flags.js';
import { isOpenAIStrictCompatible } from './openai-strict-schema.js';

/** A converted JSON Schema (a plain object a provider accepts as tool parameters). */
export type JsonSchema = Record<string, unknown>;

/** The empty-object schema used when a tool declares no params (`null`/`undefined`). */
const EMPTY_OBJECT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

/**
 * Convert a tool's `parameters` (a Zod schema instance, or null/undefined) into a
 * JSON Schema.
 *
 * - `null`/`undefined` (a no-param tool) → a strict-safe empty-object schema.
 * - A Zod schema → `z.toJSONSchema(s, { target:'draft-2020-12', unrepresentable:'any' })`.
 *   `unrepresentable:'any'` makes a `z.any()`/`z.unknown()` field degrade to `{}`
 *   instead of THROWING (the default), so conversion can never crash buildTools.
 * - Anything else (already a plain JSON Schema, or a non-Zod value) is returned as
 *   an object as-is (defensive; production always passes Zod or null).
 *
 * Never throws.
 */
export function toToolJsonSchema(parameters: unknown): JsonSchema {
  if (parameters == null) return { ...EMPTY_OBJECT_SCHEMA };
  // A Zod schema instance — convert. `unrepresentable:'any'` so an unrepresentable
  // leaf (z.any/z.unknown) becomes `{}` rather than throwing and killing the build.
  if (parameters instanceof z.ZodType) {
    try {
      const schema = z.toJSONSchema(parameters, {
        target: 'draft-2020-12',
        unrepresentable: 'any',
      }) as JsonSchema;
      if (toolDescTrimEnabled()) dropSafeIntBounds(schema);
      const out = toolSchemaCompactEnabled() ? (compactNullableTypes(schema) as JsonSchema) : schema;
      return !toolDescTrimEnabled() && toolDescLeanEnabled() ? dropSafeIntBoundsIfStrictNeutral(out) : out;
    } catch {
      // Defense-in-depth: if a future schema construct still throws, fall back to an
      // unconstrained object schema rather than crashing the whole tool list.
      return { type: 'object', additionalProperties: true };
    }
  }
  // Already a plain object (e.g. a pre-built JSON Schema) — pass through. Under
  // TOOL_SCHEMA_COMPACT_V1 a compacted COPY (an MCP tool's schema is the caller's object).
  if (typeof parameters === 'object') {
    return toolSchemaCompactEnabled() ? (compactNullableTypes(parameters) as JsonSchema) : (parameters as JsonSchema);
  }
  return { ...EMPTY_OBJECT_SCHEMA };
}

/**
 * TOOL_DESC_TRIM_V1 — zod gives every `.int()` the JS safe-integer range as JSON Schema
 * bounds (`minimum: -9007199254740991`, `maximum: 9007199254740991`): about 13 tokens per
 * integer field that tell a model nothing. Dropped from the ADVERTISED schema only; the
 * dispatcher still validates every call against the Zod schema itself
 * (engine/tool-arg-validate.ts), so the range is enforced exactly as before. A real bound
 * (`.positive()`'s exclusiveMinimum, a declared max) is never one of these two numbers and
 * stays. Mutates the fresh object toJSONSchema just returned.
 */
function dropSafeIntBounds(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) dropSafeIntBounds(item);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  if (o.minimum === -Number.MAX_SAFE_INTEGER) delete o.minimum;
  if (o.maximum === Number.MAX_SAFE_INTEGER) delete o.maximum;
  for (const v of Object.values(o)) dropSafeIntBounds(v);
}

/**
 * TOOL_DESC_LEAN_V1 — the same zero-information bounds, dropped only where that leaves the
 * tool's OpenAI strict status (isOpenAIStrictCompatible, the gate both OpenAI lanes apply to
 * this very schema) where it was. Under TOOL_DESC_TRIM_V1 the strip turned Monitor, TaskOutput
 * and stop_app from strict:false to strict:true, which changes how a model fills their
 * arguments; those keep their bounds here, and every other tool's schema loses ~13 tokens per
 * integer field with nothing else different. Judged after the compaction step, so it holds
 * with TOOL_SCHEMA_COMPACT_V1 on or off. Returns the input when nothing would change.
 */
function dropSafeIntBoundsIfStrictNeutral(schema: JsonSchema): JsonSchema {
  if (!JSON.stringify(schema).includes(String(Number.MAX_SAFE_INTEGER))) return schema;
  const lean = structuredClone(schema);
  dropSafeIntBounds(lean);
  return isOpenAIStrictCompatible(lean) === isOpenAIStrictCompatible(schema) ? lean : schema;
}

/** The JSON Schema types a nullable union collapses for: one primitive per field. */
const COMPACTABLE_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'integer', 'boolean']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** `{type: 'null'}` and nothing else: zod's null branch. */
function isBareNull(v: unknown): boolean {
  return isPlainObject(v) && v.type === 'null' && Object.keys(v).length === 1;
}

/**
 * A branch whose values a type array can carry exactly: one primitive type and no keyword that
 * would reject the null (an `enum` or `const` lists its values, and null is not among them) and
 * no nested union.
 */
function isCompactableBranch(v: unknown): v is Record<string, unknown> {
  return isPlainObject(v)
    && typeof v.type === 'string' && COMPACTABLE_TYPES.has(v.type)
    && !('enum' in v) && !('const' in v) && !('anyOf' in v) && !('oneOf' in v) && !('allOf' in v);
}

/**
 * TOOL_SCHEMA_COMPACT_V1 (harness to nine, T1b finish) — a nullable primitive field as a type
 * array: `anyOf: [{type: T, ...}, {type: 'null'}]` becomes `{type: [T, 'null'], ...}`, the same
 * JSON Schema (draft 2020-12 allows a type array; OpenAI strict documents it as the nullable
 * form) in about 5 fewer tokens per field. zod emits every `.nullable()` as the anyOf, and the
 * wide resident core carries about thirty of them (65 in the whole bench catalog). Only a two-branch union of a bare null and a
 * compactable primitive collapses (see isCompactableBranch); every other union, and every
 * object or array branch, is left exactly as it was. The branch's own keywords (bounds,
 * format) and the field's (its description) are kept. Pure and idempotent: returns a new tree.
 * The Gemini lanes turn a type array into their own `nullable: true` form
 * (transports/gemini-tool-schema.ts).
 */
export function compactNullableTypes(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(compactNullableTypes);
  if (!isPlainObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = compactNullableTypes(v);
  const branches = out.anyOf;
  if (Array.isArray(branches) && branches.length === 2) {
    const nullAt = branches.findIndex(isBareNull);
    const other = nullAt === -1 ? undefined : branches[1 - nullAt];
    if (isCompactableBranch(other)) {
      const { anyOf: _union, ...field } = out;
      const { type, ...keywords } = other;
      return { type: [type, 'null'], ...keywords, ...field };
    }
  }
  return out;
}

/** The keywords of a string branch: they move back into it when a type array is expanded. */
const STRING_BRANCH_KEYWORDS: ReadonlySet<string> = new Set([
  'minLength', 'maxLength', 'pattern', 'format', 'contentEncoding', 'contentMediaType',
]);

/**
 * The inverse of compactNullableTypes for STRING fields only: `{type: ['string', 'null'], ...}`
 * goes back to zod's `anyOf: [{type: 'string', ...string keywords}, {type: 'null'}]`, the field's
 * own keywords (its description, a default) kept on the field. For a lane whose model mangles a
 * nullable string sent as a type array (live on staging 2 Oct, the Fireworks DeepSeek lane: a
 * stray `>` and a closing tag leaked into the value of an optional string such as Bash's
 * `description` or Grep's `path`; required strings and integer type arrays came through clean).
 * Integer, number and boolean type arrays stay compact. Pure: returns a new tree.
 */
export function expandNullableStringTypes(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(expandNullableStringTypes);
  if (!isPlainObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = expandNullableStringTypes(v);
  const t = out.type;
  if (Array.isArray(t) && t.length === 2 && t.includes('string') && t.includes('null')) {
    const { type: _typeArray, ...rest } = out;
    const branch: Record<string, unknown> = { type: 'string' };
    const field: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (STRING_BRANCH_KEYWORDS.has(k)) branch[k] = v;
      else field[k] = v;
    }
    return { anyOf: [branch, { type: 'null' }], ...field };
  }
  return out;
}
