// packages/agent-sdk/src/engine/turn-iteration-result.ts
//
// The shape iterateTurn writes into its out-param. It lives in its own module so
// run()'s extracted phases (native-run-turn.ts) can type against it without
// importing NativeHarness back — the dependency runs class -> phase, and a return
// edge would close a cycle.

import type { TurnOutcome } from '../contract/turn-outcome.js';
import type { ContentBlock } from '../contract/blocks.js';
import type { NormalizedUsage } from './transport.js';

/**
 * The terminal result of one iterate-turn, written into an out-param by the
 * `iterateTurn` async generator (which also yields the turn's streaming events). All
 * fields are set on every path (success, error, abort) before the generator returns.
 */
export interface TurnIterationResult {
  outcome: TurnOutcome;
  blocks: ContentBlock[];
  stopReason: string | null;
  cumulativeCostUsd: number;
  /**
   * The run-scoped parent-OWN cost accumulator after this iterate-turn. Advanced only
   * at the parent's own model rounds (+ compaction + epilogue), NEVER by the child
   * sink, so the per-turn invariant `parentOwn + Σchild === turnDelta` can detect a
   * child mis-count. History: docs/learnings/native-harness-history.md (Billing).
   */
  parentOwnCostUsd: number;
  lastUsage: NormalizedUsage;
  /** Model behind the final round's usage (the committed model — may be the fallback). */
  lastUsageModel: string;
  /**
   * True when the turn ended on a needs-human / Composio-auth PAUSE. The run-loop's
   * Stop re-feed MUST NOT re-feed a paused turn (a synthetic user turn between a paused
   * tool_use and its resolution corrupts the journal pairing). Set on every path.
   * History: docs/learnings/native-harness-history.md (HITL pause / continue).
   */
  pausedHalt: boolean;
  /**
   * An exitReason OVERRIDE for the terminal turn_end — `'preempted_by_human'` when an
   * initiative turn yielded the floor to a staged human turn; absent otherwise → the
   * default `stop(${stopReason})`. History: docs/learnings/native-harness-history.md
   * (Preemption & ambient fuel).
   */
  exitReason?: string;
}
