/**
 * Deploy-seam ladder 1 — severed-stream classification (NATIVE_STREAM_SEVERED_RETRY).
 *
 * Incident a7ea0665 (2026-07-08): every Railway restart severs all in-flight native
 * model streams at the /api/proxy/anthropic seam. The SSE dies mid-stream, the
 * SDK's s.finalMessage() throws AnthropicError('stream ended without producing a
 * Message with role=assistant') (@anthropic-ai/sdk lib/MessageStream.mjs:341) — an
 * error with NO `status` that fell through to the terminal catch-all model_error:
 * no retry, the whole turn burned.
 *
 * Under the flag, the severance classifies as the RETRYABLE network_error kind with
 * the distinct raw.subtype 'stream_severed' (the engine's re-issue key). Flag OFF
 * must stay byte-identical to today (model_error).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AnthropicError, APIConnectionError, APIUserAbortError } from '@anthropic-ai/sdk';
import {
  classifyAnthropicError,
  isSeveredStreamError,
  ANTHROPIC_SEVERED_STREAM_MESSAGE,
  STREAM_SEVERED_SUBTYPE,
} from '../native-termination.js';

const FLAG = 'NATIVE_STREAM_SEVERED_RETRY';

const severedError = (): AnthropicError => new AnthropicError(ANTHROPIC_SEVERED_STREAM_MESSAGE);

describe('isSeveredStreamError — the mid-stream severance recognizer', () => {
  it('matches the finalMessage sentinel: AnthropicError with the exact MessageStream message', () => {
    expect(isSeveredStreamError(severedError())).toBe(true);
  });

  it('does NOT match an AnthropicError with any other message', () => {
    expect(isSeveredStreamError(new AnthropicError('some other failure'))).toBe(false);
  });

  it('does NOT match a plain Error carrying the same message (class-gated, not message-sniffed)', () => {
    expect(isSeveredStreamError(new Error(ANTHROPIC_SEVERED_STREAM_MESSAGE))).toBe(false);
  });

  it('matches the SDK connection wrapper (APIConnectionError) by instanceof', () => {
    expect(isSeveredStreamError(new APIConnectionError({ cause: new Error('socket hang up') }))).toBe(true);
  });

  it('matches structured socket codes on the error itself (ECONNRESET / premature close / undici socket)', () => {
    for (const code of ['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_SOCKET']) {
      const err = new Error('terminated') as Error & { code: string };
      err.code = code;
      expect(isSeveredStreamError(err), code).toBe(true);
    }
  });

  it('matches a structured socket code down the cause chain (undici wraps the SocketError)', () => {
    const cause = new Error('other side closed') as Error & { code: string };
    cause.code = 'UND_ERR_SOCKET';
    const err = new TypeError('terminated', { cause });
    expect(isSeveredStreamError(err)).toBe(true);
  });

  it('never matches an abort (APIUserAbortError) — an abort is a clean stop, not a severance', () => {
    expect(isSeveredStreamError(new APIUserAbortError())).toBe(false);
  });

  it('does not match a generic error / null / undefined', () => {
    expect(isSeveredStreamError(new Error('boom'))).toBe(false);
    expect(isSeveredStreamError(null)).toBe(false);
    expect(isSeveredStreamError(undefined)).toBe(false);
  });
});

describe('classifyAnthropicError — flag OFF (byte-identical to today)', () => {
  beforeEach(() => {
    delete process.env[FLAG];
  });

  it('the severed-stream sentinel still classifies model_error (the pre-flag behavior)', () => {
    const outcome = classifyAnthropicError(severedError());
    expect(outcome.kind).toBe('model_error');
    expect(outcome.raw.subtype).toBe('model_error');
  });
});

describe('classifyAnthropicError — flag ON', () => {
  beforeEach(() => {
    process.env[FLAG] = 'true';
  });
  afterEach(() => {
    delete process.env[FLAG];
  });

  it('the severed-stream sentinel classifies network_error with the distinct stream_severed subtype', () => {
    const outcome = classifyAnthropicError(severedError());
    expect(outcome.kind).toBe('network_error');
    expect(outcome.raw.subtype).toBe(STREAM_SEVERED_SUBTYPE);
    if (outcome.kind === 'network_error') {
      expect(outcome.message).toBe(ANTHROPIC_SEVERED_STREAM_MESSAGE);
    }
  });

  it('an abort still wins over the severed classification (never regress #1592)', () => {
    const outcome = classifyAnthropicError(new APIUserAbortError());
    expect(outcome.kind).toBe('user_aborted');
  });

  it('status-bearing errors are untouched (a 429 stays rate_limited)', () => {
    const err = { status: 429, message: 'rate limited' };
    expect(classifyAnthropicError(err).kind).toBe('rate_limited');
  });

  it('a generic error still classifies model_error (the severed branch sweeps nothing else)', () => {
    expect(classifyAnthropicError(new Error('boom')).kind).toBe('model_error');
  });
});
