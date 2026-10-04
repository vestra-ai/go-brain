/**
 * validate-output — pure, zero-dependency JSON-Schema *subset* guard + value
 * conformance checker (K6 P6, design §E0). NO ajv (over-featured: validates
 * keywords providers can't constrain) and NO zod (drags a runtime into the
 * kernel). Enforces EXACTLY the subset providers can natively constrain:
 *   - objects MUST set additionalProperties:false (no open objects)
 *   - NO recursion ($ref / $defs / definitions)
 *   - NO numeric constraints (minimum/maximum/multipleOf/exclusive*)
 *   - NO string-length/format constraints (minLength/maxLength/pattern/format)
 *   - minItems ∈ {0, 1} only (no maxItems / uniqueItems)
 *   - enum / required / anyOf supported
 *
 * Used to PRE-FLIGHT a requested schema and to VERIFY terminal output.
 */
import type { JsonSchemaNode, JsonSchemaSubset, JsonSchemaType } from './output-format.js';

export type SchemaValidationResult = { ok: true } | { ok: false; errors: string[] };

const SUPPORTED_TYPES: readonly JsonSchemaType[] = [
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
];

/** Keywords that are valid JSON Schema but OUTSIDE our constrainable subset. */
const FORBIDDEN_KEYWORDS = [
  '$ref',
  '$defs',
  'definitions',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'maxItems',
  'uniqueItems',
  'allOf',
  'oneOf',
  'not',
  'patternProperties',
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Preflight a requested schema against the constrainable subset. */
export function validateOutputSchema(schema: JsonSchemaSubset): SchemaValidationResult {
  const errors: string[] = [];
  walkSchema(schema, '$', errors);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function walkSchema(rawNode: JsonSchemaNode, path: string, errors: string[]): void {
  // Runtime object check. `isPlainObject` narrows to `Record<string, unknown>`,
  // which strips the JsonSchemaNode field types; re-bind to a typed view after
  // the guard so the structural reads below stay typed without per-access casts.
  if (!isPlainObject(rawNode)) {
    errors.push(`${path}: schema node must be an object`);
    return;
  }
  const node: JsonSchemaNode = rawNode as JsonSchemaNode;

  for (const kw of FORBIDDEN_KEYWORDS) {
    if (kw in rawNode) errors.push(`${path}: unsupported keyword "${kw}"`);
  }

  // anyOf branch — recurse into each, skip the type-shape checks on this node.
  if (Array.isArray(node.anyOf)) {
    const branches = node.anyOf;
    if (branches.length === 0) errors.push(`${path}.anyOf: must have at least one branch`);
    branches.forEach((b, i) => walkSchema(b, `${path}.anyOf[${i}]`, errors));
    return;
  }

  const t = node.type;
  if (t === undefined) {
    errors.push(`${path}: every node must declare a "type" (or use anyOf)`);
    return;
  }
  if (!SUPPORTED_TYPES.includes(t)) {
    errors.push(`${path}: unsupported type "${String(t)}"`);
    return;
  }

  if (t === 'object') {
    if (node.additionalProperties !== false) {
      errors.push(`${path}: objects must set additionalProperties:false`);
    }
    const props = node.properties ?? {};
    for (const [key, child] of Object.entries(props)) {
      walkSchema(child, `${path}.properties.${key}`, errors);
    }
    if (node.required) {
      for (const req of node.required) {
        if (!(req in props)) {
          errors.push(`${path}: required "${req}" is not a declared property`);
        }
      }
    }
  }

  if (t === 'array') {
    if (node.minItems !== undefined && node.minItems !== 0 && node.minItems !== 1) {
      errors.push(`${path}: minItems must be 0 or 1 (got ${node.minItems})`);
    }
    if (node.items) walkSchema(node.items, `${path}.items`, errors);
    else errors.push(`${path}: arrays must declare "items"`);
  }
}

/** Verify a concrete value conforms to a (subset) schema. */
export function validateOutputValue(
  value: unknown,
  schema: JsonSchemaSubset,
): SchemaValidationResult {
  const errors: string[] = [];
  checkValue(value, schema, '$', errors);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function checkValue(value: unknown, node: JsonSchemaNode, path: string, errors: string[]): void {
  if (Array.isArray(node.anyOf) && node.anyOf.length > 0) {
    const anyOk = node.anyOf.some((branch) => {
      const branchErrors: string[] = [];
      checkValue(value, branch, path, branchErrors);
      return branchErrors.length === 0;
    });
    if (!anyOk) errors.push(`${path}: value matches no anyOf branch`);
    return;
  }

  if (node.enum) {
    const inEnum = node.enum.some((e) => e === value);
    if (!inEnum) {
      errors.push(`${path}: value ${JSON.stringify(value)} not in enum`);
      return;
    }
  }

  switch (node.type) {
    case 'string':
      if (typeof value !== 'string') errors.push(`${path}: expected string`);
      break;
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) errors.push(`${path}: expected number`);
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        errors.push(`${path}: expected integer`);
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path}: expected boolean`);
      break;
    case 'null':
      if (value !== null) errors.push(`${path}: expected null`);
      break;
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array`);
        break;
      }
      if (node.minItems === 1 && value.length < 1) errors.push(`${path}: expected at least 1 item`);
      if (node.items) {
        value.forEach((el, i) => checkValue(el, node.items as JsonSchemaNode, `${path}[${i}]`, errors));
      }
      break;
    }
    case 'object': {
      if (!isPlainObject(value)) {
        errors.push(`${path}: expected object`);
        break;
      }
      const props = node.properties ?? {};
      for (const req of node.required ?? []) {
        if (!(req in value)) errors.push(`${path}: missing required property "${req}"`);
      }
      for (const key of Object.keys(value)) {
        if (!(key in props)) {
          errors.push(`${path}: unexpected additional property "${key}"`);
          continue;
        }
        checkValue(value[key], props[key], `${path}.${key}`, errors);
      }
      break;
    }
    default:
      errors.push(`${path}: unsupported type "${String(node.type)}"`);
  }
}
