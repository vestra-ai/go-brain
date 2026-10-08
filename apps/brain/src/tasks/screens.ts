/**
 * The trip's screen on the working cards: read while a job runs, re-hosted only when its bytes changed, so a card's
 * picture changes only with the screen. While a job has written no to-do list 20 s after it started, its last steps
 * from /v1's trace stand in (read at most every 15 s), in Go's own words: nothing the job read is echoed.
 *
 * Live, but bounded. The screen is read about once a second for the first 5 minutes of the trip's newest job, and less
 * often while it doesn't change (2, 4, then 7 s), back to once a second on the next change. After 5 minutes, or 120
 * changed pictures in a stretch of jobs, it is read every 7 s. Never while someone is signing in (needs you), never
 * twice at once for a trip, and never after the jobs end. A screenshot spends no credits, but each is one of /v1's 60
 * requests a minute per key: all trips together take at most half of that (`perMinute`), so the jobs' own calls and
 * the browser fetch keep the rest, and a tick over the budget is skipped. A picture is kept only while a card shows it:
 * the one a new picture replaces is dropped from Go's image cache.
 */
import { createHash } from 'node:crypto';
import { clip } from '../travel/cards.js';
import type { Images } from '../travel/images.js';
import { LIVE_STATES, type TaskRow, type TaskStep, type TaskStore } from './store.js';
import type { TasksService } from './tasks.js';
import { V1Error, type V1Client } from './v1-client.js';

export interface ScreensDeps {
  v1: V1Client;
  store: TaskStore;
  images: Pick<Images, 'putBytes' | 'forget'>;
  tasks: Pick<TasksService, 'pushCard'>;
  userIdFor: (tripId: string) => string;
  now: () => Date;
  log: { warn(obj: object, msg: string): void };
  traceAfterMs?: number;
  traceEveryMs?: number;
  /** Screenshots in a minute across every trip. Default: half of /v1's 60 for one key. */
  perMinute?: number;
}
export interface Screens { tick(tripId: string): Promise<void> }

/** A trace step in plain words. Only the host of a URL is shown; a summary's other text never is. */
export function stepWords(name: string | null, summary: string | null): string {
  const n = (name ?? '').toLowerCase();
  const host = summary ? /https?:\/\/([^/\s?#]+)/.exec(summary)?.[1] : undefined;
  if (n.includes('websearch') || n.includes('web_search')) return 'Searching the web';
  if (n.includes('webfetch') || n.includes('web_fetch')) return host ? clip(`Reading ${host}`, 80) : 'Reading a page';
  if (n.includes('navigate')) return host ? clip(`Opening ${host}`, 80) : 'Opening a page';
  if (n.includes('mcp_invoke') || n.includes('mcp_search')) return "Using Go's trip tools";
  if (n.includes('click')) return 'Clicking through a page';
  if (n.includes('computer_type')) return 'Filling in a form';
  if (n.includes('screenshot') || n.includes('snapshot')) return 'Looking at the page';
  return 'Working';
}

interface TraceStep { name?: string | null; input_summary?: string | null; is_error?: boolean; finished_at?: string | null }

export const LIVE_GAP_MS = 1_000;
export const SLOW_GAP_MS = 7_000;
export const LIVE_FOR_MS = 5 * 60_000;
export const MAX_LIVE_FRAMES = 120;
/** Half of /v1's 60 requests a minute per key. */
export const SCREENS_PER_MINUTE_PER_KEY = 30;
/** A tick a little early still counts: the follower's timer and the screenshot's own time drift by a few ms. */
const DUE_SLACK_MS = 150;

/** How often one trip's screen is read, and what this stretch of its jobs has taken. */
interface Pace {
  dueAt: number;
  gapMs: number;
  busy: boolean;
  frames: number;
}

export function createScreens(d: ScreensDeps): Screens {
  const lastHash = new Map<string, string>();
  const traceAt = new Map<string, number>();
  const paces = new Map<string, Pace>();
  const perMinute = d.perMinute ?? SCREENS_PER_MINUTE_PER_KEY;
  let minuteStart = Number.NEGATIVE_INFINITY;
  let taken = 0;

  /** One screenshot from this minute's budget, shared by every trip; false when it is spent. */
  function takeBudget(nowMs: number): boolean {
    if (nowMs - minuteStart >= 60_000) {
      minuteStart = nowMs;
      taken = 0;
    }
    if (taken >= perMinute) return false;
    taken += 1;
    return true;
  }

  async function traceFallback(r: TaskRow): Promise<void> {
    const nowMs = d.now().getTime();
    if (r.todosAt || !r.startedAt || !r.v1TaskId || nowMs - r.startedAt.getTime() < (d.traceAfterMs ?? 20_000)) return;
    if (nowMs - (traceAt.get(r.id) ?? 0) < (d.traceEveryMs ?? 15_000)) return;
    traceAt.set(r.id, nowMs);
    try {
      const trace = await d.v1.call<{ steps?: TraceStep[] }>('GET', `/v1/tasks/${r.v1TaskId}/trace`);
      const steps = (trace.steps ?? []).slice(-4).map((s): TaskStep => ({
        text: stepWords(s.name ?? null, s.input_summary ?? null),
        state: s.is_error ? 'failed' : s.finished_at ? 'done' : 'doing',
      }));
      if (steps.length === 0) return;
      const fresh = await d.store.get(r.id);
      if (!fresh || fresh.todosAt || !LIVE_STATES.includes(fresh.state)) return;
      await d.store.update(r.id, { steps });
      await d.tasks.pushCard({ ...fresh, steps }, false);
    } catch (err) {
      d.log.warn({ err, taskId: r.id }, "tasks: reading a job's trace failed");
    }
  }

  async function screenshot(tripId: string, rows: TaskRow[]): Promise<void> {
    const startMs = d.now().getTime();
    let pace = paces.get(tripId);
    if (!pace) {
      pace = { dueAt: 0, gapMs: LIVE_GAP_MS, busy: false, frames: 0 };
      paces.set(tripId, pace);
    }
    if (pace.busy || startMs + DUE_SLACK_MS < pace.dueAt || !takeBudget(startMs)) return;
    const newestStart = Math.max(...rows.map((r) => r.startedAt?.getTime() ?? startMs));
    const live = startMs - newestStart < LIVE_FOR_MS && pace.frames < MAX_LIVE_FRAMES;
    let changed = false;
    pace.busy = true;
    try {
      const shot = await d.v1.bytes(`/v1/users/${d.userIdFor(tripId)}/screenshot`);
      const hash = createHash('sha256').update(shot.bytes).digest('hex');
      if (shot.bytes.length > 0 && hash !== lastHash.get(tripId)) {
        changed = true;
        pace.frames += 1;
        lastHash.set(tripId, hash);
        const url = await d.images.putBytes(shot.bytes, 'image/jpeg');
        for (const r of rows) {
          if (r.screenshotUrl === url) continue;
          await d.store.update(r.id, { screenshotUrl: url });
          await d.tasks.pushCard({ ...r, screenshotUrl: url }, false, { frame: true });
        }
        // The picture a card showed before is superseded: dropped once no job's card shows it.
        for (const old of new Set(rows.map((r) => r.screenshotUrl))) {
          if (old && old !== url && !(await d.store.showsScreenshot(old))) await d.images.forget(old);
        }
      }
    } catch (err) {
      // No browser, or a person signing in on the screen (Bash shows that page to them alone): no picture now, quietly.
      const none = err instanceof V1Error && (err.code === 'browser_not_open' || err.code === 'browser_in_use');
      if (!none) d.log.warn({ err, tripId }, "tasks: reading the trip's screen failed");
    } finally {
      pace.gapMs = !live ? SLOW_GAP_MS : changed ? LIVE_GAP_MS : Math.min(pace.gapMs * 2, SLOW_GAP_MS);
      pace.dueAt = startMs + pace.gapMs;
      pace.busy = false;
    }
  }

  return {
    async tick(tripId) {
      const rows = (await d.store.listLive(tripId)).filter((r) => r.state === 'running' || r.state === 'needs_you');
      if (rows.length === 0) {
        lastHash.delete(tripId);
        paces.delete(tripId);
        return;
      }
      // One computer per trip: while anyone is signing in on it, Go takes no picture of its screen for any job.
      if (!rows.some((r) => r.state === 'needs_you')) await screenshot(tripId, rows);
      for (const r of rows) await traceFallback(r);
    },
  };
}
