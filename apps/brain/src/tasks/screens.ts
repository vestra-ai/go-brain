/**
 * The trip's screen on the working cards: read while a job runs, re-hosted only when its bytes changed, so a card's
 * picture changes only with the screen. While a job has written no to-do list 20 s after it started, its last steps
 * from /v1's trace stand in (read at most every 15 s), in Go's own words: nothing the job read is echoed.
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
  images: Pick<Images, 'putBytes'>;
  tasks: Pick<TasksService, 'pushCard'>;
  userIdFor: (tripId: string) => string;
  now: () => Date;
  log: { warn(obj: object, msg: string): void };
  traceAfterMs?: number;
  traceEveryMs?: number;
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

export function createScreens(d: ScreensDeps): Screens {
  const lastHash = new Map<string, string>();
  const traceAt = new Map<string, number>();

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

  return {
    async tick(tripId) {
      const rows = (await d.store.listLive(tripId)).filter((r) => r.state === 'running' || r.state === 'needs_you');
      if (rows.length === 0) {
        lastHash.delete(tripId);
        return;
      }
      try {
        const shot = await d.v1.bytes(`/v1/users/${d.userIdFor(tripId)}/screenshot`);
        const hash = createHash('sha256').update(shot.bytes).digest('hex');
        if (shot.bytes.length > 0 && hash !== lastHash.get(tripId)) {
          lastHash.set(tripId, hash);
          const url = await d.images.putBytes(shot.bytes, 'image/jpeg');
          for (const r of rows) {
            if (r.screenshotUrl === url) continue;
            await d.store.update(r.id, { screenshotUrl: url });
            await d.tasks.pushCard({ ...r, screenshotUrl: url }, false);
          }
        }
      } catch (err) {
        if (!(err instanceof V1Error && err.code === 'browser_not_open')) d.log.warn({ err, tripId }, "tasks: reading the trip's screen failed");
      }
      for (const r of rows) await traceFallback(r);
    },
  };
}
