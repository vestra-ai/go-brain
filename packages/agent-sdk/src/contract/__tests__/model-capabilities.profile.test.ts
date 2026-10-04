import { describe, it, expect, vi } from 'vitest';
import { resolveCapabilities } from '../model-capabilities.js';
import { resolveModelProfile } from '../model-profile.js';

// Phase 4 (§1.7 AC-R4) — the all-model Profile: every model carries a
// tokenizerId, Gemini has real (provisional) capacity rows, and a caller can
// resolve capacity KEYED (model, transport) with an observable fallback for a
// pair the registry has no data for.
describe('model-capabilities — tokenizerId (AC-R4)', () => {
  it('assigns anthropic-claude to every Anthropic model', () => {
    for (const id of ['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-sonnet-4-5']) {
      expect(resolveCapabilities(id).tokenizerId).toBe('anthropic-claude');
    }
  });

  it('resolves Opus 5 (offered) AND legacy Opus 4.8 to the same anthropic Opus caps', () => {
    for (const id of ['claude-opus-5', 'claude-opus-4-8']) {
      const caps = resolveCapabilities(id);
      expect(caps.id).toBe(id);
      expect(caps.provider).toBe('anthropic');
      expect(caps.contextWindow).toBe(1_000_000);
      expect(caps.maxOutputTokens).toBe(128_000);
    }
  });

  it('assigns o200k_base to OpenAI and Fireworks-hosted models', () => {
    for (const id of ['gpt-5.5', 'gpt-5.4-mini', 'deepseek-v4-pro', 'glm-5.2']) {
      expect(resolveCapabilities(id).tokenizerId).toBe('o200k_base');
    }
  });

  it('assigns gemini to Gemini models', () => {
    expect(resolveCapabilities('gemini-3.8-flash').tokenizerId).toBe('gemini');
  });

  it('assigns a tokenizerId to the unknown-id fallback per inferred provider', () => {
    expect(resolveCapabilities('some-unknown-model').tokenizerId).toBe('anthropic-claude');
    expect(resolveCapabilities('gpt-9-mystery').tokenizerId).toBe('o200k_base');
    expect(resolveCapabilities('gemini-9-mystery').tokenizerId).toBe('gemini');
  });
});

describe('model-capabilities — Gemini seed rows (AC-R4 all-4-transports coverage)', () => {
  it('resolves real capacity for gemini-3.8-flash on the gemini_interactions transport', () => {
    const caps = resolveCapabilities('gemini-3.8-flash');
    expect(caps.provider).toBe('google');
    expect(caps.api).toBe('gemini_interactions');
    expect(caps.contextWindow).toBeGreaterThan(0);
    expect(caps.maxOutputTokens).toBeGreaterThan(0);
  });

  it('Gemini is available (undarked 2026-09-03) with real capacity', () => {
    const caps = resolveCapabilities('gemini-3.8-flash');
    expect(caps.available).toBeUndefined();
    expect(caps.contextWindow).toBeGreaterThan(0);
  });
});

describe('resolveModelProfile — keyed (model, transport) resolution', () => {
  it('resolves exact capacity when no transport is requested (uses the model native dialect)', () => {
    const profile = resolveModelProfile('claude-sonnet-5');
    expect(profile.transport).toBe('anthropic_messages');
    expect(profile.source).toBe('exact');
    expect(profile.contextWindowTokens).toBe(1_000_000);
    expect(profile.maxOutputTokens).toBe(128_000);
    expect(profile.tokenizerId).toBe('anthropic-claude');
  });

  it('resolves exact capacity when the requested transport matches the model native dialect', () => {
    const profile = resolveModelProfile('gpt-5.5', 'openai_responses');
    expect(profile.source).toBe('exact');
    expect(profile.contextWindowTokens).toBe(1_000_000);
  });

  it('resolves each of the 4 transports with real data for at least one model each', () => {
    expect(resolveModelProfile('claude-sonnet-5').transport).toBe('anthropic_messages');
    expect(resolveModelProfile('gpt-5.5').transport).toBe('openai_responses');
    expect(resolveModelProfile('glm-5.2').transport).toBe('openai_chat_completions');
    expect(resolveModelProfile('gemini-3.8-flash').transport).toBe('gemini_interactions');
    for (const modelId of ['claude-sonnet-5', 'gpt-5.5', 'glm-5.2', 'gemini-3.8-flash']) {
      const p = resolveModelProfile(modelId);
      expect(p.source).toBe('exact');
      expect(p.contextWindowTokens).toBeGreaterThan(0);
    }
  });

  it('falls back to a conservative floor AND logs when the (model, transport) pair has no data', () => {
    const onFallback = vi.fn();
    const profile = resolveModelProfile('claude-sonnet-5', 'gemini', onFallback);
    expect(profile.source).toBe('fallback');
    expect(profile.contextWindowTokens).toBe(200_000);
    expect(profile.maxOutputTokens).toBe(8192);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback.mock.calls[0][0]).toMatch(/claude-sonnet-5/);
  });

  it('never silently guesses — the default onFallback logs via console.warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveModelProfile('gpt-5.5', 'anthropic_messages');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('never throws on an unknown model id', () => {
    expect(() => resolveModelProfile('totally-unknown-model-xyz')).not.toThrow();
  });
});
