import { describe, it, expect } from 'vitest';
import { sanitizeGeminiToolParameters } from '../gemini-tool-schema.js';

/**
 * PR5 (Hermes parity) — Gemini tool-schema sanitizer. Gemini's
 * FunctionDeclaration.parameters accepts only a SUBSET of JSON Schema (the Gemini
 * `Schema` object). Our tool schemas are OpenAI-flavored and carry keys Gemini
 * rejects — notably `additionalProperties` and `$schema` — so EVERY tool list 400s
 * ("Unknown name 'additionalProperties'") and the Gemini arm can't run tools at all.
 * Mirrors Hermes' `sanitize_gemini_schema` / `sanitize_gemini_tool_parameters`.
 */

describe('sanitizeGeminiToolParameters', () => {
  it('drops additionalProperties and $schema (the keys that 400 Gemini)', () => {
    const out = sanitizeGeminiToolParameters({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      properties: { a: { type: 'string' } },
      required: ['a'],
    });
    expect(out).not.toHaveProperty('additionalProperties');
    expect(out).not.toHaveProperty('$schema');
    expect(out.type).toBe('object');
    expect(out.required).toEqual(['a']);
  });

  it('recursively sanitizes nested properties / items / anyOf', () => {
    const out = sanitizeGeminiToolParameters({
      type: 'object',
      additionalProperties: false,
      properties: {
        nested: { type: 'object', additionalProperties: false, properties: { x: { type: 'number' } } },
        list: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
        choice: { anyOf: [{ type: 'string', additionalProperties: false }, { type: 'number' }] },
      },
    }) as Record<string, any>;
    expect(out.properties.nested).not.toHaveProperty('additionalProperties');
    expect(out.properties.nested.properties.x.type).toBe('number');
    expect(out.properties.list.items).not.toHaveProperty('additionalProperties');
    expect(out.properties.choice.anyOf[0]).not.toHaveProperty('additionalProperties');
    expect(out.properties.choice.anyOf).toHaveLength(2);
  });

  it('drops a typed enum (Gemini requires string enum entries), keeps a string enum', () => {
    const typed = sanitizeGeminiToolParameters({ type: 'integer', enum: [60, 1440, 4320] }) as Record<string, any>;
    expect(typed).not.toHaveProperty('enum');
    expect(typed.type).toBe('integer');
    const strings = sanitizeGeminiToolParameters({ type: 'string', enum: ['a', 'b'] }) as Record<string, any>;
    expect(strings.enum).toEqual(['a', 'b']);
  });

  it('preserves the documented Gemini subset keys verbatim', () => {
    const out = sanitizeGeminiToolParameters({
      type: 'string',
      description: 'a field',
      nullable: true,
      pattern: '^x',
      minLength: 1,
      maxLength: 9,
    });
    expect(out).toEqual({
      type: 'string',
      description: 'a field',
      nullable: true,
      pattern: '^x',
      minLength: 1,
      maxLength: 9,
    });
  });

  it('an empty / non-object schema → a valid empty object schema (no-params tools)', () => {
    expect(sanitizeGeminiToolParameters({ additionalProperties: false })).toEqual({ type: 'object', properties: {} });
    expect(sanitizeGeminiToolParameters(undefined)).toEqual({ type: 'object', properties: {} });
    expect(sanitizeGeminiToolParameters(null)).toEqual({ type: 'object', properties: {} });
  });
});
