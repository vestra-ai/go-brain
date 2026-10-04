/**
 * Narration parity — the `narration` param must ride EVERY transport's tools,
 * not just Anthropic's. The story spine's mint ladder reads it tier-1; the
 * product's primary model lanes (deepseek/glm/luna) ride ChatCompletions, so
 * an anthropic-only injection leaves their steps on template lines forever
 * (caught live on the first post-ship drill: "Searching the web").
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { NARRATION_PARAM } from '../../engine/tool-dispatcher.js';
import { ChatCompletionsTransport } from '../chat-completions-transport.js';
import { GeminiTransport } from '../gemini-transport.js';
import { OpenAIResponsesTransport } from '../openai-responses-transport.js';
import { AnthropicMessagesTransport } from '../anthropic-transport.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { RawToolOptions } from '../../tools/tool-types.js';

const rawTool = (over: Partial<RawToolOptions> = {}): RawToolOptions =>
  ({
    name: 'sheet_update',
    description: 'Update a sheet',
    parameters: {
      type: 'object',
      properties: { row: { type: 'number' } },
      required: ['row'],
    },
    execute: async () => 'ok',
    ...over,
  }) as RawToolOptions;

type FnTool = {
  function?: { parameters?: { properties?: Record<string, unknown>; required?: string[] }; strict?: boolean };
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  strict?: boolean;
};

describe('narration parity across transports', () => {
  it('ChatCompletions buildTools injects narration (optional; required untouched)', () => {
    const t = new ChatCompletionsTransport();
    const [tool] = t.buildTools([rawTool()]) as FnTool[];
    const fn = tool.function!;
    expect(fn.parameters?.properties?.[NARRATION_PARAM]).toBeDefined();
    expect(fn.parameters?.required).toEqual(['row']);
  });

  it('ChatCompletions strict tool: narration joins required so strict-mode schemas stay valid', () => {
    const t = new ChatCompletionsTransport();
    const [tool] = t.buildTools([rawTool({ strict: true })]) as FnTool[];
    const fn = tool.function!;
    expect(fn.parameters?.properties?.[NARRATION_PARAM]).toBeDefined();
    expect(fn.parameters?.required).toContain(NARRATION_PARAM);
    expect(fn.parameters?.required).toContain('row');
  });

  it('OpenAI Responses buildTools injects narration', () => {
    const t = new OpenAIResponsesTransport();
    const [tool] = t.buildTools([rawTool()]) as FnTool[];
    expect(tool.parameters?.properties?.[NARRATION_PARAM]).toBeDefined();
    expect(tool.parameters?.required).toEqual(['row']);
  });

  it('Gemini buildTools injects narration', () => {
    const t = new GeminiTransport({ apiKey: 'test' } as never);
    const [tool] = t.buildTools([rawTool()]) as FnTool[];
    expect(tool.parameters?.properties?.[NARRATION_PARAM]).toBeDefined();
  });

  it('a tool declaring its own narration param is left verbatim on every arm', () => {
    const own = rawTool({
      parameters: {
        type: 'object',
        properties: { narration: { type: 'string', description: 'mine' }, row: { type: 'number' } },
        required: ['row'],
      },
    });
    const t = new ChatCompletionsTransport();
    const [tool] = t.buildTools([own]) as FnTool[];
    expect((tool.function!.parameters?.properties?.[NARRATION_PARAM] as { description?: string }).description).toBe('mine');
  });

  it('non-object schemas pass through untouched', () => {
    const bare = rawTool({ parameters: { type: 'string' } as never });
    const t = new ChatCompletionsTransport();
    const [tool] = t.buildTools([bare]) as FnTool[];
    expect(tool.function!.parameters?.properties?.[NARRATION_PARAM]).toBeUndefined();
  });

  const zodTool = (over: Partial<RawToolOptions> = {}): RawToolOptions =>
    ({
      name: 'Read',
      description: 'Read a file',
      parameters: z.object({ file_path: z.string().describe('Absolute path'), limit: z.number().optional() }),
      execute: async () => 'ok',
      ...over,
    }) as RawToolOptions;

  it('a Zod-declared tool (every built-in) gets narration on ChatCompletions', () => {
    const t = new ChatCompletionsTransport();
    const [tool] = t.buildTools([zodTool()]) as FnTool[];
    const p = tool.function!.parameters!;
    expect(p.properties?.[NARRATION_PARAM]).toBeDefined();
    expect(p.properties?.file_path).toMatchObject({ type: 'string', description: 'Absolute path' });
    expect(p.required).toEqual(['file_path']);
  });

  it('a Zod-declared tool gets narration on OpenAI Responses and Gemini', () => {
    const [r] = new OpenAIResponsesTransport().buildTools([zodTool()]) as FnTool[];
    expect(r.parameters?.properties?.[NARRATION_PARAM]).toBeDefined();
    const [g] = new GeminiTransport({ apiKey: 'test' } as never).buildTools([zodTool()]) as FnTool[];
    expect(g.parameters?.properties?.[NARRATION_PARAM]).toBeDefined();
  });

  it('a Zod-declared tool gets narration on Anthropic, as real JSON Schema without $schema', () => {
    const t = new AnthropicMessagesTransport({ client: {} as unknown as Anthropic });
    const [tool] = t.buildTools([zodTool()]) as Array<{ input_schema: { type?: string; properties?: Record<string, unknown>; $schema?: string } }>;
    expect(tool.input_schema.type).toBe('object');
    expect(tool.input_schema.properties?.[NARRATION_PARAM]).toBeDefined();
    expect(tool.input_schema.properties?.file_path).toBeDefined();
    expect(tool.input_schema.$schema).toBeUndefined();
  });

  it('a no-param tool (null parameters) still gets narration', () => {
    const t = new ChatCompletionsTransport();
    const [tool] = t.buildTools([zodTool({ name: 'list_apps', parameters: null as never })]) as FnTool[];
    expect(tool.function!.parameters?.properties?.[NARRATION_PARAM]).toBeDefined();
  });

  it('a strict Zod tool requires narration', () => {
    const t = new ChatCompletionsTransport();
    const [tool] = t.buildTools([zodTool({ strict: true })]) as FnTool[];
    expect(tool.function!.parameters?.required).toContain(NARRATION_PARAM);
  });

  it('a bare object schema with no properties key still gets narration (MCP/Composio shape, and toToolJsonSchema\'s own throw-fallback)', () => {
    const t = new ChatCompletionsTransport();
    const [tool] = t.buildTools([rawTool({ parameters: { type: 'object' } as never })]) as FnTool[];
    expect(tool.function!.parameters?.properties?.[NARRATION_PARAM]).toBeDefined();
  });

  it('non-object schema passthrough preserves its exact content, not just narration-absence', () => {
    const raw = { type: 'string', description: 'raw' };
    const t = new ChatCompletionsTransport();
    const [tool] = t.buildTools([rawTool({ parameters: raw as never })]) as FnTool[];
    expect(tool.function!.parameters).toEqual(raw);
  });
});
