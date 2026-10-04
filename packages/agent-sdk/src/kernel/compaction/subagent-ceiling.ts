/**
 * COMPACTION_V2 — the subagent lane's context ceiling.
 *
 * PURITY CONTRACT (mirrors trigger.ts / overflow.ts): no I/O, no clock, no
 * provider SDK; never throws.
 *
 * ── WHY THE CHILD LANE NEEDS ITS OWN THING ──────────────────────────────────
 * PR #2600's `wireMessages` seam makes the parent's wire view and its ledger the
 * same object. It does NOT reach a subagent: a child has no journal projection at
 * all. It accumulates ONE in-memory `ProviderHistory` array, mutated in place and
 * push-only across up to 30 rounds, and every model call reads that array
 * directly. Nothing projects it, so nothing can elide it — and `cfg.compaction` is
 * not even in the round core's config `Pick`, so compaction is unreachable by
 * construction, not by omission.
 *
 * What bounds a child today is per-RESULT only: a 256KB hard cap per tool result
 * and an FS offload at ~2% of the window. Thirty rounds of large-but-legal results
 * accumulate monotonically with no ledger, no trigger, and no cut. Nothing
 * intervenes until the provider does.
 *
 * ── WHY A CONTRACT AND NOT COMPACTION ───────────────────────────────────────
 * Compaction needs a journal to splice a summary into and a turn boundary to cut
 * at; a child has neither. Giving it one would mean a per-child journal and a
 * transport-level projection — a large change to buy a mechanism the child does
 * not need, because a subagent is a BOUNDED delegation that is supposed to return
 * an answer. So the cheap correct thing is a ceiling: when the child's history
 * crosses the same bound the parent uses, stop granting it tools and ask for its
 * answer. It finishes on the near side of the preferred input ceiling instead of
 * grinding past it, and a runaway child terminates with a real answer instead of a
 * provider rejection.
 *
 * MEASUREMENT IS DELIBERATELY CRUDE. A `ProviderHistory` is opaque to the kernel
 * (`unknown` — the loop never inspects it), so the only measure available is its
 * serialized size. JSON envelope overhead makes that an OVER-estimate, which fires
 * the ceiling slightly early — the same fail-closed direction estimateTokens
 * already takes, and the right one: early costs one bounded round, late costs an
 * oversized request or a rejected one.
 */

import { estimateTokens } from '../journal/token-ledger.js';
import { resolveTriggerPoint, DEFAULT_TRIGGER_POLICY, type TriggerPolicy } from './trigger.js';

/**
 * The terminal instruction pushed when a child hits its ceiling. Names the reason
 * so the model spends its last round answering rather than planning more work.
 */
export const SUBAGENT_CONTEXT_CEILING_NUDGE =
  'You have reached the context budget for this delegated task, so no further tools are available. Write your final answer now, using only what you have already gathered. Report what you found, and state plainly which parts of the task you did not get to.';

/**
 * Has this child's accumulated history crossed its context budget?
 *
 * Uses the SAME bound as the parent trigger (`resolveTriggerPoint`), so a child on
 * a 1M-window model with a 200k preferred ceiling wraps up around that ceiling
 * rather than at 800k — the whole point of the V2 trigger, applied to the lane that
 * had no trigger at all.
 *
 * TOTAL: an unserializable history (a circular reference) measures 0 and never
 * trips the ceiling — a child must never be cut short by a measurement failure.
 */
export function subagentCeilingReached(
  history: unknown,
  model: string,
  policy: TriggerPolicy = DEFAULT_TRIGGER_POLICY,
): boolean {
  return estimateTokens(serialize(history)) >= resolveTriggerPoint(model, policy).triggerTokens;
}

function serialize(history: unknown): string {
  try {
    return JSON.stringify(history) ?? '';
  } catch {
    return '';
  }
}
