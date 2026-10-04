import { describe, it, expect } from 'vitest';
import { priceForModel, priceForModelAtPromptSize } from '../openai-pricing.js';
import { computeOpenAIResponsesCostUsd } from '../../transports/openai-responses-pricing.js';
import type { NormalizedUsage } from '../../engine/transport.js';

const M = 1_000_000;

describe('premium-tier pricing — grok-4.5 whole-request repricing at 200K prompt', () => {
  it('below the threshold: standard rates (cached $0.30 since the 08-13 re-price)', () => {
    const r = priceForModelAtPromptSize('grok-4.5', 199_999);
    expect(r.inputPerMTok).toBe(2);
    expect(r.cachedInputPerMTok).toBe(0.3);
    expect(r.outputPerMTok).toBe(6);
  });

  it('AT the threshold: ALL THREE rates swap to premium (xAI: "reaches 200k" is inclusive)', () => {
    const r = priceForModelAtPromptSize('grok-4.5', 200_000);
    expect(r.inputPerMTok).toBe(4);
    expect(r.cachedInputPerMTok).toBe(0.6);
    expect(r.outputPerMTok).toBe(12);
  });

  it('above the threshold: premium rates', () => {
    expect(priceForModelAtPromptSize('grok-4.5', 350_000).outputPerMTok).toBe(12);
  });

  it('grok-4.6 carries the same standard→premium swap (cached stays $0.50/$1.00 — only 4.5 was re-priced)', () => {
    const std = priceForModelAtPromptSize('grok-4.6', 199_999);
    expect(std.inputPerMTok).toBe(2);
    expect(std.cachedInputPerMTok).toBe(0.5);
    expect(std.outputPerMTok).toBe(6);
    const prem = priceForModelAtPromptSize('grok-4.6', 200_000);
    expect(prem.inputPerMTok).toBe(4);
    expect(prem.cachedInputPerMTok).toBe(1);
    expect(prem.outputPerMTok).toBe(12);
  });

  it('grok-4.7 carries the 4.6 card exactly: $2/$0.50/$6, then $4/$1/$12 from a 200K prompt', () => {
    const std = priceForModelAtPromptSize('grok-4.7', 199_999);
    expect(std.inputPerMTok).toBe(2);
    expect(std.cachedInputPerMTok).toBe(0.5);
    expect(std.outputPerMTok).toBe(6);
    const prem = priceForModelAtPromptSize('grok-4.7', 200_000);
    expect(prem.inputPerMTok).toBe(4);
    expect(prem.cachedInputPerMTok).toBe(1);
    expect(prem.outputPerMTok).toBe(12);
  });

  it('models WITHOUT premium fields are byte-identical at any prompt size', () => {
    // gpt-5.5 carries the registry's 272K threshold but no premium pricing row ⇒ inert.
    expect(priceForModelAtPromptSize('gpt-5.5', 400_000)).toEqual(priceForModel('gpt-5.5'));
    expect(priceForModelAtPromptSize('muse-spark-1.1', 900_000)).toEqual(priceForModel('muse-spark-1.1'));
  });

  it('unknown ids keep the fail-closed gpt-5.6-sol fallback, unaffected by prompt size', () => {
    expect(priceForModelAtPromptSize('gpt-nonesuch-9', 999_999)).toEqual(priceForModel('gpt-nonesuch-9'));
  });

  it('computeOpenAIResponsesCostUsd bills the WHOLE request at premium once input ≥ 200K', () => {
    // 250K total prompt: 150K plain + 100K cached, 10K output. Premium (total
    // ≥ 200K): uncached 150K@$4, cached 100K@$0.60, output 10K@$12. EXCLUSIVE
    // shape (2026-08-04): inputTokens is the plain remainder.
    const usage: NormalizedUsage = { inputTokens: 150_000, outputTokens: 10_000, cacheReadInputTokens: 100_000 };
    const expected = (150_000 * 4) / M + (100_000 * 0.6) / M + (10_000 * 12) / M;
    expect(computeOpenAIResponsesCostUsd(usage, 'grok-4.5')).toBeCloseTo(expected, 10);
  });

  it('computeOpenAIResponsesCostUsd stays standard just below the threshold', () => {
    const usage: NormalizedUsage = { inputTokens: 199_999, outputTokens: 1_000, cacheReadInputTokens: 0 };
    const expected = (199_999 * 2) / M + (1_000 * 6) / M;
    expect(computeOpenAIResponsesCostUsd(usage, 'grok-4.5')).toBeCloseTo(expected, 10);
  });

  it('non-premium models bill exactly as before (regression lock)', () => {
    // 300K total prompt = 100K plain + 200K cached (exclusive shape).
    const usage: NormalizedUsage = { inputTokens: 100_000, outputTokens: 5_000, cacheReadInputTokens: 200_000 };
    const expected = (100_000 * 1.25) / M + (200_000 * 0.15) / M + (5_000 * 4.25) / M;
    expect(computeOpenAIResponsesCostUsd(usage, 'muse-spark-1.1')).toBeCloseTo(expected, 10);
  });

  it('cache WRITES bill at the SWAPPED premium input rate (grok has no separate write rate — fallback follows the swap)', () => {
    // 250K total prompt: 100K plain + 50K cached reads + 100K cache writes;
    // 1K output. Premium active (total 250K ≥ 200K): plain 100K@$4, reads
    // 50K@$0.60, writes 100K@(cacheWriteInputPerMTok ?? premium input $4),
    // output 1K@$12. A fallback to the STANDARD $2 input rate here would
    // halve the write charge. EXCLUSIVE shape: inputTokens = plain remainder.
    const usage: NormalizedUsage = {
      inputTokens: 100_000,
      outputTokens: 1_000,
      cacheReadInputTokens: 50_000,
      cacheCreationInputTokens: 100_000,
    };
    const expected = (100_000 * 4) / M + (50_000 * 0.6) / M + (100_000 * 4) / M + (1_000 * 12) / M;
    expect(computeOpenAIResponsesCostUsd(usage, 'grok-4.5')).toBeCloseTo(expected, 10);
  });
});
