import { describe, it, expect, beforeEach } from 'vitest';
import { batchPoolKey } from '../round-engine.js';
import {
  getSubagentPool,
  _poolKeysForTest,
  _resetPoolsForTest,
} from '../subagent-pool.js';
import {
  getSessionFuelTank,
  _tankKeysForTest,
  _resetFuelTanksForTest,
  getGlobalAdmissionSemaphore,
  _resetGlobalAdmissionForTest,
} from '../fuel-tank.js';
import { disposeTaskResources } from '../dispose.js';

/**
 * P1 (Harness 2.0) EXIT CRITERIA — the spec's success numbers, pinned as engine-side
 * property tests. These encode what the RunContext re-home + `disposeTaskResources`
 * make TRUE structurally, so a future regression (a re-key back to the process-global
 * sessionId, or a dispose that stops evicting) fails here loudly. The incident-fence
 * behaviour itself is guarded by the sandbox repro suites; this file guards the two
 * numbers that are pure engine properties. (Spec §Phase 1; plan Task 9 Step 1.)
 */
describe('P1 exit criteria (engine properties)', () => {
  beforeEach(() => {
    _resetPoolsForTest();
    _resetFuelTanksForTest();
    _resetGlobalAdmissionForTest();
  });

  it('N parallel tasks never share a batch pool (keys are unique + taskId-derived)', () => {
    const tasks = ['t1', 't2', 't3', 't4', 't5'];
    for (const t of tasks) getSubagentPool(batchPoolKey(t), 12);

    const keys = _poolKeysForTest();
    // Every task got its OWN pool — no two tasks collapsed onto one key.
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(tasks.length);
    // …and each key is derived from the per-task id, never the process-global sessionId.
    expect(keys.every((k) => /^t\d:turnbatch$/.test(k))).toBe(true);
    // Distinct tasks → distinct pool instances (the anti-merge property).
    expect(getSubagentPool(batchPoolKey('t1'), 12)).not.toBe(
      getSubagentPool(batchPoolKey('t2'), 12),
    );
  });

  it('disposeTaskResources leaves zero per-task registry entries (tank + every task-prefixed pool)', () => {
    getSessionFuelTank('t1', 50);
    getSubagentPool(batchPoolKey('t1'), 12); // t1:turnbatch
    getSubagentPool('t1:weave:w', 4); // t1:weave:<id>
    getSubagentPool('t1', 8); // children[] pool (exact key)

    disposeTaskResources('t1');

    expect(_tankKeysForTest()).toEqual([]);
    expect(_poolKeysForTest()).toEqual([]);
  });

  it('dispose is task-scoped — a sibling task keeps its tank + pools intact', () => {
    getSessionFuelTank('t1', 50);
    getSessionFuelTank('t2', 50);
    getSubagentPool(batchPoolKey('t1'), 12);
    getSubagentPool(batchPoolKey('t2'), 12);

    disposeTaskResources('t1');

    expect(_tankKeysForTest()).toEqual(['t2']);
    expect(_poolKeysForTest()).toEqual(['t2:turnbatch']);
  });

  it('dispose never touches the process-global admission semaphore', () => {
    const global = getGlobalAdmissionSemaphore(24);
    getSessionFuelTank('t1', 50);
    getSubagentPool(batchPoolKey('t1'), 12);

    disposeTaskResources('t1');

    // Same memoized instance — the global gate is process-scoped by design, never
    // per-task, so a task teardown must leave it fully intact.
    expect(getGlobalAdmissionSemaphore(24)).toBe(global);
  });
});
