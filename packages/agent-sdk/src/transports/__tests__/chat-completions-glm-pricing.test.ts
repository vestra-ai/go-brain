import { describe, it, expect } from 'vitest';
import { priceForModel } from '../../contract/openai-pricing.js';
import { computeOpenAIResponsesCostUsd } from '../openai-responses-pricing.js';
import type { NormalizedUsage } from '../../engine/transport.js';

/**
 * GLM 5.2 billing on the Fireworks lane. GLM rides the Chat Completions transport,
 * whose computeCostUsd delegates to computeOpenAIResponsesCostUsd → priceForModel.
 *
 * Fireworks serverless Standard pricing (verified 2026-06-30): $1.40 input / $0.14
 * cached / $4.40 output per M. Fireworks uses the OpenAI INCLUDE convention
 * (prompt_tokens includes cached, reported via prompt_tokens_details.cached_tokens),
 * so the SUBTRACTIVE pricer is convention-correct — the cached slice is billed at the
 * discounted cached rate. (Cached dropped from $0.26 on the retired Z.ai lane to $0.14
 * on Fireworks; input + output are unchanged.)
 */
describe('GLM 5.2 pricing (Fireworks)', () => {
  it('priceForModel("glm-5.2") returns the verified Fireworks rate card (cached is discounted, not == input)', () => {
    const p = priceForModel('glm-5.2');
    expect(p.inputPerMTok).toBe(1.4);
    expect(p.outputPerMTok).toBe(4.4);
    expect(p.cachedInputPerMTok).toBe(0.14); // Fireworks published cached-input rate
    expect(p.cachedInputPerMTok).toBeLessThan(p.inputPerMTok); // a real discount
  });

  it('does NOT fail closed to gpt-5.5 ($5/$30) — glm-5.2 has its own exact row', () => {
    const p = priceForModel('glm-5.2');
    expect(p.inputPerMTok).not.toBe(5);
    expect(p.outputPerMTok).not.toBe(30);
  });

  it('more cache hits → LOWER cost (cache is genuinely discounted; no flat full-rate bill)', () => {
    const base = { outputTokens: 0, cacheCreationInputTokens: 0 } as const;
    // EXCLUSIVE shape (2026-08-04): the same 1M-token prompt at three cache
    // ratios — inputTokens is the plain remainder, cacheRead the cached bucket.
    const noCache = { ...base, inputTokens: 1_000_000, cacheReadInputTokens: 0 } as NormalizedUsage;
    const halfCache = { ...base, inputTokens: 500_000, cacheReadInputTokens: 500_000 } as NormalizedUsage;
    const allCache = { ...base, inputTokens: 0, cacheReadInputTokens: 1_000_000 } as NormalizedUsage;
    const a = computeOpenAIResponsesCostUsd(noCache, 'glm-5.2');
    const b = computeOpenAIResponsesCostUsd(halfCache, 'glm-5.2');
    const c = computeOpenAIResponsesCostUsd(allCache, 'glm-5.2');
    expect(b).toBeLessThan(a);
    expect(c).toBeLessThan(b);
    expect(a).toBeCloseTo(1.4, 6); // 1M fully-uncached input @ $1.40/M
    expect(c).toBeCloseTo(0.14, 6); // 1M fully-cached input @ $0.14/M
  });

  it('PARITY: a cache-heavy session shape bills the Fireworks rate to the cent ($0.3328, not $1.4867)', () => {
    // The exact token shape from staging task 40cd8892 + b44a5319 (audit BILL-01),
    // re-priced at the Fireworks cached rate $0.14.
    // EXCLUSIVE shape: total prompt 1,021,706 = 105,930 plain + 915,776 cached.
    const usage: NormalizedUsage = {
      inputTokens: 105_930,
      cacheReadInputTokens: 915_776,
      outputTokens: 12_803,
      cacheCreationInputTokens: 0,
    } as NormalizedUsage;
    // uncached 105,930×1.40 + cached 915,776×0.14 + output 12,803×4.40, all /1e6.
    expect(computeOpenAIResponsesCostUsd(usage, 'glm-5.2')).toBeCloseTo(0.332844, 5);
  });

  it('prices output at the GLM output rate ($4.40/M)', () => {
    const usage: NormalizedUsage = {
      inputTokens: 0,
      outputTokens: 1_000_000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    } as NormalizedUsage;
    expect(computeOpenAIResponsesCostUsd(usage, 'glm-5.2')).toBeCloseTo(4.4, 6);
  });
});
