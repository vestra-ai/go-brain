/**
 * Hermes-parity PR1 — empty-output recovery (gap #1, the only provider-NEUTRAL
 * CRITICAL from the 2026-06-26 transport-parity audit).
 *
 * The native loop previously treated "the model emitted NO tool calls" as a
 * TERMINAL break and classified whatever it had — even a blank or thinking-only
 * round — as a completed turn. Weak/cheap models routinely emit an empty round
 * right after tool results (or a thinking-only round), so every one became a
 * silent dead turn with a blank assistant bubble and no retry.
 *
 * Hermes treats that same branch as a bounded RECOVERY surface. This layer
 * unit-tests the pure decision helper; the wiring (in-memory nudge re-call,
 * no empty assistant entry, never-blank fallback) is covered by the integration
 * suite (apps/sandbox native-harness.empty-recovery.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { emptyRecoveryDecision } from '../native-harness.js';

const base = { hasThinking: false as boolean };

describe('emptyRecoveryDecision — pure empty-completion decision (PR1)', () => {
  it('visible text present → complete (a genuine answer, regardless of attempts)', () => {
    expect(emptyRecoveryDecision({ ...base, hasVisibleText: true, stopReason: 'end_turn', attemptsSoFar: 0, maxAttempts: 3 })).toBe('complete');
    expect(emptyRecoveryDecision({ ...base, hasVisibleText: true, stopReason: 'end_turn', attemptsSoFar: 9, maxAttempts: 3 })).toBe('complete');
  });

  it('truly-empty (no text, no thinking) + CLEAN stop + attempts under the cap → recover', () => {
    expect(emptyRecoveryDecision({ ...base, hasVisibleText: false, stopReason: 'end_turn', attemptsSoFar: 0, maxAttempts: 3 })).toBe('recover');
    expect(emptyRecoveryDecision({ ...base, hasVisibleText: false, stopReason: 'completed', attemptsSoFar: 2, maxAttempts: 3 })).toBe('recover');
    // A transport that does not surface a stopReason (null) is treated as clean.
    expect(emptyRecoveryDecision({ ...base, hasVisibleText: false, stopReason: null, attemptsSoFar: 0, maxAttempts: 3 })).toBe('recover');
  });

  it('truly-empty + CLEAN stop + attempts at/over the cap → giveup (stop retrying, finalize)', () => {
    expect(emptyRecoveryDecision({ ...base, hasVisibleText: false, stopReason: 'end_turn', attemptsSoFar: 3, maxAttempts: 3 })).toBe('giveup');
    expect(emptyRecoveryDecision({ ...base, hasVisibleText: false, stopReason: 'end_turn', attemptsSoFar: 5, maxAttempts: 3 })).toBe('giveup');
  });

  it('maxAttempts:0 → a truly-empty round gives up immediately (no recovery configured)', () => {
    expect(emptyRecoveryDecision({ ...base, hasVisibleText: false, stopReason: 'end_turn', attemptsSoFar: 0, maxAttempts: 0 })).toBe('giveup');
  });

  it('THINKING-ONLY (thinking, no text) → complete (never re-called: a 2nd assistant round would break journal role-alternation)', () => {
    expect(emptyRecoveryDecision({ hasVisibleText: false, hasThinking: true, stopReason: 'end_turn', attemptsSoFar: 0, maxAttempts: 3 })).toBe('complete');
    expect(emptyRecoveryDecision({ hasVisibleText: false, hasThinking: true, stopReason: 'completed', attemptsSoFar: 0, maxAttempts: 3 })).toBe('complete');
  });

  it('empty but NON-clean stop → complete (a legit terminal state, never recovered)', () => {
    // A refusal / content_filter is the model declining, not an empty glitch.
    expect(emptyRecoveryDecision({ ...base, hasVisibleText: false, stopReason: 'refusal', attemptsSoFar: 0, maxAttempts: 3 })).toBe('complete');
    expect(emptyRecoveryDecision({ ...base, hasVisibleText: false, stopReason: 'content_filter', attemptsSoFar: 0, maxAttempts: 3 })).toBe('complete');
    // max_tokens / length is truncation, not emptiness — re-calling won't help.
    expect(emptyRecoveryDecision({ ...base, hasVisibleText: false, stopReason: 'max_tokens', attemptsSoFar: 0, maxAttempts: 3 })).toBe('complete');
    expect(emptyRecoveryDecision({ ...base, hasVisibleText: false, stopReason: 'length', attemptsSoFar: 0, maxAttempts: 3 })).toBe('complete');
  });
});
