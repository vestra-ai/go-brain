/**
 * compaction-post-turn — COMPACTION_POST_TURN_V1, Codex's turn-end compaction on our rails
 * (codex-rs core/src/session/turn.rs:716 with session/context_window.rs
 * `turn_end_compaction_threshold_reached`).
 *
 * The round head compacts when the next request's measured input reaches the budget
 * (compaction-run.ts maybeCompact, which already reads the provider's own count). So a long task
 * compacts in the middle of the person's NEXT turn, at the round head after a tool call grew the
 * input past the line: a summarize they wait through mid-work. Codex checks once more when a turn
 * ends and compacts then, so the next turn starts under budget. Here the check runs at the turn's
 * epilogue and the compaction runs in the idle wait for the next message (post-turn-off-path.ts),
 * after the turn's AGENT_END, never inside a turn:
 *   - early (the measured input at POST_TURN_COMPACT_SHARE of the budget or more, still under it):
 *     the next message cuts it, before anything is written (the summary is journaled only after it
 *     returns), and that turn runs exactly as it does today;
 *   - due (at the budget or over): the next round head would compact anyway, so a message that
 *     arrives meanwhile waits for it and its turn starts on the compacted context.
 * Its cost is no turn's: it bills on the off-loop 'post_turn_compaction' lane, charged on its own
 * leg like the memory sweep, never folded into the run's billing and never journaled as a turn's
 * usage (the cold-start cost seed must not count it a second time). Every way it can end leaves
 * a row: done ('ok', the provider's usage), refused ('error', the billed summarize), cut by the
 * next message or by its own bound ('cancelled', the provider's usage or else the estimate of
 * the request it sent).
 *
 * Bounded three ways (#4264 review): it runs only on the idle lane (POST_TURN_OFF_PATH_V1; inline
 * it would hold the next message for a whole summarize), the host holds the box awake while it
 * runs (NativeConfig.holdForPostTurnWork), and it stops at POST_TURN_COMPACT_TIMEOUT_MS. After any
 * paid refusal in the run (here or at a round head) the turn end stops trying: a context the
 * planner refuses never pays a summarize at every turn end (the round head keeps its own wait).
 */
import type { HarnessEvent } from '../contract/events.js';
import type { FrozenElision } from './context-elision.js';
import type { ProviderTool } from './transport.js';
import type { RunContext } from './run-context.js';
import { compactionUsageEvent, measureTriggerInput, runCompaction, DEFAULT_COMPACTION, type CompactionDeps } from './compaction-run.js';
import { armCompactionRetry, billedSpendOf, compactionRetryPending, inflightEstimateOf, recordCompactionFailure } from './compaction-refusal.js';
import type { NormalizedUsage } from '../contract/events.js';
import { laneUsageEvent } from './offloop-usage.js';
import { compactionPostTurnEnabled, compactionV2Enabled } from '../policy/feature-flags.js';

/**
 * The share of the compaction budget at which a finished turn compacts. Codex's knob
 * (`model_post_turn_compact_threshold_percent`) ships at 0, off; the switch here is the flag.
 */
export const POST_TURN_COMPACT_SHARE = 0.85;

/** The bound on one turn-end compaction (a due one holds the next message for at most this). */
export function postTurnCompactTimeoutMs(): number {
  const ms = Number(process.env.POST_TURN_COMPACT_TIMEOUT_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : 120_000;
}

/** A turn-end compaction the check decided on, run later by the off path (or inline). */
export interface PostTurnCompaction {
  /** At the budget or over: the next round head would compact anyway, so the next message waits for it. */
  due: boolean;
  /** Run it under `signal` (the off path's cut, or the run's own); the events to yield. Never throws. */
  run(signal: AbortSignal): Promise<HarnessEvent[]>;
}

/**
 * The turn-end check: undefined unless COMPACTION_POST_TURN_V1 and COMPACTION_V2 are on and the
 * next request's measured input (the same reading the round head takes) is at
 * POST_TURN_COMPACT_SHARE of the budget or more. Never throws.
 */
export async function postTurnCompaction(
  deps: CompactionDeps,
  rc: RunContext,
  system: string,
  providerTools: ProviderTool[],
  elision: FrozenElision | null,
): Promise<PostTurnCompaction | undefined> {
  if (!compactionPostTurnEnabled() || !compactionV2Enabled()) return undefined;
  // A refusal already paid this run (here or at a round head): the turn end stops trying.
  if (rc.compactionRetry || compactionRetryPending(rc)) return undefined;
  const m = await measureTriggerInput(deps, system, providerTools, elision, rc).catch(() => null);
  if (!m || m.measured < m.budget * POST_TURN_COMPACT_SHARE) return undefined;
  const { ctx } = deps;
  const model = ctx.model || deps.transport.defaultModel();
  // The turn's round counter, read now: the side call belongs to the turn that just ended.
  const turnNumber = rc.billing.roundCounter.value;
  return {
    due: m.measured >= m.budget,
    async run(signal) {
      // Cut before it began (a Stop during the chip or the sweep, the next message): nothing sent, nothing billed.
      if (signal.aborted) return [];
      // Its own bound, and the caller's cut, on one signal.
      const ac = new AbortController();
      const onCut = (): void => ac.abort();
      if (signal.aborted) ac.abort();
      else signal.addEventListener('abort', onCut, { once: true });
      const bound = setTimeout(() => ac.abort(), postTurnCompactTimeoutMs());
      bound.unref?.();
      try {
        const result = await runCompaction(deps, m.messages, {
          trigger: 'auto',
          keepWindowTokens: ctx.config.compaction?.keepWindowTokens ?? DEFAULT_COMPACTION.keepWindowTokens,
          resumesTurn: false, // the turn has ended: no split-turn continuation marker
          signal: ac.signal,
          reason: 'post_turn',
        });
        const usage = compactionUsageEvent(result, ctx.taskId, turnNumber, 'post_turn_compaction');
        return [...(usage ? [usage] : []), result.event];
      } catch (err) {
        const billed = billedSpendOf(err);
        if (ac.signal.aborted) {
          // Cut (the next message, or the bound): what the provider billed, plus the estimate of a
          // request it sent that never finished. Nothing was written; the next round head decides.
          const estimate = inflightEstimateOf(err);
          // Cut before the request went out (summarizeSpan's pre-send check) with nothing finished: no row.
          if (!estimate && !spentAny(billed?.usage)) return [];
          const spent = sumUsage(billed?.usage, estimate);
          const row = laneUsageEvent('post_turn_compaction', { status: 'cancelled', usage: spent, model: billed?.model ?? model }, ctx.taskId, turnNumber);
          return row ? [row] : [];
        }
        // Refused: the record (no journal usage leg: the row below carries the money), the bound.
        armCompactionRetry(rc, err);
        const row = billed && laneUsageEvent('post_turn_compaction', { status: 'error', usage: billed.usage, model: billed.model }, ctx.taskId, turnNumber);
        return [await recordCompactionFailure(deps, 'auto', err, { journalUsage: false }), ...(row ? [row] : [])];
      } finally {
        clearTimeout(bound);
        signal.removeEventListener('abort', onCut);
        // Between turns there is no AGENT_END to clear "Optimizing context…": clear it on every path.
        ctx.config.emitStatus?.(null);
      }
    },
  };
}

/** Did a usage bill anything (any bucket above zero)? */
function spentAny(u: NormalizedUsage | undefined): boolean {
  return !!u && (u.inputTokens > 0 || u.outputTokens > 0 || (u.cacheReadInputTokens ?? 0) > 0 || (u.cacheCreationInputTokens ?? 0) > 0);
}

/** Two usages summed bucket by bucket (either may be absent). */
function sumUsage(a: NormalizedUsage | undefined, b: NormalizedUsage | undefined): NormalizedUsage {
  return {
    inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0),
    cacheReadInputTokens: (a?.cacheReadInputTokens ?? 0) + (b?.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens: (a?.cacheCreationInputTokens ?? 0) + (b?.cacheCreationInputTokens ?? 0),
  };
}
