import type { ChildCostRecord } from '../contract/child-cost.js';
import type { FrozenElision } from './context-elision.js';
import type { SessionState } from '../contract/run-state.js';
import type { ElisionCut } from '../kernel/compaction/elide.js';
import type { OverflowObservation } from '../kernel/compaction/overflow.js';
import type { LoopRequest } from './round-engine.js';
import type { MemorySpan } from '../contract/instruction-stack.js';

export interface RunBilling {
  cumulativeCostUsd: number;
  parentOwnCostUsd: number;
  childUsage: ChildCostRecord[];
  roundCounter: { value: number };
}

/**
 * P1 — ONE owner for one run's state. Everything here was previously a loop
 * local in native-harness.ts run() threaded by parameter/reference through
 * iterateTurn. Supersession = drop this object (and, from P3, fire rc.signal).
 * HOLDS PER-TASK STATE ONLY: never a process-global (see fuel-tank.ts:126 for
 * why), and never model/config state beyond what HarnessContext already scopes
 * per task — two parallel tasks on different models must stay fully isolated.
 */
export interface RunContext {
  readonly taskId: string;
  readonly ownerTaskId: string;
  billing: RunBilling;
  /** P1 — the per-task lifecycle phase (idle → starting → streaming → …). Starts
   *  { phase: 'idle' }; P3/P4 drive the transitions off the mailbox. */
  state: SessionState;
  signal?: AbortSignal;
  /**
   * Media turn-settle lock (CONTENT_ENGINE_V1). Armed once a `media` tool call in
   * this turn returned a queued job: the round engine then DENIES every further tool
   * call for the remainder of the turn (queued artifacts deliver themselves — nothing
   * in-turn can observe or speed them up). Per-SESSION (one RunContext per run) AND
   * per-TURN — run() resets it to false at each user-turn boundary. Only consulted
   * when `cfg.mediaTurnSettle` is on; off → never read (byte-identical).
   */
  mediaTurnSettled: boolean;
  /**
   * Follow-up item 1 (root wall) — did the round this turn last settled consist of exactly
   * ONE in-turn Agent call and nothing else? Two of those in a row, with no other tool
   * between them, is the root drip-feeding helpers one at a time, and the second is
   * refused. Per-TURN on top of RunContext's per-run ownership: reset at every user-turn
   * boundary (native-run-turn), exactly as `mediaTurnSettled` is, so a new user message
   * never inherits the previous turn's streak. Only consulted when `cfg.subagentWalls` is
   * on; off, nothing ever writes it.
   */
  lastRoundWasLoneSpawn: boolean;
  /**
   * Follow-up C item 3 — how many serial_root refusals THIS turn has already delivered.
   * At {@link SERIAL_ROOT_REFUSAL_CAP} the wall stops refusing and starts allowing with a
   * note: a third identical refusal to a model that has declined the advice twice is a
   * loop. Per-TURN exactly as `lastRoundWasLoneSpawn` is, and reset at the same site, so a
   * new user message gets its own two. Only written when `cfg.subagentWalls` is on.
   */
  serialRootRefusals: number;
  /**
   * R129 — how many DECLARED lone spawns (`depends_on`) THIS turn has already been given.
   * At {@link SERIAL_ROOT_DEPENDENT_CAP} a declaration stops excusing anything, so the fourth
   * is judged as a bare lone spawn. Per-TURN and reset at the same site as the streak and the
   * refusal budget. Only written when `cfg.subagentWalls` is on.
   */
  serialRootDependents: number;
  /**
   * Follow-up B item 2 — has THIS turn already been told to wrap up? The directive steers
   * once, at `cfg.turnWrapUpAt`; pushing it every round afterwards would turn a nudge into
   * nagging and spend the very context it exists to protect. Per-TURN on top of RunContext's
   * per-run ownership, reset at the user-turn boundary (native-run-turn) exactly as
   * `mediaTurnSettled` and `lastRoundWasLoneSpawn` are, so a resumed helper's second turn
   * gets its own warning. Only written when `cfg.turnWrapUpAt` is set; absent, never touched.
   */
  turnWrapUpPushed: boolean;
  /**
   * Prompt-span latch (observability). `nextRoundKind` reseeds to 'fresh' at every
   * user turn, so gating the prompt_breakdown emit on 'fresh' alone fires once per
   * turn; this run-scoped flag pins it to ONE emit per task birth (the cost cap:
   * one [prompt-span] log line per fresh session). Set true after the first emit.
   */
  promptSpanEmitted: boolean;
  /**
   * CHAT_TAIL_AFTER_TOOLS_V1 / RESPONSES_MEMORY_INPUT_V1 — where this run's memory blocks sit in
   * its system prompt (instruction-stack.ts memorySpan), measured ONCE at run open from the
   * layers the prompt was rendered from (a held base's own texts), so every round of the run
   * and every run of a held session cuts the same bytes, whatever a warm refresh puts on the
   * config mid-run. `system` is the prompt it was measured on: a round whose prompt is not that
   * one carries no span. Absent: nothing to cut.
   */
  systemMemorySpan?: { span: MemorySpan; system: string };
  /**
   * CONTEXT_ELISION_V1 — the highest eliding cut this run has used, so a later
   * turn can never walk it backward (clampCutMonotonic). Run-scoped like
   * everything else on RunContext: one RunContext per run means parallel
   * sessions sharing a process never share a cut. Null until the flag is on and
   * the journal is long enough to have anything elidable.
   *
   * It is NOT cleared across a compaction from here, and must not be: the cut
   * carries its own {@link ElisionCut.anchor}, so the next prepareElision sees
   * that the span it covered is gone and drops the carry itself. A release
   * driven from the compaction call sites would have to be repeated at every one
   * of them (six today, in three files) and would go stale at the seventh.
   */
  elisionCut: ElisionCut | null;
  /**
   * CONTEXT_ELISION_V1 — THIS turn's frozen elision, the same object the round
   * loop's wire and ledger share. Written by prepareElision (which also owns
   * elisionCut), so it is re-decided at the top of every iterate-turn and, across
   * a Stop re-feed, holds the LAST iterate-turn's decision — the one that wrote
   * the final wire prefix.
   *
   * It lives here rather than staying a local in iterateTurn because the TURN
   * EPILOGUE runs outside it: the off-loop memory sweep is a side call issued from
   * run(), on the loop's own system + tools + journal projection, so it must ride
   * the same frozen map or it ships the RAW bodies where the last round shipped
   * stubs. prepareElision clears this to null before it can return early, so a turn
   * that elides nothing can never inherit the previous turn's map.
   *
   * Null whenever the flag is off or nothing was elidable — which is every turn
   * today, and is what makes the OFF axis byte-identical.
   */
  elision: FrozenElision | null;
  /**
   * COMPACTION_V2 — a context overflow OBSERVED but not yet acted on.
   *
   * Armed when a round truncates on `model_context_window_exceeded` (a SUCCEEDING
   * request that ran out of window mid-generation — nothing throws, so the inline
   * recovery never sees it) and consumed at the next round head. Run-scoped, not
   * turn-scoped, precisely because a truncating round usually ENDS the turn: the
   * recovery lands on the next one, which is also when the user may have switched
   * models — the case Guard 1 in compaction-recovery.ts exists for.
   *
   * Null until the flag is on and a round actually truncates.
   */
  pendingOverflow: OverflowObservation | null;
  /**
   * The proactive compaction trigger's retry bound (compaction-refusal.ts). Armed by every
   * refusal that reached the summarize; the round head's proactive trigger does not fire
   * again before `notBeforeRound`. `failures` counts the consecutive ones, so the wait
   * doubles. Run-scoped like `roundCounter`, whose rounds it counts. Null until a
   * compaction refuses; cleared by the next one that lands at the round head.
   */
  compactionRetry: { failures: number; notBeforeRound: number } | null;
  /**
   * The provider's own count of the last MAIN-loop request (compaction-input.ts), which the
   * round head's trigger reads instead of trusting the chars/4 estimate alone. `atSeq` is
   * the journal seq of that round's assistant entry (everything after it is "appended
   * since"); `model` and `elisionCut` say which request it counted, so a model switch or an
   * elision cut that went DOWN makes it stale rather than wrong. Null until a round settles.
   */
  lastRoundInput: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    atSeq: number;
    elisionCut: { result: number; image: number };
  } | null;
  /**
   * Empty-completion recovery latch. Armed by `settleEmptyRound` when a round came back
   * with no text and no tool calls; CONSUMED by `buildRoundRequest`, which overlays the
   * seat + nudge onto a COPY of that one request's history.
   *
   * It is a latch and not a push onto `history` because those two items are deliberately
   * never journaled (a journaled placeholder replays on resume and the model parrots it).
   * Pushing them made the wire permanently un-re-derivable from the journal — every
   * `wire_reconstruction_desync` row ever recorded is that push.
   */
  recoverySeatArmed: boolean;
  /**
   * SWEEP_PREFIX_PARITY_V1 — the main loop's LAST request (round-engine runOneRound writes
   * it on every main round; a subagent round never does). The turn's memory sweep sends it
   * verbatim with its own history and output cap, so it carries every field the loop keys
   * the provider's cache on (the cache key, the system split, the reasoning effort the
   * transport resolves from the same model). Same reason `elision` lives here: the sweep
   * runs in the epilogue, outside the round loop. Null until a main round has been sent.
   */
  lastRequest: LoopRequest | null;
}

export function createRunContext(taskId: string, initialCostUsd?: number): RunContext {
  return {
    taskId,
    ownerTaskId: taskId,
    billing: {
      cumulativeCostUsd: initialCostUsd ?? 0,
      parentOwnCostUsd: 0,
      childUsage: [],
      roundCounter: { value: 0 },
    },
    state: { phase: 'idle' },
    mediaTurnSettled: false,
    lastRoundWasLoneSpawn: false,
    serialRootRefusals: 0,
    serialRootDependents: 0,
    turnWrapUpPushed: false,
    promptSpanEmitted: false,
    elisionCut: null,
    elision: null,
    pendingOverflow: null,
    compactionRetry: null,
    lastRoundInput: null,
    recoverySeatArmed: false,
    lastRequest: null,
  };
}
