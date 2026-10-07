/**
 * One live event stream per trip conversation while any of its jobs runs, resumed from the last event number after
 * a drop. A resume point too old for /v1 (410) is replaced by the conversation's head (the sweep fills the gap); with
 * every key's streams in use, the same events are polled as JSON. Every event goes through apply(), so webhooks and
 * the sweep can deliver the same moments without doubling anything. The screen is read while a conversation is followed:
 * the timer ticks every second, and screens.ts decides when a picture is due.
 */
import type { EventStore } from './event-store.js';
import type { TaskEvents } from './events.js';
import type { Screens } from './screens.js';
import type { SseFrame } from './sse.js';
import type { TaskStore } from './store.js';
import { V1Error, type V1Client } from './v1-client.js';

export interface FollowerDeps {
  v1: V1Client;
  store: Pick<TaskStore, 'hasActiveIn'>;
  streams: Pick<EventStore, 'lastSeq' | 'setLastSeq' | 'resetLastSeq'>;
  apply: TaskEvents['apply'];
  screens: Screens;
  log: { warn(obj: object, msg: string): void };
  reconnectMs?: number[];
  quietMs?: number;
  pollMs?: number;
  screenMs?: number;
}
export interface Follower {
  ensure(conversationId: string, tripId: string): void;
  following(): string[];
  /** Aborts every stream and wait, waits for the loops to end, and follows nothing after. registerTasks calls it from brain.onStop. */
  close(): Promise<void>;
}

const RECONNECT_MS = [1_000, 2_000, 5_000, 10_000];
const POLL_SPELL_MS = 60_000;

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    t.unref();
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

export function createFollower(d: FollowerDeps): Follower {
  const loops = new Map<string, { abort: AbortController; done: Promise<void> }>();
  const reconnect = d.reconnectMs ?? RECONNECT_MS;
  let closed = false;

  async function handle(conversationId: string, f: SseFrame): Promise<void> {
    if (f.event === 'ping') return;
    if (f.event === 'error') {
      const e = f.data as { data?: { code?: unknown } } | null;
      throw new V1Error(0, typeof e?.data?.code === 'string' ? e.data.code : 'stream_error', 'The stream ended with an error.');
    }
    const e = f.data as { type?: unknown; data?: unknown } | null;
    if (typeof e?.type === 'string') {
      const data = e.data && typeof e.data === 'object' ? (e.data as Record<string, unknown>) : {};
      await d.apply({ type: e.type, data, conversationId, source: 'stream' });
    }
    if (f.id !== null) await d.streams.setLastSeq(conversationId, f.id);
  }

  /** A spell of polling the events as JSON, for when no key has a stream free. */
  async function poll(conversationId: string, signal: AbortSignal): Promise<void> {
    const until = Date.now() + POLL_SPELL_MS;
    while (!signal.aborted && Date.now() < until && (await d.store.hasActiveIn(conversationId))) {
      const after = (await d.streams.lastSeq(conversationId)) ?? 0;
      const page = await d.v1.call<{ data: Array<{ seq: number; type: string; data?: Record<string, unknown> }> }>('GET', `/v1/conversations/${conversationId}/events`, {
        query: { format: 'json', after, limit: 100 },
      });
      for (const e of page.data) {
        await d.apply({ type: e.type, data: e.data ?? {}, conversationId, source: 'stream' });
        await d.streams.setLastSeq(conversationId, e.seq);
      }
      await sleep(d.pollMs ?? 5_000, signal);
    }
  }

  async function run(conversationId: string, tripId: string, signal: AbortSignal): Promise<void> {
    const screenTimer = setInterval(() => {
      void d.screens.tick(tripId).catch(() => undefined);
    }, d.screenMs ?? 1_000);
    screenTimer.unref();
    let failures = 0;
    try {
      while (!signal.aborted && (await d.store.hasActiveIn(conversationId))) {
        try {
          const s = await d.v1.stream(`/v1/conversations/${conversationId}/events`, {
            lastEventId: await d.streams.lastSeq(conversationId),
            signal,
            ...(d.quietMs ? { quietMs: d.quietMs } : {}),
          });
          try {
            for await (const f of s.frames) {
              failures = 0;
              await handle(conversationId, f);
              // A job ends on its task's ending, or on the turn settling after it that leaves the conversation idle.
              const ending = f.event === 'task.completed' || f.event === 'task.failed' || f.event === 'task.stopped' || f.event === 'conversation.status';
              if (ending && !(await d.store.hasActiveIn(conversationId))) break;
            }
          } finally {
            s.close();
          }
        } catch (err) {
          if (signal.aborted) break;
          if (err instanceof V1Error && err.code === 'stream_expired') {
            const head = await d.v1.call<{ last_event_seq: number }>('GET', `/v1/conversations/${conversationId}`);
            await d.streams.resetLastSeq(conversationId, head.last_event_seq);
            d.log.warn({ conversationId }, 'tasks: the stream resume point was too old; following from the head, the sweep fills the gap');
            continue;
          }
          if (err instanceof V1Error && err.code === 'too_many_streams') {
            await poll(conversationId, signal);
            continue;
          }
          d.log.warn({ err, conversationId }, 'tasks: the event stream dropped; reopening it');
        }
        if (signal.aborted || !(await d.store.hasActiveIn(conversationId))) break;
        failures += 1;
        await sleep(reconnect[Math.min(failures - 1, reconnect.length - 1)] ?? 1_000, signal);
      }
    } finally {
      clearInterval(screenTimer);
    }
  }

  const follower: Follower = {
    ensure(conversationId, tripId) {
      // Once Go is stopping, a job's follow() or the sweep must not open a new stream.
      if (closed || loops.has(conversationId)) return;
      const abort = new AbortController();
      const done = run(conversationId, tripId, abort.signal)
        .catch((err: unknown) => d.log.warn({ err, conversationId }, 'tasks: following a conversation stopped'))
        .finally(async () => {
          loops.delete(conversationId);
          // A job that started while this loop was ending must not go unfollowed.
          if (!abort.signal.aborted && (await d.store.hasActiveIn(conversationId).catch(() => false))) follower.ensure(conversationId, tripId);
        });
      loops.set(conversationId, { abort, done });
    },
    following: () => [...loops.keys()],
    async close() {
      closed = true;
      for (const l of loops.values()) l.abort.abort();
      await Promise.allSettled([...loops.values()].map((l) => l.done));
    },
  };
  return follower;
}
