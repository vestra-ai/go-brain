import { describe, it, expect, afterEach } from 'vitest';
import { KNOWN_MODEL_IDS } from '../model-capabilities.js';
import { isModelPriceable, priceUsageUsd, setRateOverrideLayer } from '../usage-pricing.js';
import { readResponsesUsage } from '../responses-usage.js';
import { embeddingUsd, OPENAI_EMBEDDING_PRICING, OPENAI_WEB_SEARCH_PRICING, webSearchCallUsd } from '../openai-pricing.js';
import { normalizeResponsesUsage } from '../../transports/openai-responses-messages.js';

/**
 * The card's answers the server's config guard and meters lean on (2026-10-03, after prod
 * served gpt-6.1-sol a day before its build could price it).
 */
describe('isModelPriceable — the question every serving-model knob is asked', () => {
  it.each(KNOWN_MODEL_IDS)('%s, a registry id, is priceable (KNOWN ⊆ priceable, so a pick never trips it)', (id) => {
    expect(isModelPriceable(id)).toBe(true);
  });

  it('is exactly the ledger pricer\'s own answer: an id it cannot price is not priceable', () => {
    for (const id of ['gpt-9-imaginary', 'not-a-model', 'claude-nonesuch-9', 'gemini-nonesuch-9']) {
      expect(priceUsageUsd(id, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
      expect(isModelPriceable(id)).toBe(false);
    }
  });

  it('an empty id is not priceable (an unset knob is never "served")', () => {
    expect(isModelPriceable('')).toBe(false);
  });
});

describe('readResponsesUsage — the one reader of a Responses usage payload', () => {
  it('reads the inclusive input and BOTH breakdowns, cache writes included', () => {
    expect(
      readResponsesUsage({
        input_tokens: 10_000,
        output_tokens: 1_000,
        input_tokens_details: { cached_tokens: 6_000, cache_write_tokens: 3_000 },
        output_tokens_details: { reasoning_tokens: 400 },
      }),
    ).toEqual({ inputTokens: 10_000, cachedTokens: 6_000, cacheWriteTokens: 3_000, outputTokens: 1_000, reasoningTokens: 400 });
  });

  it('clamps breakdowns that claim more than the input (written first, then cached out of the rest)', () => {
    expect(readResponsesUsage({ input_tokens: 1_000, input_tokens_details: { cached_tokens: 900, cache_write_tokens: 400 } })).toMatchObject({
      inputTokens: 1_000,
      cacheWriteTokens: 400,
      cachedTokens: 600,
    });
  });

  it('a missing or malformed payload reads as zeros, never NaN or a negative', () => {
    const zero = { inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    expect(readResponsesUsage(undefined)).toEqual(zero);
    expect(readResponsesUsage({ input_tokens: -5, output_tokens: Number.NaN, input_tokens_details: null })).toEqual(zero);
  });

  it('the runner transport reads through it: its exclusive buckets are the reading minus the breakdowns', () => {
    const wire = { input_tokens: 10_000, output_tokens: 1_000, total_tokens: 11_000, input_tokens_details: { cached_tokens: 6_000, cache_write_tokens: 3_000 }, output_tokens_details: { reasoning_tokens: 0 } };
    const r = readResponsesUsage(wire);
    expect(normalizeResponsesUsage(wire as never)).toEqual({
      inputTokens: r.inputTokens - r.cachedTokens - r.cacheWriteTokens,
      outputTokens: r.outputTokens,
      cacheReadInputTokens: r.cachedTokens,
      cacheCreationInputTokens: r.cacheWriteTokens,
      reasoningTokens: 0,
    });
  });
});

describe('the per-call and per-embedded-token rows', () => {
  it('web search on a reasoning OpenAI model is $10 per 1k calls ($0.01 a call, what OpenAI billed on 2026-10-01)', () => {
    expect(OPENAI_WEB_SEARCH_PRICING.reasoningPerCallUsd).toBe(0.01);
    expect(webSearchCallUsd('gpt-6.1-sol')).toBe(0.01);
    expect(webSearchCallUsd('gpt-6-luna')).toBe(0.01);
  });

  it('web search has no row for a model the card cannot price, or for another provider', () => {
    expect(webSearchCallUsd('gpt-9-imaginary')).toBeNull();
    expect(webSearchCallUsd('claude-sonnet-5-5')).toBeNull();
  });

  it('text-embedding-3-small is $0.02 per 1M tokens; an unknown embedding model has no row', () => {
    expect(OPENAI_EMBEDDING_PRICING['text-embedding-3-small']!.inputPerMTok).toBe(0.02);
    expect(embeddingUsd('text-embedding-3-small', 1_000_000)).toBeCloseTo(0.02, 12);
    expect(embeddingUsd('text-embedding-3-small', 50)).toBeCloseTo(0.000001, 12);
    expect(embeddingUsd('text-embedding-9', 1_000)).toBeNull();
  });
});

describe('the override layer — a re-price over the card, on every arm', () => {
  // 100k each: under every long-context threshold (GPT-6's 272K), so the standard rows price.
  const USAGE = { inputTokens: 100_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
  afterEach(() => setRateOverrideLayer(null));

  it('with no layer installed, the card prices (a runner installs none)', () => {
    expect(priceUsageUsd('gpt-6.1-sol', USAGE)!.usd).toBeCloseTo(0.2 + 1.0, 9);
  });

  it('replaces only the buckets it names, on the OpenAI-family, Anthropic and Google arms', () => {
    setRateOverrideLayer((id) => (id === 'gpt-6.1-sol' || id === 'claude-haiku-4-5' || id === 'gemini-3.8-flash' ? { inputPerMTok: 0.5 } : undefined));
    expect(priceUsageUsd('gpt-6.1-sol', USAGE)!.usd).toBeCloseTo(0.05 + 1.0, 9);
    expect(priceUsageUsd('claude-haiku-4-5-20251001', USAGE)!.usd).toBeCloseTo(0.05 + 0.5, 9);
    expect(priceUsageUsd('gemini-3.8-flash', USAGE)!.usd).toBeCloseTo(0.05 + 0.375, 9);
    // A model the layer does not name keeps the card.
    expect(priceUsageUsd('gpt-6-luna', USAGE)!.usd).toBeCloseTo(0.01 + 0.05, 9);
  });

  it('keys by the canonical id, so a dated alias is re-priced by its family row', () => {
    const seen: string[] = [];
    setRateOverrideLayer((id) => (seen.push(id), undefined));
    priceUsageUsd('claude-haiku-4-5-20251001', USAGE);
    expect(seen).toEqual(['claude-haiku-4-5']);
  });

  it('never makes a model the card cannot price priceable', () => {
    setRateOverrideLayer(() => ({ inputPerMTok: 1, outputPerMTok: 1, cachedInputPerMTok: 1, cacheWriteInputPerMTok: 1 }));
    expect(priceUsageUsd('gpt-9-imaginary', USAGE)).toBeNull();
    expect(isModelPriceable('gpt-9-imaginary')).toBe(false);
  });
});
