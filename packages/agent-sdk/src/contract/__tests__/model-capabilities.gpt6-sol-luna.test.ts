import { describe, it, expect } from 'vitest';
import { KNOWN_MODEL_IDS, resolveCapabilities, modelSupportsImageInput } from '../model-capabilities.js';

// GPT-6 Sol / Luna (2026-09-23): page-verified facts, live-probed on the staging
// key. Each keeps its 5.6 sibling's effort (no GPT-6 eval yet).
describe('model-capabilities — GPT-6 Sol and Luna', () => {
  it.each([
    ['gpt-6-sol', { mode: 'reasoning', effort: 'high', effortCeiling: 'max' }],
    ['gpt-6-luna', { mode: 'reasoning', effort: 'max', effortCeiling: 'max' }],
  ] as const)('%s resolves to its own row: 1.05M / 128K, 272K bounds, its sibling effort', (id, thinking) => {
    const caps = resolveCapabilities(id);
    expect(caps.id).toBe(id);
    expect(caps.provider).toBe('openai');
    expect(caps.tokenizerId).toBe('o200k_base');
    expect(caps.contextWindow).toBe(1_050_000);
    expect(caps.maxOutputTokens).toBe(128_000);
    expect(caps.premiumInputThreshold).toBe(272_000);
    expect(caps.preferredMaxInputTokens).toBe(272_000);
    expect(caps.thinking).toEqual(thinking);
    expect(caps).not.toHaveProperty('available');
    expect(caps).not.toHaveProperty('supportsToolSearch');
    expect(modelSupportsImageInput(id)).toBe(true);
    expect(KNOWN_MODEL_IDS.filter((k) => k === id)).toHaveLength(1);
  });

  it('no row shadows another: dated ids, Astra and every 5.6 row still resolve to themselves', () => {
    expect(resolveCapabilities('gpt-6-sol-2026-09-23').id).toBe('gpt-6-sol');
    expect(resolveCapabilities('gpt-6-luna-2026-09-23').id).toBe('gpt-6-luna');
    expect(resolveCapabilities('gpt-6-astra').id).toBe('gpt-6-astra');
    expect(resolveCapabilities('gpt-5.6-sol').id).toBe('gpt-5.6-sol');
    expect(resolveCapabilities('gpt-5.6-luna').id).toBe('gpt-5.6-luna');
    expect(resolveCapabilities('gpt-5.6-terra').id).toBe('gpt-5.6-terra');
    expect(resolveCapabilities('gpt-5.6').id).toBe('gpt-5.6-sol');
  });
});
