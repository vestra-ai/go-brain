/**
 * Sonnet 5.5 (`claude-sonnet-5-5`) resolves to its OWN seed row, not Sonnet 5's.
 *
 * Same stem hazard as opus-5-5 vs opus-5: 'claude-sonnet-5-5'.includes('sonnet-5') is
 * TRUE, and the resolver takes the first SEED row whose `match` is a substring. Below
 * the Sonnet 5 row every 5.5 turn would run on Sonnet 5's caps under Sonnet 5's id,
 * and a future change to that row (a thinking-off mode, say) would reach a model that
 * 400s on `thinking:{type:'disabled'}`. The first test is the ordering pin.
 */
import { describe, expect, it } from 'vitest';
import { KNOWN_MODEL_IDS, modelSupportsToolSearch, resolveCapabilities } from '../model-capabilities.js';
import { resolveAnthropicThinking } from '../../transports/thinking-support.js';

describe('Sonnet 5.5 capabilities', () => {
  it('resolves claude-sonnet-5-5 to its own id, and claude-sonnet-5 keeps its own row (row order pin)', () => {
    expect(resolveCapabilities('claude-sonnet-5-5').id).toBe('claude-sonnet-5-5');
    expect(resolveCapabilities('claude-sonnet-5-5-20260928').id).toBe('claude-sonnet-5-5');
    expect(resolveCapabilities('claude-sonnet-5-5[1m]').id).toBe('claude-sonnet-5-5');
    const five = resolveCapabilities('claude-sonnet-5');
    expect(five.id).toBe('claude-sonnet-5');
    expect(five.thinking).toEqual({ mode: 'adaptive', effort: 'medium' });
    expect(five.cache.minCacheableTokens).toBe(1024);
  });

  it('carries the Sonnet 5.5 shape: 1M / 128K, tool search, a 512-token cache floor', () => {
    const caps = resolveCapabilities('claude-sonnet-5-5');
    expect(caps.provider).toBe('anthropic');
    expect(caps.tokenizerId).toBe('anthropic-claude');
    expect(caps.contextWindow).toBe(1_000_000);
    expect(caps.maxOutputTokens).toBe(128_000);
    expect(caps.contextAware).toBe(false);
    expect(caps.preferredMaxInputTokens).toBe(200_000);
    expect(caps.premiumInputThreshold).toBeUndefined();
    // Listed in Anthropic's tool-search compatibility table.
    expect(caps.supportsToolSearch).toBe(true);
    expect(modelSupportsToolSearch('claude-sonnet-5-5')).toBe(true);
    expect(caps.cache).toEqual({
      minCacheableTokens: 512,
      ttl: '5m',
      breakpointBudget: 4,
      lookbackBlocks: 20,
      intermediateBlocks: 15,
    });
  });

  it('thinking is always_on at effort medium, so the wire is adaptive + summarized, never disabled or a budget', () => {
    expect(resolveCapabilities('claude-sonnet-5-5').thinking).toEqual({ mode: 'always_on', effort: 'medium', perMessageEffort: true });
    const cfg = resolveAnthropicThinking('claude-sonnet-5-5', 8192);
    expect(cfg).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      outputConfig: { effort: 'medium' },
    });
    expect(cfg?.beta).toBeUndefined();
    expect(JSON.stringify(cfg)).not.toMatch(/budget_tokens|disabled|between_tools/);
  });

  it('is a seed id, so the pricing-coverage tripwire enumerates it', () => {
    expect(KNOWN_MODEL_IDS).toContain('claude-sonnet-5-5');
  });
});
