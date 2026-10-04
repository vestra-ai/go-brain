/**
 * HarnessCapabilities — the manifest each arm declares so the UI and router
 * can ADAPT to engine superpowers rather than flatten them. This is the
 * "capability-aware surface" (spec §2, §4.3): a feature absent on one arm is
 * declared false/0, the block simply isn't emitted, and the UI degrades
 * gracefully. Grows by ADDITION — never freeze to the intersection.
 */
export interface HarnessCapabilities {
  /** Streams a discrete reasoning/thinking block (Claude ✓; OpenAI reasoning ~; gate the UI pane on this). */
  thinking: boolean;
  /** Reports prompt-cache token fields on usage (Claude ✓; others ✗). */
  promptCaching: boolean;
  /** Can rewrite tool args inline at approval time (Claude canUseTool.updatedInput ✓; OpenAI ✗ → tool wrapper). */
  inlineToolArgRewrite: boolean;
  /** A paused tool call can be serialized and resumed in a DIFFERENT process (OpenAI RunState ✓; Claude architectural-only ✗). */
  resumeSurvivesRestart: boolean;
  /** Has a native subagent/handoff mechanism. */
  nativeSubagents: boolean;
  /** Reports dollar cost directly on usage (Claude total_cost_usd ✓; others derive from token×pricing). */
  reportsCostUsd: boolean;
  /** Pre-spawns a reusable warm query/connection on first-keystroke so USER_MESSAGE attaches instantly (Claude SDK query ✓; OpenAI builds its Agent per-turn on USER_MESSAGE ✗ → prewarm is a no-op). */
  usesWarmQueryPool: boolean;
  /** Max context window in tokens — a NUMBER the router reads (e.g. a long-context arm). 0 = unknown. */
  maxContextTokens: number;
  /**
   * K6 P4: the arm DERIVES and surfaces its own user-facing terminal reason
   * (the synthesized AGENT_END `terminalReason` + footer chip), because its
   * provider transport has no native result footer. The Claude SDK arm leaves
   * this OFF (default false) → its AGENT_END stays byte-identical. Optional so
   * any partial capability literal (and any future arm that forgets it) defaults
   * to the byte-identical-safe behavior. NOTE: deliberately NOT keyed off
   * `reportsCostUsd` — post-K3-T4 EVERY arm sets reportsCostUsd:false, so that
   * axis can no longer distinguish Claude from the native-family arms.
   */
  surfacesTerminalReason?: boolean;
  /**
   * P2.4: the arm can REWIND its journaled context to a chosen checkpoint
   * (`Journal.rewindTo` + `applyRewind`). The native arm owns its journal, so it can
   * pivot the projection (rewind:true); the Claude SDK arm cannot rewind the SDK's own
   * transcript (rewind:false) → the driver/UI hides the rewind affordance honestly.
   * Optional so any partial capability literal (and any arm that forgets it) defaults to
   * the safe rewind:false. No product entry point invokes a rewind yet (harness to nine R4).
   */
  rewind?: boolean;
  /**
   * The arm can ABSORB a mid-turn steer: a message queued while a turn is in flight
   * redirects THAT turn instead of retiring it. Requires both halves of the P3 steer seam —
   * a round-abort the driver can fire (`actor.roundAbort`) and a `drainSteerText` pull the
   * loop consults at its round head. An arm with neither must declare FALSE, or the steer
   * branch arms a drain nobody reads and fires an abort nobody wired: the turn runs to
   * completion while the user's Stop appears to have done something.
   *
   * Optional, defaulting to false, so an arm that forgets it falls back to
   * retire-and-redrive — the path that works for every arm.
   */
  steerMidTurn?: boolean;
}

/**
 * Conservative defaults (everything off / unknown). An arm calls this with
 * overrides for the capabilities it actually has.
 */
export function defaultCapabilities(
  overrides: Partial<HarnessCapabilities> = {},
): HarnessCapabilities {
  return {
    thinking: false,
    promptCaching: false,
    inlineToolArgRewrite: false,
    resumeSurvivesRestart: false,
    nativeSubagents: false,
    reportsCostUsd: false,
    usesWarmQueryPool: false,
    maxContextTokens: 0,
    surfacesTerminalReason: false,
    rewind: false,
    steerMidTurn: false,
    ...overrides,
  };
}
