/**
 * NETWORK_WAIT_V1: a model stream carries a response timeout (MODEL_RESPONSE_TIMEOUT_MS, its
 * response headers; the SDKs stop the timer there, so a stream's body is never timed). The SDK
 * default is ten minutes, so a proxy that took the connection and never answered meant ten silent
 * minutes between network waits. Off: the request options are exactly as before (no key).
 *
 * Revert proof: drop the spread at any of the three stream calls and its "on" case fails.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { AnthropicMessagesTransport, ChatCompletionsTransport, OpenAIResponsesTransport } from '../index.js';
import { MODEL_RESPONSE_TIMEOUT_MS } from '../../engine/error-authority.js';
import type { ProviderHistory, ProviderTool } from '../../engine/transport.js';

const FLAG = 'NETWORK_WAIT_V1';
afterEach(() => { delete process.env[FLAG]; });

const BASE = { system: 'sys', tools: [] as ProviderTool[], history: [] as ProviderHistory, maxTokens: 64 };
const emptyStream = () => vi.fn().mockReturnValue((async function* () { /* the options are what is asserted */ })());

/** The request options each lane's stream call was given. */
const optionsOf = {
  anthropic: (): Record<string, unknown> => {
    const stream = emptyStream();
    new AnthropicMessagesTransport({ client: { messages: { stream } } as unknown as Anthropic })
      .callModel({ ...BASE, model: 'claude-sonnet-4-6' });
    return stream.mock.calls[0][1] as Record<string, unknown>;
  },
  responses: (): Record<string, unknown> => {
    const stream = emptyStream();
    new OpenAIResponsesTransport({ client: { responses: { stream } } as unknown as OpenAI })
      .callModel({ ...BASE, model: 'gpt-5.6-sol' });
    return stream.mock.calls[0][1] as Record<string, unknown>;
  },
  chat: (): Record<string, unknown> => {
    const stream = emptyStream();
    new ChatCompletionsTransport({ client: { chat: { completions: { stream } } } as unknown as OpenAI })
      .callModel({ ...BASE, model: 'glm-5.2', cacheKey: 'vestra:task-a' });
    return stream.mock.calls[0][1] as Record<string, unknown>;
  },
};

describe('a model stream answers within the response timeout under NETWORK_WAIT_V1', () => {
  for (const [lane, options] of Object.entries(optionsOf)) {
    it(`${lane}: on, the stream carries the timeout; off, no timeout key at all`, () => {
      process.env[FLAG] = 'true';
      expect(options().timeout).toBe(MODEL_RESPONSE_TIMEOUT_MS);
      delete process.env[FLAG];
      expect('timeout' in options()).toBe(false);
    });
  }

  it('the timeout is minutes, not the SDK default of ten', () => {
    expect(MODEL_RESPONSE_TIMEOUT_MS).toBe(120_000);
  });
});
