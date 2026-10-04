import { describe, it, expect } from 'vitest';
import { APIError } from '@anthropic-ai/sdk';
import { classifyAnthropicError } from '../native-termination.js';
import { RETRYABLE_KINDS } from '../round-engine.js';

/** Byte-for-byte what @anthropic-ai/sdk core/streaming.mjs:79-82 throws for an SSE
 *  `event: error` frame: NO status, the body ENVELOPE in `.error`, the typed field in arg 5. */
function inStreamError(type: string, message = type): APIError {
  const body = { type: 'error', error: { type, message } };
  // The SDK types arg 5 as its CLOSED ErrorType union, which omits request_too_large —
  // a type the wire does send (413). The cast keeps the test in the wire's vocabulary.
  return new APIError(undefined, body, undefined, new Headers(), type as NonNullable<APIError['type']>);
}

describe('classifyAnthropicError — in-stream error frames carry no HTTP status', () => {
  it('overloaded_error mid-stream is retryable model_unavailable, never terminal model_error', () => {
    const out = classifyAnthropicError(inStreamError('overloaded_error', 'Overloaded'));
    expect(out.kind).toBe('model_unavailable');
    expect(RETRYABLE_KINDS.has(out.kind)).toBe(true);
  });

  it.each([
    ['api_error', 'model_unavailable'],
    ['timeout_error', 'model_unavailable'],
    ['not_found_error', 'model_unavailable'],
    ['rate_limit_error', 'rate_limited'],
    ['authentication_error', 'auth_error'],
    ['permission_error', 'auth_error'],
    ['billing_error', 'billing_error'],
    ['request_too_large', 'context_exceeded'],
  ] as const)('%s → %s', (type, kind) => {
    expect(classifyAnthropicError(inStreamError(type)).kind).toBe(kind);
  });

  it('an unknown in-stream type still falls to model_error (no widening of the retry set)', () => {
    expect(classifyAnthropicError(inStreamError('invalid_request_error', 'bad field')).kind).toBe('model_error');
  });

  it('reads the SDK `type` field — the body envelope\'s `.error.type` is always the literal "error"', () => {
    const e = inStreamError('overloaded_error');
    expect((e as unknown as { error: { type: string } }).error.type).toBe('error'); // the trap the old code fell into
    expect(classifyAnthropicError(e).kind).toBe('model_unavailable');
  });

  it('HTTP-status errors are unchanged (529 still model_unavailable, 429 still rate_limited)', () => {
    const body = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } };
    expect(classifyAnthropicError(new APIError(529, body, undefined, new Headers(), 'overloaded_error')).kind).toBe('model_unavailable');
    expect(classifyAnthropicError(new APIError(429, body, undefined, new Headers(), 'rate_limit_error')).kind).toBe('rate_limited');
  });
});
