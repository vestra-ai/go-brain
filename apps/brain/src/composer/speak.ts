import type * as C from '@go/contract';
import type pg from 'pg';
import type { ServerLink } from '../door/server-link.js';
import { clip, sanitize, sanitizeDeep } from './sanitize.js';

export interface PostArgs {
  link: ServerLink;
  tripId: string;
  turnId: string;
  /** A stable request id per write ('post' is the tag): the same on a rerun of the same turn. */
  requestId: (tag: string) => string;
  text: string | null;
  cards: C.Card[];
  replyTo?: string;
  mentions?: string[];
}

export interface Speak {
  /** "Go is typing..." now, for a message that plainly names Go. Goes off by itself after 12 s unless a turn keeps it. */
  typingOn(tripId: string): void;
  /** A turn is working: typing on (if it was not) and kept alive until typingOff. Returns when it first went on. */
  working(tripId: string): Date;
  typingOff(tripId: string): void;
  /** Posts the text with the first card, then each other card; returns the message ids. */
  post(p: PostArgs): Promise<string[]>;
  stopAll(): void;
}

interface TypingState {
  since: Date;
  until: number;
  timer?: NodeJS.Timeout;
}

export function createSpeak(o: {
  pool: pg.Pool;
  link: ServerLink;
  now: () => Date;
  everyMs?: number;
  idleKeepMs?: number;
  workKeepMs?: number;
}): Speak {
  const everyMs = o.everyMs ?? 5_000;
  const idleKeepMs = o.idleKeepMs ?? 12_000;
  const workKeepMs = o.workKeepMs ?? 25_000;
  const typing = new Map<string, TypingState>();
  const send = (tripId: string, on: boolean): void => o.link.notify('typing', { trip_id: tripId, on });

  function typingOff(tripId: string): void {
    const st = typing.get(tripId);
    if (!st) return;
    clearInterval(st.timer);
    typing.delete(tripId);
    send(tripId, false);
  }

  // "On" lasts 10 s on the Server, so it is sent again every 5 s while it should stay on.
  function keep(tripId: string, keepMs: number): Date {
    const cur = typing.get(tripId);
    if (cur) {
      cur.until = Math.max(cur.until, Date.now() + keepMs);
      return cur.since;
    }
    send(tripId, true);
    const st: TypingState = { since: o.now(), until: Date.now() + keepMs };
    st.timer = setInterval(() => {
      if (Date.now() >= st.until) typingOff(tripId);
      else send(tripId, true);
    }, everyMs);
    // Never keeps the process alive; buildBrain stops every interval through brain.onStop (speak.stopAll).
    st.timer.unref();
    typing.set(tripId, st);
    return st.since;
  }

  return {
    typingOn(tripId) {
      keep(tripId, idleKeepMs);
    },
    working(tripId) {
      return keep(tripId, workKeepMs);
    },
    typingOff,
    async post(p) {
      const text = p.text && p.text.trim() ? clip(sanitize(p.text), 2_000) : null;
      const cards = p.cards.map((c) => sanitizeDeep(c));
      const first = cards.shift();
      const ids: string[] = [];
      if (text || first) {
        const r = await p.link.request('post_message', {
          request_id: p.requestId('post'),
          trip_id: p.tripId,
          ...(text ? { text } : {}),
          ...(first ? { card: first } : {}),
          ...(p.replyTo ? { reply_to: p.replyTo } : {}),
          ...(p.mentions?.length ? { mentions: p.mentions } : {}),
        });
        ids.push(r.message_id);
      }
      for (const card of cards) {
        const r = await p.link.request('post_message', { request_id: p.requestId('post'), trip_id: p.tripId, card });
        ids.push(r.message_id);
      }
      if (ids.length) {
        await o.pool.query('update turns set posted_at = coalesce(posted_at, $2) where turn_id = $1', [p.turnId, o.now()]);
      }
      return ids;
    },
    stopAll() {
      for (const tripId of [...typing.keys()]) typingOff(tripId);
    },
  };
}
