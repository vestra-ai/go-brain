/**
 * Deploy-seam ladder 1, OPENAI-DIALECT arm — severed-stream classification
 * (NATIVE_STREAM_SEVERED_RETRY).
 *
 * The Anthropic arm has recognized a mid-stream severance since incident a7ea0665
 * (native-termination.isSeveredStreamError → network_error / 'stream_severed'), but
 * `classifyOpenAIResponsesError` — the classifier BOTH OpenAI-shaped transports use
 * (Chat Completions = the GLM/Luna/DeepSeek/Fireworks lane, and Responses) — never
 * had one. Its consequences, live on staging (task 47faf57f, 2026-08-20 13:30:04Z):
 *
 *   · the transports' OWN premature-end sentinels ("Chat Completions stream ended
 *     without a terminal chunk" / "OpenAI Responses stream ended without a terminal
 *     event") and the openai SDK's `APIConnectionError` ("Connection error.") fell
 *     through every net to the terminal catch-all `model_error` — NOT retryable;
 *   · a socket-level drop that DID reach the message net classified network_error
 *     with subtype 'network', which the engine's re-issue gate did not key on.
 *
 * Either way the turn was burned. This pins the recognizer + the flag-gated
 * classification. Flag OFF must stay byte-identical to today.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { APIConnectionError, APIUserAbortError } from 'openai';
import {
  classifyOpenAIResponsesError,
  isOpenAISeveredStreamError,
  CHAT_COMPLETIONS_SEVERED_STREAM_MESSAGE,
  OPENAI_RESPONSES_SEVERED_STREAM_MESSAGE,
} from '../openai-responses-termination.js';
import { STREAM_SEVERED_SUBTYPE } from '../../engine/native-termination.js';

const FLAG = 'NATIVE_STREAM_SEVERED_RETRY';

afterEach(() => {
  delete process.env[FLAG];
});

/** The undici shape a mid-stream socket death actually arrives in. */
function undiciTerminated(): Error {
  const cause = new Error('other side closed') as Error & { code: string };
  cause.code = 'UND_ERR_SOCKET';
  return new TypeError('terminated', { cause });
}

describe('isOpenAISeveredStreamError — the OpenAI-dialect severance recognizer', () => {
  it('matches the Chat Completions premature-end sentinel (the GLM/Luna lane throw)', () => {
    expect(isOpenAISeveredStreamError(new Error(CHAT_COMPLETIONS_SEVERED_STREAM_MESSAGE))).toBe(true);
  });

  it('matches the OpenAI Responses premature-end sentinel', () => {
    expect(isOpenAISeveredStreamError(new Error(OPENAI_RESPONSES_SEVERED_STREAM_MESSAGE))).toBe(true);
  });

  it('matches the openai SDK connection wrapper by instanceof (its message is only "Connection error.")', () => {
    expect(isOpenAISeveredStreamError(new APIConnectionError({ cause: new Error('socket hang up') }))).toBe(true);
  });

  it('matches structured socket codes on the error itself', () => {
    for (const code of ['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_SOCKET']) {
      const err = new Error('terminated') as Error & { code: string };
      err.code = code;
      expect(isOpenAISeveredStreamError(err), code).toBe(true);
    }
  });

  it('matches a structured socket code down the cause chain (undici wraps the SocketError)', () => {
    expect(isOpenAISeveredStreamError(undiciTerminated())).toBe(true);
  });

  it('never matches an abort — an abort is a clean stop, not a severance', () => {
    expect(isOpenAISeveredStreamError(new APIUserAbortError())).toBe(false);
  });

  it('does not match an ordinary model failure', () => {
    expect(isOpenAISeveredStreamError(new Error('The model produced an invalid response'))).toBe(false);
  });
});

describe('classifyOpenAIResponsesError — severed stream, flag ON', () => {
  it('classifies the Chat Completions sentinel as network_error / stream_severed (was model_error)', () => {
    process.env[FLAG] = 'true';
    const out = classifyOpenAIResponsesError(new Error(CHAT_COMPLETIONS_SEVERED_STREAM_MESSAGE));
    expect(out.kind).toBe('network_error');
    expect(out.raw.subtype).toBe(STREAM_SEVERED_SUBTYPE);
  });

  it('classifies the Responses sentinel as network_error / stream_severed', () => {
    process.env[FLAG] = 'true';
    const out = classifyOpenAIResponsesError(new Error(OPENAI_RESPONSES_SEVERED_STREAM_MESSAGE));
    expect(out.kind).toBe('network_error');
    expect(out.raw.subtype).toBe(STREAM_SEVERED_SUBTYPE);
  });

  it('classifies the SDK connection wrapper as network_error / stream_severed', () => {
    process.env[FLAG] = 'true';
    const out = classifyOpenAIResponsesError(new APIConnectionError({ cause: new Error('socket hang up') }));
    expect(out.kind).toBe('network_error');
    expect(out.raw.subtype).toBe(STREAM_SEVERED_SUBTYPE);
  });

  it('classifies an undici mid-stream socket death as network_error / stream_severed', () => {
    process.env[FLAG] = 'true';
    const out = classifyOpenAIResponsesError(undiciTerminated());
    expect(out.kind).toBe('network_error');
    expect(out.raw.subtype).toBe(STREAM_SEVERED_SUBTYPE);
  });

  it('an ABORT still wins over the severed branch (clean stop, never a severance)', () => {
    process.env[FLAG] = 'true';
    expect(classifyOpenAIResponsesError(new APIUserAbortError()).kind).toBe('user_aborted');
  });

  it('a status-bearing API error is NEVER a severance, even with a socket code on its cause', () => {
    process.env[FLAG] = 'true';
    const cause = new Error('other side closed') as Error & { code: string };
    cause.code = 'ECONNRESET';
    const err = Object.assign(new Error('prompt is too long'), {
      status: 400,
      code: 'context_length_exceeded',
      cause,
    });
    // The stronger signal (400 + context code) still wins — the severed branch
    // sits early precisely BECAUSE the recognizer ignores status-bearing errors.
    expect(isOpenAISeveredStreamError(err)).toBe(false);
    expect(classifyOpenAIResponsesError(err).kind).toBe('context_exceeded');
  });

  it('does NOT sweep an overload (status-less server_error keeps model_unavailable)', () => {
    process.env[FLAG] = 'true';
    const err = Object.assign(new Error('The server had an error while processing your request'), {
      code: 'server_error',
    });
    expect(classifyOpenAIResponsesError(err).kind).toBe('model_unavailable');
  });
});

describe('classifyOpenAIResponsesError — severed stream, flag OFF (byte-identical to today)', () => {
  it('the Chat Completions sentinel stays the terminal catch-all model_error', () => {
    delete process.env[FLAG];
    const out = classifyOpenAIResponsesError(new Error(CHAT_COMPLETIONS_SEVERED_STREAM_MESSAGE));
    expect(out.kind).toBe('model_error');
    expect(out.raw.subtype).toBe('model_error');
  });

  it('the SDK connection wrapper stays model_error', () => {
    delete process.env[FLAG];
    expect(classifyOpenAIResponsesError(new APIConnectionError({ cause: new Error('socket hang up') })).kind)
      .toBe('model_error');
  });

  it('an undici socket death keeps the legacy network_error / "network" subtype', () => {
    delete process.env[FLAG];
    const out = classifyOpenAIResponsesError(undiciTerminated());
    expect(out.kind).toBe('network_error');
    expect(out.raw.subtype).toBe('network');
  });
});
