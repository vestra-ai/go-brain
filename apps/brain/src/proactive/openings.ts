// Openings: moments Go might help without being asked, from the chat (the reflex's opening question)
// and from trip changes. Also the two signals that make Go quieter: a hush, and nudges people ignored.
import type { Message, Trip, TripEvent } from '../door/methods.js';
import type { ReflexRead } from '../reflex/reflex.js';
import { plainlyNamesGo } from '../trips/names-go.js';
import type { Packs, TripPack } from '../trips/pack.js';
import type { Action, Candidate } from './policy.js';
import type { ProactiveStore } from './store.js';
import { dateClashes } from './timers.js';

export const HUSH_RE =
  /\b(hush|shush|be quiet|keep quiet|shut up|chup( kar| karo| raho| ho ja)?|bas kar(o)?|stop pinging|stop messaging|stop spamming|too many messages)\b/i;
export const CHAT_WAIT_MS = 15_000;
export const CHAT_EXPIRES_MS = 10 * 60_000;
export const IGNORED_AFTER_MS = 6 * 3600_000;
const CHANGE_WAIT_MS = 3_000;
const CHANGE_EXPIRES_MS = 6 * 3600_000;

/** Trip changes that can move a timer or a watch, or open something worth saying. */
export const REPLAN_ON: ReadonlySet<string> = new Set([
  'trip.created', 'trip.updated', 'decision.opened', 'decision.voted', 'decision.closed', 'decision.cancelled',
  'mandate.set', 'mandate.confirmed', 'mandate.declined', 'booking.changed',
]);

export function talksToGo(msg: Message, pack: TripPack): boolean {
  if (msg.mentions_go) return true;
  if (!msg.reply_to) return false;
  return pack.messages.some((m) => m.message_id === msg.reply_to && m.author.kind === 'go');
}

export function isHush(msg: Message, pack: TripPack): boolean {
  return msg.author.kind === 'person' && typeof msg.text === 'string' && talksToGo(msg, pack) && HUSH_RE.test(msg.text);
}

/**
 * A message that names Go is the composer's to answer (P1 wakes it). An opening is only for a message the reflex is
 * sure is not for Go, so the same message never gets both an answer and an unprompted post.
 */
export function chatOpening(msg: Message, read: ReflexRead, pack: TripPack, now: Date): Candidate | null {
  if (msg.author.kind !== 'person' || msg.withheld || msg.deleted || msg.mentions_go) return null;
  if (!(read.opening.sure && read.opening.value === true)) return null;
  if (!(read.forGo.sure && read.forGo.value === false) || plainlyNamesGo(msg, pack)) return null;
  const tripId = pack.trip.trip_id;
  return {
    tripId,
    dedupeKey: `chat:${msg.message_id}`,
    source: 'opening',
    topic: 'chat',
    dueAt: new Date(now.getTime() + CHAT_WAIT_MS),
    expiresAt: new Date(now.getTime() + CHAT_EXPIRES_MS),
    importance: 0.6,
    confidence: 0.9,
    urgency: 0.9,
    useful: ['react', 'record', 'message'],
    personIds: [],
    facts: { message_id: msg.message_id, seq: msg.seq },
    simulated: false,
    small: false,
  };
}

export function tripChangeOpenings(ev: TripEvent, trip: Trip, now: Date): Candidate[] {
  const make = (o: { key: string; topic: string; importance: number; urgency: number; useful: Action[]; facts: Record<string, unknown> }): Candidate => ({
    tripId: ev.trip_id,
    dedupeKey: o.key,
    source: 'opening',
    topic: o.topic,
    dueAt: new Date(now.getTime() + CHANGE_WAIT_MS),
    expiresAt: new Date(now.getTime() + CHANGE_EXPIRES_MS),
    importance: o.importance,
    confidence: 1,
    urgency: o.urgency,
    useful: o.useful,
    personIds: [],
    facts: o.facts,
    simulated: false,
    small: false,
  });
  const clashes = (): Candidate[] =>
    dateClashes(trip).map((x) =>
      make({
        key: `dates_clash:${x.booking_id}:${trip.dates?.start ?? ''}:${trip.dates?.end ?? ''}`,
        topic: 'dates_clash',
        importance: 0.9,
        urgency: 0.8,
        useful: ['message'],
        facts: { booking_id: x.booking_id, title: x.title, starts_at: x.starts_at, ends_at: x.ends_at, start: trip.dates?.start ?? null, end: trip.dates?.end ?? null },
      }),
    );

  switch (ev.type) {
    // A closed vote is not an opening: P1's intake already wakes the composer for it and Go announces the result.
    case 'booking.changed': {
      const b = ev.data.booking;
      if (ev.data.change === 'cancelled' && ev.data.by.kind !== 'go') {
        const by = ev.data.by.kind === 'person' ? ev.data.by.person_id : null;
        return [make({ key: `booking_cancelled:${b.booking_id}`, topic: 'booking_cancelled', importance: 0.8, urgency: 0.8, useful: ['message'], facts: { booking_id: b.booking_id, title: b.title, by } })];
      }
      return ev.data.change === 'added' ? clashes() : [];
    }
    case 'trip.updated':
      return ev.data.changed.includes('dates') ? clashes() : [];
    default:
      return [];
  }
}

/**
 * Did anyone react to, reply to, or talk to Go after an unprompted post? The post is Go's messages in the
 * two minutes after the promotion. A nudge that posted nothing is never "ignored".
 */
export function wasEngaged(pack: TripPack, decidedAt: Date, windowMs: number): boolean {
  const from = decidedAt.getTime();
  const until = from + windowMs;
  const goIds = new Set<string>();
  for (const m of pack.messages) {
    const t = Date.parse(m.sent_at);
    if (m.author.kind === 'go' && t >= from && t <= from + 120_000) goIds.add(m.message_id);
  }
  if (goIds.size === 0) return true;
  for (const m of pack.messages) {
    if (goIds.has(m.message_id) && m.reactions.some((r) => r.person_id != null)) return true;
    const t = Date.parse(m.sent_at);
    if (m.author.kind !== 'person' || t < from || t > until) continue;
    if ((m.reply_to && goIds.has(m.reply_to)) || m.mentions_go) return true;
  }
  return false;
}

export interface OpeningsDeps {
  store: ProactiveStore;
  packs: Pick<Packs, 'get'>;
  /** `read_trip` on the socket: `trip.updated` carries no values. */
  readTrip(tripId: string): Promise<Trip>;
  /** Re-plans timers and watches from the trip as it is now. */
  replan(tripId: string, trip: Trip): Promise<void>;
  now: () => Date;
}

export function createOpenings(d: OpeningsDeps) {
  return {
    async onRead(msg: Message, read: ReflexRead, pack: TripPack): Promise<void> {
      const tripId = pack.trip.trip_id;
      if (isHush(msg, pack)) await d.store.hush(tripId, d.now());
      const c = chatOpening(msg, read, pack, d.now());
      if (c) await d.store.add(c);
    },

    async onEvent(ev: TripEvent): Promise<void> {
      if (!REPLAN_ON.has(ev.type)) return;
      const trip = ev.type === 'trip.created'
        ? ev.data.trip
        : ev.type === 'trip.updated' ? await d.readTrip(ev.trip_id) : (await d.packs.get(ev.trip_id)).trip;
      for (const c of tripChangeOpenings(ev, trip, d.now())) await d.store.add(c);
      await d.replan(ev.trip_id, trip);
    },

    async checkIgnored(): Promise<number> {
      const now = d.now();
      let ignored = 0;
      for (const row of await d.store.toCheckForIgnored(new Date(now.getTime() - IGNORED_AFTER_MS))) {
        const pack = await d.packs.get(row.tripId);
        if (!wasEngaged(pack, row.decidedAt, IGNORED_AFTER_MS)) {
          await d.store.ignored(row.tripId, now);
          ignored += 1;
        }
        await d.store.ignoreChecked(row.tripId, row.dedupeKey, now);
      }
      return ignored;
    },
  };
}
