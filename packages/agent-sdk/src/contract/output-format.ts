/**
 * OutputFormat — provider-neutral, run-level declaration that the agent's
 * FINAL-turn answer is constrained to a JSON Schema (K6 P6, design doc
 * docs/superpowers/specs/2026-06-21-k6-p6-structured-output-design.md §E0).
 *
 * The schema is restricted to the JSON-Schema *subset* that providers can
 * constrain with native constrained decoding (Anthropic `output_config.format`,
 * OpenAI `json_schema` strict). The runtime subset guard + value-conformance
 * checker live in `./validate-output.ts`; this file is types only (zero runtime).
 *
 * Versioning: adding an optional field to a node is non-breaking. Widening the
 * subset (a new keyword) is a MINOR change that must be mirrored in
 * validateOutputSchema before any transport starts forwarding it.
 */

/** Primitive + container JSON-Schema types we support. */
export type JsonSchemaType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null';

/**
 * One node of the supported JSON-Schema subset. Intentionally permissive at the
 * type level (every field optional) — the *real* subset enforcement is the
 * runtime `validateOutputSchema` guard, which rejects unsupported keywords and
 * recursion. Keep this structural so a hand-authored schema literal type-checks
 * without ceremony.
 */
export interface JsonSchemaNode {
  type?: JsonSchemaType;
  /** Object: property name → child node. */
  properties?: Record<string, JsonSchemaNode>;
  /** Object: required property names. */
  required?: string[];
  /** Object: MUST be literal `false` in the subset (no open objects). */
  additionalProperties?: boolean;
  /** Array: element schema. */
  items?: JsonSchemaNode;
  /** Array: only 0 or 1 permitted in the subset. */
  minItems?: number;
  /** Closed value set (any JSON scalar/null). */
  enum?: Array<string | number | boolean | null>;
  /** Union of sub-schemas. */
  anyOf?: JsonSchemaNode[];
  /** Human-readable hint (passed through to the provider). */
  description?: string;
}

/** The root schema of an OutputFormat — a JSON-Schema subset node. */
export type JsonSchemaSubset = JsonSchemaNode;

/**
 * Run-level output-format declaration. One per run, enforced on the final turn.
 */
export interface OutputFormat {
  type: 'json_schema';
  schema: JsonSchemaSubset;
  /** Optional schema name forwarded to providers that want one (OpenAI). */
  name?: string;
}
