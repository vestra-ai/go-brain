import { describe, it, expect } from 'vitest';
import { validateOutputSchema, validateOutputValue } from '../validate-output.js';
import type { JsonSchemaSubset } from '../output-format.js';

const okObject: JsonSchemaSubset = {
  type: 'object',
  additionalProperties: false,
  required: ['title'],
  properties: {
    title: { type: 'string' },
    count: { type: 'integer' },
    tags: { type: 'array', items: { type: 'string' }, minItems: 0 },
    mode: { type: 'string', enum: ['fast', 'slow'] },
    note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
};

describe('validateOutputSchema — subset guard', () => {
  it('accepts a valid subset schema', () => {
    expect(validateOutputSchema(okObject)).toEqual({ ok: true });
  });

  it('requires additionalProperties:false on every object', () => {
    const r = validateOutputSchema({
      type: 'object',
      properties: { a: { type: 'string' } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/additionalProperties/i);
  });

  it('rejects additionalProperties:true', () => {
    const r = validateOutputSchema({
      type: 'object',
      additionalProperties: true,
      properties: {},
    });
    expect(r.ok).toBe(false);
  });

  it('rejects numeric constraints (minimum/maximum)', () => {
    const r = validateOutputSchema({
      type: 'object',
      additionalProperties: false,
      properties: { n: { type: 'integer', minimum: 1 } as never },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/minimum|unsupported/i);
  });

  it('rejects string length constraints (minLength/maxLength/pattern)', () => {
    const r = validateOutputSchema({
      type: 'object',
      additionalProperties: false,
      properties: { s: { type: 'string', minLength: 2 } as never },
    });
    expect(r.ok).toBe(false);
  });

  it('rejects minItems outside {0,1}', () => {
    const r = validateOutputSchema({
      type: 'object',
      additionalProperties: false,
      properties: { xs: { type: 'array', items: { type: 'string' }, minItems: 3 } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/minItems/i);
  });

  it('accepts minItems of 0 and 1', () => {
    expect(
      validateOutputSchema({
        type: 'object',
        additionalProperties: false,
        properties: {
          a: { type: 'array', items: { type: 'string' }, minItems: 0 },
          b: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
      }),
    ).toEqual({ ok: true });
  });

  it('rejects recursion ($ref)', () => {
    const r = validateOutputSchema({
      type: 'object',
      additionalProperties: false,
      properties: { self: { $ref: '#' } as never },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/\$ref|recursion|unsupported/i);
  });

  it('rejects an unknown top-level type', () => {
    const r = validateOutputSchema({ type: 'tuple' as never, additionalProperties: false });
    expect(r.ok).toBe(false);
  });
});

describe('validateOutputValue — value conformance', () => {
  it('passes a conforming object', () => {
    expect(
      validateOutputValue(
        { title: 'hi', count: 3, tags: ['x'], mode: 'fast', note: null },
        okObject,
      ),
    ).toEqual({ ok: true });
  });

  it('passes when optional fields are omitted', () => {
    expect(validateOutputValue({ title: 'only-required' }, okObject)).toEqual({ ok: true });
  });

  it('fails a missing required field', () => {
    const r = validateOutputValue({ count: 1 }, okObject);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/title|required/i);
  });

  it('fails an unexpected extra property (additionalProperties:false)', () => {
    const r = validateOutputValue({ title: 'hi', extra: 1 }, okObject);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/extra|additional/i);
  });

  it('fails a wrong scalar type', () => {
    const r = validateOutputValue({ title: 42 }, okObject);
    expect(r.ok).toBe(false);
  });

  it('fails an enum violation', () => {
    const r = validateOutputValue({ title: 'hi', mode: 'medium' }, okObject);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/enum|mode/i);
  });

  it('passes an anyOf branch (null) and fails an off-union value', () => {
    expect(validateOutputValue({ title: 'hi', note: null }, okObject)).toEqual({ ok: true });
    const r = validateOutputValue({ title: 'hi', note: 7 }, okObject);
    expect(r.ok).toBe(false);
  });

  it('validates nested array element types', () => {
    const r = validateOutputValue({ title: 'hi', tags: ['a', 5] }, okObject);
    expect(r.ok).toBe(false);
  });

  it('integer rejects a non-integer number', () => {
    const r = validateOutputValue({ title: 'hi', count: 1.5 }, okObject);
    expect(r.ok).toBe(false);
  });
});
