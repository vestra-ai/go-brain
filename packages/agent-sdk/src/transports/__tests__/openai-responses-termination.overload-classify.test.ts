/**
 * Triage 2026-08-19 item 4 — three prod turns died with ZERO retries: two `terminated`
 * (undici: the proxy stream was cut before the first event) and one "Our servers are
 * currently overloaded" — an SSE `response.failed` that reaches us as a plain Error
 * carrying code:'server_error' and NO http status. Neither matched a retryable branch,
 * so the MOST transient error class classified to non-retryable `model_error`.
 */
import { describe, it, expect } from 'vitest';
import { classifyOpenAIResponsesError } from '../openai-responses-termination.js';

describe('classifyOpenAIResponsesError — transient status-less failures are retryable', () => {
  it('code:server_error (SSE response.failed, no status) → model_unavailable', () => {
    const out = classifyOpenAIResponsesError({ code: 'server_error', message: 'Our servers are currently overloaded. Please try again later.' });
    expect(out.kind).toBe('model_unavailable');
  });

  it('overloaded WORDING with no code and no status → model_unavailable', () => {
    const out = classifyOpenAIResponsesError(new Error('The server is currently overloaded with other requests.'));
    expect(out.kind).toBe('model_unavailable');
  });

  it('"The server had an error while processing your request" → model_unavailable', () => {
    const out = classifyOpenAIResponsesError({ code: 'server_error', message: 'The server had an error while processing your request. Sorry about that!' });
    expect(out.kind).toBe('model_unavailable');
  });

  it('undici `terminated` (stream cut before first event) → network_error', () => {
    const out = classifyOpenAIResponsesError(new Error('terminated'));
    expect(out.kind).toBe('network_error');
  });

  it('socket hang up / ECONNREFUSED → network_error', () => {
    expect(classifyOpenAIResponsesError(new Error('socket hang up')).kind).toBe('network_error');
    expect(classifyOpenAIResponsesError(new Error('connect ECONNREFUSED 10.0.0.1:443')).kind).toBe('network_error');
  });

  it('a 400 validation error is still model_error (the net is not widened to everything)', () => {
    const out = classifyOpenAIResponsesError({ status: 400, message: "Invalid value: 'foo'. Supported values are: 'low', 'medium', 'high'." });
    expect(out.kind).toBe('model_error');
  });

  it('context wording still wins over the overload net when both could match', () => {
    const out = classifyOpenAIResponsesError({ code: 'context_length_exceeded', message: 'This model\'s maximum context length is 272000 tokens; overloaded' });
    expect(out.kind).toBe('context_exceeded');
  });
});
