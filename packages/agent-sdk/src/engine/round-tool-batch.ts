/**
 * round-tool-batch.ts — the TOOL half of one round: gate → execute → emit →
 * append a tool_result, for every tool_use the model asked for.
 *
 * `runToolBatch` is the whole batch, walking the same three decisions the inline
 * body did, in the same order:
 *
 *   1. MEDIA TURN-SETTLE LOCK — a prior round in this turn queued media, so the
 *      whole batch is denied without execution (denySettledMediaBatch).
 *   2. PARTITION (batch-shape.ts) — ordered segments: each maximal ≥2 run of
 *      consecutive run-eligible tool_uses is CONCURRENT (runConcurrentRun:
 *      admission stack → PASS 1 start-all → PASS 2 drain, batch order),
 *      everything else is SEQUENTIAL (runSequentialTool: begin → dispatch →
 *      finalize, one at a time).
 *   3. MEDIA TURN-SETTLE DETECTION — arm the lock for the NEXT round.
 *
 * Extracted VERBATIM from `runOneRound` (P2.2 Task 6 → the Harness-9 W4
 * decomposition). The five subagent behavior gates are unchanged and still keyed on
 * `deps.sub`; gate 5 (concurrency is MAIN-LOOP ONLY) is load-bearing deadlock
 * discipline — see runConcurrentRun.
 *
 * The batch-owned constants live here because this is their only consumer;
 * round-engine.ts re-exports the public ones, which ARE part of its contract to its
 * callers. The SEQUENTIAL phases, the batch context and the helpers both paths share
 * (the exec-ctx builder, the abort shape, the tool-billing ring mirror) sit in
 * round-tool-sequential.ts — a file-size split (apps/reconciler), no behaviour change;
 * the import edge runs one way, from here to there.
 */
import type { HarnessEvent } from '../contract/events.js';
import type { ContentBlock, ToolDisplay } from '../contract/blocks.js';
import { resolveCapabilities } from '../contract/model-capabilities.js';
import { REEXECUTE_BOUND_TOOLS } from '../kernel/index.js';
import type { HookDispatcher } from '../kernel/index.js';
import { gateAndDispatchTool } from './tool-dispatcher.js';
import { raceAbortDrain, isDrainExpired, DRAIN_DEFAULT_MS, type DrainExpired } from './abort-drain.js';
import { getSubagentPool, poolBusy } from './subagent-pool.js';
import { spawnLaneSlug } from './spawn-lane.js';
import {
  getSessionFuelTank,
  getGlobalAdmissionSemaphore,
  defaultNodeReserveUsd,
  admitNode,
  type SessionFuelTank,
} from './fuel-tank.js';
import type { ToolDispatchResult } from '../tools/tool-types.js';
import { unknownToolText } from '../tools/result-shape.js';
import { PushQueue } from './push-queue.js';
import { NoopToolDisplayPort } from '../ports/tool-display-port.js';
import type { RunContext } from './run-context.js';
import {
  appendToolUseEntry,
  appendToolResultEntry,
  appendToolBatchShapeEntry,
} from './native-journal.js';
import { partitionToolBatch, sharedToolNames, toolBatchShape } from './batch-shape.js';
import { BOOKKEEPING_TOOLS, SERIAL_ROOT_DEPENDENT_CAP, SERIAL_ROOT_REFUSAL_CAP, SPAWN_SHAPED_TOOLS,
  SUBAGENT_MESSAGE_CONCURRENCY, declaresDependency, isInTurnSpawn, isParallelBatchInput } from './subagent-walls.js';
import { makeInProcessDispatcher, inCodePause } from './in-process-dispatcher.js';
import type { CapturedReasoning } from './round-stream.js';
// Types only (erased at emit) — no runtime import edge back to round-engine.ts, and none to
// tool-early-start.ts (which imports turnBatchPool from here).
import type { RoundDeps, RoundState } from './round-engine.js';
import type { EarlyStart } from './tool-early-start.js';
import { toolBillingEvent } from './tool-billing.js';
// The sequential dispatch phases + the helpers BOTH paths share, lifted out for
// file-size headroom (apps/reconciler). The edge is one-way: never the reverse.
import {
  abortError,
  buildToolExecCtx,
  runNestedConcurrentRun,
  runSequentialTool,
  cancelSequentialTool,
  type ToolBatchCtx,
} from './round-tool-sequential.js';

/**
 * ring mirror — byte-identical to `EVENTS.SUBAGENT_START` (@bash/shared
 * events.ts:425 = 'subagent:start'). Inlined so the engine reads no `@bash/*` (same
 * discipline as tool-billing.ts's AGENT_TOOL_BILLING_EVENT); a conformance assertion in
 * apps/sandbox proves it equals `EVENTS.SUBAGENT_START`. runConcurrentRun's PASS 1
 * emits this raw event per concurrent lane UP-FRONT (right after the lane's tool_use
 * block) so the web renders every parallel subagent as running immediately, instead
 * of inventing a "queued" state for a lane whose REAL start — pushed by agent-tool.ts
 * into the lane's own PushQueue — PASS 2 has not drained yet. The payload's
 * `agentSlug` is the field the server enrichment (#1398) + materialize key on; the
 * child's own later start enriches name/icon/color via last-write-wins.
 */
const SUBAGENT_START_EVENT = 'subagent:start';

/**
 * The tool_result string a media-settled turn returns for every DENIED tool call
 * (CONTENT_ENGINE_V1). Exported so tests assert the exact bytes the model receives.
 * JSON.stringify of the fixed object → the canonical `{"denied":…,"message":…}` shape.
 */
export const MEDIA_TURN_SETTLED_DENIAL = JSON.stringify({
  denied: 'media_turn_settled',
  message:
    "Your media request is queued. Results render automatically on the user's screen and will be confirmed to you next turn. No tool can observe or speed this up. Reply with one short sentence and end your turn. If other work remains (like this denied call), finish it next turn after the confirmation. In future turns, do non-media work BEFORE requesting media.",
});

/**
 * Does a `media` tool RESULT string carry a queued job? Mirrors the SDK-arm predicate
 * `withMediaTurnGuidance` (apps/sandbox/src/mcp/media-mcp.ts): the parsed body has a
 * `jobs` array with some `status:'queued'`. Operates on the JSON string the media
 * tool's execute returns; a non-JSON / non-queued result → false (fail-open: no lock,
 * the #1751 soft directive still nudges). @vestra/agent-sdk cannot import the product
 * predicate (wrong dependency direction), so it is mirrored here.
 */
function resultHasQueuedMedia(text: string): boolean {
  try {
    const body = JSON.parse(text) as { jobs?: Array<{ status?: string }> };
    return Array.isArray(body?.jobs) && body.jobs.some((j) => j?.status === 'queued');
  } catch {
    return false;
  }
}

/**
 * Cap on simultaneously-running parallel `Agent` subagent loops in ONE turn's concurrent
 * batch. "Effectively unlimited" in practice = high cap + FIFO queue, bounded by sandbox
 * memory / provider rate limits / cost. Distinct from the children[] batch pool (keyed on
 * ownerTaskId) — see the pool key below (`:turnbatch` suffix). Exported (P2.5) as the
 * clamp ceiling for a Weave script's requested `concurrency` — one constant, one policy.
 */
export const MAIN_TURN_BATCH_CONCURRENCY = 12;

/**
 * P1 (RunContext) — the concurrent `:turnbatch` pool key. Derived from ctx.taskId
 * ONLY (the per-session key every other per-session resource uses: children[] pool
 * `agent-tool.ts rootSessionId = ownerTaskId`, fuel tank `_tanks`). NEVER derived
 * from the env SESSION_ID (once surfaced as `runtimeConfig.sessionId`), which is
 * process-GLOBAL in the multi-session sandbox and merged all parallel tasks into
 * one 12-slot pool.
 */
export function batchPoolKey(taskId: string): string {
  return `${taskId}:turnbatch`;
}

/**
 * Is a tool call of this task's main loop executing right now: a batch call, or a TOOLS_MIDSTREAM
 * early start, which the journal records only when its round ends? The live answer the journal
 * cannot give (PLANNED_RESTART_RESUME_V1's settled test, apps/sandbox crash-resume.ts).
 */
export function turnBatchBusy(taskId: string): boolean {
  return poolBusy(batchPoolKey(taskId));
}

// ── Media turn-settle LOCK: deny the whole batch ────────────────────────────
// A PRIOR round in this turn returned a queued `media` result, so every tool call
// from here to turn end is DENIED without execution: queued artifacts deliver
// themselves (the socket renders the card; a silent push lands next turn), so no
// tool can observe or speed them up. The settling round's OWN sibling calls all ran
// (the flag is armed at batch END below, not mid-batch) — the lock is round-grained.
// We still emit each tool_use/tool_result block and journal them so the round's
// tool_uses stay answered for a valid next-round history; only the dispatch is
// replaced by the settled-denial result. Skipped entirely when mediaSettle is
// undefined (flag off / subagent) → the existing partition + dispatch runs unchanged.
async function* denySettledMediaBatch(c: ToolBatchCtx): AsyncGenerator<HarnessEvent, void, void> {
  const { deps, st, capturedReasoning, results } = c;
  const { ctx, cfg, transport, history, turnBlocks } = deps;
  for (const tu of st.toolUses) {
    const persistedToolBlock = {
      type: 'tool_use',
      toolUseId: tu.id,
      toolName: tu.name,
      toolInput: tu.input ?? {},
      status: 'running',
      startTime: new Date(),
    } as ContentBlock;
    turnBlocks.push(persistedToolBlock);
    yield {
      kind: 'block',
      block: { type: 'tool_use', toolUseId: tu.id, toolName: tu.name, toolInput: tu.input } as ContentBlock,
    };
    // Attach the reasoning items that preceded this call (call_id match) so the
    // journal projection stays echo-correct on the reasoning arms — same rule as
    // the dispatch paths. Empty for Anthropic / non-reasoning → byte-identical.
    const tuReasoning = capturedReasoning
      .filter((r) => r.callId === tu.id)
      .map((r) => ({ id: r.id, encryptedContent: r.encryptedContent, ...(r.issuer ? { issuer: r.issuer } : {}) }));
    await appendToolUseEntry(cfg.journal, ctx, tu, tuReasoning);

    const res: ToolDispatchResult = { toolUseId: tu.id, text: MEDIA_TURN_SETTLED_DENIAL, isError: false };
    results.push(res);
    const pb = persistedToolBlock as unknown as Record<string, unknown>;
    pb.result = res.text;
    pb.isError = false;
    pb.status = 'completed';
    pb.endTime = new Date();
    yield {
      kind: 'block',
      block: { type: 'tool_result', toolUseId: tu.id, content: res.text, isError: false, toolName: tu.name } as ContentBlock,
    };
    // No AGENT_TOOL_BILLING: a denied tool never ran, so there is no action to charge.
    await appendToolResultEntry(cfg.journal, ctx, res);
    if (!cfg.journal) transport.pushToolResult(history, res);
  }
}

/**
 * The task's `:turnbatch` pool: bounded concurrency for this turn's parallel batch, shared by
 * every concurrent run and by L1's early starts (tool-early-start.ts). Key suffix
 * ':turnbatch' keeps it separate from the children[] pool (keyed on ownerTaskId) so the
 * memoized capacity never collides. Deadlock-safe: this pool is acquired ONLY by the MAIN
 * turn loop; subagent inner loops (subagent-runner) dispatch their own tools without
 * re-acquiring this key, so a slot-holding parent never blocks waiting for a slot for its
 * own child. Orchestration walls (D4, second half): TEN Agent calls per assistant message,
 * not twelve — one message must not be able to fill half the 20-slot tree. Flag off ⇒ the
 * existing cap ⇒ byte-identical. Memoized per task, so the FIRST round of a task fixes it.
 */
export function turnBatchPool(deps: RoundDeps): ReturnType<typeof getSubagentPool> {
  const perMessage = deps.cfg.subagentWalls === true ? SUBAGENT_MESSAGE_CONCURRENCY : MAIN_TURN_BATCH_CONCURRENCY;
  return getSubagentPool(batchPoolKey(deps.ctx.taskId), perMessage);
}

/** The pool + admission stack one concurrent run dispatches through. */
interface BatchAdmission {
  batchPool: ReturnType<typeof getSubagentPool>;
  fuelTank: SessionFuelTank | undefined;
  globalAdmission: ReturnType<typeof getGlobalAdmissionSemaphore> | undefined;
  nodeReserve: number;
}

/**
 * Acquire the pool + the Weave Floor §1a admission stack for ONE concurrent run.
 * Both admission legs are OPT-IN (undefined config → undefined here → the admitNode
 * wrapper collapses to "just run the node", byte-identical to pre-1a).
 */
function acquireBatchAdmission(deps: RoundDeps): BatchAdmission {
  const { ctx, cfg } = deps;
  const batchPool = turnBatchPool(deps);
  // Weave Floor §1a — the admission stack for this concurrent batch (the
  // bill-shock prod gate): the per-TASK USD fuel tank + the process-global
  // admission semaphore. Both are OPT-IN (undefined config → undefined here → the
  // admitNode wrapper collapses to "just run the node", byte-identical to pre-1a).
  // The tank is keyed on `ctx.taskId` — the PER-SESSION id (matching the children[]
  // pool's ownerTaskId) — NOT `sessionId`/`process.env.SESSION_ID`, which is
  // process-GLOBAL and would merge the USD ceiling across parallel tasks in one
  // sandbox. The global semaphore (intentionally process-wide) is acquired ONLY
  // here in the main loop (the same deadlock discipline as `:turnbatch` itself —
  // never re-acquired inside the recursive subagent path).
  const fuelTank: SessionFuelTank | undefined =
    cfg.sessionFuelTankUsd !== undefined
      ? getSessionFuelTank(ctx.taskId, cfg.sessionFuelTankUsd)
      : undefined;
  const globalAdmission =
    cfg.globalAdmissionLimit !== undefined
      ? getGlobalAdmissionSemaphore(cfg.globalAdmissionLimit)
      : undefined;
  // Per-node reserve = a REALISTIC estimate of one subagent's first model round at
  // the session model's rate (defaultNodeReserveUsd uses a typical output bound, NOT
  // the model's full maxOutputTokens — so a cheap wide batch is not denied far below
  // the ceiling). It only bounds in-flight overshoot of simultaneously-admitted
  // nodes; the tank's live cumulative read bounds the session across admissions.
  const nodeReserve = defaultNodeReserveUsd(
    ctx.model,
    resolveCapabilities(ctx.model).maxOutputTokens,
  );
  return { batchPool, fuelTank, globalAdmission, nodeReserve };
}

/** One in-flight member of a concurrent run: its block, its live channel, its dispatch. */
interface ConcurrentHandle {
  tu: { id: string; name: string; input: unknown };
  persistedToolBlock: ContentBlock;
  queue: PushQueue<HarnessEvent>;
  // P3: the drain-bounded dispatch — resolves the result, or the DrainExpired
  // sentinel when the dispatch outlives abort+grace (PASS 2 seals + throws).
  dispatchPromise: Promise<ToolDispatchResult | DrainExpired>;
  known: boolean;
}

// PASS 1 (batch order): emit each tool_use block + START every dispatch. Each
// dispatch gets its OWN PushQueue + execCtx; the closures fold into the SAME
// turn accumulators (cumulativeCostUsd / childUsage) the sequential path uses.
async function* startConcurrentDispatches(
  c: ToolBatchCtx,
  tus: RoundState['toolUses'],
  rc: RunContext,
  dispatcher: HookDispatcher,
  admission: BatchAdmission,
): AsyncGenerator<HarnessEvent, ConcurrentHandle[], void> {
  const { deps, capturedReasoning } = c;
  const { ctx, cfg, tools, onPause, onAuthHalt, turnBlocks } = deps;
  const { batchPool, fuelTank, globalAdmission, nodeReserve } = admission;
  const handles: ConcurrentHandle[] = [];
  for (const tu of tus) {
    const toolStart = new Date();
    // Every tool is enriched (app, brand, category) — the web wears the mark,
    // the story mint reads display.integration/category. The port is the
    // product's enrichToolUse; the SDK default is a no-op returning undefined.
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
    // Live lane start (K3 — the loop stays the SOLE emitter): synthesize this
    // lane's `subagent:start` UP-FRONT, in batch order, right after its tool_use
    // block. Without it, the lane's REAL start (pushed by the Agent tool into this
    // lane's PushQueue) is WITHHELD until PASS 2 drains the lane — so the web, with
    // no events for a lane that is genuinely executing, renders it as "queued"
    // (1 running / N-1 queued for a concurrent batch). This is additive: the child's
    // own later start (PASS-2 drain) is a benign duplicate the server materialize
    // (last-write-wins on toolUseId) and web handler (init-if-absent/monotonic,
    // #1399) dedupe by design — and both starts precede the child's first text
    // delta, so the materialize's `subagentText=''` reset never drops content. The
    // payload mirrors agent-tool.ts's emit wire shape (raw + native + the slug-keyed
    // `agentSlug` the server enrichment #1398 + materialize consume); the engine does
    // NOT resolve slugs to display names — the server enriches from its cache.
    // `spawnLaneSlug` (spawn-lane.ts) is the SHARED resolution agent-tool uses for
    // the lane's REAL start, so the two agree by construction; it returns undefined
    // for a `children[]` batch, which keeps its natural per-child start timing.
    const laneSlug = spawnLaneSlug(tu.input);
    if (laneSlug !== undefined) {
      yield {
        kind: 'raw',
        engine: 'native',
        event: SUBAGENT_START_EVENT,
        data: { taskId: ctx.taskId, toolUseId: tu.id, agentSlug: laneSlug },
      };
    }
    const tuReasoning = capturedReasoning
      .filter((r) => r.callId === tu.id)
      .map((r) => ({ id: r.id, encryptedContent: r.encryptedContent, ...(r.issuer ? { issuer: r.issuer } : {}) }));
    await appendToolUseEntry(cfg.journal, ctx, tu, tuReasoning);
    const def = tools.find((t) => t.name === tu.name);
    if (!def) {
      // Unknown tool: an empty, already-closed queue (no events) + a resolved
      // error — same result the sequential path's `res = {...}` branch produces.
      const empty = new PushQueue<HarnessEvent>();
      empty.close();
      handles.push({
        tu, persistedToolBlock, queue: empty, known: false,
        dispatchPromise: Promise.resolve({ toolUseId: tu.id, text: unknownToolText(tu.name, cfg.toolErrorTaxonomy), isError: true }),
      });
      continue;
    }
    // L1 (TOOLS_MIDSTREAM_V1): a call that started while the model was still streaming is
    // taken over here, in its turn, never dispatched twice; its events waited in its queue.
    const earlyRun = c.early?.take(tu);
    if (earlyRun) {
      handles.push({ tu, persistedToolBlock, queue: earlyRun.queue, dispatchPromise: earlyRun.dispatchPromise, known: true });
      continue;
    }
    const queue = new PushQueue<HarnessEvent>();
    const baseExecCtx = buildToolExecCtx({ ctx, cfg, rc, dispatcher, queue });
    // Bound the dispatch by the full admission stack (global → fuel tank →
    // per-turn semaphore): at most MAIN_TURN_BATCH_CONCURRENCY run at once, the
    // rest FIFO-queue; a node whose true-ceiling reserve would breach the session
    // fuel tank is DENIED before launch and returns a skip note (never dispatched,
    // never billed). The promise is set SYNCHRONOUSLY even when queued/denied, so
    // PASS-2's batch-order drain + journaling stay deterministic. When the fuel
    // tank + global semaphore are unconfigured, admitNode is a transparent pass to
    // batchPool.run — byte-identical to pre-1a.
    //
    // W3-2 — the §1a stack (tank + global semaphore) gates AGENT NODES only, per
    // member: `reserveUsd` estimates a subagent's first MODEL round, and the
    // sequential path never fuel-gated a plain tool — so a concurrencySafe member
    // of a mixed run takes only the pool + P3 drain bounds (its sequential
    // semantics, made overlapping), while Agent members keep the exact pre-W3-2
    // admission. Without this split, a wide read batch near the USD ceiling would
    // be spuriously denied with a "fuel ceiling" note sequential Reads never see.
    // P3 (bounded drain): the raceAbortDrain wrapper must be INSIDE the
    // queue-close chain — PASS 2 blocks on the queue drain first, and the queue
    // only closes when this chain settles, so bounding the raw promise alone
    // would leave the drain unbounded. On expiry the wrapper resolves the
    // sentinel, the queue closes, and PASS 2 seals + throws.
    const agentNode = REEXECUTE_BOUND_TOOLS.has(tu.name);
    const dispatchPromise = raceAbortDrain(
      admitNode<ToolDispatchResult>({
        ...(agentNode && globalAdmission !== undefined && { global: globalAdmission }),
        ...(agentNode && fuelTank !== undefined && { tank: fuelTank }),
        pool: batchPool,
        reserveUsd: nodeReserve,
        spentUsd: () => rc.billing.cumulativeCostUsd,
        run: () =>
          gateAndDispatchTool(
            def, tu.input, tu.id, deps.harness, onPause, onAuthHalt,
            {
              ...baseExecCtx,
              dispatchInProcessTool: makeInProcessDispatcher({
                tools, harness: deps.harness, onPause: inCodePause, onAuthHalt, execCtx: baseExecCtx,
              }),
            },
          ),
        onDenied: () => ({
          toolUseId: tu.id,
          text: `Skipped: session fuel ceiling ($${cfg.sessionFuelTankUsd?.toFixed(2)}) reached before launch — returning partial results.`,
          isError: false,
          fuelDenied: true,
        }),
      }),
      cfg.signal,
      cfg.drainTimeoutMs ?? DRAIN_DEFAULT_MS,
    ).finally(() => queue.close());
    handles.push({ tu, persistedToolBlock, queue, dispatchPromise, known: true });
  }
  return handles;
}

// PASS 2 (batch order): drain each tool's queue + finalize its result. Draining
// queue[i] to close (the dispatch's `.finally` closes it on settle) before
// queue[i+1] keeps emission deterministic; siblings keep executing meanwhile.
async function* drainConcurrentDispatches(
  c: ToolBatchCtx,
  handles: ConcurrentHandle[],
): AsyncGenerator<HarnessEvent, void, void> {
  const { deps, results } = c;
  const { ctx, cfg, transport, history, pendingTodoBlocks } = deps;
  for (const h of handles) {
    for await (const ev of h.queue) yield ev;
    const settledOrExpired = await h.dispatchPromise;
    // P3 (bounded drain): the dispatch outlived abort+grace. Seal THIS tool_use
    // truthfully (normal append path — the catch's heal sees it answered and
    // never double-seals), then throw so iterateTurn's catch finalizes
    // user_aborted exactly as today; heal seals the batch's other orphans.
    if (isDrainExpired(settledOrExpired)) {
      if (cfg.journal) await cfg.journal.sealInterruptedToolUse(h.tu.id, settledOrExpired.elapsedMs);
      throw abortError();
    }
    const res = settledOrExpired;
    results.push(res);
    // Fold the result INTO the persisted tool_use block (same as the sequential path).
    const pb = h.persistedToolBlock as unknown as Record<string, unknown>;
    pb.result = res.text;
    // A pausedHalt is a TYPED suspension, not an error (see the sequential fold
    // above): status:'paused' + isError:false, keyed off pausedHalt so the
    // isError-carrying pause paths (Composio auth, hook halt) are covered too.
    pb.isError = res.isError && !res.pausedHalt;
    pb.status = res.pausedHalt ? 'paused' : res.isError ? 'error' : 'completed';
    pb.endTime = new Date();
    yield {
      kind: 'block',
      block: {
        type: 'tool_result',
        toolUseId: h.tu.id,
        content: res.text,
        isError: res.isError && !res.pausedHalt,
        // Telemetry provenance: without a name on the wire the server logged
        // 'unknown' whenever it could not pair this result to its tool_use.
        toolName: h.tu.name,
        ...(res.pausedHalt ? { status: 'paused' as const } : {}),
        // S2a: the browser action report rides the live tool_result block
        // (spread-when-present — report-less results are byte-identical).
        ...(res.report !== undefined && { report: res.report }),
      } as ContentBlock,
    };
    // Per-tool ACTION billing — skip a paused tool (it re-dispatches + bills on
    // resume), the unknown-tool no-op (`known:false`), and a fuel-DENIED node (it
    // never ran, so there is no action to charge). Same gate as sequential + the
    // §1a admission denial.
    const billing = h.known ? toolBillingEvent({ taskId: ctx.taskId, toolName: h.tu.name, toolUseId: h.tu.id }, res) : undefined;
    if (billing) yield billing;
    while (pendingTodoBlocks.length > 0) {
      yield { kind: 'block', block: pendingTodoBlocks.shift()! };
    }
    // A pause-for-human halt leaves the paused tool_use UNANSWERED (no tool_result):
    // the onPause path (T5) already wrote a {status:'deferred'} placeholder for each
    // ANCESTOR Agent tool_use, so a paused sibling is slot-complete + durable while
    // the rest journal their real results. (Identical withholding rule to sequential.)
    if (!res.pausedHalt) {
      await appendToolResultEntry(cfg.journal, ctx, res);
      if (!cfg.journal) {
        transport.pushToolResult(history, res);
      }
    }
  }
}

// The CONCURRENT-run executor. Runs `tus` (a ≥2 consecutive Agent-or-
// concurrencySafe run — W3-2) through the `:turnbatch` pool; Agent members also
// take the admission stack. JS is single-threaded, so each child's
// addCostUsd / addChildCost mutation lands exactly once on the shared turn
// accumulators; a paused sibling writes its own {status:'deferred'} ancestor
// placeholder via onPause (T5) while the rest finish.
//
// P2.2 gate 5 (LOAD-BEARING — deadlock discipline): concurrency is MAIN-LOOP
// ONLY. partitionToolBatch forms a concurrent run only when deps.sub === undefined;
// the segment loop re-asserts `&& deps.sub === undefined` (which also re-narrows
// the RoundDeps union for `rc`/`dispatcher`). The `:turnbatch` pool is acquired
// only by the main loop — a recursion-enabled subagent whose batch is all-`Agent`
// would otherwise acquire the same per-task pool a slot-holding parent is already
// inside (a parent blocked on its own child). Under the orchestration walls
// (cfg.subagentWalls) a nested batch runs through `runNestedConcurrentRun` instead:
// admission is by refusal there, so the slot deadlock this rule guarded against
// cannot form.
async function* runConcurrentRun(
  c: ToolBatchCtx,
  tus: RoundState['toolUses'],
  rc: RunContext,
  dispatcher: HookDispatcher,
): AsyncGenerator<HarnessEvent, void, void> {
  const admission = acquireBatchAdmission(c.deps);
  const handles = yield* startConcurrentDispatches(c, tus, rc, dispatcher, admission);
  yield* drainConcurrentDispatches(c, handles);
}

/**
 * ── Tool batch: gate → execute → emit → append a tool_result ──
 *
 * The whole batch for one round, in batch order. Returns the results array the
 * round hands back to the loop; owns `st.inToolBatch` (D2's abort-phase
 * classifier) around the dispatch window.
 */
export async function* runToolBatch(
  deps: RoundDeps,
  st: RoundState,
  capturedReasoning: CapturedReasoning,
  committedModel: string,
  // L1: the calls that started while the model was streaming (absent ⇒ none did).
  early?: EarlyStart,
): AsyncGenerator<HarnessEvent, ToolDispatchResult[], void> {
  const { ctx, cfg, transport, tools } = deps;
  const results: ToolDispatchResult[] = [];
  // §4.3a — `capturedReasoning` (read once above, before the assistant append)
  // also feeds the per-call attach here: each tool_use entry persists the
  // reasoning item(s) that preceded it (matched by call_id), which
  // journalToOpenAIResponsesInput then echoes before the function_call.
  // D2: phase flag for the abort catch — an abort during the tool batch is
  // classified 'tools', else 'streaming'. Reset to false after the batch.
  st.inToolBatch = true;
  const c: ToolBatchCtx = { deps, st, capturedReasoning, committedModel, results, ...(early !== undefined && { early }) };

  // Orchestration walls (spec D3): a DELEGATED helper (deps.sub !== undefined) that issues
  // exactly one Agent call in a round is handing its whole piece to one child — the chain
  // that recursed five deep on prod task 95076757. Refuse it as a normal tool result;
  // two or more siblings, or one call with children[] of two or more, pass.
  // ONLY when this holder actually carries the Agent tool: a LEAF whose model hallucinates
  // a single Agent call has nothing to split, so it must get the plain unknown-tool answer
  // ("split it into two" is unfollowable advice there) and must not count as a lone_child.
  const canDelegate = deps.tools.some((t) => REEXECUTE_BOUND_TOOLS.has(t.name));
  if (deps.sub !== undefined && cfg.subagentWalls === true && canDelegate) {
    const agentCalls = st.toolUses.filter((t) => REEXECUTE_BOUND_TOOLS.has(t.name));
    // The tally is NOT rung here. This only DECIDES the refusal; the batch can still stop
    // before that tool_use is reached (a paused sibling, an abort), and a refusal the model
    // never received is not a wall the run hit. The two delivery sites — runSequentialTool
    // and runNestedConcurrentRun, where the refusal text is actually minted — ring it.
    if (agentCalls.length === 1 && !isParallelBatchInput(agentCalls[0].name, agentCalls[0].input)) {
      c.loneChildRefusal = agentCalls[0].id;
    }
  }

  // Orchestration walls (follow-up item 1, spec §0) — the ROOT wall, the same shape one
  // level up. On the founder's staging run the MAIN turn spawned one researcher, waited
  // for it, then spawned one again; the lone researcher then ran 99 searches while the
  // rest of the plan sat behind it. The first lone spawn is legitimate (one piece of work
  // is one helper); a second in a row, with no other tool call between them, is a plan
  // being drip-fed. Decided from the TURN's own tool-call sequence — this round's batch
  // plus the flag the previous round left on the per-turn RunContext — never a hand list.
  // `deps.rc` narrows the union to the MAIN loop, so a nested batch (which the D3 wall
  // above already owns) can never reach this.
  // `canDelegate` for the same reason the D3 wall carries it, and it is NOT dead here: a
  // background HELPER runs as its OWN actor, so it has a main loop (rc defined, walls on)
  // while its frozen def may exclude Agent entirely. Without this, two hallucinated lone
  // Agent calls from such a helper would get "issue them together in ONE message", advice
  // for a tool it does not have, and would ring serial_root for a spawn that never existed.
  // Follow-up D item 1 — the streak arms only on an ADMITTED spawn. It used to arm on the
  // call's SHAPE, before dispatch, so a lone spawn the Agent tool then refused on its own
  // grounds armed it anyway: on the 2026-09-04 rerun a bad tool name on the first spawn
  // armed the streak, the corrected retry read as a second consecutive lone spawn and was
  // refused, no helper ran, and the model ended its turn saying one was. This site still
  // DECIDES (lone shape, dependent, refused-vs-allowed); the arming moved to the delivery
  // site, which is the only place that can see whether the tool admitted the spawn.
  if (deps.rc !== undefined && cfg.subagentWalls === true) {
    // Follow-up B item 1 — plan bookkeeping is set aside BEFORE the shape is read. A todo
    // call is not work, so it can neither clear the streak nor start one; a round that was
    // nothing but bookkeeping leaves the streak exactly as it found it (task 406e56a9:
    // three lone spawns separated by TodoUpdates, and serial_root stayed 0).
    // Follow-up C item 1 — SPAWN_SHAPED_TOOLS, not REEXECUTE_BOUND_TOOLS: a depth-0 Weave
    // call launches helpers too, and the model routed its one-at-a-time plan through it the
    // moment the Agent door was walled. `canDelegate` is replaced here by the sharper
    // per-call check it was standing in for (R109 M2), now that the set has two members: the
    // holder must carry THE TOOL THIS CALL NAMES, or a hallucinated call gets the plain
    // unknown-tool answer rather than advice about a tool it does not have.
    const work = st.toolUses.filter((t) => !BOOKKEEPING_TOOLS.has(t.name));
    const lone = work.length === 1 && SPAWN_SHAPED_TOOLS.has(work[0].name)
      && deps.tools.some((t) => t.name === work[0].name)
      && !isParallelBatchInput(work[0].name, work[0].input)
      && isInTurnSpawn(work[0].name, work[0].input, cfg.subagentBackgroundAdvertised === true)
      ? work[0]
      : undefined;
    if (work.length === 0) {
      // Bookkeeping only: neither arm nor reset.
    } else if (lone === undefined) {
      // ANY other round breaks the streak: a two-call batch, a lone spawn alongside other
      // work, a background spawn, or a round that called no Agent at all.
      deps.rc.lastRoundWasLoneSpawn = false;
    } else if (deps.rc.lastRoundWasLoneSpawn) {
      // Left ARMED in all three verdicts, not cleared: a third lone spawn is the same
      // mistake, and clearing here would let the model alternate refused/allowed forever.
      // Like the D3 wall, the tally is rung at DELIVERY, not here — a batch can still stop
      // before this tool is reached, and a refusal the model never received is not a wall
      // the run hit. The RunContext rides along so the delivery site can count the refusal
      // it actually delivered against the cap it is read from here.
      //
      // Follow-up C items 2 and 3 and R129, in the order the model earns them. A spawn that
      // NAMES what it is waiting for has said why it must run alone, so it runs (and does not
      // spend the refusal budget: nothing was refused) while the turn still has declarations
      // left. Past THAT budget the declaration stops excusing anything and the spawn falls
      // through to the same judgement a bare one gets, which is what keeps the two caps from
      // contradicting each other. Then the turn's refusal budget decides: past it, the same
      // sentence a third time is a loop, so the spawn runs with the reading prepended instead.
      const verdict = declaresDependency(lone.input) && deps.rc.serialRootDependents < SERIAL_ROOT_DEPENDENT_CAP
        ? 'dependent'
        : deps.rc.serialRootRefusals >= SERIAL_ROOT_REFUSAL_CAP ? 'allowed' : 'refused';
      c.serialRoot = { id: lone.id, verdict, rc: deps.rc };
    } else {
      // The turn's FIRST lone spawn in a row: allowed, and it arms the streak — at
      // DELIVERY, and only if the Agent tool does not refuse it (round-tool-sequential).
      c.serialRoot = { id: lone.id, verdict: 'first', rc: deps.rc };
    }
  }

  // Media turn-settle (CONTENT_ENGINE_V1): the run's per-turn settled flag, carried on
  // RunContext. Present ONLY on the MAIN loop with the flag on — the `deps.sub ===
  // undefined` narrows the RoundDeps union to the rc-bearing variant. Off / subagent
  // path → undefined → every guard below is skipped, byte-identical to the pre-lock
  // dispatch. Read ONCE here so the enforce check + the post-batch detection agree.
  const mediaSettle =
    cfg.mediaTurnSettle === true && deps.sub === undefined ? deps.rc : undefined;

  if (mediaSettle?.mediaTurnSettled) {
    yield* denySettledMediaBatch(c);
    st.inToolBatch = false;
    return results;
  }

  // ── T6 (HITL subagent depth): PARTITIONED concurrent sibling dispatch ───────
  // Partition the batch into ordered segments (partitionToolBatch): each maximal
  // ≥2 run of CONSECUTIVE run-eligible tool_uses — `Agent`, or a tool DECLARED
  // `concurrencySafe` (W3-2: the read-only family; three Reads and a Grep overlap
  // instead of four serial round-trips) — is a CONCURRENT run (the ~12s-not-37s
  // win); every undeclared tool_use — and any lone eligible call — is SEQUENTIAL.
  // Segments execute in batch order, each fully settling before the next, so exact
  // relative order is preserved (an undeclared tool between runs is a barrier) and
  // file-WRITE/todo tools never race. The loop STAYS THE SOLE EMITTER (K3): within
  // each run, tool_use blocks + PushQueue events + tool_results drain/yield in
  // batch order — deterministic, never interleaved across tools, never duplicated.
  // The historic all-`Agent` fast path is now the special case of one full-width
  // concurrent run; a round with no ≥2-eligible run is one sequential segment ==
  // the pre-T6 body. The safe-name set is read off THIS round's tool registry
  // (RawToolOptions.concurrencySafe, or the L2 `concurrency` class under
  // TOOL_CONCURRENCY_CLASSES_V1; fail-closed: absent/unknown ⇒ sequential);
  // REEXECUTE_BOUND_TOOLS itself is untouched — it also drives interaction
  // re-execution/resume, so the partitioner takes this second predicate instead.
  const sharedNames = sharedToolNames(tools);
  const segments = partitionToolBatch(
    st.toolUses,
    deps.sub === undefined,
    (name) => sharedNames.has(name),
    { nestedConcurrent: deps.sub !== undefined && cfg.subagentWalls === true },
  );

  // Record WHAT WAS DECIDED, next to the decision — the leg that turns "did the
  // parallel subagents actually run in parallel?" into a SQL predicate instead of a
  // hand reconstruction of round boundaries. MAIN LOOP only (a subagent batch has no
  // decision to observe); batch-shape.ts owns the gate and its rationale, and
  // returns undefined for a round that had no batching decision.
  if (deps.sub === undefined) {
    const shape = toolBatchShape(st.toolUses, segments, (n) => sharedNames.has(n), {
      round: deps.rc.billing.roundCounter.value,
      api: transport.api,
      model: committedModel,
    });
    if (shape) await appendToolBatchShapeEntry(cfg.journal, ctx, shape);
  }

  // Execute the partitioned batch in segment order: each concurrent run overlaps
  // via `:turnbatch`; each sequential segment runs its tools one-at-a-time. A
  // sequential tool returning `true` (subagent pause / drain-expiry — the old
  // `break`) stops the batch. Segments run strictly in order, each fully settling
  // before the next, so exact batch order + the barrier semantics hold (K3).
  // X1 (HOOK_PARITY_V1): an interrupt stops IMMEDIATELY. Once a result carries `hookStop`, no
  // later call in the batch starts: each is answered as cancelled by policy (rendered and journaled,
  // never silently dropped). A call already running in the same concurrent run finishes as it
  // would after a Stop today. Main loop only: inside a helper an interrupt is a plain deny.
  const interrupted = (): boolean => deps.sub === undefined && results.some((r) => r.hookStop !== undefined);
  for (const seg of segments) {
    if (interrupted()) {
      for (const tu of seg.tus) yield* cancelSequentialTool(c, tu);
    } else if (seg.concurrent && deps.sub === undefined) {
      yield* runConcurrentRun(c, seg.tus, deps.rc, deps.dispatcher);
    } else if (seg.concurrent && deps.sub !== undefined) {
      // Orchestration walls (spec §4.2) — parallel at EVERY depth: a nested run
      // overlaps through its OWN per-run Semaphore, never the main loop's pool. It
      // returns the SAME stop signal a sequential tool does (a paused child / a drain
      // expiry), so the pause stops LATER segments too — the nested batch was one
      // sequential segment before the walls, and a pause stopped all of it.
      if (yield* runNestedConcurrentRun(c, seg.tus)) break;
    } else {
      let stopBatch = false;
      for (const tu of seg.tus) {
        if (interrupted()) { yield* cancelSequentialTool(c, tu); continue; }
        if (yield* runSequentialTool(c, tu)) { stopBatch = true; break; }
      }
      if (stopBatch) break;
    }
  }

  // D2: the tool batch is done — a later abort (next model call/stream) is 'streaming'.
  st.inToolBatch = false;

  // ── Media turn-settle DETECTION ─────────────────────────────────────────────
  // If a `media` tool_use in THIS round returned a queued job, ARM the lock so the
  // NEXT round (and the rest of the turn) is denied at the batch head above. Armed at
  // batch END (not per result) so this round's own sibling calls all ran first — the
  // lock is round-grained, which is what lets two `media` calls in one block both
  // execute. Guarded by mediaSettle (active + not-yet-armed); off / subagent → skipped.
  if (mediaSettle && !mediaSettle.mediaTurnSettled) {
    for (const tu of st.toolUses) {
      if (tu.name !== 'media') continue;
      const res = results.find((r) => r.toolUseId === tu.id);
      if (res && resultHasQueuedMedia(res.text)) {
        mediaSettle.mediaTurnSettled = true;
        break;
      }
    }
  }

  return results;
}
