import { describe, it, expect } from 'vitest';
import { classifyAnthropicError } from '../native-termination.js';
import { terminalReasonFor } from '../../contract/terminal-reason.js';

/**
 * Prod 09-16 — the hour nobody knew about.
 *
 * A task wedged on a 400 that was OUR fault: we replayed an assistant turn with
 * a `thinking` block whose signature no longer matched, because the accumulator
 * had dropped the provider blocks it was signed over. Anthropic answered
 *
 *   messages.19.content.1: `thinking` or `redacted_thinking` blocks in the latest
 *   assistant message cannot be modified.
 *
 * and it landed in the catch-all `model_error`, whose label reads "The AI service
 * had an issue". Both halves of that are false — the AI service was fine, and the
 * problem was a request we built. So the row was indistinguishable from a
 * transient upstream blip: the user retried five times against a wall, no alert
 * fired, and it took a support message to find it.
 *
 * Same shape as the letterhead incident (see native-termination.context.test.ts):
 * a real, specific cause wearing the generic label. `request_invalid` is the
 * honest one — the request we sent was malformed, and it names US.
 *
 * The rule is deliberately TIGHT (the `image_rejected` precedent): it matches the
 * thinking/signature replay family only. A generic `invalid_request_error` still
 * falls through to `model_error`, because widening this to every 400 would
 * relabel faults we have not actually diagnosed.
 */
describe('classifyAnthropicError — request_invalid (the 09-16 wedge)', () => {
  const MODIFIED =
    'messages.19.content.1: `thinking` or `redacted_thinking` blocks in the latest ' +
    'assistant message cannot be modified. These blocks must remain as they were ' +
    'in the original response.';

  it('names the verbatim prod message request_invalid, not model_error', () => {
    const o = classifyAnthropicError({ status: 400, message: MODIFIED });
    expect(o.kind).toBe('request_invalid');
  });

  it('catches the sibling failure — a thinking signature that does not verify', () => {
    const o = classifyAnthropicError({
      status: 400,
      message: 'Invalid signature in thinking block at messages.4.content.0',
    });
    expect(o.kind).toBe('request_invalid');
  });

  it('carries the provider message so the cause survives into telemetry', () => {
    const o = classifyAnthropicError({ status: 400, message: MODIFIED });
    expect(o.kind === 'request_invalid' && o.message).toContain('cannot be modified');
  });

  it('leaves an undiagnosed 400 as model_error — the rule stays tight', () => {
    const o = classifyAnthropicError({
      status: 400,
      message: 'messages: at least one message is required',
    });
    expect(o.kind).toBe('model_error');
  });

  it('does not steal the context and image 400s that already have honest kinds', () => {
    expect(classifyAnthropicError({ status: 400, message: 'prompt is too long' }).kind)
      .toBe('context_exceeded');
    expect(classifyAnthropicError({ status: 400, message: 'Could not process image attachment' }).kind)
      .toBe('image_error');
  });
});

describe('terminalReasonFor — request_invalid reads honestly', () => {
  it('is a failure, and does NOT blame the AI service', () => {
    const v = terminalReasonFor({ kind: 'request_invalid', message: 'x', raw: {} } as never);
    expect(v.status).toBe('failed');
    expect(v.label).not.toMatch(/AI service/i);
  });

  it('tells the user the history was the problem, not their request', () => {
    const v = terminalReasonFor({ kind: 'request_invalid', message: 'x', raw: {} } as never);
    expect(v.label.toLowerCase()).toContain('history');
  });
});
