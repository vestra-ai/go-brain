/**
 * ONE token convention on the wire (prod incident: billing_partial_underbill
 * ~150 false alarms across 30 tasks, 03-04 Aug).
 *
 * OpenAI reports input_tokens INCLUSIVE of the cached/write breakdowns;
 * Anthropic reports them as disjoint additive buckets. NormalizedUsage carried
 * each provider's own convention and documented the difference — but wire
 * consumers (the server's billable-token floor, totalContext) cannot know
 * which convention an event uses, and priced every cache-read token at the
 * full-rate floor. gpt-5.6-luna's cached rate ($0.02/M = 2e-8/tok) sits 5x
 * BELOW the tripwire floor (1e-7/tok), so every cache-heavy Luna turn tripped
 * the alarm while being billed correctly.
 *
 * The fix: NormalizedUsage.inputTokens is EXCLUSIVE everywhere (the Anthropic
 * shape) — producers subtract the breakdowns, cost functions price buckets
 * directly, and the long-context premium tier keys on the TOTAL prompt
 * (input + cached + written), which is what the provider's tier actually
 * prices. These tests pin BOTH the new shape and the money-identity: the same
 * raw provider usage must cost the same dollars as before the convention flip.
 */
import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import { normalizeResponsesUsage } from '../openai-responses-messages.js';
import { normalizeChatUsage } from '../chat-completions-messages.js';
import { computeOpenAIResponsesCostUsd } from '../openai-responses-pricing.js';
import { priceUsageUsd } from '../../contract/usage-pricing.js';

const M = 1_000_000;

/** Raw Responses usage: 2.4M prompt, 2.38M of it cached, 8k written fresh. */
const RAW_LUNA_CACHED: OpenAI.Responses.ResponseUsage = {
  input_tokens: 2_400_000,
  output_tokens: 20_000,
  total_tokens: 2_420_000,
  input_tokens_details: { cached_tokens: 2_380_000, cache_write_tokens: 8_000 } as never,
  output_tokens_details: { reasoning_tokens: 0 },
};

describe('normalizeResponsesUsage — exclusive input convention', () => {
  it('subtracts the cached and written breakdowns out of inputTokens', () => {
    const u = normalizeResponsesUsage(RAW_LUNA_CACHED);
    expect(u.inputTokens).toBe(12_000); // 2.4M − 2.38M cached − 8k written
    expect(u.cacheReadInputTokens).toBe(2_380_000);
    expect(u.cacheCreationInputTokens).toBe(8_000);
    expect(u.outputTokens).toBe(20_000);
  });

  it('clamps at zero when breakdowns exceed input (malformed usage)', () => {
    const u = normalizeResponsesUsage({
      ...RAW_LUNA_CACHED,
      input_tokens: 1_000,
      input_tokens_details: { cached_tokens: 2_000 } as never,
    });
    expect(u.inputTokens).toBe(0);
  });
});

describe('normalizeChatUsage — exclusive input convention', () => {
  it('subtracts cached_tokens out of prompt_tokens', () => {
    const u = normalizeChatUsage({
      prompt_tokens: 100_000,
      completion_tokens: 500,
      total_tokens: 100_500,
      prompt_tokens_details: { cached_tokens: 90_000 },
    } as OpenAI.Completions.CompletionUsage);
    expect(u.inputTokens).toBe(10_000);
    expect(u.cacheReadInputTokens).toBe(90_000);
  });
});

describe('normalizeChatUsage — reasoning-token convention (self-describing via total_tokens)', () => {
  it('xAI shape (reasoning EXCLUDED from completion): folds reasoning into outputTokens', () => {
    // Verbatim grok-4.6 live usage 2026-08-13: total = prompt + completion +
    // reasoning, and xAI's own cost_in_usd_ticks billed 97 output tokens
    // (completion 1 + reasoning 96) at the output rate.
    const u = normalizeChatUsage({
      prompt_tokens: 211,
      completion_tokens: 1,
      total_tokens: 308,
      prompt_tokens_details: { cached_tokens: 128 },
      completion_tokens_details: { reasoning_tokens: 96 },
    } as OpenAI.Completions.CompletionUsage);
    expect(u.outputTokens).toBe(97);
    expect(u.inputTokens).toBe(83);
    expect(u.cacheReadInputTokens).toBe(128);
  });

  it('OpenAI shape (reasoning INCLUDED in completion): no fold, no double-count', () => {
    // total = prompt + completion; reasoning_tokens is a breakdown OF completion.
    const u = normalizeChatUsage({
      prompt_tokens: 1_000,
      completion_tokens: 500,
      total_tokens: 1_500,
      completion_tokens_details: { reasoning_tokens: 400 },
    } as OpenAI.Completions.CompletionUsage);
    expect(u.outputTokens).toBe(500);
  });

  it('no total_tokens or no reasoning: byte-identical to the pre-fold behavior', () => {
    const noTotal = normalizeChatUsage({
      prompt_tokens: 100,
      completion_tokens: 10,
      completion_tokens_details: { reasoning_tokens: 5 },
    } as OpenAI.Completions.CompletionUsage);
    expect(noTotal.outputTokens).toBe(10);
    const noReasoning = normalizeChatUsage({
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
    } as OpenAI.Completions.CompletionUsage);
    expect(noReasoning.outputTokens).toBe(10);
  });
});

describe('money identity — the convention flip changes NO dollar amount', () => {
  // A 2.4M-token prompt is LONG CONTEXT (> 272K), so since 2026-09-29 the fixture prices
  // at OpenAI's documented tier — 2x input and cache (writes included), 1.5x output:
  // luna: in $0.4/M, cached $0.04/M, write $0.5/M, out $1.8/M. That is what OpenAI
  // billed for the incident turns all along; the identity below is about the two
  // CONVENTIONS agreeing, whichever tier the prompt lands in.
  const LONG_CONTEXT_EXPECTED = (12_000 * 0.4 + 2_380_000 * 0.04 + 8_000 * 0.5 + 20_000 * 1.8) / M;

  it('computeOpenAIResponsesCostUsd on the normalized shape equals the hand-priced raw usage (gpt-5.6-luna)', () => {
    const usd = computeOpenAIResponsesCostUsd(normalizeResponsesUsage(RAW_LUNA_CACHED), 'gpt-5.6-luna');
    expect(usd).toBeCloseTo(LONG_CONTEXT_EXPECTED, 10);
  });

  it('the cached-heavy turn prices well above the honest EXCLUSIVE floor — the only floor allowed to gate it', () => {
    const usd = computeOpenAIResponsesCostUsd(normalizeResponsesUsage(RAW_LUNA_CACHED), 'gpt-5.6-luna');
    // The old floor counted all 2.42M tokens at 1e-7 ($0.242; $0.121 at its 0.5 tolerance)
    // against a STANDARD-rate price of $0.076 — and fired. The honest floor is the
    // EXCLUSIVE count (12k + 20k + 8k = 40k × 1e-7 = $0.004); the true long-context
    // price is $0.14, and nothing may gate on the inclusive count.
    expect(usd).toBeCloseTo(0.14, 10);
    expect(usd).toBeGreaterThan(40_000 * 1e-7);
  });

  it('priceUsageUsd (exclusive default) matches computeOpenAIResponsesCostUsd for the same usage', () => {
    const n = normalizeResponsesUsage(RAW_LUNA_CACHED);
    const priced = priceUsageUsd('gpt-5.6-luna', {
      inputTokens: n.inputTokens,
      outputTokens: n.outputTokens,
      cacheReadTokens: n.cacheReadInputTokens ?? 0,
      cacheWriteTokens: n.cacheCreationInputTokens ?? 0,
    });
    expect(priced?.usd).toBeCloseTo(computeOpenAIResponsesCostUsd(n, 'gpt-5.6-luna'), 10);
  });

  it('priceUsageUsd legacy flag reproduces the old inclusive-input math for unupgraded-sandbox events', () => {
    // Old wire shape: input INCLUDES the breakdowns.
    const legacy = priceUsageUsd(
      'gpt-5.6-luna',
      { inputTokens: 2_400_000, outputTokens: 20_000, cacheReadTokens: 2_380_000, cacheWriteTokens: 8_000 },
      { legacyInclusiveInput: true },
    );
    // Same TOTAL prompt (2.4M) either way ⇒ the same long-context tier, the same dollars.
    expect(legacy?.usd).toBeCloseTo(LONG_CONTEXT_EXPECTED, 10);
  });
});

describe('long-context premium tier keys on the TOTAL prompt', () => {
  // grok-4.5: standard in $2/M out $6/M cached $0.30/M; premium (≥ threshold)
  // in $4/M out $12/M cached $0.60/M. A 300k prompt that is 295k cached is
  // still a 300k prompt to the provider's tier — exclusive input (5k) must NOT
  // drop the request back to the standard tier.
  it('a cache-heavy prompt over the threshold prices at the premium tier', () => {
    const priced = priceUsageUsd('grok-4.5', {
      inputTokens: 5_000,
      outputTokens: 1_000,
      cacheReadTokens: 295_000,
      cacheWriteTokens: 0,
    });
    const expected = (5_000 * 4 + 295_000 * 0.6 + 1_000 * 12) / M;
    expect(priced?.usd).toBeCloseTo(expected, 10);
  });
});

// ===========================================================================
// The T0-billing drill's leg-3a substitute: the raw Fireworks wire, pinned.
// ===========================================================================
// The raw usage object is normalized inline in the stream handler and DISCARDED
// — nothing in the repo logs, persists or returns it — so a real pass's raw
// `prompt_tokens` cannot be read back afterwards, and recovering it as
// inputTokens + cacheReadTokens merely inverts the subtraction below (circular,
// and expressly forbidden as a drill leg). This fixture is the durable
// substitute: it states the WIRE numbers as their own literals and pins what the
// normalizer makes of them, so the exclusive/inclusive boundary has a test that
// does not depend on the normalizer to describe its own input.
//
// The key set is the one the repo's own live probe recorded for Fireworks
// (2026-08-12, glm-5p2 + deepseek-v4-flash against an 8.5k repeated prefix):
// {prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details.cached_tokens}
// and nothing write-shaped — see the cache_create_per_mtok = 0 rationale in
// credit.service's DEFAULTS derivation.
describe('normalizeChatUsage — the Fireworks wire, stated as raw numbers', () => {
  it('subtracts the cached share OUT of prompt_tokens exactly once', () => {
    // WIRE (what Fireworks reports): a 30,000-token prompt of which 27,399 were
    // cache hits, and 429 completion tokens.
    const wire = {
      prompt_tokens: 30_000,
      completion_tokens: 429,
      total_tokens: 30_429,
      prompt_tokens_details: { cached_tokens: 27_399 },
    };
    const u = normalizeChatUsage(wire as never);
    // NORMALIZED: inputTokens is the FRESH remainder — the buckets are now
    // disjoint, which is what `input_tokens_exclusive: true` declares downstream.
    expect(u.inputTokens).toBe(2_601); // 30_000 - 27_399, by hand
    expect(u.cacheReadInputTokens).toBe(27_399);
    expect(u.outputTokens).toBe(429);
    expect(u.cacheCreationInputTokens).toBe(0); // Fireworks sells no cache write
    // The identity that makes the convention checkable from the wire alone:
    expect(u.inputTokens + (u.cacheReadInputTokens ?? 0)).toBe(wire.prompt_tokens);
  });

  it('a fully-cached prompt normalizes to ZERO fresh input — the shape that made the bug invisible', () => {
    // This is the reconciler's live shape: cacheRead >= the whole prompt. Priced
    // as INCLUSIVE the fresh term is already 0, so a double subtraction looks
    // exactly like a correct one — which is why nothing caught it for a day.
    const u = normalizeChatUsage({
      prompt_tokens: 27_399,
      completion_tokens: 100,
      total_tokens: 27_499,
      prompt_tokens_details: { cached_tokens: 27_399 },
    } as never);
    expect(u.inputTokens).toBe(0);
    expect(u.cacheReadInputTokens).toBe(27_399);
  });
});
