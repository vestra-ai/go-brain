/**
 * The depth-silence rail (prod 381d8797, 2026-08-24).
 *
 * A subagent two levels deep completed a tool_result and then its provider
 * stream never yielded again. Nothing threw, nothing aborted, so none of the
 * harness's (good) error propagation ran and the whole stack sat silent for 46
 * minutes. These tests pin the cure: an idle deadline that turns silence into an
 * ordinary throw, which the existing machinery already carries up every depth.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  withStallGuard,
  streamStallMs,
  StreamStalledError,
  DEFAULT_STREAM_STALL_MS,
} from '../stream-stall-guard.js';
import type { StreamEvent } from '../transport.js';

const text = (t: string): StreamEvent => ({ kind: 'text', text: t }) as StreamEvent;

/** A stream that emits `before`, then goes quiet forever. */
function stallsAfter(before: StreamEvent[]) {
  const closed = { count: 0 };
  const iterable: AsyncIterable<StreamEvent> = {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < before.length) return { value: before[i++], done: false };
          return new Promise<IteratorResult<StreamEvent>>(() => {}); // never settles
        },
        async return() {
          closed.count += 1;
          return { value: undefined as never, done: true as const };
        },
      };
    },
  };
  return { iterable, closed };
}

async function* healthy(events: StreamEvent[], gapMs: number): AsyncIterable<StreamEvent> {
  for (const ev of events) {
    await new Promise((r) => setTimeout(r, gapMs));
    yield ev;
  }
}

afterEach(() => {
  vi.useRealTimers();
  delete process.env.STREAM_STALL_MS;
});

describe('withStallGuard — silence becomes an error', () => {
  it('throws StreamStalledError when the stream goes quiet past the window', async () => {
    vi.useFakeTimers();
    const { iterable } = stallsAfter([text('hello')]);
    const seen: StreamEvent[] = [];

    const run = (async () => {
      for await (const ev of withStallGuard(iterable, { stallMs: 1000 })) seen.push(ev);
    })();
    const caught = run.catch((e) => e);

    await vi.advanceTimersByTimeAsync(1001);
    const err = (await caught) as StreamStalledError;

    expect(err).toBeInstanceOf(StreamStalledError);
    expect((err as StreamStalledError).code).toBe('stream_stalled');
    expect(seen).toHaveLength(1); // the pre-stall event was delivered, not lost
  });

  it('names WHERE it stalled — last event kind and count', async () => {
    vi.useFakeTimers();
    const { iterable } = stallsAfter([text('a'), text('b')]);
    const run = (async () => {
      for await (const _ of withStallGuard(iterable, { stallMs: 500 })) { /* drain */ }
    })();
    const caught = run.then(() => undefined, (e: unknown) => e as StreamStalledError);
    await vi.advanceTimersByTimeAsync(501);
    const err = (await caught) as StreamStalledError;

    expect(err.lastEventKind).toBe('text');
    expect(err.eventsSeen).toBe(2);
    expect(err.message).toMatch(/no event for 1s/);
  });

  it('a stall BEFORE the first event says so rather than reporting a phantom last event', async () => {
    vi.useFakeTimers();
    const { iterable } = stallsAfter([]);
    const run = (async () => {
      for await (const _ of withStallGuard(iterable, { stallMs: 800 })) { /* drain */ }
    })();
    const caught = run.then(() => undefined, (e: unknown) => e as StreamStalledError);
    await vi.advanceTimersByTimeAsync(801);
    const err = (await caught) as StreamStalledError;

    expect(err.lastEventKind).toBeNull();
    expect(err.eventsSeen).toBe(0);
    expect(err.message).toMatch(/stalled before the first event/);
  });

  it('CLOSES the upstream on stall — a hung provider socket must not leak', async () => {
    vi.useFakeTimers();
    const { iterable, closed } = stallsAfter([text('x')]);
    const run = (async () => {
      for await (const _ of withStallGuard(iterable, { stallMs: 300 })) { /* drain */ }
    })();
    const caught = run.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(301);
    await caught;
    await Promise.resolve(); // the close is fire-and-forget; let its microtask run

    expect(closed.count).toBe(1);
  });

  it('calls onStall with the error, for the caller to record', async () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const { iterable } = stallsAfter([]);
    const run = (async () => {
      for await (const _ of withStallGuard(iterable, { stallMs: 200, onStall })) { /* drain */ }
    })();
    const caught = run.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(201);
    await caught;

    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall.mock.calls[0][0]).toBeInstanceOf(StreamStalledError);
  });
});

describe('withStallGuard — a healthy stream is never interrupted', () => {
  it('a LONG generation that keeps emitting runs to completion (idle bound, not a duration budget)', async () => {
    // THE ARITHMETIC IS THE TEST. Each gap (20ms) sits well inside the window
    // (150ms) so the idle bound never trips — but the TOTAL (20 x 20ms = 400ms)
    // runs well past it, so a total-duration budget WOULD kill this run. Those two
    // facts are what make the assertion discriminate between the two semantics.
    //
    // It did not, until the gate-10 reviewer ran the mutation I claimed it killed.
    // The gap was 5ms, so the total was 100ms — UNDER the 150ms window — and a
    // total-budget mutant passed 12/12 while a comment beside it asserted "2000ms".
    // A correct comment next to arithmetic that says otherwise; the numbers now
    // agree with the claim.
    const GAP_MS = 20;
    const WINDOW_MS = 150;
    const COUNT = 20;
    expect(GAP_MS).toBeLessThan(WINDOW_MS);            // idle bound must NOT trip
    expect(COUNT * GAP_MS).toBeGreaterThan(WINDOW_MS); // a total budget MUST trip

    const events = Array.from({ length: COUNT }, (_, i) => text(`chunk-${i}`));
    const seen: StreamEvent[] = [];
    for await (const ev of withStallGuard(healthy(events, GAP_MS), { stallMs: WINDOW_MS })) {
      seen.push(ev);
    }
    expect(seen).toHaveLength(COUNT);
  });

  it('a normal finite stream passes through byte-identically', async () => {
    const events = [text('a'), text('b'), text('c')];
    const seen: StreamEvent[] = [];
    for await (const ev of withStallGuard(healthy(events, 1), { stallMs: 5000 })) seen.push(ev);
    expect(seen).toEqual(events);
  });

  it('a non-stall error from upstream propagates unchanged', async () => {
    async function* boom(): AsyncIterable<StreamEvent> {
      yield text('a');
      throw new Error('provider exploded');
    }
    await expect(async () => {
      for await (const _ of withStallGuard(boom(), { stallMs: 5000 })) { /* drain */ }
    }).rejects.toThrow('provider exploded');
  });
});

describe('streamStallMs — the disable switch', () => {
  it('defaults to the generous window', () => {
    expect(streamStallMs({} as NodeJS.ProcessEnv)).toBe(DEFAULT_STREAM_STALL_MS);
  });

  it('honours an override', () => {
    expect(streamStallMs({ STREAM_STALL_MS: '5000' } as unknown as NodeJS.ProcessEnv)).toBe(5000);
  });

  it('garbage falls back to the default rather than disabling the guard by accident', () => {
    expect(streamStallMs({ STREAM_STALL_MS: 'soon' } as unknown as NodeJS.ProcessEnv)).toBe(
      DEFAULT_STREAM_STALL_MS,
    );
    expect(streamStallMs({ STREAM_STALL_MS: '-1' } as unknown as NodeJS.ProcessEnv)).toBe(
      DEFAULT_STREAM_STALL_MS,
    );
  });

  it('0 disables it — passthrough, and a stalled stream then hangs as before', async () => {
    vi.useFakeTimers();
    const { iterable, closed } = stallsAfter([text('x')]);
    const seen: StreamEvent[] = [];
    let settled = false;
    void (async () => {
      for await (const ev of withStallGuard(iterable, { stallMs: 0 })) seen.push(ev);
      settled = true;
    })().catch(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(600_000); // ten minutes
    expect(settled).toBe(false);
    expect(closed.count).toBe(0);
    expect(seen).toHaveLength(1);
  });
});
