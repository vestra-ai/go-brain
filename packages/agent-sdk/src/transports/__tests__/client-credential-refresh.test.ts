/**
 * A warm run picks up a refreshed token (staging 2026-10-02, task 1106ef29).
 *
 * A native run stays WARM between turns, so one transport instance, and the provider client it
 * memoized, serves every turn of a task for as long as the runner lives, a box freeze included.
 * The client captures the bearer token when it is built. The runner's TOKEN_REFRESH (pushed on
 * every relay connect, before any turn is delivered) swaps process.env and nothing else, so a
 * thawed, credential-starved runner kept sending the EXPIRED token from its memoized client: the
 * first turn after the wake died `auth_error` at $0, with the fresh token already in the env.
 *
 * The memo is keyed by the credential now: the same token reuses the client (the warm pool and the
 * per-instance caches stay), a new token builds a new one. An injected client is never rebuilt.
 * Reaches the PRIVATE getClient on purpose, as client-max-retries.test.ts does: the default
 * factories are the line under test, and an injected mock would bypass them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { AnthropicMessagesTransport, ChatCompletionsTransport, OpenAIResponsesTransport } from '../index.js';

const KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'FIREWORKS_API_KEY', 'FIREWORKS_BASE_URL',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ANTHROPIC_BASE_URL = 'http://proxy.test/anthropic';
  process.env.ANTHROPIC_AUTH_TOKEN = 'token-expired';
  process.env.OPENAI_BASE_URL = 'http://proxy.test/openai';
  process.env.OPENAI_API_KEY = 'token-expired';
  process.env.FIREWORKS_BASE_URL = 'http://proxy.test/fireworks';
  process.env.FIREWORKS_API_KEY = 'token-expired';
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** What the runner's TOKEN_REFRESH does (apps/sandbox runner-token.ts applyRefreshedToken). */
function refreshToken(token: string): void {
  for (const k of ['ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'FIREWORKS_API_KEY']) process.env[k] = token;
}

describe('Anthropic Messages: the warm run carries the refreshed token', () => {
  const clientOf = (t: AnthropicMessagesTransport) => (t as unknown as { getClient(): Anthropic }).getClient();

  it('a refresh after the client was built reaches the next request', () => {
    const t = new AnthropicMessagesTransport();
    expect(clientOf(t).authToken).toBe('token-expired');
    refreshToken('token-fresh');
    expect(clientOf(t).authToken).toBe('token-fresh');
  });

  it('the same token reuses the same client (no rebuild per round)', () => {
    const t = new AnthropicMessagesTransport();
    expect(clientOf(t)).toBe(clientOf(t));
  });

  it('an injected client is never replaced, whatever the env does', () => {
    const injected = { authToken: 'mock' } as unknown as Anthropic;
    const t = new AnthropicMessagesTransport({ client: injected });
    refreshToken('token-fresh');
    expect(clientOf(t)).toBe(injected);
  });

  it('an injected factory is asked again only when the token changed', () => {
    const createClient = vi.fn(() => ({}) as Anthropic);
    const t = new AnthropicMessagesTransport({ createClient });
    clientOf(t);
    clientOf(t);
    expect(createClient).toHaveBeenCalledTimes(1);
    refreshToken('token-fresh');
    clientOf(t);
    expect(createClient).toHaveBeenCalledTimes(2);
  });
});

describe('the OpenAI-compatible lanes: the warm run carries the refreshed token', () => {
  it('Responses (openai): a refresh reaches the next request; the same token reuses the client', () => {
    const t = new OpenAIResponsesTransport();
    const clientOf = () => (t as unknown as { getClient(p: string): OpenAI }).getClient('openai');
    const before = clientOf();
    expect(before.apiKey).toBe('token-expired');
    expect(clientOf()).toBe(before);
    refreshToken('token-fresh');
    expect(clientOf().apiKey).toBe('token-fresh');
  });

  it('Chat Completions (fireworks): a refresh reaches the next request; the same token reuses the client', () => {
    const t = new ChatCompletionsTransport();
    const clientOf = () => (t as unknown as { getClient(p: string): OpenAI }).getClient('fireworks');
    const before = clientOf();
    expect(before.apiKey).toBe('token-expired');
    expect(clientOf()).toBe(before);
    refreshToken('token-fresh');
    expect(clientOf().apiKey).toBe('token-fresh');
  });

  it('a lane is rebuilt only for ITS key: another lane\'s client is untouched', () => {
    const t = new ChatCompletionsTransport();
    const clientOf = (p: string) => (t as unknown as { getClient(p: string): OpenAI }).getClient(p);
    const openai = clientOf('openai');
    process.env.FIREWORKS_API_KEY = 'token-fresh';
    expect(clientOf('openai')).toBe(openai);
    expect(clientOf('fireworks').apiKey).toBe('token-fresh');
  });

  it('an injected client is never replaced, whatever the env does', () => {
    const injected = { apiKey: 'mock' } as unknown as OpenAI;
    const t = new OpenAIResponsesTransport({ client: injected });
    refreshToken('token-fresh');
    expect((t as unknown as { getClient(p: string): OpenAI }).getClient('openai')).toBe(injected);
  });
});

/** Review of #4194: the memo keys and compares on the credential's sha256, never the secret itself. */
describe('the memo never keeps the raw token', () => {
  const secretFree = (value: unknown) => !JSON.stringify(value).includes('token-expired');

  it('Anthropic: the recorded credential is a digest', () => {
    const t = new AnthropicMessagesTransport();
    (t as unknown as { getClient(): Anthropic }).getClient();
    const recorded = (t as unknown as { clientCredential?: string }).clientCredential;
    expect(recorded).toMatch(/^[0-9a-f]{64}$/);
    expect(secretFree(recorded)).toBe(true);
  });

  it('the OpenAI-compatible lanes: every memo entry carries a digest', () => {
    for (const t of [new OpenAIResponsesTransport(), new ChatCompletionsTransport()]) {
      (t as unknown as { getClient(p: string): OpenAI }).getClient('openai');
      const memo = (t as unknown as { clientsByProvider: Map<string, { credential?: string }> }).clientsByProvider;
      const credentials = [...memo.values()].map((e) => e.credential);
      expect(credentials).toHaveLength(1);
      expect(credentials[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(secretFree(credentials)).toBe(true);
    }
  });
});
