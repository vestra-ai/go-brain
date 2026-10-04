import { describe, it, expect, beforeEach } from 'vitest';
import { getSessionFuelTank, _resetFuelTanksForTest, _tankKeysForTest, getGlobalAdmissionSemaphore, _resetGlobalAdmissionForTest } from '../fuel-tank.js';
import { getSubagentPool, _poolKeysForTest, _resetPoolsForTest } from '../subagent-pool.js';
import { disposeTaskResources } from '../dispose.js';

describe('disposeTaskResources', () => {
  beforeEach(() => { _resetFuelTanksForTest(); _resetPoolsForTest(); _resetGlobalAdmissionForTest(); });

  it('drops the task tank + every task-prefixed pool, leaves other tasks intact', () => {
    getSessionFuelTank('task-A', 50); getSessionFuelTank('task-B', 50);
    getSubagentPool('task-A:turnbatch', 12); getSubagentPool('task-A:weave:w1', 4);
    getSubagentPool('task-A', 8); getSubagentPool('task-B:turnbatch', 12);
    disposeTaskResources('task-A');
    expect(_tankKeysForTest()).toEqual(['task-B']);
    expect(_poolKeysForTest()).toEqual(['task-B:turnbatch']);
  });

  it('never touches the process-global admission semaphore', () => {
    const g = getGlobalAdmissionSemaphore(10);
    getSessionFuelTank('task-A', 50);
    disposeTaskResources('task-A');
    expect(getGlobalAdmissionSemaphore(10)).toBe(g); // same memoized instance
  });

  it('does not prefix-match sibling tasks sharing a prefix string', () => {
    getSessionFuelTank('task-A', 50); getSessionFuelTank('task-AB', 50);
    getSubagentPool('task-AB:turnbatch', 12);
    disposeTaskResources('task-A');
    expect(_tankKeysForTest()).toEqual(['task-AB']);
    expect(_poolKeysForTest()).toEqual(['task-AB:turnbatch']);
  });

  // PR-1288 review finding 1/2 — the mid-flight reap hazard: dispose must NOT
  // delete a tank holding outstanding reserves (a concurrent resume would mint a
  // fresh tank with outstandingUsd=0 and admit blind against live work).
  it('skips a tank with outstanding reserves; disposes once quiescent', () => {
    const tank = getSessionFuelTank('task-A', 50);
    const r = tank.tryReserve(1, 0);
    expect(r).not.toBeNull();
    disposeTaskResources('task-A');
    expect(_tankKeysForTest()).toEqual(['task-A']); // skipped — reserve in flight
    tank.release(r!);
    disposeTaskResources('task-A');
    expect(_tankKeysForTest()).toEqual([]); // quiescent — disposed
  });

  it('skips a BUSY pool (in-flight holder) and still disposes idle siblings', async () => {
    const pool = getSubagentPool('task-A:turnbatch', 1);
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const running = pool.run(() => gate);
    getSubagentPool('task-A:weave:w1', 4); // idle sibling of the same task
    disposeTaskResources('task-A');
    expect(_poolKeysForTest()).toEqual(['task-A:turnbatch']); // busy kept, idle gone
    release();
    await running;
    // Semaphore.run decrements `active` in a .finally chained AFTER the promise
    // the caller awaits — flush one macrotask so the release has landed.
    await new Promise((r) => setTimeout(r, 0));
    disposeTaskResources('task-A');
    expect(_poolKeysForTest()).toEqual([]);
  });
});
