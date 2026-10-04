import { resolveCapabilities } from './model-capabilities.js';

export interface TokenPrice {
  /** USD per 1,000,000 tokens. STANDARD tier (no batch/flex/priority, no long-context surcharge). */
  inputPerMTok: number;
  cachedInputPerMTok: number;
  outputPerMTok: number;
  /**
   * Cache-WRITE rate, present only on models that bill prompt-cache writes
   * (GPT-5.6+: 1.25× the uncached input rate). ABSENT on older rows — their
   * writes bill at the standard input rate (pre-5.6 OpenAI behavior), keeping
   * existing entries byte-identical. Consume as `cacheWriteInputPerMTok ?? inputPerMTok`.
   */
  cacheWriteInputPerMTok?: number;
  /**
   * PREMIUM long-context tier — present ONLY on models whose provider re-prices
   * the ENTIRE request once the prompt crosses the registry's
   * `premiumInputThreshold` (grok: 200K — xAI: "requests whose prompt reaches
   * 200k tokens are billed at the higher rate for all tokens in the request";
   * GPT-6 / GPT-5.6: 272K — OpenAI: "Prompts with more than 272K input tokens are
   * priced at 2x input and cache rates and 1.5x output for the full request").
   * Whole-request swap, never a marginal surcharge. ABSENT on every other row —
   * existing entries byte-identical, standard rates always used.
   */
  premiumInputPerMTok?: number;
  premiumCachedInputPerMTok?: number;
  premiumOutputPerMTok?: number;
  /**
   * How the provider reads the registry's boundary. ABSENT (xAI): "requests whose
   * prompt reaches 200k tokens" — the threshold itself is premium. TRUE (OpenAI):
   * "more than 272K" — a prompt of exactly 272,000 is standard. Verified 2026-09-29
   * against the per-model pages and against prod: OpenAI's long-context cost lines
   * for 2026-09-26 equal the rows above 272,000 to the cent, rows at 278,260 and
   * 278,484 included — so the boundary is 272,000, not 272×1024.
   */
  premiumThresholdExclusive?: boolean;
  /**
   * PREMIUM cache-WRITE rate. OpenAI bills "cache writes, long context" as its own
   * cost line at 2x the standard write (per-model pages + the prod cost report,
   * 2026-09-29). Present only where the provider re-prices writes; a premium row
   * WITHOUT it keeps its standard `cacheWriteInputPerMTok` through the swap (grok
   * declares neither, so its writes follow the swapped input rate via the
   * consumers' `?? inputPerMTok` fallback — unchanged).
   */
  premiumCacheWriteInputPerMTok?: number;
  verifiedAt: string;
  sources: string[];
  /**
   * TIME-OF-DAY tiers — present ONLY on models whose provider bills by wall
   * clock (DeepSeek official: peak/off-peak from 2026-08-16T16:00Z, off-peak =
   * half peak). The row carries its own schedule and flips ITSELF at the
   * provider's cutover instant: before `effectiveAtIso` the base rates above
   * apply (history stays truthful); after it, the UTC minute-of-day picks the
   * tier. Windows are half-open [startMin, endMin). ABSENT on every other row —
   * byte-identical, `priceForModelAtInstant` returns the row by reference.
   */
  timeTiers?: {
    effectiveAtIso: string;
    peakWindowsUtc: ReadonlyArray<readonly [number, number]>;
    peak: { inputPerMTok: number; cachedInputPerMTok: number; outputPerMTok: number };
    offPeak: { inputPerMTok: number; cachedInputPerMTok: number; outputPerMTok: number };
  };
}

const V = '2026-05-30';
const SRC = ['https://openai.com/api/pricing/'];
const SRC56 = ['https://developers.openai.com/api/docs/models', 'https://openai.com/api/pricing/'];
const SRC6 = ['https://developers.openai.com/api/docs/models/gpt-6-astra', 'https://developers.openai.com/api/docs/pricing'];
const SRC6_SOL = ['https://developers.openai.com/api/docs/models/gpt-6-sol', 'https://developers.openai.com/api/docs/pricing'];
const SRC61_SOL = ['https://developers.openai.com/api/docs/models/gpt-6.1-sol', 'https://developers.openai.com/api/docs/pricing'];
const SRC6_LUNA = ['https://developers.openai.com/api/docs/models/gpt-6-luna', 'https://developers.openai.com/api/docs/pricing'];

/**
 * DeepSeek V4.1 Flash on Fireworks serverless, Standard tier: $0.30 in / $0.006 cached /
 * $1.20 out per MTok, the public card (docs.fireworks.ai/serverless/pricing).
 *
 * The row follows what Fireworks INVOICES this account: the billing summary's line items
 * (GET /v1/accounts/{id}/billing/summary, stored daily in provider_cost_daily.raw) carry
 * a unitAmount in nanos per token for each model bucket and category. "DeepSeek V4.1
 * Flash" was invoiced at 220 / 7 / 660 ($0.22 / $0.007 / $0.66, the V4 Flash 0731
 * build's price) on every day 09-15..09-30, while the public card already said $0.30 /
 * $0.006 / $1.20. On 10-01 the invoice moved to the public card: 300 / 6 / 1200. This
 * row followed on 10-03, so 10-01 until the merge billed input 27% and output 45% under
 * cost (not back-billed). The billing-truth price check (fireworksPriceCheck, server)
 * compares every invoiced unitAmount to this row and alerts the day they part.
 */
const DEEPSEEK_V41_FLASH_PRICE: TokenPrice = {
  inputPerMTok: 0.3,
  cachedInputPerMTok: 0.006,
  outputPerMTok: 1.2,
  verifiedAt: '2026-10-03',
  sources: [
    'https://docs.fireworks.ai/serverless/pricing',
    'fireworks billing summary line items (provider_cost_daily), 2026-10-01: unitAmount 300/6/1200 nanos',
  ],
};

/** Verified against openai.com/api/pricing on 2026-05-30. STANDARD tier. */
export const OPENAI_TOKEN_PRICING: Record<string, TokenPrice> = {
  // GPT-6 Astra — verified 2026-09-05 against the per-model page + the pricing
  // page: $10 in / $1 cached / $50 out per MTok, cache WRITES 1.25× input = $12.50
  // (the 5.6 family ratios: cached = 10% input, write = 1.25× input). 2.5× Sol on
  // every bucket; exactly Fable 5.1's card. The >272K long-context tier IS modeled
  // (2026-09-29, see the 5.6 note below): $20 / $2 / $25 write / $75, whole request.
  'gpt-6-astra': { inputPerMTok: 10, cachedInputPerMTok: 1, outputPerMTok: 50, cacheWriteInputPerMTok: 12.5, premiumInputPerMTok: 20, premiumCachedInputPerMTok: 2, premiumCacheWriteInputPerMTok: 25, premiumOutputPerMTok: 75, premiumThresholdExclusive: true, verifiedAt: '2026-09-29', sources: SRC6 },
  // GPT-6 Sol / Luna — launched 2026-09-23, verified that day against the per-model
  // pages: Sol $2 in / $0.20 cached / $2.50 write / $10 out, Luna $0.10 / $0.01 /
  // $0.125 / $0.50 (the family ratios again: cached = 10% input, write = 1.25×).
  // They succeed GPT-5.6 Sol and Luna in every offer and default; GPT-6 Sol also
  // succeeds 5.6 Terra, which it undercuts on every bucket. The >272K long-context
  // tier (2× input, cached AND cache writes, 1.5× output, whole request) is modeled
  // since 2026-09-29 — the 5.6 note below has the two legs that verified it.
  // Exact-key rows: priceForModel never prefix-matches, so no 'gpt-6-*' id can
  // borrow Astra's card (pinned in openai-pricing.gpt6.test.ts).
  //
  // GPT-6.1 Sol (2026-09-29) — replaces GPT-6 Sol in every offer and default
  // (2026-09-30). Verified that day against its per-model page + the pricing page:
  // the Sol card except CACHED input, which halves to $0.10 (5% of input, not the
  // family's 10%); >272K whole request $4 / $0.20 / $5 write / $15. The gpt-6-sol
  // row stays so historical and resumed tasks bill at their own rates.
  'gpt-6.1-sol': { inputPerMTok: 2, cachedInputPerMTok: 0.1, outputPerMTok: 10, cacheWriteInputPerMTok: 2.5, premiumInputPerMTok: 4, premiumCachedInputPerMTok: 0.2, premiumCacheWriteInputPerMTok: 5, premiumOutputPerMTok: 15, premiumThresholdExclusive: true, verifiedAt: '2026-09-30', sources: SRC61_SOL },
  'gpt-6-sol': { inputPerMTok: 2, cachedInputPerMTok: 0.2, outputPerMTok: 10, cacheWriteInputPerMTok: 2.5, premiumInputPerMTok: 4, premiumCachedInputPerMTok: 0.4, premiumCacheWriteInputPerMTok: 5, premiumOutputPerMTok: 15, premiumThresholdExclusive: true, verifiedAt: '2026-09-29', sources: SRC6_SOL },
  'gpt-6-luna': { inputPerMTok: 0.1, cachedInputPerMTok: 0.01, outputPerMTok: 0.5, cacheWriteInputPerMTok: 0.125, premiumInputPerMTok: 0.2, premiumCachedInputPerMTok: 0.02, premiumCacheWriteInputPerMTok: 0.25, premiumOutputPerMTok: 0.75, premiumThresholdExclusive: true, verifiedAt: '2026-09-29', sources: SRC6_LUNA },
  // GPT-5.6 family (Sol / Terra / Luna) — SUPERSEDED 2026-09-23 by GPT-6 Sol / Luna
  // (Terra retired, its successor is GPT-6 Sol). The rows stay so historical tasks
  // resume and re-price at their own rates. GA 2026-07-09, verified same day against
  // the per-model pages on developers.openai.com. Cached input = 10% of input; cache
  // WRITES bill at 1.25× input (new in 5.6 — see cacheWriteInputPerMTok).
  //
  // LONG-CONTEXT TIER (modeled 2026-09-29, GPT-6 and 5.6 alike): "Prompts with more
  // than 272K input tokens are priced at 2x input and cache rates and 1.5x output for
  // the full request" (per-model pages; the pricing page lists the four long-context
  // columns per model, cache writes included). Two legs: (1) those pages; (2) the
  // prod cost report — OpenAI's "…, long context" lines for gpt-6-luna on 2026-09-26
  // ($0.151 writes / $0.062 cached / $0.011 output) equal the task_turn_usage rounds
  // whose total prompt exceeded 272,000, repriced at exactly these multiples, to the
  // cent (rows at 278,260 and 278,484 inside the match ⇒ the cliff is 272,000, not
  // 272×1024). Until then every request past the cliff billed at STANDARD rates
  // ($8.3 short over 17 prod days; $3.16 on 09-27 alone). The swap keys on the TOTAL
  // prompt the provider saw (uncached + cached + written) — priceForModelAtPromptSize.
  //
  // ⚠️ PROMOTIONAL, NOT PERMANENT. Sol cut 2026-08-21 (announced) from $5/$30 to
  // $4/$20 (cached 0.5→0.4, cache-write 6.25→5.0 — both keep the family ratios:
  // cached = 10% input, cache-write = 1.25× input). OpenAI's own words: "GPT-5.6
  // Sol's promotional pricing is available at least through November 21, 2026."
  // Deliberately NOT modeled as an auto-expiring tier — "at least through" is
  // open-ended, so a scheduled revert would be a guess that silently OVER-charges
  // the day OpenAI extends it.
  // 🔴 RE-VERIFY from ~2026-11-21: if the promo lapses this row must return to
  // $5/$30, or we eat the difference on every Sol turn.
  'gpt-5.6-sol': { inputPerMTok: 4, cachedInputPerMTok: 0.4, outputPerMTok: 20, cacheWriteInputPerMTok: 5, premiumInputPerMTok: 8, premiumCachedInputPerMTok: 0.8, premiumCacheWriteInputPerMTok: 10, premiumOutputPerMTok: 30, premiumThresholdExclusive: true, verifiedAt: '2026-09-29', sources: SRC56 },
  // Terra re-priced 2026-07 (input 2.5→2, cached 0.25→0.2, output 15→12; cache-write
  // 1.25× input = 2.5). Verified 2026-07-31 against the per-model page.
  'gpt-5.6-terra': { inputPerMTok: 2, cachedInputPerMTok: 0.2, outputPerMTok: 12, cacheWriteInputPerMTok: 2.5, premiumInputPerMTok: 4, premiumCachedInputPerMTok: 0.4, premiumCacheWriteInputPerMTok: 5, premiumOutputPerMTok: 18, premiumThresholdExclusive: true, verifiedAt: '2026-09-29', sources: SRC56 },
  // Luna re-priced ~80% down on 2026-07-30 (input 1→0.2, cached 0.1→0.02, output
  // 6→1.2; cache-write stays 1.25× input = 0.25). Verified 2026-07-31 against the
  // per-model page. cached = 10% input, cache-write = 1.25× input (both unchanged ratios).
  'gpt-5.6-luna': { inputPerMTok: 0.2, cachedInputPerMTok: 0.02, outputPerMTok: 1.2, cacheWriteInputPerMTok: 0.25, premiumInputPerMTok: 0.4, premiumCachedInputPerMTok: 0.04, premiumCacheWriteInputPerMTok: 0.5, premiumOutputPerMTok: 1.8, premiumThresholdExclusive: true, verifiedAt: '2026-09-29', sources: SRC56 },
  // Superseded GPT-5.4/5.5 rows stay for historical-task billing (resume + re-price).
  'gpt-5.4-mini': { inputPerMTok: 0.75, cachedInputPerMTok: 0.075, outputPerMTok: 4.5, verifiedAt: V, sources: SRC },
  'gpt-5.4': { inputPerMTok: 2.5, cachedInputPerMTok: 0.25, outputPerMTok: 15, verifiedAt: V, sources: SRC },
  'gpt-5.5': { inputPerMTok: 5, cachedInputPerMTok: 0.5, outputPerMTok: 30, verifiedAt: V, sources: SRC },
  // GLM 5.2 on Fireworks serverless (Standard tier) — rides this same OpenAI-rate-card
  // path via the Chat Completions transport. Keyed by the SHORT canonical id (the long
  // accounts/fireworks/models/glm-5p2 wire slug is applied at the wire boundary, so the
  // pricing key stays this short id). Fireworks serverless Standard pricing (verified
  // 2026-06-30): $1.40 input / $0.14 cached-input / $4.40 output per M. Fireworks uses
  // the OpenAI INCLUDE convention (prompt_tokens includes cached, via
  // prompt_tokens_details.cached_tokens), so the SUBTRACTIVE computeOpenAIResponsesCostUsd
  // is convention-correct. NOTE: the cached rate is $0.14 on Fireworks (the prior Z.ai
  // lane billed cached at $0.26); input + output are unchanged.
  'glm-5.2': {
    inputPerMTok: 1.4,
    cachedInputPerMTok: 0.14,
    outputPerMTok: 4.4,
    verifiedAt: '2026-06-30',
    sources: ['https://docs.fireworks.ai/serverless/pricing'],
  },
  // DeepSeek V4 on Fireworks serverless (Standard tier) — ride this OpenAI-rate-card
  // path via the Chat Completions transport. Keyed by the SHORT canonical id (the
  // long accounts/fireworks/models/... wire slug is applied at the wire boundary, so
  // the pricing key stays this short id). Fireworks uses the OpenAI INCLUDE
  // convention (prompt_tokens includes cached, via prompt_tokens_details.cached_tokens),
  // so the SUBTRACTIVE computeOpenAIResponsesCostUsd is convention-correct. Rates from
  // docs.fireworks.ai/serverless/pricing (cached = input/12 Pro, input/5 Flash).
  // REVERSAL 2026-08-17: Pro returned to Fireworks serving (the direct DeepSeek
  // lane was removed for Google Limited Use compliance), so rates follow the
  // SERVING provider back to the Fireworks serverless Standard card — verified
  // 2026-08-17 against docs.fireworks.ai/serverless/pricing (same values as the
  // pre-cutover era). The official-API era's rates (incl. its 08-16 peak/off-peak
  // tiers) live in the ledger rows written while it served; entry replacement is
  // the house pattern for serving changes (cf. the Luna re-price).
  // RE-PRICE 2026-10-03 to the INVOICE: the 0813 build was never billed at the docs
  // card above ($1.74 / $0.145 / $3.48). The billing summary's "DeepSeek V4 Pro 0813"
  // line items carry unitAmount 1320 / 44 / 3960 nanos per token on every day it ran
  // (08-22, 08-23, 08-27, 09-23), and the public card no longer lists V4 Pro (read
  // 2026-10-03). The old row over-charged input and cache hits and under-charged output.
  'deepseek-v4-pro': {
    inputPerMTok: 1.32,
    cachedInputPerMTok: 0.044,
    outputPerMTok: 3.96,
    verifiedAt: '2026-10-03',
    sources: ['fireworks billing summary line items (provider_cost_daily), 2026-08-22..2026-09-23: unitAmount 1320/44/3960 nanos'],
  },
  // RE-PRICE 2026-08-22T12:00Z (Fireworks serverless mail + docs card): Flash leaves
  // the DSV4 *preview* rate for the DSV4 off-peak rate, applied FLAT to Fireworks
  // Serverless (no peak/off-peak windows — the timeTiers mechanism stays absent).
  // NOT a cut for our shape: uncached input +57% (0.14→0.22) and output +136%
  // (0.28→0.66); only cache-hits fall (0.028→0.007, -75%), so the mail's "~40%
  // reduction" holds for cache-heavy prompts and inverts for output-heavy ones.
  // Entry replacement is the house pattern for serving changes (see the Pro row):
  // ledger rows written before the cutover keep the old rate, so history stays true.
  //
  // RETIRED BY FIREWORKS 2026-09-26 (its 0731 build answers 404): the id now rides
  // V4.1 Flash's wire (contract/fireworks-wire.ts), so it bills at V4.1 Flash's card,
  // by reference, never a copy. Both builds were invoiced at the same unit amounts
  // on every day they overlapped (09-20..09-26), so no ledger row moves.
  'deepseek-v4-flash': DEEPSEEK_V41_FLASH_PRICE,
  'deepseek-v4.1-flash': DEEPSEEK_V41_FLASH_PRICE,
  // Muse Spark 1.1 — Meta Model API direct lane (meta provider), rides this same
  // OpenAI-rate-card path via the Responses transport. Meta uses the OpenAI INCLUDE
  // convention (input_tokens includes the cached breakdown), so the SUBTRACTIVE
  // computeOpenAIResponsesCostUsd is convention-correct. Verified 2026-07-15.
  // Muse Spark 1.3 CONTRIBUTOR — the offered Muse since 2026-09-03. Meta's
  // contributor tier: "Heavily discounted token pricing in exchange for permission
  // to use your prompts and completions to train future Meta models". Same
  // INCLUDE convention + subtractive calc as 1.1. Verified 2026-09-03 against the
  // pricing page (Standard 1.3 is unchanged at 1.25 / 0.15 / 4.25).
  'muse-spark-1.3-contributor': {
    inputPerMTok: 0.1,
    cachedInputPerMTok: 0.002,
    outputPerMTok: 0.2,
    verifiedAt: '2026-09-03',
    sources: [
      'https://dev.meta.ai/docs/pricing-rate-limits',
      'https://dev.meta.ai/docs/models/',
    ],
  },
  // Muse Spark 1.3 STANDARD — the contributor row's `unavailableSibling` (never
  // offered; a sibling round is BILLED at the contributor price, this row is what
  // Meta charges us for it). Verified 2026-09-05 against dev.meta.ai/docs/pricing-rate-limits:
  // $1.25 in / $0.15 cached / $4.25 out per MTok. Same INCLUDE convention as 1.1.
  'muse-spark-1.3': {
    inputPerMTok: 1.25,
    cachedInputPerMTok: 0.15,
    outputPerMTok: 4.25,
    verifiedAt: '2026-09-05',
    sources: ['https://dev.meta.ai/docs/pricing-rate-limits'],
  },
  'muse-spark-1.1': {
    inputPerMTok: 1.25,
    cachedInputPerMTok: 0.15,
    outputPerMTok: 4.25,
    verifiedAt: '2026-07-15',
    sources: [
      'https://ai.meta.com/blog/introducing-muse-spark-meta-model-api/',
      'https://dev.meta.ai/docs/getting-started/overview/',
    ],
  },
  // Grok 4.5 — xAI direct lane (xai provider) via the Chat Completions transport.
  // STANDARD (<200K prompt) tier here; the ≥200K premium whole-request tier is
  // added by the premium-tier mechanism (see priceForModelAtPromptSize).
  // CACHED re-priced by xAI around the 4.6 release: $0.50→$0.30 standard,
  // $1.00→$0.60 premium (docs.x.ai verbatim 2026-08-13, corroborated by the
  // wire's own cost_in_usd_ticks: 115×$2 + 384×$0.30 + 25×$6 = the exact
  // charge). Input/output unchanged.
  'grok-4.5': {
    inputPerMTok: 2,
    cachedInputPerMTok: 0.3,
    outputPerMTok: 6,
    premiumInputPerMTok: 4,
    premiumCachedInputPerMTok: 0.6,
    premiumOutputPerMTok: 12,
    verifiedAt: '2026-08-13',
    sources: ['https://docs.x.ai/developers/models/grok-4.5'],
  },
  // Grok 4.6 — same rates and premium structure as 4.5 (xAI held the price at the
  // 08-12 release). Verified 2026-08-13 against the OpenRouter endpoints oracle
  // ($2/$0.50/$6 standard; $4/$1/$12 whole-request once the prompt reaches 200K).
  'grok-4.6': {
    inputPerMTok: 2,
    cachedInputPerMTok: 0.5,
    outputPerMTok: 6,
    premiumInputPerMTok: 4,
    premiumCachedInputPerMTok: 1,
    premiumOutputPerMTok: 12,
    verifiedAt: '2026-08-13',
    sources: [
      'https://docs.x.ai/developers/models/grok-4.6',
      'https://openrouter.ai/x-ai/grok-4.6',
    ],
  },
  // Grok 4.7 — the 4.6 card exactly: $2/$0.50/$6 standard, $4/$1/$12 whole-request
  // once the prompt reaches 200K (docs.x.ai model page, verified 2026-09-29).
  'grok-4.7': {
    inputPerMTok: 2,
    cachedInputPerMTok: 0.5,
    outputPerMTok: 6,
    premiumInputPerMTok: 4,
    premiumCachedInputPerMTok: 1,
    premiumOutputPerMTok: 12,
    verifiedAt: '2026-09-29',
    sources: ['https://docs.x.ai/developers/models/grok-4.7'],
  },
};

/**
 * The fail-closed estimate for an id no row matches: the per-bucket MAXIMUM across
 * every known row, computed once at module load.
 *
 * Was a hardcoded pointer at the `gpt-5.6-sol` row, which satisfied the "never
 * under-charge an unknown id" contract only while Sol HAPPENED to be the priciest
 * row. OpenAI's 2026-08-21 promotional cut ($5/$30 → $4/$20) broke exactly that
 * coincidence — the superseded `gpt-5.5` row stayed at $5/$30, so the fallback
 * silently became a 20-33% UNDER-charge on ids we cannot identify. Deriving the
 * bound instead of naming a row keeps the guarantee true through the next
 * re-price; the pricing-coverage tripwire asserts it per bucket.
 *
 * Per-BUCKET (not "the most expensive row"): buckets move independently across
 * providers, so the safe bound is the max of each, even if no single real model
 * charges all of them. This is an ESTIMATE for an unknown id — over-stating is the
 * safe direction; ledger writes never use it (priceUsageUsd returns null instead).
 */
const FAIL_CLOSED_PRICE: TokenPrice = (() => {
  const rows = Object.values(OPENAI_TOKEN_PRICING);
  const max = (pick: (r: TokenPrice) => number) => Math.max(...rows.map(pick));
  return {
    inputPerMTok: max((r) => r.inputPerMTok),
    cachedInputPerMTok: max((r) => r.cachedInputPerMTok),
    outputPerMTok: max((r) => r.outputPerMTok),
    // A row without an explicit cache-write rate bills writes at its input rate
    // (the ?? fallback the transports use), so fold that in rather than skipping it.
    cacheWriteInputPerMTok: max((r) => r.cacheWriteInputPerMTok ?? r.inputPerMTok),
    verifiedAt: 'derived',
    sources: ['derived: per-bucket max of OPENAI_TOKEN_PRICING (fail-closed, unknown id)'],
  };
})();

/**
 * Price for a model id; FAILS CLOSED to the per-bucket max price on an unknown id — never $0.
 *
 * WHAT THE MAX STILL GUARDS (2026-10-03). Prod 2026-10-01 billed Sol task rounds from a
 * runner's max claim ($17.74 against $3.68 at the card) because config named a model the
 * server's own card lacked. Now no config can serve such a model (the server's serving-model
 * guard), and a runner adopts the server's rows on the lease beat, so on a billed turn this
 * fallback is unreachable in normal operation. It stays as the last resort for a model that
 * reaches a runner some other way, and the server pages `billing_unpriced_model` whenever it
 * bills such a claim (turn-reprice.service), so it is never quiet again.
 */
export function priceForModel(model: string): TokenPrice {
  return OPENAI_TOKEN_PRICING[model] ?? FAIL_CLOSED_PRICE;
}

/**
 * True when `priceForModel(model)` falls to FAIL_CLOSED_PRICE — the RAW id has no row
 * in the live (adoptable) table. Defined AS that lookup, so pricing and flagging cannot
 * disagree. A price at the fail-closed max is an estimate for an id we cannot name, and
 * no stop gate may act on it (live-spend.ts). Deliberately NOT the biller's question
 * (priceUsageUsd resolves aliases through the capabilities table first): an alias the
 * biller folds onto a known row still priced HERE at the max, 100× in the worst case.
 */
export function pricesAtFailClosed(model: string): boolean {
  return priceForModel(model) === FAIL_CLOSED_PRICE;
}

// ── The price book the server bills with ─────────────────────────────────────
//
// The server and a runner run different builds of this table: the server deploys
// first, a runner converges at its next idle boundary. A model shipped in between
// is UNKNOWN to the runner, and an unknown id fails closed to the table's max —
// safe for an estimate, lethal for a gate. Prod 09-23, task fee1bd62: a $0.11
// gpt-6-luna turn read $11.05 on the runner's live-spend ledger and the $10
// per-turn ceiling stopped it mid-work, while the server billed $0.11 from its
// own, newer row. So the price that gates must be the price that bills: the
// server hands its book to the runner on the lease beat whenever the
// fingerprints differ (runner-lease-routes / runner/price-book), and the runner
// adopts it into THIS table — every lookup reads it, no call site changes.

/** A short, order-independent name for a price book — the same function runs on
 *  both sides of the beat, so equal books always agree. Pure JS (FNV-1a over a
 *  key-sorted serialization): this contract is imported where node:crypto is not. */
export function priceBookFingerprint(book: Record<string, TokenPrice>): string {
  const canonical = (v: unknown): string =>
    v !== null && typeof v === 'object'
      ? Array.isArray(v)
        ? `[${v.map(canonical).join(',')}]`
        : `{${Object.keys(v)
            // An undefined field does not survive JSON transit, so it is not part of the book.
            .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
            .join(',')}}`
      : JSON.stringify(v);
  const text = canonical(book);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `pb1-${(h >>> 0).toString(16).padStart(8, '0')}-${Object.keys(book).length}`;
}

const isRate = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** Adopt the server's rows into this table (server row wins; ids only the runner
 *  knows stay). A row whose rates are not finite non-negative numbers is refused:
 *  a NaN price would make every round's cost NaN, which the live ledger drops —
 *  blinding the very gates this exists to keep honest. Returns the rows adopted. */
export function adoptPriceBook(book: Record<string, TokenPrice>): number {
  let adopted = 0;
  for (const [model, row] of Object.entries(book)) {
    if (!row || !isRate(row.inputPerMTok) || !isRate(row.cachedInputPerMTok) || !isRate(row.outputPerMTok)) continue;
    if (row.cacheWriteInputPerMTok !== undefined && !isRate(row.cacheWriteInputPerMTok)) continue;
    OPENAI_TOKEN_PRICING[model] = row;
    adopted += 1;
  }
  return adopted;
}

/**
 * The effective rate at a wall-clock instant. Rows without `timeTiers` return
 * BY REFERENCE (byte-identical); rows with tiers price flat until the
 * provider's `effectiveAtIso`, then by UTC minute-of-day window membership.
 * Call with the REQUEST's time (the server's ledger-write repricer passes its
 * write instant — minutes from the request, and a turn straddling a boundary
 * bills at the write-side tier, which is the same rounding the provider's own
 * per-request clock applies to us).
 */
export function priceForModelAtInstant(model: string, atMs: number): TokenPrice {
  const base = priceForModel(model);
  const tiers = base.timeTiers;
  if (tiers === undefined) return base;
  if (atMs < Date.parse(tiers.effectiveAtIso)) return base;
  const d = new Date(atMs);
  const minuteOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
  const peak = tiers.peakWindowsUtc.some(([start, end]) => minuteOfDay >= start && minuteOfDay < end);
  const tier = peak ? tiers.peak : tiers.offPeak;
  return {
    ...base,
    inputPerMTok: tier.inputPerMTok,
    cachedInputPerMTok: tier.cachedInputPerMTok,
    outputPerMTok: tier.outputPerMTok,
  };
}

/**
 * The effective rate for a request whose prompt is `promptTokens` (TOTAL input
 * tokens INCLUDING the cached and written breakdowns — the OpenAI convention, which
 * is also how xAI counts "the prompt"). Swaps in the premium tier only when the row
 * declares premium rates AND the registry threshold is set and crossed — whole-
 * request repricing, never a blend. The row also says HOW the provider reads the
 * boundary: xAI's "reaches 200k" makes the threshold itself premium; OpenAI's
 * "more than 272K" (`premiumThresholdExclusive`) leaves exactly 272,000 at
 * standard. Every other model returns its row unchanged (byte-identical billing).
 */
export function priceForModelAtPromptSize(model: string, promptTokens: number): TokenPrice {
  const base = priceForModel(model);
  if (base.premiumInputPerMTok === undefined) return base;
  const threshold = resolveCapabilities(model).premiumInputThreshold;
  if (threshold === undefined) return base;
  const premium = base.premiumThresholdExclusive ? promptTokens > threshold : promptTokens >= threshold;
  if (!premium) return base;
  return {
    ...base,
    inputPerMTok: base.premiumInputPerMTok,
    cachedInputPerMTok: base.premiumCachedInputPerMTok ?? base.cachedInputPerMTok,
    outputPerMTok: base.premiumOutputPerMTok ?? base.outputPerMTok,
    // OpenAI bills long-context cache WRITES as their own line; a row without a
    // premium write rate keeps its standard one (grok declares none at all ⇒ the
    // consumers' `?? inputPerMTok` fallback follows the swapped input rate, as before).
    ...(base.premiumCacheWriteInputPerMTok !== undefined && { cacheWriteInputPerMTok: base.premiumCacheWriteInputPerMTok }),
  };
}

// ── Priced per call or per embedded token, beside the token rows ─────────────
//
// The composer's provider web search and its catalog embedder bill on OpenAI's
// invoice like any model round, so they are priced from this card too: never a
// hardcoded figure at a call site (the composer charged a flat $0.03 per search
// against OpenAI's $0.01), and never unmetered (the embedder had no meter at all).

const SRC_TOOLS = ['https://developers.openai.com/api/docs/pricing'];

/**
 * OpenAI's built-in web search tool, USD per call. The pricing page (read 2026-10-03):
 * "$10.00 / 1k calls" for reasoning models, whose search content tokens bill at the
 * model's own rates and so already sit inside the response's usage; "$25.00 / 1k
 * calls" for non-reasoning models, whose content tokens are free. Prod's OpenAI cost
 * report for 2026-10-01 bills gpt-6.1-sol's searches at exactly $0.01 each.
 */
export const OPENAI_WEB_SEARCH_PRICING = {
  reasoningPerCallUsd: 0.01,
  nonReasoningPerCallUsd: 0.025,
  verifiedAt: '2026-10-03',
  sources: SRC_TOOLS,
} as const;

/** One web search call's price on `model`, or null when the card has no row for that
 *  model's searches (a non-OpenAI model, or an OpenAI id the token card cannot name). */
export function webSearchCallUsd(model: string): number | null {
  const caps = resolveCapabilities(model);
  if (caps.provider !== 'openai' || !OPENAI_TOKEN_PRICING[caps.id]) return null;
  return caps.thinking.mode === 'reasoning'
    ? OPENAI_WEB_SEARCH_PRICING.reasoningPerCallUsd
    : OPENAI_WEB_SEARCH_PRICING.nonReasoningPerCallUsd;
}

/** OpenAI embedding models, USD per 1M input tokens (the pricing page, read 2026-10-03:
 *  text-embedding-3-small "$0.02" per 1M tokens, no cached rate). */
export const OPENAI_EMBEDDING_PRICING: Readonly<Record<string, { inputPerMTok: number; verifiedAt: string; sources: string[] }>> = {
  'text-embedding-3-small': { inputPerMTok: 0.02, verifiedAt: '2026-10-03', sources: SRC_TOOLS },
};

/** What embedding `tokens` cost on `model`, or null when the card has no row for it. */
export function embeddingUsd(model: string, tokens: number): number | null {
  const row = OPENAI_EMBEDDING_PRICING[model];
  return row ? (tokens * row.inputPerMTok) / 1_000_000 : null;
}
