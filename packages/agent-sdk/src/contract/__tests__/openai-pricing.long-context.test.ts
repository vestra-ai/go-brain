import { describe, it, expect } from 'vitest';
import { OPENAI_TOKEN_PRICING, priceForModel, priceForModelAtPromptSize } from '../openai-pricing.js';
import { priceUsageUsd } from '../usage-pricing.js';
import { computeOpenAIResponsesCostUsd } from '../../transports/openai-responses-pricing.js';
import type { NormalizedUsage } from '../../engine/transport.js';

/**
 * OpenAI's long-context tier: "Prompts with more than 272K input tokens are priced at 2x
 * input and cache rates and 1.5x output for the full request" (developers.openai.com
 * per-model pages, 2026-09-29; the pricing page lists the four long-context columns per
 * model, cache writes included). Second, independent leg: OpenAI's prod cost lines for
 * gpt-6-luna on 2026-09-26 — "cache writes, long context" $0.151, "cached input, long
 * context" $0.062, "output, long context" $0.011 — equal the task_turn_usage rounds
 * whose total prompt exceeded 272,000, repriced at exactly these multiples, to the cent.
 * The rows at 278,260 and 278,484 are inside that match, so the boundary is 272,000 (not
 * 272×1024 = 278,528), and a prompt of exactly 272,000 is standard ("more than").
 */
const M = 1_000_000;

const ROWS = [
  // id, standard [in, cached, write, out], long-context [in, cached, write, out]
  ['gpt-6-astra', [10, 1, 12.5, 50], [20, 2, 25, 75]],
  ['gpt-6-sol', [2, 0.2, 2.5, 10], [4, 0.4, 5, 15]],
  ['gpt-6-luna', [0.1, 0.01, 0.125, 0.5], [0.2, 0.02, 0.25, 0.75]],
  ['gpt-5.6-sol', [4, 0.4, 5, 20], [8, 0.8, 10, 30]],
  ['gpt-5.6-terra', [2, 0.2, 2.5, 12], [4, 0.4, 5, 18]],
  ['gpt-5.6-luna', [0.2, 0.02, 0.25, 1.2], [0.4, 0.04, 0.5, 1.8]],
] as const;

const buckets = (r: { inputPerMTok: number; cachedInputPerMTok: number; cacheWriteInputPerMTok?: number; outputPerMTok: number }) =>
  [r.inputPerMTok, r.cachedInputPerMTok, r.cacheWriteInputPerMTok, r.outputPerMTok];

describe('openai-pricing — the >272K long-context tier on GPT-6 / GPT-5.6', () => {
  it.each(ROWS)('%s: 272,000 is standard, 272,001 swaps all FOUR buckets (2x / 2x / 2x write / 1.5x out)', (id, std, prem) => {
    const row = OPENAI_TOKEN_PRICING[id];
    expect(row).toMatchObject({
      premiumInputPerMTok: prem[0],
      premiumCachedInputPerMTok: prem[1],
      premiumCacheWriteInputPerMTok: prem[2],
      premiumOutputPerMTok: prem[3],
      premiumThresholdExclusive: true, // OpenAI: "more than 272K"
      verifiedAt: '2026-09-29',
    });
    // Not crossed ⇒ the row itself, by reference (the byte-identical guarantee).
    const at = priceForModelAtPromptSize(id, 272_000);
    expect(at).toBe(row);
    expect(buckets(at)).toEqual([...std]);
    const over = priceForModelAtPromptSize(id, 272_001);
    expect(buckets(over)).toEqual([...prem]);
    // The multiples are exactly the documented ones, derived from the standard row.
    expect(prem[0]).toBeCloseTo(std[0] * 2, 12);
    expect(prem[1]).toBeCloseTo(std[1] * 2, 12);
    expect(prem[2]).toBeCloseTo(std[2] * 2, 12);
    expect(prem[3]).toBeCloseTo(std[3] * 1.5, 12);
  });

  it('the boundary is the documented "more than": 271,999 and 272,000 standard, 272,001 premium; 278,528 (272×1024) is not the cliff', () => {
    expect(priceForModelAtPromptSize('gpt-6-luna', 271_999).inputPerMTok).toBe(0.1);
    expect(priceForModelAtPromptSize('gpt-6-luna', 272_000).inputPerMTok).toBe(0.1);
    expect(priceForModelAtPromptSize('gpt-6-luna', 272_001).inputPerMTok).toBe(0.2);
    // The 09-26 prod row at 278,260 was on OpenAI's long-context line.
    expect(priceForModelAtPromptSize('gpt-6-luna', 278_260).cacheWriteInputPerMTok).toBe(0.25);
  });

  it('xAI keeps its INCLUSIVE "reaches 200k" boundary and its write fallback (byte-identical)', () => {
    for (const id of ['grok-4.5', 'grok-4.6', 'grok-4.7']) expect(OPENAI_TOKEN_PRICING[id].premiumThresholdExclusive, id).toBeUndefined();
    expect(priceForModelAtPromptSize('grok-4.7', 199_999)).toBe(priceForModel('grok-4.7'));
    const prem = priceForModelAtPromptSize('grok-4.7', 200_000);
    expect(prem).toMatchObject({ inputPerMTok: 4, cachedInputPerMTok: 1, outputPerMTok: 12 });
    // No premium write rate on the row ⇒ no write key materializes; the consumers' `?? inputPerMTok` follows the swap.
    expect('cacheWriteInputPerMTok' in prem).toBe(false);
  });

  it('the runner claim and the server pricer bill the same long-context round (a 09-26 prod row)', () => {
    // gpt-6-luna, 2026-09-26: 278,260 total prompt = 3 uncached + 270,159 cached + 8,098
    // written; 2,821 output. Long context (> 272,000): 3@$0.20 + 270,159@$0.02 +
    // 8,098@$0.25 + 2,821@$0.75.
    const usage: NormalizedUsage = { inputTokens: 3, outputTokens: 2_821, cacheReadInputTokens: 270_159, cacheCreationInputTokens: 8_098 };
    const expected = (3 * 0.2 + 270_159 * 0.02 + 8_098 * 0.25 + 2_821 * 0.75) / M;
    const claim = computeOpenAIResponsesCostUsd(usage, 'gpt-6-luna');
    expect(claim).toBeCloseTo(expected, 12);
    const server = priceUsageUsd('gpt-6-luna', { inputTokens: 3, outputTokens: 2_821, cacheReadTokens: 270_159, cacheWriteTokens: 8_098 });
    expect(server?.usd).toBeCloseTo(claim, 12);
    // …and it is the long-context charge, not the standard row's.
    const standard = (3 * 0.1 + 270_159 * 0.01 + 8_098 * 0.125 + 2_821 * 0.5) / M;
    expect(claim).toBeGreaterThan(standard);
  });

  it('a sweep that re-writes its whole 281,605-token prefix bills the write at the long-context $0.25 (the 09-26 sweep row)', () => {
    const usage: NormalizedUsage = { inputTokens: 3, outputTokens: 1_024, cacheReadInputTokens: 0, cacheCreationInputTokens: 281_602 };
    expect(computeOpenAIResponsesCostUsd(usage, 'gpt-6-luna')).toBeCloseTo((3 * 0.2 + 281_602 * 0.25 + 1_024 * 0.75) / M, 12);
  });

  it('a round at exactly the boundary bills standard on both lanes', () => {
    const usage: NormalizedUsage = { inputTokens: 0, outputTokens: 100, cacheReadInputTokens: 270_000, cacheCreationInputTokens: 2_000 };
    const expected = (270_000 * 0.01 + 2_000 * 0.125 + 100 * 0.5) / M;
    expect(computeOpenAIResponsesCostUsd(usage, 'gpt-6-luna')).toBeCloseTo(expected, 12);
    expect(priceUsageUsd('gpt-6-luna', { inputTokens: 0, outputTokens: 100, cacheReadTokens: 270_000, cacheWriteTokens: 2_000 })?.usd).toBeCloseTo(expected, 12);
  });

  it('the legacy inclusive convention keys the tier on the same TOTAL prompt (old-bundle events reprice identically)', () => {
    // Inclusive wire: input_tokens 278,260 CONTAINS the 270,159 cached + 8,098 written.
    const server = priceUsageUsd(
      'gpt-6-luna',
      { inputTokens: 278_260, outputTokens: 2_821, cacheReadTokens: 270_159, cacheWriteTokens: 8_098 },
      { legacyInclusiveInput: true },
    );
    expect(server?.usd).toBeCloseTo((3 * 0.2 + 270_159 * 0.02 + 8_098 * 0.25 + 2_821 * 0.75) / M, 12);
  });
});
