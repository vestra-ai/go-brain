/**
 * Phase 1a — The Floor: Session Fuel Tank + Global Admission semaphore + the
 * lock-ordered `admitNode` admission wrapper.
 *
 * The fuel tank is a per-session/task USD ceiling that EVERY subagent node debits
 * at admission, across all pools (:turnbatch, children[], future :weave:*). It is
 * the HARD version of the cooperative `fanOutChildren` budget gate (subagent-pool.ts):
 * the cooperative gate re-reads cumulative cost before each child (overshoot bounded
 * by concurrency); the tank RESERVES a node's true ceiling BEFORE dispatch so
 * concurrent in-flight nodes cannot overshoot the ceiling at all.
 *
 * SINGLE SOURCE OF TRUTH (design §6.3): the tank does NOT fork a second spend
 * counter. It owns ONLY the outstanding (in-flight) reserves; actual spend is always
 * read LIVE from the loop's `getCumulativeCostUsd()` (the same value `turn_end.billing`
 * reports). `release()` frees a reserve on success or abort — the node's real cost is
 * already in the live cumulative via the unchanged `addCostUsd` sink, so the tank
 * never records spend and can never drift. The tank GATES dispatch; it does not bill.
 */
import { describe, it, expect } from 'vitest';
import {
  SessionFuelTank,
  getSessionFuelTank,
  _resetFuelTanksForTest,
  getGlobalAdmissionSemaphore,
  _resetGlobalAdmissionForTest,
  nodeReserveUsd,
  defaultNodeReserveUsd,
  admitNode,
  getAmbientFuelTank,
  disposeTank,
  _tankKeysForTest,
} from '../fuel-tank.js';
import { Semaphore } from '../subagent-pool.js';

describe('SessionFuelTank — hard USD admission ceiling (single SOT)', () => {
  it('reserves headroom up to the ceiling and denies admission beyond it', () => {
    const tank = new SessionFuelTank(1.0); // $1.00 ceiling
    const spent = 0;
    const a = tank.tryReserve(0.4, spent);
    const b = tank.tryReserve(0.4, spent);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // 0.4 + 0.4 = 0.8 outstanding; a third 0.4 would reach 1.2 > 1.0 → DENIED.
    expect(tank.tryReserve(0.4, spent)).toBeNull();
    expect(tank.remaining(spent)).toBeCloseTo(0.2, 6);
  });

  it('reads ACTUAL spend live (a cheap completed node restores headroom)', () => {
    const tank = new SessionFuelTank(1.0);
    const a = tank.tryReserve(0.6, 0)!; // reserve $0.60 against $0 spent
    expect(tank.remaining(0)).toBeCloseTo(0.4, 6);
    // The node completed having cost only $0.10 (folded into the live cumulative) and the
    // reserve is released. remaining now reads the LIVE spent ($0.10), not the reserve.
    tank.release(a);
    expect(tank.remaining(0.1)).toBeCloseTo(0.9, 6);
  });

  it('counts OUTSTANDING reserves against remaining (prevents in-flight overshoot)', () => {
    const tank = new SessionFuelTank(1.0);
    // 3 nodes admitted, each reserving 0.3, NOTHING actually spent yet.
    const r = [tank.tryReserve(0.3, 0), tank.tryReserve(0.3, 0), tank.tryReserve(0.3, 0)];
    expect(r.every((x) => x !== null)).toBe(true);
    // 0.9 outstanding; a 4th 0.3-node is denied even at $0 actual spend — the reserves
    // bound the worst-case in-flight cost so the ceiling can never be overshot.
    expect(tank.tryReserve(0.3, 0)).toBeNull();
    expect(tank.remaining(0)).toBeCloseTo(0.1, 6);
  });

  it('release frees a reserve and is idempotent (success and abort share the path)', () => {
    const tank = new SessionFuelTank(1.0);
    const a = tank.tryReserve(0.7, 0)!;
    expect(tank.remaining(0)).toBeCloseTo(0.3, 6);
    tank.release(a);
    tank.release(a); // second release is a no-op (no negative outstanding)
    expect(tank.remaining(0)).toBeCloseTo(1.0, 6);
  });

  it('combines live spend AND outstanding reserves in the admission decision', () => {
    const tank = new SessionFuelTank(1.0);
    const a = tank.tryReserve(0.3, 0)!; // 0.3 outstanding
    // Now 0.5 has actually been spent (folded into cumulative); 0.3 still outstanding.
    // remaining = 1.0 - 0.5 - 0.3 = 0.2. A 0.25 node is denied; a 0.15 node admits.
    expect(tank.remaining(0.5)).toBeCloseTo(0.2, 6);
    expect(tank.tryReserve(0.25, 0.5)).toBeNull();
    expect(tank.tryReserve(0.15, 0.5)).not.toBeNull();
    tank.release(a);
  });

  it('a zero/negative reserve always admits (a non-model node never blocks)', () => {
    const tank = new SessionFuelTank(0.0); // exhausted ceiling
    expect(tank.tryReserve(0, 5.0)).not.toBeNull(); // reserve 0 against overspent → still admits
  });
});

describe('SessionFuelTank — synchronous atomicity (no over-admission under concurrency)', () => {
  it('N concurrent reservations against the SAME live spend never exceed the ceiling', async () => {
    const tank = new SessionFuelTank(1.0);
    // 100 concurrent admission attempts, each reserving 0.1 against $0 spent. The ceiling
    // is 1.0 so at most 10 may be admitted. tryReserve is a single synchronous
    // read-modify-write of `outstanding`, so JS's single-threaded model guarantees no two
    // interleave to over-admit.
    const admitted = await Promise.all(
      Array.from({ length: 100 }, () => Promise.resolve().then(() => tank.tryReserve(0.1, 0))),
    );
    expect(admitted.filter((x) => x !== null).length).toBe(10);
    expect(tank.remaining(0)).toBeCloseTo(0, 6);
  });
});

describe('getSessionFuelTank — per-root memoization (matches getSubagentPool discipline)', () => {
  it('returns the SAME tank for one root and DISTINCT tanks for distinct roots', () => {
    _resetFuelTanksForTest();
    const a1 = getSessionFuelTank('session-A', 5.0);
    const a2 = getSessionFuelTank('session-A', 999.0); // ceiling ignored after first create
    const b1 = getSessionFuelTank('session-B', 5.0);
    expect(a1).toBe(a2);
    expect(a1.ceilingUsd).toBe(5.0); // first caller fixes the ceiling for the whole tree
    expect(a1).not.toBe(b1);
  });
});

describe('getAmbientFuelTank + disposeTank — the P4 ambient keyspace (Task 2)', () => {
  it('keys the ambient tank under `${taskId}#ambient`, distinct from the foreground tank', () => {
    _resetFuelTanksForTest();
    const fg = getSessionFuelTank('task-1', 50);
    const amb = getAmbientFuelTank('task-1', 5);
    expect(amb).not.toBe(fg);
    expect(amb.ceilingUsd).toBe(5);
    expect(_tankKeysForTest().sort()).toEqual(['task-1', 'task-1#ambient']);
  });

  it('disposeTank drops BOTH the foreground and the #ambient key for the task', () => {
    _resetFuelTanksForTest();
    getSessionFuelTank('task-1', 50);
    getAmbientFuelTank('task-1', 5);
    getSessionFuelTank('task-2', 50); // a sibling task must survive
    disposeTank('task-1');
    expect(_tankKeysForTest()).toEqual(['task-2']);
  });

  it('respects the quiescence gate PER key — a key with an outstanding reserve is not dropped', () => {
    _resetFuelTanksForTest();
    getSessionFuelTank('task-1', 50);
    const amb = getAmbientFuelTank('task-1', 5);
    amb.tryReserve(1, 0); // hold an ambient reserve in flight
    disposeTank('task-1');
    // Foreground key dropped; the #ambient key lingers because a reserve is outstanding.
    expect(_tankKeysForTest()).toEqual(['task-1#ambient']);
  });
});

describe('nodeReserveUsd — the true-ceiling per-node reserve', () => {
  it('computes (input + enforced max_output) × per-token rate for the node model', () => {
    // opus rate = $5/Mtok in, $25/Mtok out. 10k input + 16k enforced max_output:
    // (10_000 * 5 + 16_000 * 25) / 1e6 = (50_000 + 400_000) / 1e6 = $0.45.
    expect(nodeReserveUsd('claude-opus-4-8', 10_000, 16_000)).toBeCloseTo(0.45, 6);
    // sonnet rate = $3/$15. Same tokens: (10_000*3 + 16_000*15)/1e6 = 0.03 + 0.24 = $0.27.
    expect(nodeReserveUsd('claude-sonnet-4-6', 10_000, 16_000)).toBeCloseTo(0.27, 6);
  });

  it('uses the FULL (cache-miss) input rate so the reserve is a conservative upper bound', () => {
    // A real run may hit the prompt cache (cheaper) — the reserve must NOT assume that or
    // it would under-reserve. opus full input rate is $5/Mtok (not the $0.5 cache-read).
    expect(nodeReserveUsd('claude-opus-4-8', 1_000_000, 0)).toBeCloseTo(5.0, 6);
  });

  it('a zero-token reserve is zero (a non-model node reserves nothing)', () => {
    expect(nodeReserveUsd('claude-opus-4-8', 0, 0)).toBe(0);
  });

  it('an unknown model family fails closed to a non-zero (Sonnet-tier) reserve, never free', () => {
    const r = nodeReserveUsd('some-unpriced-model', 10_000, 16_000);
    expect(r).toBeGreaterThan(0);
  });

  it('defaultNodeReserveUsd uses a REALISTIC output bound (16k), not the model max', () => {
    // opus max output is 128k, but the default reserve uses min(16k, max) so a cheap wide
    // batch is not denied far below the ceiling: (32k×5 + 16k×25)/1e6 = 0.16 + 0.40 = $0.56.
    expect(defaultNodeReserveUsd('claude-opus-4-8', 128_000)).toBeCloseTo(0.56, 6);
    // a model whose own max is BELOW 16k caps the output term at that max (never above it).
    expect(defaultNodeReserveUsd('claude-opus-4-8', 8_000)).toBeCloseTo((32_000 * 5 + 8_000 * 25) / 1e6, 6);
  });
});

describe('getGlobalAdmissionSemaphore — process-global concurrency ceiling', () => {
  it('is a single process-global instance (every leaf dispatch shares it)', () => {
    _resetGlobalAdmissionForTest();
    const s1 = getGlobalAdmissionSemaphore(8);
    const s2 = getGlobalAdmissionSemaphore(999); // limit ignored after first create
    expect(s1).toBe(s2);
  });

  it('bounds global concurrency across sessions (no cross-session starvation breach)', async () => {
    _resetGlobalAdmissionForTest();
    const sem = getGlobalAdmissionSemaphore(3);
    let active = 0;
    let peak = 0;
    const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const job = (): Promise<void> =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await tick(5);
        active--;
      });
    await Promise.all(Array.from({ length: 12 }, () => job()));
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe('admitNode — lock-ordered admission (global → tank → pool → node)', () => {
  it('admits and runs a node when the tank has headroom, releasing the reserve after', async () => {
    const tank = new SessionFuelTank(1.0);
    let ran = false;
    const result = await admitNode({
      tank,
      reserveUsd: 0.5,
      spentUsd: () => 0,
      run: async () => {
        ran = true;
        return 'ok';
      },
      onDenied: () => 'denied',
    });
    expect(ran).toBe(true);
    expect(result).toBe('ok');
    // reserve released after the run → full headroom restored at $0 spent.
    expect(tank.remaining(0)).toBeCloseTo(1.0, 6);
  });

  it('returns onDenied WITHOUT running the node when the tank is exhausted', async () => {
    const tank = new SessionFuelTank(0.5);
    let ran = false;
    const result = await admitNode({
      tank,
      reserveUsd: 0.6, // exceeds the $0.50 ceiling
      spentUsd: () => 0,
      run: async () => {
        ran = true;
        return 'ok';
      },
      onDenied: () => 'fuel-exhausted',
    });
    expect(ran).toBe(false);
    expect(result).toBe('fuel-exhausted');
  });

  it('releases the reserve even when the node throws (no fuel leak on abort)', async () => {
    const tank = new SessionFuelTank(1.0);
    await expect(
      admitNode({
        tank,
        reserveUsd: 0.5,
        spentUsd: () => 0,
        run: async () => {
          throw new Error('node blew up');
        },
        onDenied: () => 'denied',
      }),
    ).rejects.toThrow('node blew up');
    // The reserve was freed in finally → no leak.
    expect(tank.remaining(0)).toBeCloseTo(1.0, 6);
  });

  it('respects the workflow pool concurrency bound (lock order tank → pool)', async () => {
    const tank = new SessionFuelTank(100); // never the limiter here
    const pool = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const one = (): Promise<string> =>
      admitNode({
        tank,
        pool,
        reserveUsd: 0.1,
        spentUsd: () => 0,
        run: async () => {
          active++;
          peak = Math.max(peak, active);
          await tick(5);
          active--;
          return 'ok';
        },
        onDenied: () => 'denied',
      });
    await Promise.all([one(), one(), one(), one(), one()]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('with no tank/pool/global supplied, just runs the node (back-compat no-op gate)', async () => {
    const result = await admitNode({
      reserveUsd: 0.5,
      spentUsd: () => 0,
      run: async () => 'ran',
      onDenied: () => 'denied',
    });
    expect(result).toBe('ran');
  });

  it('a fully-reserved tank stops scheduling under real concurrency and returns partials', async () => {
    // The end-to-end prod-gate property: dispatch 8 nodes each reserving $0.30 against a
    // $1.00 tank with $0 live spend. At most 3 fit (3×0.3=0.9 ≤ 1.0); the rest are denied
    // and return their partial/skip note — never spawned.
    const tank = new SessionFuelTank(1.0);
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        admitNode({
          tank,
          reserveUsd: 0.3,
          spentUsd: () => 0,
          run: async () => `ran-${i}`,
          onDenied: () => `skip-${i}`,
        }),
      ),
    );
    const ran = outcomes.filter((o) => o.startsWith('ran-')).length;
    const skipped = outcomes.filter((o) => o.startsWith('skip-')).length;
    expect(ran).toBe(3);
    expect(skipped).toBe(5);
  });
});
