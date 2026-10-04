/**
 * turn-budget.ts — the turn gets an owner (harness-to-nine L5; harvest of #3447,
 * product review 2026-09-02, agent-runtime.md §F, findings 4 and 7).
 *
 * A turn used to be a chain of awaits with no single object that knew its limits:
 * the run's AbortController lived in the sandbox driver, the round cap in
 * `cfg.maxTurns`, the spend ceiling in the live-spend ledger. Every exit was a
 * `turn_end` yield somewhere, and nothing recorded that the turn had finished, or
 * why, in one place.
 *
 * THE BUDGET owns exactly two things — signals and exits — and moves no other logic:
 *
 *  · ONE ROOT AbortController. The driver mints the budget for every native run and
 *    registers `budget.controller` as the run's controller, so every signal the turn
 *    hands out (the round scope the model call reads, recall, a compaction) derives
 *    from this root by construction. `child()` mints one explicitly.
 *  · THE COUNTERS the loop already keeps, mirrored: rounds (`noteRound` at each round
 *    head) and this turn's spend (`observeSpend` from the live ledger), so
 *    `exhausted()` answers "which limit" from one place. The loop's own gates stay the
 *    deciders; the budget is where the verdict is READ.
 *  · ONE `end(reason)` per turn: idempotent. The first call records the reason and
 *    fires the sinks; every later call is a no-op that returns false. Every terminal
 *    `turn_end` the engine yields calls it; so does the driver's AGENT_END emit.
 *
 * NO CLOCK, ON PURPOSE. The first draft (#3447) also carried a wall deadline
 * (`TURN_DEADLINE_MS`). It is gone: a turn that is working is never stopped on time
 * alone (founder law, 22 Sep; #3775). The only cut this object may ever carry is PROVEN
 * non-progress (no model tokens, no tool start or end, no tool output, no heartbeat for
 * a long window), behind its own flag: tool-progress-watch.ts (TOOL_PROGRESS_WATCHDOG_V1),
 * which cuts ONE tool's derived scope and never the root. Nothing in this file aborts the
 * root: only the person's Stop (and the existing gates, through the driver) does.
 *
 * PER-TURN STATE, ONE OBJECT PER RUN. The native loop is persistent: a warm turn
 * re-feeds the same run, and the root controller (Stop's handle) is per run. So the
 * budget lives for the run and `beginTurn()` resets the per-turn state (rounds,
 * spend, ended) at each user turn's head.
 */

/**
 * THE ABORT-REASON CONVENTION (L5; review of #4073, finding 5). One rule for every scope
 * the turn hands out (the budget's child, the sandbox's round scope, a tool's own scope):
 *
 *  · A DERIVED scope aborts with its PARENT's reason, verbatim, never a fresh one, so a
 *    reader at any depth sees why the nearest cutting scope stopped.
 *  · A cut that ORIGINATES at a scope and must be told apart names itself with
 *    `abortReason(name)`: a DOMException named AbortError (what a bare abort() makes), so
 *    every name-based abort classifier still reads it as an abort, with the name as its
 *    message. The first named cut is `non_progress` (tool-progress-watch.ts). Stop and
 *    the round steer keep the platform default: nothing reads them apart.
 */
export function abortReason(name: string): DOMException {
  return new DOMException(name, 'AbortError');
}

/** True when `reason` is the named cut `name` (see abortReason). */
export function isAbortReason(reason: unknown, name: string): boolean {
  return reason instanceof DOMException && reason.name === 'AbortError' && reason.message === name;
}

/**
 * A scope derived from `parent` under the convention above. `release` drops the link,
 * for a short-lived scope (one tool call) on a turn-long parent, which would otherwise
 * leave one listener per call on the parent.
 */
export function deriveAbortScope(parent: AbortSignal): { controller: AbortController; release: () => void } {
  const controller = new AbortController();
  if (parent.aborted) {
    controller.abort(parent.reason);
    return { controller, release: () => {} };
  }
  const onAbort = (): void => controller.abort(parent.reason);
  parent.addEventListener('abort', onAbort, { once: true });
  return { controller, release: () => parent.removeEventListener('abort', onAbort) };
}

export type TurnBudgetExhaustion = 'spend' | 'rounds';

export interface TurnBudgetLimits {
  /** This turn's spend ceiling, USD. Undefined = uncapped. */
  maxSpendUsd?: number;
  /** Max model rounds per turn. Undefined = uncapped (the loop's own `maxTurns` still binds). */
  maxRounds?: number;
}

export interface TurnBudgetOptions extends TurnBudgetLimits {
  /** Reuse a controller the caller already holds (tests); default: a fresh one. */
  controller?: AbortController;
}

export interface TurnBudget {
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  readonly limits: Readonly<TurnBudgetLimits>;
  /**
   * Model rounds in the current USER turn: every round head the loop passes, forced
   * continuations (a Stop hook's re-feed) included. Reset by beginTurn().
   */
  readonly rounds: number;
  readonly spentUsd: number;
  /** The reason the current turn ended, or null while it runs. */
  readonly ended: string | null;
  /** A derived signal: aborts when (and only when) the root aborts. */
  child(): AbortSignal;
  /** Reset the per-turn state at a user turn's head (a warm turn on the same run). */
  beginTurn(): void;
  /** One round head passed; returns the new count. */
  noteRound(): number;
  /** The live ledger's reading of THIS turn's spend. */
  observeSpend(usd: number): void;
  /** Which limit the mirrored counters have reached, if any. */
  exhausted(): TurnBudgetExhaustion | null;
  /**
   * End the current turn. True the first time (sinks fire), false on every later call.
   * The engine calls it as it BUILDS the terminal event, so it fires before that turn_end
   * is yielded, before the next-prompt chip and before the driver's AGENT_END: a sink sees
   * the turn end before anything downstream of the terminal has run.
   */
  end(reason: string): boolean;
  onEnd(cb: (reason: string) => void): () => void;
}

export function createTurnBudget(opts: TurnBudgetOptions = {}): TurnBudget {
  const limits: Readonly<TurnBudgetLimits> = Object.freeze({
    ...(opts.maxSpendUsd !== undefined && { maxSpendUsd: opts.maxSpendUsd }),
    ...(opts.maxRounds !== undefined && { maxRounds: opts.maxRounds }),
  });
  const controller = opts.controller ?? new AbortController();
  const sinks = new Set<(reason: string) => void>();

  let rounds = 0;
  let spentUsd = 0;
  let ended: string | null = null;

  return {
    controller,
    signal: controller.signal,
    limits,
    get rounds() { return rounds; },
    get spentUsd() { return spentUsd; },
    get ended() { return ended; },

    child(): AbortSignal {
      return deriveAbortScope(controller.signal).controller.signal;
    },

    beginTurn(): void {
      rounds = 0;
      spentUsd = 0;
      ended = null;
    },

    noteRound(): number {
      rounds += 1;
      return rounds;
    },

    observeSpend(usd: number): void {
      if (Number.isFinite(usd) && usd > spentUsd) spentUsd = usd;
    },

    exhausted(): TurnBudgetExhaustion | null {
      const { maxSpendUsd, maxRounds } = limits;
      if (maxSpendUsd !== undefined && spentUsd >= maxSpendUsd) return 'spend';
      if (maxRounds !== undefined && rounds >= maxRounds) return 'rounds';
      return null;
    },

    end(reason: string): boolean {
      if (ended !== null) return false;
      ended = reason;
      for (const cb of sinks) {
        try { cb(reason); } catch { /* a sink never affects the turn's exit */ }
      }
      return true;
    },

    onEnd(cb: (reason: string) => void): () => void {
      sinks.add(cb);
      return () => { sinks.delete(cb); };
    },
  };
}
