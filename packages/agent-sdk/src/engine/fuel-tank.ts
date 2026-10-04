/**
 * fuel-tank.ts — Phase 1a "The Floor": the Session Fuel Tank + Global Admission
 * semaphore + the lock-ordered `admitNode` wrapper. The shared billing-safety
 * substrate EVERY subagent node rides (Agent today, Weave next).
 *
 * THE PROD GATE (design §6.3 / §6.4 R1). #1252 made the Agent tool 12-wide ×
 * depth-7 and FLAG-FREE, but the concurrent `:turnbatch` path has NO fuel cap — a
 * 12-wide all-`Agent` round can overshoot UNBOUNDEDLY before the cooperative
 * `maxBudgetUsd` turn-boundary gate trips. This module bounds that: a per-session/task
 * USD ceiling the top-level `:turnbatch` nodes debit AT ADMISSION.
 *
 * WHAT THIS BOUNDS — AND WHAT IT DOES NOT (read before trusting the ceiling). The tank
 * is debited at the TOP-LEVEL `:turnbatch` admission only. An admitted node is a whole
 * subagent loop PLUS its depth-7 recursive subtree and any `children[]` fan-out, and
 * those inner dispatches are NOT yet tank-gated (they go through bare
 * `gateAndDispatchTool`). Their spend DOES fold into the live `cumulativeCostUsd` the
 * tank reads, so once cumulative ≥ ceiling EVERY subsequent admission is denied — i.e.
 * the tank hard-bounds the session ACROSS SEQUENTIAL admissions. But a SINGLE
 * simultaneous wide batch admits all its nodes before any completes, so that one batch
 * can overshoot the ceiling by up to its subtrees' cost. Net: this converts UNBOUNDED
 * bill-shock into "~ceiling + at most one in-flight batch", a large mitigation — NOT a
 * perfect per-dollar ceiling. `maxBudgetUsd` (the cooperative per-turn cap, $10 default)
 * remains the in-turn backstop; gating the recursive/`children[]` path (and reserving
 * inclusive subtree cost) is the deferred follow-up that closes the residual overshoot.
 *
 * SINGLE SOURCE OF TRUTH (design §6.3 — "do not fork a second SOT that drifts"). The
 * tank does NOT keep its own spend counter. It owns ONLY the outstanding (in-flight)
 * reserves; actual spend is read LIVE from the loop's `getCumulativeCostUsd()` (the
 * same value `turn_end.billing.cumulativeCostUsd` reports). `release()` frees a
 * reserve on success or abort — the node's real cost is already in the live cumulative
 * via the unchanged `addCostUsd` sink, so the tank never records spend and can never
 * drift. The tank GATES dispatch; it does not bill. `parentOwn + Σchild === turnDelta`
 * is untouched.
 *
 * RESERVE + SINGLE DEBIT (design §6.3 / AC-W2). The per-node reserve (`nodeReserveUsd`)
 * is a REALISTIC estimate of one node's first model round — NOT its recursive subtree
 * (no static number can bound depth-7; see "WHAT THIS BOUNDS" above). Its only job is to
 * bound the IN-FLIGHT overshoot of simultaneously-admitted nodes; the live-cumulative
 * read does the rest. On completion the caller RELEASES the reserve; the ONE actual cost
 * is applied via the existing sink — never both. The abort/timeout path (1b) also calls
 * `release()`, so a hung node frees its reserve AND its slot and cannot deadlock the tank
 * on fuel that never settles.
 *
 * LOCK ORDER (design §6.3 deadlock-safety): GLOBAL admission → SESSION tank →
 * WORKFLOW pool (getSubagentPool) → NODE slot. The Global Admission semaphore is a
 * blocking concurrency gate, so to stay deadlock-free it is acquired ONLY at the
 * top-level `:turnbatch` main-loop dispatch (which `subagent-runner` never
 * re-acquires) — NOT inside the recursive `children[]`/subagent path, where a
 * slot-holding parent waiting on its own child's slot would self-deadlock. The fuel
 * tank, by contrast, is a NON-blocking synchronous check (never queues), so it is
 * debited at every admission site without any deadlock risk.
 */
import { Semaphore, type SubagentPool } from './subagent-pool.js';
import { rateForReserve } from './native-pricing.js';

/** An opaque headroom reservation handed back by `tryReserve`. */
export interface FuelReservation {
  /** The USD ceiling this reservation holds against the tank. */
  readonly reserveUsd: number;
  /** Set once on release so a double-release never drives outstanding negative. */
  released: boolean;
}

/**
 * A single session/task USD fuel tank. Owns only the OUTSTANDING (in-flight) reserves;
 * actual spend is always supplied live by the caller (`getCumulativeCostUsd()`), never
 * forked into the tank. Admits a node only when its reserve fits under the ceiling
 * given live spend + outstanding reserves.
 *
 * All mutation is SYNCHRONOUS (no `await` between the admission check and the
 * `outstanding` write), so concurrent admissions on the single-threaded event loop
 * cannot interleave to over-admit — the same atomicity discipline the cost accumulator
 * relies on (native-harness.ts addCostUsd `+=`).
 */
export class SessionFuelTank {
  private outstandingUsd = 0;

  constructor(
    /** The hard USD ceiling for this session/task. */
    readonly ceilingUsd: number,
  ) {}

  /** USD headroom left given the caller's LIVE cumulative spend. */
  remaining(spentUsd: number): number {
    return this.ceilingUsd - spentUsd - this.outstandingUsd;
  }

  /** Sum of in-flight reserves (test/observability). */
  get outstanding(): number {
    return this.outstandingUsd;
  }

  /**
   * Reserve `reserveUsd` of headroom for a node about to dispatch, given the LIVE
   * cumulative spend. Returns a handle when the reserve fits under the ceiling, else
   * `null` (admission DENIED — the caller skips the node and returns partial results +
   * a `dropped[]` note). A zero/negative reserve (a non-model node) always admits, even
   * on an exhausted tank — the tank only bounds model spend.
   */
  tryReserve(reserveUsd: number, spentUsd: number): FuelReservation | null {
    const need = reserveUsd > 0 ? reserveUsd : 0;
    if (need > 0 && spentUsd + this.outstandingUsd + need > this.ceilingUsd) return null;
    const r: FuelReservation = { reserveUsd: need, released: false };
    this.outstandingUsd += need;
    return r;
  }

  /**
   * Free a reservation (success OR abort/timeout). Idempotent. The node's real cost is
   * already in the live cumulative via the unchanged `addCostUsd` path, so the tank
   * records no spend here — it only releases the in-flight reserve.
   */
  release(r: FuelReservation): void {
    if (r.released) return;
    r.released = true;
    this.outstandingUsd -= r.reserveUsd;
    // Clamp tiny float drift so remaining() never reports a spurious negative band.
    if (this.outstandingUsd < 0) this.outstandingUsd = 0;
  }
}

/**
 * Per-TASK tank registry, keyed by the per-session/task id (`ctx.taskId`) — the SAME
 * per-session key the `children[]` pool uses (`agent-tool.ts` `rootSessionId = ownerTaskId`),
 * so the whole task tree shares ONE tank and recursion cannot reset the ceiling. It MUST
 * NOT be keyed on the env `SESSION_ID` (once surfaced as `runtimeConfig.sessionId`), which is
 * process-GLOBAL in the multi-session-per-process sandbox and would merge the USD ceiling
 * across parallel tasks (Task B falsely denied because Task A spent). Module-level (never a
 * process-global single tank). NOTE: this is per-PROCESS-RUN — a fresh process (Blaxel
 * recycle / cold resume) starts a fresh tank; it bounds one within-process runaway, not a
 * cross-resume lifetime total. Entries are not evicted (same pattern as `_pools`); a
 * task-completion teardown is a follow-up.
 */
const _tanks = new Map<string, SessionFuelTank>();

/**
 * The tank for `taskId`, creating it (ceiling `ceilingUsd`) on first use. Memoized: a
 * later call for the same task returns the SAME instance and IGNORES `ceilingUsd` (the
 * first caller fixes the ceiling for the whole task tree).
 */
export function getSessionFuelTank(taskId: string, ceilingUsd: number): SessionFuelTank {
  let tank = _tanks.get(taskId);
  if (!tank) {
    tank = new SessionFuelTank(ceilingUsd);
    _tanks.set(taskId, tank);
  }
  return tank;
}

/**
 * P4 Task 2 — the AMBIENT fuel tank for `taskId`: a SECOND tank in the SAME registry
 * under a distinct `${taskId}#ambient` keyspace, so a task's self-initiated (initiative)
 * turns bill against a capped bucket that NEVER collides with the foreground tank. Same
 * memoization + per-process-run lifetime as `getSessionFuelTank`; `disposeTank` drops
 * this key alongside the foreground one.
 */
export function getAmbientFuelTank(taskId: string, ceilingUsd: number): SessionFuelTank {
  return getSessionFuelTank(`${taskId}#ambient`, ceilingUsd);
}

/** Test-only: clear the per-task tank registry between cases. */
export function _resetFuelTanksForTest(): void {
  _tanks.clear();
}

/** P1 dispose — drop a completed task's tank so _tanks can't grow unbounded
 *  ("Entries are not evicted … a task-completion teardown is a follow-up" — this
 *  is that follow-up).
 *
 *  QUIESCENCE GATE (PR-1288 review finding 1): the driver cleanup that calls this
 *  is NOT exclusively terminal — the periodic reaper can evict a native turn that
 *  outlives the 6h protection window while its loop still holds reservations.
 *  Deleting then would orphan those reserves: a concurrent resume mints a FRESH
 *  tank (outstandingUsd=0) and admits blind against the live in-flight work. So:
 *  skip disposal while reserves are outstanding. The rare skipped entry lingers
 *  (the pre-P1 status quo for ALL entries) rather than softening the ceiling. */
export function disposeTank(taskId: string): void {
  disposeTankKey(taskId);
  // P4 Task 2 — the ambient keyspace shares this task's lifetime; drop it too (same
  // quiescence gate, applied independently so an ambient reserve in flight blocks
  // only the ambient key).
  disposeTankKey(`${taskId}#ambient`);
}

function disposeTankKey(key: string): void {
  const t = _tanks.get(key);
  if (t && t.outstanding > 0) return;
  _tanks.delete(key);
}

/** Test-only: current tank keys. */
export function _tankKeysForTest(): string[] {
  return [..._tanks.keys()];
}

/**
 * The process-global admission semaphore. Sized from a global concurrency / rate
 * ceiling, it gates the top-level concurrent `:turnbatch` fan-out ABOVE the per-session
 * pools so no single session can breach the user's aggregate provider rate limits or
 * starve a sibling session. Acquired FIRST in the lock order (global → session →
 * workflow → node) and ONLY at the main-loop dispatch (never re-acquired inside the
 * recursive subagent path — see the deadlock note at the top of this file).
 */
let _globalAdmission: SubagentPool | undefined;

/** The process-global admission semaphore, created (capacity `limit`) on first use
 *  and memoized (the first caller fixes the cap). */
export function getGlobalAdmissionSemaphore(limit: number): SubagentPool {
  if (!_globalAdmission) _globalAdmission = new Semaphore(Math.max(1, Math.floor(limit)));
  return _globalAdmission;
}

/** Test-only: drop the process-global admission semaphore between cases. */
export function _resetGlobalAdmissionForTest(): void {
  _globalAdmission = undefined;
}

/**
 * P2.5 — process-global NON-BLOCKING node counter. Deny-don't-queue (the tank's
 * discipline), so any nesting depth may consult it without deadlock — unlike the
 * blocking admission Semaphore, which stays top-level-only (see the lock-order
 * note at the top of this file). All mutation is synchronous, so concurrent
 * admissions on the single-threaded event loop cannot interleave to over-admit.
 */
export class GlobalNodeCounter {
  private inFlightCount = 0;

  constructor(
    /** The process-wide in-flight node ceiling. */
    readonly limit: number,
  ) {}

  /**
   * Take a slot, or `null` when the counter is at its limit (admission DENIED —
   * the caller skips the node with a dropped note, never queues). The returned
   * release fn is idempotent: a double-release never frees a second slot.
   */
  tryAcquire(): (() => void) | null {
    if (this.inFlightCount >= this.limit) return null;
    this.inFlightCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlightCount -= 1;
    };
  }

  /** Current in-flight slot count (test/observability). */
  get inFlight(): number {
    return this.inFlightCount;
  }
}

let _globalNodeCounter: GlobalNodeCounter | undefined;

/** The process-global node counter, created (ceiling `limit`, floored to ≥1) on
 *  first use and memoized like the admission semaphore (the first caller fixes
 *  the limit; a later different `limit` is ignored). */
export function getGlobalNodeCounter(limit: number): GlobalNodeCounter {
  if (!_globalNodeCounter) _globalNodeCounter = new GlobalNodeCounter(Math.max(1, Math.floor(limit)));
  return _globalNodeCounter;
}

/** Test-only: drop the process-global node counter between cases. */
export function _resetGlobalNodeCounterForTest(): void {
  _globalNodeCounter = undefined;
}

/**
 * `(inputTokens + outputTokens) × the node's per-token rate`, at the FULL (cache-miss)
 * input rate. This is the low-level primitive; callers use `defaultNodeReserveUsd` for
 * the standard per-node estimate. It is an estimate of ONE model round, NOT a node's
 * recursive subtree — see `defaultNodeReserveUsd` and the module header.
 */
export function nodeReserveUsd(model: string, inputTokens: number, outputTokens: number): number {
  const r = rateForReserve(model);
  const inTok = inputTokens > 0 ? inputTokens : 0;
  const outTok = outputTokens > 0 ? outputTokens : 0;
  return (inTok * r.in + outTok * r.out) / 1_000_000;
}

/**
 * The standard per-node admission reserve. Deliberately a REALISTIC estimate of one
 * subagent's FIRST model round — NOT the model's full `maxOutputTokens` ceiling. A typical
 * subagent turn emits a few-k to low-tens-of-k tokens, so reserving the full 128k opus
 * output ($3.20/node) would deny legitimate cheap wide batches far below the USD ceiling.
 * The reserve only bounds the IN-FLIGHT overshoot of simultaneously-admitted nodes; the
 * live-cumulative read bounds the session across sequential admissions, and (per the module
 * header) gating the recursive subtree is the deferred follow-up — so a tight, realistic
 * reserve is the right call here, not the model max. `outputTokens` never exceeds the
 * model's own `maxOutputTokens`.
 */
const FUEL_RESERVE_INPUT_TOKENS = 32_000;
const FUEL_RESERVE_OUTPUT_TOKENS = 16_000;
export function defaultNodeReserveUsd(model: string, modelMaxOutputTokens: number): number {
  const outTok = Math.min(
    FUEL_RESERVE_OUTPUT_TOKENS,
    modelMaxOutputTokens > 0 ? modelMaxOutputTokens : FUEL_RESERVE_OUTPUT_TOKENS,
  );
  return nodeReserveUsd(model, FUEL_RESERVE_INPUT_TOKENS, outTok);
}

/**
 * Run one node under the full admission stack, in lock order
 * (global → tank → pool → node). Returns the node's result when admitted, or
 * `onDenied()` (WITHOUT running the node) when the tank denies the reserve. The
 * reserve is released in `finally`, so it is freed on success, throw, AND abort — no
 * fuel leak. Every argument except `reserveUsd`/`spentUsd`/`run`/`onDenied` is
 * optional, so a caller that wants only a subset of the stack (e.g. the recursive
 * `children[]` path debits the tank but NOT the global semaphore) passes just those.
 */
export async function admitNode<T>(opts: {
  /** Lock 1: the process-global admission semaphore (top-level dispatch only). */
  global?: SubagentPool;
  /** Lock 1.5 (P2.5): the process-global NON-BLOCKING node counter — the global
   *  gate any nesting depth may consult (deny-don't-queue, so no deadlock). A
   *  full counter routes to `onDenied` BEFORE any fuel reserve or pool queueing:
   *  a denied node is dropped, never queued. */
  counter?: GlobalNodeCounter;
  /** Lock 2: the session fuel tank (every admission site). */
  tank?: SessionFuelTank;
  /** Lock 3: the per-session workflow pool (getSubagentPool). */
  pool?: SubagentPool;
  /** This node's true-ceiling reserve (nodeReserveUsd). */
  reserveUsd: number;
  /** Live reader of the root session's cumulative spend (the single SOT). */
  spentUsd: () => number;
  /** The node body (the gated dispatch). */
  run: () => Promise<T>;
  /** Produce the skip result when the counter or tank denies admission (partial + dropped note). */
  onDenied: () => T;
}): Promise<T> {
  const { global, counter, tank, pool, reserveUsd, spentUsd, run, onDenied } = opts;
  const body = async (): Promise<T> => {
    // Lock 1.5: the non-blocking global node counter. Synchronous → atomic; the
    // slot is held across pool queueing + the run so `inFlight` bounds admitted
    // (not merely running) nodes, and released in `finally` — no slot leak on
    // throw or abort.
    const slot = counter ? counter.tryAcquire() : null;
    if (counter && slot === null) return onDenied();
    try {
      // Lock 2: reserve against the tank using the LIVE spend (reflects nodes that
      // settled while this one queued on the global semaphore). Synchronous → atomic.
      const handle = tank ? tank.tryReserve(reserveUsd, spentUsd()) : null;
      if (tank && handle === null) return onDenied();
      try {
        // Lock 3: the workflow pool (bounded concurrency), then the node.
        return pool ? await pool.run(run) : await run();
      } finally {
        if (handle) tank!.release(handle);
      }
    } finally {
      slot?.();
    }
  };
  // Lock 1: the global admission semaphore (outermost).
  return global ? global.run(body) : body();
}
