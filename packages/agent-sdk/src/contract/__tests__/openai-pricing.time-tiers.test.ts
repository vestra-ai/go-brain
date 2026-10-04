/**
 * Time-of-day pricing tiers. The machinery (a row carrying its own schedule,
 * self-activating at the provider's cutover instant) stays: the only tiered
 * row — deepseek-v4-pro on the official-API lane — left with the 2026-08-17
 * reversal (Pro returned to Fireworks; Google Limited Use), so today every
 * catalog row is flat. When a tiered row returns, its PR re-adds the window
 * tests (peak/off-peak values, half-open edges, pre-effective history) — see
 * this file's history at 884985392 for the shape.
 */
import { describe, it, expect } from 'vitest';
import { OPENAI_TOKEN_PRICING, priceForModel, priceForModelAtInstant } from '../openai-pricing.js';

const T = (iso: string) => Date.parse(iso);

describe('priceForModelAtInstant — every catalog row is flat today', () => {
  it('no row carries timeTiers (the 08-17 reversal guard)', () => {
    for (const [id, row] of Object.entries(OPENAI_TOKEN_PRICING)) {
      expect(row.timeTiers, `${id} should be flat`).toBeUndefined();
    }
  });

  it('returns the base row BY REFERENCE at any instant (byte-identical lanes)', () => {
    for (const id of ['gpt-5.6-luna', 'glm-5.2', 'deepseek-v4-pro', 'deepseek-v4-flash', 'grok-4.5']) {
      const base = priceForModel(id);
      expect(priceForModelAtInstant(id, T('2026-08-20T02:00:00Z'))).toBe(base);
      expect(priceForModelAtInstant(id, T('2025-01-01T00:00:00Z'))).toBe(base);
    }
  });

  it('deepseek-v4-pro prices flat even inside the old peak windows', () => {
    // 02:00 UTC was peak under the official-API era; Fireworks has no tiers.
    const p = priceForModelAtInstant('deepseek-v4-pro', T('2026-08-18T02:00:00Z'));
    expect(p.inputPerMTok).toBe(1.32);
    expect(p.outputPerMTok).toBe(3.96);
  });
});
