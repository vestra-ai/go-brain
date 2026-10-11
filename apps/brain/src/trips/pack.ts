import type pg from 'pg';
import type { Message, Trip, TripEvent } from '../door/methods.js';
import type { ServerLink } from '../door/server-link.js';
import type { Log } from '../log.js';
import { applyEvent, upsertMessage } from './apply.js';
import { TripGoneError } from './gone.js';
import { isPrivate, screenMessage } from './screen.js';

/** An active trip's working set, kept fresh from events. */
export interface TripPack {
  /** TripSnapshot as read_trip returns it, kept current from events. */
  trip: Trip;
  /** The whole chat, oldest first, deletes removed. */
  messages: Message[];
  seq: number;
}

/**
 * A message as the model names it: "#57" or "57", the number the chat shows it under, or its message id. The model only
 * ever sees the numbers, so a tool that looked messages up by id alone never found one (Varkala, 11 Oct: the organizer's
 * "Yes please do it @Go", cited as proof for the title, was no message in the trip, and the change was refused).
 */
export function messageByRef(messages: readonly Message[], ref: string): Message | undefined {
  const n = /^#?(\d+)$/.exec(ref.trim());
  return n ? messages.find((m) => m.seq === Number(n[1])) : messages.find((m) => m.message_id === ref);
}

export interface Packs {
  get(tripId: string): Promise<TripPack>;
  invalidate(tripId: string): void;
}

export type PacksImpl = Packs & {
  /** Keeps a loaded pack current; stores every message whether or not the pack is loaded. */
  apply(ev: TripEvent): Promise<void>;
  /** read_trip plus read_messages after `after` (default: the newest change Go stored); returns messages Go never stored. */
  refill(tripId: string, after?: number): Promise<Message[]>;
  /** Trips whose pack was used within `withinMs` (default 6 hours). */
  active(withinMs?: number): string[];
  peek(tripId: string): TripPack | undefined;
};

/** Stores a message (newest change wins). True when Go had never stored it before. */
async function storeMessage(pool: pg.Pool, tripId: string, m: Message, now: Date): Promise<boolean> {
  const payload = m.deleted ? { ...m, text: null } : m;
  const r = await pool.query<{ inserted: boolean }>(
    `insert into messages (trip_id, message_id, seq, updated_seq, person_id, text, reply_to, deleted_at, payload)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     on conflict (trip_id, message_id) do update
       set updated_seq = excluded.updated_seq, text = excluded.text, deleted_at = excluded.deleted_at, payload = excluded.payload
       where messages.updated_seq <= excluded.updated_seq
     returning (xmax = 0) as inserted`,
    [
      tripId,
      m.message_id,
      m.seq,
      m.updated_seq,
      m.author.kind === 'person' ? m.author.person_id : null,
      m.deleted ? null : (m.text ?? null),
      m.reply_to ?? null,
      m.deleted ? now : null,
      JSON.stringify(payload),
    ],
  );
  return r.rows[0]?.inserted === true;
}

export function createPacks(o: { pool: pg.Pool; link: ServerLink; log: Log; now: () => Date }): PacksImpl {
  const packs = new Map<string, TripPack>();
  const touched = new Map<string, number>();
  const loading = new Map<string, Promise<TripPack>>();
  const touch = (tripId: string): void => {
    touched.set(tripId, o.now().getTime());
  };

  async function storedUpTo(tripId: string): Promise<number> {
    const { rows } = await o.pool.query<{ n: number }>('select coalesce(max(updated_seq), 0)::int as n from messages where trip_id = $1', [tripId]);
    return rows[0]?.n ?? 0;
  }

  /**
   * Where a cold load starts reading. A trip whose events Go never finished processing (its first event, or a trip Go
   * meets for the first time) is read from the start: the one message its first event stored is not its history.
   */
  async function loadFrom(tripId: string): Promise<number> {
    const { rows } = await o.pool.query<{ processed_seq: number }>('select processed_seq from trips where trip_id = $1', [tripId]);
    return (rows[0]?.processed_seq ?? 0) > 0 ? storedUpTo(tripId) : 0;
  }

  /**
   * Reads messages changed after `after`, page by page while has_more; screens and stores them; returns the ones Go never
   * stored. It only stores: waking Go for what it returns is the caller's choice.
   */
  async function pull(tripId: string, after: number, pack: TripPack): Promise<Message[]> {
    const fresh: Message[] = [];
    let cursor = after;
    for (let page = 0; page < 50; page++) {
      const r = await o.link.request('read_messages', { trip_id: tripId, after_seq: cursor, limit: 200 });
      for (const raw of r.messages) {
        const m = screenMessage(raw);
        if (await storeMessage(o.pool, tripId, m, o.now())) fresh.push(m);
        upsertMessage(pack, m);
        cursor = Math.max(cursor, m.updated_seq);
      }
      if (!r.has_more || r.messages.length === 0) break;
    }
    return fresh;
  }

  /** A trip marked gone is never read again from here: a stale refresh, a waiting turn or its retry all stop at this. */
  async function notGone(tripId: string): Promise<void> {
    const { rowCount } = await o.pool.query('select 1 from trips where trip_id = $1 and gone_at is not null', [tripId]);
    if ((rowCount ?? 0) > 0) throw new TripGoneError(tripId);
  }

  async function load(tripId: string): Promise<TripPack> {
    await notGone(tripId);
    const trip = await o.link.request('read_trip', { trip_id: tripId });
    const { rows } = await o.pool.query<{ payload: Message }>(
      'select payload from messages where trip_id = $1 and deleted_at is null order by seq',
      [tripId],
    );
    // A message only some people see is never in the pack (screen.ts): no turn reads it.
    const pack: TripPack = { trip, messages: rows.map((r) => r.payload).filter((m) => !isPrivate(m)), seq: trip.seq };
    // History read at load is stored only, never handed to intake, so it never wakes Go.
    await pull(tripId, await loadFrom(tripId), pack);
    packs.set(tripId, pack);
    return pack;
  }

  async function get(tripId: string): Promise<TripPack> {
    touch(tripId);
    const have = packs.get(tripId);
    if (have) return have;
    let p = loading.get(tripId);
    if (!p) {
      p = load(tripId).finally(() => loading.delete(tripId));
      loading.set(tripId, p);
    }
    return p;
  }

  return {
    get,
    invalidate(tripId) {
      packs.delete(tripId);
    },
    peek: (tripId) => packs.get(tripId),
    async apply(ev) {
      touch(ev.trip_id);
      if (ev.type === 'message.created' || ev.type === 'message.edited') {
        await storeMessage(o.pool, ev.trip_id, ev.data.message, o.now());
      }
      if (ev.type === 'message.deleted') {
        await o.pool.query(
          `update messages set deleted_at = $3, text = null, payload = (payload - 'text') || '{"deleted": true}'::jsonb
           where trip_id = $1 and message_id = $2`,
          [ev.trip_id, ev.data.message_id, o.now()],
        );
      }
      if (ev.type === 'trip.created' && !packs.has(ev.trip_id)) {
        packs.set(ev.trip_id, { trip: ev.data.trip, messages: [], seq: ev.seq });
        return;
      }
      const pack = packs.get(ev.trip_id);
      if (!pack) return; // not loaded: the next get() reads it fresh
      if (applyEvent(pack, ev) === 'reread') pack.trip = await o.link.request('read_trip', { trip_id: ev.trip_id });
      pack.seq = Math.max(pack.seq, ev.seq);
    },
    async refill(tripId, after) {
      const pack = await get(tripId);
      await notGone(tripId);
      pack.trip = await o.link.request('read_trip', { trip_id: tripId });
      pack.seq = Math.max(pack.seq, pack.trip.seq);
      return pull(tripId, after ?? (await storedUpTo(tripId)), pack);
    },
    active(withinMs = 6 * 60 * 60_000) {
      const since = o.now().getTime() - withinMs;
      return [...touched].filter(([id, at]) => at >= since && packs.has(id)).map(([id]) => id);
    },
  };
}
