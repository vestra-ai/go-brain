/**
 * The trip computer's screen, for the live view (live.ts): Bash's browser watch (GET /v1/users/{user_id}/browser/watch),
 * the pages Go's browser fetches open, live. One Bash stream per trip someone watches: opened for its first viewer,
 * closed CLOSE_AFTER_MS after its last leaves (a viewer that dials again finds it still open), and opened again while it
 * is wanted (Bash ends a stream after 30 minutes). Watching never wakes the computer: while it sleeps, Bash says asleep.
 *
 * Go's own guard on top of Bash's: a picture goes on only of a page Go may show (frame-pages.ts), and with its path
 * alone, never its query. A tab on any other page is hidden for good, said once (not_listed), as Bash hides one on a
 * page it must not show: a viewer never waits on a tab that will never show. In memory only: each open tab's last
 * picture, for a viewer who comes in late.
 */
import type { Log } from '../log.js';
import type { SseFrame } from '../tasks/sse.js';
import { pathOf } from './book/run-event.js';
import { isFramePage } from './frame-pages.js';

/**
 * What a viewer reads of the screen. `off`: no screen to watch (Bash refused or is not reachable, or not ixigo_web).
 * `tag`: the run whose fetch has the tab now (its run_id, Go's own tag on the fetch), so its tile carries the run's label;
 * a kept tab a later run takes says the later run's.
 */
export type ScreenEvent =
  | { type: 'state'; state: 'asleep' | 'live' | 'off' }
  | { type: 'tab_open'; tab_id: string; tag?: string }
  | { type: 'frame'; tab_id: string; tag?: string; at: string; page: string; width: number; height: number; jpeg_base64: string }
  | { type: 'hidden'; tab_id: string; tag?: string; reason: 'blocked_path' | 'off_site' | 'not_listed' }
  | { type: 'tab_close'; tab_id: string };

export interface ScreenFeed {
  /** Every screen event of the trip from now on; now() is what a viewer is shown first. */
  watch(tripId: string, fn: (e: ScreenEvent) => void): { now(): ScreenEvent[]; off(): void };
  /** Closes every stream (Go stopping). */
  stop(): void;
}

export interface ScreenStream {
  frames: AsyncIterable<SseFrame>;
  close(): void;
}

export interface ScreenFeedDeps {
  /** Opens the trip's Bash watch stream; null when there is none to open here (another TRAVEL_MODE, jobs off). */
  open: (tripId: string, signal: AbortSignal) => Promise<ScreenStream> | null;
  log: Pick<Log, 'warn'>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** How long a trip's stream stays open after its last viewer leaves. */
export const CLOSE_AFTER_MS = 30_000;
/** Waits before opening again: after a stream that ended, then after each failure in a row, the last repeating. */
export const AGAIN_MS = 1_000;
export const WAITS_MS = [2_000, 5_000, 15_000, 30_000];
const TAB_ID = /^[A-Za-z0-9_-]{1,80}$/;
const TAG = /^[A-Za-z0-9_.:-]{1,64}$/;

interface Tab {
  tag: string | null;
  hidden: ScreenEvent | null;
  last: ScreenEvent | null;
}

type ScreenState = Extract<ScreenEvent, { type: 'state' }>;

interface TripScreen {
  fns: Set<(e: ScreenEvent) => void>;
  state: ScreenState | null;
  tabs: Map<string, Tab>;
  abort: AbortController;
  closing: ReturnType<typeof setTimeout> | null;
}

const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    t.unref?.();
    signal.addEventListener('abort', done, { once: true });
  });

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0);

export function createScreenFeed(d: ScreenFeedDeps): ScreenFeed {
  const trips = new Map<string, TripScreen>();
  const sleep = d.sleep ?? pause;

  const tell = (t: TripScreen, tripId: string, e: ScreenEvent): void => {
    for (const fn of t.fns) {
      try {
        fn(e);
      } catch (err) {
        d.log.warn({ err: String(err).slice(0, 200), tripId }, 'travel: a live viewer failed on a screen event');
      }
    }
  };

  /** The tabs are no longer known (the stream ended): each viewer closes them. */
  const forget = (t: TripScreen, tripId: string): void => {
    for (const id of [...t.tabs.keys()]) tell(t, tripId, { type: 'tab_close', tab_id: id });
    t.tabs.clear();
  };

  const tagged = (tag: string | null): { tag?: string } => (tag ? { tag } : {});

  const tabOf = (t: TripScreen, tripId: string, id: string, tag: string | null): Tab => {
    let tab = t.tabs.get(id);
    if (!tab) {
      tab = { tag, hidden: null, last: null };
      t.tabs.set(id, tab);
      tell(t, tripId, { type: 'tab_open', tab_id: id, ...tagged(tag) });
    }
    if (tag) tab.tag = tag;
    return tab;
  };

  /** One of Bash's events, as the screen says it. Anything else, or anything malformed, is dropped. */
  function take(t: TripScreen, tripId: string, f: SseFrame): void {
    const data = (f.data ?? {}) as Record<string, unknown>;
    if (f.event === 'state') {
      if (data.state !== 'asleep' && data.state !== 'live') return;
      t.state = { type: 'state', state: data.state };
      tell(t, tripId, t.state);
      return;
    }
    const id = typeof data.tab_id === 'string' && TAB_ID.test(data.tab_id) ? data.tab_id : null;
    if (!id) return;
    const tag = typeof data.tag === 'string' && TAG.test(data.tag) ? data.tag : null;
    if (f.event === 'tab_open') {
      tabOf(t, tripId, id, tag);
    } else if (f.event === 'frame') {
      if (typeof data.url !== 'string' || typeof data.jpeg_base64 !== 'string') return;
      const tab = tabOf(t, tripId, id, tag);
      if (tab.hidden) return;
      // Go's own rule: only a page Go may show, and only its path. Any other page hides its tab, as Bash's own rule does.
      if (!isFramePage(data.url)) {
        tab.last = null;
        tab.hidden = { type: 'hidden', tab_id: id, ...tagged(tab.tag), reason: 'not_listed' };
        tell(t, tripId, tab.hidden);
        return;
      }
      tab.last = {
        type: 'frame', tab_id: id, ...tagged(tab.tag), at: typeof data.at === 'string' ? data.at : new Date().toISOString(), page: pathOf(data.url),
        width: num(data.width), height: num(data.height), jpeg_base64: data.jpeg_base64,
      };
      tell(t, tripId, tab.last);
    } else if (f.event === 'hidden') {
      const tab = tabOf(t, tripId, id, tag);
      tab.last = null;
      tab.hidden = { type: 'hidden', tab_id: id, ...tagged(tab.tag), reason: data.reason === 'off_site' ? 'off_site' : 'blocked_path' };
      tell(t, tripId, tab.hidden);
    } else if (f.event === 'tab_close') {
      if (t.tabs.delete(id)) tell(t, tripId, { type: 'tab_close', tab_id: id });
    }
  }

  /** The trip's stream, opened again while anyone wants it. */
  async function follow(t: TripScreen, tripId: string): Promise<void> {
    const { signal } = t.abort;
    let fails = 0;
    while (!signal.aborted) {
      let opened = false;
      try {
        const stream = await d.open(tripId, signal);
        if (!stream) {
          t.state = { type: 'state', state: 'off' };
          tell(t, tripId, t.state);
          return;
        }
        opened = true;
        fails = 0;
        try {
          for await (const f of stream.frames) {
            if (signal.aborted) break;
            take(t, tripId, f);
          }
        } finally {
          stream.close();
        }
      } catch (err) {
        if (signal.aborted) return;
        const code = (err as { code?: unknown } | null)?.code;
        d.log.warn({ tripId, code: typeof code === 'string' ? code : String(err).slice(0, 120) }, "travel: the trip computer's screen stream failed");
      }
      if (signal.aborted) return;
      forget(t, tripId);
      if (!opened && t.state?.state !== 'off') {
        t.state = { type: 'state', state: 'off' };
        tell(t, tripId, t.state);
      }
      await sleep(opened ? AGAIN_MS : WAITS_MS[Math.min(fails++, WAITS_MS.length - 1)]!, signal);
    }
  }

  const close = (tripId: string, t: TripScreen): void => {
    if (trips.get(tripId) === t) trips.delete(tripId);
    if (t.closing) clearTimeout(t.closing);
    t.abort.abort();
  };

  return {
    watch(tripId, fn) {
      let t = trips.get(tripId);
      const fresh = !t;
      if (!t) {
        t = { fns: new Set(), state: null, tabs: new Map(), abort: new AbortController(), closing: null };
        trips.set(tripId, t);
      }
      const screen = t;
      if (screen.closing) clearTimeout(screen.closing);
      screen.closing = null;
      screen.fns.add(fn);
      // After the viewer is in: an open that fails at once still tells it.
      if (fresh) void follow(screen, tripId);
      return {
        now() {
          const out: ScreenEvent[] = screen.state ? [screen.state] : [];
          for (const [id, tab] of screen.tabs) {
            out.push({ type: 'tab_open', tab_id: id, ...tagged(tab.tag) });
            const shown = tab.hidden ?? tab.last;
            if (shown) out.push(shown);
          }
          return out;
        },
        off() {
          screen.fns.delete(fn);
          if (screen.fns.size > 0 || screen.closing) return;
          screen.closing = setTimeout(() => close(tripId, screen), CLOSE_AFTER_MS);
          screen.closing.unref?.();
        },
      };
    },
    stop() {
      for (const [tripId, t] of [...trips]) close(tripId, t);
    },
  };
}
