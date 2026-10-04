import { describe, it, expect } from 'vitest';
import { classifyAnthropicError } from '../native-termination.js';

/**
 * Net 3 (Document Studio Slice 0): a 413 "Request body is too large" and a 400
 * "too many images" are CONTEXT overflows, not a generic model_error. They were
 * the letterhead incident's user-facing failure ("The AI service had an issue").
 * context_exceeded already maps to an honest "Conversation too long to process".
 */
describe('classifyAnthropicError — context_exceeded (Net 3)', () => {
  it('maps a 413 (request body too large) to context_exceeded', () => {
    const o = classifyAnthropicError({ status: 413, message: 'Request body is too large' });
    expect(o.kind).toBe('context_exceeded');
  });

  it('maps a request_too_large error type (no status) to context_exceeded', () => {
    const o = classifyAnthropicError({
      message: 'payload too large',
      error: { type: 'request_too_large' },
    } as never);
    expect(o.kind).toBe('context_exceeded');
  });

  it('maps a 400 "too many images" to context_exceeded (NOT image_error)', () => {
    const o = classifyAnthropicError({ status: 400, message: 'too many images in the request' });
    expect(o.kind).toBe('context_exceeded');
  });

  it('maps a 400 "maximum of 100 images" to context_exceeded', () => {
    const o = classifyAnthropicError({
      status: 400,
      message: 'A maximum of 100 images is allowed per request, but 142 were provided',
    });
    expect(o.kind).toBe('context_exceeded');
  });

  it('still maps a single-image decode failure to image_error (not swept up)', () => {
    const o = classifyAnthropicError({ status: 400, message: 'Could not process image attachment' });
    expect(o.kind).toBe('image_error');
  });

  it('still maps a generic validation 400 to model_error', () => {
    const o = classifyAnthropicError({ status: 400, message: 'Invalid parameter: foo' });
    expect(o.kind).toBe('model_error');
  });
});
