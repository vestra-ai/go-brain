/**
 * COMPACTION_V2 — overflow classification and the two staleness guards.
 *
 * The classification tests exist for ONE failure: answering a temporary "slow down"
 * by permanently destroying the user's conversation. Real rate-limit bodies talk
 * about tokens ("token rate limit exceeded", "input tokens per minute"), so an
 * overflow pattern matched first would classify a throttle as an overflow. The
 * exclusions run first, and these pin that they do.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyOverflow,
  overflowSurvivesModelSwitch,
  overflowSurvivesCompaction,
} from '../overflow.js';
import { resolveMaxContextTokens } from '../../journal/token-ledger.js';

describe('classifyOverflow — throttle exclusions run FIRST', () => {
  it('a 429 that talks about tokens is a THROTTLE, never an overflow', () => {
    expect(
      classifyOverflow({
        status: 429,
        message: 'Request too large: token rate limit exceeded, too many tokens for this org',
      }),
    ).toEqual({ overflow: false, reason: 'throttle' });
  });

  it('a rate_limit_error TYPE excludes overflow even with overflow-shaped prose', () => {
    expect(
      classifyOverflow({
        status: 400,
        errorType: 'rate_limit_error',
        message: 'prompt is too long: maximum tokens exceeded',
      }),
    ).toEqual({ overflow: false, reason: 'throttle' });
  });

  it('a retry-after header excludes overflow — an overflow is never retryable-after-a-wait', () => {
    expect(
      classifyOverflow({ status: 400, retryAfterPresent: true, message: 'context window exceeded' }),
    ).toEqual({ overflow: false, reason: 'throttle' });
  });

  it('throttle PROSE alone excludes overflow when no structured field disambiguates', () => {
    for (const message of [
      'You have exceeded your tokens per minute quota',
      'Too many requests, try again later',
      'The model is currently overloaded with other requests',
      'Rate limit reached for input tokens',
    ]) {
      expect(classifyOverflow({ status: 400, message }), message).toEqual({
        overflow: false,
        reason: 'throttle',
      });
    }
  });
});

describe('classifyOverflow — structured signals before prose', () => {
  it('413 is an overflow off the STATUS alone, no message needed', () => {
    expect(classifyOverflow({ status: 413 })).toEqual({ overflow: true, signal: 'status' });
  });

  it('request_too_large / context_length_exceeded classify off the error TYPE', () => {
    for (const errorType of ['request_too_large', 'payload_too_large', 'context_length_exceeded']) {
      expect(classifyOverflow({ status: 400, errorType }), errorType).toEqual({
        overflow: true,
        signal: 'error_type',
      });
    }
  });

  it('model_context_window_exceeded classifies off the STOP REASON — nothing threw', () => {
    expect(classifyOverflow({ stopReason: 'model_context_window_exceeded' })).toEqual({
      overflow: true,
      signal: 'stop_reason',
    });
  });

  it('max_tokens is NOT an overflow — that is the output cap on a long answer', () => {
    expect(classifyOverflow({ stopReason: 'max_tokens' })).toEqual({
      overflow: false,
      reason: 'no_signal',
    });
  });

  it('prose is the LAST resort, and only behind a 4xx', () => {
    expect(classifyOverflow({ status: 400, message: 'prompt is too long: 250000 > 200000 tokens' })).toEqual({
      overflow: true,
      signal: 'message',
    });
    // A 500 whose body happens to mention context must never masquerade as overflow.
    expect(classifyOverflow({ status: 500, message: 'internal error in context service' })).toEqual({
      overflow: false,
      reason: 'no_signal',
    });
    // Prose with NO status at all is not enough on its own.
    expect(classifyOverflow({ message: 'the context window is too long' })).toEqual({
      overflow: false,
      reason: 'no_signal',
    });
  });

  it('is TOTAL — an empty or junk input is not an overflow', () => {
    expect(classifyOverflow({})).toEqual({ overflow: false, reason: 'no_signal' });
    expect(classifyOverflow({ status: 200, message: '' })).toEqual({ overflow: false, reason: 'no_signal' });
  });
});

describe('GUARD 1 — model switch', () => {
  const observed = { model: 'claude-sonnet-4-5', seq: 42 }; // 200k window

  it('BAILS when the user switched to a LARGER-window model', () => {
    // 200k overflowed; the turn now runs a 1M model, where it may fit fine.
    expect(overflowSurvivesModelSwitch(observed, 'claude-sonnet-5', resolveMaxContextTokens)).toBe(false);
  });

  it('SURVIVES a switch to an equal or smaller window — it still overflows', () => {
    expect(overflowSurvivesModelSwitch(observed, 'claude-haiku-4-5', resolveMaxContextTokens)).toBe(true);
    expect(overflowSurvivesModelSwitch(observed, 'claude-opus-4-5', resolveMaxContextTokens)).toBe(true);
  });

  it('SURVIVES when the model did not change at all', () => {
    expect(overflowSurvivesModelSwitch(observed, observed.model, resolveMaxContextTokens)).toBe(true);
  });

  it('the guard is about the WINDOW, not the id — a rename with the same window survives', () => {
    const windowFor = (): number => 200_000;
    expect(overflowSurvivesModelSwitch(observed, 'some-other-id', windowFor)).toBe(true);
  });
});

describe('GUARD 2 — post-compaction staleness', () => {
  const observed = { model: 'claude-sonnet-5', seq: 100 };

  it('BAILS when a compaction landed AFTER the observation', () => {
    expect(overflowSurvivesCompaction(observed, 120)).toBe(false);
  });

  it('BAILS when a compaction landed AT the observation', () => {
    expect(overflowSurvivesCompaction(observed, 100)).toBe(false);
  });

  it('SURVIVES when the only compaction predates the observation', () => {
    expect(overflowSurvivesCompaction(observed, 80)).toBe(true);
  });

  it('SURVIVES when nothing has ever compacted', () => {
    expect(overflowSurvivesCompaction(observed, null)).toBe(true);
  });
});
