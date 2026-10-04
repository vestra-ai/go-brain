/**
 * routed-spawn.ts — Phase 4 (§1.7 AC-R5) per-node model routing, RESTORED.
 *
 * Weave v0 (§2) cut per-node model routing — every node inherited the parent's
 * model/transport verbatim. This wraps the existing `resolveChildTransport`
 * (Agent-v2 Task 10, already live for `Agent({model})` children) with the
 * STRUCTURAL floor: a requested model below the policy floor is REJECTED
 * (throws), never silently downgraded to the parent's model. Both the Agent
 * tool and Weave route through this SAME function — one spawn path, one floor.
 *
 * SCOPE: called from `apps/sandbox/src/harness/tools/agent-tool.ts` — the
 * `native`/`openai_responses` runtime arms' `Agent`/`Weave` tools. It does NOT
 * cover the Claude Agent SDK arm's own Task tool, nor the `openai` runtime
 * arm's separate `Agent.asTool()` subagents (openai-subagents.ts) — see
 * agent-tool.ts's file header for the full scope note.
 */
import {
  resolveChildTransport,
  type ChildModelOverride,
  type ChildTransportFactory,
  type TransportModelPair,
} from '../engine/child-transport-registry.js';
import { isBelowModelFloor } from './subagent-type-registry.js';
import { KNOWN_MODEL_IDS, resolveCapabilities } from '../contract/model-capabilities.js';

/** AC-R5 — thrown when a spawn requests a model below the policy floor. The
 *  caller (Agent tool / Weave) must surface this as a REJECTION, not fall back
 *  to the parent model — a silent downgrade would defeat the "no Haiku" floor
 *  by letting a rejected request quietly succeed on a different model. */
export class RoutingFloorViolationError extends Error {
  constructor(readonly requestedModel: string) {
    super(
      `Requested model "${requestedModel}" is below the policy floor (no Haiku) — ` +
        `the spawn was REJECTED, not downgraded.`,
    );
    this.name = 'RoutingFloorViolationError';
  }
}

/** Thrown when a spawn requests a model id the registry does not know (`o3`, `gpt-5`, a
 *  typo). Its every round would price at the fail-closed max, a figure the server cannot
 *  price either, so it is REJECTED at spawn, never run unpriced. A floor violation by
 *  subclass: every caller that surfaces the floor as a REJECTION surfaces this one too. */
export class UnknownSpawnModelError extends RoutingFloorViolationError {
  constructor(requestedModel: string) {
    super(requestedModel);
    this.message =
      `Requested model "${requestedModel}" is not a model this runner knows — ` +
      `the spawn was REJECTED. Omit \`model\` to use your own, or name a listed one.`;
    this.name = 'UnknownSpawnModelError';
  }
}

/**
 * Resolve a spawn's routed `{transport, model}` — restoring per-node routing
 * (AC-R5). Identical resolution to `resolveChildTransport` EXCEPT the
 * RESOLVED model (the override's model if given, else — crucially — the
 * PARENT's model, exactly what `resolveChildTransport` would actually run
 * the node on) is floor-checked BEFORE any transport is built, throwing
 * {@link RoutingFloorViolationError} when it is below the floor.
 *
 * This must check the resolved model, not just `override.model`: a session
 * running in "Lite" mode has `claude-haiku-4-5` as its OWN top-level model
 * (AGENT_MODE_MODELS.light), so a spawn with no per-type pin and no per-spawn
 * override would otherwise silently INHERIT Haiku — the exact case the
 * "never Haiku" floor exists to catch. Floor-checking only `override.model`
 * left that inherited path completely unchecked.
 */
export function resolveRoutedSpawn(
  override: ChildModelOverride,
  parent: TransportModelPair,
  makeTransport?: ChildTransportFactory,
): TransportModelPair {
  const resolvedModel = override.model ?? parent.model;
  if (isBelowModelFloor(resolvedModel)) {
    throw new RoutingFloorViolationError(resolvedModel);
  }
  if (!override.model) return resolveChildTransport(override, parent, makeTransport);
  // An override runs as its CANONICAL id: an alias (`gpt-5.6`, a dated snapshot) prices at
  // its real row, and an id the registry does not know never runs at all.
  const canonical = resolveCapabilities(override.model).id;
  if (!KNOWN_MODEL_IDS.includes(canonical)) throw new UnknownSpawnModelError(override.model);
  return resolveChildTransport({ ...override, model: canonical }, parent, makeTransport);
}
