/**
 * P2.5 Task 10 — GlobalNodeCounter: the process-global NON-BLOCKING node counter
 * with the fuel tank's deny-don't-queue discipline. Unlike the blocking admission
 * Semaphore (top-level-only — self-deadlock at depth), any nesting depth may
 * consult this without deadlock: a full counter DENIES (returns null), never queues.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  GlobalNodeCounter,
  getGlobalNodeCounter,
  _resetGlobalNodeCounterForTest,
  admitNode,
} from '../fuel-tank.js';

describe('GlobalNodeCounter', () => {
  it('admits up to the limit, then DENIES (null) — never queues', () => {
    const c = new GlobalNodeCounter(2);
    const r1 = c.tryAcquire();
    const r2 = c.tryAcquire();
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(c.inFlight).toBe(2);
    expect(c.tryAcquire()).toBeNull(); // at limit → denied, synchronously
  });

  it('release restores capacity', () => {
    const c = new GlobalNodeCounter(1);
    const release = c.tryAcquire()!;
    expect(c.tryAcquire()).toBeNull();
    release();
    expect(c.inFlight).toBe(0);
    expect(c.tryAcquire()).not.toBeNull();
  });

  it('release is idempotent — a double-release never frees a second slot', () => {
    const c = new GlobalNodeCounter(2);
    const release = c.tryAcquire()!;
    c.tryAcquire();
    release();
    release(); // second call must be a no-op
    expect(c.inFlight).toBe(1);
  });
});

describe('getGlobalNodeCounter (memoized like the admission semaphore)', () => {
  beforeEach(() => _resetGlobalNodeCounterForTest());

  it('returns the same instance; the FIRST caller fixes the limit', () => {
    const a = getGlobalNodeCounter(3);
    const b = getGlobalNodeCounter(99); // later limit ignored
    expect(b).toBe(a);
    expect(b.limit).toBe(3);
  });

  it('normalizes a fractional/low limit to at least 1 (the semaphore discipline)', () => {
    expect(getGlobalNodeCounter(0.4).limit).toBe(1);
  });
});

describe('admitNode + counter (the deny-don\'t-queue admission hook)', () => {
  it('a full counter routes to onDenied WITHOUT running the node; release in finally restores capacity', async () => {
    const c = new GlobalNodeCounter(1);
    let ran = 0;
    const admit = () =>
      admitNode<string>({
        counter: c,
        reserveUsd: 0,
        spentUsd: () => 0,
        run: async () => { ran += 1; return 'ran'; },
        onDenied: () => 'denied',
      });
    const hold = c.tryAcquire()!; // saturate the counter
    expect(await admit()).toBe('denied');
    expect(ran).toBe(0);
    hold();
    expect(await admit()).toBe('ran'); // slot released → admitted
    expect(c.inFlight).toBe(0); // admitNode released its slot in finally
  });

  it('a throwing node still releases its counter slot', async () => {
    const c = new GlobalNodeCounter(1);
    await expect(
      admitNode({
        counter: c,
        reserveUsd: 0,
        spentUsd: () => 0,
        run: async () => { throw new Error('boom'); },
        onDenied: () => 'denied',
      }),
    ).rejects.toThrow('boom');
    expect(c.inFlight).toBe(0);
  });
});
