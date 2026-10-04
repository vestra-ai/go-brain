/**
 * gemini-tool-schema — translate an OpenAI-flavored tool parameter schema into the
 * subset Gemini's `FunctionDeclaration.parameters` (the Gemini `Schema` object)
 * accepts. Our tool schemas (via `toOpenAIToolJsonSchema`) carry keys Gemini rejects
 * — notably `additionalProperties` and `$schema` — so without this EVERY Gemini tool
 * list 400s ("Unknown name 'additionalProperties'") and the arm can't run tools.
 *
 * A faithful TS port of Hermes' `gemini_schema.py`
 * (`sanitize_gemini_schema` / `sanitize_gemini_tool_parameters`).
 */

/** The documented Gemini `Schema` subset of OpenAPI 3.0 / JSON Schema keys. */
const GEMINI_SCHEMA_ALLOWED_KEYS = new Set<string>([
  'type', 'format', 'title', 'description', 'nullable', 'enum',
  'maxItems', 'minItems', 'properties', 'required', 'minProperties',
  'maxProperties', 'minLength', 'maxLength', 'pattern', 'example',
  'anyOf', 'propertyOrdering', 'default', 'items', 'minimum', 'maximum',
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Return a Gemini-compatible copy of a tool parameter schema: keep only the allowed
 * keys, recursively sanitize nested `properties` / `items` / `anyOf`, and drop a
 * typed `enum` (Gemini requires every enum entry to be a string, even when the parent
 * type is integer/number/boolean — OpenAI/Anthropic accept typed enums, Gemini does not).
 */
export function sanitizeGeminiSchema(schema: unknown): Record<string, unknown> {
  if (!isObject(schema)) return {};

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!GEMINI_SCHEMA_ALLOWED_KEYS.has(key)) continue;
    if (key === 'properties') {
      if (!isObject(value)) continue;
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        props[propName] = sanitizeGeminiSchema(propSchema);
      }
      cleaned[key] = props;
      continue;
    }
    if (key === 'items') {
      cleaned[key] = sanitizeGeminiSchema(value);
      continue;
    }
    if (key === 'anyOf') {
      if (!Array.isArray(value)) continue;
      cleaned[key] = value.filter(isObject).map(sanitizeGeminiSchema);
      continue;
    }
    // A JSON Schema type array (`["string", "null"]`: TOOL_SCHEMA_COMPACT_V1's nullable form,
    // or an MCP server's own schema) is not a Gemini `type`, which names ONE type. Gemini's
    // form: the one non-null type, plus `nullable: true` when null was listed; several
    // non-null types become an anyOf of each.
    if (key === 'type' && Array.isArray(value)) {
      const types = value.filter((t): t is string => typeof t === 'string');
      const nonNull = types.filter((t) => t !== 'null');
      if (nonNull.length === 1) cleaned.type = nonNull[0];
      else if (nonNull.length > 1) cleaned.anyOf = nonNull.map((t) => ({ type: t }));
      if (nonNull.length < types.length) cleaned.nullable = true;
      continue;
    }
    cleaned[key] = value;
  }

  // Drop a typed enum (non-string entries with an integer/number/boolean type) — the
  // type + description still guide the model and the tool handler validates the value.
  const enumVal = cleaned.enum;
  const typeVal = cleaned.type;
  if (
    Array.isArray(enumVal) &&
    (typeVal === 'integer' || typeVal === 'number' || typeVal === 'boolean') &&
    enumVal.some((item) => typeof item !== 'string')
  ) {
    delete cleaned.enum;
  }

  return cleaned;
}

/** Normalize tool parameters to a VALID Gemini object schema (never empty). */
export function sanitizeGeminiToolParameters(parameters: unknown): Record<string, unknown> {
  const cleaned = sanitizeGeminiSchema(parameters);
  if (Object.keys(cleaned).length === 0) return { type: 'object', properties: {} };
  return cleaned;
}
