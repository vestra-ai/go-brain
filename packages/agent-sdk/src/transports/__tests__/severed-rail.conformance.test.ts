/**
 * THE RAIL IS ONE RAIL — cross-lane conformance.
 *
 * The 2026-08-20 bug (staging task 47faf57f) was not "the fireworks lane lacks a
 * retry". It was that mid-turn recovery had a per-dialect key: the belt gated on
 * `raw.subtype === 'stream_severed'`, which only `classifyAnthropicError` ever
 * stamped, so every OpenAI-shaped lane carried a belt that could never buckle —
 * and nothing in the suite said so. The bug was invisible because every test
 * asked "does the Anthropic arm recover?", never "does EVERY arm recover?".
 *
 * So this file asks the second question, and asks it TOTALLY: it enumerates every
 * Transport exported from `../index.js` rather than naming lanes, so a provider
 * added tomorrow is swept in automatically and fails HERE if its classifier does
 * not arm the shared rail. That is the property that was missing, not a test for
 * one more lane.
 *
 * What it pins is the CONTRACT between a transport and the engine:
 *   · a severance → an outcome the rail re-issues (isReissuableRoundError);
 *   · an abort    → never re-issued (a clean stop, not a severance);
 *   · a 429 / 400 → never re-issued (a stronger signal owns those).
 * It says nothing about HOW a lane recognizes a severance — that is the dialect's
 * SeveranceSpec, and the policy it feeds lives once in engine/severed-recognizer.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as transports from '../index.js';
import { isReissuableRoundError } from '../../engine/severed-stream.js';
import { STREAM_END_SENTINELS } from '../../engine/severed-recognizer.js';
import type { Transport } from '../../engine/transport.js';

const FLAG = 'NATIVE_STREAM_SEVERED_RETRY';

afterEach(() => {
  delete process.env[FLAG];
});

/**
 * Every concrete Transport the package ships, discovered from the barrel — NOT a
 * hand-maintained list, which is the thing that would rot back into the bug.
 * Duck-typed on the two members the engine actually calls through.
 */
type TransportCtor = new () => Transport;
const isTransportCtor = (value: unknown): value is TransportCtor => {
  const proto = (value as { prototype?: Record<string, unknown> } | undefined)?.prototype;
  return (
    typeof value === 'function' &&
    typeof proto?.classifyError === 'function' &&
    typeof proto?.readStream === 'function'
  );
};
const LANES: Array<[string, TransportCtor]> = Object.entries(transports)
  .filter(([, value]) => isTransportCtor(value))
  .map(([name, value]) => [name, value as TransportCtor]);

/** The undici shape a real mid-stream socket death arrives in. */
function undiciSocketDeath(): Error {
  const cause = new Error('other side closed') as Error & { code: string };
  cause.code = 'UND_ERR_SOCKET';
  return new TypeError('terminated', { cause });
}

function econnreset(): Error {
  const err = new Error('socket hang up') as Error & { code: string };
  err.code = 'ECONNRESET';
  return err;
}

it('discovers every shipped Transport (a barrel that stops exporting one must fail here)', () => {
  // Guard the guard: if the duck-type ever stops matching, LANES silently empties
  // and every conformance case below vacuously passes.
  expect(LANES.length).toBeGreaterThanOrEqual(4);
  expect(LANES.map(([name]) => name).sort()).toEqual([
    'AnthropicMessagesTransport',
    'ChatCompletionsTransport',
    'GeminiInteractionsTransport',
    'GeminiTransport',
    'OpenAIResponsesTransport',
  ]);
});

describe.each(LANES)('%s — arms the shared severed-round rail', (_name, Ctor) => {
  const classify = (err: unknown) => new Ctor().classifyError(err);

  it('a mid-stream socket death is re-issuable', () => {
    process.env[FLAG] = 'true';
    expect(isReissuableRoundError(classify(undiciSocketDeath()))).toBe(true);
  });

  it('an ECONNRESET is re-issuable', () => {
    process.env[FLAG] = 'true';
    expect(isReissuableRoundError(classify(econnreset()))).toBe(true);
  });

  it.each(STREAM_END_SENTINELS)('recovers from the premature-end sentinel %s', (sentinel) => {
    process.env[FLAG] = 'true';
    // EVERY sentinel, on EVERY lane. These strings are ours — each transport's
    // readStream throws one when the SSE ends with no terminal chunk/event — and
    // they live in one shared registry precisely so no lane can know only its own.
    // That is how the Gemini lane was found dark: its sentinel classified
    // model_error because only the Anthropic string was on the Anthropic arm.
    expect(isReissuableRoundError(classify(new Error(sentinel)))).toBe(true);
  });

  it('an ABORT is never re-issued (a clean stop is not a severance)', () => {
    process.env[FLAG] = 'true';
    const abort = new Error('Request was aborted.');
    abort.name = 'AbortError';
    const outcome = classify(abort);
    expect(outcome.kind).toBe('user_aborted');
    expect(isReissuableRoundError(outcome)).toBe(false);
  });

  it('a 429 is never re-issued by the rail (rate limiting owns its own retry)', () => {
    process.env[FLAG] = 'true';
    const outcome = classify(Object.assign(new Error('slow down'), { status: 429 }));
    expect(outcome.kind).toBe('rate_limited');
    expect(isReissuableRoundError(outcome)).toBe(false);
  });

  it('a status-bearing error keeps its stronger signal even with a socket code on its cause', () => {
    process.env[FLAG] = 'true';
    const cause = new Error('other side closed') as Error & { code: string };
    cause.code = 'ECONNRESET';
    const outcome = classify(Object.assign(new Error('server blew up'), { status: 503, cause }));
    // 5xx → model_unavailable, which the rail does NOT re-issue; the severed
    // branch must not have stolen it on the way past.
    expect(outcome.kind).toBe('model_unavailable');
  });
});
