import type pg from 'pg';
import type { Speak } from '../composer/speak.js';
import type { Desk } from '../desk/desk.js';
import type { ToGoHandler } from '../door/handlers.js';
import type { Message, Trip, TripEvent } from '../door/methods.js';
import type { Log } from '../log.js';
import { leftToPeople } from '../reflex/read.js';
import { UNSURE_READ, type Reflex, type ReflexRead } from '../reflex/reflex.js';
import type { HooksImpl } from './hooks.js';
import type { TripLogImpl } from './log.js';
import { answersToGo, followsGoAnswer } from '../composer/fence.js';
import { asksWhatTheyMissed, continuesAskToGo, endsThought, namesGoInText, plainlyNamesGo } from './names-go.js';
import { TripGoneError } from './gone.js';
import type { PacksImpl, TripPack } from './pack.js';
import { screenEvent } from './screen.js';
import type { SetupImpl } from './setup.js';
import { tripOfOne } from './votes.js';

/**
 * The group's stay, booked before this person joined, that is not theirs yet: they see neither it nor its voucher, and pay
 * no share of it. None for a trip of one, or a stay booked for one person.
 */
export function stayBookedBefore(trip: Trip, personId: string): Trip['bookings'][number] | null {
  if (tripOfOne(trip)) return null;
  return trip.bookings.find((b) => b.kind === 'stay' && b.status === 'confirmed' && b.for_person_ids.length > 1 && !b.for_person_ids.includes(personId)) ?? null;
}

/** send_event answers within 2 s (the contract); an answer slower than this is logged, with the event's type. */
export const SLOW_ANSWER_MS = 1_000;

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
  /** The wait after a message for Go, unless it is a whole thought (dueAtOnce). */
  waitMs?: number;
  /** The trip's own Server has been away for minutes (the link's away): the minute refresh reads nothing for it. */
  away?: (tripId: string) => Promise<boolean>;
  /** The link follows the trip's home to the socket its event came on (ServerLink.rehome), for its very next request. */
  rehome?: (tripId: string, home: { instance: string; server: string | null }) => void;
}

/**
 * Whether a person's message wakes the composer. One that names Go always does. A line the reflex leaves to the people
 * (question 11 sure there is nothing in it for Go, or question 1 sure it is banter: reflex/read.ts leftToPeople) never
 * does, and neither does asking the group what you missed: the App gives each person their own catch-up (the Server's
 * catch_up). Everything else does, a line no one spoke to Go in too: Go jumps in on most lines, wherever it can add
 * anything (Keshav, 10 Oct: "go can interfere in most of the messages"), and the turn decides whether it can.
 */
export function wakesComposer(namesGo: boolean, read: Pick<ReflexRead, 'banter' | 'actionable'>, text: string | null | undefined): boolean {
  if (namesGo) return true;
  return !(leftToPeople(read) || asksWhatTheyMissed(text));
}

/**
 * Whether a message that wakes the composer is a whole thought, due at once instead of waiting for more lines: the reflex
 * is sure it is complete; it plainly ends ("...?") and names Go, or ends a burst that named Go; or a hook read it as a
 * whole ask (a travel search it has already started). Lines that stop mid-burst ("@Go can you", "for my birthday on the
 * 7th") don't end plainly, so they still wait.
 */
export function dueAtOnce(m: Message, pack: TripPack, read: Pick<ReflexRead, 'complete'>, namesGo: boolean, hookDueNow: boolean): boolean {
  if (read.complete.sure && read.complete.value === true) return true;
  if (endsThought(m.text) && (namesGo || continuesAskToGo(m, pack))) return true;
  return hookDueNow;
}

export function createIntake(d: IntakeDeps) {
  const waitMs = d.waitMs ?? 2_000;
  const queues = new Map<string, Promise<void>>();
  /** Trips with a refresh waiting in their queue. */
  const refreshing = new Set<string>();
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
    const said = await d.hooks.run(m, read, pack);
    // Asked without Go's name ("I want to login again to ixigo", "koi flights dekh lo"): the quick read is sure the line
    // is for Go, so the turn takes it as an ask, as if it named Go (Keshav, 10 Oct: "go only responds to @go? this is not
    // right"). Banter stays the group's: the read is sure only above its bar.
    const asksGo = !namesGo && read.forGo.sure && read.forGo.value === true;
    // Not an ask, but the quick read is sure Go has something to do with it ("I'm veg", "let's do Goa in Nov?"): the turn
    // is told so, and jumps in.
    const actionable = !namesGo && !asksGo && read.actionable?.sure === true && read.actionable.value === true;
    if (asksGo) d.speak.typingOn(tripId);
    // A plain answer to Go's question, or a line going on from Go's answer to this person, is for Go though it names no
    // one (prod, 11 Oct 08:22: "also mention that he should be my roommate" after Go answered them got silence): it
    // always reaches the composer, which reads it as a reply (fence.ts) and still says nothing to an "ok".
    const toGo = !namesGo && (answersToGo(pack).has(m.message_id) || followsGoAnswer(pack).has(m.message_id));
    if (wakesComposer(namesGo || toGo, read, m.text)) {
      const now = d.now();
      const complete = dueAtOnce(m, pack, read, namesGo || asksGo, said.dueNow === true);
      await d.desk.put({
        id: `msg:${tripId}:${m.message_id}`,
        tripId,
        kind: 'message',
        ref: m.message_id,
        dueAt: complete ? now : new Date(now.getTime() + waitMs),
        payload: { messageId: m.message_id, seq: m.seq, namesGo, ...(asksGo ? { asksGo } : {}), ...(actionable ? { actionable } : {}) },
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
    // Someone joined after the group's stay was booked (Keshav, 12 Oct: "people joining later issues"): Go offers to split
    // it with them and finds their flights, which went out before they came (composer/wakes.ts, person.joined). Once a
    // person: the id holds, so a second join never asks again.
    if (ev.type === 'person.joined') {
      const personId = ev.data.person.person_id;
      const stay = stayBookedBefore((await d.packs.get(ev.trip_id)).trip, personId);
      if (stay) {
        await d.desk.put({
          id: `joined:${ev.trip_id}:${personId}`,
          tripId: ev.trip_id,
          kind: 'trip_change',
          ref: `person:${personId}`,
          dueAt: d.now(),
          payload: { type: ev.type, personId, bookingId: stay.booking_id },
        });
      }
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
    // The Server sent an event for the trip, so it has it: a trip marked gone comes back before anything reads it.
    const back = await d.pool.query('update trips set gone_at = null where trip_id = $1 and gone_at is not null', [tripId]);
    if ((back.rowCount ?? 0) > 0) d.log.info({ trip: tripId }, 'the Server has this trip again: Go picks it back up');
    if (ev.type !== 'trip.created' && before > 0 && ev.seq > before + 1) await fillGap(tripId, before, ev.seq);
    await d.packs.apply(ev);
    // Setup runs on trip.created and on any event for a trip not set up yet; it never holds up the events.
    d.setup.ensureSoon(tripId);
    await react(ev);
    // The Server reached Go for this trip, so it is back: a turn that waited on it runs now, together with this event's
    // message, so the asks it missed are answered in one reply.
    await d.desk.wake?.(tripId);
    await d.tripLog.emit(ev);
    await setProcessed(tripId, ev.seq);
  }

  const sendEvent: ToGoHandler<'send_event'> = async (raw, meta) => {
    const started = Date.now();
    // People's text is screened before it is written anywhere: from here on, every copy holds the masked text.
    const ev = screenEvent(raw);
    // The one write before the answer: the event, and the trip's home moved to the socket it came on (trips/log.ts),
    // which the link follows at once: the reply to this very message goes there.
    const from = { instance: meta.instance, server: meta.server ?? null };
    const r = await d.tripLog.append(ev, from);
    d.rehome?.(ev.trip_id, from);
    // Answered as soon as the event is written; the work happens after, in seq order per trip.
    if (r === 'new') void enqueue(ev.trip_id, () => processEvent(ev));
    const ms = Date.now() - started;
    if (ms > SLOW_ANSWER_MS) d.log.warn({ trip: ev.trip_id, type: ev.type, ms }, 'send_event was slow to answer: the event write waited');
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
        // One refresh waits per trip; behind a slow one, a second would only read the trip again.
        if (refreshing.has(tripId)) continue;
        refreshing.add(tripId);
        void enqueue(tripId, async () => {
          refreshing.delete(tripId);
          // Marked gone while this waited (its pack went with the mark): it is not read again.
          if (!d.packs.peek(tripId)) return;
          // Its Server has been away for minutes (a closed drill): another Server would only answer 404.
          if (await d.away?.(tripId)) return;
          try {
            const fresh = await d.packs.refill(tripId);
            for (const m of fresh.sort((a, b) => a.seq - b.seq)) await onMessage(tripId, m);
          } catch (e) {
            if (!(e instanceof TripGoneError)) throw e;
          }
        });
      }
    },
    /** Waits until every trip's queue is empty (tests and shutdown). */
    async idle(): Promise<void> {
      while (queues.size) await Promise.all([...queues.values()]);
    },
  };
}
