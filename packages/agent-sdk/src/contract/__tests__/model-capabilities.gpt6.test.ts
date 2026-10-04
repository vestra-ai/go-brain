import { describe, it, expect } from 'vitest';
import { KNOWN_MODEL_IDS, resolveCapabilities, modelSupportsImageInput, modelSupportsVideoInput } from '../model-capabilities.js';

// GPT-6 Astra — OpenAI's flagship above the GPT-5.6 family. Seeded 2026-09-05 on
// the founder's call; facts verified the same day against the per-model page
// (developers.openai.com/api/docs/models/gpt-6-astra) and live-probed through the
// staging lane (a Responses call answered on our key).

describe('model-capabilities — GPT-6 Astra', () => {
  it('resolves canonically: 1.05M ctx, 128K out, effort high with the max ceiling, 272K bounds', () => {
    const caps = resolveCapabilities('gpt-6-astra');
    expect(caps.id).toBe('gpt-6-astra');
    expect(caps.provider).toBe('openai');
    expect(caps.contextWindow).toBe(1_050_000);
    expect(caps.maxOutputTokens).toBe(128_000);
    // Founder 2026-09-05: Sol's default (high); the top tier stays an opt-in
    // (OPENAI_REASONING_EFFORT) at $50/M output.
    expect(caps.thinking).toEqual({ mode: 'reasoning', effort: 'high', effortCeiling: 'max' });
    expect(caps.premiumInputThreshold).toBe(272_000);
    expect(caps.preferredMaxInputTokens).toBe(272_000);
    expect(caps.tokenizerId).toBe('o200k_base');
    // No wire-dialect override: the provider's house dialect (Responses) applies.
    expect(caps.api).toBeUndefined();
  });

  it('is UNGATED — entitlement live-probed 2026-09-05 through the staging lane', () => {
    const caps = resolveCapabilities('gpt-6-astra');
    expect(caps).not.toHaveProperty('available');
    expect(caps).not.toHaveProperty('unavailableReason');
  });

  it('takes images but not video (the page lists text + image; the watch tool covers video)', () => {
    expect(modelSupportsImageInput('gpt-6-astra')).toBe(true);
    expect(modelSupportsVideoInput('gpt-6-astra')).toBe(false);
  });

  it('is a registry citizen: KNOWN_MODEL_IDS carries it exactly once', () => {
    expect(KNOWN_MODEL_IDS.filter((id) => id === 'gpt-6-astra')).toHaveLength(1);
  });

  it('dated snapshots match the family (substring resolver)', () => {
    expect(resolveCapabilities('gpt-6-astra-2026-08-27').id).toBe('gpt-6-astra');
  });

  it("'gpt-6-astra' is disjoint from every GPT-5.x match — the 5.6 rows still resolve to themselves", () => {
    expect(resolveCapabilities('gpt-5.6-sol').id).toBe('gpt-5.6-sol');
    expect(resolveCapabilities('gpt-5.6').id).toBe('gpt-5.6-sol');
    expect(resolveCapabilities('gpt-5.6-luna').id).toBe('gpt-5.6-luna');
  });
});
