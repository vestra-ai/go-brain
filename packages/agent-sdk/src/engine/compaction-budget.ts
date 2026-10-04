/**
 * compaction-budget.ts — the ONE number that says how far a conversation is
 * allowed to grow before something rewrites it.
 *
 * Two mechanisms need it and they must not disagree:
 *
 *   COMPACTION reads it as its trigger — cross it and history is summarized away.
 *   ELISION    sizes its live window and its stride against it — elision only ever
 *              acts in the span BELOW compaction, so a stride derived from
 *              anything else is derived from the wrong number.
 *
 * They disagreed. `maybeCompact` resolved the two-bound trigger
 * (min(0.8 x window, 0.9 x preferredMaxInputTokens)); `prepareElision` passed
 * `resolveMaxContextTokens(model)` — the raw window — into a policy whose
 * fractions were derived on a 200k model. On every model that declares a
 * preferred ceiling the trigger is pinned at 180,000 (or 244,800) whatever the
 * window is, while the elision fractions scale WITH the window: on a 1M lane
 * compaction rewrites history at 180,000 while elision's first cut wants
 * 550,000, so the mechanism could never fire before compaction made it moot.
 * Measured 2026-08-22: 0 of 12,178 staging calls and at most 19 of 5,054 prod
 * calls in 60 days would have produced a non-zero cut.
 *
 * One resolver, two callers, so the two can no longer drift apart.
 *
 * NOT PURE — it reads the COMPACTION_V2 flag, which is why it sits in engine/
 * and not next to `resolveTriggerPoint` in the kernel. The kernel half stays a
 * pure function of (model, policy); this is the thin shell that picks which of
 * its two bounds is live.
 */

import { resolveMaxContextTokens, resolveTriggerPoint, DEFAULT_TRIGGER_POLICY } from '../kernel/index.js';
import { compactionV2Enabled } from '../policy/feature-flags.js';
import type { NativeConfig } from './native-config.js';

/** The compaction config slice both callers hold. */
type CompactionConfig = NonNullable<NativeConfig['compaction']>;

/**
 * The token count at which this run's history stops growing, for THIS model
 * under THIS config.
 *
 * COMPACTION_V2 ON  → the two-bound trigger, the earlier of the window ceiling
 *                     and the model's preferred input ceiling.
 * COMPACTION_V2 OFF → `thresholdPct x contextWindow`, which is exactly the
 *                     pre-V2 predicate `ledgerTotal / maxTokens < thresholdPct`
 *                     rearranged, so the OFF path keeps its own number.
 *
 * `compaction` ABSENT means auto-compaction is not configured at all
 * (`maybeCompact` returns null before it ever measures). Nothing rewrites
 * history in that world, so the wall really is the context window and elision
 * gets the whole of it — which is what its fractions were originally written
 * against.
 */
export function resolveCompactionBudget(
  model: string,
  compaction: CompactionConfig | undefined,
): number {
  if (!compaction) return resolveMaxContextTokens(model);
  const thresholdPct = compaction.thresholdPct ?? DEFAULT_TRIGGER_POLICY.thresholdPct;
  const point = resolveTriggerPoint(model, { ...DEFAULT_TRIGGER_POLICY, thresholdPct });
  return compactionV2Enabled() ? point.triggerTokens : point.ceilingTokens;
}
