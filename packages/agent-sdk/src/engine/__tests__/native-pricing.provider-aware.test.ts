import { describe, it, expect, vi } from 'vitest';
import { anthropicPricesAtFailClosed, computeAnthropicCostUsd, resolveFamilyRate } from '../native-pricing.js';

/**
 * Provider-aware native pricing.
 *
 * `native-pricing` is `AnthropicMessagesTransport`'s billing source. If a non-
 * anthropic model (e.g. gpt-5.5) is ever priced through the Anthropic transport
 * (a transport/model desync), the legacy 3-family map fell to DEFAULT_RATE = the
 * Sonnet tier ($3 in / $15 out) and UNDER-charged the customer vs the correct
 * OpenAI rates ($5 in / $30 out). The fix routes non-anthropic ids to the OpenAI
 * rate card via `resolveCapabilities(model).provider`, keeping anthropic
 * (opus/haiku/sonnet) byte-identical.
 */
describe('native-pricing: provider-aware rates (gpt billed at OpenAI, not Sonnet)', () => {
  it('gpt-5.5 prices 1M input tokens at $5 (OpenAI rate), NOT $3 (Sonnet DEFAULT)', () => {
    const usd = computeAnthropicCostUsd({ input_tokens: 1_000_000, output_tokens: 0 }, 'gpt-5.5');
    expect(usd).toBeCloseTo(5.0, 5);
    expect(usd).not.toBeCloseTo(3.0, 5);
  });

  it('gpt-5.5 prices 1M output tokens at $30 (OpenAI rate), NOT $15 (Sonnet DEFAULT)', () => {
    const usd = computeAnthropicCostUsd({ input_tokens: 0, output_tokens: 1_000_000 }, 'gpt-5.5');
    expect(usd).toBeCloseTo(30.0, 5);
    expect(usd).not.toBeCloseTo(15.0, 5);
  });

  it('gpt-5.4 prices at the gpt-5.4 OpenAI tier ($2.5 in / $15 out)', () => {
    const inUsd = computeAnthropicCostUsd({ input_tokens: 1_000_000, output_tokens: 0 }, 'gpt-5.4');
    const outUsd = computeAnthropicCostUsd({ input_tokens: 0, output_tokens: 1_000_000 }, 'gpt-5.4');
    expect(inUsd).toBeCloseTo(2.5, 5);
    expect(outUsd).toBeCloseTo(15, 5);
  });

  it('gpt-5.4-mini prices at the mini OpenAI tier ($0.75 in / $4.5 out)', () => {
    const inUsd = computeAnthropicCostUsd({ input_tokens: 1_000_000, output_tokens: 0 }, 'gpt-5.4-mini');
    const outUsd = computeAnthropicCostUsd({ input_tokens: 0, output_tokens: 1_000_000 }, 'gpt-5.4-mini');
    expect(inUsd).toBeCloseTo(0.75, 5);
    expect(outUsd).toBeCloseTo(4.5, 5);
  });

  it('gpt cache reads use the OpenAI cached-input rate (gpt-5.5 = $0.5/Mtok)', () => {
    const usd = computeAnthropicCostUsd(
      { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 },
      'gpt-5.5',
    );
    expect(usd).toBeCloseTo(0.5, 5);
  });

  it('NO "[native-pricing] Unknown model family" warn fires for a known gpt id', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    computeAnthropicCostUsd({ input_tokens: 100_000, output_tokens: 100_000 }, 'gpt-5.5');
    const unknownWarns = warnSpy.mock.calls.filter((args) =>
      String(args[0]).includes('Unknown model family'),
    );
    expect(unknownWarns).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('a GLM (fireworks) id routes to its exact Fireworks rate card ($1.40 in / $4.40 out), NOT the Sonnet default', () => {
    const inUsd = computeAnthropicCostUsd({ input_tokens: 1_000_000, output_tokens: 0 }, 'glm-5.2');
    const outUsd = computeAnthropicCostUsd({ input_tokens: 0, output_tokens: 1_000_000 }, 'glm-5.2');
    expect(inUsd).toBeCloseTo(1.4, 5);
    expect(outUsd).toBeCloseTo(4.4, 5);
    expect(inUsd).not.toBeCloseTo(3.0, 5); // never the Anthropic Sonnet DEFAULT_RATE
  });

  it('GLM cache reads bill at the discounted Fireworks cached rate ($0.14/M), not the full input rate', () => {
    const usd = computeAnthropicCostUsd(
      { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 },
      'glm-5.2',
    );
    expect(usd).toBeCloseTo(0.14, 5);
  });
});

/**
 * Claude arm safety: opus/haiku/sonnet substring matching stays FIRST and
 * byte-unchanged. A claude-* id MUST return the exact same rate as before the
 * provider-aware branch was added.
 */
describe('native-pricing: anthropic family rates', () => {
  it('claude-sonnet-5 prices $2 in / $10 out / $0.2 read / $2.5 write (the 1.5× overcharge fix)', () => {
    // Sonnet 5's $2/$10 launch price was made PERMANENT (the 2026-09-01 rise to
    // $3/$15 was cancelled) — verified 2026-08-13 vs
    // https://platform.claude.com/docs/en/about-claude/pricing. The old family-row
    // assertion here pinned the $3/$15 rate as "can never UNDER-charge"; once the
    // intro price became standard that was a straight 1.5× overcharge on every turn.
    expect(computeAnthropicCostUsd({ input_tokens: 1_000_000, output_tokens: 0 }, 'claude-sonnet-5')).toBeCloseTo(2, 5);
    expect(computeAnthropicCostUsd({ input_tokens: 0, output_tokens: 1_000_000 }, 'claude-sonnet-5')).toBeCloseTo(10, 5);
    expect(
      computeAnthropicCostUsd({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }, 'claude-sonnet-5'),
    ).toBeCloseTo(0.2, 5);
    expect(
      computeAnthropicCostUsd({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 }, 'claude-sonnet-5'),
    ).toBeCloseTo(2.5, 5);
  });

  it('a dated sonnet-5 id rides the same $2/$10 row', () => {
    expect(computeAnthropicCostUsd({ input_tokens: 1_000_000, output_tokens: 0 }, 'claude-sonnet-5-20260401')).toBeCloseTo(2, 5);
  });

  it('claude-sonnet-4-6 still prices $3 in / $15 out', () => {
    expect(computeAnthropicCostUsd({ input_tokens: 1_000_000, output_tokens: 0 }, 'claude-sonnet-4-6')).toBeCloseTo(3, 5);
    expect(computeAnthropicCostUsd({ input_tokens: 0, output_tokens: 1_000_000 }, 'claude-sonnet-4-6')).toBeCloseTo(15, 5);
  });

  it('sonnet-4-5 and 3-5-sonnet ids do NOT match the sonnet-5 token (stay $3/$15)', () => {
    // The version digits sit differently in both ('sonnet-4-5', '3-5-sonnet'), so
    // the 'sonnet-5' substring never fires for them — regression guard for the split.
    expect(computeAnthropicCostUsd({ input_tokens: 1_000_000, output_tokens: 0 }, 'claude-sonnet-4-5')).toBeCloseTo(3, 5);
    expect(computeAnthropicCostUsd({ input_tokens: 1_000_000, output_tokens: 0 }, 'claude-3-5-sonnet-20241022')).toBeCloseTo(3, 5);
  });

  it('claude-opus-4-8 prices at the current Opus 4.8 rates ($5 in / $25 out / $0.5 cacheRead / $6.25 cacheWrite)', () => {
    // Opus 4.8 published rates (was the retired Opus 4.1 $15/$75/$1.5/$18.75 = 3× too high).
    // https://platform.claude.com/docs/en/about-claude/pricing
    expect(computeAnthropicCostUsd({ input_tokens: 1_000_000, output_tokens: 0 }, 'claude-opus-4-8')).toBeCloseTo(5, 5);
    expect(computeAnthropicCostUsd({ input_tokens: 0, output_tokens: 1_000_000 }, 'claude-opus-4-8')).toBeCloseTo(25, 5);
    expect(
      computeAnthropicCostUsd({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }, 'claude-opus-4-8'),
    ).toBeCloseTo(0.5, 5);
    expect(
      computeAnthropicCostUsd({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 }, 'claude-opus-4-8'),
    ).toBeCloseTo(6.25, 5);
  });

  it('an opus turn now costs exactly 1/3 of the retired Opus 4.1 rates (the 3× overcharge regression)', () => {
    // Mixed-usage turn exercising all four rate components at once.
    const usage = {
      input_tokens: 100_000,
      output_tokens: 20_000,
      cache_read_input_tokens: 80_000,
      cache_creation_input_tokens: 10_000,
    };
    const usd = computeAnthropicCostUsd(usage, 'claude-opus-4-8');
    // NEW rates 5/25/0.5/6.25 are each exactly 1/3 of the OLD 15/75/1.5/18.75,
    // so the whole linear cost is exactly 1/3 of the old cost.
    const OLD_RATES = { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 };
    const oldCost =
      (usage.input_tokens * OLD_RATES.in +
        usage.output_tokens * OLD_RATES.out +
        usage.cache_read_input_tokens * OLD_RATES.cacheRead +
        usage.cache_creation_input_tokens * OLD_RATES.cacheWrite) /
      1_000_000;
    expect(usd).toBeCloseTo(oldCost / 3, 9);
  });

  it('claude-haiku-4-5 still prices $1 in / $5 out', () => {
    expect(computeAnthropicCostUsd({ input_tokens: 1_000_000, output_tokens: 0 }, 'claude-haiku-4-5')).toBeCloseTo(1, 5);
    expect(computeAnthropicCostUsd({ input_tokens: 0, output_tokens: 1_000_000 }, 'claude-haiku-4-5')).toBeCloseTo(5, 5);
  });

  it('an unknown ANTHROPIC-inferred family still fails closed to the Sonnet default ($3/$15)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // No provider prefix → inferProvider defaults to anthropic → keeps the legacy Sonnet fail-closed.
    const inUsd = computeAnthropicCostUsd({ input_tokens: 1_000_000, output_tokens: 0 }, 'some-future-anthropic-model');
    const outUsd = computeAnthropicCostUsd({ input_tokens: 0, output_tokens: 1_000_000 }, 'some-future-anthropic-model');
    expect(inUsd).toBeCloseTo(3, 5);
    expect(outUsd).toBeCloseTo(15, 5);
    vi.restoreAllMocks();
  });
});

/**
 * resolveFamilyRate — the introspection the pricing-coverage tripwire needs.
 * A named-family match and the fail-closed DEFAULT are NUMERICALLY identical for
 * Sonnet ($3/$15 === DEFAULT_RATE), so a coverage test cannot tell "matched a real
 * family" from "fell through" by comparing rate values. This helper exposes the
 * classification itself (`isDefault`) without changing rateFor's behavior.
 */
describe('native-pricing: resolveFamilyRate introspection', () => {
  it.each([
    ['claude-opus-4-8', 'opus', 5, 25],
    ['claude-opus-4-5', 'opus', 5, 25],
    ['claude-sonnet-5', 'sonnet5', 2, 10],
    ['claude-haiku-4-5', 'haiku', 1, 5],
    ['claude-fable-5', 'fable', 10, 50],
  ] as const)('%s → family %s (non-default, positive rates)', (id, family, inRate, outRate) => {
    const r = resolveFamilyRate(id);
    expect(r.family).toBe(family);
    expect(r.isDefault).toBe(false);
    expect(r.rate.in).toBe(inRate);
    expect(r.rate.out).toBe(outRate);
  });

  it('Sonnet is NON-default even though its rate is numerically identical to DEFAULT_RATE', () => {
    // The whole reason the helper exists: value-equality can never discriminate here.
    const r = resolveFamilyRate('claude-sonnet-4-6');
    expect(r.family).toBe('sonnet');
    expect(r.isDefault).toBe(false);
    expect(r.rate.in).toBe(3);
  });

  it('Mythos rides the Fable family (shares the $10/$50 tier)', () => {
    const r = resolveFamilyRate('claude-mythos-5');
    expect(r.family).toBe('fable');
    expect(r.isDefault).toBe(false);
    expect(r.rate.in).toBe(10);
  });

  it('an unknown anthropic-inferred id is the DEFAULT sentinel (isDefault true, Sonnet tier)', () => {
    const r = resolveFamilyRate('some-future-anthropic-model');
    expect(r.family).toBe('default');
    expect(r.isDefault).toBe(true);
    expect(r.rate.in).toBe(3);
    expect(r.rate.out).toBe(15);
  });
});

describe('anthropicPricesAtFailClosed — only the desync arm can reach the fail-closed max', () => {
  it('an OpenAI-card id with no row on the card: the max, flagged', () => {
    expect(anthropicPricesAtFailClosed('gpt-not-a-real-model')).toBe(true);
  });

  it('a known OpenAI-card id, a Claude family, and the Sonnet DEFAULT are all real prices', () => {
    expect(anthropicPricesAtFailClosed('gpt-5.5')).toBe(false);
    expect(anthropicPricesAtFailClosed('claude-opus-4-8')).toBe(false);
    // Unknown Anthropic family → Sonnet DEFAULT: a family fallback, never the max.
    expect(anthropicPricesAtFailClosed('claude-not-a-family')).toBe(false);
    expect(anthropicPricesAtFailClosed('gemini-not-a-family')).toBe(false);
  });
});
