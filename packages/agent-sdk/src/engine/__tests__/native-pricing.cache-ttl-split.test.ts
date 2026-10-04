import { describe, it, expect } from 'vitest';
import {
  ANTHROPIC_1H_WRITE_INPUT_MULTIPLE,
  computeAnthropicCostUsd,
  denormalizeAnthropicUsage,
  normalizeAnthropicUsage,
  type AnthropicUsage,
} from '../native-pricing.js';
import { priceUsageUsd } from '../../contract/usage-pricing.js';

/**
 * Anthropic bills a 1-hour ephemeral cache write at 2x base input (5-minute: 1.25x), and
 * the model proxy rewrites every breakpoint to a 1h TTL — so the runner's claim must read
 * the wire's `usage.cache_creation` split, not the aggregate. Prod 09-15..09-28: every
 * Claude row in task_turn_usage carried ephemeral_5m = ephemeral_1h = 0 beside 11.9M
 * written tokens (the runner dropped the split at the source), and pricing them at 1h
 * reproduced Anthropic's own cost report within $1.05 over 14 days where the 5m price
 * left a $34.51 residual. Docs leg: platform.claude.com/docs/en/about-claude/pricing,
 * "1h cache writes" = 2x "Base input tokens" on every row (2026-09-29).
 */
const MTOK = 1_000_000;

describe('native-pricing — the 5m/1h cache-write split', () => {
  it('the multiple is 2x, and the 1h write derives from the row input rate ($8 Opus 5.5, $20 Fable 5.1, $4 Sonnet 5.5, $2 Haiku)', () => {
    expect(ANTHROPIC_1H_WRITE_INPUT_MULTIPLE).toBe(2);
    const oneHour: AnthropicUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: MTOK,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: MTOK },
    };
    expect(computeAnthropicCostUsd(oneHour, 'claude-opus-5-5')).toBeCloseTo(8, 6);
    expect(computeAnthropicCostUsd(oneHour, 'claude-fable-5-1')).toBeCloseTo(20, 6);
    expect(computeAnthropicCostUsd(oneHour, 'claude-sonnet-5-5')).toBeCloseTo(4, 6);
    expect(computeAnthropicCostUsd(oneHour, 'claude-haiku-4-5')).toBeCloseTo(2, 6);
  });

  it('a mixed split prices each half at its own multiple and ignores the aggregate', () => {
    // sonnet-5-5: in $2 → 5m write $2.50, 1h write $4.
    const u: AnthropicUsage = {
      input_tokens: 1_000,
      output_tokens: 500,
      cache_read_input_tokens: 10_000,
      cache_creation_input_tokens: 5_000, // aggregate — ignored once the split is present
      cache_creation: { ephemeral_5m_input_tokens: 2_000, ephemeral_1h_input_tokens: 3_000 },
    };
    // (1000*2 + 500*10 + 10000*0.2 + 2000*2.5 + 3000*4) / 1e6
    expect(computeAnthropicCostUsd(u, 'claude-sonnet-5-5')).toBeCloseTo(0.026, 10);
  });

  it('no split (older wire, or the SDK null) → the aggregate prices at the 5m rate, byte-identical to before', () => {
    const plain: AnthropicUsage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 300 };
    const before = computeAnthropicCostUsd(plain, 'claude-opus-5-5');
    expect(computeAnthropicCostUsd({ ...plain, cache_creation: null }, 'claude-opus-5-5')).toBe(before);
    expect(before).toBeCloseTo((100 * 4 + 50 * 20 + 200 * 0.2 + 300 * 5) / MTOK, 12);
  });

  it('the runner claim and the server pricer agree to the last digit on a 100%-1h response (the prod shape)', () => {
    // A prod-shaped round: a dozen uncached tokens, a large cache read, a 1h-only write.
    const wire: AnthropicUsage = {
      input_tokens: 12,
      output_tokens: 2_345,
      cache_read_input_tokens: 181_204,
      cache_creation_input_tokens: 9_876,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 9_876 },
    };
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-4-5']) {
      const claim = computeAnthropicCostUsd(wire, model);
      const server = priceUsageUsd(model, {
        inputTokens: 12,
        outputTokens: 2_345,
        cacheReadTokens: 181_204,
        cacheWriteTokens: 9_876,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 9_876,
      });
      expect(server?.usd, model).toBe(claim);
      // …and the 1h write really is 2x input, not the 5m 1.25x the aggregate would buy.
      expect(claim, model).toBeGreaterThan(computeAnthropicCostUsd({ ...wire, cache_creation: null }, model));
    }
  });

  it('normalize ↔ denormalize round-trips the split, and omits it when the wire had none', () => {
    const wire: AnthropicUsage = {
      input_tokens: 5,
      output_tokens: 7,
      cache_read_input_tokens: 11,
      cache_creation_input_tokens: 13,
      cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 9 },
    };
    const n = normalizeAnthropicUsage(wire);
    expect(n).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      cacheReadInputTokens: 11,
      cacheCreationInputTokens: 13,
      cacheCreation5mInputTokens: 4,
      cacheCreation1hInputTokens: 9,
    });
    expect(denormalizeAnthropicUsage(n)).toEqual(wire);

    const plain = normalizeAnthropicUsage({ input_tokens: 5, output_tokens: 7 });
    expect(plain).toEqual({ inputTokens: 5, outputTokens: 7, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    expect('cacheCreation1hInputTokens' in plain).toBe(false);
    expect('cache_creation' in denormalizeAnthropicUsage(plain)).toBe(false);
  });
});
