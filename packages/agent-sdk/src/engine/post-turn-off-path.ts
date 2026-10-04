/**
 * post-turn-off-path — the two epilogue SIDE CALLS a completed turn makes (the
 * next-prompt suggestion and the Nami memory sweep), lifted out of native-harness.ts.
 *
 * The bodies, gates and event order are the harness's, moved verbatim: with
 * POST_TURN_OFF_PATH_V1 off the loop still awaits both, suggestion first, before it
 * reads the next message ({@link runSideCallsInline}). Measured on staging (15 Sep to
 * 1 Oct) that wait held 22 of 49 quick follow-ups for 3.8 s p50 / 7.8 s p90 before
 * their turn could start. With the flag on, {@link PostTurnOffPath} runs the same calls
 * while the loop already listens for the next message.
 */
import type { HarnessEvent, NormalizedUsage } from '../contract/events.js';
import type { UserTurn } from '../contract/harness.js';
import { stripInvisibleControlTurns } from '../contract/journal.js';
import { laneUsageEvent, runSuggestionCall, suggestionHistoryFromProjection } from './offloop-usage.js';
import {
  runOffloopSweep, depositEventData, isTrivialUserMessage, sweepParityPlan, NAMI_REMEMBER_DEPOSIT_EVENT,
  type OffloopSweepResult, type SweepLoopInput,
} from './memory-sweep.js';
import type { FrozenElision } from './context-elision.js';
import type { NativeConfig } from './native-config.js';
import type { LoopRequest } from './round-engine.js';
import type { ProviderTool, Transport } from './transport.js';
import { sweepEffortMessageEnabled, sweepParityByPrefixEnabled, sweepPrefixParityEnabled } from '../policy/feature-flags.js';
import { monotonicMs } from './monotonic-clock.js';
import type { PostTurnCompaction } from './compaction-post-turn.js';

export { postTurnCompaction } from './compaction-post-turn.js';

/**
 * Inlined literal (the engine reads no `@bash/*`); equals `EVENTS.PROMPT_SUGGESTION`.
 * Payload `{ taskId, suggestion }` matches the Claude-arm emit (identical chip).
 * Pinned by: harness-conformance.native.test.ts ("inlined PROMPT_SUGGESTION literal
 * equals EVENTS.PROMPT_SUGGESTION").
 */
const PROMPT_SUGGESTION_EVENT = 'prompt:suggestion';

/** What both side calls read, captured at the turn's epilogue (after its turn_end). */
export interface PostTurnInputs {
  cfg: NativeConfig;
  taskId: string;
  /** `ctx.model || transport.defaultModel()`. */
  model: string;
  transport: Transport;
  /** The main loop's system string, verbatim (the sweep's cache-prefix contract). */
  system: string;
  /** The main loop's provider tools, read when the sweep starts (cache-prefix contract). */
  wireTools: () => ProviderTool[];
  /** The turn's frozen elision (the sweep's third cache-prefix leg). */
  elision: FrozenElision | null;
  /** The main loop's last request, captured at the epilogue (RunContext.lastRequest). */
  loopRequest: LoopRequest | null;
  /** The provider's count of that request (RunContext.lastRoundInput), for a cut sweep's estimate. */
  loopInput: SweepLoopInput | null;
  /** The run's abort signal: a user abort cancels either call. */
  signal: AbortSignal;
  /** The turn's round counter: a side call's usage row reuses it, never bumps it. */
  turnNumber: number;
  /** The turn completed genuinely: `completed` and not paused. */
  clean: boolean;
  userTurn: UserTurn;
  /** COMPACTION_POST_TURN_V1: the turn-end compaction its check decided on (compaction-post-turn.ts). */
  compact?: PostTurnCompaction | undefined;
}

/**
 * Native next-prompt chip gate. Default-off `suggestNextPrompt` flag; fires ONLY after a
 * genuinely completed turn (never max_turns/budget/refused/paused/aborted). Skipped when a
 * next user message is already staged (the prediction is moot).
 * History: docs/learnings/native-harness-history.md (Coalescing; next-prompt).
 * Pinned by: native-harness.suggestion.test.ts.
 */
export function suggestionWanted(p: PostTurnInputs): boolean {
  return p.cfg.suggestNextPrompt === true && p.clean && !p.cfg.hasPendingInput?.();
}

/**
 * Nami P2 phase 1, the OFF-LOOP memory sweep (spec 2026-08-04): the gates every sweep
 * needs (flag, a genuinely completed turn, a journal to project).
 */
export function sweepBaseGate(p: PostTurnInputs): boolean {
  return p.cfg.namiOffloopSweep === true && p.clean && Boolean(p.cfg.journal);
}

/** The phase 0 trivial-turn gate and never-after-a-control-turn: does THIS turn ask for one. */
export function sweepOwnInterest(p: PostTurnInputs): boolean {
  return p.userTurn.control === undefined && !isTrivialUserMessage(p.userTurn.text ?? '');
}

/** The suggestion side call's results: its lane row (absent when nothing was sent) and its chip. */
export interface SuggestionOutcome {
  row?: HarnessEvent;
  chip?: HarnessEvent;
  /** A failed call's usage reported before the failure (SideCallResult.spent). */
  spent?: NormalizedUsage;
}

/**
 * ONE suggestion side call. Trimmed window (last user + assistant, control turns
 * stripped) + the API-validity trailing user turn, assembled in offloop-usage.ts.
 * Side-call: never priced, never throws out of the call itself. The row is metered
 * BEFORE the chip: a call that failed produced no chip but DID hit the provider, and
 * that attempt must still surface.
 */
export async function suggestionCall(
  p: PostTurnInputs,
  signal: AbortSignal,
  reasoningEffort?: 'low',
): Promise<SuggestionOutcome> {
  const projected = p.cfg.journal
    ? stripInvisibleControlTurns((await p.cfg.journal.project()).messages)
    : [];
  const startMs = monotonicMs();
  const suggested = await runSuggestionCall({
    trimmed: suggestionHistoryFromProjection(projected),
    transport: p.transport,
    model: p.model,
    signal,
    ...(reasoningEffort !== undefined && { reasoningEffort }),
  });
  const row = laneUsageEvent('suggestion', suggested, p.taskId, p.turnNumber, Math.round(monotonicMs() - startMs));
  const chip: HarnessEvent | undefined = suggested.text
    ? {
        kind: 'raw',
        engine: 'native',
        event: PROMPT_SUGGESTION_EVENT,
        data: { taskId: p.taskId, suggestion: suggested.text },
      }
    : undefined;
  return { ...(row && { row }), ...(chip && { chip }), ...(suggested.spent && { spent: suggested.spent }) };
}

/** The sweep side call's results: its lane row, its deposit events, and how it ended. */
export interface SweepOutcome {
  row?: HarnessEvent;
  deposits: HarnessEvent[];
  status: OffloopSweepResult['status'];
  /** A failed call's usage reported before the failure (OffloopSweepResult.spent). */
  spent?: NormalizedUsage;
}

/**
 * ONE memory sweep, on the suggestion-epilogue pattern but with the loop's
 * BYTE-IDENTICAL prefix (system + provider tools + the same WIRE projection, elision
 * and all) so the cache the turn just wrote is a hit. FACT lines become raw deposit
 * events; the sweep is never a turn, never journaled, never suppressed. It is the
 * EXPENSIVE side call (full system + tool schemas + the whole journal projection), so
 * it is metered before the deposits: a sweep that returned no facts still reports.
 */
export async function sweepCall(p: PostTurnInputs, signal: AbortSignal): Promise<SweepOutcome> {
  const startMs = monotonicMs();
  // SWEEP_PREFIX_PARITY_V1: the loop's last request verbatim, so the cache it wrote is a hit, on the
  // rows sweepParityPlan picks: its own turn lowered by a per-message effort change where the row
  // takes one (SWEEP_EFFORT_MESSAGE_V1), as before where parity pays off, past the break-even on a
  // high-effort row without the change (SWEEP_PARITY_BY_PREFIX_V1).
  const plan =
    sweepPrefixParityEnabled() && p.loopRequest
      ? sweepParityPlan(p.loopRequest.model, { effortMessage: sweepEffortMessageEnabled(), byPrefix: sweepParityByPrefixEnabled() })
      : null;
  const sweep = await runOffloopSweep({
    transport: p.transport,
    // Gated by sweepBaseGate: a sweep is only ever asked for when a journal exists.
    journal: p.cfg.journal!,
    elision: p.elision,
    model: p.model,
    system: p.system,
    providerTools: p.wireTools(),
    signal,
    ...(plan && p.loopRequest && { loopRequest: p.loopRequest, ...(p.loopInput && { loopInput: p.loopInput }), ...plan }),
  });
  const row = laneUsageEvent('sweep', sweep, p.taskId, p.turnNumber, Math.round(monotonicMs() - startMs));
  const deposits: HarnessEvent[] = sweep.facts.map((fact) => ({
    kind: 'raw',
    engine: 'native',
    event: NAMI_REMEMBER_DEPOSIT_EVENT,
    data: depositEventData(p.taskId, fact),
  }));
  return { ...(row && { row }), deposits, status: sweep.status, ...(sweep.spent && { spent: sweep.spent }) };
}

/**
 * Flag off (today): both side calls AWAITED, suggestion then sweep, before the loop
 * reads the next message. The sweep gate is evaluated after the suggestion settles,
 * as it always was, so a message staged during the suggestion still skips the sweep.
 */
export async function* runSideCallsInline(p: PostTurnInputs): AsyncGenerator<HarnessEvent> {
  if (suggestionWanted(p)) {
    const s = await suggestionCall(p, p.signal);
    if (s.row) yield s.row;
    if (s.chip) yield s.chip;
  }
  if (sweepBaseGate(p) && !p.cfg.hasPendingInput?.() && sweepOwnInterest(p)) {
    const s = await sweepCall(p, p.signal);
    if (s.row) yield s.row;
    yield* s.deposits;
  }
}

/** Side-call events the idle lane hands the loop BETWEEN turns, never inside one. */
export class PostTurnEvents {
  constructor(readonly events: HarnessEvent[]) {}
}

/** What one epilogue asked the idle lane for, decided at the epilogue (today's timing). */
interface IdleWork {
  p: PostTurnInputs;
  suggest: boolean;
  sweep: boolean;
  compact: PostTurnCompaction | undefined;
}

/** The pull in flight for the next message, and the silent pushes it already brought in. */
interface Pull {
  next: Promise<IteratorResult<UserTurn>>;
  held: UserTurn[];
}

/**
 * A cut call's settle slower than this is reported (`cfg.onPostTurnCut`). The follow-up
 * waits for the settle on purpose (a transport's per-call state is released before the
 * next turn reuses it), so a slow abort is exactly the wait this lane exists to remove.
 */
export const SLOW_CUT_SETTLE_MS = 500;

/**
 * A turn the loop stages without starting one (native-harness.ts: shouldQuery false and
 * no continueInteraction). A silent push is not a follow-up, so it never cuts a side call.
 */
function isSilentStage(t: UserTurn): boolean {
  return t.shouldQuery === false && !t.continueInteraction;
}

/** A cut call's 'error' row says what happened: 'cancelled', with any usage reported before the cut. */
function asCancelled(row: HarnessEvent | undefined, spent: NormalizedUsage | undefined): HarnessEvent | undefined {
  if (row?.kind !== 'usage' || row.laneStatus !== 'error') return row;
  return { ...row, laneStatus: 'cancelled', ...(spent && { usage: spent }) };
}

/**
 * POST_TURN_OFF_PATH_V1 — the side calls leave the input loop's critical path. One per
 * run() (local to it, never module state: parallel sessions share one process).
 *
 * The epilogue {@link schedule}s instead of awaiting; {@link turns} wraps the input and
 * pulls the next message IMMEDIATELY after the turn, then runs the work (suggestion,
 * then sweep: today's order) while that pull is pending, each call raced against it:
 *  - the call settles first: its events go out as one {@link PostTurnEvents}, still idle;
 *  - a REAL message arrives first: the call is aborted and its settle AWAITED before the
 *    message is handed over (a settle slower than {@link SLOW_CUT_SETTLE_MS} is reported).
 *    Only its usage row goes out, as 'cancelled' (a suggestion's chip predicts the message
 *    just sent, so it is never shown), and a sweep cut short is OWED. So a side event only
 *    ever sits between one turn's turn_end and the next turn's first event, the calls write
 *    no journal entries (unchanged), and none of them is still running inside a turn;
 *  - a silent push (a staged turn that starts nothing) is held, the pull goes on, and the
 *    held pushes are handed over, in order, before whatever ends the wait;
 *  - the input ends (or throws): no follow-up is waiting, so the work finishes as today.
 *
 * An OWED sweep runs at the next cleanly completed turn's idle, whatever that turn's own
 * interest: the sweep projects the WHOLE journal, so that one call covers both turns and
 * bills one row. The owed flag lives on this run's instance, so it dies with the run: when
 * turn N+1 itself ends the run (a HITL pause, a budget stop or a user abort) the owed sweep
 * is dropped, as today's pending-input gate drops it. The recovery is the resumed run's own
 * sweep: its first cleanly completed, non-trivial turn re-reads the same transcript.
 *
 * Metering: a call cancelled before it reached the provider reports nothing ('skipped').
 * One cut in flight reports a 'cancelled' row (real provider spend, never filed as a
 * failure): the usage the provider reported before the cut, or zero tokens when it reported
 * none, which is the common case because usage arrives with `done`.
 */
export class PostTurnOffPath {
  private scheduled: IdleWork | undefined;
  private sweepOwed = false;

  /** The epilogue hands over this turn's side work instead of awaiting it. */
  schedule(p: PostTurnInputs): void {
    const suggest = suggestionWanted(p);
    let sweep = sweepBaseGate(p) && (this.sweepOwed || sweepOwnInterest(p));
    // A message already staged would win the race at once: owe the sweep, start nothing.
    if (sweep && p.cfg.hasPendingInput?.()) {
      this.sweepOwed = true;
      sweep = false;
    }
    // COMPACTION_POST_TURN_V1: with a message already staged the next round head decides, as today.
    const compact = p.compact && !p.cfg.hasPendingInput?.() ? p.compact : undefined;
    this.scheduled = suggest || sweep || compact ? { p, suggest, sweep, compact } : undefined;
  }

  /** The input, with the scheduled side work run while each next message is awaited. */
  async *turns(input: AsyncIterable<UserTurn>): AsyncGenerator<UserTurn | PostTurnEvents> {
    const it = input[Symbol.asyncIterator]();
    let pull: Pull | undefined;
    let finished = false;
    try {
      for (;;) {
        const work = this.scheduled;
        this.scheduled = undefined;
        pull = { next: it.next(), held: [] };
        if (work) yield* this.idle(work, pull, it);
        for (const held of pull.held) yield held;
        let r: IteratorResult<UserTurn>;
        try {
          r = await pull.next;
        } catch (err) {
          finished = true; // a throwing input is done: for-await would not close it either
          throw err;
        } finally {
          pull = undefined;
        }
        if (r.done) {
          finished = true;
          return;
        }
        yield r.value;
      }
    } finally {
      // An early exit closes the input, as for-await does. With a pull still outstanding the
      // close is fired, not awaited: an async generator answers return() only after the
      // pending next(), so awaiting it would hang a driver breaking off a superseded run.
      // The fired close completes because the run's end always closes the lane:
      // run-driver.ts cleanup() calls messageStream.cleanupWithRescue (handleQueryError's
      // resume retry calls messageStream.cleanup), which ends the pending pull, and the
      // queued return() then runs.
      if (!finished) {
        if (pull) void Promise.resolve(it.return?.()).catch(() => undefined);
        else await it.return?.();
      }
    }
  }

  private async *idle(work: IdleWork, pull: Pull, it: AsyncIterator<UserTurn>): AsyncGenerator<PostTurnEvents> {
    const { p } = work;
    // The host holds the box awake while this lane works, whatever the work (the chip, the memory
    // sweep, a turn-end compaction): a cloud box otherwise stands by 7 s after AGENT_END, freezing
    // a call mid-stream, which the provider bills and nothing meters. Released when the lane is
    // done; the host bounds it (sandbox stream/post-turn-hold.ts, a 180 s ceiling).
    const release = p.cfg.holdForPostTurnWork?.();
    // Only a real message preempts. An ended or throwing input leaves `message` unsettled;
    // a silent push is held and the pull goes on. Nothing is held once this idle is over.
    let arrived = false;
    let listening = true;
    const message = new Promise<'message'>((resolve) => {
      const watch = (): void => {
        pull.next.then(
          (r) => {
            if (!listening || r.done) return;
            if (isSilentStage(r.value)) {
              pull.held.push(r.value);
              pull.next = it.next();
              watch();
              return;
            }
            arrived = true;
            resolve('message');
          },
          () => undefined,
        );
      };
      watch();
    });
    // One side call, cancelled by the run's abort (as today) or by the next message.
    const race = async <T>(
      lane: 'suggestion' | 'sweep' | 'post_turn_compaction',
      call: (signal: AbortSignal) => Promise<T>,
    ): Promise<{ out: T; cut: boolean }> => {
      const ac = new AbortController();
      const onRunAbort = () => ac.abort();
      if (p.signal.aborted) ac.abort();
      else p.signal.addEventListener('abort', onRunAbort, { once: true });
      try {
        const settled = call(ac.signal);
        if ((await Promise.race([settled.then(() => 'settled' as const), message])) !== 'message') {
          return { out: await settled, cut: false };
        }
        const cutAt = Date.now();
        ac.abort();
        const out = await settled;
        const settleMs = Date.now() - cutAt;
        if (settleMs > SLOW_CUT_SETTLE_MS) p.cfg.onPostTurnCut?.({ lane, settleMs });
        return { out, cut: true };
      } finally {
        p.signal.removeEventListener('abort', onRunAbort);
      }
    };

    try {
      if (work.suggest && !arrived) {
        const { out: s, cut } = await race('suggestion', (signal) => suggestionCall(p, signal, 'low'));
        const row = cut ? asCancelled(s.row, s.spent) : s.row;
        const events = [row, arrived ? undefined : s.chip].filter((e): e is HarnessEvent => e !== undefined);
        if (events.length > 0) yield new PostTurnEvents(events);
      }
      if (work.sweep && arrived) this.sweepOwed = true;
      else if (work.sweep) {
        const { out: s, cut } = await race('sweep', (signal) => sweepCall(p, signal));
        // A sweep that returned is done, whoever won the race; one cut short by a message is
        // owed. A sweep that failed on its own is lost exactly as today (no retry loop).
        const returned = s.status !== 'error' && s.status !== 'timeout' && s.status !== 'skipped';
        this.sweepOwed = cut && !returned;
        const row = cut ? asCancelled(s.row, s.spent) : s.row;
        const events = [...(row ? [row] : []), ...s.deposits];
        if (events.length > 0) yield new PostTurnEvents(events);
      }
      // COMPACTION_POST_TURN_V1, last: an early one yields to the next message (cut before it
      // writes anything); a due one finishes first, since that turn's round head would compact.
      const c = work.compact;
      if (c && !arrived) {
        const events = c.due ? await c.run(p.signal) : (await race('post_turn_compaction', (signal) => c.run(signal))).out;
        if (events.length > 0) yield new PostTurnEvents(events);
      }
    } finally {
      listening = false;
      release?.();
    }
  }
}
