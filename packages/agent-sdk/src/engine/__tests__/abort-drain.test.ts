/**
 * P3 (PR-3) — raceAbortDrain unit contract.
 *
 * The load-bearing property is the HOT PATH: with no signal the promise is
 * returned untouched, and with a signal that never aborts ZERO timers are
 * created — the un-aborted engine loop stays byte-identical (the happy-path
 * guard the plan's Task 4 Step 1 calls for). The abort path races the dispatch
 * against abort+grace: settle-within-grace wins (timer cleaned up), expiry
 * resolves the { drainExpired, elapsedMs } sentinel.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { raceAbortDrain, isDrainExpired, DRAIN_DEFAULT_MS } from '../abort-drain.js';

describe('raceAbortDrain', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('no signal → returns the SAME promise (zero wrapping, zero timers)', async () => {
    const p = Promise.resolve('ok');
    const wrapped = raceAbortDrain(p, undefined, DRAIN_DEFAULT_MS);
    expect(wrapped).toBe(p);
    expect(vi.getTimerCount()).toBe(0);
    await expect(wrapped).resolves.toBe('ok');
  });

  it('signal present but never aborted → resolves the value with ZERO timers created', async () => {
    const ac = new AbortController();
    let resolveDispatch!: (v: string) => void;
    const dispatch = new Promise<string>((r) => {
      resolveDispatch = r;
    });
    const wrapped = raceAbortDrain(dispatch, ac.signal, DRAIN_DEFAULT_MS);
    expect(vi.getTimerCount()).toBe(0); // the byte-identical hot path
    resolveDispatch('result');
    await expect(wrapped).resolves.toBe('result');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('signal present but never aborted → passes a rejection through unchanged', async () => {
    const ac = new AbortController();
    const boom = new Error('tool blew up');
    await expect(raceAbortDrain(Promise.reject(boom), ac.signal, DRAIN_DEFAULT_MS)).rejects.toBe(boom);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('abort then settle WITHIN grace → the real result flows and the grace timer is cleaned up', async () => {
    const ac = new AbortController();
    let resolveDispatch!: (v: string) => void;
    const dispatch = new Promise<string>((r) => {
      resolveDispatch = r;
    });
    const wrapped = raceAbortDrain(dispatch, ac.signal, 5_000);
    ac.abort();
    expect(vi.getTimerCount()).toBe(1); // the grace timer started AT the abort
    resolveDispatch('drained');
    await expect(wrapped).resolves.toBe('drained');
    expect(vi.getTimerCount()).toBe(0); // cleared on settle
  });

  it('abort + grace expiry → resolves the DrainExpired sentinel with the elapsed ms', async () => {
    const ac = new AbortController();
    const wrapped = raceAbortDrain(new Promise<never>(() => {}), ac.signal, 5_000);
    ac.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    const res = await wrapped;
    expect(isDrainExpired(res)).toBe(true);
    if (isDrainExpired(res)) expect(res.elapsedMs).toBe(5_000); // fake-timer Date advances in lockstep
  });

  it('signal ALREADY aborted at call time → the grace clock starts immediately', async () => {
    const ac = new AbortController();
    ac.abort();
    const wrapped = raceAbortDrain(new Promise<never>(() => {}), ac.signal, 100);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(isDrainExpired(await wrapped)).toBe(true);
  });

  it('a LATE rejection after expiry is absorbed (no unhandled rejection from the abandoned dispatch)', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const ac = new AbortController();
      let rejectDispatch!: (e: Error) => void;
      const dispatch = new Promise<never>((_r, rej) => {
        rejectDispatch = rej;
      });
      const wrapped = raceAbortDrain(dispatch, ac.signal, 50);
      ac.abort();
      await vi.advanceTimersByTimeAsync(50);
      expect(isDrainExpired(await wrapped)).toBe(true);
      rejectDispatch(new Error('late failure of the abandoned dispatch'));
      // Let the microtask queue flush so an unhandled rejection would surface.
      await vi.advanceTimersByTimeAsync(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
