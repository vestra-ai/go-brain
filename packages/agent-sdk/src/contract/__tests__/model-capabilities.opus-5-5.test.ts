/**
 * Opus 5.5 (`claude-opus-5-5`) resolves to its OWN seed row, not Opus 5's.
 *
 * Same stem hazard as fable-5-1 vs fable-5: 'claude-opus-5-5'.includes('opus-5')
 * is TRUE, and the resolver takes the first SEED row whose `match` is a substring.
 * If the 5.5 row ever moves below the 5 row, every Opus 5.5 turn silently runs on
 * Opus 5's caps: `thinking.mode: 'adaptive'` is harmless on the wire, but the id
 * misattributes telemetry and the effort default is wrong. The first test below is
 * the ordering pin: it goes red the moment the row moves.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { KNOWN_MODEL_IDS, resolveCapabilities } from '../model-capabilities.js';
import { resolveAnthropicThinking } from '../../transports/thinking-support.js';

describe('Opus 5.5 capabilities', () => {
  afterEach(() => {
    delete process.env.NATIVE_THINKING;
  });

  it('resolves claude-opus-5-5 to its own id, NOT claude-opus-5 (row order pin)', () => {
    expect(resolveCapabilities('claude-opus-5-5').id).toBe('claude-opus-5-5');
    expect(resolveCapabilities('claude-opus-5-5-20260915').id).toBe('claude-opus-5-5');
    expect(resolveCapabilities('claude-opus-5-5[1m]').id).toBe('claude-opus-5-5');
  });

  it('still resolves plain claude-opus-5 to Opus 5 (historical tasks keep their caps)', () => {
    const caps = resolveCapabilities('claude-opus-5');
    expect(caps.id).toBe('claude-opus-5');
    expect(caps.thinking).toEqual({ mode: 'adaptive', effort: 'high', perMessageEffort: true });
  });

  it('carries the Opus 5.5 shape: 1M / 128K, always-on thinking at medium effort', () => {
    const caps = resolveCapabilities('claude-opus-5-5');
    expect(caps.provider).toBe('anthropic');
    expect(caps.tokenizerId).toBe('anthropic-claude');
    expect(caps.contextWindow).toBe(1_000_000);
    expect(caps.maxOutputTokens).toBe(128_000);
    expect(caps.thinking).toEqual({ mode: 'always_on', effort: 'medium', perMessageEffort: true });
    expect(caps.contextAware).toBe(false);
    expect(caps.preferredMaxInputTokens).toBe(200_000);
  });

  it('is a seed id, so the pricing-coverage tripwire enumerates it', () => {
    expect(KNOWN_MODEL_IDS).toContain('claude-opus-5-5');
  });

  it('the wire config is adaptive + summarized + effort medium; never disabled or a budget', () => {
    const cfg = resolveAnthropicThinking('claude-opus-5-5', 8192);
    expect(cfg).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      outputConfig: { effort: 'medium' },
    });
    expect(cfg?.beta).toBeUndefined();
    expect(JSON.stringify(cfg)).not.toMatch(/budget_tokens|disabled/);
  });
});
