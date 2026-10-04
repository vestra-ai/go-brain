/**
 * usage-pricing.ts — the merchant-of-record pricer (L1 server re-price;
 * bash-notes/billing-reprice-wake-converge-spec-2026-07-31.md).
 *
 * Pure (model id + token counts) → USD against THIS build's rate cards. The server
 * calls it at ledger-write time so a stale runner bundle's price table can never set
 * the billed amount; the runner's transports may share it for their own estimates.
 * Living in the agent-sdk contract means the server deploy and the agent bundle
 * compile the SAME formulas — only table freshness can differ, never the math.
 *
 * EXPLICIT ROWS ONLY. Every branch that cannot name its exact rate returns `null`
 * and the caller bills the runner-claimed USD instead (loudly, with telemetry).
 * This deliberately does NOT use priceForModel's fail-closed-to-Sol fallback or the
 * anthropic Sonnet DEFAULT: those exist for estimates/reserves, where over-guessing
 * is safe. A ledger charge at a guessed rate is a wrong charge in either direction.
 *
 * Token-count semantics are the WIRE conventions, per provider (mirrors
 * priceTokenUsage / computeOpenAIResponsesCostUsd, audit BILL-03):
 *  - anthropic: buckets are DISJOINT (inputTokens excludes cache read/write) — additive;
 *  - openai/fireworks/meta/xai: inputTokens INCLUDES BOTH the cached AND the
 *    cache-write breakdowns (verified live 2026-07-10: written ⊆ input; re-verified
 *    against the 07-31 Luna incident rows where every message nets input − read −
 *    written = its plain remainder) — the formula below mirrors
 *    computeOpenAIResponsesCostUsd byte-for-byte so claimed-vs-server drift can only
 *    ever mean TABLE drift, never formula drift;
 *  - outputTokens already includes reasoning tokens (providers bill them as output —
 *    never price a reasoning bucket separately);
 *  - orchestration buckets are the CALLER's job: fold them into the standard buckets
 *    before calling iff they are additive on the wire (see normalizeAgentUsage on the
 *    server), so this contract stays provider-shape-only.
 */
import { resolveCapabilities } from './model-capabilities.js';
import { resolveGeminiRate } from './gemini-pricing.js';
import {
  OPENAI_TOKEN_PRICING,
  priceForModelAtInstant,
  priceForModelAtPromptSize,
} from './openai-pricing.js';
import { priceAnthropicUsageAtRate, resolveFamilyRate } from '../engine/native-pricing.js';
import { billCacheWrite1hEnabled } from '../policy/feature-flags.js';

const M = 1_000_000;

export interface NormalizedTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Aggregate cache-creation tokens (always known). */
  cacheWriteTokens: number;
  /** Anthropic ephemeral split, when the wire carried it. When either field is
   *  positive the split is authoritative and the aggregate is ignored (never both). */
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
}

/**
 * BILL_CACHE_WRITE_1H_V1: the token usage a server CHARGE prices (the turn re-price and the off-loop
 * charge). Off, the 5m/1h split is left out, so every cache write prices at the 5-minute rate, the
 * charge prod has always made; on, the usage as recorded, so a 1-hour write charges 2x input. The
 * runner's claim reads the same flag (engine/native-pricing.ts chargeableAnthropicUsage), so the two
 * agree in both states. Never for the price check against the provider's own cost report or for
 * telemetry: those price the truth, priceUsageUsd on the usage as recorded.
 */
export function chargeableTokenUsage(u: NormalizedTokenUsage): NormalizedTokenUsage {
  if ((u.cacheWrite5mTokens === undefined && u.cacheWrite1hTokens === undefined) || billCacheWrite1hEnabled()) return u;
  const { cacheWrite5mTokens: _5m, cacheWrite1hTokens: _1h, ...charged } = u;
  return charged;
}

/** Per-Mtok rates for the four buckets, injected by the caller — this core never
 *  looks a rate up, so the registry lane and the `pricing_config` DB lane can
 *  share the arithmetic without either inheriting the other's rate source. */
export interface BucketRates {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok: number;
  cacheWriteInputPerMTok: number;
}

/** The four token counts every lane's usage reduces to. */
export interface BucketUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * The disjoint buckets. On the INCLUSIVE convention `inputTokens` CONTAINS the
 * cached and written shares, so they are peeled off in order (cached first,
 * then written out of what remains) and each `min` clamps a malformed wire
 * reading rather than producing a negative term. On EXCLUSIVE the buckets are
 * already disjoint and this is the identity.
 */
function splitInputBuckets(u: BucketUsage, inclusiveInput: boolean): { uncached: number; cached: number; written: number } {
  if (!inclusiveInput) return { uncached: u.inputTokens, cached: u.cacheReadTokens, written: u.cacheWriteTokens };
  const cached = Math.min(u.cacheReadTokens, u.inputTokens);
  const written = Math.min(u.cacheWriteTokens, u.inputTokens - cached);
  return { uncached: u.inputTokens - cached - written, cached, written };
}

/**
 * THE one formula core, shared by both pricers (spec §2.3, Ruling 45).
 *
 * Before this existed there were THREE formulas for one question: this file's
 * exclusive form, this file's two-subtraction inclusive form, and
 * credit.service's hybrid (subtract cacheRead only, then bill cacheCreate
 * additively on top) — which matched neither lane. Two pricers may keep their
 * own RATE SOURCES (the registry here, `pricing_config` on the server), but the
 * arithmetic is written down exactly once.
 *
 * The convention is a plain REQUIRED PARAMETER, never a marker this function
 * reads off the usage, and there is deliberately NO assert here (Ruling 46): the
 * turn lane's `NormalizedTokenUsage` carries no marker field, and a throw on
 * this path would poison `repriceAgentUsageMessage` to claimed-fallback for the
 * entire turn fleet — a far worse, and invisible, failure than the one the
 * marker fixes. The assert belongs to `priceTokenUsage` alone.
 */
export function priceBuckets(rates: BucketRates, u: BucketUsage, opts: { inclusiveInput: boolean }): number {
  const { uncached, cached, written } = splitInputBuckets(u, opts.inclusiveInput);
  return (
    (uncached * rates.inputPerMTok +
      u.outputTokens * rates.outputPerMTok +
      cached * rates.cachedInputPerMTok +
      written * rates.cacheWriteInputPerMTok) /
    M
  );
}

export interface PricedUsage {
  usd: number;
  provider: string;
  /** The registry-canonical id the rate row was keyed by (aliases resolved). */
  canonicalId: string;
}

export interface PriceUsageOpts {
  /**
   * The wire event predates the 2026-08-04 one-convention flip: its
   * inputTokens INCLUDES the cached/write breakdowns (old OpenAI-family
   * sandboxes emit this until auto-upgrade retires them). Reproduces the
   * pre-flip subtraction math so historical/straggler events reprice
   * identically. Never set for Anthropic events (always exclusive).
   */
  legacyInclusiveInput?: boolean;
  /**
   * Wall-clock instant for TIME-TIERED rows (DeepSeek official peak/off-peak,
   * effective 2026-08-16T16:00Z). The server's ledger-write repricer passes its
   * write instant; absent, the pricer uses `Date.now()` — a deliberate impurity,
   * because a missing timestamp must bill the CURRENT tier, never a stale flat
   * rate. Untiered rows ignore it entirely (byte-identical).
   */
  atMs?: number;
}

/**
 * A re-price layered OVER the card: per-Mtok rates that replace the card's for one model
 * (canonical id), any bucket left out keeping the card's. The server installs one that
 * reads `pricing_config`'s `model:<id>:*` rows, the founder's no-deploy re-price lever, so
 * a row moves every ledger lane at once (task turns, composer, background). The layer can
 * only RE-price a model the card already names: it never makes an unpriceable model
 * priceable, so the explicit-row gate below is the card's alone. A runner installs none.
 */
export interface RateOverride {
  inputPerMTok?: number;
  outputPerMTok?: number;
  cachedInputPerMTok?: number;
  cacheWriteInputPerMTok?: number;
}
export type RateOverrideLayer = (canonicalId: string) => RateOverride | undefined;

let overrideLayer: RateOverrideLayer | null = null;

/** Install (or with null, remove) the process's override layer. */
export function setRateOverrideLayer(layer: RateOverrideLayer | null): void {
  overrideLayer = layer;
}

/** null = cannot price EXPLICITLY — the caller must fall back to the claimed USD. */
export function priceUsageUsd(modelId: string, u: NormalizedTokenUsage, opts?: PriceUsageOpts): PricedUsage | null {
  const caps = resolveCapabilities(modelId);

  if (caps.provider === 'anthropic') {
    const fam = resolveFamilyRate(modelId);
    if (fam.isDefault) return null;
    const o = overrideLayer?.(caps.id);
    const rate = o
      ? {
          in: o.inputPerMTok ?? fam.rate.in,
          out: o.outputPerMTok ?? fam.rate.out,
          cacheRead: o.cachedInputPerMTok ?? fam.rate.cacheRead,
          cacheWrite: o.cacheWriteInputPerMTok ?? fam.rate.cacheWrite,
        }
      : fam.rate;
    // The SAME formula the runner claims with (priceAnthropicUsageAtRate): a 1-hour
    // cache write bills 2x input, a 5-minute write 1.25x, and the wire's split is
    // authoritative over the aggregate whenever either half is positive. Only the
    // rate row can differ between the two lanes, never the arithmetic.
    const hasSplit = (u.cacheWrite5mTokens ?? 0) > 0 || (u.cacheWrite1hTokens ?? 0) > 0;
    const usd = priceAnthropicUsageAtRate(rate, {
      input_tokens: u.inputTokens,
      output_tokens: u.outputTokens,
      cache_read_input_tokens: u.cacheReadTokens,
      cache_creation_input_tokens: u.cacheWriteTokens,
      ...(hasSplit
        ? {
            cache_creation: {
              ephemeral_5m_input_tokens: u.cacheWrite5mTokens ?? 0,
              ephemeral_1h_input_tokens: u.cacheWrite1hTokens ?? 0,
            },
          }
        : {}),
    });
    return { usd, provider: caps.provider, canonicalId: caps.id };
  }

  if (
    caps.provider === 'openai' ||
    caps.provider === 'fireworks' ||
    caps.provider === 'meta' ||
    caps.provider === 'xai' ||
    // Joined at the 2026-08-13 official-API cutover. Its absence here silently
    // disengaged the L1 rail for Pro turns (null → claimed-fallback) — the exact
    // "skipped every legacy row" failure class this comment now guards against.
    caps.provider === 'deepseek'
  ) {
    // Unknown ids resolve to a fallback caps whose `id` is the raw string — absent
    // from the rate card by construction, so this lookup IS the explicit-match gate.
    if (!OPENAI_TOKEN_PRICING[caps.id]) return null;
    // ONE-CONVENTION (2026-08-04): inputTokens is EXCLUSIVE on the current wire;
    // buckets price directly, mirroring computeOpenAIResponsesCostUsd exactly so
    // claimed-vs-server drift can only ever mean TABLE drift, never formula
    // drift. `legacyInclusiveInput` reproduces the pre-flip subtraction for
    // events from not-yet-upgraded sandboxes (see PriceUsageOpts).
    const inclusiveInput = opts?.legacyInclusiveInput === true;
    const split = splitInputBuckets(u, inclusiveInput);
    // Two whole-request swap mechanisms, one row each (no row carries both):
    //   - TIME tiers (deepseek official peak/off-peak) — picked by wall clock;
    //   - PREMIUM size tier (grok-4.5 ≥272K) — keyed on the TOTAL prompt the
    //     provider saw (uncached + both breakdowns in EITHER convention).
    const base = OPENAI_TOKEN_PRICING[caps.id];
    const row = base.timeTiers
      ? priceForModelAtInstant(caps.id, opts?.atMs ?? Date.now())
      : priceForModelAtPromptSize(caps.id, split.uncached + split.cached + split.written);
    // The convention this lane declares is `legacyInclusiveInput` — an OPTION
    // this function already owned, not a marker on the usage. NormalizedTokenUsage
    // carries no marker and must never gain one (Ruling 46), so the signature and
    // both callers are untouched; only the arithmetic moved into the shared core.
    const o = overrideLayer?.(caps.id);
    const usd = priceBuckets(
      {
        inputPerMTok: o?.inputPerMTok ?? row.inputPerMTok,
        outputPerMTok: o?.outputPerMTok ?? row.outputPerMTok,
        cachedInputPerMTok: o?.cachedInputPerMTok ?? row.cachedInputPerMTok,
        cacheWriteInputPerMTok: o?.cacheWriteInputPerMTok ?? row.cacheWriteInputPerMTok ?? row.inputPerMTok,
      },
      u,
      { inclusiveInput },
    );
    return { usd, provider: caps.provider, canonicalId: caps.id };
  }

  if (caps.provider === 'google') {
    // The Gemini Interactions lane (2026-09-03). Same pure rate table the transport
    // bills from (contract/gemini-pricing.ts), so claimed-vs-server drift can only
    // ever mean TABLE drift. Three buckets: Google's implicit cache sells no write
    // (cacheWriteTokens is always 0 on this wire). The lane is post-convention, so
    // inputTokens is EXCLUSIVE of the cached bucket by construction; the legacy
    // inclusive option still applies for symmetry with the OpenAI-family arm.
    const g = resolveGeminiRate(caps.id);
    if (g.isFallback) return null;
    const split = splitInputBuckets(u, opts?.legacyInclusiveInput === true);
    const o = overrideLayer?.(caps.id);
    const usd =
      (split.uncached * (o?.inputPerMTok ?? g.price.inPerM) +
        split.cached * (o?.cachedInputPerMTok ?? g.price.cachedPerM) +
        u.outputTokens * (o?.outputPerMTok ?? g.price.outPerM)) /
      M;
    return { usd, provider: caps.provider, canonicalId: caps.id };
  }

  // Any future provider: claimed-fallback.
  return null;
}

const NO_TOKENS: NormalizedTokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/**
 * Can THIS build's card price `modelId` explicitly? Defined AS the ledger pricer's own
 * answer (a priced zero usage), so the question a config guard asks and the answer the
 * biller gives cannot disagree. A serving model that fails this is one the server would
 * bill at $0 (the composer, 2026-10-01) or at the runner's fail-closed max claim (a task
 * turn), so nothing that names a model to SERVE may name one that fails it.
 */
export function isModelPriceable(modelId: string): boolean {
  return modelId !== '' && priceUsageUsd(modelId, NO_TOKENS) !== null;
}
