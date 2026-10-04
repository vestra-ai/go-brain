import type { ModelUsageSummary } from '../contract/turn-outcome.js';
import { resolveCapabilities } from '../contract/model-capabilities.js';
import { priceForModel, pricesAtFailClosed } from '../contract/openai-pricing.js';
import type { NormalizedUsage } from './transport.js';
import { billCacheWrite1hEnabled } from '../policy/feature-flags.js';

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /**
   * The wire's split of `cache_creation_input_tokens` by cache TTL (Anthropic's
   * `usage.cache_creation`; 5m + 1h = the aggregate, `null` when the response carried
   * none). A 5-minute write bills 1.25x input, a 1-hour write 2x — and the model proxy
   * rewrites every breakpoint to a 1h TTL (proxy-core inject-cache-ttl), so a pricer
   * that sees only the aggregate bills every write at 1.25x.
   */
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
}

// USD per 1M tokens. Keep in sync with Anthropic's pricing page.
// Keyed by family token; version numbers in model strings are intentionally ignored —
// EXCEPT where Anthropic prices a version differently (sonnet-5, opus-5-5 and
// fable-5-1 below).
const FAMILY_RATES: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  // Fable 5 / Mythos 5 — top tier, $10/$50 (2× Opus). Their ids carry no
  // opus/sonnet/haiku token, so without this they fell to the Sonnet DEFAULT
  // ($3/$15) and under-charged 3.3×. cache read 0.1×, cache write 1.25× (5m).
  fable:  { in: 10, out: 50,  cacheRead: 1.0, cacheWrite: 12.5  },
  // Fable 5.1 / Mythos 5.1 — same tier, but cache reads are 0.025× input ($0.25;
  // verified 2026-09-22 vs platform.claude.com/docs/en/about-claude/pricing, which
  // footnotes both 5.1 models). On the family row every cached token billed 4×.
  fable51: { in: 10, out: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  // Opus 5.5 — $4/$20 against the family's $5/$25, cache reads 0.05× input ($0.20),
  // 5m write 1.25× ($5; same page, 2026-09-22). On the family row it billed 1.25×.
  opus55: { in: 4,  out: 20,  cacheRead: 0.2, cacheWrite: 5     },
  opus:   { in: 5,  out: 25,  cacheRead: 0.5, cacheWrite: 6.25  },
  // Sonnet 5 — $2/$10 made PERMANENT (the planned 2026-09-01 rise to $3/$15 was
  // cancelled; verified 2026-08-13 vs platform.claude.com/docs/en/about-claude/pricing).
  // Billing it on the family row below overcharged every sonnet-5 turn 1.5×.
  // cache read 0.1×, write 1.25× (5m); the 1h 2×-input uplift lives in usage-pricing.
  sonnet5: { in: 2, out: 10,  cacheRead: 0.2, cacheWrite: 2.5   },
  sonnet: { in: 3,  out: 15,  cacheRead: 0.3, cacheWrite: 3.75  },
  haiku:  { in: 1,  out: 5,   cacheRead: 0.1, cacheWrite: 1.25  },
};
// Intentionally Sonnet-tier for unknown/future families so estimates are never free.
const DEFAULT_RATE = { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 };

// Warn-once registry: each unknown-family model id is logged at most once per process.
// This surfaces silent overcharge risk without spamming on every turn.
const _warnedUnknownFamilies = new Set<string>();

type Rate = { in: number; out: number; cacheRead: number; cacheWrite: number };
export type AnthropicFamily = 'fable51' | 'fable' | 'opus55' | 'opus' | 'sonnet5' | 'sonnet' | 'haiku';

/**
 * Classify a model id to its Anthropic family by family token — version numbers,
 * dated suffixes (…-20251001), and [1m] variants are ignored so every version of a
 * family resolves the same, EXCEPT sonnet-5, which Anthropic prices below the rest
 * of its family (2026-08-13 correction — before it, every sonnet-5 turn billed the
 * $3/$15 family row = a 1.5× overcharge), and opus-5-5 / fable-5-1 / mythos-5-1
 * (2026-09-22, same class). Returns null when NO named family matches
 * (the caller then applies the provider-aware branch / DEFAULT). This stays first in
 * rateFor; its ORDER + tokens change only for a deliberate rate correction like the
 * sonnet-5 split, never as a side effect. It is the SINGLE source of truth for the
 * family match: both rateFor (billing) and resolveFamilyRate (the coverage-tripwire
 * introspection) go through it, so they can never drift.
 */
function classifyAnthropicFamily(model: string): { family: AnthropicFamily; rate: Rate } | null {
  const m = model.toLowerCase();
  // Each version split sits ABOVE its family check (the family token is a substring
  // of the versioned id). Dated / [1m] suffixes keep the version token intact; a
  // plain 'claude-fable-5' or 'claude-opus-5' never contains it.
  if (m.includes('fable-5-1') || m.includes('mythos-5-1')) return { family: 'fable51', rate: FAMILY_RATES.fable51 };
  if (m.includes('fable') || m.includes('mythos')) return { family: 'fable', rate: FAMILY_RATES.fable };
  if (m.includes('opus-5-5')) return { family: 'opus55', rate: FAMILY_RATES.opus55 };
  if (m.includes('opus'))   return { family: 'opus', rate: FAMILY_RATES.opus };
  if (m.includes('haiku'))  return { family: 'haiku', rate: FAMILY_RATES.haiku };
  // 'sonnet-5' also matches dated/[1m] suffixed ids; 'sonnet-4-5' / '…-3-5-sonnet…'
  // do NOT contain the token, so every older sonnet stays on the $3/$15 family row.
  // A future sonnet-5-x would land here — re-check the pricing page when one ships.
  // sonnet-5-5 does, correctly: Anthropic prices it exactly as Sonnet 5 (2026-09-29).
  if (m.includes('sonnet-5')) return { family: 'sonnet5', rate: FAMILY_RATES.sonnet5 };
  if (m.includes('sonnet')) return { family: 'sonnet', rate: FAMILY_RATES.sonnet };
  return null;
}

/** rateFor's desync arm: a NON-anthropic id this transport prices off the OpenAI card. */
function onOpenAiCard(model: string): boolean {
  const provider = resolveCapabilities(model).provider;
  return provider === 'openai' || provider === 'fireworks' || provider === 'meta' || provider === 'xai';
}

function rateFor(model: string) {
  // ── Anthropic FIRST, byte-unchanged ────────────────────────────────────────
  // The Claude arm bills from the SDK's own total_cost_usd and never reaches the
  // openai branch below for a non-anthropic id — but keep it unreachable-safe anyway.
  const matched = classifyAnthropicFamily(model);
  if (matched) return matched.rate;

  // ── Provider-aware fail-correct for non-anthropic ids ──────────────────────
  // If a non-anthropic model (e.g. gpt-5.5) is priced through the Anthropic
  // transport (a transport/model desync), the legacy code fell to DEFAULT_RATE
  // = the Sonnet tier ($3/$15) and UNDER-charged the customer vs the correct
  // OpenAI rates ($5/$30). Gate on the PROVIDER VALUE (not runtime/harness-id —
  // the K2 lint wall forbids that) and delegate to the OpenAI rate card so the
  // charge is accurate. priceForModel fails closed to the max tier (gpt-5.6-sol)
  // on an unknown openai id, so this is never $0 and never NaN.
  // meta/xai ride their own transports' computeOpenAIResponsesCostUsd in practice;
  // this arm only protects the transport/model-desync path (same as openai). NOTE:
  // standard-tier rates only — the flat Rate shape has no prompt-size input, so the
  // grok-4.5 ≥200K premium tier cannot apply here (it does in the real path).
  if (onOpenAiCard(model)) {
    const p = priceForModel(model);
    // Map the OpenAI rate card into native-pricing's {in,out,cacheRead,cacheWrite}
    // shape. GPT-5.6+ bills cache WRITES at 1.25× input (cacheWriteInputPerMTok);
    // older OpenAI models have no write surcharge, so absent falls back to the
    // standard input rate — mirroring openai-responses-pricing.ts.
    return {
      in: p.inputPerMTok,
      out: p.outputPerMTok,
      cacheRead: p.cachedInputPerMTok,
      cacheWrite: p.cacheWriteInputPerMTok ?? p.inputPerMTok,
    };
  }

  // Unknown ANTHROPIC-inferred family: fail closed to Sonnet tier, warn once.
  if (!_warnedUnknownFamilies.has(model)) {
    _warnedUnknownFamilies.add(model);
    console.warn(
      `[native-pricing] Unknown model family for "${model}" — no opus/haiku/sonnet token in model id. ` +
        `Billing at Sonnet tier (DEFAULT_RATE) to fail closed. Add the family to FAMILY_RATES if needed.`,
    );
  }
  return DEFAULT_RATE;
}

/**
 * True when computeAnthropicCostUsd(…, model) priced at the fail-closed MAXIMUM: rateFor's
 * desync arm (no Anthropic family, an OpenAI-card provider) with no raw row on the card
 * (pricesAtFailClosed). The Sonnet DEFAULT for an unknown Anthropic family is a family
 * fallback (at most ~4× off), NOT the max — unflagged, so Claude ids keep counting
 * toward the stop gates (live-spend.ts).
 */
export function anthropicPricesAtFailClosed(model: string): boolean {
  return classifyAnthropicFamily(model) === null && onOpenAiCard(model) && pricesAtFailClosed(model);
}

export interface FamilyRateResolution {
  /** The matched Anthropic family, or 'default' when the id fell to DEFAULT_RATE. */
  family: AnthropicFamily | 'default';
  rate: Rate;
  /** True ONLY when no named family matched and the Sonnet-tier DEFAULT_RATE stood in. */
  isDefault: boolean;
}

/**
 * Introspect the ANTHROPIC-arm family classification for `model`, WITHOUT running
 * the provider-aware openai branch. Exists for the pricing-coverage tripwire, which
 * must distinguish a real family match from the fail-closed DEFAULT — Sonnet's rate
 * is numerically identical to DEFAULT_RATE ($3/$15), so comparing rate VALUES can
 * never tell them apart. Non-anthropic ids have no Anthropic family, so they report
 * `default`/`isDefault:true` here (price them via the OpenAI/Gemini rate cards, not
 * this helper). No behavior change: rateFor + computeAnthropicCostUsd are untouched.
 */
export function resolveFamilyRate(model: string): FamilyRateResolution {
  const matched = classifyAnthropicFamily(model);
  if (matched) return { family: matched.family, rate: matched.rate, isDefault: false };
  return { family: 'default', rate: DEFAULT_RATE, isDefault: true };
}

/**
 * The conservative per-1M-token {in, out} rate for a model, for the fuel tank's
 * true-ceiling RESERVE (fuel-tank.ts). Deliberately the FULL input rate (not the
 * cheaper cache-read rate): a reserve must be an UPPER bound, so it must not assume a
 * prompt-cache hit that may not happen. Delegates to the same `rateFor` classifier
 * the actual cost uses, so it inherits the fail-closed-to-Sonnet behavior for unknown
 * families (a reserve is never $0, which would let an unpriced model bypass the tank).
 */
export function rateForReserve(model: string): { in: number; out: number } {
  const r = rateFor(model);
  return { in: r.in, out: r.out };
}

const M = 1_000_000;

/**
 * Anthropic bills a 1-hour ephemeral cache WRITE at 2x the base input rate; the 5-minute
 * write (1.25x) is what every FAMILY_RATES.cacheWrite already carries. Verified 2026-09-29
 * against platform.claude.com/docs/en/about-claude/pricing — the "1h cache writes" column
 * is exactly 2x "Base input tokens" on every row ($8 Opus 5.5, $20 Fable 5.1, $4 Sonnet 5.5).
 */
export const ANTHROPIC_1H_WRITE_INPUT_MULTIPLE = 2;

/**
 * THE one Anthropic formula, shared by the runner's claim (computeAnthropicCostUsd) and
 * the server's ledger pricer (contract/usage-pricing.ts), so the two can only ever disagree
 * on the RATE ROW, never on the arithmetic. When the wire carried the 5m/1h split it is
 * authoritative and the aggregate is ignored (never both); without it every write prices at
 * the 5m rate — the pre-split behavior, byte-identical.
 *
 * This prices the TRUTH, what the provider bills. A CHARGE prices chargeableAnthropicUsage
 * (BILL_CACHE_WRITE_1H_V1); the price check that audits the card against Anthropic's own cost
 * report (billing-truth) prices this, always.
 */
export function priceAnthropicUsageAtRate(r: Rate, u: AnthropicUsage): number {
  const w5m = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const hasSplit = w5m > 0 || w1h > 0;
  const write5m = hasSplit ? w5m : (u.cache_creation_input_tokens ?? 0);
  const write1h = hasSplit ? w1h : 0;
  return (
    (u.input_tokens * r.in +
      u.output_tokens * r.out +
      (u.cache_read_input_tokens ?? 0) * r.cacheRead +
      write5m * r.cacheWrite +
      write1h * r.in * ANTHROPIC_1H_WRITE_INPUT_MULTIPLE) / M
  );
}

export function computeAnthropicCostUsd(u: AnthropicUsage, model: string): number {
  return priceAnthropicUsageAtRate(rateFor(model), u);
}

/**
 * BILL_CACHE_WRITE_1H_V1: the usage a CHARGE prices. Off, the 5m/1h split is left out, so every
 * write prices at the 5-minute rate, the charge prod has always made; the row still records the
 * split (the record is never flagged). On, the usage as the provider reported it, so a 1-hour
 * write charges 2x input. The runner's claim (the transports' computeCostUsd / buildModelUsage)
 * and the server's charges (contract/usage-pricing.ts chargeableTokenUsage) both read the same
 * flag, so they agree in both states.
 */
export function chargeableAnthropicUsage(u: AnthropicUsage): AnthropicUsage {
  if (!u.cache_creation || billCacheWrite1hEnabled()) return u;
  const { cache_creation: _split, ...charged } = u;
  return charged;
}

/**
 * Anthropic wire usage → the provider-neutral NormalizedUsage. The 5m/1h split rides
 * whenever the wire carried the `cache_creation` object (both keys, so a 100%-1h response
 * still says "5m: 0" rather than dropping the field); a response without it is the
 * pre-split shape, byte-identical. Shared by the live transport and the replay transport
 * so the two projections cannot drift.
 */
export function normalizeAnthropicUsage(u: AnthropicUsage): NormalizedUsage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
    ...(u.cache_creation
      ? {
          cacheCreation5mInputTokens: u.cache_creation.ephemeral_5m_input_tokens ?? 0,
          cacheCreation1hInputTokens: u.cache_creation.ephemeral_1h_input_tokens ?? 0,
        }
      : {}),
  };
}

/** NormalizedUsage → the Anthropic pricing field names (the inverse of normalizeAnthropicUsage). */
export function denormalizeAnthropicUsage(u: NormalizedUsage): AnthropicUsage {
  const hasSplit = u.cacheCreation5mInputTokens !== undefined || u.cacheCreation1hInputTokens !== undefined;
  return {
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
    cache_read_input_tokens: u.cacheReadInputTokens ?? 0,
    cache_creation_input_tokens: u.cacheCreationInputTokens ?? 0,
    ...(hasSplit
      ? {
          cache_creation: {
            ephemeral_5m_input_tokens: u.cacheCreation5mInputTokens ?? 0,
            ephemeral_1h_input_tokens: u.cacheCreation1hInputTokens ?? 0,
          },
        }
      : {}),
  };
}

/**
 * Build a ModelUsageSummary from raw Anthropic token usage.
 * NOTE: the real ModelUsageEntry uses `costUSD` (uppercase D), `webSearchRequests`.
 */
export function buildModelUsage(u: AnthropicUsage, model: string): ModelUsageSummary {
  return {
    [model]: {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
      webSearchRequests: 0,
      costUSD: computeAnthropicCostUsd(u, model),
    },
  };
}
