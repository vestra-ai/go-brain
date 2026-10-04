import { describe, it, expect } from 'vitest';
import { computeAnthropicCostUsd, resolveFamilyRate } from '../native-pricing.js';
import { priceUsageUsd } from '../../contract/usage-pricing.js';

/**
 * Two versions Anthropic prices OFF their family row (verified 2026-09-22 vs
 * platform.claude.com/docs/en/about-claude/pricing), split the way sonnet-5 is:
 *  - Opus 5.5: $4 / $20, cache read $0.20 (0.05x), 5m write $5, 1h write $8. On the
 *    opus family row it would bill 1.25x input and 2.5x cache reads.
 *  - Fable 5.1 / Mythos 5.1: cache read $0.25 (0.025x) where Fable 5 is $1.00. On
 *    the fable family row every cached token billed 4x its cost.
 * Everything else in each family must stay on its family row.
 */
describe('native-pricing: version-priced splits (opus-5-5, fable-5-1)', () => {
  const cost = (u: Partial<{ input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }>, id: string) =>
    computeAnthropicCostUsd({ input_tokens: 0, output_tokens: 0, ...u }, id);
  const MTOK = 1_000_000;

  it.each(['claude-opus-5-5', 'claude-opus-5-5-20260915', 'claude-opus-5-5[1m]'])(
    '%s bills $4 in / $20 out / $0.20 read / $5 write',
    (id) => {
      expect(cost({ input_tokens: MTOK }, id)).toBeCloseTo(4, 5);
      expect(cost({ output_tokens: MTOK }, id)).toBeCloseTo(20, 5);
      expect(cost({ cache_read_input_tokens: MTOK }, id)).toBeCloseTo(0.2, 5);
      expect(cost({ cache_creation_input_tokens: MTOK }, id)).toBeCloseTo(5, 5);
    },
  );

  it.each(['claude-opus-5', 'claude-opus-4-8', 'claude-opus-5-20260401'])('%s stays on the opus family row ($5/$25/$0.50/$6.25)', (id) => {
    expect(cost({ input_tokens: MTOK }, id)).toBeCloseTo(5, 5);
    expect(cost({ output_tokens: MTOK }, id)).toBeCloseTo(25, 5);
    expect(cost({ cache_read_input_tokens: MTOK }, id)).toBeCloseTo(0.5, 5);
    expect(cost({ cache_creation_input_tokens: MTOK }, id)).toBeCloseTo(6.25, 5);
  });

  it.each(['claude-fable-5-1', 'claude-mythos-5-1', 'claude-fable-5-1[1m]'])('%s reads cache at $0.25, the rest at the Fable tier', (id) => {
    expect(cost({ cache_read_input_tokens: MTOK }, id)).toBeCloseTo(0.25, 5);
    expect(cost({ input_tokens: MTOK }, id)).toBeCloseTo(10, 5);
    expect(cost({ output_tokens: MTOK }, id)).toBeCloseTo(50, 5);
    expect(cost({ cache_creation_input_tokens: MTOK }, id)).toBeCloseTo(12.5, 5);
  });

  it.each(['claude-fable-5', 'claude-mythos-5', 'claude-fable-5-20260601'])('%s still reads cache at the family $1.00', (id) => {
    expect(cost({ cache_read_input_tokens: MTOK }, id)).toBeCloseTo(1.0, 5);
  });

  it('the coverage tripwire names both new families (never the DEFAULT sentinel)', () => {
    expect(resolveFamilyRate('claude-opus-5-5')).toMatchObject({ family: 'opus55', isDefault: false });
    expect(resolveFamilyRate('claude-fable-5-1')).toMatchObject({ family: 'fable51', isDefault: false });
    expect(resolveFamilyRate('claude-mythos-5-1')).toMatchObject({ family: 'fable51', isDefault: false });
    expect(resolveFamilyRate('claude-opus-5').family).toBe('opus');
    expect(resolveFamilyRate('claude-fable-5').family).toBe('fable');
  });

  it.each(['claude-sonnet-5-5', 'claude-sonnet-5-5-20260928', 'claude-sonnet-5-5[1m]'])(
    '%s bills exactly as Sonnet 5, per MTok: 2 in, 10 out, 0.20 read, 2.50 5m write, 4 1h write',
    (id) => {
      expect(cost({ input_tokens: MTOK }, id)).toBeCloseTo(2, 5);
      expect(cost({ output_tokens: MTOK }, id)).toBeCloseTo(10, 5);
      expect(cost({ cache_read_input_tokens: MTOK }, id)).toBeCloseTo(0.2, 5);
      expect(cost({ cache_creation_input_tokens: MTOK }, id)).toBeCloseTo(2.5, 5);
      const oneHour = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: MTOK, cacheWrite1hTokens: MTOK };
      expect(priceUsageUsd(id, oneHour)?.usd).toBeCloseTo(4, 5);
      expect(resolveFamilyRate(id)).toMatchObject({ family: 'sonnet5', isDefault: false });
    },
  );

  it('the 1h write uplift derives from the row input rate: $8 on Opus 5.5, $20 on Fable 5.1', () => {
    const u = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: MTOK, cacheWrite1hTokens: MTOK };
    expect(priceUsageUsd('claude-opus-5-5', u)?.usd).toBeCloseTo(8, 5);
    expect(priceUsageUsd('claude-fable-5-1', u)?.usd).toBeCloseTo(20, 5);
  });
});
