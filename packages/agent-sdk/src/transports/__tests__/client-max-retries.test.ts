/**
 * One retry authority (H9 W2 Task 4): every provider SDK client is constructed
 * with maxRetries: 0. The SDKs default to 2 silent retries with their own backoff
 * — stacked UNDER the engine's startStreamWithRetry, a 529 storm got up to
 * (1+2)×maxAttempts requests, and the SDK timer ran blind to our abort signal and
 * our backoff. The engine is the only retry authority (it reads Retry-After
 * itself — round-engine.retry-authority.test.ts).
 *
 * Reaches the transports' PRIVATE lazy client factories on purpose: the option
 * lives at construction, and an injected mock client (every other test) would
 * bypass exactly the line under test.
 */
import { it, expect, beforeEach, afterEach } from 'vitest';
import {
  AnthropicMessagesTransport,
  ChatCompletionsTransport,
  OpenAIResponsesTransport,
} from '../index.js';

const KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'FIREWORKS_API_KEY', 'FIREWORKS_BASE_URL',
  'XAI_API_KEY', 'XAI_BASE_URL',
  'META_API_KEY', 'META_BASE_URL',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.FIREWORKS_API_KEY = 'test-key';
  process.env.XAI_API_KEY = 'test-key';
  process.env.META_API_KEY = 'test-key';
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

type HasMaxRetries = { maxRetries: number };

it('the Anthropic default client is built with maxRetries: 0', () => {
  const t = new AnthropicMessagesTransport();
  const client = (t as unknown as { getClient(): HasMaxRetries }).getClient();
  expect(client.maxRetries).toBe(0);
});

it.each(['openai', 'fireworks', 'xai'] as const)(
  'the Chat Completions %s-lane client is built with maxRetries: 0',
  (provider) => {
    const t = new ChatCompletionsTransport();
    const client = (t as unknown as { getClient(p: string): HasMaxRetries }).getClient(provider);
    expect(client.maxRetries).toBe(0);
  },
);

it.each(['openai', 'meta'] as const)(
  'the Responses %s-lane client is built with maxRetries: 0',
  (provider) => {
    const t = new OpenAIResponsesTransport();
    const client = (t as unknown as { getClient(p: string): HasMaxRetries }).getClient(provider);
    expect(client.maxRetries).toBe(0);
  },
);
