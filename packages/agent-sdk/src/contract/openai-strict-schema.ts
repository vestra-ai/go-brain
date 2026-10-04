/**
 * openai-strict-schema — the PURE, provider-neutral predicate that decides whether
 * a JSON Schema is compatible with OpenAI Structured-Outputs `strict:true`.
 *
 * WHY IT LIVES IN contract/ (not transports/)
 * -------------------------------------------
 * This is a self-contained JSON-Schema object-walk with ZERO zod and ZERO provider
 * SDK usage — exactly the kind of pure rule the engine/contract layer is allowed to
 * depend on. Two CALLERS need it from DIFFERENT layers:
 *   - the OpenAI transport's per-tool strict gate (`transports/openai-responses-transport.ts`)
 *   - the engine's structured-output strict preflight (`engine/native-harness.ts`)
 * Keeping it in `transports/` forced an engine→transports import, which erodes the
 * engine-neutrality invariant (the engine must depend only on contract + kernel +
 * ports — the basis of the standalone-SDK packaging). Living here, both
 * transports→contract and engine→contract are allowed directions and no module
 * cycle is introduced. The zod-using Zod→JSON-Schema converter
 * (`toOpenAIToolJsonSchema`) deliberately STAYS in `transports/openai-tool-schema.ts`.
 *
 * THE 400 TRAP (why the gate exists)
 * ----------------------------------
 * OpenAI returns a 400 for the WHOLE request if ANY schema sent with `strict:true`
 * is not strict-compatible. OpenAI strict requires, at EVERY object level:
 * `additionalProperties:false` AND every key in `properties` also in `required`,
 * AND only a whitelisted set of keywords (no type-specific CONSTRAINT keywords).
 * A schema using `.nullable().optional()` drops the field from `required`; a
 * `z.number().int()` emits `minimum`/`maximum`. Both are strict-INcompatible, so a
 * caller must downgrade to `strict:false` (transport) or fail closed (engine
 * preflight) rather than 400.
 */

/**
 * Is `schema` compatible with OpenAI Structured-Outputs `strict:true`?
 *
 * Strict requires, recursively at EVERY object level:
 *   - `additionalProperties === false`
 *   - every key in `properties` is also present in `required`
 *
 * We recurse into `properties.*`, array `items`, and `anyOf`/`oneOf`/`allOf`
 * branches (a `.nullable()` field is emitted as `anyOf:[T,null]`, and the `null`
 * branch and any nested object branch must also satisfy the rule). A non-object
 * leaf (string/number/boolean/null) is trivially compatible.
 *
 * Conservative: any shape we are unsure about returns `false` (→ strict:false),
 * which is always 400-safe.
 */
export function isOpenAIStrictCompatible(schema: unknown): boolean {
  // A tool's converted `parameters` is always an object schema. A non-object input
  // is unexpected → treat as not-strict-safe (→ strict:false, always 400-safe).
  if (schema == null || typeof schema !== 'object') return false;
  return isStrictNode(schema);
}

/**
 * The keywords OpenAI Structured-Outputs `strict:true` ACCEPTS on a JSON-Schema
 * node — a WHITELIST. Everything here is either structural (drives the shape the
 * model generates) or pure metadata (ignored by constrained decoding).
 *
 * Any OTHER keyword — every type-specific CONSTRAINT — is REJECTED by OpenAI with
 * a hard 400 on the WHOLE request:
 *   - numbers:  minimum/maximum/exclusiveMinimum/exclusiveMaximum/multipleOf
 *   - strings:  minLength/maxLength/pattern/format
 *   - arrays:   minItems/maxItems/uniqueItems/contains/minContains/maxContains
 *   - objects:  minProperties/maxProperties/patternProperties/propertyNames/
 *               dependentRequired/dependentSchemas
 *   - logic/meta: default/if/then/else/not
 *
 * `z.number().int()` emits `minimum`/`maximum`; `.min(1)` emits `minLength`/
 * `minItems`. The previous gate validated ONLY `additionalProperties` + `required`
 * and was BLIND to these → it wrongly marked `TaskOutput`/`Monitor` (required
 * `z.number().int()`) strict:true → a 400 on every native gpt turn. A whitelist
 * is robust against any future keyword a schema construct might introduce: a node
 * carrying a non-whitelisted key is strict-incompatible (→ strict:false, real
 * schema still sent, never a 400).
 *
 * This set MIRRORS OpenAI Structured Outputs' strict-SUPPORTED keyword set. It
 * deliberately EXCLUDES keywords OpenAI strict does NOT support — `prefixItems`
 * (tuples), `oneOf` (discriminated unions), `allOf` (intersections), and
 * `nullable` (zod emits nullables as `anyOf:[T,{type:'null'}]` under draft-2020-12,
 * so a literal `nullable` key never appears). Adding a STRICT tool that uses a
 * tuple / discriminated-union / intersection param requires RE-VALIDATING this set
 * against OpenAI's docs (such a tool is correctly downgraded to strict:false today).
 */
const OPENAI_STRICT_ALLOWED_KEYS = new Set<string>([
  // JSON-Schema meta / document keys (z.toJSONSchema emits `$schema` at the root).
  '$schema',
  '$ref',
  '$defs',
  '$id',
  '$comment',
  // Pure metadata — ignored by constrained decoding, harmless under strict.
  'title',
  'description',
  // Structural — these DRIVE the generated shape and ARE supported under strict.
  // `anyOf` is the ONLY combinator OpenAI strict supports (oneOf/allOf excluded).
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'anyOf',
]);

/**
 * The recursive worker. A node is strict-compatible when:
 *   - it contains ONLY whitelisted keys (no unsupported constraint keyword), AND
 *   - IF it is an object schema, it sets `additionalProperties:false` and lists
 *     every property in `required`, AND
 *   - all of its property/item/combinator sub-schemas are likewise compatible.
 * Non-object nodes (leaves) are compatible.
 */
function isStrictNode(schema: unknown): boolean {
  // A non-object sub-schema is a leaf we don't constrain here — e.g. a boolean
  // schema (`true`) under `items`. It carries no object-level strict obligation,
  // so it's compatible. (A leaf `false` schema can't appear under our converters.)
  if (schema == null || typeof schema !== 'object') return true;
  const node = schema as Record<string, unknown>;

  // WHITELIST: any non-whitelisted key is a constraint OpenAI strict 400s on.
  for (const key of Object.keys(node)) {
    if (!OPENAI_STRICT_ALLOWED_KEYS.has(key)) return false;
  }

  // Recurse through the union branches (a nullable/union field → `anyOf:[T,…]`).
  // Only `anyOf` survives the whitelist above (oneOf/allOf are rejected outright),
  // so it is the only combinator to recurse into.
  {
    const branches = node.anyOf;
    if (Array.isArray(branches)) {
      if (!branches.every((b) => isStrictNode(b))) return false;
    }
  }

  const isObjectSchema = node.type === 'object' || node.properties !== undefined;
  if (isObjectSchema) {
    // OpenAI strict: no extra props allowed at this level.
    if (node.additionalProperties !== false) return false;
    const properties = (node.properties as Record<string, unknown> | undefined) ?? {};
    const required = Array.isArray(node.required) ? (node.required as string[]) : [];
    const propKeys = Object.keys(properties);
    // Every declared property must be required.
    for (const k of propKeys) {
      if (!required.includes(k)) return false;
    }
    // And every property's sub-schema must itself be strict-compatible.
    for (const k of propKeys) {
      if (!isStrictNode(properties[k])) return false;
    }
  }

  // Arrays: their `items` sub-schema must be strict-compatible too. (`prefixItems`
  // / tuples are rejected by the whitelist above, so only `items` is recursed.)
  {
    const sub = node.items;
    if (sub !== undefined) {
      if (Array.isArray(sub)) {
        if (!sub.every((it) => isStrictNode(it))) return false;
      } else if (!isStrictNode(sub)) {
        return false;
      }
    }
  }

  return true;
}
