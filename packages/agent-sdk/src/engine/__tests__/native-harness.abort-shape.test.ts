/**
 * isAbortShapedError — the abort recognizer the round-abort steer path and the
 * terminal catch both key off.
 *
 * Disease-level guard: these tests construct the REAL SDK wrapper classes, not
 * hand-rolled `{ name: 'APIUserAbortError' }` doubles. The real classes never
 * set `.name` — a real instance reports `.name === 'Error'` on BOTH SDKs — so a
 * name-only check passes the doubles while missing every real wrapped abort.
 * Do not "simplify" back to name-only matching.
 */
import { describe, it, expect } from 'vitest';
import { APIUserAbortError as AnthropicAPIUserAbortError } from '@anthropic-ai/sdk';
import { APIUserAbortError as OpenAIAPIUserAbortError } from 'openai';
import { isAbortShapedError } from '../native-harness.js';

describe('isAbortShapedError — real SDK wrapper instances', () => {
  it("openai APIUserAbortError: real instance reports .name === 'Error' and matches via instanceof", () => {
    const err = new OpenAIAPIUserAbortError();
    expect(err.name).toBe('Error'); // the class never sets .name — why name-only matching failed
    expect(isAbortShapedError(err)).toBe(true);
  });

  it("anthropic APIUserAbortError: real instance reports .name === 'Error' and matches via instanceof", () => {
    const err = new AnthropicAPIUserAbortError();
    expect(err.name).toBe('Error');
    expect(isAbortShapedError(err)).toBe(true);
  });

  it("platform abort shape (name === 'AbortError') still matches", () => {
    expect(isAbortShapedError({ name: 'AbortError' })).toBe(true);
  });

  it("duck-typed doubles that set name = 'APIUserAbortError' still match (kept arm)", () => {
    const err = new Error('Request was aborted.');
    err.name = 'APIUserAbortError';
    expect(isAbortShapedError(err)).toBe(true);
  });

  it('a plain Error is NOT abort-shaped — even with the abort wording (message-sniffing is deliberately not used)', () => {
    expect(isAbortShapedError(new Error('x'))).toBe(false);
    expect(isAbortShapedError(new Error('Request was aborted.'))).toBe(false);
  });

  it('null / undefined are not abort-shaped', () => {
    expect(isAbortShapedError(null)).toBe(false);
    expect(isAbortShapedError(undefined)).toBe(false);
  });
});
