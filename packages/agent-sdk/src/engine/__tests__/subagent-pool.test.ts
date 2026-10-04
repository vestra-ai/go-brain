/**
 * Task 9: per-session subagent concurrency pool (root-keyed) + cooperative
 * budget check at the fan-out site.
 *
 * Three contracts:
 *  (1) `getSubagentPool(root, limit)` never runs more than `limit` callbacks
 *      concurrently — for the WHOLE session tree (one pool per root).
 *  (2) the pool is memoized by ROOT session id: the same root returns the SAME
 *      instance (a nested/orchestrator level reuses it, not a fresh one →
 *      recursion can't multiply the cap to limit^depth); a different root gets a
 *      different instance.
 *  (3) `fanOutChildren` stops LAUNCHING children once the live cumulative cost
 *      reaches `maxBudgetUsd` — the remaining children are skipped, not spawned.
 */
import { describe, it, expect } from 'vitest';
import { getSubagentPool, fanOutChildren as fanOut, treeStats, resetTreeStats } from '../subagent-pool.js';

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A child spec (the children[] entry shape — only the fields the test reads). */
const c = (p: string): { subagent_type: string; prompt: string; description: string } => ({
  subagent_type: 'r',
  prompt: p,
  description: p,
});

/**
 * Ergonomic test wrapper over the production `fanOut`: `cumulativeAfterEach`
 * drives the live `getCumulativeCostUsd` getter (the cumulative spend OBSERVED
 * before scheduling child i reflects children 0..i-1 having settled), so the
 * budget gate is exercised deterministically without a real harness.
 */
async function fanOutChildren<S>(
  specs: S[],
  opts: { maxBudgetUsd: number; cumulativeAfterEach: number[]; onLaunch: (i: number) => void },
): Promise<unknown> {
  let completed = 0;
  return fanOut(specs, {
    maxBudgetUsd: opts.maxBudgetUsd,
    getCumulativeCostUsd: () =>
      completed === 0 ? 0 : opts.cumulativeAfterEach[Math.min(completed, opts.cumulativeAfterEach.length) - 1],
    onLaunch: opts.onLaunch,
    runChild: async () => {
      completed += 1;
      return { text: 'ok', pausedHalt: false };
    },
  });
}

describe('subagent-pool — Task 9: per-session concurrency pool + cooperative budget', () => {
  it('never runs more than `limit` tasks concurrently across the session tree', async () => {
    const pool = getSubagentPool('session-A', 2);
    let active = 0;
    let peak = 0;
    const job = (): Promise<number> =>
      pool.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await tick(5);
        active--;
        return 0;
      });
    await Promise.all([job(), job(), job(), job(), job()]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('a nested (orchestrator) level reuses the ROOT pool, not a fresh one', () => {
    expect(getSubagentPool('session-A', 2)).toBe(getSubagentPool('session-A', 2)); // same instance
    expect(getSubagentPool('session-A', 2)).not.toBe(getSubagentPool('session-B', 2));
  });

  it('stops launching children once the cumulative budget is exceeded', async () => {
    const launched: number[] = [];
    await fanOutChildren([c('a'), c('b'), c('c')], {
      maxBudgetUsd: 0.15,
      cumulativeAfterEach: [0.1, 0.2],
      onLaunch: (i: number) => launched.push(i),
    });
    expect(launched).toEqual([0, 1]); // after child 1 pushes cumulative to 0.20 >= 0.15, child 2 is skipped
  });
});

/**
 * Phase 3, Task 9 (spec §4.9) — THE TEAM COUNTERS.
 *
 * The team surface is six things a turn can do that the Phase 1 tally has no word for: a
 * message that landed, a message a cap refused, a helper the lead called off, a finished
 * helper a message woke, and the two halves of the board (an item a helper took, an item it
 * finished). Each is one number on the SAME record the walls already write, so
 * "what did this team actually do" survives a runner recycle instead of living in a log line.
 *
 * Counters only, exactly as the walls' are: nothing here gates anything, so a missed
 * increment costs a report line and never a send.
 */
describe('TreeStats — the Phase 3 team counters', () => {
  it('a fresh tree starts every team counter at zero', () => {
    resetTreeStats('root-team-1');
    const s = treeStats('root-team-1');
    expect(s.messagesSent).toBe(0);
    expect(s.hopRefusals).toBe(0);
    expect(s.leadStops).toBe(0);
    expect(s.resumes).toBe(0);
    expect(s.boardClaims).toBe(0);
    expect(s.boardDones).toBe(0);
    resetTreeStats('root-team-1');
  });

  it('they are ADDITIVE: the Phase 1 tally is untouched beside them', () => {
    resetTreeStats('root-team-2');
    const s = treeStats('root-team-2');
    // The whole shape, so a counter dropped or renamed fails here rather than in the
    // server's sum, where the reading just goes quiet.
    expect(Object.keys(s).sort()).toEqual([
      'allowed', 'boardClaims', 'boardDones', 'hopRefusals', 'leadStops', 'maxDepth',
      'messagesSent', 'refused', 'resumes', 'spawned', 'spawnedBySubagents', 'stopped',
    ]);
    expect(s.spawned).toBe(0);
    expect(s.refused).toEqual({ depth: 0, leaf: 0, lone_child: 0, concurrency: 0, budget: 0, serial_root: 0 });
    expect(s.stopped).toEqual({ user: 0, parent: 0, turn_cap: 0 });
    resetTreeStats('root-team-2');
  });

  it('they accumulate per ROOT, and the reset clears them with the rest', () => {
    resetTreeStats('root-team-3');
    treeStats('root-team-3').messagesSent += 1;
    treeStats('root-team-3').resumes += 1;
    treeStats('root-team-3').boardClaims += 1;
    treeStats('root-team-3').boardDones += 1;
    expect(treeStats('root-team-3').messagesSent).toBe(1);
    expect(treeStats('root-team-3').boardClaims).toBe(1);
    // A different tree is a different tally.
    expect(treeStats('root-team-4').messagesSent).toBe(0);
    expect(treeStats('root-team-4').boardClaims).toBe(0);
    resetTreeStats('root-team-3');
    expect(treeStats('root-team-3').messagesSent).toBe(0);
    expect(treeStats('root-team-3').boardDones).toBe(0);
    resetTreeStats('root-team-3');
    resetTreeStats('root-team-4');
  });
});
