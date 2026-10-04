import { describe, it, expect, vi } from 'vitest';
import type OpenAI from 'openai';
import { ChatCompletionsTransport } from '../chat-completions-transport.js';
import type { ProviderHistory, ProviderTool } from '../../engine/transport.js';
import type { ModelProvider } from '../../contract/model-capabilities.js';

const BASE = {
  system: 'you are a helper',
  tools: [] as ProviderTool[],
  history: [] as ProviderHistory,
  maxTokens: 4096,
};

function stubClient() {
  const create = vi.fn();
  const stream = vi.fn().mockReturnValue(
    (async function* () {
      /* no chunks — only the request body is asserted */
    })(),
  );
  return { create, stream, client: { chat: { completions: { create, stream } } } as unknown as OpenAI };
}

type ReqOptions = { signal?: unknown; headers?: Record<string, string> } | undefined;

function callFor(model: string, extra: Record<string, unknown> = {}) {
  const { client, stream } = stubClient();
  new ChatCompletionsTransport({ client }).callModel({ ...BASE, model, ...extra });
  return {
    body: stream.mock.calls[0][0] as Record<string, unknown>,
    options: stream.mock.calls[0][1] as ReqOptions,
  };
}

describe('ChatCompletionsTransport — xAI (grok-4.5) wire path', () => {
  it('routes a grok id to the "xai" provider client lane', () => {
    const calls: ModelProvider[] = [];
    const createClient = vi.fn((p: ModelProvider) => {
      calls.push(p);
      return stubClient().client;
    });
    new ChatCompletionsTransport({ createClient }).callModel({ ...BASE, model: 'grok-4.5' });
    expect(calls).toEqual(['xai']);
  });

  it('sends the BARE canonical id — no wire-slug rewrite (that seam is Fireworks-only)', () => {
    expect((callFor('grok-4.5').body as { model?: string }).model).toBe('grok-4.5');
  });

  it('sends stream_options + reasoning_effort; NO prompt_cache_key body field and NO affinity header (xAI caching is automatic)', () => {
    const { body, options } = callFor('grok-4.5', { cacheKey: 'vestra:task-1' });
    expect(body.stream_options).toEqual({ include_usage: true });
    expect((body as { reasoning_effort?: string }).reasoning_effort).toBe('high');
    expect('prompt_cache_key' in body).toBe(false);
    expect(options?.headers).toBeUndefined();
  });
});

describe('ChatCompletionsTransport — xAI grok-4.7 wire path (same as 4.6)', () => {
  it('rides the xai lane under its bare id with reasoning_effort high, exactly like grok-4.6', () => {
    const calls: ModelProvider[] = [];
    const createClient = vi.fn((p: ModelProvider) => {
      calls.push(p);
      return stubClient().client;
    });
    new ChatCompletionsTransport({ createClient }).callModel({ ...BASE, model: 'grok-4.7' });
    expect(calls).toEqual(['xai']);
    const body = callFor('grok-4.7').body;
    expect(body.model).toBe('grok-4.7');
    expect(body.reasoning_effort).toBe('high');
    expect(body.reasoning_effort).toBe(callFor('grok-4.6').body.reasoning_effort);
    // A reasoning model errors on a penalty or a stop; this lane sends neither.
    for (const key of ['presence_penalty', 'frequency_penalty', 'stop', 'presencePenalty', 'frequencyPenalty']) {
      expect(key in body, key).toBe(false);
    }
  });
});
