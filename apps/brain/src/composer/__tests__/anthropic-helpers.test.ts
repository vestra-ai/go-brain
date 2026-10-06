import { APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  classifyAnthropicError,
  computeAnthropicCostUsd,
  normalizeAnthropicUsage,
  resolveCapabilities,
  type AnthropicUsage,
} from '../anthropic-helpers.js';

const usage: AnthropicUsage = { input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 4_000, cache_creation_input_tokens: 2_000 };
/** An HTTP error as the SDK builds it from Anthropic's answer. */
const answered = (status: number, type: string, message: string): APIError =>
  APIError.generate(status, { type: 'error', error: { type, message } }, undefined, new Headers());

describe('the cost of a request', () => {
  it("prices a known usage on each of Go's two models, per million tokens", () => {
    // Sonnet 5.5: $2 in, $10 out, $0.20 cache read, $2.50 cache write (5 minutes).
    expect(computeAnthropicCostUsd(usage, 'claude-sonnet-5-5')).toBeCloseTo((1_000 * 2 + 500 * 10 + 4_000 * 0.2 + 2_000 * 2.5) / 1e6, 12);
    // Haiku 4.5: $1 in, $5 out, $0.10 cache read, $1.25 cache write.
    expect(computeAnthropicCostUsd(usage, 'claude-haiku-4-5')).toBeCloseTo((1_000 * 1 + 500 * 5 + 4_000 * 0.1 + 2_000 * 1.25) / 1e6, 12);
    // A dated id prices as its model.
    expect(computeAnthropicCostUsd(usage, 'claude-haiku-4-5-20251001')).toBe(computeAnthropicCostUsd(usage, 'claude-haiku-4-5'));
  });

  it('prices a 1-hour cache write at 2x input and a 5-minute write at 1.25x; without the split every write is 5 minutes', () => {
    const writes = (split: AnthropicUsage['cache_creation']): AnthropicUsage => ({
      input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000, ...(split ? { cache_creation: split } : {}),
    });
    expect(computeAnthropicCostUsd(writes({ ephemeral_1h_input_tokens: 1_000, ephemeral_5m_input_tokens: 0 }), 'claude-sonnet-5-5')).toBeCloseTo(1_000 * 2 * 2 / 1e6, 12);
    expect(computeAnthropicCostUsd(writes({ ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 0 }), 'claude-sonnet-5-5')).toBeCloseTo(1_000 * 2.5 / 1e6, 12);
    expect(computeAnthropicCostUsd(writes(null), 'claude-sonnet-5-5')).toBeCloseTo(1_000 * 2.5 / 1e6, 12);
  });

  it('never prices another model as free: it pays the Sonnet tier', () => {
    expect(computeAnthropicCostUsd(usage, 'some-new-model')).toBeCloseTo((1_000 * 3 + 500 * 15 + 4_000 * 0.3 + 2_000 * 3.75) / 1e6, 12);
  });
});

describe("usage in Go's field names", () => {
  it('carries the 5m/1h split only when the wire did', () => {
    expect(normalizeAnthropicUsage({ input_tokens: 10, output_tokens: 2 })).toEqual({
      inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    });
    expect(normalizeAnthropicUsage({ ...usage, cache_creation: { ephemeral_1h_input_tokens: 2_000 } })).toEqual({
      inputTokens: 1_000, outputTokens: 500, cacheReadInputTokens: 4_000, cacheCreationInputTokens: 2_000,
      cacheCreation5mInputTokens: 0, cacheCreation1hInputTokens: 2_000,
    });
  });
});

describe("a model's capabilities", () => {
  it("knows Go's two models, dated or [1m], and gives any other id a careful answer length", () => {
    expect(resolveCapabilities('claude-sonnet-5-5')).toEqual({ id: 'claude-sonnet-5-5', maxOutputTokens: 128_000 });
    expect(resolveCapabilities('Claude-Sonnet-5-5[1m]')).toEqual({ id: 'claude-sonnet-5-5', maxOutputTokens: 128_000 });
    expect(resolveCapabilities('claude-haiku-4-5-20251001')).toEqual({ id: 'claude-haiku-4-5', maxOutputTokens: 64_000 });
    expect(resolveCapabilities('Some-New-Model')).toEqual({ id: 'some-new-model', maxOutputTokens: 8192 });
  });
});

describe('what kind of failure an error is', () => {
  it('overloaded, from an HTTP answer or an error frame in the stream (which has no status)', () => {
    expect(classifyAnthropicError(answered(529, 'overloaded_error', 'Overloaded')).kind).toBe('model_unavailable');
    expect(classifyAnthropicError(new APIError(undefined, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'Overloaded', undefined)).kind).toBe('model_unavailable');
  });

  it('rate limited', () => {
    expect(classifyAnthropicError(answered(429, 'rate_limit_error', 'Number of request tokens has exceeded your rate limit')).kind).toBe('rate_limited');
  });

  it('context too long, which Anthropic answers as a 400 told apart only by its message', () => {
    expect(classifyAnthropicError(answered(400, 'invalid_request_error', 'prompt is too long: 210000 tokens > 200000 maximum')).kind).toBe('context_exceeded');
    expect(classifyAnthropicError(answered(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.')).kind).toBe('billing_error');
  });

  it('an abort, a dropped connection and anything else', () => {
    expect(classifyAnthropicError(new APIUserAbortError()).kind).toBe('user_aborted');
    expect(classifyAnthropicError(new Error('fetch failed')).kind).toBe('network_error');
    expect(classifyAnthropicError(answered(503, 'some_new_error', 'Service Unavailable')).kind).toBe('model_unavailable');
    expect(classifyAnthropicError(new Error('overloaded')).kind).toBe('model_error');
    expect(classifyAnthropicError('not even an error').kind).toBe('model_error');
  });
});
