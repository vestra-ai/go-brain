/**
 * Regression: the bounded structured-output epilogue must short-circuit a genuine
 * REFUSAL terminal constrained call to a `kind:'refused'` outcome BEFORE the
 * `JSON.parse` retry loop — so a refusal does NOT masquerade as
 * `max_structured_output_retries` (which billed the constrained call 3×).
 *
 * The short-circuit is OUTCOME-DRIVEN (it keys on the terminal stopReason being a
 * refusal), NOT on the provider / runtime. It is therefore a SHARED-PATH change:
 * it applies symmetrically to the Anthropic and OpenAI arms. The byte-identity
 * constraint is preserved precisely because it fires ONLY on a refusal signal and
 * does NOT touch: the happy path (valid JSON → null → parses & succeeds), the
 * legitimate retry path (nonempty INVALID JSON → null → parses, fails, retries),
 * NOR a benign EMPTY completion on a clean stopReason (empty + end_turn/completed
 * → null → keeps its full retry budget, which a later attempt can satisfy).
 *
 * This unit-tests the pure decision helper `epilogueRefusalShortCircuit`, which is
 * the entire behavior change; the harness calls it before its parse loop.
 */
import { describe, it, expect } from 'vitest';
import { epilogueRefusalShortCircuit } from '../native-harness.js';

describe('epilogueRefusalShortCircuit — genuine refusal terminal → refused outcome', () => {
  it('a refusal stopReason short-circuits to a refused outcome carrying the refusal text', () => {
    const out = epilogueRefusalShortCircuit('refusal', "I'm sorry, I cannot produce that.");
    expect(out).not.toBeNull();
    expect(out!.kind).toBe('refused');
    expect((out as { kind: 'refused'; text: string }).text).toBe(
      "I'm sorry, I cannot produce that.",
    );
  });

  it('a content_filter stopReason also short-circuits to refused', () => {
    const out = epilogueRefusalShortCircuit('content_filter', 'blocked by policy');
    expect(out).not.toBeNull();
    expect(out!.kind).toBe('refused');
    expect((out as { kind: 'refused'; text: string }).text).toBe('blocked by policy');
  });

  it('a refusal that carries NO text → refused with a stable fallback (never a blank bubble)', () => {
    const out = epilogueRefusalShortCircuit('refusal', '');
    expect(out).not.toBeNull();
    expect(out!.kind).toBe('refused');
    expect((out as { kind: 'refused'; text: string }).text).toBe(
      'The model declined to produce a structured response.',
    );
  });

  // ── Anthropic byte-identity / legitimate-retry guard ──────────────────────
  // The helper returns null (no short-circuit) on EVERY non-refusal stopReason —
  // including a benign EMPTY completion — so the existing JSON.parse → validate →
  // retry behavior runs exactly as before, preserving the full retry budget. This
  // holds regardless of provider — the helper has no provider/runtime input.

  it('an EMPTY result on a clean stopReason → null (retry budget PRESERVED, not stolen)', () => {
    // adversarial #1 regression: empty text on a benign stopReason must NOT
    // short-circuit — attempt 0 empties, a LATER attempt can still succeed.
    expect(epilogueRefusalShortCircuit('completed', '')).toBeNull();
  });

  it('an EMPTY result on a null stopReason (Anthropic end_turn-equivalent) → null', () => {
    expect(epilogueRefusalShortCircuit(null, '')).toBeNull();
  });

  it('whitespace-only text on a clean stopReason → null (still flows into the retry loop)', () => {
    expect(epilogueRefusalShortCircuit('completed', '   \n  ')).toBeNull();
  });

  it('valid JSON on a clean completion → null (happy path UNCHANGED, falls through to parse)', () => {
    expect(epilogueRefusalShortCircuit('completed', '{"answer":42}')).toBeNull();
  });

  it('nonempty INVALID JSON on a clean completion → null (legitimate retry path UNCHANGED)', () => {
    expect(epilogueRefusalShortCircuit('completed', 'not json at all')).toBeNull();
  });

  it('a partial (max_output_tokens) nonempty result → null (still parses/retries, not a refusal)', () => {
    expect(epilogueRefusalShortCircuit('max_output_tokens', '{"partial":')).toBeNull();
  });

  it('a null stopReason with nonempty text → null (Anthropic end_turn-equivalent unchanged)', () => {
    expect(epilogueRefusalShortCircuit(null, '{"ok":true}')).toBeNull();
  });
});
