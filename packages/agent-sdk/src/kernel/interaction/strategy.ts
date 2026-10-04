/**
 * K5-T0 — Human-in-the-loop PAUSE/CONTINUE: the schema + strategy keystone.
 *
 * Pure, kernel-side logic (no I/O, no clock, no provider) for the durable
 * human-in-the-loop primitive (spec: 2026-06-15-vestra-kernel-k5-hitl-pause-continue).
 * Everything that has side effects — appending journal entries, firing the
 * substrate row, re-dispatching a tool — is a LATER task (T1/T2/T3). This module
 * defines only the contracts + the two pure decisions everything else queues
 * behind:
 *   1. MATERIALIZE_STRATEGY — how a resolution of each `InteractionKind` becomes
 *      the continue (the resolution IS the result, vs. re-execute the tool).
 *   2. planMaterialization — given a RESOLVED interaction (kind + outcome),
 *      the pure plan for the continue.
 *   3. buildPending/ResolvedInteractionData — the `data?: unknown` payloads that
 *      ride the FROZEN `interaction` journal entry (zero schema change).
 *
 * The `InteractionKind`/`InteractionOutcome` types are reused VERBATIM from
 * `@bash/shared` (the real kinds; a wrong-keyed Record below is a compile
 * error — that is the exhaustiveness guarantee).
 */

import type { InteractionKind, InteractionOutcome } from '../../contract/interaction.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { SubagentId, SubagentPathSegment } from '../../contract/subagent-path.js';

/**
 * The set of `toolUseId`s that are SUSPENDED: bound to a `resolved:false`
 * interaction entry and not yet answered by a `tool_result`. Pure over the raw
 * journal (interactions are visible there). Single source of truth shared by
 * `suspendPending` (journal projection) and `computePausedToolUseIds` (the
 * compaction pin) so the two never drift.
 */
export function computeSuspendedToolUseIds(all: JournalEntry[]): Set<string> {
  const answered = new Set<string>();
  const pending = new Set<string>();
  for (const e of all) {
    // Defensive: a wire-hydrated entry can arrive payload-less (the mirror's legacy
    // oversize stub). The hydrate seam now screens those, but this function crashed a
    // live dispatch on exactly that shape (2026-07-15) — never trust `payload` here.
    const p = e.payload;
    if (p === undefined || p === null) continue;
    if (p.type === 'tool_result') {
      answered.add(p.toolUseId);
    } else if (p.type === 'interaction' && p.resolved === false) {
      const tuId = (p.data as { toolUseId?: string } | undefined)?.toolUseId;
      if (typeof tuId === 'string') pending.add(tuId);
    }
  }
  return new Set([...pending].filter((id) => !answered.has(id)));
}

/** The two ways a resolution becomes the continue (spec §7). */
export type MaterializeStrategy = 'resolution_is_result' | 're_execute';

/**
 * Exhaustive over the REAL `InteractionKind` union. A missing or extra key is
 * a TypeScript compile error — this Record IS the exhaustiveness test.
 *
 * Two kinds are `re_execute`:
 *  - `composio_auth`: a "connected" resolution carries no tool output, so the only
 *    correct result is the original tool's real run against the now-live connector.
 *  - `tool_permission` (native-perm-reexec): the user APPROVED a paused action tool
 *    (Bash/Write/Edit/Glob/Grep/Composio/WebFetch/Agent/…). The tool was paused via
 *    `needs_human` BEFORE it executed (PAUSED_HALT, no tool_result journaled), so the
 *    approval is the gate decision for its FIRST and ONLY run — RE-EXECUTE it once and
 *    surface its REAL output. Materializing `{"status":"allowed"}` as the result (the
 *    old behavior) left the tool un-run: the curl never POSTed, the file never wrote.
 *    This matches the Claude arm (approve → the SDK runs the tool once). A DENY never
 *    re-executes (the deny branch of `planMaterialization` runs first).
 *
 * The answer-IS-result kinds (`ask_question`/`exit_plan`/`custom`) materialize the
 * resolution AS the tool_result — their execute is a stub and the user's answer/choice
 * IS the output. `credit_approval` and `hands_approval` are `resolution_is_result`
 * for type-exhaustiveness only — both are `server_gate` kinds driven by the gate's
 * own held HTTP response and never enter the K5 continue path (spec §5C).
 * `plan_limit` (engines T5) is the same: server-minted, answered and resumed by the
 * server (driveContinue skips server_gate rows), never bound to a tool_use.
 */
export const MATERIALIZE_STRATEGY: Record<InteractionKind, MaterializeStrategy> = {
  ask_question: 'resolution_is_result',
  tool_permission: 're_execute',
  exit_plan: 'resolution_is_result',
  custom: 'resolution_is_result',
  composio_auth: 're_execute',
  credit_approval: 'resolution_is_result',
  hands_approval: 'resolution_is_result',
  plan_limit: 'resolution_is_result',
};

/**
 * native-redrive — the bound TOOLS whose `re_execute` is a SUBAGENT RE-SPAWN, not a
 * leaf-tool re-run. Since native-perm-reexec made `tool_permission` itself a
 * `re_execute` kind (the general "approve → run the approved tool once" rule), this set
 * no longer CHANGES the strategy — every `tool_permission` ALLOW already re-executes.
 * It is now a TAG the sandbox's `materializeReExecute` reads to pick the right
 * re-dispatch shape:
 *   - `Agent` → re-SPAWN the subagent (a nested native loop; a residual inner-tool
 *     re-pause re-suspends with a FRESH interaction bound to the SAME parent tool_use).
 *   - any other tool → re-RUN the leaf action tool (Bash/Write/Edit/Composio/…) once
 *     under a one-shot allow and settle its real output.
 *
 * Kept a small, explicit kernel policy (mirrors MATERIALIZE_STRATEGY being a kernel
 * constant): the tool name is the durable, FROZEN `PendingInteractionData.toolName`
 * signal — no new entry kind, no schema change. DENY is never re-executed (the
 * planMaterialization deny branch runs first): a declined permission settles a
 * structured `declined` result, NOT a run/re-spawn.
 */
export const REEXECUTE_BOUND_TOOLS: ReadonlySet<string> = new Set(['Agent']);

/**
 * P3.3 (control-plane durable Weave pause) — the script-orchestration tool whose
 * BOUND pauses re-dispatch the SCRIPT (for ALLOW and DENY alike) instead of the
 * leaf. Deliberately NOT in REEXECUTE_BOUND_TOOLS: that set also drives the
 * round-engine's concurrent-batch trigger and the subagent re-spawn shape, and
 * Weave must stay out of both (pinned invariant). `reconcileInteractions` keys on
 * the JOURNALED tool_use name — the PENDING marker's `toolName` is the LEAF call's
 * name (what the approval card shows), so the marker alone cannot identify a
 * Weave-bound pause.
 */
export const WEAVE_REEXECUTE_TOOL = 'Weave';

/**
 * Resolve the materialize strategy for an ALLOW resolution. After native-perm-reexec
 * the per-kind MATERIALIZE_STRATEGY already covers every tool (`tool_permission` and
 * `composio_auth` are `re_execute`; the answer-IS-result kinds are not), so this is a
 * thin pass-through that keeps the tool-aware signature stable for callers. The
 * `toolName` is retained (and consulted via REEXECUTE_BOUND_TOOLS as a defensive
 * floor) so a future `resolution_is_result` kind bound to a re-spawn tool would still
 * re-execute. Pure.
 */
export function resolveMaterializeStrategy(kind: InteractionKind, toolName: string | undefined): MaterializeStrategy {
  if (toolName !== undefined && REEXECUTE_BOUND_TOOLS.has(toolName)) return 're_execute';
  return MATERIALIZE_STRATEGY[kind];
}

/**
 * The pure plan a resolution yields. The kernel's continue path (T1/T3) executes
 * it: `result` → append this as the bound tool_use's `tool_result`; `re_execute`
 * → re-dispatch the original tool and use its output.
 */
export type MaterializationPlan =
  | { action: 'result'; content: string; isError: false }
  | { action: 're_execute' };

/**
 * Continue-alongside (durable suspend/resume): the synthetic tool_result that
 * settles a paused tool_use's slot WHILE its interaction stays pending, so the
 * conversation can continue and the model stays aware it still owes that task.
 * Distinct from a deny `status:'redirected'` (which RESOLVES/cancels) — `deferred`
 * does NOT resolve the interaction. Non-error so the model pivots, never apologizes.
 */
export const DEFERRED_STATUS = 'deferred';

export function buildDeferredResultContent(note?: string): string {
  return JSON.stringify({
    status: DEFERRED_STATUS,
    ...(note ? { note } : {}),
  });
}

export function isDeferredResultContent(content: string): boolean {
  try {
    return (JSON.parse(content) as { status?: unknown })?.status === DEFERRED_STATUS;
  } catch {
    return false;
  }
}

/**
 * P5.1 (Agent Teams) — the settle marker for a DELEGATED tool_use: the parent
 * Agent tool (mode:'teammate') spawned a teammate — a task-scoped actor with its
 * own live lane — and this synthetic tool_result closes the parent's tool slot,
 * carrying the child's identity. Distinct from `deferred`: a deferred result is
 * NOT a real answer (the interaction stays pending), whereas a delegated result
 * IS the final answer for that slot (the live teammate lane carries the work
 * forward). Downstream treats the two OPPOSITELY, so the detectors are mutually
 * exclusive by construction (distinct `status` sentinels).
 */
export const DELEGATED_STATUS = 'delegated';

/**
 * Phase 2 (background helpers) — `extra` carries the HELPER shape: `kind:'helper'`
 * marks a depth-0 background helper (its own actor on the teammate rail, no roster
 * slot), `note` is what the MODEL reads in place of a result ("Helper launched
 * in the background…"), and `description` is the brief that TITLES the helper's
 * lane (R76: the marker is the only spawn record a reload has, so a description
 * left off here comes back as the minted handle). `addressable` (Phase 3, spec
 * 2026-09-05 §4.6) says the PERSON can message this helper, and rides here for the
 * same reason the description does: the reload path has no other record of it.
 * All three are omitted for a teammate, so the teammate marker string is byte-identical
 * to the pre-Phase-2 one — a live journal full of teammate markers keeps parsing on
 * exactly the shape it was written with.
 */
export function buildDelegatedResultContent(
  name: string,
  teammateTaskId: string,
  extra?: { kind: 'helper'; note: string; description?: string; addressable?: true },
): string {
  return JSON.stringify({ status: DELEGATED_STATUS, name, teammateTaskId, ...(extra ?? {}) });
}

export function isDelegatedResultContent(content: unknown): boolean {
  if (typeof content !== 'string') return false;
  try {
    return (JSON.parse(content) as { status?: unknown })?.status === DELEGATED_STATUS;
  } catch {
    return false;
  }
}

export function parseDelegatedResultContent(
  content: unknown,
): {
  name: string;
  teammateTaskId: string;
  kind?: 'helper';
  note?: string;
  description?: string;
  addressable?: true;
} | null {
  if (typeof content !== 'string') return null;
  try {
    const parsed = JSON.parse(content) as {
      status?: unknown;
      name?: unknown;
      teammateTaskId?: unknown;
      kind?: unknown;
      note?: unknown;
      description?: unknown;
      addressable?: unknown;
    };
    if (parsed?.status !== DELEGATED_STATUS) return null;
    if (typeof parsed.name !== 'string' || typeof parsed.teammateTaskId !== 'string') return null;
    // Conditional spreads, never `kind: undefined`: a teammate marker parses to the
    // SAME two-key object it always did, so every `toEqual` on the old shape holds.
    return {
      name: parsed.name,
      teammateTaskId: parsed.teammateTaskId,
      ...(parsed.kind === 'helper' ? { kind: 'helper' as const } : {}),
      ...(typeof parsed.note === 'string' ? { note: parsed.note } : {}),
      ...(typeof parsed.description === 'string' ? { description: parsed.description } : {}),
      // Phase 3 (§4.6) — literally `true`, never merely truthy: this marker is journal
      // text, and it is what a RELOAD rebuilds an addressable lane from. Anything else
      // reads as the Phase 2 helper it is.
      ...(parsed.addressable === true ? { addressable: true as const } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Plain-language deny result the MODEL reads directly off the tool_result. We deliberately
 * do NOT emit a bare `{"status":"declined"}` JSON: the model reads tool_result text as the
 * TOOL'S OWN OUTPUT, so a bare status reads as the command's stdout. Live bug (task
 * 0046b07f): a denied `rm -rf` materialized `{"status":"declined","reason":"user_declined"}`,
 * the model thought *"the rm -rf command returned a JSON response? That's odd"*, checked the
 * folder, decided *"let me try again"*, and RE-RAN the command → a permission re-prompt loop.
 * Spell out, unambiguously, that the action was refused and must not be retried.
 */
function denyMessage(reason: Extract<InteractionOutcome, { behavior: 'deny' }>['reason']): string {
  switch (reason) {
    case 'user_declined':
      return 'The user DECLINED to approve this action, so the tool was NOT run. Do not attempt it again. Acknowledge their decision and ask what they would like to do instead.';
    case 'user_skipped':
      return 'The user SKIPPED this action, so the tool was NOT run. Continue without it; do not retry it.';
    case 'timed_out':
      return 'The permission request received NO response in time, so the tool was NOT run. Do not retry it now; continue or ask the user how to proceed.';
    case 'aborted':
      return 'This action was ABORTED, so the tool was NOT run. Stop here; do not retry it.';
    case 'user_redirected':
      return 'The user gave a NEW instruction instead of approving this action, so the tool was NOT run. Do not run it. Follow the user\'s new instruction instead.';
    case 'awaiting_user_input':
      // The pause halt sentinel — NOT a resolution. planMaterialization guards this.
      throw new Error('planMaterialization: awaiting_user_input is the pause sentinel, not a resolution');
    default: {
      // Compile-time exhaustiveness: a new InteractionDenyReason makes `reason`
      // non-`never` here and fails the build — self-documents the guarantee even
      // if tsconfig's noImplicitReturns is ever loosened.
      const _exhaustive: never = reason;
      throw new Error(`planMaterialization: unhandled deny reason ${String(_exhaustive)}`);
    }
  }
}

/**
 * Pure: given a RESOLVED interaction's kind + outcome, plan the continue (spec §7).
 *
 * - DENY / EXPIRED / CANCELLED (any kind) → a deterministic, non-error tool_result
 *   carrying the structured reason. The model reads it as a normal result and
 *   pivots — never an apology, never a re-prompt. (composio_auth DENY does NOT
 *   re-execute.)
 * - ALLOW → the kind's strategy decides: `re_execute` (composio_auth) or
 *   `resolution_is_result` (the rest), where the result is `outcome.updatedInput`.
 *
 * Throws on the `awaiting_user_input` sentinel — that is the pause halt and must
 * never reach the continue path (fail-loud on a logic bug).
 *
 * `toolName` (the bound tool, from the FROZEN `PendingInteractionData`) makes the
 * ALLOW strategy tool-aware: a subagent (`Agent`) pause re-executes even though its
 * kind is `tool_permission` (see REEXECUTE_BOUND_TOOLS). Optional for back-compat —
 * an omitted name falls back to the per-kind strategy (the pre-native-redrive
 * behavior, byte-identical for every non-subagent caller/test).
 */
export function planMaterialization(
  kind: InteractionKind,
  outcome: InteractionOutcome,
  toolName?: string,
): MaterializationPlan {
  if (outcome.behavior === 'deny') {
    const base = denyMessage(outcome.reason); // throws on awaiting_user_input
    return {
      action: 'result',
      // PLAIN LANGUAGE, not JSON (see denyMessage). The model reads tool_result text as the
      // tool's own stdout, so a bare `{"status":"declined"}` confused it into retrying the
      // refused action (re-prompt loop, task 0046b07f). A clear sentence makes it pivot.
      content: outcome.message ? `${base} (${outcome.message})` : base,
      isError: false,
    };
  }
  // ALLOW
  if (resolveMaterializeStrategy(kind, toolName) === 're_execute') {
    return { action: 're_execute' };
  }
  return {
    action: 'result',
    content: JSON.stringify(outcome.updatedInput ?? { status: 'allowed' }),
    isError: false,
  };
}

// ── FROZEN journal `interaction` payload `data` shapes (zero schema change) ──
//
// Both ride `{ type:'interaction'; interactionId; resolved; data?: unknown }`
// (packages/shared/src/journal/entry.ts:16). CONTEXT_POLICY[interaction] === false
// → these are kernel control records, never replayed into model context.

/** The pending marker's `data`, binding the interaction to its tool_use (written at fire time). */
export interface PendingInteractionData {
  kind: InteractionKind;
  toolUseId: string;
  toolName: string;
  /**
   * T3 (subagent-deep-HITL) — OPTIONAL routing/attribution metadata. The leaf
   * subagent's stable id + the root→leaf path, present only when a subagent at
   * depth ≥ 1 raised this interaction. Absent for a main-agent pause ⇒ the
   * recorded `data` is byte-identical to today. Inert until a later task
   * populates them.
   */
  subagentPath?: SubagentPathSegment[];
  subagentId?: SubagentId;
  /**
   * P3.3 (durable Weave pause) — present ONLY on a pause bound to a `Weave`
   * tool_use: the stable hash of the captured pending LEAF call
   * (`hashNodeSpec({toolName, input})`). The continue path threads it into the
   * script re-dispatch as the ONE-SHOT approval/deny match key — the re-generated
   * leaf call auto-resolves IFF its hash matches what the user actually saw
   * (hash mismatch ⇒ a fresh pause, never a blind auto-allow). This is the only
   * durable sandbox-side home for the leaf identity (the continue payload carries
   * no call). Absent everywhere else ⇒ byte-identical marker data.
   *
   * P3.5b (Fix 1) — `nodeSpecHash` (the paused NODE's content-derived spec identity)
   * and `scopeId` (its journal scope — the node dispatch's toolCallId, the pause
   * bubble's path root) freeze WHICH node paused and WHERE its pre-pause rounds
   * live, so the resume re-enters that node from its journaled rounds and the gated
   * leaf is CONTINUED byte-stably instead of re-composed (the composed-content
   * drift IMPORTANT-1 closed). Both absent on a pre-P3.5b marker ⇒ the
   * regenerate-from-scratch resume (fails safe: a drifted leaf re-pauses fresh).
   */
  weavePending?: { contentHash: string; nodeSpecHash?: string; scopeId?: string };
}

/** The resolution marker's `data`, appended on continue (append-only; the pending entry is never mutated). */
export interface ResolvedInteractionData {
  outcome: InteractionOutcome;
  /** ISO timestamp, INJECTED by the caller (kernel purity: this module never reads the clock). */
  materializedAt: string;
}

export function buildPendingInteractionData(
  kind: InteractionKind,
  toolUseId: string,
  toolName: string,
  subagentPath?: SubagentPathSegment[],
  subagentId?: SubagentId,
  weavePending?: { contentHash: string; nodeSpecHash?: string; scopeId?: string },
): PendingInteractionData {
  return {
    kind,
    toolUseId,
    toolName,
    // Conditional-spread: absent ⇒ the key is OMITTED (never set to undefined),
    // so a main-agent pause records exactly `{ kind, toolUseId, toolName }`.
    ...(subagentPath !== undefined && { subagentPath }),
    ...(subagentId !== undefined && { subagentId }),
    ...(weavePending !== undefined && { weavePending }),
  };
}

export function buildResolvedInteractionData(
  outcome: InteractionOutcome,
  materializedAt: string,
): ResolvedInteractionData {
  return { outcome, materializedAt };
}

// ── The primitive's CONTRACT (signature only; orchestration is T2) ──

/**
 * The pause halt a tool's request returns. Equal to today's `awaitInteraction`
 * halt — the `awaiting_user_input` deny — so the turn ends cleanly and the
 * sandbox is free to idle (no keep-alive billing).
 */
export type PauseSignal = Extract<InteractionOutcome, { behavior: 'deny' }> & { reason: 'awaiting_user_input' };

/** The payload a tool hands `requestHumanInput` (binds the pending interaction to the tool_use). */
export interface RequestHumanInputPayload {
  toolUseId: string;
  toolName: string;
  toolInput: unknown;
  /** Per-kind extras carried verbatim to the substrate row (questions, composio toolkit, …). Opaque here. */
  extras?: unknown;
}

/**
 * The kernel-facing primitive (contract only — T2 implements the orchestration:
 * journal-bind the pending interaction, fire the substrate row via the injected
 * registrar, emit INTERACTION_REQUIRED, return the halt). Named `requestHumanInput`;
 * the shared gateway it wraps is `fireHarnessInteraction` (renamed from the
 * `fireOpenAIInteraction` misnomer).
 */
export type RequestHumanInput = (
  kind: InteractionKind,
  payload: RequestHumanInputPayload,
) => Promise<PauseSignal>;
