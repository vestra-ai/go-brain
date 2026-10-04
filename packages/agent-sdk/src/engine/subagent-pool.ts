/**
 * Per-session subagent concurrency pool (root-keyed) + the cooperative budget
 * gate that bounds the Agent-v2 `children[]` fan-out (Task 9).
 *
 * WHY ROOT-KEYED (finding 7): recursion (Task 11) re-admits the Agent tool for
 * orchestrators. If every node keyed its pool by its OWN child-scoped id
 * (`tu-1:0`), each node would get a fresh `limit` and total concurrency would
 * blow up to ~`limit^depth`, silently defeating the cap. The pool is therefore
 * memoized by the STABLE ROOT session id (`process.env.SESSION_ID` / the
 * top-level `ownerTaskId`), threaded UNCHANGED through every recursion level, so
 * the WHOLE session tree shares ONE semaphore. The module-level `_pools` Map IS
 * the per-session discipline (one entry per root, never a process-global single
 * pool that would cross-contaminate parallel sessions).
 *
 * WHY A COOPERATIVE BUDGET GATE (finding 6): `maxBudgetUsd` is only enforced at
 * the turn boundary (native-harness budget gate). Concurrent fan-out can spend
 * past the cap before the turn-boundary gate trips, by up to ~`concurrency`. The
 * fan-out re-checks the LIVE cumulative cost before scheduling each child and
 * skips the rest once the cap is reached — a best-effort cap whose overshoot is
 * bounded by the concurrency limit (exact at limit 1).
 */
import type { SubagentAllowKind, SubagentRefusalKind } from './subagent-walls.js';

/** A bounded-concurrency runner. At most `limit` `run` callbacks execute at once. */
export interface SubagentPool {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/** A counting semaphore: runs up to `limit` callbacks, queues the rest FIFO.
 *  Exported so the Phase-1a global admission gate (fuel-tank.ts) reuses the SAME
 *  bounded-concurrency primitive instead of duplicating it. */
export class Semaphore implements SubagentPool {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  /** True while any holder is running or queued (the P1 dispose quiescence gate). */
  get busy(): boolean {
    return this.active > 0 || this.queue.length > 0;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const exec = (): void => {
        this.active += 1;
        // Defer fn() to a microtask so a synchronous throw still rejects (not
        // throw) and the active-count bookkeeping is symmetric with the release.
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1;
            const next = this.queue.shift();
            if (next) next();
          });
      };
      if (this.active < this.limit) exec();
      else this.queue.push(exec);
    });
  }
}

/**
 * Per-root pool registry. Keyed by ROOT session id so the same root ALWAYS
 * returns the SAME instance (memoized) — distinct roots get distinct pools.
 * Module-level (never global single-pool) = the per-session-tree cap.
 */
const _pools = new Map<string, SubagentPool>();

/**
 * The pool for `rootSessionId`, creating it (capacity `limit`) on first use.
 * Memoized: a later call for the same root returns the SAME instance and IGNORES
 * `limit` (the first caller — the root — fixes the cap for the whole tree).
 */
export function getSubagentPool(rootSessionId: string, limit: number): SubagentPool {
  let pool = _pools.get(rootSessionId);
  if (!pool) {
    pool = new Semaphore(Math.max(1, Math.floor(limit)));
    _pools.set(rootSessionId, pool);
  }
  return pool;
}

/** Is a holder running or queued in the pool under `key` right now? False for a key never used. */
export function poolBusy(key: string): boolean {
  const pool = _pools.get(key);
  return pool instanceof Semaphore && pool.busy;
}

/** P1 dispose — drop every pool owned by `taskId` (exact key or `taskId:`-prefixed:
 *  `:turnbatch`, `:weave:<id>`, children[] pools). A dropped idle Semaphore holds
 *  no timers/handles, so deletion is free.
 *
 *  QUIESCENCE GATE (PR-1288 review finding 1): a BUSY pool is skipped — deleting
 *  it while holders run would let a concurrent resume mint a fresh Semaphore for
 *  the same key and double the effective concurrency. The skipped entry lingers
 *  (pre-P1 status quo) instead. The walls' tree-admission gate (below) is swept by
 *  the SAME prefix rule and the SAME quiescence gate: dropping a gate that still
 *  has children running would mint a fresh 20 slots on top of the ones in flight. */
export function disposePoolsFor(taskId: string): void {
  const prefix = `${taskId}:`;
  for (const key of [..._pools.keys()]) {
    if (key !== taskId && !key.startsWith(prefix)) continue;
    const pool = _pools.get(key);
    if (pool instanceof Semaphore && pool.busy) continue;
    _pools.delete(key);
  }
  let gateBusy = false;
  for (const key of [..._gates.keys()]) {
    if (key !== taskId && !key.startsWith(prefix)) continue;
    if (_gates.get(key)?.busy === true) {
      gateBusy = true;
      continue;
    }
    _gates.delete(key);
  }
  // Counters hold no slots, so they go with the task — but NOT while children are still
  // running under it. dispose.ts warns in as many words that this path is not terminal
  // (idle eviction, orphan sweep, rewind, strand repair, the 6h reaper), and zeroing a
  // tree that is still spawning would silently undercount it. Nothing gates on these, so
  // the cost of keeping them one sweep longer is a Map entry.
  if (!gateBusy) _stats.delete(taskId);
}

/** Test-only: current pool and gate keys. */
export function _poolKeysForTest(): string[] {
  return [..._pools.keys(), ..._gates.keys()];
}

/** Test-only: clear the per-root pool, gate and stats registries between cases. */
export function _resetPoolsForTest(): void {
  _pools.clear();
  _gates.clear();
  _stats.clear();
}

/** The outcome of running one child (the subset the fan-out gate needs). */
export interface ChildOutcome {
  text: string;
  /** The child paused for human-in-the-loop — stop scheduling further children. */
  pausedHalt: boolean;
}

export interface FanOutOptions<S> {
  /**
   * Bounds concurrency for the whole session tree. Omit → SEQUENTIAL (effective
   * limit 1): each child's gate sees the prior child's settled cost, so the
   * budget cap is exact. With a pool of limit > 1 the gate is cooperative
   * (overshoot bounded by the limit).
   */
  pool?: SubagentPool;
  /** Cooperative budget cap (USD). Omit → no cap. */
  maxBudgetUsd?: number;
  /** Live reader of cumulative session cost (USD), checked before each child. */
  getCumulativeCostUsd?: () => number;
  /** Run one child. Omit → a no-op completion (scheduling-only tests). */
  runChild?: (spec: S, index: number) => Promise<ChildOutcome>;
  /** Observe each child actually scheduled (post-gate, pre-run). */
  onLaunch?: (index: number) => void;
  /** Text returned for a child the budget gate skipped. */
  budgetNote?: (spec: S, index: number) => string;
  /** Text for a child the TURN-CEILING gate skipped. Omit ⇒ the legacy note. A callback,
   *  symmetric with `budgetNote`, so the caller can COUNT the skip as it words it — the
   *  walls read one voice at both money gates and tally both. */
  ceilingNote?: (spec: S, index: number) => string;
  /**
   * The parent turn's PER-TURN spend ceiling (live-spend.ts `turnSpendCeilingReached`).
   * True ⇒ no FURTHER child is launched. Separate from `maxBudgetUsd`: that one asks
   * whether the task is out of money, this one whether THIS TURN ran away — a
   * fan-out is exactly how the 2026-08-24 burn outran the turn-boundary gate.
   * Omit ⇒ no ceiling gate ⇒ byte-identical.
   */
  turnSpendExceeded?: () => boolean;
}

const DEFAULT_BUDGET_NOTE = 'Skipped: subagent budget (maxBudgetUsd) reached before launch.';
const TURN_CEILING_NOTE = 'Skipped: turn spend ceiling reached.';

/**
 * Fan out `specs` under `pool`, applying three cooperative gates BEFORE scheduling
 * each child:
 *  - PAUSE: once any child returns `pausedHalt`, no further children launch
 *    (preserves Task 8's ≤1-in-flight-HITL-pause rule — already-running children
 *    settle, but none new are scheduled). Pause-skipped children return empty
 *    text (the caller drops them, matching the sequential break).
 *  - BUDGET: once `getCumulativeCostUsd() >= maxBudgetUsd`, the remaining
 *    children are skipped with a `budgetNote` instead of being spawned.
 *  - TURN CEILING: once `turnSpendExceeded()` is true, likewise — the per-turn
 *    ceiling, which reads live spend rather than settled cost.
 *
 * Returns one `ChildOutcome` per spec (index-aligned). Concurrency is bounded by
 * the pool; with no pool the run is sequential.
 */
export async function fanOutChildren<S>(specs: S[], opts: FanOutOptions<S>): Promise<ChildOutcome[]> {
  const { pool, maxBudgetUsd, getCumulativeCostUsd, runChild, onLaunch, budgetNote, ceilingNote, turnSpendExceeded } =
    opts;
  const results: ChildOutcome[] = new Array(specs.length);
  let paused = false;
  let budgetExhausted = false;

  const overBudget = (): boolean =>
    maxBudgetUsd !== undefined && (getCumulativeCostUsd?.() ?? 0) >= maxBudgetUsd;

  // The gated body for child `i`. Re-checks both gates at the moment a slot opens
  // (so children queued behind the cap are skipped once a sibling pauses or the
  // budget trips) and writes `results[i]`.
  const schedule = async (spec: S, i: number): Promise<void> => {
    if (paused) {
      results[i] = { text: '', pausedHalt: false };
      return;
    }
    if (budgetExhausted || overBudget()) {
      budgetExhausted = true;
      results[i] = { text: budgetNote ? budgetNote(spec, i) : DEFAULT_BUDGET_NOTE, pausedHalt: false };
      return;
    }
    // TURN CEILING: re-read live (the predicate is monotonic within a turn, so no
    // latch is needed — a sibling that pushed the turn over the line is visible to
    // every child still queued behind it).
    if (turnSpendExceeded?.() === true) {
      results[i] = { text: ceilingNote ? ceilingNote(spec, i) : TURN_CEILING_NOTE, pausedHalt: false };
      return;
    }
    onLaunch?.(i);
    const r = (await runChild?.(spec, i)) ?? { text: '', pausedHalt: false };
    results[i] = r;
    if (r.pausedHalt) paused = true;
  };

  if (pool) {
    await Promise.all(specs.map((spec, i) => pool.run(() => schedule(spec, i))));
  } else {
    for (let i = 0; i < specs.length; i++) {
      await schedule(specs[i], i);
    }
  }
  return results;
}

/**
 * Orchestration walls (spec D4): the TREE-WIDE admission gate. A counting gate that
 * hands out a slot or says no — it never queues. A parent waiting on children holds
 * nothing here (the Agent tool acquires per CHILD), so the deadlock that forced
 * "nested batches never concurrent" cannot form: a child either runs now or is told
 * to do the work itself. Keyed by the root task, so every depth shares one cap.
 */
export interface TreeAdmission {
  /** A release function, or null when the tree is full. Never waits. */
  tryAcquire(): (() => void) | null;
  readonly running: number;
}

class CountingGate implements TreeAdmission {
  private active = 0;
  constructor(private readonly limit: number) {}
  get running(): number {
    return this.active;
  }
  /** Mirrors Semaphore.busy — the dispose quiescence gate reads both the same way. */
  get busy(): boolean {
    return this.active > 0;
  }
  tryAcquire(): (() => void) | null {
    if (this.active >= this.limit) return null;
    this.active += 1;
    // Latched: a caller that releases twice (a retry, a finally after an early
    // return) must not hand the tree a slot nobody is holding.
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}

/** Gate registry, keyed `${root}:tree` so the ONE `taskId:`-prefix dispose rule that
 *  already sweeps `:turnbatch` / `:weave:<id>` pools sweeps these too. */
const _gates = new Map<string, CountingGate>();

/**
 * The tree-wide gate for `rootTaskId`, creating it (capacity `limit`) on first use.
 * Memoized exactly like `getSubagentPool`: a later call for the same root returns the
 * SAME gate and IGNORES `limit`, so no depth can mint itself a fresh cap.
 */
export function getTreeAdmission(rootTaskId: string, limit: number): TreeAdmission {
  const key = `${rootTaskId}:tree`;
  let gate = _gates.get(key);
  if (!gate) {
    gate = new CountingGate(Math.max(1, Math.floor(limit)));
    _gates.set(key, gate);
  }
  return gate;
}

/**
 * What one task tree did under the walls. Counters only — nothing here gates
 * anything, so a missed increment costs a report line, never a spawn.
 */
export interface TreeStats {
  spawned: number;
  maxDepth: number;
  spawnedBySubagents: number;
  /** Every wall the runtime can refuse at, so `refused[kind] += 1` is total. */
  refused: Record<SubagentRefusalKind, number>;
  /**
   * Follow-up C — the root wall's ALLOW readings: a lone spawn that declared a dependency,
   * and one waved through past the turn's refusal cap. A SEPARATE record from `refused`
   * because the server sums that one whole into `agent_turns.spawn_refused`, and a spawn
   * the wall let through is not one it stopped.
   */
  allowed: Record<SubagentAllowKind, number>;
  stopped: Record<'user' | 'parent' | 'turn_cap', number>;
  /**
   * Phase 3 (spec 2026-09-05-orchestration-teamwork §4.9) — what the TEAM did this turn,
   * beside what the walls did. Six flat counters rather than a record, because they are
   * not one taxonomy: they are six different events, and the server sums `refused` whole
   * (a message is not a refusal, and a refused hop is not a refused spawn).
   *
   *   · `messagesSent`  — SendMessage deliveries that LANDED, from any actor in the tree.
   *   · `hopRefusals`   — sends the hop cap or the per-turn cap refused (§4.5).
   *   · `leadStops`     — StopHelper calls the seam actually stopped (a live actor: the
   *                       verb stops a teammate with the same word, and both are the lead's).
   *   · `resumes`       — messages that woke a FINISHED helper into a new turn (§4.4).
   *   · `boardClaims`   — items a helper took off the lead's plan and now holds (§4.7).
   *   · `boardDones`    — items a helper marked finished on it.
   *
   * Written only under the team surface (HELPER_TEAMWORK_V1): flag off they stay at zero,
   * so the record and the log line read exactly as they did before it existed.
   */
  messagesSent: number;
  hopRefusals: number;
  leadStops: number;
  resumes: number;
  boardClaims: number;
  boardDones: number;
}

const emptyStats = (): TreeStats => ({
  spawned: 0,
  maxDepth: 0,
  spawnedBySubagents: 0,
  refused: { depth: 0, leaf: 0, lone_child: 0, concurrency: 0, budget: 0, serial_root: 0 },
  allowed: { serial_root_dependent: 0, serial_root_allowed: 0 },
  stopped: { user: 0, parent: 0, turn_cap: 0 },
  messagesSent: 0,
  hopRefusals: 0,
  leadStops: 0,
  resumes: 0,
  boardClaims: 0,
  boardDones: 0,
});

const _stats = new Map<string, TreeStats>();

/** The mutable stats record for `rootTaskId`, created on first use. */
export function treeStats(rootTaskId: string): TreeStats {
  let s = _stats.get(rootTaskId);
  if (!s) {
    s = emptyStats();
    _stats.set(rootTaskId, s);
  }
  return s;
}

export function resetTreeStats(rootTaskId: string): void {
  _stats.delete(rootTaskId);
}
