/**
 * TOOL_SCHEMA_COMPACT_V1 (harness to nine, T1b finish) — a nullable primitive field goes on the
 * wire as a JSON Schema type array instead of zod's two-branch anyOf.
 *
 * Pinned here: OFF is byte-identical (and a plain schema passes through as the same object); ON
 * collapses exactly the nullable primitives and nothing else, keeps every keyword and the
 * required list, never mutates its input and is idempotent; no tool in the bench catalog changes
 * its OpenAI strict status; and the Gemini lanes receive Gemini's own nullable form.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { compactNullableTypes, toToolJsonSchema } from '../tool-json-schema.js';
import { isOpenAIStrictCompatible } from '../openai-strict-schema.js';
import { sanitizeGeminiToolParameters } from '../../transports/gemini-tool-schema.js';

const FLAG = 'TOOL_SCHEMA_COMPACT_V1';
const prev = process.env[FLAG];
afterEach(() => {
  if (prev === undefined) delete process.env[FLAG];
  else process.env[FLAG] = prev;
});
function withFlag<T>(value: string | undefined, fn: () => T): T {
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  return fn();
}

const SAMPLE = z.object({
  command: z.string().describe('The command'),
  note: z.string().nullable().optional().describe('A note'),
  timeout: z.number().int().positive().nullable().optional().describe('Milliseconds'),
  ratio: z.number().nullable().describe('Required, but may be null'),
  flag: z.boolean().nullable().optional(),
  mode: z.enum(['a', 'b']).nullable().optional().describe('An enum keeps its union'),
  nested: z.object({ x: z.string() }).nullable().optional().describe('An object keeps its union'),
  list: z.array(z.string()).nullable().optional(),
});

type Props = Record<string, Record<string, unknown>>;
const props = (s: unknown) => (s as { properties: Props }).properties;

describe('TOOL_SCHEMA_COMPACT_V1 off: byte-identical', () => {
  it('every nullable stays zod\'s anyOf, for unset and every non-opt-in value', () => {
    for (const v of [undefined, 'false', '0', '', 'yes']) {
      const s = withFlag(v, () => toToolJsonSchema(SAMPLE));
      expect(props(s).note?.anyOf).toBeDefined();
      expect(JSON.stringify(s)).not.toContain('"type":["');
    }
  });

  it('a plain JSON schema (an MCP tool) passes through as the very same object', () => {
    const plain = { type: 'object', properties: { q: { anyOf: [{ type: 'string' }, { type: 'null' }] } } };
    expect(withFlag(undefined, () => toToolJsonSchema(plain))).toBe(plain);
  });
});

describe('TOOL_SCHEMA_COMPACT_V1 on: nullable primitives as type arrays', () => {
  it('collapses string, integer (bounds kept), number and boolean; keeps descriptions and the required list', () => {
    const off = withFlag(undefined, () => toToolJsonSchema(SAMPLE)) as { required: string[] };
    const on = withFlag('true', () => toToolJsonSchema(SAMPLE)) as { required: string[] };
    const p = props(on);
    expect(p.note).toEqual({ type: ['string', 'null'], description: 'A note' });
    expect(p.timeout?.type).toEqual(['integer', 'null']);
    expect(p.timeout?.exclusiveMinimum).toBe(0);
    expect(p.timeout?.description).toBe('Milliseconds');
    expect(p.ratio?.type).toEqual(['number', 'null']);
    expect(p.flag).toEqual({ type: ['boolean', 'null'] });
    expect(on.required).toEqual(off.required);
    expect(on.required).toContain('ratio');
  });

  it('leaves an enum, an object and an array union exactly as zod wrote them', () => {
    const off = props(withFlag(undefined, () => toToolJsonSchema(SAMPLE)));
    const on = props(withFlag('true', () => toToolJsonSchema(SAMPLE)));
    for (const k of ['mode', 'nested', 'list', 'command']) expect(on[k], k).toEqual(off[k]);
  });

  it('is pure and idempotent, and compacts a plain schema as a copy', () => {
    const plain = { type: 'object', properties: { q: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'd' } } };
    const before = JSON.stringify(plain);
    const once = withFlag('true', () => toToolJsonSchema(plain));
    expect(JSON.stringify(plain)).toBe(before);
    expect(props(once).q).toEqual({ type: ['string', 'null'], description: 'd' });
    expect(compactNullableTypes(once)).toEqual(once);
  });

  it('only a bare null branch counts: a null branch carrying keywords, or three branches, stays a union', () => {
    const odd = { anyOf: [{ type: 'string' }, { type: 'null', description: 'x' }] };
    const three = { anyOf: [{ type: 'string' }, { type: 'integer' }, { type: 'null' }] };
    expect(compactNullableTypes(odd)).toEqual(odd);
    expect(compactNullableTypes(three)).toEqual(three);
  });

  it('is smaller on the wire', () => {
    const off = JSON.stringify(withFlag(undefined, () => toToolJsonSchema(SAMPLE)));
    const on = JSON.stringify(withFlag('true', () => toToolJsonSchema(SAMPLE)));
    expect(on.length).toBeLessThan(off.length - 4 * 15);
  });
});

describe('no strict status changes, across the bench catalog', () => {
  it('every tool is OpenAI strict-compatible after compaction exactly when it was before', () => {
    const catalog = JSON.parse(readFileSync(fileURLToPath(new URL('../../../bench/fixtures/catalog.json', import.meta.url)), 'utf8')) as {
      tools: Array<{ name: string; parameters: unknown }>;
    };
    let collapsed = 0;
    for (const t of catalog.tools) {
      const compact = compactNullableTypes(t.parameters);
      collapsed += (JSON.stringify(compact).match(/"type":\["/g) ?? []).length;
      expect(isOpenAIStrictCompatible(compact), t.name).toBe(isOpenAIStrictCompatible(t.parameters));
    }
    expect(collapsed).toBeGreaterThan(30);
  });
});

describe('the Gemini lanes get Gemini\'s own form', () => {
  it('a type array becomes one type plus nullable, several types an anyOf', () => {
    const out = sanitizeGeminiToolParameters({
      type: 'object',
      properties: {
        a: { type: ['string', 'null'], description: 'd' },
        b: { type: ['integer', 'null'], minimum: 1 },
        c: { type: ['string', 'integer'] },
        d: { type: 'string' },
      },
    }) as { properties: Props };
    expect(out.properties.a).toEqual({ type: 'string', description: 'd', nullable: true });
    expect(out.properties.b).toEqual({ type: 'integer', minimum: 1, nullable: true });
    expect(out.properties.c).toEqual({ anyOf: [{ type: 'string' }, { type: 'integer' }] });
    expect(out.properties.d).toEqual({ type: 'string' });
  });

  it('a compacted tool reaches Gemini with no type array left', () => {
    const on = withFlag('true', () => toToolJsonSchema(SAMPLE));
    expect(JSON.stringify(sanitizeGeminiToolParameters(on))).not.toContain('"type":["');
  });
});
