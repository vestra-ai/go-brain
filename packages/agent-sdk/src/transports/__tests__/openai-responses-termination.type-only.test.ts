/**
 * Type-only transient errors (prod task b7867465, 2026-08-31 09:38Z).
 *
 * OpenAI delivered a transient failure as an in-stream error frame the SDK threw
 * as an APIError with `status: undefined`, `code: null` and ONLY a `type`:
 * `{ type: 'service_unavailable_error', message: 'Unable to verify model access
 * right now. Please retry.' }`. The classifier is code-first and never read
 * `type`, so a provider that literally said "please retry" classified to the
 * terminal `model_error` and the turn burned with zero retries — the type twin
 * of the 2026-08-19 `server_error` code fix.
 *
 * These pin the RAW shape production emitted (fields verbatim from the runner
 * log), not a tidy HTTP-status version of it.
 */
import { describe, it, expect } from 'vitest';
import { classifyOpenAIResponsesError } from '../openai-responses-termination.js';

/** The openai SDK's APIError shape for an in-stream `error` event: no status, type only. */
function typeOnlyApiError(type: string, message: string): unknown {
  const err = new Error(message) as Error & Record<string, unknown>;
  err.name = 'APIError';
  err.status = undefined;
  err.code = null;
  err.param = null;
  err.type = type;
  err.error = { type, code: null, message, param: null };
  return err;
}

describe('classifyOpenAIResponsesError — type-only transient frames', () => {
  it('service_unavailable_error with code:null and no status → model_unavailable (retryable)', () => {
    const out = classifyOpenAIResponsesError(
      typeOnlyApiError('service_unavailable_error', 'Unable to verify model access right now. Please retry.'),
    );
    expect(out.kind).toBe('model_unavailable');
    expect(out.raw?.api_error_status).toBe(503);
  });

  it('server_error arriving as a TYPE (code:null) rides the existing server_error row', () => {
    const out = classifyOpenAIResponsesError(
      typeOnlyApiError('server_error', 'The server had an error while processing your request.'),
    );
    expect(out.kind).toBe('model_unavailable');
  });

  it('rate_limit_error arriving as a TYPE (code:null, no status) → rate_limited', () => {
    const out = classifyOpenAIResponsesError(
      typeOnlyApiError('rate_limit_error', 'Rate limit reached. Please try again shortly.'),
    );
    expect(out.kind).toBe('rate_limited');
  });

  it('a code STILL wins over the type when both are present (code-first stays)', () => {
    const err = typeOnlyApiError('server_error', 'You exceeded your current quota.') as Record<string, unknown>;
    err.code = 'insufficient_quota';
    const out = classifyOpenAIResponsesError(err);
    expect(out.kind).toBe('billing_error');
  });

  it('a non-transient type (invalid_request_error) is NOT swept into retry — stays terminal', () => {
    const out = classifyOpenAIResponsesError(
      typeOnlyApiError('invalid_request_error', 'Unsupported parameter: foo.'),
    );
    expect(out.kind).toBe('model_error');
  });
});
