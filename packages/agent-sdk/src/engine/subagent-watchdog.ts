/**
 * subagent-watchdog.ts — the runaway guard (bounded progress), extracted as its
 * own module per the billing-tripwire precedent (grow a new module, never the
 * loop file). One counting core, two factories: the SUBAGENT loops
 * (runSubagentLoop, PR #2743) and the PARENT loop (iterateTurn, W3-3) share
 * identical thresholds, reset rules and directive by design — only the trip
 * WARN's identity line differs.
 *
 * Incident class (2026-08-20): a Researcher subagent livelocked 45+ minutes
 * calling WebSearch ~5x/sec against a billing-dead vendor — every call
 * identical, every result an error. The vendor-402 breaker killed THAT
 * trigger; this guard covers the CLASS: any always-failing tool can spin a
 * model in a retry loop — inside a subagent (where the parent has zero
 * visibility: the turn never ends, no agent_turns row is written) or in the
 * parent turn itself.
 *
 * Level-triggered on OBSERVED behavior — never wall-clock:
 *  - N consecutive IDENTICAL failing calls (same tool + normalized args) trip;
 *  - M consecutive failing calls of ANY shape trip;
 *  - any successful dispatch resets both counters.
 * "Failing" = ToolDispatchResult.isError (the structured error channel: a
 * thrown execute, an unknown tool, a taxonomy-stamped sentinel) — never prose
 * matching. Repeated IDENTICAL SUCCESSES deliberately never trip: polling a
 * status tool is legitimate, the loop has no progress signal for successful
 * results, and maxTurns already bounds the run.
 *
 * State is strictly per-instance (closure) — one watchdog per runSubagentLoop
 * invocation / per parent turn, so concurrent loops never share counters. No
 * feature flag: the closest sibling guard (billing-tripwire) wears none, and
 * the guard is pure observation until the pathological trip.
 */

/** Consecutive IDENTICAL (tool + normalized args) failures that trip the guard. */
export const SUBAGENT_RUNAWAY_IDENTICAL_LIMIT = 8;
/** Consecutive failures of ANY shape that trip the guard. */
export const SUBAGENT_RUNAWAY_FAILURE_LIMIT = 25;
/** Model rounds allowed AFTER the directive is injected before the loop force-finishes. */
export const SUBAGENT_RUNAWAY_GRACE_ROUNDS = 2;

/**
 * The terminal steer, used BOTH as the injected user directive and as the
 * refusal text for any tool call attempted after the trip (the loop's gate
 * wrapper denies with this exact message).
 */
export { SUBAGENT_RUNAWAY_DIRECTIVE } from '../contract/injected-user-text.js';

export interface SubagentRunawayTrip {
  reason: 'identical_failures' | 'consecutive_failures';
  /** The tool whose failure crossed the limit. */
  toolName: string;
  consecutiveIdenticalFailures: number;
  consecutiveFailures: number;
}

export interface SubagentRunawayWatchdog {
  /** Latched TRUE from the trip observation onward. */
  readonly tripped: boolean;
  /**
   * Feed one settled model-driven dispatch (paused results are the caller's
   * concern to exclude — a pause is a wait, not a failure). Returns the trip
   * EXACTLY ONCE, on the crossing observation; null before and after.
   */
  observe(toolName: string, toolInput: unknown, isError: boolean): SubagentRunawayTrip | null;
}

/** Loop-neutral aliases (W3-3): the trip/watchdog shapes are shared verbatim by
 *  both factories; the Subagent-prefixed names stay canonical (rename nothing). */
export type RunawayTrip = SubagentRunawayTrip;
export type RunawayWatchdog = SubagentRunawayWatchdog;

/**
 * Order-insensitive identity for tool args: stable stringify with object keys
 * sorted at every depth (model-authored JSON — no cycles). `undefined` input
 * (a no-arg call) maps to a fixed token so it still forms an identity key.
 */
function canonicalArgsKey(input: unknown): string {
  return (
    JSON.stringify(input, (_k, v: unknown) =>
      v !== null && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          )
        : v,
    ) ?? 'undefined'
  );
}

/**
 * The shared counting core: latch-once trip over consecutive-failure windows.
 * `onTrip` fires EXACTLY ONCE, on the crossing observation — the factories use
 * it for their one structured WARN (the billing-tripwire convention: warn in
 * the checker, promote in the caller).
 */
function createRunawayWatchdog(
  identicalLimit: number,
  consecutiveLimit: number,
  onTrip: (trip: RunawayTrip) => void,
): RunawayWatchdog {
  let consecutiveFailures = 0;
  let consecutiveIdentical = 0;
  let lastFailureKey: string | null = null;
  let trip: RunawayTrip | null = null;

  return {
    get tripped(): boolean {
      return trip !== null;
    },
    observe(toolName: string, toolInput: unknown, isError: boolean): RunawayTrip | null {
      if (trip !== null) return null; // latched — refusals after the trip never recount
      if (!isError) {
        consecutiveFailures = 0;
        consecutiveIdentical = 0;
        lastFailureKey = null;
        return null;
      }
      consecutiveFailures += 1;
      const key = `${toolName}\u0000${canonicalArgsKey(toolInput)}`;
      consecutiveIdentical = key === lastFailureKey ? consecutiveIdentical + 1 : 1;
      lastFailureKey = key;
      if (consecutiveIdentical < identicalLimit && consecutiveFailures < consecutiveLimit) return null;
      trip = {
        reason: consecutiveIdentical >= identicalLimit ? 'identical_failures' : 'consecutive_failures',
        toolName,
        consecutiveIdenticalFailures: consecutiveIdentical,
        consecutiveFailures,
      };
      onTrip(trip);
      return trip;
    },
  };
}

/** The trip WARN's shared key=value tail — one format, both loops' pagers. */
function tripLine(trip: RunawayTrip): string {
  return (
    `runaway tripped: reason=${trip.reason} tool=${trip.toolName} ` +
    `consecutiveIdenticalFailures=${trip.consecutiveIdenticalFailures} consecutiveFailures=${trip.consecutiveFailures}`
  );
}

export function createSubagentRunawayWatchdog(opts: {
  /** The subagent node id (the Agent tool_use id) — carried on the trip WARN. */
  childId: string;
  /** The model the nested run is on — carried on the trip WARN. */
  model: string;
  /** Test-overridable limits; production callers use the named defaults. */
  identicalFailureLimit?: number;
  consecutiveFailureLimit?: number;
}): SubagentRunawayWatchdog {
  return createRunawayWatchdog(
    opts.identicalFailureLimit ?? SUBAGENT_RUNAWAY_IDENTICAL_LIMIT,
    opts.consecutiveFailureLimit ?? SUBAGENT_RUNAWAY_FAILURE_LIMIT,
    (trip) =>
      console.warn(
        `[SubagentRunner][runaway-watchdog] ${tripLine(trip)} childId=${opts.childId} model=${opts.model}`,
      ),
  );
}

/**
 * W3-3 — the PARENT loop's factory (iterateTurn owns one per turn). Identical
 * thresholds, reset rules and latch as the subagent guard by design; only the
 * trip WARN's identity line differs (taskId instead of childId).
 */
export function createParentRunawayWatchdog(opts: {
  /** The parent task id — carried on the trip WARN. */
  taskId: string;
  /** The model the turn is on — carried on the trip WARN. */
  model: string;
  /** Test-overridable limits; production callers use the named defaults. */
  identicalFailureLimit?: number;
  consecutiveFailureLimit?: number;
}): RunawayWatchdog {
  return createRunawayWatchdog(
    opts.identicalFailureLimit ?? SUBAGENT_RUNAWAY_IDENTICAL_LIMIT,
    opts.consecutiveFailureLimit ?? SUBAGENT_RUNAWAY_FAILURE_LIMIT,
    (trip) =>
      console.warn(`[NativeHarness][runaway-watchdog] ${tripLine(trip)} taskId=${opts.taskId} model=${opts.model}`),
  );
}
