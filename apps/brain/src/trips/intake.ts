import type pg from 'pg';
import type { Speak } from '../composer/speak.js';
import type { Desk } from '../desk/desk.js';
import type { ToGoHandler } from '../door/handlers.js';
import type { Message, TripEvent } from '../door/methods.js';
import type { Log } from '../log.js';
import { UNSURE_READ, type Reflex, type ReflexRead } from '../reflex/reflex.js';
import type { HooksImpl } from './hooks.js';
import type { TripLogImpl } from './log.js';
import { namesGoInText, plainlyNamesGo } from './names-go.js';
import type { PacksImpl } from './pack.js';
import { screenEvent } from './screen.js';
import type { SetupImpl } from './setup.js';

export interface IntakeDeps {
  pool: pg.Pool;
  log: Log;
  now: () => Date;
  tripLog: TripLogImpl;
  packs: PacksImpl;
  setup: SetupImpl;
  desk: Desk;
  speak: Speak;
  hooks: HooksImpl;
  /** Read at call time: P2 replaces brain.reflex after boot wiring. */
  reflex: () => Reflex;
  runningTasks: (tripId: string) => Promise<Array<{ id: string; brief: string }>>;
  /** The wait after a message for Go, unless the reflex is sure the thought is complete. */
  waitMs?: number;
}

export function createIntake(d: IntakeDeps) {
  const waitMs = d.waitMs ?? 2_000;
  const queues = new Map<string, Promise<void>>();
  const processed = new Map<string, number>();
  const handled = new Set<string>();

  /** One trip's events are handled one at a time, in the order they arrived (the Server sends them in seq order). */
  function enqueue(tripId: string, job: () => Promise<void>): Promise<void> {
    const next = (queues.get(tripId) ?? Promise.resolve())
      .then(job)
      .catch((e: unknown) => d.log.error({ err: e, trip: tripId }, 'handling a trip event failed'));
    queues.set(tripId, next);
    void next.then(() => {
      if (queues.get(tripId) === next) queues.delete(tripId);
    });
    return next;
  }

  async function processedSeq(tripId: string): Promise<number> {
    const hit = processed.get(tripId);
    if (hit !== undefined) return hit;
    const { rows } = await d.pool.query<{ processed_seq: number }>('select processed_seq from trips where trip_id = $1', [tripId]);
    const v = rows[0]?.processed_seq ?? 0;
    processed.set(tripId, v);
    return v;
  }

  async function setProcessed(tripId: string, seq: number): Promise<void> {
    processed.set(tripId, Math.max(seq, processed.get(tripId) ?? 0));
    await d.pool.query('update trips set processed_seq = greatest(processed_seq, $2) where trip_id = $1', [tripId, seq]);
  }

  function remember(messageId: string): void {
    handled.add(messageId);
    if (handled.size > 10_000) {
      const oldest = handled.values().next().value;
      if (oldest !== undefined) handled.delete(oldest);
    }
  }

  /** A person's message: typing at once if it names Go, then the reflex, the lanes' hooks, and the desk. */
  async function onMessage(tripId: string, m: Message): Promise<void> {
    if (m.author.kind !== 'person' || m.withheld || m.deleted) return;
    const key = `${tripId}:${m.message_id}`;
    if (handled.has(key)) return;
    if (m.mentions_go || namesGoInText(m.text)) d.speak.typingOn(tripId);
    const pack = await d.packs.get(tripId);
    const namesGo = plainlyNamesGo(m, pack);
    if (namesGo && !(m.mentions_go || namesGoInText(m.text))) d.speak.typingOn(tripId); // a reply to Go
    let read: ReflexRead;
    try {
      read = await d.reflex().read(m, { pack, runningTasks: await d.runningTasks(tripId).catch(() => []) });
    } catch (e) {
      d.log.warn({ err: e, message: m.message_id }, 'the reflex failed; the composer decides');
      read = UNSURE_READ;
    }
    await d.hooks.run(m, read, pack);
    // Sure chatter never wakes the model, but a message that names Go always does.
    if (namesGo || !(read.forGo.sure && read.forGo.value === false)) {
      const now = d.now();
      const complete = read.complete.sure && read.complete.value === true;
      await d.desk.put({
        id: `msg:${tripId}:${m.message_id}`,
        tripId,
        kind: 'message',
        ref: m.message_id,
        dueAt: complete ? now : new Date(now.getTime() + waitMs),
        payload: { messageId: m.message_id, seq: m.seq, namesGo },
      });
    }
    // Remembered only once read and on the desk: if anything above failed, the next gap check or a restart handles it again.
    remember(key);
  }

  /** P1's own reactions to an event; lanes add theirs with tripLog.onEvent. */
  async function react(ev: TripEvent): Promise<void> {
    if (ev.type === 'message.created') {
      await onMessage(ev.trip_id, ev.data.message);
      return;
    }
    if (ev.type === 'message.deleted') {
      await d.desk.cancel(ev.trip_id, ev.data.message_id);
      return;
    }
    if (ev.type === 'decision.closed' && ev.data.reason !== 'closed_by_go') {
      const decisionId = ev.data.decision.decision_id;
      await d.desk.put({
        id: `change:${ev.event_id}`,
        tripId: ev.trip_id,
        kind: 'trip_change',
        ref: `decision:${decisionId}`,
        dueAt: d.now(),
        payload: { type: ev.type, decisionId, reason: ev.data.reason },
      });
    }
  }

  /**
   * Holding change `from` and receiving `to` > from + 1: read the trip and every message after `from`, then
   * handle each message posted in between that this copy has not handled yet (missed, or stored by an event whose
   * handling failed).
   */
  async function fillGap(tripId: string, from: number, to: number): Promise<void> {
    d.log.info({ trip: tripId, from, to }, 'missed events: reading the trip again');
    await d.packs.refill(tripId, from);
    const pack = await d.packs.get(tripId);
    for (const m of pack.messages.filter((x) => x.seq > from && x.seq < to)) await onMessage(tripId, m);
  }

  async function processEvent(ev: TripEvent): Promise<void> {
    const tripId = ev.trip_id;
    const before = await processedSeq(tripId);
    if (ev.seq <= before) return;
    if (ev.type !== 'trip.created' && before > 0 && ev.seq > before + 1) await fillGap(tripId, before, ev.seq);
    await d.packs.apply(ev);
    // Setup runs on trip.created and on any event for a trip not set up yet; it never holds up the events.
    d.setup.ensureSoon(tripId);
    await react(ev);
    await d.tripLog.emit(ev);
    await setProcessed(tripId, ev.seq);
  }

  const sendEvent: ToGoHandler<'send_event'> = async (raw) => {
    // People's text is screened before it is written anywhere: from here on, every copy holds the masked text.
    const ev = screenEvent(raw);
    const r = await d.tripLog.append(ev);
    // Answered as soon as the event is written; the work happens after, in seq order per trip.
    if (r === 'new') void enqueue(ev.trip_id, () => processEvent(ev));
    return { accepted: true, duplicate: r === 'duplicate' };
  };

  return {
    sendEvent,
    /** On boot: events written but never processed (a crash between the answer and the work). */
    async recover(): Promise<number> {
      const { rows } = await d.pool.query<{ payload: TripEvent }>(
        `select e.payload from trip_events e join trips t on t.trip_id = e.trip_id
         where e.seq > t.processed_seq order by e.trip_id, e.seq`,
      );
      for (const r of rows) void enqueue(r.payload.trip_id, () => processEvent(r.payload));
      return rows.length;
    },
    /** Once a minute: read every active trip again, as a net for anything both sides missed. */
    async refreshActive(): Promise<void> {
      for (const tripId of d.packs.active()) {
        void enqueue(tripId, async () => {
          const fresh = await d.packs.refill(tripId);
          for (const m of fresh.sort((a, b) => a.seq - b.seq)) await onMessage(tripId, m);
        });
      }
    },
    /** Waits until every trip's queue is empty (tests and shutdown). */
    async idle(): Promise<void> {
      while (queues.size) await Promise.all([...queues.values()]);
    },
  };
}
