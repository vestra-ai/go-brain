/**
 * Fable 5.1 (`claude-fable-5-1`) resolves to its OWN seed row, not Fable 5's.
 *
 * `resolveCapabilities` walks SEED in order and takes the first entry whose
 * `match` is a SUBSTRING of the id (`lower.includes(entry.match)`). The Fable 5
 * row matches on the stem `fable-5`, and 'claude-fable-5-1'.includes('fable-5')
 * is TRUE — so without a more specific row placed BEFORE it, every Fable 5.1
 * request silently resolves to Fable 5's caps and reports `id: 'claude-fable-5'`.
 * Same collision the seed already guards for mythos-preview vs mythos-5.
 *
 * That failure is invisible at the call site: the request succeeds, billing and
 * telemetry attribute it to the wrong model, and a future divergence in caps
 * (context window, thinking mode) would apply the wrong one.
 */
import { describe, expect, it } from 'vitest';
import { resolveCapabilities } from '../model-capabilities.js';

describe('Fable 5.1 capabilities', () => {
  it('resolves claude-fable-5-1 to its own id, NOT claude-fable-5 (stem collision)', () => {
    expect(resolveCapabilities('claude-fable-5-1').id).toBe('claude-fable-5-1');
  });

  it('still resolves plain claude-fable-5 to Fable 5 (legacy ids stay billable)', () => {
    expect(resolveCapabilities('claude-fable-5').id).toBe('claude-fable-5');
  });

  it('carries the Fable line shape: 1M context, 128K output, always-on thinking', () => {
    const caps = resolveCapabilities('claude-fable-5-1');
    expect(caps.provider).toBe('anthropic');
    expect(caps.contextWindow).toBe(1_000_000);
    expect(caps.maxOutputTokens).toBe(128_000);
    // thinking is always on: sending a thinking config returns 400, effort tunes it
    expect(caps.thinking.mode).toBe('always_on');
    expect(caps.thinking.effort).toBe('high');
  });

  it('resolves a dated Fable 5.1 snapshot to the 5.1 row, not the 5 row', () => {
    expect(resolveCapabilities('claude-fable-5-1-20260901').id).toBe('claude-fable-5-1');
  });
});
