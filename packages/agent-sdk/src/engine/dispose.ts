import { disposeTank } from './fuel-tank.js';
import { disposePoolsFor } from './subagent-pool.js';

/** P1 — explicit task teardown. Called from QueryManager's forceCleanup path,
 *  which fires on MORE than terminal task-end: idle eviction, the orphan sweep,
 *  TASK_DESTROY, rewind, strand-repair, and the >6h capacity reaper (PR-1288
 *  review finding 3 — do not assume terminality here). Both delegates are
 *  quiescence-gated for exactly that reason: a tank with outstanding reserves or
 *  a busy pool is SKIPPED, not deleted (finding 1). Deliberately NOT touching
 *  the process-global admission semaphore (one per process by design). */
export function disposeTaskResources(taskId: string): void {
  disposeTank(taskId);
  disposePoolsFor(taskId);
}
