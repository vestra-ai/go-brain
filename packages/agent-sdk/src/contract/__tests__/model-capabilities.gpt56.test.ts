import { describe, it, expect } from 'vitest';
import { resolveCapabilities } from '../model-capabilities.js';

// GPT-5.6 family (Sol / Terra / Luna) — GA 2026-07-09. Three variant SEED rows plus
// a bare 'gpt-5.6' alias row that resolves to Sol (OpenAI routes the bare id there).
// The variant rows must precede the alias row in SEED: the resolver matches by
// substring, and 'gpt-5.6' is a substring of all three variant ids.

describe('model-capabilities — GPT-5.6 family (Sol / Terra / Luna)', () => {
  it.each([
    ['gpt-5.6-sol', 'high'],
    ['gpt-5.6-terra', 'medium'],
    // Luna at MAX on the agent lane (founder call 08-06; API honors it — probe
    // echoed the top tier back).
    ['gpt-5.6-luna', 'max'],
  ] as const)('%s resolves canonically (1.05M ctx, 128K out, effort %s)', (id, effort) => {
    const caps = resolveCapabilities(id);
    expect(caps.id).toBe(id);
    expect(caps.provider).toBe('openai');
    expect(caps.contextWindow).toBe(1_050_000);
    expect(caps.maxOutputTokens).toBe(128_000);
    // The whole 5.6 family declares the max ceiling (Sol documented at launch,
    // Luna + Terra live-probed 2026-08-06).
    expect(caps.thinking).toEqual({ mode: 'reasoning', effort, effortCeiling: 'max' });
    expect(caps.premiumInputThreshold).toBe(272_000);
    expect(caps.tokenizerId).toBe('o200k_base');
    expect(caps.available).not.toBe(false); // entitlement verified live 2026-07-10
  });

  it('bare "gpt-5.6" (the documented OpenAI alias) resolves to the Sol row, not the inferred fallback', () => {
    const caps = resolveCapabilities('gpt-5.6');
    expect(caps.id).toBe('gpt-5.6-sol');
    expect(caps.contextWindow).toBe(1_050_000);
  });

  it('the whole family is UNGATED — account entitlement verified live 2026-07-10', () => {
    for (const id of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6']) {
      const caps = resolveCapabilities(id);
      expect(caps, id).not.toHaveProperty('available');
      expect(caps, id).not.toHaveProperty('unavailableReason');
    }
  });

  it('dated snapshots match their family (substring resolver, most-specific-first)', () => {
    expect(resolveCapabilities('gpt-5.6-terra-2026-07-09').id).toBe('gpt-5.6-terra');
    expect(resolveCapabilities('gpt-5.6-luna-2026-08-01').id).toBe('gpt-5.6-luna');
  });

  it('superseded gpt-5.4/5.5 rows remain resolvable for historical-task resume', () => {
    expect(resolveCapabilities('gpt-5.5').id).toBe('gpt-5.5');
    expect(resolveCapabilities('gpt-5.4-mini').id).toBe('gpt-5.4-mini');
  });
});
