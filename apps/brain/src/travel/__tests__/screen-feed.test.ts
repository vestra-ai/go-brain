import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLog } from '../../log.js';
import type { SseFrame } from '../../tasks/sse.js';
import { AGAIN_MS, CLOSE_AFTER_MS, WAITS_MS, createScreenFeed, type ScreenEvent, type ScreenStream } from '../screen-feed.js';

const RESULTS = 'https://www.ixigo.com/hotels/search/result?city=Goa&checkinDate=20112026&checkoutDate=23112026';

/** One Bash watch stream the test pushes Bash's events into, and ends. */
class FakeBashStream implements ScreenStream {
  closed = false;
  private queue: SseFrame[] = [];
  private wake: (() => void) | null = null;
  private done = false;
  constructor(signal: AbortSignal) {
    signal.addEventListener('abort', () => this.end());
  }
  readonly frames: AsyncIterable<SseFrame> = { [Symbol.asyncIterator]: () => this.read() };
  private async *read(): AsyncGenerator<SseFrame> {
    for (;;) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }
  push(event: string, data: Record<string, unknown>): void {
    this.queue.push({ id: null, event, data: { type: event, ...data } });
    this.wake?.();
  }
  end(): void {
    this.done = true;
    this.wake?.();
  }
  close(): void {
    this.closed = true;
    this.end();
  }
}

/** A feed whose Bash answers each open with a fake stream, or with `answer`'s throw; and waits recorded, never slept. */
function rig(answer?: () => ScreenStream | null) {
  const streams: FakeBashStream[] = [];
  const waits: number[] = [];
  const open = vi.fn((_tripId: string, signal: AbortSignal) => {
    if (answer) {
      const a = answer();
      return a === null ? null : Promise.resolve(a);
    }
    const s = new FakeBashStream(signal);
    streams.push(s);
    return Promise.resolve(s);
  });
  const feed = createScreenFeed({
    open, log: silentLog,
    sleep: async (ms) => {
      waits.push(ms);
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  return { feed, open, streams, waits };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

afterEach(() => vi.useRealTimers());

describe('the trip computer\'s screen', () => {
  it('opens one Bash stream for every viewer of a trip, and passes on what Bash says, a picture with its path only', async () => {
    const { feed, open, streams } = rig();
    const a: ScreenEvent[] = [];
    const b: ScreenEvent[] = [];
    feed.watch('t_goa', (e) => a.push(e));
    feed.watch('t_goa', (e) => b.push(e));
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
    const s = streams[0]!;
    s.push('state', { state: 'live' });
    s.push('tab_open', { tab_id: 'tab_1' });
    s.push('frame', { tab_id: 'tab_1', url: RESULTS, at: '2026-10-08T10:00:00.000Z', width: 960, height: 600, jpeg_base64: '/9j/A' });
    s.push('ping', {});
    await settle();
    const want: ScreenEvent[] = [
      { type: 'state', state: 'live' },
      { type: 'tab_open', tab_id: 'tab_1' },
      { type: 'frame', tab_id: 'tab_1', at: '2026-10-08T10:00:00.000Z', page: '/hotels/search/result', width: 960, height: 600, jpeg_base64: '/9j/A' },
    ];
    expect(a).toEqual(want);
    expect(b).toEqual(want);
  });

  it('never passes on a picture of a page Go may not show, whatever Bash sent', async () => {
    const { feed, streams } = rig();
    const got: ScreenEvent[] = [];
    feed.watch('t_goa', (e) => got.push(e));
    await settle();
    const s = streams[0]!;
    s.push('tab_open', { tab_id: 'tab_1' });
    for (const url of ['https://www.ixigo.com/payments/checkout', 'https://www.ixigo.com/hotels/123/book', 'https://example.com/hotels', 'not a url']) {
      s.push('frame', { tab_id: 'tab_1', url, width: 960, height: 600, jpeg_base64: '/9j/A' });
    }
    s.push('frame', { tab_id: '../x', url: RESULTS, jpeg_base64: '/9j/A' });
    await settle();
    expect(got).toEqual([{ type: 'tab_open', tab_id: 'tab_1' }]);
  });

  it('a hidden tab shows nothing more, and a viewer who comes late sees the screen as it is', async () => {
    const { feed, streams } = rig();
    feed.watch('t_goa', () => undefined);
    await settle();
    const s = streams[0]!;
    s.push('state', { state: 'live' });
    s.push('tab_open', { tab_id: 'tab_1' });
    s.push('frame', { tab_id: 'tab_1', url: RESULTS, at: 'x', width: 960, height: 600, jpeg_base64: '/9j/A' });
    s.push('tab_open', { tab_id: 'tab_2' });
    s.push('frame', { tab_id: 'tab_2', url: RESULTS, at: 'x', width: 480, height: 300, jpeg_base64: '/9j/B' });
    s.push('hidden', { tab_id: 'tab_2', reason: 'blocked_path' });
    s.push('frame', { tab_id: 'tab_2', url: RESULTS, at: 'x', width: 480, height: 300, jpeg_base64: '/9j/C' });
    await settle();
    const late = feed.watch('t_goa', () => undefined);
    expect(late.now()).toEqual([
      { type: 'state', state: 'live' },
      { type: 'tab_open', tab_id: 'tab_1' },
      { type: 'frame', tab_id: 'tab_1', at: 'x', page: '/hotels/search/result', width: 960, height: 600, jpeg_base64: '/9j/A' },
      { type: 'tab_open', tab_id: 'tab_2' },
      { type: 'hidden', tab_id: 'tab_2', reason: 'blocked_path' },
    ]);
    s.push('tab_close', { tab_id: 'tab_1' });
    await settle();
    expect(late.now().map((e) => e.type)).toEqual(['state', 'tab_open', 'hidden']);
  });

  it('a stream that ends closes its tabs and opens again; one that fails says off and waits longer each time', async () => {
    let fails = 2;
    const opened: FakeBashStream[] = [];
    const { feed, waits } = rig(() => {
      if (fails-- > 0) throw Object.assign(new Error('refused'), { code: 'unreachable' });
      const s = new FakeBashStream(new AbortController().signal);
      opened.push(s);
      return s;
    });
    const got: ScreenEvent[] = [];
    feed.watch('t_goa', (e) => got.push(e));
    await settle();
    expect(waits).toEqual([WAITS_MS[0], WAITS_MS[1]]);
    expect(got).toEqual([{ type: 'state', state: 'off' }]);
    const s = opened[0]!;
    s.push('state', { state: 'live' });
    s.push('tab_open', { tab_id: 'tab_1' });
    await settle();
    s.end();
    await settle();
    expect(got.slice(1)).toEqual([{ type: 'state', state: 'live' }, { type: 'tab_open', tab_id: 'tab_1' }, { type: 'tab_close', tab_id: 'tab_1' }]);
    expect(waits.at(2)).toBe(AGAIN_MS);
    expect(opened.length).toBe(2);
    expect(s.closed).toBe(true);
    feed.stop();
  });

  it("carries the run that has a tab (the fetch's tag), and the later run's once it takes a kept tab", async () => {
    const { feed, streams } = rig();
    const got: ScreenEvent[] = [];
    feed.watch('t_goa', (e) => got.push(e));
    await settle();
    const s = streams[0]!;
    s.push('tab_open', { tab_id: 'tab_1', tag: '01JRUNA' });
    s.push('frame', { tab_id: 'tab_1', tag: '01JRUNB', url: RESULTS, at: 'x', width: 960, height: 600, jpeg_base64: '/9j/A' });
    s.push('frame', { tab_id: 'tab_1', tag: 'bad tag!', url: RESULTS, at: 'y', width: 960, height: 600, jpeg_base64: '/9j/B' });
    await settle();
    expect(got.map((e) => [e.type, 'tag' in e ? e.tag : null])).toEqual([['tab_open', '01JRUNA'], ['frame', '01JRUNB'], ['frame', '01JRUNB']]);
    expect(feed.watch('t_goa', () => undefined).now()[0]).toEqual({ type: 'tab_open', tab_id: 'tab_1', tag: '01JRUNB' });
  });

  it('says off, and opens nothing more, where there is no watch to open', async () => {
    const { feed, open } = rig(() => null);
    const got: ScreenEvent[] = [];
    feed.watch('t_goa', (e) => got.push(e));
    await settle();
    expect(got).toEqual([{ type: 'state', state: 'off' }]);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('closes the stream CLOSE_AFTER_MS after the last viewer leaves; a viewer back sooner keeps it', async () => {
    vi.useFakeTimers();
    const { feed, open, streams } = rig();
    const first = feed.watch('t_goa', () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    first.off();
    await vi.advanceTimersByTimeAsync(CLOSE_AFTER_MS - 1);
    const again = feed.watch('t_goa', () => undefined);
    await vi.advanceTimersByTimeAsync(CLOSE_AFTER_MS);
    expect(streams[0]!.closed).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
    again.off();
    await vi.advanceTimersByTimeAsync(CLOSE_AFTER_MS);
    expect(streams[0]!.closed).toBe(true);
    feed.watch('t_goa', () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(open).toHaveBeenCalledTimes(2);
    feed.stop();
  });
});
