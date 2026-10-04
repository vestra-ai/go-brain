/**
 * The Anthropic lane's `input_schema` contract — real JSON Schema, always.
 *
 * The lane once shipped `RawToolOptions.parameters` (a Zod schema OBJECT) straight
 * onto the wire. Claude tolerates the malformed blob, so unlike the OpenAI lane —
 * where the same passthrough made the model invent argument keys — nothing here ever
 * went visibly red. It cost us anyway, in two ways this suite pins:
 *
 *   BYTES — serialized Zod internals are nested `def` wrappers and `:null`
 *   placeholders, re-sent for every tool on every request.
 *   DOCS  — the worse half. `.describe()` text lives inside Zod internals that
 *   JSON.stringify never reaches, and the blob carries no `properties` key at all,
 *   so every per-field doc authored in `tools/*` reached the model as NOTHING.
 *
 * TOOL_SCHEMA_JSON_V1 graduated: there is no OFF axis left to pin. The narration
 * injector (`tool-dispatcher.withNarrationParam`) converts every tool's parameters
 * to plain JSON Schema and drops `$schema` before the transport ever sees them, so
 * the real schema and its docs are simply what the lane sends.
 *
 * The measurement below uses the REAL Grep tool (14 params, the widest core
 * schema) rather than a fixture, so the number this suite asserts is the number
 * the lane actually pays.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicMessagesTransport } from '../anthropic-transport.js';
import { makeGrepTool } from '../../tools/grep-tool.js';
import type { RawToolOptions } from '../../tools/tool-types.js';

const noop = (): string => '';

function build(tools: RawToolOptions[]): Array<{ name: string; description: string; input_schema: unknown }> {
  // buildTools never touches the client; a stub is fine (no network).
  const t = new AnthropicMessagesTransport({ client: {} as unknown as Anthropic });
  return t.buildTools(tools) as Array<{ name: string; description: string; input_schema: unknown }>;
}

const grepTool = (): RawToolOptions => makeGrepTool(() => '/workspace');

/** Wire bytes of ONE tool as the request serializer sees it. */
const wireBytes = (tool: unknown): number => Buffer.byteLength(JSON.stringify(tool), 'utf8');

describe('Anthropic input_schema — real JSON Schema, unconditionally', () => {
  it('ships real JSON Schema for a Zod tool, docs included, narration included, no $schema', () => {
    const [tool] = build([grepTool()]);
    const s = tool.input_schema as {
      type?: string; properties?: Record<string, { description?: string }>; $schema?: string;
    };
    expect(s.type).toBe('object');
    expect(Object.keys(s.properties ?? {})).toContain('pattern');
    expect(s.properties?.pattern?.description).toBeTruthy();
    expect(s.properties?.narration).toBeDefined();
    expect(s.$schema).toBeUndefined();
    // The win is structural, not incidental: even carrying ~1.5KB of docs the raw
    // Zod blob never had, the served tool is materially smaller than that blob
    // would be. A regression here means the `def` wrappers came back.
    const asRawZod = wireBytes({ ...tool, input_schema: grepTool().parameters });
    expect(wireBytes(tool)).toBeLessThan(asRawZod * 0.75);
  });

  it('emits type/properties/required, no Zod internals', () => {
    const [tool] = build([{
      name: 'Skill',
      description: 'd',
      parameters: z.object({ name: z.string().describe('The skill slug to load') }),
      execute: noop,
    }]);
    const schema = tool.input_schema as Record<string, unknown>;
    expect(schema.type).toBe('object');
    expect(schema.required).toContain('name');
    expect('def' in schema).toBe(false);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.name.type).toBe('string');
    expect(props.name.description).toBe('The skill slug to load');
  });

  it('carries EVERY .describe() string the tool authored — the docs the model never saw', () => {
    const [tool] = build([grepTool()]);
    const props = (tool.input_schema as { properties: Record<string, { description?: string }> }).properties;
    expect(props.pattern.description).toBe('The regular expression pattern to search for in file contents');
    expect(props.multiline.description).toContain('Enable multiline mode');
    // Every one of Grep's 14 params documents itself; none may be dropped. The
    // injected narration param documents itself too, so it needs no exemption.
    const undocumented = Object.entries(props).filter(([, v]) => !v.description).map(([k]) => k);
    expect(undocumented).toEqual([]);
  });

  it('preserves a typed enum as a real enum the model can read', () => {
    const [tool] = build([grepTool()]);
    const props = (tool.input_schema as { properties: Record<string, Record<string, unknown>> }).properties;
    // output_mode is `.nullable().optional()`, so the enum sits under anyOf.
    expect(JSON.stringify(props.output_mode)).toContain('files_with_matches');
  });
});

describe('Anthropic input_schema — everything that is not the schema shape stays put', () => {
  it('name, description, tool count and ORDER are untouched', () => {
    const tools: RawToolOptions[] = [
      { name: 'A', description: 'first', parameters: z.object({ a: z.string() }), execute: noop },
      { name: 'B', description: 'second', parameters: z.object({ b: z.string() }), execute: noop },
    ];
    expect(build(tools).map((t) => [t.name, t.description])).toEqual([['A', 'first'], ['B', 'second']]);
  });

  it('an already-plain JSON Schema (the MCP tool shape) passes through, narration aside', () => {
    const parameters = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
    const [tool] = build([{ name: 'GMAIL_FETCH', description: 'd', parameters, execute: noop }]);
    const schema = tool.input_schema as { properties: Record<string, unknown>; required: string[] };
    // MCP servers hand us JSON Schema already; conversion is a no-op for them.
    expect(schema.properties.a).toEqual({ type: 'string' });
    expect(schema.required).toEqual(['a']);
    expect(schema.properties.narration).toBeDefined();
  });

  it('a no-param tool still gets a valid empty object schema, never null', () => {
    const [tool] = build([{ name: 'N', description: 'd', parameters: null, execute: noop }]);
    const schema = tool.input_schema as { type: string; properties: Record<string, unknown> };
    expect(schema.type).toBe('object');
    expect(schema.properties.narration).toBeDefined();
  });

  it('never throws on an unrepresentable leaf (z.any) — degrades instead of killing the tool list', () => {
    const [tool] = build([{
      name: 'Loose',
      description: 'd',
      parameters: z.object({ payload: z.any() }),
      execute: noop,
    }]);
    expect((tool.input_schema as Record<string, unknown>).type).toBe('object');
  });
});
