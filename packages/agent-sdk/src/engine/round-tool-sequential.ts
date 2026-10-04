/**
 * round-tool-sequential.ts — the tool-dispatch helpers one round's batch threads
 * through: the batch context, the shared execCtx builder, and the three-phase
 * SEQUENTIAL path (begin → dispatch → finalize) the caller loops over a sequential
 * segment.
 *
 * Lifted VERBATIM out of round-tool-batch.ts, which had reached the apps/reconciler
 * file-size threshold; behaviour is unchanged, only the file boundary moved. The
 * import edge is ONE-WAY — round-tool-batch.ts imports from here, never the reverse
 * — so the two helpers that the CONCURRENT path also needs (`abortError`,
 * `buildToolExecCtx`) live here and are exported back, rather than being reached
 * for across a cycle. The billing frame both paths emit is tool-billing.ts's.
 */
import type { HarnessContext } from '../contract/harness.js';
import type { HarnessEvent } from '../contract/events.js';
import type { ContentBlock, ToolDisplay } from '../contract/blocks.js';
import { interruptedSealText } from '../kernel/index.js';
import type { HookDispatcher } from '../kernel/index.js';
import type { NativeConfigLike } from './native-config-like.js';
import { gateAndDispatchTool } from './tool-dispatcher.js';
import { raceAbortDrain, isDrainExpired, DRAIN_DEFAULT_MS } from './abort-drain.js';
import type { RawToolOptions, ToolDispatchResult } from '../tools/tool-types.js';
import { unknownToolText } from '../tools/result-shape.js';
import { PushQueue } from './push-queue.js';
import { toolBillingEvent } from './tool-billing.js';
import { NoopToolDisplayPort } from '../ports/tool-display-port.js';
import type { RunContext } from './run-context.js';
import {
  appendToolUseEntry,
  appendToolResultEntry,
  appendSubagentToolUseEntry,
  appendSubagentToolResultEntry,
} from './native-journal.js';
import { LONE_CHILD_REFUSAL, SERIAL_ROOT_ALLOWED_NOTE, SERIAL_ROOT_REFUSAL, SUBAGENT_MESSAGE_CONCURRENCY } from './subagent-walls.js';
import { Semaphore } from './subagent-pool.js';
import { makeInProcessDispatcher, inCodePause, type InProcessExecCtx } from './in-process-dispatcher.js';
import type { CapturedReasoning } from './round-stream.js';
// Types only (erased at emit) — no runtime import edge back to round-engine.ts.
import type { RoundCfg, RoundDeps, RoundState } from './round-engine.js';
import type { EarlyStart } from './tool-early-start.js';

/**
 * P3 (bounded drain) — the AbortError shape iterateTurn's catch classifies as a
 * user abort (same construction the Anthropic SDK throws on an aborted stream).
 * Thrown by the MAIN loop's drain-expiry paths AFTER sealing the expired
 * tool_use, so the existing catch finalizes user_aborted exactly as today.
 */
export function abortError(): Error {
  const err = new Error('Request was aborted.');
  err.name = 'AbortError';
  return err;
}

/**
 * Everything one tool batch threads through its dispatch paths. `results` is the
 * batch's SHARED, batch-ordered sink — every path pushes into the same array the
 * round returns.
 */
export interface ToolBatchCtx {
  deps: RoundDeps;
  st: RoundState;
  /** §4.3a — this round's encrypted reasoning items, read ONCE before the assistant append. */
  capturedReasoning: CapturedReasoning;
  /** The model that produced this round's stream (batch-shape provenance). */
  committedModel: string;
  /** The batch's results, batch-ordered — mutated in place by every dispatch path. */
  results: ToolDispatchResult[];
  /** Orchestration walls (D3): the tool_use id of a lone nested Agent call this batch refuses. */
  loneChildRefusal?: string;
  /**
   * Root wall (follow-up item 1, then C items 2 and 3): the lone in-turn root spawn in this
   * batch, and what the wall decided about it. `first` is the turn's first one in a row —
   * allowed, and the one that ARMS the streak (follow-up D item 1: at delivery, and only if
   * the tool admitted it). The other three are the SECOND in a row: `refused`, `dependent`
   * (it named what it is waiting for) or `allowed` (the turn has spent its refusals). The
   * turn's RunContext rides along so the delivery site can count the refusal it actually
   * delivered against the cap the decision site read.
   */
  serialRoot?: { id: string; verdict: 'first' | 'refused' | 'dependent' | 'allowed'; rc: RunContext };
  /** L1 (TOOLS_MIDSTREAM_V1): the calls that started while the model was streaming. */
  early?: EarlyStart;
}

/**
 * The execCtx every dispatch from this turn shares. Hoisted so the SAME closures
 * (addCostUsd folds into this turn; pushEvent feeds this queue; signal aborts this
 * turn) back BOTH a model-driven call AND any in-code re-entry the tool makes via
 * ctx.dispatchInProcessTool — nested cost folds into the same turn and an abort
 * propagates. Typed so the arrow params (`ev`, `usd`) are contextually typed (no
 * implicit any).
 *
 * ONE builder for BOTH main-loop dispatch paths. The concurrent run and the
 * sequential tool constructed this object field-for-field identically (verified
 * byte-identical before the merge), so a field added to one can no longer be missed
 * by the other.
 */
export function buildToolExecCtx(a: {
  ctx: HarnessContext<NativeConfigLike>;
  cfg: RoundCfg;
  rc: RunContext;
  dispatcher: HookDispatcher;
  queue: PushQueue<HarnessEvent>;
}): InProcessExecCtx {
  const { ctx, cfg, rc, dispatcher, queue } = a;
  return {
    // exactOptionalPropertyTypes (SDK): omit `signal` when undefined.
    ...(cfg.signal !== undefined && { signal: cfg.signal }),
    pushEvent: (ev) => queue.push(ev),
    // K5 batch-2: a tool that drives model calls (the Agent subagent tool) adds
    // its nested cost to THIS turn's cumulative total, so it bills exactly once
    // on the turn_end below.
    addCostUsd: (usd) => { rc.billing.cumulativeCostUsd += usd; },
    // Agent v2 (Task 4): the attributed per-child cost sink. Pushes the record
    // onto THIS user turn's childUsage (passed by reference from run()). It
    // DELIBERATELY DOES NOT touch parentOwnCostUsd — the parent's own cost is
    // measured independently at the model rounds, so the per-turn invariant
    // `parentOwn + Σchild === turnDelta` is non-tautological.
    addChildCost: (rec) => { rc.billing.childUsage.push(rec); },
    // native-redrive: OPT IN to the pause-surfacing path. The Agent subagent tool
    // calls ctx.markPausedHalt() when a tool inside its subagent paused-for-human;
    // gateAndDispatchTool substitutes its own capturing closure and stamps
    // pausedHalt onto the dispatch result, so the `results.some(r => r.pausedHalt)`
    // check pauses THIS turn (bound to the parent Agent tool_use id). A no-op
    // sentinel here — it only signals that this dispatch path wants pause-surfacing.
    markPausedHalt: () => {},
    // Follow-up D: OPT IN to the spawn markers the same way. A spawn tool calls
    // ctx.markSpawnAdmitted() when it actually dispatches a child and ctx.markSpawnRefused()
    // when a wall of its own turned one away; the dispatcher substitutes its capturing
    // closures and stamps `spawnAdmitted` onto the result, which is what the root wall reads
    // before arming its streak. No-op sentinels here — they only signal that this dispatch
    // path wants the markers.
    markSpawnAdmitted: () => {},
    markSpawnRefused: () => {},
    // Agent v2 (Task 9): the cooperative budget seam. The Agent tool's children[]
    // fan-out reads the live TURN-scoped spend (children fold into it via the
    // addCostUsd closure above) against this budget, skipping further children
    // once the cap is reached — ahead of the turn-boundary budget gate. Omit
    // maxBudgetUsd when undefined (exactOptionalPropertyTypes); the getter always
    // reflects the local.
    //
    // TURN-scoped, not lifetime (budget-scope fix, incident 14a935ea): the budget
    // is minted per message from the LIVE balance, and the run cumulative carries
    // the task's whole (already-paid) history via the resume seed — comparing the
    // two refused children to funded users. The ledger's turn mark is seed-free;
    // the no-ledger fallback (tests only — prod always wires the ledger) keeps the
    // old figure rather than inventing a second baseline here.
    ...(cfg.maxBudgetUsd !== undefined && { maxBudgetUsd: cfg.maxBudgetUsd }),
    getCumulativeCostUsd: () => cfg.liveSpend?.readTurnUsd() ?? rc.billing.cumulativeCostUsd,
    // K6-P2 B2: route PreToolUse/PostToolUse/PostToolUseFailure through the per-run
    // hook surface. The floor wraps gateTool → floor-only gating is byte-identical
    // to the pre-B2 direct-gate path.
    dispatcher,
    // K6-P3-C7: thread the real task id so a PERMISSION_DENIED event carries
    // ctx.taskId (not the SESSION_ID env var).
    taskId: ctx.taskId,
    // Phase 3 (§1.5): thread the sandbox filesystem root so an oversized result
    // can be offloaded. Absent → offload no-ops (byte-identical).
    ...(cfg.workingDir !== undefined && { workingDir: cfg.workingDir }),
    ...(cfg.contextOffloadThresholdChars !== undefined && { offloadThresholdChars: cfg.contextOffloadThresholdChars }),
    // Phase 4 (§1.7) — the running model, so an unset threshold above derives a
    // window-fraction default from this model's real contextWindowTokens.
    ...(ctx.model && { model: ctx.model }),
    // Hardening-G — the dark tool-error-taxonomy flag. Absent → OFF (byte-identical).
    ...(cfg.toolErrorTaxonomy !== undefined && { toolErrorTaxonomy: cfg.toolErrorTaxonomy }),
    // W4-2 — the shadow injection screen seam (absent → byte-identical dispatch).
    ...(cfg.injectionScreen !== undefined && { injectionScreen: cfg.injectionScreen }),
    // The run's OWN session id for the dispatcher's hook-input builders + the
    // PERMISSION_DENIED fallback. Never a process-wide value: one runner serves many
    // sessions, and the env SESSION_ID is the session that started it.
    sessionId: ctx.sessionId,
    // L5 (TOOL_PROGRESS_WATCHDOG_V1): the main loop's calls, and their in-code re-entries,
    // opt in to the non-progress watchdog; the flag still decides. A subagent's own
    // dispatches carry no opt-in: the Agent call above them is the watched unit.
    watchProgress: true,
    // Its verdicts go to the host's shipped logger (log_events); absent, the console.
    ...(cfg.onToolWatchdog !== undefined && { onToolWatchdog: cfg.onToolWatchdog }),
  };
}

/**
 * Sequential phase 1 — OPEN the tool_use: build the block that will carry the
 * completed card (K5 render parity), yield it live BEFORE execute so the sink emits
 * AGENT_TOOL_USE in pre-execute order, and journal the tool_use entry (so a crash
 * mid-execute leaves an orphan healOnError synthesizes a result for). Returns the
 * persisted block the finalize phase folds the result onto.
 */
async function* beginSequentialToolUse(
  c: ToolBatchCtx,
  tu: RoundState['toolUses'][number],
): AsyncGenerator<HarnessEvent, ContentBlock, void> {
  const { deps, capturedReasoning } = c;
  const { ctx, cfg, turnBlocks } = deps;
  // K5 tool-RENDER parity: the COMPLETED tool_use block must land in
  // turnBlocks → out.blocks → turn_end.blocks → MESSAGE_COMPLETE, so the
  // PERSISTED assistant message carries the rich tool card (Write/Edit
  // file viewer, Read pill, Bash strip) and it survives reload. The Claude
  // arm's processor does exactly this (folds the result INTO the tool_use
  // block in assistantBlocks); native previously pushed ONLY text into
  // turnBlocks, so its persisted message was text-only and the cards
  // vanished. We append a frozen object reference HERE (pre-execute) and
  // mutate its result/status/timing AFTER dispatch, mirroring the Claude
  // processor's merge-into-tool_use pattern. No standalone tool_result
  // block is persisted (parity: the SDK keeps results on a separate user
  // message, never in the assistant's MESSAGE_COMPLETE content).
  const toolStart = new Date();
  // Display enrichment (Claude-arm parity), now for EVERY tool. The
  // ToolDisplayPort (cfg.toolDisplay, ring 4c.5 — the product
  // EnrichToolDisplayPort wrapping enrichToolUse) classifies every tool_use
  // (app/brand/category for Composio + regular tools). For a Skill call
  // specifically it also resolves the owning ability from cfg.abilities and
  // returns a display carrying { skillName, abilityName } — the SAME
  // server-enriched display the legacy @openai/agents arm sets, so the
  // native + openai_responses arms (which invoke a skill with a BARE slug,
  // e.g. "create-skill") still render the ability-attributed card. Set on
  // BOTH the persisted turnBlocks block (reload) and the live-yielded
  // block (the sink forwards block.display onto AGENT_TOOL_USE). The SDK's
  // NoopToolDisplayPort returns undefined for every tool → byte-identical
  // for hosts without a port.
  const display: ToolDisplay | undefined = (cfg.toolDisplay ?? new NoopToolDisplayPort()).enrich(
    { toolName: tu.name, toolUseId: tu.id, toolInput: tu.input },
    cfg.abilities,
  );
  const persistedToolBlock = {
    type: 'tool_use',
    toolUseId: tu.id,
    toolName: tu.name,
    toolInput: tu.input ?? {},
    status: 'running',
    startTime: toolStart,
    ...(display ? { display } : {}),
  } as ContentBlock;
  turnBlocks.push(persistedToolBlock);

  // K3-T2: yield the tool_use block BEFORE appendToolUseEntry/execute so
  // the sink emits AGENT_TOOL_USE in the same pre-execute order as before.
  yield {
    kind: 'block',
    block: {
      type: 'tool_use',
      toolUseId: tu.id,
      toolName: tu.name,
      toolInput: tu.input,
      ...(display ? { display } : {}),
    } as ContentBlock,
  };

  // Task 10: append the tool_use entry to the journal before executing
  // (so a crash mid-execute leaves an orphan that healOnError synthesizes a result for).
  // §4.3a — attach the encrypted reasoning items that preceded THIS call
  // (matched by call_id) so the journal projection echoes them before the
  // function_call. Empty for Anthropic / non-reasoning → byte-identical.
  const tuReasoning = capturedReasoning
    .filter((r) => r.callId === tu.id)
    .map((r) => ({ id: r.id, encryptedContent: r.encryptedContent, ...(r.issuer ? { issuer: r.issuer } : {}) }));
  await appendToolUseEntry(cfg.journal, ctx, tu, tuReasoning);
  // T10 (P2.2) — the SUBAGENT's scope-tagged tool_use entry, journaled BEFORE
  // dispatch (mirrors the legacy nested body: a tool that pauses still has its
  // attempt recorded for the resume re-entry). Absent seam ⇒ main loop ⇒ no-op.
  if (deps.sub?.scopedJournal) {
    await appendSubagentToolUseEntry(deps.sub.scopedJournal.j, deps.sub.scopedJournal.path, {
      id: tu.id, name: tu.name, input: tu.input ?? {}, thoughtSignature: tu.thoughtSignature,
    });
  }

  return persistedToolBlock;
}

/**
 * Sequential phase 2 — DISPATCH the tool, down one of three paths: the SUBAGENT
 * execCtx (gate 1's settle-on-abort applies — a drain expiry becomes the tool's
 * RESULT, never a throw), the MAIN loop's PushQueue channel (pushed events drained
 * LIVE; a drain expiry seals + throws), or the unknown-tool sentinel.
 */
async function* dispatchSequentialTool(
  c: ToolBatchCtx,
  tu: RoundState['toolUses'][number],
  def: RawToolOptions | undefined,
): AsyncGenerator<HarnessEvent, { res: ToolDispatchResult; subDrainExpired: boolean }, void> {
  const { deps } = c;
  const { ctx, cfg, tools, onPause, onAuthHalt } = deps;
  let res: ToolDispatchResult;
  // P3 (bounded drain, SUB path): drain expiry here SETTLES instead of throwing —
  // a throw would escape runSubagentLoop (no catch there) and lose the subagent's
  // already-accumulated cost, breaking settle-on-abort (gate 1 / AC-2b-3). The
  // expired tool gets the truthful elapsed seal as its RESULT (scope-journaled by
  // the normal flow below), then the batch breaks so the nested loop's
  // signal-aborted check settles the run with its cost intact.
  let subDrainExpired = false;
  if (def && deps.sub !== undefined) {
    // P2.2 — the SUBAGENT dispatch: the SAME gate → execute → scan pipeline,
    // through the sub's OWN execCtx (nested cost sinks + in-code dispatcher + a
    // push channel, built once per run by runSubagentLoop). Still no per-tool
    // PushQueue here, and that is the point: a subagent tool's events do NOT
    // ride this generator. They leave through the sub execCtx's own pushEvent,
    // which hands them to runSubagentLoop's `onEvent` and out via the Agent tool
    // — so the engine keeps its single-emitter contract and this branch has
    // nothing to drain. The dispatch await stays in round-engine: P3's
    // raceAbortDrain lands at these awaits for BOTH callers.
    const settledOrExpired = await raceAbortDrain(
      gateAndDispatchTool(def, tu.input, tu.id, deps.harness, onPause, onAuthHalt, deps.sub.execCtx),
      cfg.signal,
      cfg.drainTimeoutMs ?? DRAIN_DEFAULT_MS,
    );
    if (isDrainExpired(settledOrExpired)) {
      subDrainExpired = true;
      res = { toolUseId: tu.id, text: interruptedSealText(settledOrExpired.elapsedMs), isError: true };
    } else {
      res = settledOrExpired;
    }
  } else if (def && deps.sub === undefined) {
    const { rc, dispatcher } = deps;
    // K5-T7 mid-turn push channel. Dispatch the tool as a PROMISE and
    // concurrently drain a PushQueue the tool feeds via `pushEvent`,
    // YIELDING each event LIVE (the loop stays the sole emitter → K3
    // invariant holds, no lint rule trips). When dispatch settles it
    // closes the queue, the drain ends, and we yield the tool_result.
    // Tools that never push (the other 19) leave the queue empty → the
    // drain ends immediately → byte-identical to the pre-T7 single-await.
    // L1 (TOOLS_MIDSTREAM_V1): a call that started while the model was still streaming is
    // taken over here, in its turn, never dispatched twice; its events waited in its queue.
    const earlyRun = c.early?.take(tu);
    const queue = earlyRun?.queue ?? new PushQueue<HarnessEvent>();
    const baseExecCtx = buildToolExecCtx({ ctx, cfg, rc, dispatcher, queue });
    // P3 (bounded drain): raceAbortDrain sits INSIDE the queue-close chain —
    // the loop blocks on the queue drain below first, and the queue only
    // closes when this chain settles, so bounding the raw dispatch alone
    // would leave the drain unbounded. On expiry the wrapper resolves the
    // sentinel, the queue closes, and the check below seals + throws.
    const dispatchPromise = earlyRun?.dispatchPromise ?? raceAbortDrain(
      gateAndDispatchTool(
        def, tu.input, tu.id, deps.harness, onPause, onAuthHalt,
        {
          ...baseExecCtx,
          // code-exec (Task 7): give this tool's execute() an in-code dispatcher
          // that re-enters the SAME gate+billing pipeline for a named tool. The
          // INNER execCtx is `baseExecCtx` (NO dispatchInProcessTool) so a tool
          // invoked from inside execute_code cannot recurse back into execute_code.
          dispatchInProcessTool: makeInProcessDispatcher({
            // code-exec hardening: the in-code path uses a SIDE-EFFECT-FREE pause
            // (inCodePause → PAUSED_HALT) instead of the loop's real onPause. A
            // needs_human/ask verdict on an in-code tool call cannot pause the turn
            // (the subprocess blocks on a synchronous UDS RPC), so firing the real
            // onPause would mint a PHANTOM durable interaction + journal entry bound
            // to an unjournaled toolCallId and corrupt resume. The model-driven path
            // above (the direct gateAndDispatchTool call) KEEPS the real onPause.
            tools, harness: deps.harness, onPause: inCodePause, onAuthHalt, execCtx: baseExecCtx,
          }),
        },
      ),
      cfg.signal,
      cfg.drainTimeoutMs ?? DRAIN_DEFAULT_MS,
    ).finally(() => queue.close());
    for await (const ev of queue) {
      yield ev;
    }
    const settledOrExpired = await dispatchPromise; // already settled (it closed the queue)
    // P3 (bounded drain): the dispatch outlived abort+grace. Seal THIS tool_use
    // truthfully (normal append path — the catch's heal sees it answered and
    // never double-seals), then throw so iterateTurn's catch finalizes
    // user_aborted exactly as today. The tool's late real result is discarded.
    if (isDrainExpired(settledOrExpired)) {
      if (cfg.journal) await cfg.journal.sealInterruptedToolUse(tu.id, settledOrExpired.elapsedMs);
      throw abortError();
    }
    res = settledOrExpired;
  } else {
    res = { toolUseId: tu.id, text: unknownToolText(tu.name, cfg.toolErrorTaxonomy), isError: true };
  }
  return { res, subDrainExpired };
}

/**
 * Sequential phase 3 — FINALIZE: fold the result into the persisted block (K5
 * render parity), yield the tool_result, bill the action, drain any todo blocks the
 * tool pushed, and journal the result (WITHHELD on a pause — native-redrive needs
 * the paused tool_use to read as genuinely unanswered). Returns `true` when the
 * SUBAGENT path must STOP the batch.
 */
async function* finalizeSequentialTool(
  c: ToolBatchCtx,
  tu: RoundState['toolUses'][number],
  def: RawToolOptions | undefined,
  persistedToolBlock: ContentBlock,
  res: ToolDispatchResult,
  subDrainExpired: boolean,
): AsyncGenerator<HarnessEvent, boolean, void> {
  const { deps, results } = c;
  const { ctx, cfg, transport, history, pendingTodoBlocks } = deps;
  results.push(res);

  // K5 tool-RENDER parity: fold the result INTO the persisted tool_use
  // block (mirrors processor.ts merging result/isError/status/endTime onto
  // the matching assistantBlocks tool_use). The FE's normalizeContentForFrontend
  // + ToolUseBlock render the completed card from exactly these fields.
  const pb = persistedToolBlock as unknown as Record<string, unknown>;
  pb.result = res.text;
  // A pausedHalt is a TYPED suspension, not an error: fold status:'paused' +
  // isError:false so the persisted block (reload) and the LIVE tool_result block
  // both render "awaiting", never a red error chip. Keys off pausedHalt (the
  // typed pause signal) so it also covers the isError-carrying pause paths
  // (Composio auth, PreToolUse hook halt) that ride pausedHalt without flipping
  // their own isError.
  pb.isError = res.isError && !res.pausedHalt;
  pb.status = res.pausedHalt ? 'paused' : res.isError ? 'error' : 'completed';
  pb.endTime = new Date();

  // K3-T2: yield the tool_result block AFTER dispatchTool returns; the
  // sink emits AGENT_TOOL_RESULT. No direct emit.
  yield {
    kind: 'block',
    block: {
      type: 'tool_result',
      toolUseId: tu.id,
      content: res.text,
      isError: res.isError && !res.pausedHalt,
      // Telemetry provenance: the server can't always pair a result back to
      // its tool_use (an empty callId defeats id pairing), and without a name
      // on the wire it logged 'unknown'. Never rendered.
      toolName: tu.name,
      ...(res.pausedHalt ? { status: 'paused' as const } : {}),
      // S2a: the browser action report rides the live tool_result block
      // (spread-when-present — report-less results are byte-identical).
      ...(res.report !== undefined && { report: res.report }),
    } as ContentBlock,
  };

  // Native-arm per-tool ACTION billing — parity with the Claude arm
  // (processor.ts extractAndEmitToolBilling → AGENT_TOOL_BILLING). The
  // Claude arm bills every tool_use; the native arm emitted NONE, so the
  // Composio per-call fee ($0.30) billed $0 on the native (default) arm.
  // Emitted AFTER the tool_result block so it never lands between tool_use
  // and tool_result (the push-channel contract). Bill a real dispatched tool
  // (`def` excludes the unknown-tool no-op) unless it paused for HITL — a
  // paused tool re-dispatches and bills on resume, so billing here would
  // double-charge. The server consumes this identically to the Claude arm
  // (sandbox-relay → checkAndDeductTool, which skips the expensive-tool
  // pre-gate, so no double-charge there).
  // A SUBAGENT's call bills here too, on its RESULT (isSubagent), so a refused or paused one
  // sends nothing. The subagent's driveRound carries the frame up as a `billing` event and
  // the Agent tool, the one emitter, buffers it per attempt (agent-tool.ts); it no longer
  // bills at tool_use, so this is the only frame a nested call gets.
  const billing = def ? toolBillingEvent({ taskId: ctx.taskId, toolName: tu.name, toolUseId: tu.id, ...(deps.sub !== undefined && { isSubagent: true }) }, res) : undefined;
  if (billing) yield billing;

  // K3-T2: drain any todo blocks pushed by a Todos tool's execute() that
  // ran inside the dispatchTool above. The sink emits AGENT_TODO.
  while (pendingTodoBlocks.length > 0) {
    yield { kind: 'block', block: pendingTodoBlocks.shift()! };
  }

  // Task 10: append the tool_result entry to the journal.
  // When no journal: fold into the in-memory ProviderHistory.
  //
  // native-redrive — a pause-for-human halt (needs_human / Composio auth /
  // a SUBAGENT pause propagated up by the Agent tool) must leave the paused
  // tool_use UNANSWERED in the journal: NO tool_result. A tool_result here
  // would (a) make computeSuspendedToolUseIds treat the tool_use as answered,
  // so suspendPending would NOT drop the orphan from the projection, and
  // (b) make the continue path's hasToolResult() short-circuit as
  // alreadyAnswered → never re-drive. The real resolution materializes the
  // tool_result later (continue path). The PAUSED_HALT sentinel still rendered
  // live (the tool_result block yielded above) and folded onto the persisted
  // block for the UI — only the DURABLE journal entry is withheld so the
  // suspend/continue machinery sees a genuinely-unanswered paused tool.
  if (!res.pausedHalt) {
    await appendToolResultEntry(cfg.journal, ctx, res);
    // T10 (P2.2) — the SUBAGENT's scope-tagged tool_result (withheld on a pause,
    // exactly like the main-scope append above — the resume materializes it).
    // `res.blocks` (image envelopes) ride through when set (legacy shape).
    if (deps.sub?.scopedJournal) {
      await appendSubagentToolResultEntry(deps.sub.scopedJournal.j, deps.sub.scopedJournal.path, {
        toolUseId: res.toolUseId,
        text: res.text,
        isError: res.isError,
        ...((res as { blocks?: ContentBlock[] }).blocks ? { blocks: (res as { blocks?: ContentBlock[] }).blocks } : {}),
        // W4-1: the scope-tagged copy carries the same taint verdict as the
        // main-scope append (spread-when-present — untainted byte-identical).
        ...(res.taint !== undefined && { taint: res.taint }),
      });
    }
    if (!cfg.journal) {
      transport.pushToolResult(history, res);
    }
  }

  // P2.2 gate 5 (pause semantics) — the SUBAGENT stops at the FIRST paused tool
  // (native-redrive): remaining tool_uses are NOT dispatched; the Agent tool
  // propagates the pause to the parent turn. The main loop instead completes
  // the batch and pauses at the batch boundary (iterateTurn's results.some).
  // Placed after the withheld-result block so a paused tool's result is neither
  // journaled nor pushed (identical to the legacy nested body). Returning `true`
  // (was `break`) stops the caller's per-tool loop over the sequential segment.
  if (deps.sub !== undefined && res.pausedHalt) return true;

  // P3 (bounded drain, SUB path): the expired tool's seal is journaled above
  // (scope-tagged, so no unanswered scoped tool_use is left behind — the
  // remaining tool_uses were never scope-journaled); stop dispatching the rest
  // (each would only burn another grace window against the aborted signal) and
  // let the nested loop's signal-aborted check settle with its cost intact.
  if (deps.sub !== undefined && subDrainExpired) return true;
  return false;
}

/** What a call the model asked for reads when an interrupt stopped the batch before it started. */
export const CANCELLED_BY_POLICY = 'Not run: a policy hook stopped the agent before this call started.';

/**
 * X1 (HOOK_PARITY_V1): answer a call an interrupt stopped before it started. It is never
 * dispatched (no gate, no execute, no bill: `refused`), yet it is rendered and journaled like
 * any refusal, so the history stays paired and the model reads why on the next turn.
 */
export async function* cancelSequentialTool(
  c: ToolBatchCtx,
  tu: RoundState['toolUses'][number],
): AsyncGenerator<HarnessEvent, boolean, void> {
  const persistedToolBlock = yield* beginSequentialToolUse(c, tu);
  const res: ToolDispatchResult = { toolUseId: tu.id, text: CANCELLED_BY_POLICY, isError: true, refused: true };
  return yield* finalizeSequentialTool(c, tu, c.deps.tools.find((t) => t.name === tu.name), persistedToolBlock, res, false);
}

// The SEQUENTIAL executor: run ONE tool_use to completion (dispatch, drain LIVE,
// finalize, journal) — the historic per-tool body, byte-identical to pre-T6. The
// caller loops it over a sequential segment's tools in batch order. Returns `true`
// when the SUBAGENT path must STOP the batch (a pause / drain-expiry) — the old
// `break`; the main loop never returns true (its breaks are sub-only).
export async function* runSequentialTool(
  c: ToolBatchCtx,
  tu: RoundState['toolUses'][number],
): AsyncGenerator<HarnessEvent, boolean, void> {
  const persistedToolBlock = yield* beginSequentialToolUse(c, tu);
  const def = c.deps.tools.find((t) => t.name === tu.name);
  // Orchestration walls (D3) — refuse WITHOUT dispatching: the child is never spawned,
  // and the helper reads the refusal as an ordinary tool result and carries on itself.
  if (c.loneChildRefusal === tu.id) {
    // Counted HERE, at delivery: the refusal has now reached the model as a tool result.
    c.deps.cfg.onSubagentRefused?.('lone_child');
    const res = { toolUseId: tu.id, text: LONE_CHILD_REFUSAL, isError: true };
    return yield* finalizeSequentialTool(c, tu, def, persistedToolBlock, res, false);
  }
  // Root wall (follow-up item 1) — same shape, same delivery-time tally: the child is
  // never spawned and the root reads the refusal as an ordinary tool result. A lone root
  // spawn is always SEQUENTIAL (partitionToolBatch runs only a batch of two or more
  // concurrently), so this is the one site it can arrive at.
  const serialRoot = c.serialRoot?.id === tu.id ? c.serialRoot : undefined;
  if (serialRoot?.verdict === 'refused') {
    // Counted HERE, at delivery, and the turn's refusal budget spent HERE with it, so the
    // cap can never be spent by a refusal the model was not shown.
    serialRoot.rc.serialRootRefusals += 1;
    c.deps.cfg.onSubagentRefused?.('serial_root');
    const res = { toolUseId: tu.id, text: SERIAL_ROOT_REFUSAL, isError: true };
    return yield* finalizeSequentialTool(c, tu, def, persistedToolBlock, res, false);
  }
  // Follow-up C items 2 and 3 — the two ALLOW readings. The spawn dispatches normally;
  // only the record changes, and (past the cap) the note the model reads above its result,
  // so a waved-through hand-off is never mistaken for one the wall approved of.
  if (serialRoot !== undefined && serialRoot.verdict !== 'first') {
    // R129: spent HERE, for the same reason the refusal budget is — a declaration the model
    // never got the benefit of must not consume one of its three.
    if (serialRoot.verdict === 'dependent') serialRoot.rc.serialRootDependents += 1;
    c.deps.cfg.onSubagentAllowed?.(`serial_root_${serialRoot.verdict}`);
  }
  const { res, subDrainExpired } = yield* dispatchSequentialTool(c, tu, def);
  // Follow-up D — the streak ARMS here, after the tool ran, and only on a spawn the tool
  // said it ADMITTED. A refusal of its own started no helper, so the corrected retry is
  // judged as the first spawn again rather than walled as a second one. Read off the dispatch
  // result's verdict, never off the refusal's text.
  //
  // R138 — an EXPLICIT true, not "no refusal was marked". Marking refusals is a list of
  // sites and a list can be missed (four were, one of them the incident itself); requiring
  // the admission cannot be. It also makes the three paths where the tool never ran read
  // truthfully: a gate deny, a throw before the child started and a drain expiry all leave
  // the key absent, and none of them handed anything off.
  //
  // Never CLEARED here: a round that is not a lone spawn is what clears it, and that is the
  // decision site's call. The condition is deliberately wider than `verdict === 'first'` —
  // on `dependent` and `allowed` the streak is already armed, so re-arming is a no-op today
  // and stays correct if a future round ever clears it between decision and delivery.
  if (serialRoot !== undefined && res.spawnAdmitted === true) serialRoot.rc.lastRoundWasLoneSpawn = true;
  const noted = serialRoot?.verdict === 'allowed' && res.text !== undefined
    ? { ...res, text: `${SERIAL_ROOT_ALLOWED_NOTE}\n\n${res.text}` }
    : res;
  return yield* finalizeSequentialTool(c, tu, def, persistedToolBlock, noted, subDrainExpired);
}

/**
 * Orchestration walls (spec §4.2) — the NESTED concurrent run. Opens every tool_use in
 * batch order (blocks + journal, exactly as the sequential path does), dispatches them
 * all at once through the sub's OWN execCtx (their events leave via that ctx's pushEvent,
 * never this generator — the same single-emitter contract as dispatchSequentialTool),
 * bounded by a per-run Semaphore of SUBAGENT_MESSAGE_CONCURRENCY, then finalizes in
 * batch order so results stay ordered. The tree-wide cap is enforced inside the Agent
 * tool (admission by refusal), so nothing here can block on a slot a parent holds.
 *
 * STOP NEVER DELETES WORK. Every opened tool_use is finalized, even after a child
 * pauses or THROWS: by the time we know, all of them have already been dispatched and settled,
 * so breaking early would throw away a sibling's paid-for result AND leave its
 * tool_use unanswered for a resume to re-drive (re-running a child that finished).
 * This is what the MAIN loop's concurrent run does too — drainConcurrentDispatches
 * finalizes every handle and lets `finalizeSequentialTool` withhold only the PAUSED
 * child's journal entry, which is what keeps that one pending for the resume.
 *
 * Returns `true` when the SUBAGENT path must STOP the batch — the same signal
 * `runSequentialTool` returns, so the caller's segment loop breaks and no LATER
 * segment dispatches. Without it a pause would stop this run and the next segment
 * would still run, which the one-sequential-segment nested batch never did.
 */
export async function* runNestedConcurrentRun(
  c: ToolBatchCtx,
  tus: RoundState['toolUses'],
): AsyncGenerator<HarnessEvent, boolean, void> {
  const { deps } = c;
  const { cfg, tools, onPause, onAuthHalt } = deps;
  const sub = deps.sub!;
  const opened: Array<{ tu: RoundState['toolUses'][number]; def: RawToolOptions | undefined; block: ContentBlock }> = [];
  for (const tu of tus) {
    const block = yield* beginSequentialToolUse(c, tu);
    opened.push({ tu, def: tools.find((t) => t.name === tu.name), block });
  }
  const pool = new Semaphore(SUBAGENT_MESSAGE_CONCURRENCY);
  const inFlight = opened.map(({ tu, def }) => {
    const dispatchPromise = pool.run(async (): Promise<NestedSettled> => {
      // Orchestration walls (D3) — refuse WITHOUT dispatching, exactly as the
      // sequential path does; the child is never spawned. FIRST, matching
      // runSequentialTool's order: the refusal is decided before the tool is
      // resolved, so it stands even when `def` is undefined.
      if (c.loneChildRefusal === tu.id) {
        cfg.onSubagentRefused?.('lone_child'); // at DELIVERY, as the sequential path counts it
        return { res: { toolUseId: tu.id, text: LONE_CHILD_REFUSAL, isError: true }, subDrainExpired: false };
      }
      if (!def) return { res: { toolUseId: tu.id, text: unknownToolText(tu.name, cfg.toolErrorTaxonomy), isError: true }, subDrainExpired: false };
      const r = await raceAbortDrain(
        gateAndDispatchTool(def, tu.input, tu.id, deps.harness, onPause, onAuthHalt, sub.execCtx),
        cfg.signal,
        cfg.drainTimeoutMs ?? DRAIN_DEFAULT_MS,
      );
      // P3 (bounded drain, SUB path): the expiry becomes this tool's RESULT, never a
      // throw — a throw would escape runSubagentLoop and lose the run's cost.
      if (isDrainExpired(r)) {
        return { res: { toolUseId: tu.id, text: interruptedSealText(r.elapsedMs), isError: true }, subDrainExpired: true };
      }
      return { res: r, subDrainExpired: false };
    });
    // A no-op OBSERVER, not a handler: a child that rejects before the sweep reaches
    // it would otherwise be an unhandled rejection for that window (the trade the
    // MAIN loop already lives with). The sweep still awaits `dispatchPromise` itself,
    // so the real outcome — and the seal below — is unchanged.
    void dispatchPromise.catch(() => {});
    return dispatchPromise;
  });
  let stop = false;
  for (let i = 0; i < opened.length; i++) {
    const { tu, def, block } = opened[i];
    // Await each child INSIDE the batch-ordered sweep — the MAIN loop's shape
    // (drainConcurrentDispatches), never a `Promise.all` gather: a gather settles
    // as one unit, so ONE child's rejection would discard every sibling's
    // already-paid-for result and leave every opened tool_use unanswered.
    //
    // STOP NEVER DELETES WORK, on the THROW path. gateAndDispatchTool guards only
    // `execute()`: `harness.gateTool` and `onPause` are awaited BARE, and
    // raceAbortDrain forwards a rejection — so a throwing gate (or a failed
    // durable-interaction mint inside onPause) rejects THIS child. Seal it as an
    // error result, exactly the way an execute() throw is sealed (tool-dispatcher.ts's
    // catch: the raw message, isError), and carry on: every SIBLING still finalizes
    // and no opened tool_use is left unanswered.
    let settled: NestedSettled;
    try {
      settled = await inFlight[i];
    } catch (err) {
      settled = {
        res: { toolUseId: tu.id, text: err instanceof Error ? err.message : String(err), isError: true },
        subDrainExpired: false,
      };
    }
    // OR the stop flags rather than breaking — see STOP NEVER DELETES WORK above.
    if (yield* finalizeSequentialTool(c, tu, def, block, settled.res, settled.subDrainExpired)) stop = true;
  }
  return stop;
}

/** One nested child's settled dispatch: its result plus the sub-path drain-expiry flag. */
interface NestedSettled {
  res: ToolDispatchResult;
  subDrainExpired: boolean;
}
