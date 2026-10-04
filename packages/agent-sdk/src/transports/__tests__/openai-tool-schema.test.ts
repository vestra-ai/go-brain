import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { toOpenAIToolJsonSchema } from '../openai-tool-schema.js';
import { isOpenAIStrictCompatible } from '../../contract/openai-strict-schema.js';

describe('toOpenAIToolJsonSchema — Zod → JSON Schema', () => {
  it('converts a flat object to draft-2020-12 with properties/required/additionalProperties:false', () => {
    const js = toOpenAIToolJsonSchema(z.object({ name: z.string() }));
    expect(js.type).toBe('object');
    expect((js.properties as Record<string, unknown>).name).toBeDefined();
    expect(js.required).toEqual(['name']);
    expect(js.additionalProperties).toBe(false);
  });

  it('returns an empty-object strict-safe schema for null / undefined params', () => {
    for (const v of [null, undefined]) {
      const js = toOpenAIToolJsonSchema(v);
      expect(js.type).toBe('object');
      expect(js.additionalProperties).toBe(false);
      expect(js.properties).toEqual({});
    }
  });

  it('does NOT throw for a z.record(z.string(), z.unknown()) param (the default would throw)', () => {
    expect(() =>
      toOpenAIToolJsonSchema(z.object({ metadata: z.record(z.string(), z.unknown()) })),
    ).not.toThrow();
    const js = toOpenAIToolJsonSchema(z.object({ metadata: z.record(z.string(), z.unknown()) }));
    expect((js.properties as Record<string, unknown>).metadata).toBeDefined();
  });

  it('does NOT throw for a z.unknown() field (unrepresentable degrades to {})', () => {
    expect(() => toOpenAIToolJsonSchema(z.object({ x: z.unknown() }))).not.toThrow();
  });
});

describe('isOpenAIStrictCompatible', () => {
  it('accepts a flat all-required object', () => {
    const js = toOpenAIToolJsonSchema(z.object({ name: z.string() }));
    expect(isOpenAIStrictCompatible(js)).toBe(true);
  });

  it('accepts an empty-object schema', () => {
    expect(isOpenAIStrictCompatible(toOpenAIToolJsonSchema(null))).toBe(true);
  });

  it('rejects a schema with an optional (.nullable().optional()) field not in required', () => {
    const js = toOpenAIToolJsonSchema(
      z.object({ command: z.string(), timeout: z.number().int().nullable().optional() }),
    );
    expect(isOpenAIStrictCompatible(js)).toBe(false);
  });

  it('rejects a z.record param (additionalProperties:{} at the record level)', () => {
    const js = toOpenAIToolJsonSchema(z.object({ metadata: z.record(z.string(), z.unknown()) }));
    expect(isOpenAIStrictCompatible(js)).toBe(false);
  });

  it('rejects a nested array-of-object whose inner object has an optional field', () => {
    // askUserQuestion shape: questions[].options[].description is optional.
    const js = toOpenAIToolJsonSchema(
      z.object({
        questions: z.array(
          z.object({
            header: z.string(),
            options: z.array(
              z.object({ label: z.string(), description: z.string().nullable().optional() }),
            ),
          }),
        ),
      }),
    );
    expect(isOpenAIStrictCompatible(js)).toBe(false);
  });

  it('accepts a nested array-of-object when every inner field is required and keyword-free', () => {
    // NOTE: inner fields must be keyword-free — `z.number().int()` would emit
    // minimum/maximum (an OpenAI-strict-rejected keyword); a bare `z.boolean()`
    // emits only `{type:'boolean'}`. (See the keyword-trap suite below.)
    const js = toOpenAIToolJsonSchema(
      z.object({
        items: z.array(z.object({ a: z.string(), b: z.boolean() })),
      }),
    );
    expect(isOpenAIStrictCompatible(js)).toBe(true);
  });

  it('returns false for a non-object input (defensive)', () => {
    expect(isOpenAIStrictCompatible(null)).toBe(false);
    expect(isOpenAIStrictCompatible('nope')).toBe(false);
  });
});

describe('isOpenAIStrictCompatible — rejects OpenAI-strict-UNSUPPORTED keywords (400 trap)', () => {
  // OpenAI strict mode hard-400s the whole request on type-specific constraint
  // keywords. `z.number().int()` emits `minimum`/`maximum`; `.min(1)` on a string
  // emits `minLength`; on an array emits `minItems`. The gate must downgrade ANY
  // such tool to strict:false (still sending the real schema), or every native gpt
  // turn that includes it would 400.

  it('rejects a required z.number().int() field (emits minimum/maximum) — the TaskOutput/Monitor trap', () => {
    // TaskOutput: { task_id, block, timeout: z.number().int() } — all required.
    const taskOutput = toOpenAIToolJsonSchema(
      z.object({ task_id: z.string(), block: z.boolean(), timeout: z.number().int() }),
    );
    expect(isOpenAIStrictCompatible(taskOutput)).toBe(false);
    // Monitor: { description, command, timeout_ms: z.number().int(), persistent } — all required.
    const monitor = toOpenAIToolJsonSchema(
      z.object({
        description: z.string(),
        command: z.string(),
        timeout_ms: z.number().int(),
        persistent: z.boolean(),
      }),
    );
    expect(isOpenAIStrictCompatible(monitor)).toBe(false);
  });

  it('rejects an unsupported keyword at a NESTED object level', () => {
    const js = toOpenAIToolJsonSchema(z.object({ a: z.object({ n: z.number().int() }) }));
    expect(isOpenAIStrictCompatible(js)).toBe(false);
  });

  it('rejects a string minLength (.min) field', () => {
    const js = toOpenAIToolJsonSchema(z.object({ s: z.string().min(1) }));
    expect(isOpenAIStrictCompatible(js)).toBe(false);
  });

  it('rejects an array minItems (.min) field', () => {
    const js = toOpenAIToolJsonSchema(z.object({ xs: z.array(z.string()).min(1) }));
    expect(isOpenAIStrictCompatible(js)).toBe(false);
  });

  it('does NOT false-downgrade genuinely-flat tools (Skill / Write) — description/type/enum are fine', () => {
    const skill = toOpenAIToolJsonSchema(z.object({ name: z.string().describe('slug') }));
    expect(isOpenAIStrictCompatible(skill)).toBe(true);
    const write = toOpenAIToolJsonSchema(z.object({ file_path: z.string(), content: z.string() }));
    expect(isOpenAIStrictCompatible(write)).toBe(true);
    // `enum` (and `const`) are supported under strict.
    const withEnum = toOpenAIToolJsonSchema(z.object({ mode: z.enum(['a', 'b']) }));
    expect(isOpenAIStrictCompatible(withEnum)).toBe(true);
  });

  it('tolerates the top-level $schema meta key (z.toJSONSchema emits it) — still strict-compatible', () => {
    const skill = toOpenAIToolJsonSchema(z.object({ name: z.string() }));
    expect(skill.$schema).toBeDefined();
    expect(isOpenAIStrictCompatible(skill)).toBe(true);
  });

  it('converted schemas contain no $ref (the recursion assumes a fully-inlined schema)', () => {
    // A deeply-nested tool — askUserQuestion-like. z.toJSONSchema inlines by default
    // (reused:"inline"), so there should be no $ref to chase.
    const js = toOpenAIToolJsonSchema(
      z.object({
        questions: z.array(
          z.object({
            header: z.string(),
            options: z.array(z.object({ label: z.string() })),
          }),
        ),
      }),
    );
    expect(JSON.stringify(js)).not.toContain('$ref');
  });
});

describe('isOpenAIStrictCompatible — whitelist mirrors OpenAI strict\'s TRUE supported set', () => {
  // OpenAI strict supports `anyOf` but NOT `prefixItems` (tuples), `oneOf`
  // (discriminated unions), or `allOf` (intersections). The whitelist must reject
  // those so a future strict tool that adopts one is downgraded, not 400'd.

  it('rejects a tuple param (z.tuple → prefixItems)', () => {
    const js = toOpenAIToolJsonSchema(z.object({ t: z.tuple([z.string(), z.string()]) }));
    expect(JSON.stringify(js)).toContain('prefixItems');
    expect(isOpenAIStrictCompatible(js)).toBe(false);
  });

  it('rejects an intersection param (z.intersection / .and → allOf)', () => {
    const js = toOpenAIToolJsonSchema(
      z.object({
        a: z.intersection(z.object({ p: z.string() }), z.object({ q: z.string() })),
      }),
    );
    expect(JSON.stringify(js)).toContain('allOf');
    expect(isOpenAIStrictCompatible(js)).toBe(false);
  });

  it('rejects a discriminated-union param (z.discriminatedUnion → oneOf)', () => {
    const js = toOpenAIToolJsonSchema(
      z.object({
        d: z.discriminatedUnion('k', [
          z.object({ k: z.literal('a'), x: z.string() }),
          z.object({ k: z.literal('b'), y: z.string() }),
        ]),
      }),
    );
    expect(JSON.stringify(js)).toContain('oneOf');
    expect(isOpenAIStrictCompatible(js)).toBe(false);
  });

  it('STILL accepts an anyOf union (the union form OpenAI strict supports)', () => {
    // A nullable field is anyOf:[T,{type:null}] under draft-2020-12 — must stay
    // strict-compatible when every property is required.
    const js = toOpenAIToolJsonSchema(z.object({ u: z.union([z.string(), z.boolean()]) }));
    expect(JSON.stringify(js)).toContain('anyOf');
    expect(isOpenAIStrictCompatible(js)).toBe(true);
  });
});
