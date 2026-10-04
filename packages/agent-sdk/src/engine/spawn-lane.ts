/**
 * WHICH SLUG A SINGLE `Agent` SPAWN RUNS UNDER — the one place that decides it.
 *
 * Two call sites need the same answer and must not drift:
 *
 *  - `agent-tool.ts` resolves the spawn for real. It owns the roster, so it alone
 *    can say whether a requested type exists, and it mints the effective agent as
 *    `found?.agent ?? { slug: spec.name! }` — i.e. the INLINE lane is slugged with
 *    the caller's `name`.
 *  - `round-engine.ts` synthesizes each concurrent lane's `subagent:start` UP-FRONT,
 *    before the lane's own start can drain, so the web never invents a "queued"
 *    state for a lane that is genuinely executing. It has no roster.
 *
 * The engine's synthetic start and the lane's real start carry the SAME
 * `agentSlug`, so a disagreement here would relabel the lane until the real start
 * lands. Keeping the rule in one module is what makes them agree by construction
 * rather than by two comments promising to.
 */

/**
 * The documented sentinel: `subagent_type:"custom"` asks for an on-the-fly agent
 * built from `name` + `prompt`. It is only a REQUEST — an installed ability
 * slugged "custom" still wins (resolution order is roster → built-in → inline),
 * which is why `isInlineLane` takes the roster's answer rather than assuming one.
 */
export const INLINE_LANE_SENTINEL = 'custom';

/** The spawn fields both call sites read off an `Agent` tool_use input. */
export interface SpawnLaneFields {
  subagent_type?: unknown;
  name?: unknown;
  children?: unknown;
}

/** `subagent_type` normalized to a slug — `''` when absent or not a string. */
export function requestedLaneType(input: unknown): string {
  const t = (input as SpawnLaneFields | null | undefined)?.subagent_type;
  return typeof t === 'string' ? t : '';
}

/**
 * Is this spawn the INLINE lane — an on-the-fly agent slugged by its `name`?
 *
 * True when no type was requested, or when the `'custom'` sentinel was requested
 * AND no roster entry claims that slug. `rosterClaims` is the caller's roster
 * answer; a caller without a roster (the engine) passes `false`, which resolves
 * `'custom'` to the inline reading — the overwhelmingly common one, and self-
 * correcting anyway since the lane's real start is last-write-wins on toolUseId.
 */
export function isInlineLane(requested: string, rosterClaims: boolean): boolean {
  return requested === '' || (requested === INLINE_LANE_SENTINEL && !rosterClaims);
}

/**
 * The lane slug for a SINGLE-child spawn, or `undefined` when there is nothing to
 * name yet.
 *
 * `undefined` for a `children[]` batch — one tool_use fanning out N children with
 * their own ids is out of scope for an up-front per-lane start, and each child
 * keeps its natural start timing. Also `undefined` for an inline spawn with no
 * usable `name` (agent-tool rejects that spawn loudly; the engine simply has no
 * slug to announce).
 */
export function spawnLaneSlug(input: unknown): string | undefined {
  const fields = (input ?? {}) as SpawnLaneFields;
  if (Array.isArray(fields.children)) return undefined;
  const requested = requestedLaneType(fields);
  const name = typeof fields.name === 'string' && fields.name.length > 0 ? fields.name : undefined;
  // No roster here — see `isInlineLane`.
  if (!isInlineLane(requested, false)) return requested;
  return name ?? (requested === '' ? undefined : requested);
}
