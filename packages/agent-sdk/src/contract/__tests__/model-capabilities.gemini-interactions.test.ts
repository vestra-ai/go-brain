import { describe, it, expect } from 'vitest';
import {
  KNOWN_MODEL_IDS,
  resolveCapabilities,
  isModelAvailable,
  modelSupportsImageInput,
} from '../model-capabilities.js';
import { resolveModelProfile } from '../model-profile.js';
import { resolveGeminiThinking } from '../../transports/thinking-support.js';

describe('google lane — gemini-3.8-flash (Interactions wire, dark-gated)', () => {
  it('resolves the seeded row', () => {
    const caps = resolveCapabilities('gemini-3.8-flash');
    expect(caps.id).toBe('gemini-3.8-flash');
    expect(caps.provider).toBe('google');
    expect(caps.api).toBe('gemini_interactions');
    expect(caps.contextWindow).toBe(1_048_576);
    expect(caps.maxOutputTokens).toBe(65_536);
    expect(caps.thinking).toEqual({ mode: 'reasoning', effort: 'medium' });
    expect(caps.tokenizerId).toBe('gemini');
    // Automatic prefix caching: no explicit breakpoints.
    expect(caps.cache.breakpointBudget).toBe(0);
  });

  it('is AVAILABLE (undarked 2026-09-03 on the founder\'s word) and vision-CAPABLE', () => {
    const caps = resolveCapabilities('gemini-3.8-flash');
    expect(caps.available).toBeUndefined();
    expect(caps.unavailableReason).toBeUndefined();
    expect(isModelAvailable('gemini-3.8-flash')).toBe(true);
    expect(modelSupportsImageInput('gemini-3.8-flash')).toBe(true);
  });

  it('routes to the gemini_interactions transport and resolves medium thinking with summaries', () => {
    expect(resolveModelProfile('gemini-3.8-flash').transport).toBe('gemini_interactions');
    expect(resolveGeminiThinking('gemini-3.8-flash')).toEqual({ thinking_level: 'medium', thinking_summaries: 'auto' });
  });

  it('the retired ids (gemini-3-pro / gemini-3-flash) left the seed and now resolve as UNSEEDED google fallbacks', () => {
    expect(KNOWN_MODEL_IDS).not.toContain('gemini-3-pro');
    expect(KNOWN_MODEL_IDS).not.toContain('gemini-3-flash');
    expect(KNOWN_MODEL_IDS).toContain('gemini-3.8-flash');
    const caps = resolveCapabilities('gemini-3-pro');
    expect(caps.provider).toBe('google');
    expect(caps.api).toBeUndefined();
  });

  it("an UNSEEDED future gemini id infers google, the gemini tokenizer, and google's house dialect", () => {
    const caps = resolveCapabilities('gemini-4-future');
    expect(caps.provider).toBe('google');
    expect(caps.tokenizerId).toBe('gemini');
    expect(resolveModelProfile('gemini-4-future').transport).toBe('gemini_interactions');
    // Unknown ids are never dark-gated (fail-closed only on explicit rows).
    expect(isModelAvailable('gemini-4-future')).toBe(true);
  });
});
