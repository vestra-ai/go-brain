/**
 * Follow-up B item 3 — a bodyless 5xx from the provider (staging tasks 6cffd831 and
 * b2d2b365, wave-2 drills 2026-09-04): "502 status code (no body)" failed the turn at
 * once, once for a helper 19 tool calls in and once for a lead before its first call.
 *
 * That message is what an edge or a proxy returns when the upstream is briefly gone: no
 * error body, so no code and no type for the classifier to read. When it reaches us as a
 * plain re-thrown Error (the transport's captured-SSE-failure path, which carries the
 * message and nothing else) every net misses it and it lands on the terminal model_error,
 * which is deliberately NOT retryable. The provider said nothing except "try again", and
 * the turn burned.
 *
 * The wording IS the fact here: there is no structured field to parse, which is why this
 * is a named message rule and not a code row. The net is tight on purpose — it names the
 * exact three statuses worth another attempt, so a bodyless 4xx stays terminal.
 */
import { describe, it, expect } from 'vitest';
import { classifyOpenAIResponsesError } from '../openai-responses-termination.js';
import { BODYLESS_5XX_SUBTYPE } from '../../engine/error-authority.js';

/** The captured-SSE-failure re-throw: the message, and nothing else to read. */
function relayedFrame(message: string): unknown {
  return new Error(message);
}

/** The openai SDK's own shape for a bodyless HTTP error (core/error.js makeMessage). */
function apiErrorFrame(status: number): unknown {
  const err = new Error(`${status} status code (no body)`) as Error & Record<string, unknown>;
  err.name = 'APIError';
  err.status = status;
  err.code = null;
  err.type = undefined;
  return err;
}

describe('classifyOpenAIResponsesError — a bodyless 5xx is transient, not terminal', () => {
  it.each([502, 503, 504])('a status-less "%d status code (no body)" relay → model_unavailable', (status) => {
    const out = classifyOpenAIResponsesError(relayedFrame(`${status} status code (no body)`));
    expect(out.kind).toBe('model_unavailable');
    expect(out.raw?.subtype).toBe(BODYLESS_5XX_SUBTYPE);
  });

  it('the same frame WITH its http status keeps the real status on the telemetry', () => {
    const out = classifyOpenAIResponsesError(apiErrorFrame(504));
    expect(out.kind).toBe('model_unavailable');
    expect(out.raw?.subtype).toBe(BODYLESS_5XX_SUBTYPE);
    expect(out.raw?.api_error_status).toBe(504);
  });

  it('a bodyless 4xx is NOT retried: it stays exactly what it is today', () => {
    // A 400 with no body is a request we built wrong. Another attempt sends the same bytes.
    const out = classifyOpenAIResponsesError(relayedFrame('400 status code (no body)'));
    expect(out.kind).toBe('model_error');
    expect(out.raw?.subtype).not.toBe(BODYLESS_5XX_SUBTYPE);
  });

  it('a 5xx WITH a body does not ride this rule — it keeps its own classification', () => {
    const out = classifyOpenAIResponsesError(relayedFrame('The server had an error while processing your request.'));
    expect(out.kind).toBe('model_unavailable');
    expect(out.raw?.subtype).not.toBe(BODYLESS_5XX_SUBTYPE);
  });

  it('a bodyless 401 still reads as auth, not as a transient blip', () => {
    const err = new Error('401 status code (no body)') as Error & Record<string, unknown>;
    err.status = 401;
    const out = classifyOpenAIResponsesError(err);
    expect(out.kind).toBe('auth_error');
  });
});
