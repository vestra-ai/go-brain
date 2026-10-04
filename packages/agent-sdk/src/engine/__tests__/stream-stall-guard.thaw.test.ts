/**
 * 2.13b (agent-runtime.md finding 6) — the stall guard re-arms from THAW.
 *
 * Blaxel freezes the whole process. A wall-clock idle window that ran out during the
 * freeze fires the instant the process thaws and calls a stream that was merely frozen
 * "dead"; one that had not run out is that much shorter after thaw. With an `onThaw`
 * subscription the pending window is re-armed for its full length from thaw: a frozen
 * stream gets its whole window to prove life, and a stream that really died in the
 * freeze is caught one window after thaw — not immediately, not late.
 *
 * Fake timers; the thaw is the sandbox's hook, simulated by calling the subscribed
 * callback (the awake clock's own detection is tested with the clock).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { withStallGuard, StreamStalledError } from '../stream-stall-guard.js';
import type { StreamEvent } from '../transport.js';

const text = (t: string): StreamEvent => ({ kind: 'text', text: t }) as StreamEvent;

/** A stream that emits `before`, then goes quiet forever. */
function stallsAfter(before: StreamEvent[]): AsyncIterable<StreamEvent> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < before.length) return { value: before[i++], done: false };
          return new Promise<IteratorResult<StreamEvent>>(() => {});
        },
        async return() { return { value: undefined as never, done: true as const }; },
      };
    },
  };
}

/** A thaw seam the test fires by hand. */
function thawSeam() {
  const subs = new Set<() => void>();
  return {
    onThaw: (cb: () => void) => { subs.add(cb); return () => { subs.delete(cb); }; },
    fire: () => { for (const cb of subs) cb(); },
    count: () => subs.size,
  };
}

afterEach(() => vi.useRealTimers());

describe('withStallGuard — thaw-aware re-arm', () => {
  it('a thaw re-arms the window from thaw: no stall at the old deadline, a stall one full window later', async () => {
    vi.useFakeTimers();
    const thaw = thawSeam();
    const seen: StreamEvent[] = [];
    let error: unknown;
    const run = (async () => {
      try {
        for await (const ev of withStallGuard(stallsAfter([text('a')]), { stallMs: 180_000, onThaw: thaw.onThaw })) seen.push(ev);
      } catch (err) { error = err; }
    })();
    await vi.advanceTimersByTimeAsync(100_000); // 100s quiet, window armed at 0 → due at 180s
    expect(error).toBeUndefined();
    thaw.fire(); // the process thawed here: the window is re-armed for 180s from NOW
    // Mutation: no re-arm → the old deadline at 180s fires here (80s after thaw).
    await vi.advanceTimersByTimeAsync(80_000);
    expect(error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(99_999); // 179.999s after thaw
    expect(error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(error).toBeInstanceOf(StreamStalledError);
    expect(seen).toEqual([text('a')]);
  });

  it('the thaw subscription is released when the guard ends (no listener leak across rounds)', async () => {
    vi.useFakeTimers();
    const thaw = thawSeam();
    const run = (async () => {
      try {
        for await (const _ev of withStallGuard(stallsAfter([]), { stallMs: 1_000, onThaw: thaw.onThaw })) void _ev;
      } catch { /* the stall */ }
    })();
    expect(thaw.count()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await run;
    // Mutation: forget the unsubscribe → 1 here, and every round leaves one behind.
    expect(thaw.count()).toBe(0);
  });

  it('a thaw with no pending window (between events) is a no-op', async () => {
    vi.useFakeTimers();
    const thaw = thawSeam();
    const events: StreamEvent[] = [];
    const src = (async function* () { yield text('x'); })();
    for await (const ev of withStallGuard(src, { stallMs: 1_000, onThaw: thaw.onThaw })) events.push(ev);
    expect(() => thaw.fire()).not.toThrow();
    expect(events).toEqual([text('x')]);
  });

  it('without onThaw the guard is byte-identical: the window fires at its original deadline', async () => {
    vi.useFakeTimers();
    let error: unknown;
    const run = (async () => {
      try {
        for await (const _ev of withStallGuard(stallsAfter([]), { stallMs: 1_000 })) void _ev;
      } catch (err) { error = err; }
    })();
    await vi.advanceTimersByTimeAsync(999);
    expect(error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(error).toBeInstanceOf(StreamStalledError);
  });
});
