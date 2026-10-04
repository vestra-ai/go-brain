/**
 * The one Fireworks wire table (contract/fireworks-wire.ts).
 *
 * 2026-09-26 ~03:05Z Fireworks pulled `deepseek-v4-flash-0731`; three hand-kept copies of
 * the table still named it, and every lane on the flash default answered 404 for four days.
 * These pins hold the three things that went wrong: a retired build in the table, the alias
 * resolving anywhere but the live slug, and a price that does not follow the wire.
 */
import { describe, expect, it } from 'vitest';
import {
  FIREWORKS_WIRE_ID,
  RETIRED_FIREWORKS_WIRE_IDS,
  fireworksWireId,
  hasFireworksWireEntry,
} from '../fireworks-wire.js';
import { OPENAI_TOKEN_PRICING, priceForModel } from '../openai-pricing.js';
import { resolveCapabilities } from '../model-capabilities.js';

describe('the Fireworks wire table', () => {
  it('maps no id to a build Fireworks has retired', () => {
    expect(RETIRED_FIREWORKS_WIRE_IDS).toContain('accounts/fireworks/models/deepseek-v4-flash-0731');
    for (const [id, slug] of Object.entries(FIREWORKS_WIRE_ID)) {
      expect(RETIRED_FIREWORKS_WIRE_IDS, `${id} → ${slug}`).not.toContain(slug);
    }
  });

  it('resolves the retired deepseek-v4-flash alias to the live V4.1 Flash slug', () => {
    expect(fireworksWireId('deepseek-v4-flash')).toBe('accounts/fireworks/models/deepseek-v4p1-flash');
    expect(fireworksWireId('deepseek-v4-flash')).toBe(fireworksWireId('deepseek-v4.1-flash'));
  });

  it('pins the other entries and prefixes an id it does not know', () => {
    expect(fireworksWireId('deepseek-v4-pro')).toBe('accounts/fireworks/models/deepseek-v4-pro-0813');
    expect(fireworksWireId('glm-5.2')).toBe('accounts/fireworks/models/glm-5p2');
    expect(fireworksWireId('some-new-model')).toBe('accounts/fireworks/models/some-new-model');
    expect(hasFireworksWireEntry('deepseek-v4.1-flash')).toBe(true);
    expect(hasFireworksWireEntry('claude-opus-5-5')).toBe(false);
  });

  it('keys every entry by a canonical Fireworks id the registry resolves to itself', () => {
    for (const id of Object.keys(FIREWORKS_WIRE_ID)) {
      const caps = resolveCapabilities(id);
      expect(caps.id, id).toBe(id);
      expect(caps.provider, id).toBe('fireworks');
    }
  });

  it('prices every entry, and two ids on one slug at ONE card: billing follows the wire', () => {
    const bySlug = new Map<string, string[]>();
    for (const [id, slug] of Object.entries(FIREWORKS_WIRE_ID)) {
      expect(OPENAI_TOKEN_PRICING[id], `${id} has no price row`).toBeDefined();
      bySlug.set(slug, [...(bySlug.get(slug) ?? []), id]);
    }
    for (const ids of bySlug.values()) {
      for (const id of ids) expect(priceForModel(id), `${id} vs ${ids[0]}`).toBe(priceForModel(ids[0]));
    }
    // The case that exists today: the retired alias bills at the V4.1 Flash card it runs on.
    expect(priceForModel('deepseek-v4-flash')).toBe(priceForModel('deepseek-v4.1-flash'));
    expect(priceForModel('deepseek-v4.1-flash')).toMatchObject({
      inputPerMTok: 0.3,
      cachedInputPerMTok: 0.006,
      outputPerMTok: 1.2,
    });
  });
});
