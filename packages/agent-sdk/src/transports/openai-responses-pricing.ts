import type { ModelUsageSummary } from '../contract/turn-outcome.js';
import {
  priceForModelAtInstant,
  priceForModelAtPromptSize,
  OPENAI_TOKEN_PRICING,
} from '../contract/openai-pricing.js';
import type { NormalizedUsage } from '../engine/transport.js';

const M = 1_000_000;

// Warn-once registry: each unknown model id is logged at most once per process.
// This surfaces silent overcharge risk without spamming on every turn.
const _warnedUnknownModels = new Set<string>();

/**
 * Compute OpenAI Responses API cost in USD from normalized token usage.
 *
 * Reuses rate table from `@bash/shared/harness/openai-pricing` (verified 2026-05-30;
 * GPT-5.6 rows 2026-07-09). `priceForModel` does an EXACT key lookup (no
 * family/prefix matching) and FAILS CLOSED to the max (gpt-5.6-sol) price on any
 * unknown id — so a version-drift id like `gpt-5.4-20260901` does NOT resolve to
 * the gpt-5.4 tier; it falls back to gpt-5.6-sol. Never $0, never NaN. Unknown
 * model ids emit one console.warn per process (see _warnedUnknownModels) so
 * overcharges surface in logs without spamming per turn.
 *
 * OpenAI Responses API cached-input pricing: `cacheReadInputTokens` billed at
 * `cachedInputPerMTok` (10× cheaper than fresh input). `cacheCreationInputTokens`
 * bill at `cacheWriteInputPerMTok` where present (GPT-5.6+: 1.25× input) and at
 * the standard input rate on older models (pre-5.6: no write surcharge).
 *
 * CONVENTION (2026-08-04, single): NormalizedUsage.inputTokens is EXCLUSIVE of the
 * cache buckets on EVERY arm — the producers (normalizeResponsesUsage /
 * normalizeChatUsage) subtract OpenAI's inclusive breakdowns at the source. This fn
 * prices disjoint buckets directly; re-subtracting here would under-charge.
 */
export function computeOpenAIResponsesCostUsd(usage: NormalizedUsage, model: string): number {
  if (!(model in OPENAI_TOKEN_PRICING) && !_warnedUnknownModels.has(model)) {
    _warnedUnknownModels.add(model);
    console.warn(
      `[openai-responses-pricing] Unknown model id "${model}" — no exact entry in OPENAI_TOKEN_PRICING. ` +
        `Billing at max tier (gpt-5.6-sol) to fail closed. Update the pricing table if this model is now available.`,
    );
  }
  // ONE-CONVENTION (2026-08-04): NormalizedUsage.inputTokens is EXCLUSIVE on
  // every arm — normalizeResponsesUsage already subtracted the cached/write
  // breakdowns at the producer, so the buckets price DIRECTLY here. The
  // long-context premium tier keys on the TOTAL prompt the provider saw
  // (exclusive input + cached + written): a 300k prompt that is 295k cached is
  // still a 300k prompt to the provider's tier pricing.
  const cached = usage.cacheReadInputTokens ?? 0;
  const written = usage.cacheCreationInputTokens ?? 0;
  const uncached = usage.inputTokens;
  // TIME-TIERED rows (deepseek official peak/off-peak from 08-16) price by wall
  // clock at stream end — the SAME selection the server repricer makes at
  // ledger-write, so claimed-vs-server drift stays a TABLE-freshness radar and
  // never lights up on a tier mismatch. Untiered rows keep the size-premium path.
  const rate = OPENAI_TOKEN_PRICING[model]?.timeTiers
    ? priceForModelAtInstant(model, Date.now())
    : priceForModelAtPromptSize(model, uncached + cached + written);
  const inputCost = (uncached * rate.inputPerMTok) / M;
  const outputCost = (usage.outputTokens * rate.outputPerMTok) / M;
  const cacheReadCost = (cached * rate.cachedInputPerMTok) / M;
  const cacheCreationCost = (written * (rate.cacheWriteInputPerMTok ?? rate.inputPerMTok)) / M;
  return inputCost + outputCost + cacheReadCost + cacheCreationCost;
}

/**
 * Build a ModelUsageSummary entry for the OpenAI Responses transport.
 * Returns the real ModelUsageEntry shape: costUSD (uppercase D), all token fields required.
 */
export function buildModelUsage(usage: NormalizedUsage, model: string): ModelUsageSummary {
  return {
    [model]: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
      webSearchRequests: 0,
      costUSD: computeOpenAIResponsesCostUsd(usage, model),
    },
  };
}
