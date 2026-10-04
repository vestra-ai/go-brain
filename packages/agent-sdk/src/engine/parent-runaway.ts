/**
 * parent-runaway.ts — the PARENT loop's runaway-guard GLUE (W3-3), extracted so
 * native-harness.ts (under the file-size ratchet) carries only the per-turn
 * construction and one-line calls at its existing seams. The counting core,
 * thresholds, reset rules and terminal directive live in subagent-watchdog.ts
 * (shared verbatim with the subagent loops); this module owns the loop-side
 * mechanics:
 *
 *  - `settleRound` — the ONE settle call site's body (mirrors where the
 *    subagent loop counts): feed every settled dispatch; a pause-containing
 *    batch is excluded whole (a pause is a wait, not a failure — the subagent
 *    rule; the turn stops at the loop's pausedHalt break anyway). On the
 *    tripping round it invokes `pushDirective` EXACTLY ONCE, at the settle
 *    boundary, BEHIND the batch's tool_results (the caller's journal append
 *    lands before the post-batch re-project; the in-memory push lands after
 *    runOneRound's pushToolResult calls).
 *  - `graceExhausted` — the round-head force-complete gate: TRUE once
 *    SUBAGENT_RUNAWAY_GRACE_ROUNDS post-directive rounds are spent (the caller
 *    clears wantedMoreTools and breaks, so the epilogue classifies a
 *    COMPLETION with the partial output, never max_turns).
 *  - `tripped` — the latch NativeHarness.gateTool consults to refuse every
 *    post-trip call with the terminal directive (assigned to the instance per
 *    turn; cleared in run()'s finally — fix round 1: the continue path
 *    pre-gates on the same instance between turns).
 *
 * State is a per-instance closure — one guard per parent turn; zero cost until
 * the pathological trip. Pinned by native-harness.runaway-guard.test.ts and
 * replay fixture 05.
 */
import {
  createParentRunawayWatchdog,
  SUBAGENT_RUNAWAY_GRACE_ROUNDS,
} from './subagent-watchdog.js';

export interface ParentRunawayGuard {
  /** Latched TRUE from the trip onward — the gateTool deny latch. */
  tripped(): boolean;
  /** Round-head gate: TRUE once the post-directive grace budget is exhausted. */
  graceExhausted(): boolean;
  /** The settle call site — observe the batch, push the directive once on trip. */
  settleRound(
    toolUses: ReadonlyArray<{ id: string; name: string; input: unknown }>,
    results: ReadonlyArray<{ toolUseId: string; isError: boolean; pausedHalt?: boolean }>,
  ): Promise<void>;
}

export function createParentRunawayGuard(opts: {
  /** The parent task id — carried on the trip WARN. */
  taskId: string;
  /** The model the turn is on — carried on the trip WARN. */
  model: string;
  /**
   * Appends the terminal directive as a user-role entry (journal append or
   * in-memory push — the caller owns the seam so it reads the turn's LIVE
   * history binding). Invoked EXACTLY ONCE, on the tripping round's settle.
   */
  pushDirective: () => Promise<void>;
}): ParentRunawayGuard {
  const watchdog = createParentRunawayWatchdog({ taskId: opts.taskId, model: opts.model });
  let directivePushed = false;
  let graceRoundsUsed = 0;
  return {
    tripped: (): boolean => watchdog.tripped,
    graceExhausted(): boolean {
      if (!directivePushed) return false;
      if (graceRoundsUsed >= SUBAGENT_RUNAWAY_GRACE_ROUNDS) return true;
      graceRoundsUsed += 1;
      return false;
    },
    async settleRound(toolUses, results): Promise<void> {
      if (results.length === 0 || results.some((r) => r.pausedHalt)) return;
      for (const r of results) {
        const tu = toolUses.find((t) => t.id === r.toolUseId);
        if (tu) watchdog.observe(tu.name, tu.input, r.isError);
      }
      if (watchdog.tripped && !directivePushed) {
        directivePushed = true;
        await opts.pushDirective();
      }
    },
  };
}
