/**
 * tool-early-start.ts — L1 (TOOLS_MIDSTREAM_V1): a tool call starts while the model is still
 * streaming the rest of its answer.
 *
 * Every transport emits a `tool_ready` stream event the moment one call's arguments are
 * complete and readable (engine/tool-ready.ts). The round's stream drive hands each one to
 * `offer`; the tool batch, which still runs after the stream exactly as before, `take`s the
 * started dispatch in its turn instead of starting a second one. Everything the person and the
 * journal see keeps its order: the tool_use block, the tool_use entry, the live events, the
 * tool_result and its entry all land in CALL order at the batch, whatever order the calls
 * finished in. Only the work moved earlier.
 *
 * WHICH calls start early: only one that would have started first anyway. That is a SHARED
 * call (the L2 class, or the W3-2 marker: reads, search, fetch, Nami reads) with nothing but
 * calls the partition overlaps with it before it in this round (batch-shape.ts runs every
 * maximal run of shared-or-Agent calls together, and anything else is a barrier). So the
 * first exclusive call (an Edit, Bash, the browser) shuts the door for the rest of the round:
 * it and everything after it wait for the stream to end, as they always did. Agent and Weave
 * spawns never start early, because the orchestration walls and the fuel tank judge a spawn
 * from the WHOLE batch, which does not exist yet. Main loop only (a subagent's batch runs
 * through its own seams), and never in a turn whose media is already settling.
 *
 * THE GATE runs when the call starts (decideToolGate, the PreToolUse hooks, the schema check,
 * the injection screen: the whole of gateAndDispatchTool, unchanged), so nothing runs before
 * its gate. What the gate cannot do early is put a card in front of the person: a call that
 * needs approval waits, holding its pause, until the batch reaches it and has journaled its
 * tool_use, and only then asks, exactly when it asks today. A Composio connect card waits the
 * same way. A denied call's PERMISSION_DENIED event waits in the call's own queue.
 *
 * CANCELLED: a started call nobody takes (the stream failed or was aborted, the provider sent
 * a different call under that id, the round ended first) is aborted through its own signal and
 * its result dropped. It journaled nothing, so there is nothing to seal; its pause, if it was
 * holding one, never reaches the person.
 *
 * THE READ/WRITE GATE (TOOLS_MIDSTREAM_RW_V1, on top of L1; Codex tools/parallel.rs takes a
 * read lock for a parallel tool and a write lock for any other, fairly, in arrival order). The
 * first exclusive call no longer shuts the door: each call in the round starts at its
 * `tool_ready` as soon as the gate lets it. A shared call starts unless an earlier exclusive
 * call has not settled; an exclusive call starts once EVERY earlier call has settled; a later
 * call queues behind it. A call that cannot start early (unreadable arguments, a spawn, no such
 * tool) never settles before the batch, so it holds back every exclusive call after it, and an
 * exclusive one holds back everything after it. A call holding a pause has not settled either.
 * Nothing starts once the batch begins: a queued call is the batch's to run, as before.
 *
 * Because an exclusive call may now have RUN before the stream ends, a round that ends before
 * the batch takes it cannot just drop it (the edit happened; nothing would say so). `salvage`
 * hands the round the started prefix to journal, in call order, with real results (Codex
 * drains its in-flight calls and records them even when the stream fails: session/turn.rs
 * drain_in_flight). The prefix skips what the batch already took and stops at the first call
 * that has not started, whose gate has not answered yet, or that is holding a pause. A call
 * left out is cancelled and never runs, even if its gate answers later (its execute refuses
 * once the round let go of it); a held card is never shown, during the salvage either. On a
 * stream error the prefix's running calls get the drain bound from the moment the salvage
 * begins, so the error reaches the person within it. Nothing starts once the turn is stopped
 * or the round has let go of its calls.
 */
import type { HarnessEvent } from '../contract/events.js';
import type { ToolCall } from '../contract/harness.js';
import type { RawToolOptions, ToolDispatchResult, OnAuthHalt } from '../tools/tool-types.js';
import { REEXECUTE_BOUND_TOOLS } from '../kernel/index.js';
import { toolsMidstreamEnabled, toolsMidstreamRwEnabled } from '../policy/feature-flags.js';
import { gateAndDispatchTool } from './tool-dispatcher.js';
import { raceAbortDrain, isDrainExpired, DRAIN_DEFAULT_MS, type DrainExpired } from './abort-drain.js';
import { PushQueue } from './push-queue.js';
import { sharedToolNames } from './batch-shape.js';
import { SPAWN_SHAPED_TOOLS } from './subagent-walls.js';
import { makeInProcessDispatcher, inCodePause } from './in-process-dispatcher.js';
import { buildToolExecCtx } from './round-tool-sequential.js';
import { turnBatchPool } from './round-tool-batch.js';
// Types only (erased at emit) — no runtime import edge back to round-engine.ts.
import type { RoundDeps } from './round-engine.js';

/** One call as the stream names it (the `tool_ready` payload, and later the `tool_use`). */
export interface StreamedCall {
  id: string;
  name: string;
  input: unknown;
}

/** A call the batch takes over: its live channel and its drain-bounded dispatch. */
export interface EarlyDispatch {
  queue: PushQueue<HarnessEvent>;
  dispatchPromise: Promise<ToolDispatchResult | DrainExpired>;
}

/** The round's early starts. */
export interface EarlyStart {
  /** A `tool_ready` call: start it now if it would have started first anyway. */
  offer(call: StreamedCall): void;
  /** The batch reached this call: its started dispatch (its pause may now ask), or undefined. */
  take(call: StreamedCall): EarlyDispatch | undefined;
  /** Abort every started call nobody took, and start nothing more. Safe to call more than once. */
  cancelUntaken(): void;
  /**
   * TOOLS_MIDSTREAM_RW_V1: the round is ending with calls the batch never took (the stream
   * failed, the person stopped it, or the round threw or was closed before its batch). The
   * started prefix the round must journal, in call order, when an exclusive call in it may have
   * run; undefined when there is none (a reads-only prefix is cancelled as L1 always did).
   * Shuts the gate; a call still running gets the drain bound from now. The rest is left to
   * cancelUntaken.
   */
  salvage(): StreamedCall[] | undefined;
}

/** What a held pause returns when its call is cancelled. Never shown: the result is dropped. */
const CANCELLED_BEFORE_ITS_TURN = 'Cancelled before its turn in the batch.';

interface Started extends EarlyDispatch {
  call: StreamedCall;
  /** Lets the held pause / auth card through (true) or drops it (false). Called once. */
  open: (go: boolean) => void;
  abort: AbortController;
  /** TOOLS_MIDSTREAM_RW_V1: arms the drain bound without stopping the call (a salvage on a stream error). */
  drain: AbortController;
  /** TOOLS_MIDSTREAM_RW_V1: what the gate reads of its run. */
  gate: CallGateState;
}

/** A started call's run, as the gate and the salvage read it. */
interface CallGateState {
  /** Its dispatch has finished (the gate counts it as settled). */
  finished: boolean;
  /** It asked for a pause or a card, which waits for its turn in the batch. */
  holding: boolean;
  /** Its gate let it through and it began to execute: from here its effect may be real. */
  running: boolean;
  /** The batch took it: its result is the batch's to journal. */
  taken: boolean;
  /** Cancelled: its result is dropped, and it never begins to execute. */
  cancelled: boolean;
}

/** TOOLS_MIDSTREAM_RW_V1: one call of the round, in call order, as the gate sees it. */
interface GateEntry {
  call: StreamedCall;
  exclusive: boolean;
  /** The definition to start, or undefined when the call cannot start early. */
  def: RawToolOptions | undefined;
  started: Started | undefined;
}

/**
 * The round's early starts, or undefined when none may happen: the flag is off, this is a
 * subagent's round, or the turn's media already settled (every call is then denied unrun).
 */
export function createEarlyStart(deps: RoundDeps): EarlyStart | undefined {
  if (deps.sub !== undefined) return undefined;
  if (!toolsMidstreamEnabled()) return undefined;
  const { ctx, cfg, rc, dispatcher, tools, harness } = deps;
  if (cfg.mediaTurnSettle === true && rc.mediaTurnSettled) return undefined;
  const shared = sharedToolNames(tools);
  // One reading of "exclusive" for L1's door and the read/write gate alike: neither a spawn
  // (the walls own those) nor a call the partition overlaps.
  const isExclusive = (name: string): boolean => !REEXECUTE_BOUND_TOOLS.has(name) && !shared.has(name);
  const started = new Map<string, Started>();
  // Shut by the first call the partition would not overlap with what came before it.
  let doorShut = false;
  // TOOLS_MIDSTREAM_RW_V1: the read/write gate instead of the door, read once per round.
  const rw = toolsMidstreamRwEnabled();
  const entries: GateEntry[] = [];
  // No call starts early once the batch has begun, the round has let go of its calls (a
  // salvage or a cancel), or the turn is stopped.
  let gateShut = false;
  const closed = (): boolean => gateShut || cfg.signal?.aborted === true;
  // The round is journaling its started prefix: a card it would mint now would belong to a
  // round that is about to throw, so a late pause or auth card is cancelled instead.
  let salvaging = false;

  const cancel = (s: Started): void => {
    if (s.gate.taken || s.gate.cancelled) return;
    s.gate.cancelled = true;
    s.open(false);
    s.abort.abort();
  };

  const start = (call: StreamedCall, def: RawToolOptions): Started => {
    const queue = new PushQueue<HarnessEvent>();
    // Its own signal, so a cancel stops this call alone; the turn's abort still reaches it.
    const abort = new AbortController();
    const drain = new AbortController();
    abort.signal.addEventListener('abort', () => drain.abort(), { once: true });
    const parent = cfg.signal;
    const relay = (): void => abort.abort();
    if (parent?.aborted) abort.abort();
    else parent?.addEventListener('abort', relay, { once: true });
    const gate: CallGateState = { finished: false, holding: false, running: false, taken: false, cancelled: false };
    let open!: (go: boolean) => void;
    const turn = new Promise<boolean>((resolve) => { open = resolve; });
    const onPause = async (c: ToolCall, kind: string): Promise<string> => {
      gate.holding = true;
      return (await turn) && !salvaging ? deps.onPause(c, kind) : CANCELLED_BEFORE_ITS_TURN;
    };
    const authHalt = deps.onAuthHalt;
    const onAuthHalt: OnAuthHalt | undefined = authHalt === undefined ? undefined : async (verdict, bind) => {
      gate.holding = true;
      if ((await turn) && !salvaging) await authHalt(verdict, bind);
    };
    // TOOLS_MIDSTREAM_RW_V1: the gate has answered when the call begins to execute (the
    // salvage keeps only calls past that point), and a call the round let go of never begins.
    const runDef: RawToolOptions = !rw ? def : {
      ...def,
      execute: (input, execCtx) => {
        if (gate.cancelled) throw new Error(CANCELLED_BEFORE_ITS_TURN);
        gate.running = true;
        return def.execute(input, execCtx);
      },
    };
    const base = { ...buildToolExecCtx({ ctx, cfg, rc, dispatcher, queue }), signal: abort.signal };
    const dispatchPromise = raceAbortDrain(
      turnBatchPool(deps).run(() =>
        gateAndDispatchTool(runDef, call.input, call.id, harness, onPause, onAuthHalt, {
          ...base,
          // The same in-code re-entry the batch gives a call: a side-effect-free pause.
          dispatchInProcessTool: makeInProcessDispatcher({ tools, harness, onPause: inCodePause, onAuthHalt, execCtx: base }),
        }),
      ),
      drain.signal,
      cfg.drainTimeoutMs ?? DRAIN_DEFAULT_MS,
    ).then((r) => {
      // Past its drain bound the call is told to stop (a no-op when the bound came from its abort).
      if (isDrainExpired(r)) abort.abort();
      return r;
    }).finally(() => {
      queue.close();
      parent?.removeEventListener('abort', relay);
    });
    const entry: Started = { call, queue, dispatchPromise, open, abort, drain, gate };
    // An observer, not a handler: a cancelled call's rejection must never go unhandled. A
    // taken call's outcome still reaches the batch, which awaits this same promise. Under the
    // read/write gate a finished call may let the next ones start.
    void dispatchPromise.catch(() => {}).finally(() => {
      gate.finished = true;
      if (rw) pump();
    });
    started.set(call.id, entry);
    return entry;
  };

  // TOOLS_MIDSTREAM_RW_V1: start every call the gate lets through, in call order.
  const pump = (): void => {
    if (closed()) return;
    let allEarlierFinished = true;
    let exclusiveAhead = false;
    for (const e of entries) {
      if (e.started === undefined && e.def !== undefined && (e.exclusive ? allEarlierFinished : !exclusiveAhead)) {
        e.started = start(e.call, e.def);
      }
      if (e.started?.gate.finished !== true) {
        allEarlierFinished = false;
        if (e.exclusive) exclusiveAhead = true;
      }
    }
  };

  const offerToGate = (call: StreamedCall): void => {
    if (closed() || entries.some((e) => e.call.id === call.id)) return;
    const exclusive = isExclusive(call.name);
    // Unreadable arguments and spawns never start early (as under L1); the call still
    // takes its place in the order, holding back what must wait for it.
    const startable = call.input !== undefined && !SPAWN_SHAPED_TOOLS.has(call.name);
    const def = startable ? tools.find((t) => t.name === call.name) : undefined;
    entries.push({ call, exclusive, def, started: undefined });
    pump();
  };

  return {
    offer(call) {
      if (rw) {
        offerToGate(call);
        return;
      }
      if (doorShut || started.has(call.id) || closed()) return;
      // Judged by NAME first: an exclusive call shuts the door whether or not its arguments
      // could be read (the transports report every closed call, an unreadable one with
      // input undefined, precisely so this line sees it).
      if (isExclusive(call.name)) {
        doorShut = true;
        return;
      }
      // Unreadable arguments never start early; the batch runs the call as it always did.
      if (call.input === undefined) return;
      if (SPAWN_SHAPED_TOOLS.has(call.name)) return;
      const def = tools.find((t) => t.name === call.name);
      if (def) start(call, def);
    },
    take(call) {
      // The batch has begun: nothing else starts early.
      gateShut = true;
      const s = started.get(call.id);
      if (s === undefined || s.gate.taken || s.gate.cancelled) return undefined;
      // The call the batch runs is the stream's final word. A different call under the same
      // id (it never happens on a sane stream) is not the one that started: drop it, run fresh.
      if (s.call.name !== call.name || JSON.stringify(s.call.input) !== JSON.stringify(call.input)) {
        // Said out loud: on a sane stream this never happens, so when it does, the provider
        // (or its transport) changed a call after closing it, and the early run was wasted work.
        console.warn(
          `[tool-early-start] ${call.name} ${call.id}: the stream's final call differs from the one started early; cancelled it, running the final one`,
        );
        cancel(s);
        return undefined;
      }
      s.gate.taken = true;
      s.open(true);
      return { queue: s.queue, dispatchPromise: s.dispatchPromise };
    },
    cancelUntaken() {
      // Shut first: a cancelled call settles, and a settled call must not let a queued one start.
      gateShut = true;
      for (const s of started.values()) cancel(s);
    },
    salvage() {
      if (!rw) return undefined;
      gateShut = true;
      salvaging = true;
      const prefix: Started[] = [];
      let exclusiveRan = false;
      for (const e of entries) {
        const s = e.started;
        if (s?.gate.taken === true) continue;
        // Not started, cancelled, its gate still deciding, or holding a card: the prefix ends.
        if (s === undefined || s.gate.cancelled || s.gate.holding || !(s.gate.running || s.gate.finished)) break;
        prefix.push(s);
        if (e.exclusive) exclusiveRan = true;
      }
      // Every call the round will not journal is let go NOW, before the salvage batch runs: a
      // call left out whose gate answered during that batch would otherwise run unjournaled
      // (its execute refuses once it is cancelled). A reads-only prefix is let go whole, as L1.
      const kept = new Set(exclusiveRan ? prefix : []);
      for (const s of started.values()) if (!kept.has(s)) cancel(s);
      if (!exclusiveRan) return undefined;
      // A call still running gets the drain bound from now (on Stop its abort armed it already).
      for (const s of prefix) s.drain.abort();
      return prefix.map((s) => s.call);
    },
  };
}
