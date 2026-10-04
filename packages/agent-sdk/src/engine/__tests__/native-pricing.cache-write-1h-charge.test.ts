/**
 * BILL_CACHE_WRITE_1H_V1: the 1-hour cache-write PRICE is a charge decision; the 5m/1h split on
 * the row is the record, and it is never flagged.
 *
 * Evidence (prod read-only, 2026-10-04): every prod Claude row in the 7 days to 10-01 (436 rows,
 * 8.63M write tokens) carries ephemeral_5m = ephemeral_1h = 0, because prod runs the 09-28
 * release, before #3990 put the split on the row; on staging every write since 09-30 carries it,
 * 100% at 1 hour (the proxy's TTL). #3990 shipped the record AND a 2x charge unflagged, so the
 * next promote would raise prod's charge with no pricing decision. This gate keeps the charge
 * where prod has always had it until the founder says otherwise, and leaves the truth alone:
 *   - the runner's claim (computeCostUsd / buildModelUsage on both Anthropic transports) and the
 *     server's charges (chargeableTokenUsage) price the split only with the flag on, and agree
 *     in both states;
 *   - the truth pricers (computeAnthropicCostUsd, priceUsageUsd: billing-truth's check against
 *     Anthropic's own cost report, telemetry) price the split always.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  chargeableAnthropicUsage,
  computeAnthropicCostUsd,
  denormalizeAnthropicUsage,
  type AnthropicUsage,
} from '../native-pricing.js';
import { chargeableTokenUsage, priceUsageUsd, type NormalizedTokenUsage } from '../../contract/usage-pricing.js';
import { toAgentUsageWire, tokenUsageFromWire } from '../../contract/usage-wire.js';
import { ReplayTransport } from '../replay/replay-transport.js';
import type { NormalizedUsage } from '../transport.js';

const FLAG = 'BILL_CACHE_WRITE_1H_V1';
afterEach(() => {
  delete process.env[FLAG];
});

const MTOK = 1_000_000;
/** One million 1-hour writes, the prod shape (the proxy writes every breakpoint at 1 hour). */
const ONE_HOUR: AnthropicUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: MTOK,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: MTOK },
};
const NORMALIZED: NormalizedUsage = {
  inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: MTOK,
  cacheCreation5mInputTokens: 0, cacheCreation1hInputTokens: MTOK,
};
const TOKENS: NormalizedTokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: MTOK, cacheWrite5mTokens: 0, cacheWrite1hTokens: MTOK };

describe('the charge follows the flag', () => {
  it('off: the runner claim and the server charge price 1-hour writes at the 5m rate ($5 Opus 5.5, $12.50 Fable 5.1)', () => {
    // Mutation: drop the gate from chargeableAnthropicUsage → $8 / $20.
    expect(computeAnthropicCostUsd(chargeableAnthropicUsage(ONE_HOUR), 'claude-opus-5-5')).toBeCloseTo(5, 9);
    expect(computeAnthropicCostUsd(chargeableAnthropicUsage(ONE_HOUR), 'claude-fable-5-1')).toBeCloseTo(12.5, 9);
    // Mutation: drop the gate from chargeableTokenUsage → $8.
    expect(priceUsageUsd('claude-opus-5-5', chargeableTokenUsage(TOKENS))!.usd).toBeCloseTo(5, 9);
  });

  it("on: both price the write at 2x input ($8 Opus 5.5, $20 Fable 5.1), what the provider bills", () => {
    process.env[FLAG] = 'true';
    expect(computeAnthropicCostUsd(chargeableAnthropicUsage(ONE_HOUR), 'claude-opus-5-5')).toBeCloseTo(8, 9);
    expect(computeAnthropicCostUsd(chargeableAnthropicUsage(ONE_HOUR), 'claude-fable-5-1')).toBeCloseTo(20, 9);
    expect(priceUsageUsd('claude-opus-5-5', chargeableTokenUsage(TOKENS))!.usd).toBeCloseTo(8, 9);
  });

  it("'1' is on too (the billing idiom); any other value is off", () => {
    process.env[FLAG] = '1';
    expect(priceUsageUsd('claude-opus-5-5', chargeableTokenUsage(TOKENS))!.usd).toBeCloseTo(8, 9);
    process.env[FLAG] = 'yes';
    expect(priceUsageUsd('claude-opus-5-5', chargeableTokenUsage(TOKENS))!.usd).toBeCloseTo(5, 9);
  });

  it('the replayed claim follows the flag like the live one', () => {
    const replay = new ReplayTransport([]);
    expect(replay.computeCostUsd(NORMALIZED, 'claude-opus-5-5')).toBeCloseTo(5, 9);
    expect(replay.buildModelUsage(NORMALIZED, 'claude-opus-5-5')['claude-opus-5-5']!.costUSD).toBeCloseTo(5, 9);
    process.env[FLAG] = 'true';
    expect(replay.computeCostUsd(NORMALIZED, 'claude-opus-5-5')).toBeCloseTo(8, 9);
  });

  it('claim and server charge agree in both states, through the wire the server reads', () => {
    for (const flag of [undefined, 'true']) {
      if (flag) process.env[FLAG] = flag;
      else delete process.env[FLAG];
      const claimed = computeAnthropicCostUsd(chargeableAnthropicUsage(denormalizeAnthropicUsage(NORMALIZED)), 'claude-fable-5-1');
      const charged = priceUsageUsd('claude-fable-5-1', chargeableTokenUsage(tokenUsageFromWire(toAgentUsageWire(NORMALIZED))!))!.usd;
      expect(charged).toBeCloseTo(claimed, 12);
    }
  });

  it('a usage with no split is the same object in both states (nothing to gate)', () => {
    const plain: AnthropicUsage = { input_tokens: 5, output_tokens: 6, cache_creation_input_tokens: 7 };
    expect(chargeableAnthropicUsage(plain)).toBe(plain);
    const tokens: NormalizedTokenUsage = { inputTokens: 5, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 7 };
    expect(chargeableTokenUsage(tokens)).toBe(tokens);
  });
});

describe('the record and the truth are never flagged', () => {
  it('flag off: the wire the row is written from still carries the split', () => {
    // Mutation: gate the record instead of the charge → the row loses ephemeral_1h again.
    expect(toAgentUsageWire(NORMALIZED).cache_creation).toEqual({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: MTOK });
  });

  it('flag off: the truth pricers still price the provider bill (billing-truth checks the card against it)', () => {
    expect(computeAnthropicCostUsd(ONE_HOUR, 'claude-opus-5-5')).toBeCloseTo(8, 9);
    expect(priceUsageUsd('claude-opus-5-5', TOKENS)!.usd).toBeCloseTo(8, 9);
  });

  it('the charge helpers never mutate what they are given', () => {
    const u = structuredClone(ONE_HOUR);
    chargeableAnthropicUsage(u);
    expect(u).toEqual(ONE_HOUR);
    const t = { ...TOKENS };
    chargeableTokenUsage(t);
    expect(t).toEqual(TOKENS);
  });
});
