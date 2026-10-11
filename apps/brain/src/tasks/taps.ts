/**
 * The working card's buttons. Watch mints a fresh 15-minute session on the trip's screen for every tap and answers it
 * as "open" (a link is never posted in the chat); it asks for control only for the person a hand-off waits on, and
 * falls back to a view when /v1 has shared control off. Stop ends a live job.
 */
import type { Brain } from '../app.js';
import { LIVE_STATES, type TaskStore } from './store.js';
import type { TasksService } from './tasks.js';
import { V1Error, type V1Client } from './v1-client.js';

export interface TaskTapDeps {
  store: TaskStore;
  tasks: Pick<TasksService, 'stop'>;
  v1: V1Client;
  userIdFor: (tripId: string) => string;
  log: { warn(obj: object, msg: string): void };
}

/** The longest a session's open waits out Bash's 429 before trying again once: a tap must answer within 3 s. */
export const SESSION_RETRY_MAX_MS = 1_200;

export async function openSession(
  v1: V1Client,
  userId: string,
  conversationId: string | null,
  screen: 'view' | 'control',
  o: { driver?: 'user'; retried?: boolean } = {},
): Promise<{ id?: string; url: string; expires_at: string }> {
  try {
    return await v1.call<{ id?: string; url: string; expires_at: string }>('POST', '/v1/sessions', {
      body: { user_id: userId, ...(conversationId ? { conversation_id: conversationId } : {}), screen, ...(screen === 'control' && o.driver ? { driver: o.driver } : {}) },
      signal: AbortSignal.timeout(2_000),
    });
  } catch (err) {
    if (screen === 'control' && err instanceof V1Error && err.code === 'screen_control_unavailable') return openSession(v1, userId, conversationId, 'view');
    // Every key resting for a moment (Bash counts Go's background reads too): once more, when the wait fits in a tap's
    // answer, never a screen that can't open for a pause of a second.
    if (err instanceof V1Error && err.status === 429 && !o.retried && (err.retryAfterMs ?? Infinity) <= SESSION_RETRY_MAX_MS) {
      await new Promise((r) => setTimeout(r, err.retryAfterMs ?? 0));
      return openSession(v1, userId, conversationId, screen, { ...o, retried: true });
    }
    // A Bash from before driver (bash #4656) refuses the field: the screen opens as it did, with Take control.
    if (o.driver && err instanceof V1Error && err.status === 400) return openSession(v1, userId, conversationId, screen);
    throw err;
  }
}

export function registerTaskTaps(taps: Brain['taps'], d: TaskTapDeps): void {
  taps.on('working', 'watch', async (tap, card) => {
    const row = card.kind === 'working' ? await d.store.get(card.task_id) : null;
    if (!row || row.tripId !== tap.trip_id) return { result: 'refused', toast: 'That job is not here any more' };
    const control = row.state === 'needs_you' && row.needsPersonId === tap.person_id;
    try {
      const s = await openSession(d.v1, d.userIdFor(row.tripId), row.conversationId, control ? 'control' : 'view');
      return { result: 'open', url: s.url, expires_at: s.expires_at };
    } catch (err) {
      d.log.warn({ err, taskId: row.id }, 'tasks: a Watch session did not open');
      return { result: 'refused', toast: "Can't open Go's screen right now" };
    }
  });

  taps.on('working', 'stop', async (tap, card) => {
    const row = card.kind === 'working' ? await d.store.get(card.task_id) : null;
    if (!row || row.tripId !== tap.trip_id) return { result: 'refused', toast: 'That job is not here any more' };
    if (!LIVE_STATES.includes(row.state)) return { result: 'refused', toast: 'That job has already finished' };
    await d.tasks.stop(row.id);
    return { result: 'done', toast: 'Stopping it' };
  });
}
