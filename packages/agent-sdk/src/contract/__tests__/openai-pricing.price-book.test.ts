/**
 * THE PRICE THAT GATES IS THE PRICE THAT BILLS.
 *
 * Prod 09-23, task fee1bd62: the server had shipped gpt-6-luna (priced $0.01/M cached)
 * while the user's runner still ran the previous bundle, whose table had no luna row.
 * An unknown id fails closed to the table's MAX price, so a $0.11 turn read $11.05 on
 * the runner's live-spend ledger and the $10 per-turn ceiling stopped it mid-work. The
 * server billed $0.11 — from its own, newer table.
 *
 * The runner prices with the server's book: the server hands it over on the lease beat
 * whenever the fingerprints differ, and the runner adopts it into this one table.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  OPENAI_TOKEN_PRICING,
  adoptPriceBook,
  priceBookFingerprint,
  priceForModel,
  pricesAtFailClosed,
  type TokenPrice,
} from '../openai-pricing.js';
import { priceUsageUsd } from '../usage-pricing.js';
import { computeOpenAIResponsesCostUsd } from '../../transports/openai-responses-pricing.js';

const NEW_MODEL = 'gpt-test-price-book-new';
const lunaLike: TokenPrice = {
  inputPerMTok: 0.1, cachedInputPerMTok: 0.01, outputPerMTok: 0.5, cacheWriteInputPerMTok: 0.125,
  verifiedAt: '2026-09-23', sources: ['test'],
};

afterEach(() => {
  delete OPENAI_TOKEN_PRICING[NEW_MODEL];
});

describe('the runner adopts the price book the server bills with', () => {
  it('a model the bundle never knew is priced at the server row, not the fail-closed max (fee1bd62)', () => {
    // Turn 1's usage: 5.27M cached reads, 368k cache writes, 23k out.
    const usage = { inputTokens: 186, outputTokens: 23_405, cacheReadInputTokens: 5_275_679, cacheCreationInputTokens: 368_496 };
    const before = computeOpenAIResponsesCostUsd(usage, NEW_MODEL);

    expect(adoptPriceBook({ [NEW_MODEL]: lunaLike })).toBe(1);

    const after = computeOpenAIResponsesCostUsd(usage, NEW_MODEL);
    expect(after).toBeCloseTo(0.1106, 3);
    expect(before / after).toBeGreaterThan(50); // the false ceiling trip, measured
    expect(priceForModel(NEW_MODEL)).toEqual(lunaLike);
  });

  it('the server row replaces a stale bundled row — the biller is the authority', () => {
    const id = Object.keys(OPENAI_TOKEN_PRICING)[0];
    const original = OPENAI_TOKEN_PRICING[id];
    try {
      adoptPriceBook({ [id]: { ...original, outputPerMTok: original.outputPerMTok + 1 } });
      expect(priceForModel(id).outputPerMTok).toBe(original.outputPerMTok + 1);
    } finally {
      OPENAI_TOKEN_PRICING[id] = original;
    }
  });

  it('a malformed row is refused — a NaN price would blind every spend gate', () => {
    const bad = { ...lunaLike, outputPerMTok: Number.NaN };
    const negative = { ...lunaLike, inputPerMTok: -1 };
    expect(adoptPriceBook({ [NEW_MODEL]: bad, 'gpt-neg': negative } as Record<string, TokenPrice>)).toBe(0);
    expect(NEW_MODEL in OPENAI_TOKEN_PRICING).toBe(false);
    expect('gpt-neg' in OPENAI_TOKEN_PRICING).toBe(false);
  });

  it('the fingerprint names the book: stable across key order, moved by any price change', () => {
    const a = { x: lunaLike, y: { ...lunaLike, outputPerMTok: 2 } };
    const b = { y: { ...lunaLike, outputPerMTok: 2 }, x: lunaLike };
    expect(priceBookFingerprint(a)).toBe(priceBookFingerprint(b));
    expect(priceBookFingerprint(a)).not.toBe(priceBookFingerprint({ ...a, x: { ...lunaLike, inputPerMTok: 0.2 } }));
  });
});

// ── pricesAtFailClosed: the question a stop gate asks (live-spend.ts) ──────────
describe('pricesAtFailClosed — IS the fail-closed lookup, raw id against the live table', () => {
  it('false for every row in the table; true for an id with no row', () => {
    for (const id of Object.keys(OPENAI_TOKEN_PRICING)) expect(pricesAtFailClosed(id), id).toBe(false);
    expect(pricesAtFailClosed(NEW_MODEL)).toBe(true);
  });

  it('an alias the BILLER resolves to a known row still prices at the max here — the raw id has no row', () => {
    const alias = 'gpt-5.6-some-alias';
    expect(priceUsageUsd(alias, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).not.toBeNull();
    expect(pricesAtFailClosed(alias)).toBe(true);
  });

  it('reads the LIVE table: an adopted id stops pricing at the max', () => {
    expect(pricesAtFailClosed(NEW_MODEL)).toBe(true);
    adoptPriceBook({ [NEW_MODEL]: lunaLike });
    expect(pricesAtFailClosed(NEW_MODEL)).toBe(false);
  });
});
