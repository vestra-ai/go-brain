import { describe, it, expect } from 'vitest';
import { resolveCapabilities, isModelAvailable } from '../model-capabilities.js';

/**
 * Model availability. The `available:false` GATE is a first-class, enforced state
 * (never a silent substitution) that the picker + server submit-gate read. Fable
 * (claude-fable-5) WAS gated until it went GA on our account. Since 2026-10-04 the
 * gate holds the two Fireworks builds their provider retired (404 "Model not found"
 * while still listed): deepseek-v4-pro and glm-5.2. Provider-VALUE gating; never
 * runtime/harness.
 */
describe('model availability — Fable 5 is now GA (ungated)', () => {
  it('Fable resolves to available (no `available` flag, no unavailableReason)', () => {
    const fable = resolveCapabilities('claude-fable-5');
    expect(fable).not.toHaveProperty('available');
    expect(fable).not.toHaveProperty('unavailableReason');
  });

  it('a dated/aliased Fable id family-matches and is likewise available', () => {
    expect(resolveCapabilities('claude-fable-5-20260601')).not.toHaveProperty('available');
  });

  it('every seed row leaves `available` ABSENT (no model is gated today)', () => {
    const ids = [
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'claude-fable-5',
      'claude-mythos-5',
      'claude-mythos-preview',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-opus-4-5',
      'claude-sonnet-4-5',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
    ];
    for (const id of ids) {
      const caps = resolveCapabilities(id);
      expect(caps).not.toHaveProperty('available');
      expect(caps).not.toHaveProperty('unavailableReason');
    }
  });

  it('the unknown-id fallback leaves `available` absent → treated as available', () => {
    const caps = resolveCapabilities('some-future-model-9');
    expect(caps).not.toHaveProperty('available');
  });
});

describe('isModelAvailable', () => {
  it('Fable 5 is now available', () => {
    expect(isModelAvailable('claude-fable-5')).toBe(true);
    expect(isModelAvailable('claude-fable-5-20260601')).toBe(true);
  });

  it('is true for every available / unknown model (fail-closed only on a disabled id)', () => {
    for (const id of ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5', 'gpt-5.5', 'some-future-model-9']) {
      expect(isModelAvailable(id)).toBe(true);
    }
  });
});

// 2026-10-04: a minimal call on our Fireworks key answers 404 for deepseek-v4-pro-0813 and glm-5p2,
// as it did for the V4 Flash 0731 build on 2026-09-26. The rows stay (old tasks resolve, label and
// bill) but nothing may be routed to them: the picker, the submit gate, the composer and crash
// resume all read this gate, and the person sees the reason instead of a provider error.
describe('model availability — the Fireworks builds their provider retired', () => {
  it.each([
    ['deepseek-v4-pro', 'DeepSeek V4 Pro'],
    ['glm-5.2', 'GLM 5.2'],
  ])('%s is unavailable, with a reason that names it and says what to do', (id, name) => {
    const caps = resolveCapabilities(id);
    expect(caps.available).toBe(false);
    expect(caps.unavailableReason).toBe(`${name} was retired by its provider. Pick another model to continue.`);
    expect(caps.unavailableReason).not.toMatch(/claude|\u2014|\u2013/i);
    expect(isModelAvailable(id)).toBe(false);
  });

  it('the live builds beside them stay available (V4.1 Flash, and V4 Flash that rides its slug)', () => {
    for (const id of ['deepseek-v4.1-flash', 'deepseek-v4-flash']) {
      expect(resolveCapabilities(id)).not.toHaveProperty('available');
      expect(isModelAvailable(id)).toBe(true);
    }
  });
});
