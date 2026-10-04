/**
 * COMPACTION_V2 — the trigger, as pure economics.
 *
 * PURITY CONTRACT (mirrors compactor.ts / token-ledger.ts):
 *   - No I/O, no clock, no model SDK. Imports only the sibling ledger.
 *   - Never throws; degenerate input resolves to a finite decision.
 *
 * ── WHY THE TRIGGER HAS TWO BOUNDS ──────────────────────────────────────────
 * The old trigger fired at 80% of the CONTEXT WINDOW. On a 200k model that is
 * 160k — sensible. On the 1M models we actually run it is 800k: a long task spent
 * its whole life re-reading half a million tokens every round, paying for every
 * one of them, with no compaction in sight.
 *
 * PRICING FACT (verified 2026-08-20 against the vendor pricing page; mirrored in
 * engine/native-pricing.ts): Anthropic bills the FULL 1M window at STANDARD rate.
 * There is no premium tier and no price cliff at 200k — a 900k-token request costs
 * the same per token as a 9k one. An earlier version of this header claimed a 2x
 * cliff; that was false and misled three modules. The bound below is kept for
 * the reasons that ARE true:
 *   - context hygiene: a long-lived 500k prompt degrades answer quality;
 *   - prefill latency scales with input tokens;
 *   - rejection headroom: one large tool result must not overflow the window;
 *   - subagent bounding: children inherit this ceiling.
 *
 * ── THE TWO BOUNDS ──────────────────────────────────────────────────────────
 * Fire at whichever comes FIRST:
 *
 *     trigger = min( ceiling   = thresholdPct × contextWindow,
 *                    preferred = preferredSafetyPct × preferredMaxInputTokens )
 *
 * The ceiling is the HARD bound — a model with no declared preferredMaxInputTokens
 * has no second term and behaves exactly as before. The preferred bound is an
 * ADDITIONAL, earlier bound, so this can only ever move the trigger DOWN, never up.
 *
 * ── WHY A SAFETY FRACTION ON THE PREFERRED BOUND ────────────────────────────
 * The trigger runs at the round head, after the previous round's tool results
 * are already in the ledger, so firing AT the bound would already keep every
 * request under it. The fraction exists because the ledger is a heuristic
 * (token-ledger.ts: char/word blend, flat per-image rate), and the wire also
 * carries bytes the ledger cannot see — signed thinking blocks, provider
 * envelope overhead. A ~10% margin absorbs that estimation error so a request
 * we measured at "just under" does not land just over on the real tokenizer.
 */

import { resolveMaxContextTokens, resolvePreferredMaxInputTokens } from '../journal/token-ledger.js';

/** Which bound decided the trigger point (observability + tests). */
export type TriggerBound = 'ceiling' | 'preferred';

export interface TriggerPolicy {
  /**
   * Fraction of the model's CONTEXT WINDOW that is the hard ceiling. 0.8 today —
   * unchanged from the pre-V2 trigger, and still the only bound on a model with
   * no declared preferredMaxInputTokens.
   */
  thresholdPct: number;
  /**
   * Fraction of the model's preferredMaxInputTokens to fire at; absorbs ledger
   * estimation error (see the module header). 1.0 would fire exactly at the
   * bound; >1 is clamped away because firing ABOVE it defeats the point.
   */
  preferredSafetyPct: number;
}

export const DEFAULT_TRIGGER_POLICY: TriggerPolicy = {
  thresholdPct: 0.8,
  preferredSafetyPct: 0.9,
};

export interface TriggerPoint {
  /** The token count at which compaction fires — the min of the two bounds. */
  triggerTokens: number;
  /** thresholdPct × contextWindow. Always present. */
  ceilingTokens: number;
  /** preferredSafetyPct × preferredMaxInputTokens. ABSENT when the model declares no preferred ceiling. */
  preferredTokens?: number;
  /** Which bound won. 'preferred' only ever when the model HAS a declared preferred ceiling. */
  bound: TriggerBound;
}

/**
 * Resolve where compaction fires for a model, under a policy.
 *
 * TOTAL: a model with no declared preferred ceiling yields `bound: 'ceiling'` and
 * no `preferredTokens`, which is exactly the pre-V2 behavior. A non-finite or
 * non-positive policy value falls back to the default rather than producing a
 * NaN trigger that would fire on every round (or never).
 */
export function resolveTriggerPoint(model: string, policy: TriggerPolicy): TriggerPoint {
  const thresholdPct = safeFraction(policy.thresholdPct, DEFAULT_TRIGGER_POLICY.thresholdPct);
  // Clamped at 1: a safety fraction above 1 would fire past the preferred
  // ceiling, which is the one thing this bound exists to prevent.
  const preferredSafetyPct = Math.min(
    safeFraction(policy.preferredSafetyPct, DEFAULT_TRIGGER_POLICY.preferredSafetyPct),
    1,
  );

  const ceilingTokens = resolveMaxContextTokens(model) * thresholdPct;
  const preferredMax = resolvePreferredMaxInputTokens(model);

  // No declared ceiling → no preferred term. NOT a ceiling of zero (see the
  // resolver's note in token-ledger.ts): omitting the field is what keeps a
  // Haiku session on the pre-V2 trigger.
  if (preferredMax === undefined || !Number.isFinite(preferredMax) || preferredMax <= 0) {
    return { triggerTokens: ceilingTokens, ceilingTokens, bound: 'ceiling' };
  }

  const preferredTokens = preferredMax * preferredSafetyPct;
  return preferredTokens < ceilingTokens
    ? { triggerTokens: preferredTokens, ceilingTokens, preferredTokens, bound: 'preferred' }
    : { triggerTokens: ceilingTokens, ceilingTokens, preferredTokens, bound: 'ceiling' };
}

/**
 * The provider's own count of the LAST request, and what the journal gained since.
 * `inputTokens` is the whole prompt the provider billed (uncached + cache read + cache
 * write); `outputTokens` is that round's reply, reasoning included, which the next request
 * carries back; `appendedTokens` is the estimate of every entry appended after it.
 */
export interface ReportedInput {
  inputTokens: number;
  outputTokens: number;
  appendedTokens: number;
}

/**
 * The input the NEXT request will carry, as the trigger should read it.
 *
 * The estimate (token-ledger.ts, chars/4 over text blocks) is a hint. It cannot see replayed
 * encrypted reasoning and undercounts dense tool output, and on gpt-6-luna it ran at 60-65%
 * of the real input: the 244.8K trigger first fired at 330-410K real (task c00b391e: +54
 * estimated vs +7,459 real per round). The provider already counts every request, so when
 * that count is in hand the next request is that count, plus the reply it produced, plus
 * whatever was appended since.
 *
 * `max`, never a replacement: the trigger can only move EARLIER than the estimate alone
 * would put it (the same one-way rule as the two bounds above). PURE and TOTAL.
 */
export function measuredInputTokens(estimate: number, reported?: ReportedInput): number {
  if (!reported) return estimate;
  return Math.max(estimate, reported.inputTokens + reported.outputTokens + reported.appendedTokens);
}

/** A fraction that must be finite and positive; anything else falls back. */
function safeFraction(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
