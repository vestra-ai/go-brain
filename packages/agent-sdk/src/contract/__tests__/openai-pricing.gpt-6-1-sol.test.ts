import { describe, it, expect } from 'vitest';
import { OPENAI_TOKEN_PRICING, priceForModel, priceForModelAtPromptSize } from '../openai-pricing.js';
import { priceUsageUsd } from '../usage-pricing.js';
import { computeOpenAIResponsesCostUsd } from '../../transports/openai-responses-pricing.js';
import { computeAnthropicCostUsd, resolveFamilyRate } from '../../engine/native-pricing.js';
import type { NormalizedUsage } from '../../engine/transport.js';

// GPT-6.1 Sol (2026-09-29), verified 2026-09-30 against
// developers.openai.com/api/docs/models/gpt-6.1-sol and /docs/pricing: GPT-6 Sol's
// card except CACHED input, which halves to $0.10; >272K (exclusive) swaps the whole
// request to $4 / $0.20 / $5 write / $15.
const M = 1_000_000;
const buckets = (r: { inputPerMTok: number; cachedInputPerMTok: number; cacheWriteInputPerMTok?: number; outputPerMTok: number }) =>
  [r.inputPerMTok, r.cachedInputPerMTok, r.cacheWriteInputPerMTok, r.outputPerMTok];

describe('openai-pricing — GPT-6.1 Sol', () => {
  it('carries its verified card, own sources, and the exclusive >272K tier', () => {
    const row = OPENAI_TOKEN_PRICING['gpt-6.1-sol'];
    expect(buckets(row)).toEqual([2, 0.1, 2.5, 10]);
    expect(row).toMatchObject({
      premiumInputPerMTok: 4,
      premiumCachedInputPerMTok: 0.2,
      premiumCacheWriteInputPerMTok: 5,
      premiumOutputPerMTok: 15,
      premiumThresholdExclusive: true,
      verifiedAt: '2026-09-30',
    });
    expect(row.sources).toEqual(['https://developers.openai.com/api/docs/models/gpt-6.1-sol', 'https://developers.openai.com/api/docs/pricing']);
  });

  it('272,000 is standard (the row itself), 272,001 swaps all four buckets', () => {
    const row = OPENAI_TOKEN_PRICING['gpt-6.1-sol'];
    expect(priceForModelAtPromptSize('gpt-6.1-sol', 272_000)).toBe(row);
    expect(buckets(priceForModelAtPromptSize('gpt-6.1-sol', 272_001))).toEqual([4, 0.2, 5, 15]);
  });

  it('differs from GPT-6 Sol ONLY in cached input, and the 6 Sol row stays for history', () => {
    const sol61 = OPENAI_TOKEN_PRICING['gpt-6.1-sol'];
    const sol6 = OPENAI_TOKEN_PRICING['gpt-6-sol'];
    expect(buckets(sol6)).toEqual([2, 0.2, 2.5, 10]);
    expect(sol6.premiumCachedInputPerMTok).toBe(0.4);
    expect(sol61.cachedInputPerMTok).toBe(sol6.cachedInputPerMTok / 2);
    expect(sol61.premiumCachedInputPerMTok).toBe(sol6.premiumCachedInputPerMTok! / 2);
    for (const k of ['inputPerMTok', 'outputPerMTok', 'cacheWriteInputPerMTok', 'premiumInputPerMTok', 'premiumCacheWriteInputPerMTok', 'premiumOutputPerMTok'] as const) {
      expect(sol61[k], k).toBe(sol6[k]);
    }
  });

  it('the runner claim and the server pricer bill a cached round at $0.10, never 6 Sol\'s $0.20', () => {
    const usage: NormalizedUsage = { inputTokens: 1_000, outputTokens: 2_000, cacheReadInputTokens: 100_000, cacheCreationInputTokens: 4_000 };
    const expected = (1_000 * 2 + 100_000 * 0.1 + 4_000 * 2.5 + 2_000 * 10) / M;
    const claim = computeOpenAIResponsesCostUsd(usage, 'gpt-6.1-sol');
    expect(claim).toBeCloseTo(expected, 12);
    const server = priceUsageUsd('gpt-6.1-sol', { inputTokens: 1_000, outputTokens: 2_000, cacheReadTokens: 100_000, cacheWriteTokens: 4_000 });
    expect(server?.usd).toBeCloseTo(expected, 12);
    expect(computeOpenAIResponsesCostUsd(usage, 'gpt-6-sol')).toBeGreaterThan(claim);
  });

  it('native-pricing gives it no Anthropic family and prices its desync arm off its OWN row', () => {
    expect(resolveFamilyRate('gpt-6.1-sol').isDefault).toBe(true);
    expect(computeAnthropicCostUsd({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: M }, 'gpt-6.1-sol')).toBeCloseTo(0.1, 12);
    expect(computeAnthropicCostUsd({ input_tokens: M, output_tokens: 0 }, 'gpt-6.1-sol')).toBeCloseTo(priceForModel('gpt-6.1-sol').inputPerMTok, 12);
  });
});
