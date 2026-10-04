/**
 * chat-completions-moonshot-schema — repair OpenAI-flavored tool schemas to the
 * stricter subset Moonshot (Kimi) accepts. Moonshot 400s ("not a valid moonshot
 * flavored json schema") on common shapes:
 *   1. a property schema with no `type` (OpenAI allows it; Moonshot refuses),
 *   2. an `anyOf` whose `type` sits on the parent / has a null branch,
 *   3. null / empty-string values inside an `enum`, and the `nullable` keyword.
 *
 * A faithful TS port of Hermes' `moonshot_schema.py`. Gated on `isMoonshotModel`
 * (detection by model slug — covers Nous/OpenRouter aggregators routing to Moonshot).
 */

const SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);
const SCHEMA_LIST_KEYS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);
const SCHEMA_NODE_KEYS = new Set(['items', 'contains', 'not', 'additionalProperties', 'propertyNames']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Infer a reasonable `type` for a schema node that lacks one (Rule 1). */
function fillMissingType(node: Obj): Obj {
  const t = node.type;
  if (Array.isArray(t)) {
    const concrete = t.find((x) => typeof x === 'string' && x !== '' && x !== 'null') ?? 'string';
    return { ...node, type: concrete };
  }
  if (typeof t === 'string' && t !== '') return node;
  let inferred = 'string';
  if ('properties' in node || 'required' in node || 'additionalProperties' in node) inferred = 'object';
  else if ('items' in node || 'prefixItems' in node) inferred = 'array';
  else if (Array.isArray(node.enum) && node.enum.length > 0) {
    const s = node.enum[0];
    inferred = typeof s === 'boolean' ? 'boolean' : typeof s === 'number' ? (Number.isInteger(s) ? 'integer' : 'number') : 'string';
  }
  return { ...node, type: inferred };
}

function repairSchema(node: unknown, isSchema = true): unknown {
  if (Array.isArray(node)) return node.map((item) => repairSchema(item, true));
  if (!isObj(node)) return node;

  let repaired: Obj = {};
  for (const [key, value] of Object.entries(node)) {
    if (SCHEMA_MAP_KEYS.has(key) && isObj(value)) {
      const m: Obj = {};
      for (const [k, v] of Object.entries(value)) m[k] = repairSchema(v, true);
      repaired[key] = m;
    } else if (SCHEMA_LIST_KEYS.has(key) && Array.isArray(value)) {
      repaired[key] = value.map((v) => repairSchema(v, true));
    } else if (SCHEMA_NODE_KEYS.has(key)) {
      repaired[key] = isObj(value) ? repairSchema(value, true) : value;
    } else {
      repaired[key] = value;
    }
  }

  if (!isSchema) return repaired;

  // Rule 2: anyOf — type belongs on the children; drop null branches, promote a
  // single non-null branch (so Rules 1/3 still apply to the merged node).
  if (Array.isArray(repaired.anyOf)) {
    delete repaired.type;
    const nonNull = repaired.anyOf.filter((b) => isObj(b) && b.type !== 'null');
    if (nonNull.length > 0 && nonNull.length < repaired.anyOf.length) {
      if (nonNull.length === 1) {
        const { anyOf: _drop, ...rest } = repaired;
        repaired = { ...rest, ...(nonNull[0] as Obj) };
      } else {
        repaired.anyOf = nonNull;
        return repaired;
      }
    } else {
      return repaired;
    }
  }

  delete repaired.nullable;

  // Rule 1: fill a missing type ($ref nodes are exempt — type comes from the ref).
  if (!('$ref' in repaired)) repaired = fillMissingType(repaired);

  // Rule 3: strip null/empty-string enum values for scalar types; drop an empty enum.
  if (Array.isArray(repaired.enum) && ['string', 'integer', 'number', 'boolean'].includes(repaired.type as string)) {
    const cleaned = repaired.enum.filter((v) => v !== null && v !== '');
    if (cleaned.length > 0) repaired.enum = cleaned;
    else delete repaired.enum;
  }

  return repaired;
}

/** Normalize tool parameters to a Moonshot-compatible object schema (never mutates input). */
export function sanitizeMoonshotToolParameters(parameters: unknown): Obj {
  if (!isObj(parameters)) return { type: 'object', properties: {} };
  const repaired = repairSchema(structuredClone(parameters), true) as Obj;
  if (repaired.type !== 'object') repaired.type = 'object';
  if (!('properties' in repaired)) repaired.properties = {};
  return repaired;
}

/** True for any Kimi / Moonshot model slug, regardless of aggregator prefix. */
export function isMoonshotModel(model: string | undefined | null): boolean {
  if (!model) return false;
  const bare = model.trim().toLowerCase();
  const tail = bare.split('/').pop() ?? '';
  if (tail.startsWith('kimi-') || tail === 'kimi') return true;
  return bare.includes('moonshot');
}
