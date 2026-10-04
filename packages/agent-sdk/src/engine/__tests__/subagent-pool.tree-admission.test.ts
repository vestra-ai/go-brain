/**
 * Orchestration walls, D4 — the tree-wide admission gate and the refusal/spawn counters.
 *
 * The gate REFUSES, it never queues: that is the whole point. The nested deadlock this
 * replaces lived in the FIFO queue (a parent holding a slot while it awaited its own
 * children). A counting gate that answers "slot" or "null" cannot deadlock — a child
 * either runs now or is told to do the work itself.
 */
import { describe, it, expect } from 'vitest';
import {
  getTreeAdmission,
  treeStats,
  resetTreeStats,
  disposePoolsFor,
  _poolKeysForTest,
} from '../subagent-pool.js';

describe('tree admission — refuse, never queue', () => {
  it('hands out exactly `limit` slots, then null, and a release frees one', () => {
    const a = getTreeAdmission('root-1', 2);
    const r1 = a.tryAcquire();
    const r2 = a.tryAcquire();
    const r3 = a.tryAcquire();
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r3).toBeNull();
    expect(a.running).toBe(2);
    r1!();
    expect(a.running).toBe(1);
    expect(a.tryAcquire()).not.toBeNull();
  });

  it('never waits: a full gate answers synchronously with null, not a promise', () => {
    const a = getTreeAdmission('root-1b', 1);
    a.tryAcquire();
    // The mutation this kills: swapping the gate back for a Semaphore (which QUEUES).
    expect(a.tryAcquire()).toBeNull();
    expect(a.running).toBe(1);
  });

  it('a release is idempotent — a double call cannot mint a phantom slot', () => {
    const a = getTreeAdmission('root-1c', 1);
    const rel = a.tryAcquire()!;
    rel();
    rel();
    expect(a.running).toBe(0);
    expect(a.tryAcquire()).not.toBeNull();
    expect(a.tryAcquire()).toBeNull();
  });

  it('is memoized by root: the same root shares one gate, another root gets its own', () => {
    expect(getTreeAdmission('root-2', 1)).toBe(getTreeAdmission('root-2', 1));
    expect(getTreeAdmission('root-2', 1)).not.toBe(getTreeAdmission('root-3', 1));
  });

  it('the FIRST caller fixes the cap for the whole tree (a later limit is ignored)', () => {
    const a = getTreeAdmission('root-2b', 1);
    expect(getTreeAdmission('root-2b', 50)).toBe(a);
    a.tryAcquire();
    expect(getTreeAdmission('root-2b', 50).tryAcquire()).toBeNull();
  });

  it('disposePoolsFor drops an idle gate and keeps a busy one', () => {
    const a = getTreeAdmission('root-4', 1);
    const rel = a.tryAcquire();
    disposePoolsFor('root-4');
    expect(getTreeAdmission('root-4', 1)).toBe(a); // busy: kept
    rel!();
    disposePoolsFor('root-4');
    expect(getTreeAdmission('root-4', 1)).not.toBe(a); // idle: replaced
  });

  it('disposePoolsFor drops the gate under the `taskId:` prefix rule, not by exact key', () => {
    getTreeAdmission('root-4b', 1);
    expect(_poolKeysForTest()).toContain('root-4b:tree');
    disposePoolsFor('root-4b');
    expect(_poolKeysForTest()).not.toContain('root-4b:tree');
  });

  it('disposePoolsFor drops the stats for the task', () => {
    treeStats('root-4c').spawned += 7;
    disposePoolsFor('root-4c');
    expect(treeStats('root-4c').spawned).toBe(0);
  });

  it('disposePoolsFor KEEPS the stats while children are still running under the task', () => {
    // dispose.ts fires on idle eviction / rewind / strand repair too, not only task end.
    const rel = getTreeAdmission('root-4d', 1).tryAcquire()!;
    treeStats('root-4d').spawned += 5;
    disposePoolsFor('root-4d');
    expect(treeStats('root-4d').spawned).toBe(5);
    rel();
    disposePoolsFor('root-4d');
    expect(treeStats('root-4d').spawned).toBe(0);
  });

  it('tree stats count and reset', () => {
    const s = treeStats('root-5');
    s.spawned += 2;
    s.maxDepth = 3;
    s.refused.lone_child += 1;
    expect(treeStats('root-5')).toMatchObject({
      spawned: 2,
      maxDepth: 3,
      refused: { lone_child: 1 },
    });
    resetTreeStats('root-5');
    expect(treeStats('root-5').spawned).toBe(0);
  });

  it('stats carry a counter for EVERY refusal kind the walls can produce', () => {
    // A missing key would make `refused[kind] += 1` write NaN at the call site and
    // the counter would silently read undefined forever.
    expect(Object.keys(treeStats('root-6').refused).sort()).toEqual(
      ['budget', 'concurrency', 'depth', 'leaf', 'lone_child', 'serial_root'],
    );
    expect(Object.values(treeStats('root-6').refused).every((n) => n === 0)).toBe(true);
    expect(Object.keys(treeStats('root-6').stopped).sort()).toEqual(
      ['parent', 'turn_cap', 'user'],
    );
    // Follow-up C — the root wall's two ALLOW readings live in their OWN record, not among
    // the refusals: the server sums the refusal record into one `spawn_refused` column, so
    // a spawn the wall let through would be reported there as one it stopped.
    expect(Object.keys(treeStats('root-6').allowed).sort()).toEqual(
      ['serial_root_allowed', 'serial_root_dependent'],
    );
    expect(Object.values(treeStats('root-6').allowed).every((n) => n === 0)).toBe(true);
  });

  it('stats are per-root: one tree\'s counters never leak into another', () => {
    treeStats('root-7').spawned += 3;
    expect(treeStats('root-8').spawned).toBe(0);
  });
});
