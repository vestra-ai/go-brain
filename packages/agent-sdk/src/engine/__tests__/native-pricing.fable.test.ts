import { describe, it, expect } from 'vitest';
import { computeAnthropicCostUsd } from '../native-pricing.js';

/**
 * Fable 5 (claude-fable-5) is Anthropic's top tier: $10/1M in, $50/1M out (2× Opus).
 * Its id carries NO opus/sonnet/haiku family token, so the legacy 3-family map fell
 * through to DEFAULT_RATE = the Sonnet tier ($3/$15) and UNDER-charged the customer
 * 3.3×. This pins the dedicated Fable family. Claude Mythos 5 shares Fable's exact
 * pricing/API and the same tokenless-id problem, so it rides the same tier.
 */
describe('native-pricing: Fable 5 tier ($10 in / $50 out) — never the Sonnet DEFAULT', () => {
  const M = (u: Partial<{ input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }>, id: string) =>
    computeAnthropicCostUsd({ input_tokens: 0, output_tokens: 0, ...u }, id);

  it('input 1M → $10 (NOT $3 Sonnet default)', () => {
    expect(M({ input_tokens: 1_000_000 }, 'claude-fable-5')).toBeCloseTo(10.0, 5);
    expect(M({ input_tokens: 1_000_000 }, 'claude-fable-5')).not.toBeCloseTo(3.0, 5);
  });

  it('output 1M → $50 (NOT $15 Sonnet default)', () => {
    expect(M({ output_tokens: 1_000_000 }, 'claude-fable-5')).toBeCloseTo(50.0, 5);
    expect(M({ output_tokens: 1_000_000 }, 'claude-fable-5')).not.toBeCloseTo(15.0, 5);
  });

  it('cache read 1M → $1.0 (0.1× input)', () => {
    expect(M({ cache_read_input_tokens: 1_000_000 }, 'claude-fable-5')).toBeCloseTo(1.0, 5);
  });

  it('cache write 1M → $12.5 (1.25× input, 5m ephemeral)', () => {
    expect(M({ cache_creation_input_tokens: 1_000_000 }, 'claude-fable-5')).toBeCloseTo(12.5, 5);
  });

  it('a dated/aliased Fable id resolves to the Fable tier', () => {
    expect(M({ input_tokens: 1_000_000 }, 'claude-fable-5-20260601')).toBeCloseTo(10.0, 5);
  });

  it('Mythos 5 shares the Fable $10/$50 tier (same-tier under-bill guard)', () => {
    expect(M({ input_tokens: 1_000_000 }, 'claude-mythos-5')).toBeCloseTo(10.0, 5);
    expect(M({ output_tokens: 1_000_000 }, 'claude-mythos-5')).toBeCloseTo(50.0, 5);
  });
});
