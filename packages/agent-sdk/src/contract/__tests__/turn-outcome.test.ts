import { describe, it, expect } from 'vitest';
import { cacheReadRatioFromModelUsage } from '../turn-outcome.js';
import type { ModelUsageEntry, ModelUsageSummary } from '../turn-outcome.js';

/**
 * cacheReadRatioFromModelUsage — the measurement-only prompt-cache hit-rate SLI
 * (TTFT lever). Ratio = Σ cacheReadInputTokens / Σ (inputTokens + cacheReadInputTokens
 * + cacheCreationInputTokens), across every model in the turn. The three input buckets
 * are non-overlapping (mirrors buildModelUsage), so a genuine [0,1] fraction.
 */
function entry(p: Partial<ModelUsageEntry>): ModelUsageEntry {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    ...p,
  };
}

describe('cacheReadRatioFromModelUsage', () => {
  it('omits (undefined) when there is nothing to measure', () => {
    expect(cacheReadRatioFromModelUsage(undefined)).toBeUndefined();
    expect(cacheReadRatioFromModelUsage({})).toBeUndefined();
  });

  it('guards divide-by-zero → 0 when entries exist but carry no prompt tokens', () => {
    const usage: ModelUsageSummary = { 'claude-fable-5': entry({ outputTokens: 42 }) };
    expect(cacheReadRatioFromModelUsage(usage)).toBe(0);
  });

  it('computes a partial-cache ratio over the full prompt (input + read + creation)', () => {
    // reads 1500 / total (500 + 1500 + 0) = 0.75
    const usage: ModelUsageSummary = {
      'claude-fable-5': entry({ inputTokens: 500, cacheReadInputTokens: 1500 }),
    };
    expect(cacheReadRatioFromModelUsage(usage)).toBe(0.75);
  });

  it('counts cache-creation tokens in the denominator (a miss, not a hit)', () => {
    // reads 1000 / total (0 + 1000 + 1000) = 0.5
    const usage: ModelUsageSummary = {
      'claude-fable-5': entry({ cacheReadInputTokens: 1000, cacheCreationInputTokens: 1000 }),
    };
    expect(cacheReadRatioFromModelUsage(usage)).toBe(0.5);
  });

  it('returns 1 for a fully-cached prompt', () => {
    const usage: ModelUsageSummary = {
      'claude-fable-5': entry({ cacheReadInputTokens: 8000 }),
    };
    expect(cacheReadRatioFromModelUsage(usage)).toBe(1);
  });

  it('aggregates across every model in the turn', () => {
    // reads (1000 + 0) / total ((1000 + 1000 + 0) + (2000 + 0 + 0)) = 1000 / 4000 = 0.25
    const usage: ModelUsageSummary = {
      'claude-fable-5': entry({ inputTokens: 1000, cacheReadInputTokens: 1000 }),
      'claude-haiku-4-5': entry({ inputTokens: 2000 }),
    };
    expect(cacheReadRatioFromModelUsage(usage)).toBe(0.25);
  });

  it('rounds to 4 decimals', () => {
    // reads 1 / total (2 + 1 + 0) = 0.3333…
    const usage: ModelUsageSummary = {
      'claude-fable-5': entry({ inputTokens: 2, cacheReadInputTokens: 1 }),
    };
    expect(cacheReadRatioFromModelUsage(usage)).toBe(0.3333);
  });

  it('always yields a value within [0,1]', () => {
    const usage: ModelUsageSummary = {
      'claude-fable-5': entry({ inputTokens: 123, cacheReadInputTokens: 45_678, cacheCreationInputTokens: 9 }),
    };
    const r = cacheReadRatioFromModelUsage(usage)!;
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(1);
  });
});
