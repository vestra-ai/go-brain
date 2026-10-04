/**
 * @vestra/agent-sdk/engine — the provider-neutral kernel transport layer (ring 4c).
 *
 * Batteries entry: contains I/O-adjacent types and test doubles (FakeTransport).
 * Import from this subpath, NOT from the bare `@vestra/agent-sdk` root, so
 * the pure root never drags transport types into consumers that only need the
 * contract.
 */
export * from './transport.js';
// Node-built-in I/O leaves relocated out of the pure root barrel (ring-E
// node:fs-in-root fix): these import node:fs, so they live here in the
// batteries entry, NOT in @vestra/agent-sdk root / @bash/shared (browser-safe).
export * from '../kernel/journal/jsonl-store.js';
// JOURNAL_ONE_WRITER_V1: one writer per journal file (node:fs, so batteries entry like the store).
export * from '../kernel/journal/writer-lock.js';
export * from '../kernel/journal/journal-registry.js';
export * from '../kernel/context/volume-context-port.js';
export * from '../kernel/context/retrieval-context-port.js';
export * from './native-capabilities.js';
export * from './capture-signal.js';
export * from './native-pricing.js';
export * from './native-termination.js';
export * from './native-messages.js';
export * from './native-config-like.js';
export * from './native-journal.js';
export { heldAppendLayerIds } from './context-append.js';
export * from './native-hooks.js';
export * from './tool-dispatcher.js';
export * from './tool-billing.js';
// X1: the Stop-continuation wire name, exported so the product can pin it to @bash/shared EVENTS,
// and the documented answers the product's own hook sites give (the Agent tool, mcp_invoke).
export { HOOK_STOP_CONTINUED_EVENT, MAX_STOP_CONTINUE, notifyHooks, subagentStartContext, subagentStopContinuation } from './hook-parity.js';
export { CANCELLED_BY_POLICY } from './round-tool-sequential.js';
// TOOL_SEARCH_V1 — the client-side deferred-tool rail. Exported so the product can
// render the index layer (the deferred names + summaries) into the system prompt
// from the SAME `deferrable` marker the engine shapes the wire with.
export * from './tool-search.js';
// The end-of-task memory sweep. Exported for the SERVER-side mirror guard: SWEEP_SOURCES
// is a hand-written subset of @bash/shared's NAMI_SOURCES, and this package cannot import
// that union (shared depends on THIS package, not the reverse), so the assertion that the
// two agree has to be made where both are visible.
export * from './memory-sweep.js';
export * from './context-offload.js';
export * from './compaction-archive.js';
export * from './subagent-runner.js';
export * from './subagent-pool.js';
export { turnBatchBusy } from './round-tool-batch.js';
export * from './spawn-lane.js';
export * from './main-run-cache-key.js';
// Weave Floor §1a — the session fuel tank + global admission + lock-ordered
// `admitNode` wrapper. Re-exported here (Phase 2) so the Weave tool can route every
// node through the SAME admission stack the main loop uses (shared per-task tank).
export * from './fuel-tank.js';
export * from './child-transport-registry.js';
export * from './native-config.js';
// P5 T5-extension — the recall seam types (RecallSeam / RecallConsultSample)
// for the eval's in-loop arm; the primitives are engine-internal but the seam
// shape is a public injection point (NativeConfig.recall).
export * from './recall.js';
export * from './mcp-retry.js';
export * from './push-queue.js';
export * from './prompt-span.js';
export * from './round-engine.js';
export * from './offloop-usage.js';
// VIDEO_UNDERSTANDING_V1 — the flag accessor on the engine barrel, so the product
// config factory and the engine gate on the same function, plus the `watch` tool
// every model without native video borrows Gemini's eyes and ears with.
export { videoUnderstandingEnabled } from '../policy/feature-flags.js';
export * from './media-watch.js';
// COMPACTION_V2 — the compaction body (trigger/plan/splice/summarize), extracted
// from native-harness.ts under the R3 ratchet. Exported so the perf-budget suite can
// measure the trigger directly instead of casting into a private method.
export * from './compaction-run.js';
export * from './native-harness.js';
export * from './run-context.js';
export * from './dispose.js';
export * from './continue-interaction.js';
export * from './continue-orchestrator.js';
export * from './world-delta.js';
// Phase 4 (§1.7) — composition + policy registries (assembler-time, pure).
export * from '../composition/capability-registry.js';
export * from '../composition/subagent-type-registry.js';
export * from '../composition/routed-spawn.js';
export * from '../composition/subagent-permissions.js';
export * from '../composition/skills-scope.js';
export { withStallGuard, streamStallMs, StreamStalledError, DEFAULT_STREAM_STALL_MS } from './stream-stall-guard.js';
// L5 — the turn's owner: one root signal, mirrored counters, one end(). No clock (turn-budget.ts).
export {
  createTurnBudget,
  deriveAbortScope,
  abortReason,
  isAbortReason,
  type TurnBudget,
  type TurnBudgetLimits,
  type TurnBudgetExhaustion,
} from './turn-budget.js';
// L5 — the non-progress tool watchdog (TOOL_PROGRESS_WATCHDOG_V1): the window and the cut's text.
export { TOOL_PROGRESS_WINDOW_MS, nonProgressText, NonProgressCut, toolWatchdogLine, type ToolWatchdogEvent } from './tool-progress-watch.js';
// Orchestration walls (spec 2026-09-02-orchestration-design) — the ONE source for the
// wall numbers and the refusal/label/preamble strings, so the Agent tool, the round
// tool-batch, the subagent runner and the tool description never drift apart.
export * from './subagent-walls.js';
// The bounded-drain default the walls shrink from (nestedDrainTimeoutMs): the Agent tool
// needs the same number the round core falls back to, so it is exported, never re-typed.
export { DRAIN_DEFAULT_MS } from './abort-drain.js';
