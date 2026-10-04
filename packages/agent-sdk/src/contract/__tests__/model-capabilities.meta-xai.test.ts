import { describe, it, expect } from 'vitest';
import {
  resolveCapabilities,
  isModelAvailable,
  modelSupportsImageInput,
} from '../model-capabilities.js';
import { resolveModelProfile } from '../model-profile.js';

describe('meta lane — muse-spark-1.3-contributor (the offered Muse, 2026-09-03)', () => {
  it('resolves the seeded row AHEAD of the 1.1 row (most-specific-first) on the same wire', () => {
    const caps = resolveCapabilities('muse-spark-1.3-contributor');
    expect(caps.id).toBe('muse-spark-1.3-contributor');
    expect(caps.provider).toBe('meta');
    expect(caps.api).toBe('openai_responses');
    expect(caps.contextWindow).toBe(1_048_576);
    expect(caps.maxOutputTokens).toBe(131_072);
    expect(caps.thinking).toEqual({ mode: 'reasoning', effort: 'high' });
    expect(isModelAvailable('muse-spark-1.3-contributor')).toBe(true);
    expect(modelSupportsImageInput('muse-spark-1.3-contributor')).toBe(true);
    expect(resolveModelProfile('muse-spark-1.3-contributor').transport).toBe('openai_responses');
  });
});

describe('meta lane — muse-spark-1.1 (superseded on the picker; kept for historical tasks)', () => {
  it('resolves the seeded row', () => {
    const caps = resolveCapabilities('muse-spark-1.1');
    expect(caps.id).toBe('muse-spark-1.1');
    expect(caps.provider).toBe('meta');
    expect(caps.api).toBe('openai_responses');
    expect(caps.contextWindow).toBe(1_048_576);
    expect(caps.maxOutputTokens).toBe(131_072);
    expect(caps.thinking).toEqual({ mode: 'reasoning', effort: 'high' });
    expect(caps.tokenizerId).toBe('o200k_base');
    // OpenAI-style automatic prefix caching: no explicit breakpoints.
    expect(caps.cache.breakpointBudget).toBe(0);
  });

  it('is AVAILABLE (undarked 2026-09-03 on the founder\'s word) and vision-CAPABLE', () => {
    const caps = resolveCapabilities('muse-spark-1.1');
    expect(caps.available).toBeUndefined();
    expect(caps.unavailableReason).toBeUndefined();
    expect(isModelAvailable('muse-spark-1.1')).toBe(true);
    expect(modelSupportsImageInput('muse-spark-1.1')).toBe(true);
  });

  it('routes to the openai_responses transport', () => {
    expect(resolveModelProfile('muse-spark-1.1').transport).toBe('openai_responses');
  });

  it('an UNSEEDED future muse id infers provider meta, vision-capable, OpenAI cache policy', () => {
    const caps = resolveCapabilities('muse-nova-2');
    expect(caps.provider).toBe('meta');
    expect(caps.tokenizerId).toBe('o200k_base');
    expect(caps.cache.breakpointBudget).toBe(0);
    expect(modelSupportsImageInput('muse-nova-2')).toBe(true);
    // Unknown ids are never dark-gated (fail-closed only on explicit rows).
    expect(isModelAvailable('muse-nova-2')).toBe(true);
  });
});

describe('xai lane — grok-4.5 (Chat Completions wire, undarked 2026-07-15)', () => {
  it('resolves the seeded row', () => {
    const caps = resolveCapabilities('grok-4.5');
    expect(caps.id).toBe('grok-4.5');
    expect(caps.provider).toBe('xai');
    expect(caps.api).toBe('openai_chat_completions');
    expect(caps.contextWindow).toBe(500_000);
    expect(caps.maxOutputTokens).toBe(32_768);
    expect(caps.thinking).toEqual({ mode: 'reasoning', effort: 'high' });
    expect(caps.premiumInputThreshold).toBe(200_000);
    expect(caps.tokenizerId).toBe('o200k_base');
  });

  it('is AVAILABLE (gate deleted at the 2026-07-15 flip) and vision-CAPABLE', () => {
    expect(isModelAvailable('grok-4.5')).toBe(true);
    expect(resolveCapabilities('grok-4.5').available).toBeUndefined();
    expect(resolveCapabilities('grok-4.5').unavailableReason).toBeUndefined();
    expect(modelSupportsImageInput('grok-4.5')).toBe(true);
  });

  it("the 'grok-4.5-latest' alias collapses onto the canonical row", () => {
    const caps = resolveCapabilities('grok-4.5-latest');
    expect(caps.id).toBe('grok-4.5');
    expect(caps.provider).toBe('xai');
  });

  it('routes to the openai_chat_completions transport', () => {
    expect(resolveModelProfile('grok-4.5').transport).toBe('openai_chat_completions');
  });

  it('an UNSEEDED future grok id infers provider xai', () => {
    const caps = resolveCapabilities('grok-5');
    expect(caps.provider).toBe('xai');
    expect(isModelAvailable('grok-5')).toBe(true);
  });
});

describe('xai lane — grok-4.6 (released 2026-08-12, seeded 2026-08-13)', () => {
  it('resolves the seeded row', () => {
    const caps = resolveCapabilities('grok-4.6');
    expect(caps.id).toBe('grok-4.6');
    expect(caps.provider).toBe('xai');
    expect(caps.api).toBe('openai_chat_completions');
    expect(caps.contextWindow).toBe(500_000);
    expect(caps.maxOutputTokens).toBe(32_768);
    expect(caps.thinking).toEqual({ mode: 'reasoning', effort: 'high' });
    expect(caps.premiumInputThreshold).toBe(200_000);
    expect(caps.tokenizerId).toBe('o200k_base');
  });

  it('is AVAILABLE (no launch gate) and vision-CAPABLE', () => {
    expect(isModelAvailable('grok-4.6')).toBe(true);
    expect(resolveCapabilities('grok-4.6').available).toBeUndefined();
    expect(resolveCapabilities('grok-4.6').unavailableReason).toBeUndefined();
    expect(modelSupportsImageInput('grok-4.6')).toBe(true);
  });

  it("the 'grok-4.6-latest' alias collapses onto the canonical row", () => {
    const caps = resolveCapabilities('grok-4.6-latest');
    expect(caps.id).toBe('grok-4.6');
    expect(caps.provider).toBe('xai');
  });

  it('routes to the openai_chat_completions transport', () => {
    expect(resolveModelProfile('grok-4.6').transport).toBe('openai_chat_completions');
  });
});

describe('xai lane — grok-4.7 (seeded 2026-09-29, beside 4.5 and 4.6)', () => {
  it('resolves its OWN row (not the unknown-id fallback), shaped like 4.6: available, vision, Chat Completions', () => {
    const caps = resolveCapabilities('grok-4.7');
    expect(caps.id).toBe('grok-4.7');
    expect(caps.provider).toBe('xai');
    expect(caps.api).toBe('openai_chat_completions');
    expect(caps.contextWindow).toBe(500_000);
    expect(caps.maxOutputTokens).toBe(32_768);
    expect(caps.thinking).toEqual({ mode: 'reasoning', effort: 'high' });
    expect(caps.premiumInputThreshold).toBe(200_000);
    expect(caps.preferredMaxInputTokens).toBe(200_000);
    expect(caps.tokenizerId).toBe('o200k_base');
    expect(isModelAvailable('grok-4.7')).toBe(true);
    expect(caps.available).toBeUndefined();
    expect(modelSupportsImageInput('grok-4.7')).toBe(true);
    expect(resolveModelProfile('grok-4.7')).toMatchObject({ transport: 'openai_chat_completions', contextWindowTokens: 500_000, source: 'exact' });
  });

  it("the 'grok-4.7-latest' alias collapses onto the canonical row, and 4.6 keeps its own", () => {
    expect(resolveCapabilities('grok-4.7-latest').id).toBe('grok-4.7');
    expect(resolveCapabilities('grok-4.6').id).toBe('grok-4.6');
  });
});
