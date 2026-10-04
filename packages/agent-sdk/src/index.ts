/**
 * @vestra/agent-sdk — the Vestra Agent SDK.
 * A provider-agnostic agent framework (the "native" harness), extracted from
 * the Vestra product so it can be consumed, sold, or open-sourced standalone.
 * See docs/superpowers/specs/2026-06-18-vestra-agent-sdk-extraction-design.md
 */
export const VESTRA_AGENT_SDK_NAME = '@vestra/agent-sdk';

// ── Harness contract (the swappable-harness spine) ──────────────────────────
export * from './contract/ids.js';
export * from './contract/capabilities.js';
export * from './contract/permission.js';
export * from './contract/openai-pricing.js';
export * from './contract/gemini-pricing.js';
export * from './contract/usage-pricing.js';
export * from './contract/responses-usage.js';
export * from './contract/usage-wire.js';
export * from './contract/compaction-prompt.js';
export * from './contract/resume-protocol.js';
export * from './contract/profile.js';
export * from './contract/instruction-stack.js';
export * from './contract/turn-outcome.js';
export * from './contract/terminal-reason.js';
export * from './contract/output-format.js';
export * from './contract/cache-prefix-hint.js';
export * from './contract/validate-output.js';
export * from './contract/blocks.js';
export * from './contract/interaction.js';
export * from './contract/paused-halt.js';
export * from './contract/events.js';
export * from './contract/child-cost.js';
export * from './contract/subagent-path.js';
export * from './contract/harness.js';
export * from './contract/journal.js';
export * from './contract/model-capabilities.js';
export * from './contract/fireworks-wire.js';
export * from './contract/model-profile.js';
export * from './contract/ability-evals.js';
export * from './contract/ability.js';
export * from './contract/ability-frontmatter.js';
export * from './contract/ability-hooks.js';
export * from './contract/injected-user-text.js';
export * from './contract/compaction-summary-check.js';
export * from './contract/ability-synthesis.js';
export * from './contract/active-ability.js';
export * from './contract/run-state.js';
export * from './kernel/index.js';
export * from './ports/index.js';
// ROOT IS PURE: contract + kernel + ports + policy engine + tool TYPES only.
// The generic tools (read/write/edit/glob/grep/bash + fs/process substrate) do
// real I/O and live behind the `@vestra/agent-sdk/tools` entry (./tools/index.js),
// so importing the SDK contract never drags node:fs/child_process into a consumer.
export * from './tools/tool-types.js';
// Bash [cwd: …] trailer format — pure string logic (no I/O), so consumers that
// parse Bash output bytes (sandbox detection hooks) can strip it from the root.
export * from './tools/cwd-trailer.js';
export * from './policy/index.js';
// HITL world-delta (T3): pure copy/threshold helpers (no I/O) re-exported at the
// root so classic-moduleResolution consumers (apps/server, node10) can import them —
// the ./engine subpath export resolves only under node16/bundler resolution.
export {
  WORLD_DELTA_THRESHOLD_MS,
  worldDeltaMeetsThreshold,
  humanDuration,
  buildWorldDeltaResumeText,
  buildWorldDeltaChildPreamble,
  type WorldDelta,
} from './engine/world-delta.js';
// Pricing: the Anthropic per-model cost function, re-exported at the root so
// classic-moduleResolution consumers (apps/server credit.service) can single-source
// their Anthropic token rates from the SAME function the native arm bills from,
// without the ./engine subpath (which resolves only under node16/bundler).
export { computeAnthropicCostUsd, type AnthropicUsage } from './engine/native-pricing.js';
// The INCLUSIVE live spend ledger: the host (sandbox) mints one per query and threads
// it through NativeConfig so in-flight spend is readable while children still burn.
export { createLiveSpendLedger, foldModelSpend, turnSpendCeilingReached, type LiveSpendLedger } from './engine/live-spend.js';
