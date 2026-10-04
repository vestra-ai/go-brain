import { describe, it, expect } from 'vitest';
import { KNOWN_MODEL_IDS, resolveCapabilities } from '../model-capabilities.js';
import { resolveFamilyRate } from '../../engine/native-pricing.js';
import { OPENAI_TOKEN_PRICING, priceForModel } from '../openai-pricing.js';
import { resolveGeminiRate } from '../../transports/gemini-transport.js';

/**
 * PRICING-COVERAGE TRIPWIRE — the merchant-of-record guarantee.
 *
 * Enumerates EVERY canonical model id in the capability registry and asserts each
 * resolves to an explicit, positive, NON-FALLBACK rate on its provider's rate card:
 *   - anthropic → a NAMED family in native-pricing (never the Sonnet DEFAULT sentinel),
 *   - openai/fireworks → an EXACT OPENAI_TOKEN_PRICING row (verifiedAt + sources + 3 rates),
 *   - google → an EXPLICIT GEMINI_RATES row (provisional allowed, absent not).
 *
 * KNOWN_MODEL_IDS is derived from the registry SEED, so seeding a new model without a
 * price makes THIS test go red. That is the whole point: rates can never drift silently
 * behind the model list.
 */
describe('pricing coverage — every registry model id has an explicit non-fallback rate', () => {
  it('enumerates a non-empty registry spanning all six providers', () => {
    // 'deepseek' left the set 2026-08-17: the direct lane was removed (Google
    // Limited Use) and both DeepSeek builds ride 'fireworks'.
    expect(KNOWN_MODEL_IDS.length).toBeGreaterThan(0);
    const providers = new Set(KNOWN_MODEL_IDS.map((id) => resolveCapabilities(id).provider));
    expect(providers).toEqual(
      new Set(['anthropic', 'openai', 'fireworks', 'google', 'meta', 'xai']),
    );
  });

  it('exposes no duplicate ids (canonical, deduped)', () => {
    expect(new Set(KNOWN_MODEL_IDS).size).toBe(KNOWN_MODEL_IDS.length);
  });

  it('has teeth: a synthetic unpriced id is flagged as fallback in EVERY provider arm', () => {
    // Guards the guard — if any arm's fallback signal were hardcoded, the per-id
    // assertions below would pass vacuously and stop catching an unpriced model.
    expect(resolveFamilyRate('claude-nonesuch-9').isDefault).toBe(true);
    expect(OPENAI_TOKEN_PRICING['gpt-nonesuch-9']).toBeUndefined();
    expect(resolveGeminiRate('gemini-nonesuch-9').isFallback).toBe(true);
  });

  // FAIL-CLOSED INVARIANT — an unknown id must never bill BELOW a known one.
  // priceForModel's contract is "fails closed to the max price on an unknown id —
  // never $0"; an estimate for an id we cannot identify has to over-charge, never
  // under-charge. That held only while the named fallback row HAPPENED to be the
  // most expensive one, so any re-price that cuts it silently voids the contract
  // (2026-08-23: OpenAI cut Sol to $4/$20 while the superseded gpt-5.5 row stayed
  // $5/$30). Asserting the invariant itself, per bucket, makes the guarantee
  // survive the next re-price instead of resting on a coincidence.
  it('an unknown id prices at or above EVERY known row, in every bucket', () => {
    const fallback = priceForModel('gpt-nonesuch-9');
    for (const [id, rate] of Object.entries(OPENAI_TOKEN_PRICING)) {
      expect(fallback.inputPerMTok, `${id} input outprices the unknown-id fallback`).toBeGreaterThanOrEqual(rate.inputPerMTok);
      expect(fallback.outputPerMTok, `${id} output outprices the unknown-id fallback`).toBeGreaterThanOrEqual(rate.outputPerMTok);
      expect(fallback.cachedInputPerMTok, `${id} cached input outprices the unknown-id fallback`).toBeGreaterThanOrEqual(rate.cachedInputPerMTok);
    }
    expect(fallback.inputPerMTok).toBeGreaterThan(0);
    expect(fallback.outputPerMTok).toBeGreaterThan(0);
  });

  it.each(KNOWN_MODEL_IDS)('%s → explicit, positive, non-fallback rate', (id) => {
    const { provider } = resolveCapabilities(id);
    switch (provider) {
      case 'anthropic': {
        const r = resolveFamilyRate(id);
        expect(r.isDefault, `${id} fell to the Sonnet DEFAULT_RATE sentinel`).toBe(false);
        expect(r.rate.in, `${id} input rate`).toBeGreaterThan(0);
        expect(r.rate.out, `${id} output rate`).toBeGreaterThan(0);
        expect(r.rate.cacheRead, `${id} cache-read rate`).toBeGreaterThan(0);
        expect(r.rate.cacheWrite, `${id} cache-write rate`).toBeGreaterThan(0);
        break;
      }
      case 'openai':
      case 'fireworks':
      case 'meta':
      case 'xai':
      // DeepSeek first-party rides the same OPENAI_TOKEN_PRICING table (the
      // canonical id keeps its row across the provider cutover — PR-B swaps
      // the row's RATES, never its key).
      case 'deepseek': {
        const row = OPENAI_TOKEN_PRICING[id];
        expect(row, `no exact OPENAI_TOKEN_PRICING row for ${id}`).toBeDefined();
        expect(row.inputPerMTok, `${id} input rate`).toBeGreaterThan(0);
        expect(row.cachedInputPerMTok, `${id} cached-input rate`).toBeGreaterThan(0);
        expect(row.outputPerMTok, `${id} output rate`).toBeGreaterThan(0);
        expect(typeof row.verifiedAt, `${id} missing verifiedAt`).toBe('string');
        expect(row.sources.length, `${id} missing sources`).toBeGreaterThan(0);
        break;
      }
      case 'google': {
        const g = resolveGeminiRate(id);
        expect(g.isFallback, `${id} fell to the gemini pro-tier fallback`).toBe(false);
        expect(g.price.inPerM, `${id} input rate`).toBeGreaterThan(0);
        expect(g.price.cachedPerM, `${id} cached-input rate`).toBeGreaterThan(0);
        expect(g.price.outPerM, `${id} output rate`).toBeGreaterThan(0);
        expect(typeof g.price.verifiedAt, `${id} missing verifiedAt`).toBe('string');
        expect(g.price.sources.length, `${id} missing sources`).toBeGreaterThan(0);
        break;
      }
      default: {
        // Exhaustiveness guard — a future ModelProvider must get a rate-card arm here.
        const _exhaustive: never = provider;
        throw new Error(`pricing coverage: unhandled provider ${String(_exhaustive)} for ${id}`);
      }
    }
  });
});
