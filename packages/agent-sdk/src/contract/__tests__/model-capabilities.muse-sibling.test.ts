import { describe, it, expect } from 'vitest';
import { KNOWN_MODEL_IDS, resolveCapabilities } from '../model-capabilities.js';
import { OPENAI_TOKEN_PRICING } from '../openai-pricing.js';

// The sibling lane (2026-09-05): Muse Spark 1.3 Standard exists in the registry ONLY
// as the contributor row's `unavailableSibling` — identical weights on Meta's
// Standard door, which never trains on the data and never flapped.

describe('model-capabilities — Muse sibling lane', () => {
  it('the contributor row names Standard 1.3 as its sibling; Standard names none (no chains)', () => {
    expect(resolveCapabilities('muse-spark-1.3-contributor').unavailableSibling).toBe('muse-spark-1.3');
    expect(resolveCapabilities('muse-spark-1.3').unavailableSibling).toBeUndefined();
  });

  it('Standard 1.3 resolves canonically on the meta lane (same wire, window, and output as the contributor row)', () => {
    const std = resolveCapabilities('muse-spark-1.3');
    const con = resolveCapabilities('muse-spark-1.3-contributor');
    expect(std.id).toBe('muse-spark-1.3');
    expect(std.provider).toBe('meta');
    expect(std.api).toBe('openai_responses');
    expect(std.contextWindow).toBe(con.contextWindow);
    expect(std.maxOutputTokens).toBe(con.maxOutputTokens);
    expect(std.thinking).toEqual(con.thinking);
  });

  it("substring order holds: the contributor id still resolves to the contributor row ('muse-spark-1.3' is its substring)", () => {
    expect(resolveCapabilities('muse-spark-1.3-contributor').id).toBe('muse-spark-1.3-contributor');
    expect(resolveCapabilities('muse-spark-1.3-2026-09-01').id).toBe('muse-spark-1.3');
  });

  it('Standard 1.3 carries the verified card: 1.25 in / 0.15 cached / 4.25 out (12.5× / 75× / 21× the contributor tier)', () => {
    const std = OPENAI_TOKEN_PRICING['muse-spark-1.3'];
    const con = OPENAI_TOKEN_PRICING['muse-spark-1.3-contributor'];
    expect(std).toMatchObject({ inputPerMTok: 1.25, cachedInputPerMTok: 0.15, outputPerMTok: 4.25 });
    expect(std.inputPerMTok / con.inputPerMTok).toBe(12.5);
    expect(std.outputPerMTok / con.outputPerMTok).toBeCloseTo(21.25, 6);
  });

  it('the belt is Muse-only today: no other seed row names a sibling', () => {
    const withSibling = KNOWN_MODEL_IDS.filter((id) => resolveCapabilities(id).unavailableSibling !== undefined);
    expect(withSibling).toEqual(['muse-spark-1.3-contributor']);
  });

  it('every declared sibling is itself a seeded, priced row (a sibling round must bill from a real card)', () => {
    for (const id of KNOWN_MODEL_IDS) {
      const sibling = resolveCapabilities(id).unavailableSibling;
      if (sibling === undefined) continue;
      expect(KNOWN_MODEL_IDS, `${id} → ${sibling}`).toContain(sibling);
      expect(OPENAI_TOKEN_PRICING[sibling], `${sibling} price row`).toBeDefined();
    }
  });
});
