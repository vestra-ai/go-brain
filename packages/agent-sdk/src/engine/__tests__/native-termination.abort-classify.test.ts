/**
 * classifyAnthropicError — abort arm. Constructs the REAL @anthropic-ai/sdk
 * APIUserAbortError (the class never sets `.name`; a real instance reports
 * `.name === 'Error'`), so the name-only arm missed it and a steer-killed
 * stream fell through to model_error ("The AI service had an issue").
 */
import { describe, it, expect } from 'vitest';
import { APIUserAbortError } from '@anthropic-ai/sdk';
import { classifyAnthropicError } from '../native-termination.js';

describe('classifyAnthropicError — user_aborted (real SDK wrapper)', () => {
  it('maps a REAL APIUserAbortError instance to user_aborted', () => {
    const err = new APIUserAbortError();
    expect(err.name).toBe('Error'); // the class never sets .name
    const o = classifyAnthropicError(err);
    expect(o).toMatchObject({ kind: 'user_aborted', abortPhase: 'streaming' });
  });

  it("carries the caller's phase", () => {
    const o = classifyAnthropicError(new APIUserAbortError(), 'tools');
    expect(o).toMatchObject({ kind: 'user_aborted', abortPhase: 'tools' });
  });

  it("still maps a platform AbortError (name === 'AbortError') to user_aborted", () => {
    const o = classifyAnthropicError({ name: 'AbortError', message: 'This operation was aborted' });
    expect(o.kind).toBe('user_aborted');
  });

  it('regression shape: a plain Error with the abort wording stays model_error (message-sniffing is deliberately NOT used)', () => {
    const o = classifyAnthropicError(new Error('Request was aborted.'));
    expect(o.kind).toBe('model_error');
  });
});
