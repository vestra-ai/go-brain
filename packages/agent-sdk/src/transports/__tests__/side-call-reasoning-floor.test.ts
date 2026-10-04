/**
 * The side-call reasoning floor (tell-it-once, 2026-09-25).
 *
 * The memory sweep runs on the task's own model. On gpt-5.6-luna / gpt-6-luna that is the top
 * effort tier, and 54% of 858 prod sweeps since 09-03 spent the whole 1024-token budget
 * reasoning and wrote no FACT line. `reasoningEffort: 'low'` pins the floor for one call, on
 * every dialect the sweep can run on, and only where the model already sends an effort.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type OpenAI from 'openai';
import { OpenAIResponsesTransport } from '../openai-responses-transport.js';
import { ChatCompletionsTransport } from '../chat-completions-transport.js';
import { AnthropicMessagesTransport } from '../anthropic-transport.js';
import { GeminiInteractionsTransport } from '../gemini-interactions-transport.js';
import type { GeminiInteractionsRequest } from '../gemini-interactions-wire.js';
import type { ProviderHistory, ProviderTool } from '../../engine/transport.js';

const BASE = { system: 'S', tools: [] as ProviderTool[], history: [] as ProviderHistory, maxTokens: 2048 };

afterEach(() => {
  delete process.env.OPENAI_REASONING_EFFORT;
  delete process.env.OPENAI_REASONING;
});

function responsesBody(model: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const stream = vi.fn().mockReturnValue((async function* () {})());
  new OpenAIResponsesTransport({ client: { responses: { stream } } as unknown as OpenAI }).callModel({ ...BASE, model, ...extra });
  return stream.mock.calls[0][0] as Record<string, unknown>;
}

function chatBody(model: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const stream = vi.fn().mockReturnValue((async function* () {})());
  const client = { chat: { completions: { create: vi.fn(), stream } } } as unknown as OpenAI;
  new ChatCompletionsTransport({ client }).callModel({ ...BASE, model, ...extra });
  return stream.mock.calls[0][0] as Record<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function anthropicBody(model: string, extra: Record<string, unknown> = {}): Record<string, any> {
  const stream = vi.fn((_body: unknown, _opts?: unknown) => ({ __sentinel: 'stream' }) as unknown);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new AnthropicMessagesTransport({ client: { messages: { stream } } as any }).callModel({
    ...BASE,
    history: [{ role: 'user', content: 'hi' }] as unknown as ProviderHistory,
    model,
    ...extra,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return stream.mock.calls[0][0] as Record<string, any>;
}

async function geminiBody(model: string, extra: Record<string, unknown> = {}): Promise<GeminiInteractionsRequest> {
  const bodies: GeminiInteractionsRequest[] = [];
  const t = new GeminiInteractionsTransport({
    streamFactory: (body) => {
      bodies.push(body);
      return (async function* () {})();
    },
  });
  for await (const ev of t.callModel({ ...BASE, model, ...extra }) as AsyncIterable<unknown>) void ev;
  return bodies[0]!;
}

describe('side-call reasoning floor: OpenAI Responses', () => {
  it('a sweep on gpt-6-luna asks for low effort and keeps the summary; the floor beats an env override and never invents reasoning', () => {
    expect(responsesBody('gpt-6-luna').reasoning).toEqual({ effort: 'xhigh', summary: 'auto' });
    expect(responsesBody('gpt-6-luna', { reasoningEffort: 'low' }).reasoning).toEqual({ effort: 'low', summary: 'auto' });

    process.env.OPENAI_REASONING_EFFORT = 'max';
    expect(responsesBody('gpt-5.6-luna', { reasoningEffort: 'low' }).reasoning).toEqual({ effort: 'low', summary: 'auto' });

    process.env.OPENAI_REASONING = 'off';
    expect('reasoning' in responsesBody('gpt-6-luna', { reasoningEffort: 'low' })).toBe(false);
  });
});

describe('side-call reasoning floor: Chat Completions', () => {
  it('glm-5.2 drops from high to low', () => {
    expect(chatBody('glm-5.2').reasoning_effort).toBe('high');
    expect(chatBody('glm-5.2', { reasoningEffort: 'low' }).reasoning_effort).toBe('low');
  });
});

describe('side-call reasoning floor: Anthropic', () => {
  it('an effort-taking model gets output_config.effort low with its thinking shape unchanged; a model with no effort param gets nothing new', () => {
    const plain = anthropicBody('claude-opus-5-5');
    const floored = anthropicBody('claude-opus-5-5', { reasoningEffort: 'low' });
    expect(plain.output_config.effort).toBe('medium');
    expect(floored.output_config.effort).toBe('low');
    expect(floored.thinking).toEqual(plain.thinking);

    const haiku = anthropicBody('claude-haiku-4-5', { reasoningEffort: 'low' });
    expect(haiku.output_config).toBeUndefined();
    expect(haiku.thinking.budget_tokens).toBeLessThan(haiku.max_tokens);
  });
});

describe('side-call reasoning floor: Gemini Interactions', () => {
  it('gemini-3.8-flash drops from medium to low', async () => {
    expect((await geminiBody('gemini-3.8-flash')).generation_config.thinking_level).toBe('medium');
    expect((await geminiBody('gemini-3.8-flash', { reasoningEffort: 'low' })).generation_config.thinking_level).toBe('low');
  });
});
