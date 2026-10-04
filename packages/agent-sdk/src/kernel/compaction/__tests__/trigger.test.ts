/**
 * COMPACTION_V2 — the trigger's two bounds, as a table.
 *
 * The defect these pin: the pre-V2 trigger fired at 80% of the CONTEXT WINDOW, so
 * on the 1M-window models we actually run it sat at ~800k, and a long task spent
 * its whole life re-reading half a million tokens a round. The preferred term
 * moves the trigger to the model's declared preferred input ceiling (context
 * hygiene, latency, headroom — NOT a price tier: Anthropic bills the full 1M at
 * standard rate); the window ceiling stays the hard bound; a model with no
 * declared ceiling is untouched.
 */
import { describe, it, expect } from 'vitest';
import { resolveTriggerPoint, DEFAULT_TRIGGER_POLICY, measuredInputTokens } from '../trigger.js';

describe('resolveTriggerPoint — the preferred input ceiling is the first bound', () => {
  it('claude-sonnet-5 (1M window, 200k preferred): fires at the PREFERRED bound, not 800k', () => {
    const point = resolveTriggerPoint('claude-sonnet-5', DEFAULT_TRIGGER_POLICY);
    expect(point.bound).toBe('preferred');
    expect(point.triggerTokens).toBe(180_000); // 200k x 0.9
    expect(point.ceilingTokens).toBe(800_000); // the pre-V2 trigger, now the ceiling
    expect(point.preferredTokens).toBe(180_000);
  });

  it('claude-fable-5 / claude-opus-5 (1M, 200k preferred) land on the same bound', () => {
    for (const model of ['claude-fable-5', 'claude-opus-5', 'claude-mythos-5']) {
      const point = resolveTriggerPoint(model, DEFAULT_TRIGGER_POLICY);
      expect(point.bound, model).toBe('preferred');
      expect(point.triggerTokens, model).toBe(180_000);
    }
  });

  it('gpt-5.6 family (1.05M window, 272k preferred): fires at 272k x 0.9', () => {
    const point = resolveTriggerPoint('gpt-5.6-sol', DEFAULT_TRIGGER_POLICY);
    expect(point.bound).toBe('preferred');
    expect(point.triggerTokens).toBeCloseTo(244_800, 6);
    expect(point.ceilingTokens).toBeCloseTo(840_000, 6);
  });

  it('claude-haiku-4-5 (200k window, NO declared ceiling): unchanged 80% ceiling, no preferred term', () => {
    const point = resolveTriggerPoint('claude-haiku-4-5', DEFAULT_TRIGGER_POLICY);
    expect(point.bound).toBe('ceiling');
    expect(point.triggerTokens).toBe(160_000);
    expect(point.preferredTokens).toBeUndefined();
  });

  it('the Fireworks OSS lane (glm-5.2, deepseek-v4-pro — no declared ceiling) keeps the ceiling', () => {
    for (const model of ['glm-5.2', 'deepseek-v4-pro']) {
      const point = resolveTriggerPoint(model, DEFAULT_TRIGGER_POLICY);
      expect(point.bound, model).toBe('ceiling');
      expect(point.preferredTokens, model).toBeUndefined();
    }
  });

  it('an unknown model id (200k fallback, no declared ceiling) keeps the ceiling — never a bound at zero', () => {
    const point = resolveTriggerPoint('some-model-we-have-not-seeded', DEFAULT_TRIGGER_POLICY);
    expect(point.bound).toBe('ceiling');
    expect(point.triggerTokens).toBe(160_000);
    expect(point.triggerTokens).toBeGreaterThan(0);
  });

  it('takes the MIN: a low thresholdPct makes the ceiling win even on a model with a preferred bound', () => {
    const point = resolveTriggerPoint('claude-sonnet-5', { ...DEFAULT_TRIGGER_POLICY, thresholdPct: 0.1 });
    expect(point.bound).toBe('ceiling');
    expect(point.triggerTokens).toBe(100_000);
    expect(point.preferredTokens).toBe(180_000); // present but not the binding bound
  });

  it('can only ever move the trigger DOWN — never later than the pre-V2 point', () => {
    for (const model of [
      'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5', 'claude-haiku-4-5',
      'gpt-5.6-sol', 'gpt-5.5', 'grok-4.5', 'glm-5.2', 'claude-sonnet-4-5',
    ]) {
      const point = resolveTriggerPoint(model, DEFAULT_TRIGGER_POLICY);
      expect(point.triggerTokens, model).toBeLessThanOrEqual(point.ceilingTokens);
    }
  });

  it('clamps a safety fraction above 1 — firing PAST the preferred ceiling defeats the bound', () => {
    const point = resolveTriggerPoint('claude-sonnet-5', { ...DEFAULT_TRIGGER_POLICY, preferredSafetyPct: 1.5 });
    expect(point.triggerTokens).toBe(200_000); // clamped to 1.0 x the ceiling, not 300k
  });

  it('degenerate policy values fall back instead of producing a NaN trigger', () => {
    for (const bad of [NaN, 0, -1, Infinity]) {
      const point = resolveTriggerPoint('claude-sonnet-5', { thresholdPct: bad, preferredSafetyPct: bad });
      expect(Number.isFinite(point.triggerTokens), String(bad)).toBe(true);
      expect(point.triggerTokens, String(bad)).toBeGreaterThan(0);
    }
  });
});

describe('measuredInputTokens — the provider\'s count outranks the estimate (B1)', () => {
  // c00b391e's shape on gpt-6-luna: the estimate grew +54 a round while the real input grew
  // +7,459 (replayed encrypted reasoning), so the 244.8K trigger first fired at ~352K real.
  const TRIGGER = resolveTriggerPoint('gpt-6-luna', DEFAULT_TRIGGER_POLICY).triggerTokens;

  it('fires from the reported input when the estimate alone would not', () => {
    const estimate = 150_000; // what the chars/4 ledger reads
    const reported = { inputTokens: 238_000, outputTokens: 7_459, appendedTokens: 54 };
    expect(estimate).toBeLessThan(TRIGGER);
    expect(measuredInputTokens(estimate, reported)).toBe(245_513);
    expect(measuredInputTokens(estimate, reported)).toBeGreaterThanOrEqual(TRIGGER);
  });

  it('only ever moves the trigger EARLIER: a lower count never outvotes the estimate', () => {
    expect(measuredInputTokens(200_000, { inputTokens: 90_000, outputTokens: 500, appendedTokens: 100 })).toBe(200_000);
  });

  it('with no count in hand it is the estimate, unchanged', () => {
    expect(measuredInputTokens(123_456)).toBe(123_456);
  });
});
