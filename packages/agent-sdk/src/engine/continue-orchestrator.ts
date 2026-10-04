/**
 * K5-T5b — orchestrateContinue: the sandbox CONTINUE_INTERACTION orchestration
 * (spec §6). The server resolves the interaction (CAS + outcome) and pushes a
 * typed `CONTINUE_INTERACTION` event; this drives the four pure decisions, in
 * order, over the task's ONE journal:
 *
 *   1. Idempotency — the paused tool_use already has a tool_result (replay /
 *      double-trigger / a prior continue) → no-op. The within-process once-token
 *      (the server `continue_state` CAS is the cross-process one).
 *   2. Materialize IN PLACE — `reconcileInteractions` turns a `resolution_is_result`
 *      kind (ask/permission/exit_plan/custom) INTO the paused tool_use's
 *      tool_result and settles the row; for `composio_auth` it returns a
 *      `re_execute` directive (the original tool must run now the connector is
 *      live) which `materializeReExecute` dispatches. A tool_use compacted away
 *      before its resolution settles WITHOUT a tool_result (F1 — never re-sends a
 *      real side-effect, never orphans a tool_result).
 *   3. Partial-resolution re-check — when an assistant turn paused on a BATCH of
 *      tools, answering ONE leaves the siblings waiting; the model cannot continue
 *      with a half-answered tool batch (the API requires a tool_result per
 *      tool_use). So we RE-SUSPEND (durable, no model call) until every paused
 *      interaction is settled.
 *   4. Drive — only when all are settled: drive ONE continue turn off the
 *      now-complete journal (the `{continueInteraction:true}` run; D-Sink). No
 *      synthetic user turn is ever appended — the resolution is materialized in
 *      place, so this is the auto-query suppression.
 *
 * Kernel-pure boundary: this module owns only the wiring; the kernel
 * (`reconcileInteractions`) owns the schema + materialization; `materializeReExecute`
 * owns the composio re-dispatch. The caller (QueryManager) provides the ONE
 * journal (per-task cache, single writer), the rebuilt toolset, and the drive.
 *
 * ring 4c — RELOCATED into the SDK engine. The composio re_execute's post-connect
 * connected-apps refresh arrives via the injected `StatePort` (threaded through
 * `OrchestrateContinueDeps.state` into `materializeReExecute`), so the SDK reads no
 * product module.
 */

import type { ContinueInteractionPayload } from '../contract/interaction.js';
import type { GateResult, ToolCall } from '../contract/harness.js';
import type { HarnessEvent } from '../contract/events.js';
import type { JournalEntry } from '../contract/journal.js';
import { type Journal, liveSuspendedToolUseIds, isDeferredResultContent } from '../kernel/index.js';
import type { RawToolOptions } from '../tools/tool-types.js';
import type { InjectionScreenSeam } from '../policy/injection-screen.js';
import type { ChildCostRecord } from '../contract/child-cost.js';
import type { StatePort } from '../ports/index.js';
import { materializeReExecute } from './continue-interaction.js';
import { type WorldDelta, worldDeltaMeetsThreshold, buildWorldDeltaResumeText } from './world-delta.js';

/** The rebuilt run surface a composio re_execute needs (lazy — only built on demand). */
export interface ContinueToolset {
  tools: RawToolOptions[];
  harness: { gateTool(call: ToolCall): Promise<GateResult> };
  /**
   * W4-2 — the run's shadow injection screen, from the SAME rebuilt config the tools
   * come from. It rides the TOOLSET rather than `OrchestrateContinueDeps` on purpose:
   * the seam is a property of the reconstructed run, so a caller cannot hand a screen
   * for one run alongside another run's tools, and a `resolution_is_result` continue
   * that never builds a toolset never builds a seam either. Absent (flag dark, or a
   * caller that supplies none) → no key → byte-identical dispatch.
   */
  injectionScreen?: InjectionScreenSeam;
}

export interface OrchestrateContinueDeps {
  taskId: string;
  payload: ContinueInteractionPayload;
  /** The task's ONE Journal (per-task cache → single-writer tail-chain). */
  journal: Journal;
  /**
   * ring 4c — the injected per-session state port. Threaded into
   * `materializeReExecute` so the composio re_execute path can fetch-AND-commit the
   * connected-apps snapshot via `state.refreshConnectedApps()` before the first
   * re-dispatch (byte-identical to the prior `refreshConnectedAppsCache` import).
   */
  state: StatePort;
  /**
   * Rebuild the tool registry + a gateTool harness for a composio re-dispatch.
   * LAZY: invoked only when reconcile returns a `re_execute` directive, so a
   * resolution_is_result continue never pays the cost.
   */
  buildToolset: () => Promise<ContinueToolset>;
  /** Drive ONE continue turn off the now-complete journal (the continue-signal run). */
  drive: () => Promise<void>;
  /**
   * K6-P3-C5 — durable "always allow" writeback seam. Invoked AFTER the kernel
   * materializes THIS resolution (so the writeback never blocks the tool_result)
   * with the resolved outcome. The native query-manager wires this to
   * `applyAddRuleOnResolution`, which persists the rule IFF the outcome is an
   * `InteractionAllow` carrying `addRule`. TOTAL — the handler never throws, so a
   * failed persist can't break the continue. Optional: a continue without a
   * writeback handler (legacy / tests) simply skips it.
   */
  onResolved?: (outcome: ContinueInteractionPayload['outcome']) => Promise<void>;
  /**
   * native-redrive — live socket sink for a re-spawned SUBAGENT's SUBAGENT_* events
   * on the continue path (so the re-run renders identically). Threaded into
   * materializeReExecute for an `Agent` re_execute; absent for composio / tests.
   */
  pushEvent?: (ev: HarnessEvent) => void;
  /**
   * native-redrive — bill the re-spawned subagent's model cost onto the continue
   * turn (only the rounds actually run). Threaded into materializeReExecute for an
   * `Agent` re_execute; absent for composio / tests.
   */
  addCostUsd?: (usd: number) => void;
  /**
   * Agent v2 (Task 6) — the ATTRIBUTED per-child cost sink for the re-spawned
   * subagent's replay records (parallel to `addCostUsd`, which is the budget
   * roll-up). The Agent tool emits `ctx.addChildCost` per re-spawn; threaded into
   * materializeReExecute so the replay's child records reach the continue's
   * `reExecChildUsage` (which seeds the drive turn's per-turn `childUsage`). Absent
   * (composio path / tests) → the records are dropped here, byte-identical.
   */
  addChildCost?: (rec: ChildCostRecord) => void;
  /**
   * ring 4c — the tenant boundary (workspaceId) the journal stamps on the
   * materialized settle entries. Threaded into materializeReExecute as
   * `cfg.runtimeConfig?.userId ?? ''`. Absent (legacy / tests) → `''` → `'sandbox'`.
   */
  userId?: string;
  /**
   * HITL world-delta (T3) — the elapsed-time + runner-recycle context for THIS resume.
   * When it meets the threshold (>10min gap OR a recycled runner) we append a system-
   * principal breadcrumb to the journal RIGHT BEFORE the drive so the resumed main agent
   * does not assume filesystem/process state survived the pause; a re_execute child
   * additionally gets a second-person preamble (threaded into materializeReExecute).
   * Absent (legacy / short resume / tests) → no breadcrumb, byte-identical to today.
   */
  worldDelta?: WorldDelta;
  /**
   * Continue anywhere (spec §6.3) — threaded into every `materializeReExecute`: awaited after a
   * re-execute's REEXECUTE_STARTED intent is fsynced and before the approved tool runs, so the Mac
   * lane can mirror that intent first. Absent → nothing runs there, byte-identical.
   */
  afterReExecuteMarked?: (toolName: string) => Promise<void>;
}

export interface ContinueOutcome {
  /** A tool_result already existed → the whole continue was a no-op. */
  alreadyAnswered: boolean;
  /** The resolution was materialized (tool_result and/or settled row). */
  materialized: boolean;
  /** A sibling interaction is still unanswered → durable re-suspend, no model call. */
  reSuspended: boolean;
  /** The continue turn was driven (all paused interactions settled). */
  drove: boolean;
}

/**
 * Has this tool_use a REAL (non-deferred) tool_result? A `{status:'deferred'}`
 * placeholder (HITL T2) settles the slot so the conversation can continue WHILE the
 * interaction stays pending — it is NOT a real answer, so it must NOT short-circuit
 * the continue as "already answered" (the forwardResume branch handles its late
 * resolution). A genuine result still no-ops, byte-identical to before.
 */
async function hasToolResult(journal: Journal, toolUseId: string): Promise<boolean> {
  for await (const e of journal.read()) {
    if (e.payload.type !== 'tool_result' || e.payload.toolUseId !== toolUseId) continue;
    const text = e.payload.blocks?.find((b) => b.type === 'text')?.text ?? '';
    if (isDeferredResultContent(text)) continue; // deferred placeholder — not a real answer
    return true;
  }
  return false;
}

/**
 * Step 1's question, asked the same way by a host after a FAILED continue: once this answer
 * is in the journal, a retry reads "already answered" and drives nothing, so the failure is
 * terminal for the retry rail.
 */
export async function continueAlreadyAnswered(journal: Journal, payload: Pick<ContinueInteractionPayload, 'toolUseId'>): Promise<boolean> {
  return !!payload.toolUseId && (await hasToolResult(journal, payload.toolUseId));
}

async function readToolUseInput(journal: Journal, toolUseId: string): Promise<unknown> {
  let input: unknown;
  for await (const e of journal.read()) {
    if (e.payload.type === 'tool_use' && e.payload.toolUseId === toolUseId) input = e.payload.input;
  }
  return input;
}

async function readAll(journal: Journal): Promise<JournalEntry[]> {
  const out: JournalEntry[] = [];
  for await (const e of journal.read()) out.push(e);
  return out;
}

export async function orchestrateContinue(deps: OrchestrateContinueDeps): Promise<ContinueOutcome> {
  const { taskId, payload, journal } = deps;

  // 1. Idempotency (within-process once-token).
  if (await continueAlreadyAnswered(journal, payload)) {
    return { alreadyAnswered: true, materialized: false, reSuspended: false, drove: false };
  }

  // 2. Materialize in place. The kernel resolves ONLY this interaction; siblings
  //    (other pending interactions) return null → left pending for their own
  //    continue. resolution_is_result kinds become the tool_result here; composio
  //    AND a subagent (`Agent`) pause come back as a re_execute directive.
  const { reExecute, forwardResume } = await journal.reconcileInteractions(async (id) =>
    id === payload.interactionId ? payload.outcome : null,
  );

  // 2a. native-redrive — the "always allow" writeback MUST run BEFORE a re_execute
  //     re-dispatch, not after. A subagent (`Agent`) re_execute re-spawns the
  //     subagent and replays its inner tool; if the user chose "always allow", the
  //     rule has to be persisted FIRST so the previously-paused inner tool auto-
  //     allows on the re-run and does NOT re-pause. (For composio + resolution_is_
  //     result the relative order is immaterial — the writeback is independent of
  //     materialization — so running it up-front is byte-safe for them too.) TOTAL
  //     by contract; guarded so a misbehaving handler can't strand the continue.
  if (deps.onResolved) {
    try {
      await deps.onResolved(payload.outcome);
    } catch {
      // the writeback is best-effort; a failed persist must not break the continue.
    }
  }

  if (reExecute.length > 0) {
    const { tools, harness, injectionScreen } = await deps.buildToolset();
    for (const directive of reExecute) {
      const originalInput = await readToolUseInput(journal, directive.toolUseId);
      await materializeReExecute({
        directive,
        tools,
        originalInput,
        outcome: payload.outcome,
        journal,
        taskId,
        harness,
        state: deps.state,
        // ring 4c — the tenant boundary stamped on the settle entries.
        ...(deps.userId !== undefined && { userId: deps.userId }),
        // native-redrive: live render + billing for a re-spawned subagent.
        ...(deps.pushEvent !== undefined && { pushEvent: deps.pushEvent }),
        ...(deps.addCostUsd !== undefined && { addCostUsd: deps.addCostUsd }),
        ...(deps.addChildCost !== undefined && { addChildCost: deps.addChildCost }),
        // HITL world-delta (T3) — a re_execute re-spawns the paused CHILD; carry the
        // world-delta so dispatchAgentScope prepends the second-person preamble to the
        // child's prompt when the gap is large. Spread-when-present (byte-identical absent).
        ...(deps.worldDelta !== undefined && { worldDelta: deps.worldDelta }),
        // W4-2 — the shadow screen from the rebuilt run, so a RE-DISPATCH is screened
        // like a first dispatch. Before this the whole re_execute lane was unscreened:
        // no ask, no verdict, and NO ROW, which reads downstream as a clean turn rather
        // than as an unmeasured one. Spread-when-present (byte-identical absent).
        ...(injectionScreen !== undefined && { injectionScreen }),
        // Continue anywhere (spec §6.3) — the Mac lane's write-ahead for an approved re-execute.
        ...(deps.afterReExecuteMarked !== undefined && { afterReExecuteMarked: deps.afterReExecuteMarked }),
      });
    }
  }

  // 2b. FORWARD-RESUME (HITL T5): a DEFERRED pause (its tool_use already answered by a
  //     `{status:'deferred'}` placeholder while the interaction stayed pending) has SINCE
  //     resolved. `reconcileInteractions` settled the row and returned a forwardResume
  //     directive — it did NOT splice a second tool_result (A6: the deferred slot is
  //     immutable) and did NOT re_execute (the stale original args must not be replayed).
  //     We append ONE forward-resume breadcrumb (a user-role entry framed as a SYSTEM
  //     notification, attributed to the system principal — the `[SYSTEM_RESUME]` pattern
  //     applied FORWARD) so the model re-decides the deferred work with all in-between
  //     context, then fall through to the SAME drive plumbing. The drive runs off the now-
  //     updated full journal (query-manager's `drive` re-projects it), so no synthetic
  //     re-dispatch happens. ADDITIVE: this only fires when a deferral resolved; a non-
  //     deferred continue never sees a forwardResume directive, so reExecute / resolution_
  //     is_result / re-suspend / alreadyAnswered are untouched. If a forwardResume co-
  //     occurs with a genuinely-unanswered sibling, the step-3 re-check below still wins
  //     (the breadcrumb stays journaled for the eventual drive). One combined breadcrumb
  //     names every resolved tool, worded by each directive's kind and outcome (an
  //     approval is not a connection: live 28edef30).
  if (forwardResume.length > 0) {
    await journal.appendForwardResumeBreadcrumb(forwardResume);
  }

  // 3. Partial-resolution re-check (after materialize, inside the caller's lock).
  //    Re-suspend iff a LIVE (post-compaction) tool_use is still bound to an
  //    unsettled interaction without a result — the model can't proceed with a
  //    half-answered tool batch. liveSuspendedToolUseIds (FIX-D) excludes a
  //    compacted-away/abandoned tool_use (e.g. a prior cap-failed continue's
  //    dangling resolved:false) so it can NEVER strand this continue forever.
  if (liveSuspendedToolUseIds(await readAll(journal)).size > 0) {
    return { alreadyAnswered: false, materialized: true, reSuspended: true, drove: false };
  }

  // 4. Every paused interaction is settled → drive ONE continue turn.
  //    HITL world-delta (T3): a resume that lands long after the pause (or on a recycled
  //    runner) gets a system-principal breadcrumb IMMEDIATELY before the drive, so the
  //    re-projected turn tells the model that time passed and ephemeral state may be gone.
  //    Below threshold / no worldDelta → nothing appended, byte-identical to today.
  if (worldDeltaMeetsThreshold(deps.worldDelta)) {
    await journal.appendWorldDeltaBreadcrumb(buildWorldDeltaResumeText(deps.worldDelta?.elapsedMs));
  }
  await deps.drive();
  return { alreadyAnswered: false, materialized: true, reSuspended: false, drove: true };
}
