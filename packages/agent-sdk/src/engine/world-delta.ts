/**
 * HITL world-delta (T3) — the shared copy + threshold for the "time passed / runner
 * recycled" resume context. A HITL pause waits FOREVER; a user can deny 32 hours later
 * on a freshly spawned runner whose /tmp was wiped. Without this, the resumed agent has
 * zero signal that time passed or the environment was recycled, runs `ls`, finds the
 * pre-pause file gone, and can falsely conclude its own gate was violated.
 *
 * This module is the ENGINE-side single source of the copy + humanDuration + the
 * threshold predicate. The kernel `appendWorldDeltaBreadcrumb` takes the built text as
 * an argument (kernel must not import engine → no cycle). The SERVER Claude arm keeps a
 * documented byte-twin of `humanDuration` + the resume line (it does not import the SDK
 * engine); see apps/server/src/services/interaction-continue.service.ts.
 *
 * Copy rules (load-bearing): no em dashes, never names the model/provider.
 */

/** The gap past which a resume carries world-delta context. Below it, the resume is
 *  byte-identical to today (no breadcrumb, no preamble, no extra SYSTEM_RESUME line). */
export const WORLD_DELTA_THRESHOLD_MS = 10 * 60_000;

export interface WorldDelta {
  /** ms between the pause (interaction created_at) and its resolution (resolved_at). */
  elapsedMs?: number;
  /** The resume landed on a cold journal rebuild ⇒ a fresh process ⇒ ephemeral state gone. */
  runnerRecycled?: boolean;
}

/** True when the resume is old enough OR the runner was recycled — either warrants the
 *  world-delta context. Absent worldDelta (legacy / tests) ⇒ false (byte-identical). */
export function worldDeltaMeetsThreshold(wd?: WorldDelta): boolean {
  if (!wd) return false;
  return (wd.elapsedMs !== undefined && wd.elapsedMs > WORLD_DELTA_THRESHOLD_MS) || wd.runnerRecycled === true;
}

/**
 * A human-scaled duration for the resume copy. Tiers (strict upper bounds, so a boundary
 * value falls to the NEXT tier): <90s → 'moments', <90min → 'N minutes', <36h → 'N hours',
 * else 'N days'. `undefined` (runner-recycled with no measured gap) → 'some time'.
 */
export function humanDuration(ms?: number): string {
  if (ms === undefined) return 'some time';
  if (ms < 90_000) return 'moments';
  if (ms < 90 * 60_000) {
    const m = Math.round(ms / 60_000);
    return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
  }
  if (ms < 36 * 3_600_000) {
    const h = Math.round(ms / 3_600_000);
    return `${h} ${h === 1 ? 'hour' : 'hours'}`;
  }
  const d = Math.round(ms / 86_400_000);
  return `${d} ${d === 1 ? 'day' : 'days'}`;
}

/** The system-principal breadcrumb / Claude-arm SYSTEM_RESUME line. */
export function buildWorldDeltaResumeText(elapsedMs?: number): string {
  return (
    `[System] This resume arrives ${humanDuration(elapsedMs)} after the pause. The runtime ` +
    `environment may have been restarted in between: temporary files, working directories, ` +
    `and process state from before the pause may no longer exist. Re-verify current state ` +
    `with tools before drawing conclusions; do not infer that a previously gated action ran.`
  );
}

/** The child re-spawn preamble — the same context, addressed to the subagent in second person. */
export function buildWorldDeltaChildPreamble(elapsedMs?: number): string {
  return (
    `Your earlier tool request paused for user input. This resume arrives ${humanDuration(elapsedMs)} ` +
    `after the pause. The runtime environment may have been restarted in between: temporary files, ` +
    `working directories, and process state from before the pause may no longer exist. Re-verify ` +
    `current state with tools before drawing conclusions; do not infer that a previously gated action ran.`
  );
}
