import type * as C from '@go/contract';
import type pg from 'pg';
import type { ServerLink } from '../door/server-link.js';
import { clip, sanitize, sanitizeDeep, stripIds, stripMessageRefs } from './sanitize.js';
import type { QuickReply } from './tools.js';

export interface PostArgs {
  link: ServerLink;
  tripId: string;
  turnId: string;
  /** A stable request id per write ('post' is the tag): the same on a rerun of the same turn. */
  requestId: (tag: string) => string;
  text: string | null;
  cards: C.Card[];
  replyTo?: string;
  /** 1.1: tap-to-answer choices under the message's words (offer_replies); sent only with words. */
  quickReplies?: QuickReply[];
  /** Given, it is sent as it is; left out, it comes from `people` named in the text. */
  mentions?: string[];
  /** The trip's people: the ones Go's text names go in mentions, so they get a push. */
  people?: ReadonlyArray<Pick<C.Person, 'person_id' | 'name' | 'go_paused'>>;
  /** 1.2: only these people see the post (visible_to_person_ids), and only they can be mentioned in it. */
  visibleTo?: string[];
}

type Named = Pick<C.Person, 'person_id' | 'name' | 'go_paused'>;
const firstOf = (name: string): string => name.trim().split(/\s+/)[0] ?? '';
const keyOf = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Go addresses people as "@FirstName" (Keshav, 11 Oct: "directed messages should send @name"). Each "@name" Go wrote that
 * is one person in the trip is written as theirs: "@saket" and "@Saket Diwakar" are "@Saket", a first name two people
 * share is written in full ("@Rahul Kapoor"), and an "@name" that is nobody, or more than one person, stays as written.
 * mentionsIn then puts them in mentions. Never someone who paused Go.
 */
export function atNames(text: string, people: ReadonlyArray<Named>): string {
  const shared = new Map<string, number>();
  for (const p of people) shared.set(keyOf(firstOf(p.name)), (shared.get(keyOf(firstOf(p.name))) ?? 0) + 1);
  // How each person is written after "@", by every way Go may have written them.
  const forms = new Map<string, string>();
  for (const p of people) {
    const full = p.name.trim().replace(/\s+/g, ' ');
    const first = firstOf(full);
    if (p.go_paused || first.length < 2 || keyOf(first) === 'go') continue;
    const alone = shared.get(keyOf(first)) === 1;
    if (alone) forms.set(keyOf(first), first);
    if (full.includes(' ')) forms.set(keyOf(full), alone ? first : full);
  }
  if (forms.size === 0) return text;
  const names = [...forms.keys()]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));
  // Never inside an address ("x@asha.com").
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}_.+-])@(${names.join('|')})(?![\\p{L}\\p{N}])`, 'giu'), (_all, said: string) => `@${forms.get(keyOf(said)) ?? said}`);
}

/**
 * The people Go's words name, as whole words: a first name ("Asha, you're the payer") or a full name, in any case and
 * next to any punctuation ("Rahul bhai, Priya ko bolo!"). "Asha" in "Ashanti" is not Asha. A first name two people share
 * goes only to the one named in full. Never someone who paused Go, never a member whose name is Go, at most 30.
 */
export function mentionsIn(text: string, people: ReadonlyArray<Pick<C.Person, 'person_id' | 'name' | 'go_paused'>>): string[] {
  const words = text.toLowerCase();
  const said = (name: string): boolean => {
    const n = name.trim().toLowerCase();
    if (n.length < 2 || n === 'go') return false;
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(words);
  };
  const first = (name: string): string => name.trim().split(/\s+/)[0] ?? '';
  const out: string[] = [];
  for (const p of people) {
    if (p.go_paused) continue;
    const shared = people.filter((q) => first(q.name).toLowerCase() === first(p.name).toLowerCase()).length > 1;
    const full = p.name.trim().includes(' ') && said(p.name);
    if (full || (!shared && said(first(p.name)))) out.push(p.person_id);
  }
  return [...new Set(out)].slice(0, 30);
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
      // Go's ids never reach people. Message numbers leave the words only; a card's "House #12" is an address.
      const cleaned = p.text && p.text.trim() ? sanitize(stripMessageRefs(stripIds(p.text)).text) : '';
      const words = cleaned && p.people ? atNames(cleaned, p.people) : cleaned;
      const text = words ? clip(words, 2_000) : null;
      const cards = p.cards.map((c) => sanitizeDeep(c));
      const first = cards.shift();
      const ids: string[] = [];
      // A private post mentions only people who can see it.
      const named = p.mentions ?? (text && p.people ? mentionsIn(text, p.people) : []);
      const mentions = p.visibleTo ? named.filter((id) => p.visibleTo!.includes(id)) : named;
      const visible = p.visibleTo?.length ? { visible_to_person_ids: p.visibleTo } : {};
      if (text || first) {
        const r = await p.link.request('post_message', {
          request_id: p.requestId('post'),
          trip_id: p.tripId,
          ...(text ? { text } : {}),
          ...(first ? { card: first } : {}),
          ...(p.replyTo ? { reply_to: p.replyTo } : {}),
          ...(mentions.length ? { mentions } : {}),
          ...(text && p.quickReplies?.length ? { quick_replies: p.quickReplies.map((q) => sanitizeDeep(q)) } : {}),
          ...visible,
        });
        ids.push(r.message_id);
      }
      for (const card of cards) {
        const r = await p.link.request('post_message', { request_id: p.requestId('post'), trip_id: p.tripId, card, ...visible });
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
