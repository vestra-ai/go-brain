/**
 * The sweep, every 2 minutes. /v1 is the source of truth for a job, so whatever the stream and the webhooks missed is
 * read back here: /v1's events after the last one Go saw, jobs that never reached /v1, jobs /v1 started without Go
 * hearing, each running job's status and to-do list, asks nobody delivered, and a follower for each conversation with
 * a running job. Then the clocks: past its deadline a job is stopped; a question nobody answered in 10 minutes is
 * cancelled; a hand-off nobody answered in 10 minutes ends the job as "Didn't work".
 */
import type { Brain } from '../app.js';
import { clip } from '../travel/cards.js';
import type { Computer } from './computer.js';
import type { EventStore } from './event-store.js';
import type { TaskEvents } from './events.js';
import { ACTIVE_STATES, LIVE_STATES, type TaskRow, type TaskStore } from './store.js';
import type { TaskWake, TasksService } from './tasks.js';
import { V1Error, type V1Client } from './v1-client.js';
import { toV1Event, type PlatformEvent } from './webhooks.js';
import { stepsFromTodos } from './working-card.js';

export const SWEEP_EVERY_MS = 120_000;
/** How long a question or hand-off may wait on the room. */
export const ASK_TTL_MS = 10 * 60_000;
/** A job still not handed to /v1 after this long is handed again. */
const DISPATCH_GRACE_MS = 30_000;
/** A job /v1 has not named after this long is looked up in /v1's events. */
const START_GRACE_MS = 60_000;
/** How far back the sweep looks for jobs Go stopped before /v1 named them. */
const UNNAMED_STOP_MS = 60 * 60_000;
const EVENTS_PAGE = 100;
const EVENT_PAGES = 5;

export interface SweepDeps {
  v1: V1Client;
  store: TaskStore;
  eventStore: EventStore;
  tasks: TasksService;
  events: TaskEvents;
  computer: Pick<Computer, 'userIdFor'>;
  follow: (conversationId: string, tripId: string) => void;
  desk: Brain['desk'];
  packs: Pick<Brain['packs'], 'get'>;
  now: () => Date;
  log: { warn(obj: object, msg: string): void };
  askTtlMs?: number;
}
export interface SweepReport { polled: number; checked: number; expired: number; dropped: number }
export interface Sweep {
  runOnce(): Promise<SweepReport>;
  start(everyMs?: number): void;
  /** Clears the timer and waits for a sweep in flight, so nothing reads the pool after Go stops. */
  stop(): Promise<void>;
}

export function createSweep(d: SweepDeps): Sweep {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<unknown> | null = null;

  async function newest(): Promise<string | null> {
    const page = await d.v1.call<{ data: PlatformEvent[] }>('GET', '/v1/events', { query: { limit: 1 } });
    return page.data[0]?.id ?? null;
  }

  /** /v1's events after the cursor, oldest first, each applied once (webhooks share the seen list). */
  async function pollEvents(): Promise<number> {
    const cursor = await d.eventStore.cursor('events');
    if (!cursor) {
      // First run: start from now. What came before is covered by reading each job's status.
      const id = await newest();
      if (id) await d.eventStore.setCursor('events', id);
      return 0;
    }
    let after = cursor;
    let applied = 0;
    for (let page = 0; page < EVENT_PAGES; page += 1) {
      let got: { data: PlatformEvent[] };
      try {
        got = await d.v1.call<{ data: PlatformEvent[] }>('GET', '/v1/events', { query: { after, limit: EVENTS_PAGE } });
      } catch (err) {
        if (err instanceof V1Error && err.status === 404) {
          // The cursor's event is past /v1's 30 days: start again from now.
          const id = await newest();
          if (id) await d.eventStore.setCursor('events', id);
          return applied;
        }
        throw err;
      }
      for (const e of got.data) {
        if (await d.eventStore.markSeen(e.id, e.type)) {
          try {
            await d.events.apply(toV1Event(e, 'poll'));
            applied += 1;
          } catch (err) {
            await d.eventStore.unmarkSeen(e.id);
            throw err;
          }
        }
        after = e.id;
        await d.eventStore.setCursor('events', after);
      }
      if (got.data.length < EVENTS_PAGE) break;
    }
    return applied;
  }

  /** The job's status and to-do list, as /v1 has them. */
  async function checkJob(row: TaskRow): Promise<void> {
    if (!row.v1TaskId) return;
    const task = await d.v1.call<{ status: string; progress?: Array<{ content: string; status: string }> }>('GET', `/v1/tasks/${row.v1TaskId}`);
    if (task.status === 'done') {
      await d.events.apply({ type: 'task.completed', data: { task_id: row.v1TaskId }, source: 'sweep' });
      return;
    }
    if (task.status === 'failed') {
      await d.events.apply({ type: 'task.failed', data: { task_id: row.v1TaskId, message: 'The computer reported a problem.' }, source: 'sweep' });
      return;
    }
    if (task.progress && task.progress.length > 0 && JSON.stringify(stepsFromTodos(task.progress)) !== JSON.stringify(row.steps)) {
      await d.events.apply({ type: 'task.progress', data: { task_id: row.v1TaskId, todos: task.progress }, source: 'sweep' });
    }
  }

  /** Asks /v1 has open on a conversation that Go never heard about. */
  async function missedAsks(conversationId: string): Promise<void> {
    const conv = await d.v1.call<{ open_interactions?: Array<{ interaction_id: string; task_id: string | null }> }>('GET', `/v1/conversations/${conversationId}`);
    const known = new Set((await d.store.allOpenInteractions()).map((i) => i.interactionId));
    for (const ask of conv.open_interactions ?? []) {
      if (known.has(ask.interaction_id)) continue;
      await d.events.apply({ type: 'interaction.created', data: { interaction_id: ask.interaction_id, ...(ask.task_id ? { task_id: ask.task_id } : {}) }, source: 'sweep' });
    }
  }

  async function settleOldAsks(): Promise<{ expired: number; dropped: number }> {
    const ttl = d.askTtlMs ?? ASK_TTL_MS;
    const nowMs = d.now().getTime();
    let expired = 0;
    let dropped = 0;
    for (const ask of await d.store.allOpenInteractions()) {
      if (nowMs - ask.createdAt.getTime() < ttl) continue;
      const row = await d.store.get(ask.taskId);
      if (!row || !LIVE_STATES.includes(row.state)) {
        await d.store.setInteraction(ask.interactionId, 'cancelled', d.now());
        continue;
      }
      if (ask.type === 'handoff') {
        const pack = await d.packs.get(row.tripId);
        const who = pack.trip.people.find((p) => p.person_id === ask.forPersonIds[0])?.name ?? 'The person it needed';
        await d.tasks.expire(row.id, 'handoff_expired', `${who} wasn't around to help, so Go stopped it.`);
        expired += 1;
      } else if (ask.type === 'question') {
        await d.v1.call('POST', `/v1/interactions/${ask.interactionId}/cancel`, { body: { reason: 'Nobody answered in time.' } }).catch(() => undefined);
        await d.store.setInteraction(ask.interactionId, 'cancelled', d.now());
        const wake: TaskWake = { event: 'question_dropped', taskId: row.id, title: row.title, question: clip(ask.questions[0]?.question ?? ask.summary ?? 'its question', 300) };
        await d.desk.put({ id: `task:${row.id}:dropped:${ask.interactionId}`, tripId: row.tripId, kind: 'task', ref: row.id, dueAt: d.now(), payload: wake });
        dropped += 1;
      }
    }
    return { expired, dropped };
  }

  async function runOnce(): Promise<SweepReport> {
    const report: SweepReport = { polled: 0, checked: 0, expired: 0, dropped: 0 };
    try {
      report.polled = await pollEvents();
    } catch (err) {
      d.log.warn({ err }, "tasks: the sweep could not read /v1's events");
    }
    const live = await d.store.listLive();
    for (const tripId of new Set(live.filter((r) => r.state === 'queued').map((r) => r.tripId))) await d.tasks.startQueued(tripId);
    const conversations = new Map<string, string>();
    const nowMs = d.now().getTime();
    for (const seen of live) {
      try {
        let row = await d.store.get(seen.id);
        if (!row || !LIVE_STATES.includes(row.state)) continue;
        if (row.state === 'starting' && !row.v1TurnId && nowMs - row.createdAt.getTime() > DISPATCH_GRACE_MS) {
          await d.tasks.dispatch(row.id);
          row = await d.store.get(row.id);
        }
        if (row?.v1TurnId && !row.v1TaskId && nowMs - row.createdAt.getTime() > START_GRACE_MS) {
          await d.tasks.findStart(row);
          row = await d.store.get(row.id);
        }
        if (row?.v1TaskId && (row.state === 'running' || row.state === 'needs_you')) {
          await checkJob(row);
          report.checked += 1;
          row = await d.store.get(row.id);
        }
        if (row && LIVE_STATES.includes(row.state) && row.deadlineAt && row.deadlineAt.getTime() < nowMs) {
          await d.tasks.expire(row.id, 'deadline', 'It took too long, so Go stopped it.');
          report.expired += 1;
          continue;
        }
        if (row?.conversationId && ACTIVE_STATES.includes(row.state)) conversations.set(row.conversationId, row.tripId);
      } catch (err) {
        d.log.warn({ err, taskId: seen.id }, 'tasks: the sweep could not check a job');
      }
    }
    // Jobs stopped before Go heard /v1 name them: once their start is found, mapStarts stops them on /v1 too.
    for (const row of await d.store.unnamedStops(new Date(nowMs - UNNAMED_STOP_MS))) {
      try {
        await d.tasks.findStart(row);
      } catch (err) {
        d.log.warn({ err, taskId: row.id }, "tasks: the sweep could not look up a stopped job's start");
      }
    }
    for (const [conversationId, tripId] of conversations) {
      try {
        await missedAsks(conversationId);
        d.follow(conversationId, tripId);
      } catch (err) {
        d.log.warn({ err, conversationId }, 'tasks: the sweep could not read a conversation');
      }
    }
    const asks = await settleOldAsks();
    report.expired += asks.expired;
    report.dropped = asks.dropped;
    return report;
  }

  return {
    runOnce,
    start(everyMs = SWEEP_EVERY_MS) {
      if (timer || everyMs <= 0) return;
      timer = setInterval(() => {
        if (running) return;
        running = runOnce()
          .catch((err: unknown) => d.log.warn({ err }, 'tasks: a sweep failed'))
          .finally(() => {
            running = null;
          });
      }, everyMs);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
  };
}
