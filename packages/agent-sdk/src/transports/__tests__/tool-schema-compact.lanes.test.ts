/**
 * TOOL_SCHEMA_COMPACT_V1 per lane: the exact tool schema each lane puts on the wire with the flag on.
 *
 * Live on staging (2 Oct) the Fireworks DeepSeek lane mangled a nullable STRING sent as a type
 * array (`type: ["string", "null"]`): a stray `>` and a closing tag in the value of an optional
 * string (Bash `description`, Grep `path`), while required strings and integer type arrays came
 * through clean. So the Fireworks lane gets zod's two-branch union back for nullable strings
 * (chat-completions-transport.ts STRING_TYPE_ARRAY_UNSAFE_PROVIDERS, keyed by the catalog row's
 * provider), and keeps every other compaction. Claude, GPT, Gemini and the other Chat Completions
 * lanes keep the full saving.
 *
 * Revert-proof: drop the Fireworks expansion and the DeepSeek case finds a string type array;
 * apply it on every lane and the xAI case finds a union; ignore the flag and the flag-off case
 * finds the request's tools rewritten.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type OpenAI from 'openai';
import type { RawToolOptions } from '../../tools/tool-types.js';
import type { ProviderHistory } from '../../engine/transport.js';
import { toAnthropicTool } from '../../engine/tool-dispatcher.js';
import { compactNullableTypes, expandNullableStringTypes } from '../../contract/tool-json-schema.js';
import { ChatCompletionsTransport } from '../chat-completions-transport.js';
import { OpenAIResponsesTransport } from '../openai-responses-transport.js';
import { GeminiInteractionsTransport } from '../gemini-interactions-transport.js';
import { sanitizeGeminiToolParameters } from '../gemini-tool-schema.js';

const FLAG = 'TOOL_SCHEMA_COMPACT_V1';
const prev = process.env[FLAG];
afterEach(() => {
  if (prev === undefined) delete process.env[FLAG];
  else process.env[FLAG] = prev;
});
function withFlag<T>(value: string | undefined, fn: () => T): T {
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }
}

/** The shapes the drill exercised: Bash's optional description, Grep's optional path and head_limit. */
const PROBE: RawToolOptions = {
  name: 'Probe',
  description: 'probe',
  parameters: z.object({
    command: z.string().describe('The command'),
    description: z.string().nullable().optional().describe('What it does'),
    path: z.string().max(200).nullable().optional().describe('Where to look'),
    head_limit: z.number().int().positive().nullable().optional().describe('How many'),
    verbose: z.boolean().nullable().optional(),
  }),
  execute: async () => 'ok',
};

type Props = Record<string, Record<string, unknown>>;

/** The string fields as zod writes them (the pre-compact form). */
const DESCRIPTION_UNION = { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'What it does' };
const PATH_UNION = { anyOf: [{ type: 'string', maxLength: 200 }, { type: 'null' }], description: 'Where to look' };

/** The request body a Chat Completions lane sends for `model` (stub client, no network). */
function chatWireProps(model: string, flag: string | undefined): Props {
  return withFlag(flag, () => {
    const stream = vi.fn().mockReturnValue((async function* () { /* the body is what is asserted */ })());
    const client = { chat: { completions: { create: vi.fn(), stream } } } as unknown as OpenAI;
    const transport = new ChatCompletionsTransport({ client });
    const tools = transport.buildTools([PROBE]);
    transport.callModel({ model, system: 's', tools, history: [] as ProviderHistory, maxTokens: 64 });
    const body = stream.mock.calls[0]![0] as { tools: Array<{ function: { parameters: { properties: Props } } }> };
    return body.tools[0]!.function.parameters.properties;
  });
}

describe('TOOL_SCHEMA_COMPACT_V1 on: the wire schema per lane', () => {
  it('Claude (Anthropic Messages): every nullable primitive is a type array', () => {
    const p = withFlag('true', () => (toAnthropicTool(PROBE).input_schema as unknown as { properties: Props }).properties);
    expect(p.description).toEqual({ type: ['string', 'null'], description: 'What it does' });
    expect(p.path).toEqual({ type: ['string', 'null'], maxLength: 200, description: 'Where to look' });
    expect(p.head_limit?.type).toEqual(['integer', 'null']);
    expect(p.verbose).toEqual({ type: ['boolean', 'null'] });
  });

  it('GPT (OpenAI Responses): every nullable primitive is a type array', () => {
    const p = withFlag('true', () => {
      const [tool] = new OpenAIResponsesTransport({}).buildTools([PROBE]) as unknown as Array<{ parameters: { properties: Props } }>;
      return tool!.parameters.properties;
    });
    expect(p.description).toEqual({ type: ['string', 'null'], description: 'What it does' });
    expect(p.path).toEqual({ type: ['string', 'null'], maxLength: 200, description: 'Where to look' });
    expect(p.head_limit?.type).toEqual(['integer', 'null']);
  });

  it("Gemini (Interactions): Gemini's own nullable form, no type array", () => {
    const p = withFlag('true', () => {
      const [tool] = new GeminiInteractionsTransport({}).buildTools([PROBE]) as unknown as Array<{ parameters: { properties: Props } }>;
      return tool!.parameters.properties;
    });
    expect(p.description).toEqual({ type: 'string', description: 'What it does', nullable: true });
    expect(p.head_limit?.nullable).toBe(true);
  });

  it('DeepSeek (Fireworks Chat Completions): nullable strings go back to the union; integers and booleans stay compact', () => {
    for (const model of ['deepseek-v4.1-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'glm-5.2']) {
      const p = chatWireProps(model, 'true');
      expect(p.description, model).toEqual(DESCRIPTION_UNION);
      expect(p.path, model).toEqual(PATH_UNION);
      expect(p.command, model).toEqual({ type: 'string', description: 'The command' });
      expect(p.head_limit?.type, model).toEqual(['integer', 'null']);
      expect(p.verbose, model).toEqual({ type: ['boolean', 'null'] });
      expect(JSON.stringify(p), model).not.toContain('"type":["string"');
    }
  });

  it("another Chat Completions lane (xAI) keeps the full compact form", () => {
    const p = chatWireProps('grok-4.7', 'true');
    expect(p.description).toEqual({ type: ['string', 'null'], description: 'What it does' });
    expect(p.path).toEqual({ type: ['string', 'null'], maxLength: 200, description: 'Where to look' });
  });

  it('flag off: the Fireworks lane sends exactly what zod wrote, as before', () => {
    const p = chatWireProps('deepseek-v4.1-flash', undefined);
    expect(p.description).toEqual(DESCRIPTION_UNION);
    expect(p.path).toEqual(PATH_UNION);
    expect(p.head_limit?.anyOf).toBeDefined();
  });
});

describe('expandNullableStringTypes', () => {
  it('is the exact inverse of compaction for a string field, and leaves other type arrays alone', () => {
    const zodForm = { type: 'object', properties: { a: PATH_UNION, b: DESCRIPTION_UNION, n: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] } } };
    const back = expandNullableStringTypes(compactNullableTypes(zodForm)) as { properties: Props };
    expect(back.properties.a).toEqual(PATH_UNION);
    expect(back.properties.b).toEqual(DESCRIPTION_UNION);
    expect(back.properties.n).toEqual({ type: ['integer', 'null'], minimum: 1 });
    const before = JSON.stringify(zodForm);
    expandNullableStringTypes(zodForm);
    expect(JSON.stringify(zodForm)).toBe(before);
  });
});

describe('bytes still saved per lane (the bench catalog, tool parameters only)', () => {
  it('Fireworks keeps part of the saving; every other lane keeps all of it', () => {
    const catalog = JSON.parse(readFileSync(fileURLToPath(new URL('../../../bench/fixtures/catalog.json', import.meta.url)), 'utf8')) as {
      tools: Array<{ name: string; parameters: unknown }>;
    };
    const size = (f: (p: unknown) => unknown) => catalog.tools.reduce((n, t) => n + JSON.stringify(f(t.parameters)).length, 0);
    const off = size((p) => p);
    const compact = size(compactNullableTypes);
    const fireworks = size((p) => expandNullableStringTypes(compactNullableTypes(p)));
    const geminiOff = size((p) => sanitizeGeminiToolParameters(p));
    const geminiOn = size((p) => sanitizeGeminiToolParameters(compactNullableTypes(p)));
    // eslint-disable-next-line no-console
    console.log(
      `[compact-bytes] tools=${catalog.tools.length} off=${off} ` +
        `claude/gpt/xai=${compact} (saves ${off - compact}) fireworks=${fireworks} (saves ${off - fireworks}) ` +
        `gemini off=${geminiOff} on=${geminiOn} (saves ${geminiOff - geminiOn})`,
    );
    expect(compact).toBeLessThan(fireworks);
    expect(fireworks).toBeLessThanOrEqual(off);
    expect(geminiOn).toBeLessThanOrEqual(geminiOff);
  });
});

