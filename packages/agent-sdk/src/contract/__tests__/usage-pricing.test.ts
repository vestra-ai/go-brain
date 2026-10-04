import { describe, it, expect } from 'vitest';
import { priceBuckets, priceUsageUsd, type NormalizedTokenUsage } from '../usage-pricing.js';
import { computeAnthropicCostUsd } from '../../engine/native-pricing.js';

const u = (partial: Partial<NormalizedTokenUsage>): NormalizedTokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...partial,
});

describe('priceUsageUsd — anthropic', () => {
  it('prices the 5m/1h cache-write split at 1.25x / 2x input (the claimed path already does)', () => {
    // sonnet-5: in $2, out $10, cacheRead $0.2, 5m write $2.5, 1h write = 2x input = $4
    const priced = priceUsageUsd(
      'claude-sonnet-5',
      u({
        inputTokens: 1_000,
        outputTokens: 500,
        cacheReadTokens: 10_000,
        cacheWriteTokens: 5_000, // aggregate — must be IGNORED when the split is present
        cacheWrite5mTokens: 2_000,
        cacheWrite1hTokens: 3_000,
      }),
    );
    // (1000*2 + 500*10 + 10000*0.2 + 2000*2.5 + 3000*4) / 1e6
    expect(priced?.usd).toBeCloseTo(0.026, 10);
    expect(priced?.provider).toBe('anthropic');
  });

  it('matches computeAnthropicCostUsd exactly when only the aggregate write is known', () => {
    const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 300 };
    const priced = priceUsageUsd(
      'claude-sonnet-5',
      u({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 300 }),
    );
    expect(priced?.usd).toBeCloseTo(computeAnthropicCostUsd(usage, 'claude-sonnet-5'), 12);
  });

  it('prices claude-opus-5 at the opus family rate', () => {
    const priced = priceUsageUsd('claude-opus-5', u({ inputTokens: 1_000_000 }));
    expect(priced?.usd).toBeCloseTo(5, 10);
  });

  it('refuses an unknown anthropic family (never bills the Sonnet stand-in)', () => {
    expect(priceUsageUsd('claude-nova-9', u({ inputTokens: 1_000_000 }))).toBeNull();
  });
});

describe('priceUsageUsd — openai family (EXCLUSIVE convention, 2026-08-04)', () => {
  it('prices luna at the current (07-30 cut) row — disjoint buckets price directly', () => {
    const priced = priceUsageUsd(
      'gpt-5.6-luna',
      u({ inputTokens: 0, outputTokens: 100, cacheReadTokens: 600, cacheWriteTokens: 400 }),
    );
    // plain 0; cached 600*0.02 + write 400*0.25 + out 100*1.2 = 232 / 1e6
    expect(priced?.usd).toBeCloseTo(0.000232, 12);
  });

  it('legacy include-convention events still clamp a malformed cached > input to the input', () => {
    const priced = priceUsageUsd(
      'gpt-5.6-luna',
      u({ inputTokens: 100, cacheReadTokens: 500 }),
      { legacyInclusiveInput: true },
    );
    // legacy math: cached clamps to 100; nothing plain remains.
    expect(priced?.usd).toBeCloseTo((100 * 0.02) / 1_000_000, 12);
  });

  it('prices gpt-6-astra on the 2026-09-05 card — every bucket 2.5× Sol', () => {
    const priced = priceUsageUsd(
      'gpt-6-astra',
      u({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 600, cacheWriteTokens: 400 }),
    );
    // plain 1000*10 + cached 600*1 + write 400*12.5 + out 100*50 = 20,600 / 1e6
    expect(priced?.usd).toBeCloseTo(0.0206, 12);
  });

  it('canonicalizes the bare gpt-5.6 alias to sol', () => {
    // 100K tokens: under the 272K long-context cliff (a 1M-token prompt would bill 2x —
    // openai-pricing.long-context.test.ts pins that tier).
    const priced = priceUsageUsd('gpt-5.6', u({ inputTokens: 100_000 }));
    expect(priced?.canonicalId).toBe('gpt-5.6-sol');
    // $4/M input since the 2026-08-21 promotional cut (was $5).
    expect(priced?.usd).toBeCloseTo(0.4, 10);
  });

  it('refuses an unknown openai id (never the fail-closed Sol estimate — that is for estimates, not ledgers)', () => {
    expect(priceUsageUsd('gpt-9-quasar', u({ inputTokens: 1_000_000 }))).toBeNull();
  });
});

describe('priceUsageUsd — fireworks / meta / xai', () => {
  it('prices deepseek-v4-flash (writes bill at the input rate via the ?? fallback, like the transport)', () => {
    const priced = priceUsageUsd(
      'deepseek-v4-flash',
      u({ inputTokens: 250, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 250 }),
    );
    // EXCLUSIVE shape (2026-08-04): 250 plain + 500 cached + 250 written.
    // V4.1 Flash's card since 2026-10-01: uncached 250*0.30 + cached 500*0.006 +
    // written 250*0.30 + out 100*1.20 = 273 / 1e6
    expect(priced?.usd).toBeCloseTo(0.000273, 12);
  });

  it('prices muse-spark-1.3-contributor on the contributor card: 0.10 in / 0.002 cached / 0.20 out', () => {
    const priced = priceUsageUsd(
      'muse-spark-1.3-contributor',
      u({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 }),
    );
    expect(priced?.provider).toBe('meta');
    expect(priced?.canonicalId).toBe('muse-spark-1.3-contributor');
    expect(priced?.usd).toBeCloseTo(0.1 + 0.002 + 0.2, 10);
  });

  it('prices muse cache-writes at the input rate (no cacheWriteInputPerMTok on the row)', () => {
    const priced = priceUsageUsd('muse-spark-1.1', u({ inputTokens: 0, cacheWriteTokens: 1_000 }));
    // EXCLUSIVE shape: an all-write prompt has zero plain input; 1000 written * 1.25.
    expect(priced?.usd).toBeCloseTo(0.00125, 12);
  });

  it('applies grok-4.5 standard tier below 200K prompt', () => {
    const priced = priceUsageUsd(
      'grok-4.5',
      u({ inputTokens: 80_000, outputTokens: 1_000, cacheReadTokens: 20_000 }),
    );
    // EXCLUSIVE shape: 80k plain + 20k cached = 100k total prompt (< threshold).
    // uncached 80k*2 + cached 20k*0.3 + out 1k*6 = 172_000 / 1e6 (cached
    // re-priced $0.50→$0.30 by xAI, docs-verified 2026-08-13).
    expect(priced?.usd).toBeCloseTo(0.172, 10);
  });

  it('applies grok-4.5 premium whole-request tier at >=200K prompt', () => {
    const priced = priceUsageUsd(
      'grok-4.5',
      u({ inputTokens: 200_000, outputTokens: 1_000, cacheReadTokens: 50_000 }),
    );
    // EXCLUSIVE shape: 200k plain + 50k cached = 250k total prompt (>= threshold).
    // premium 4/0.6/12: uncached 200k*4 + cached 50k*0.6 + out 1k*12 = 842_000 / 1e6
    expect(priced?.usd).toBeCloseTo(0.842, 10);
  });
});

describe('priceUsageUsd — refusals', () => {
  it('an UNSEEDED google id is claimed-fallback (no explicit row → null, never the pro-tier guess)', () => {
    expect(priceUsageUsd('gemini-9-future', u({ inputTokens: 1_000_000 }))).toBeNull();
  });
});

describe('priceUsageUsd — google (Gemini Interactions lane, 2026-09-03)', () => {
  it('prices gemini-3.8-flash on the verified card: 0.75 in / 0.075 cached / 3.75 out, no write bucket', () => {
    const priced = priceUsageUsd(
      'gemini-3.8-flash',
      u({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 }),
    );
    expect(priced?.provider).toBe('google');
    expect(priced?.canonicalId).toBe('gemini-3.8-flash');
    expect(priced?.usd).toBeCloseTo(0.75 + 0.075 + 3.75, 10);
  });
});

describe('luna-incident-54c8e899 — the exact class this ships to kill', () => {
  // The REAL 16 per-message rows from staging task_turn_usage for the 07-31
  // incident task (stale CAS bundle billed old Luna rates, 5x overcharge,
  // refunded). Columns: [input(incl. both breakdowns), cacheWrite, cacheRead, output].
  // These rows predate the 2026-08-04 one-convention flip, so they price through
  // legacyInclusiveInput — the same path the server uses for any unmarked wire
  // event. This suite IS the legacy path's regression pin.
  const ROWS: Array<[number, number, number, number]> = [
    [27548, 27545, 0, 115],
    [27705, 157, 27545, 80],
    [28870, 1165, 27702, 41],
    [28963, 93, 28867, 40],
    [29051, 88, 28960, 101],
    [34360, 5309, 29048, 161],
    [36343, 1983, 34357, 203],
    [36770, 427, 36340, 146],
    [39129, 2359, 36767, 163],
    [39630, 501, 39126, 306],
    [40604, 974, 39627, 192],
    [42849, 2245, 40601, 81],
    [42979, 130, 42846, 44],
    [43069, 90, 42976, 27],
    [43555, 486, 43066, 235],
    [43804, 249, 43552, 48],
  ];

  const priceAll = () =>
    ROWS.reduce((sum, [input, write, read, output]) => {
      const priced = priceUsageUsd(
        'gpt-5.6-luna',
        u({ inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write }),
        { legacyInclusiveInput: true },
      );
      expect(priced).not.toBeNull();
      return sum + priced!.usd;
    }, 0);

  it('prices the incident turn at ~$0.024 on the CURRENT (07-30 cut) table', () => {
    // Σuncached 48 * 0.2 + Σread 541,380 * 0.02 + Σwrite 43,801 * 0.25 + Σout 1,983 * 1.2
    expect(priceAll()).toBeCloseTo(0.02416705, 6);
  });

  it('is >4x below what the STALE (pre-cut) table claimed — the overcharge cannot recur', () => {
    const billedNow = priceAll();
    // The stale bundle's table (in 1 / cached 0.1 / write 1.25 / out 6) on the same counts:
    const staleClaim = (48 * 1 + 541_380 * 0.1 + 43_801 * 1.25 + 1_983 * 6) / 1_000_000;
    expect(staleClaim).toBeCloseTo(0.1208, 3);
    expect(billedNow).toBeLessThan(staleClaim / 4);
  });
});

describe('priceUsageUsd — deepseek on Fireworks (the 2026-08-17 reversal)', () => {
  const u = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  it('prices Pro EXPLICITLY on the fireworks lane — never null/claimed-fallback', () => {
    const priced = priceUsageUsd('deepseek-v4-pro', u, { atMs: Date.parse('2026-08-18T12:00:00Z') });
    expect(priced).not.toBeNull();
    expect(priced!.provider).toBe('fireworks');
    expect(priced!.usd).toBeCloseTo(1.32, 6);
  });

  it('Pro is flat at any instant — the official lane\'s peak/off-peak tiers are gone', () => {
    const peak = priceUsageUsd('deepseek-v4-pro', u, { atMs: Date.parse('2026-08-18T02:00:00Z') });
    const off = priceUsageUsd('deepseek-v4-pro', u, { atMs: Date.parse('2026-08-18T12:00:00Z') });
    expect(peak!.usd).toBeCloseTo(off!.usd, 10);
  });

  it('atMs never touches untiered rows (fireworks flash byte-identical at any instant)', () => {
    const a = priceUsageUsd('deepseek-v4-flash', u, { atMs: Date.parse('2026-08-17T02:00:00Z') });
    const b = priceUsageUsd('deepseek-v4-flash', u, { atMs: Date.parse('2026-08-17T12:00:00Z') });
    expect(a!.usd).toBeCloseTo(0.3, 6);
    expect(b!.usd).toBeCloseTo(a!.usd, 10);
    expect(a!.provider).toBe('fireworks');
  });
});

// ===========================================================================
// priceBuckets — the ONE formula core both pricers share (spec §2.3, Ruling 45)
// ===========================================================================
// Two pricers duplicated the bucket arithmetic and drifted into THREE formulas:
// priceUsageUsd's two-subtraction inclusive form, its direct exclusive form, and
// credit.service's subtract-cacheRead-only-then-add-cacheCreate hybrid. The core
// is the single place the two conventions are written down; the convention is a
// plain REQUIRED parameter here (no marker read, no assert — see Ruling 46: the
// turn lane's NormalizedTokenUsage carries no marker and must never gain one).
describe('priceBuckets — the shared formula core', () => {
  const RATES = {
    inputPerMTok: 10,
    outputPerMTok: 100,
    cachedInputPerMTok: 1,
    cacheWriteInputPerMTok: 20,
  };
  const usage = {
    inputTokens: 100_000,
    outputTokens: 1_000,
    cacheReadTokens: 60_000,
    cacheWriteTokens: 30_000,
  };

  it('EXCLUSIVE: the buckets are disjoint and price directly (no peeling)', () => {
    // 100k*10 + 1k*100 + 60k*1 + 30k*20 = 1_000_000 + 100_000 + 60_000 + 600_000
    //                                    = 1_760_000 / 1e6 = $1.76
    expect(priceBuckets(RATES, usage, { inclusiveInput: false })).toBeCloseTo(1.76, 10);
  });

  it('INCLUSIVE: cached then written are peeled OUT of input, in that order', () => {
    // cached = min(60k, 100k) = 60k; written = min(30k, 100k-60k) = 30k;
    // uncached = 100k - 60k - 30k = 10k
    // 10k*10 + 1k*100 + 60k*1 + 30k*20 = 100_000 + 100_000 + 60_000 + 600_000
    //                                   = 860_000 / 1e6 = $0.86
    expect(priceBuckets(RATES, usage, { inclusiveInput: true })).toBeCloseTo(0.86, 10);
  });

  // A cached share LARGER than the input it is supposed to be a breakdown of is
  // malformed on this convention. The peel clamps every term to what is left
  // rather than producing a negative one — and it clamps the CACHED term too, so
  // the request is billed as at most the input the provider said it saw. This is
  // the one place the core differs from credit.service's old hybrid, which billed
  // the full reported cacheRead on top of a zeroed input. Unreachable for every
  // real inclusive producer (on both wires the cached count IS a breakdown of
  // prompt/input tokens, so cacheRead <= input by construction).
  it('INCLUSIVE clamps a malformed cached > input to input, and written to what is left (never negative)', () => {
    // cached = min(90k, 10k) = 10k; written = min(50k, 10k-10k=0) = 0; uncached = 0.
    const usd = priceBuckets(
      RATES,
      { inputTokens: 10_000, outputTokens: 0, cacheReadTokens: 90_000, cacheWriteTokens: 50_000 },
      { inclusiveInput: true },
    );
    // 0*10 + 0*100 + 10k*1 + 0*20 = 10_000 / 1e6 = $0.01
    expect(usd).toBeCloseTo(0.01, 10);
  });

  it('the two conventions AGREE exactly when there are no cache buckets (the inert case)', () => {
    const bare = { inputTokens: 5_000, outputTokens: 700, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(priceBuckets(RATES, bare, { inclusiveInput: true })).toBeCloseTo(
      priceBuckets(RATES, bare, { inclusiveInput: false }),
      12,
    );
  });

  // THE BUG, in the core's own terms: an EXCLUSIVE usage read as INCLUSIVE with
  // cacheRead >= input clamps the fresh-input term to exactly zero — the whole
  // 1.4M tokens the pass actually paid for vanish from the bill. This is what
  // the reconciler lane did from the day it was armed.
  it('an exclusive usage read as inclusive with cacheRead >= input loses the WHOLE fresh-input term', () => {
    const reconcilerShaped = {
      inputTokens: 1_400_000,
      outputTokens: 0,
      cacheReadTokens: 7_000_000,
      cacheWriteTokens: 0,
    };
    const flash = { inputPerMTok: 0.22, outputPerMTok: 0.66, cachedInputPerMTok: 0.007, cacheWriteInputPerMTok: 0 };
    // Correct (the stamp the reconciler now carries): 1.4M*0.22 + 7M*0.007 = $0.357
    expect(priceBuckets(flash, reconcilerShaped, { inclusiveInput: false })).toBeCloseTo(0.357, 10);
    // Misread: cached clamps to 1.4M, uncached to 0 ⇒ 1.4M*0.007 = $0.0098.
    expect(priceBuckets(flash, reconcilerShaped, { inclusiveInput: true })).toBeCloseTo(0.0098, 10);
  });
});
