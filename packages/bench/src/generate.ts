/**
 * Long chats from a short hand-written skeleton. The skeleton holds every line that matters;
 * seeded filler fills the long quiet stretches with ordinary group chatter. Same skeleton and
 * seed, same bytes.
 */
import { ChatLine, checkChat, type Chat, type ReflexLabel, type Speak } from './chat.js';

/** mulberry32: small, fast, and the same on every machine. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SkeletonSay {
  kind: 'say';
  at: number;
  /** A name other entries and recall probes use to point at this line. */
  ref?: string;
  person: string;
  text: string;
  speak: Speak;
  quiet_ok?: true;
  photo?: string;
  reply?: string;
  reflex?: ReflexLabel;
  recall?: Array<{ question: string; answer: string; ref: string }>;
  note?: string;
  /** Nobody talks between this line and the next skeleton line (a night). */
  quietAfter?: true;
}
export interface SkeletonEdit { kind: 'edit'; at: number; ref: string; text: string }
export interface SkeletonDelete { kind: 'delete'; at: number; ref: string }
export interface SkeletonReact { kind: 'react'; at: number; ref: string; person: string; emoji: string }
export type SkeletonEntry = SkeletonSay | SkeletonEdit | SkeletonDelete | SkeletonReact;
export interface Skeleton {
  name: string;
  seed: number;
  /** Total messages in the finished chat, skeleton and filler together. */
  messages: number;
  entries: SkeletonEntry[];
}

export const DAY = 86_400;
/** Chat time in seconds for day `day` (0 is the first evening's day) at hh:mm:ss. */
export function clock(day: number, hh: number, mm: number, ss = 0): number {
  return day * DAY + hh * 3600 + mm * 60 + ss;
}
export function say(at: number, person: string, text: string, speak: Speak, extra: Omit<SkeletonSay, 'kind' | 'at' | 'person' | 'text' | 'speak'> = {}): SkeletonSay {
  return { kind: 'say', at, person, text, speak, ...extra };
}

interface Filler {
  text: string;
  speak: false | 'either';
  reflex?: ReflexLabel;
  photo?: string;
}

/** Ordinary chatter. `{slot}` words are filled from SLOTS. None of it calls Go. */
export const FILLER: readonly Filler[] = [
  { text: 'haha 😂', speak: false },
  { text: 'lol', speak: false },
  { text: '😂😂😂', speak: false },
  { text: 'same', speak: false },
  { text: 'sahi hai', speak: false },
  { text: 'kya baat hai', speak: false },
  { text: 'ok ok', speak: false },
  { text: 'done 👍', speak: false },
  { text: "who's bringing the {thing}?", speak: false },
  { text: "I'll get the {thing}", speak: false },
  { text: '{name} you better not forget the {thing} this time', speak: false },
  { text: '{place} beach was so crowded last time', speak: false },
  { text: 'we should do one sunset at {place}', speak: false },
  { text: 'I want {food} at least once', speak: false },
  { text: 'bro the {food} at that shack in {place} 🤤', speak: false },
  { text: 'office mein aaj full meeting day hai, later', speak: false },
  { text: 'yaar this week is so long', speak: false },
  { text: 'kal baat karte hain', speak: false },
  { text: 'anyone up?', speak: false },
  { text: 'brb', speak: false },
  { text: 'back', speak: false },
  { text: 'sorry was driving', speak: false },
  { text: '😴', speak: false },
  { text: "can't wait 🌴", speak: false },
  { text: 'countdown shuru 🗓️', speak: false },
  { text: '{name} send the playlist', speak: false },
  { text: 'added 5 songs to the playlist 🎶', speak: false },
  { text: 'please no 6 am alarms on this trip', speak: false },
  { text: "I'm packing light this time, promise", speak: false },
  { text: '{name} you said that last time too 😂', speak: false },
  { text: 'kitna paisa lagega total roughly?', speak: 'either' },
  { text: 'anyone knows if {place} is crowded in November?', speak: 'either' },
  { text: 'what time is check-in usually?', speak: 'either' },
  { text: 'is it hot in Goa in November?', speak: 'either' },
  { text: 'do we need cash or is UPI fine everywhere?', speak: 'either' },
  { text: "let's go to {place} on Saturday", speak: false, reflex: { for_go: false } },
  { text: 'go karte hain {place}, sunset ke liye', speak: false, reflex: { for_go: false } },
  { text: "I'll go with whatever {name} decides", speak: false, reflex: { for_go: false } },
  { text: 'we have to go to the flea market at Anjuna', speak: false, reflex: { for_go: false } },
  { text: 'ready to go 🧳', speak: false, reflex: { for_go: false } },
  { text: 'look at this view 😍', speak: false, photo: 'A beach shack with string lights at night in {place}' },
  { text: 'my packing so far', speak: false, photo: 'An open suitcase with clothes, a {thing} and a hat' },
  { text: 'found this old pic', speak: false, photo: 'Five friends on scooters on a coastal road' },
  { text: 'scooty rent karenge na?', speak: false },
  { text: 'I can drive the scooty, {name} sits behind 😂', speak: false },
  { text: 'helmet le ke aana', speak: false },
  { text: "who's on the aux", speak: false },
  { text: '{name} DJ mat banna please', speak: false },
  { text: "ok wait I'll check my leave", speak: false },
  { text: 'manager approved 🙏', speak: false },
  { text: 'finally weekend vibes', speak: false },
  { text: 'meeting khatam, what did I miss', speak: false },
  { text: 'scrolling up... so much to read 😂', speak: false },
  { text: '{name} ka mood off hai kya?', speak: false },
  { text: 'nahi yaar all good', speak: false },
  { text: 'chalo goodnight', speak: false },
  { text: 'gm all ☀️', speak: false },
  { text: "who's awake", speak: false },
  { text: 'my mom says carry an umbrella 😂', speak: false },
  { text: 'ok noted', speak: false },
];

const SLOTS: Readonly<Record<string, readonly string[]>> = {
  place: ['Baga', 'Anjuna', 'Vagator', 'Palolem', 'Candolim', 'Assagao', 'Morjim', 'Calangute'],
  food: ['fish thali', 'bebinca', 'poi bread', 'xacuti', 'ros omelette', 'kokum juice', 'mushroom cafreal', 'veg thali'],
  thing: ['sunscreen', 'power bank', 'speaker', 'UNO cards', 'flip flops', 'hat'],
  name: ['Rahul', 'Priya', 'Arjun', 'Meher', 'Kabir'],
};

const PEOPLE: ReadonlyArray<readonly [string, number]> = [['p_rahul', 0.25], ['p_priya', 0.22], ['p_meher', 0.2], ['p_kabir', 0.18], ['p_arjun', 0.15]];

/** Gaps shorter than this hold no chatter, so bursts and quick replies stay together. */
export const MIN_FILL_GAP_S = 120;

type Raw = { at: number; entry: SkeletonEntry } | { at: number; filler: { person: string; f: Filler; text: string; photo?: string } };

export function expandSkeleton(sk: Skeleton): Chat {
  const r = rng(sk.seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const fill = (s: string): string => s.replace(/\{(\w+)\}/g, (_m, k: string) => pick(SLOTS[k] ?? [k]));
  const pickPerson = (): string => {
    let x = r();
    for (const [p, w] of PEOPLE) {
      if (x < w) return p;
      x -= w;
    }
    return 'p_rahul';
  };

  const entries = sk.entries;
  entries.forEach((e, k) => {
    const prev = entries[k - 1];
    if (prev !== undefined && e.at < prev.at) throw new Error(`${sk.name}: entry ${k} goes back in time`);
  });
  const fillerTotal = sk.messages - entries.filter((e) => e.kind === 'say').length;
  if (fillerTotal < 0) throw new Error(`${sk.name}: the skeleton has more messages than the chat`);

  // Which gaps hold chatter, and how much: in proportion to length, remainders to the largest fractions.
  const gaps = entries.slice(1).flatMap((next, k) => {
    const e = entries[k] as SkeletonEntry;
    const quiet = e.kind === 'say' && e.quietAfter === true;
    return !quiet && next.at - e.at >= MIN_FILL_GAP_S ? [{ k, len: next.at - e.at }] : [];
  });
  const total = gaps.reduce((s, g) => s + g.len, 0);
  if (fillerTotal > 0 && total === 0) throw new Error(`${sk.name}: no gap is long enough for chatter`);
  const exact = gaps.map((g) => (total === 0 ? 0 : (fillerTotal * g.len) / total));
  const counts = exact.map((x) => Math.floor(x));
  let left = fillerTotal - counts.reduce((a, b) => a + b, 0);
  const order = exact.map((x, n) => ({ n, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || a.n - b.n);
  for (const o of order) {
    if (left === 0) break;
    counts[o.n] = (counts[o.n] ?? 0) + 1;
    left--;
  }
  const fillAfter = new Map<number, number>();
  gaps.forEach((g, n) => fillAfter.set(g.k, counts[n] ?? 0));

  const raws: Raw[] = [];
  entries.forEach((entry, k) => {
    raws.push({ at: entry.at, entry });
    const c = fillAfter.get(k) ?? 0;
    const next = entries[k + 1];
    if (c === 0 || next === undefined) return;
    const step = (next.at - entry.at) / (c + 1);
    let prevAt = entry.at;
    for (let j = 1; j <= c; j++) {
      const jitter = (r() - 0.5) * step * 0.6;
      const at = Math.round(Math.min(next.at - 1, Math.max(prevAt + 1, entry.at + step * j + jitter)));
      prevAt = at;
      const f = pick(FILLER);
      const person = pickPerson();
      raws.push({ at, filler: { person, f, text: fill(f.text), ...(f.photo !== undefined ? { photo: fill(f.photo) } : {}) } });
    }
  });

  const refIndex = new Map<string, number>();
  raws.forEach((raw, i) => {
    if ('entry' in raw && raw.entry.kind === 'say' && raw.entry.ref !== undefined) {
      if (refIndex.has(raw.entry.ref)) throw new Error(`${sk.name}: ref ${raw.entry.ref} is used twice`);
      refIndex.set(raw.entry.ref, i);
    }
  });
  const idx = (ref: string): number => {
    const n = refIndex.get(ref);
    if (n === undefined) throw new Error(`${sk.name}: unknown ref ${ref}`);
    return n;
  };

  const lines = raws.map((raw, i): ChatLine => {
    if ('filler' in raw) {
      const { person, f, text, photo } = raw.filler;
      return ChatLine.parse({
        i, at: raw.at, kind: 'say', person, text,
        ...(photo !== undefined ? { photo: { caption: photo } } : {}),
        go_should_speak: f.speak,
        ...(f.reflex !== undefined ? { reflex: f.reflex } : {}),
      });
    }
    const e = raw.entry;
    switch (e.kind) {
      case 'say':
        return ChatLine.parse({
          i, at: e.at, kind: 'say', person: e.person, text: e.text,
          ...(e.photo !== undefined ? { photo: { caption: e.photo } } : {}),
          ...(e.reply !== undefined ? { reply_to: idx(e.reply) } : {}),
          go_should_speak: e.speak,
          ...(e.quiet_ok ? { quiet_ok: true } : {}),
          ...(e.recall !== undefined ? { recall: e.recall.map((p) => ({ question: p.question, answer: p.answer, line: idx(p.ref) })) } : {}),
          ...(e.reflex !== undefined ? { reflex: e.reflex } : {}),
          ...(e.note !== undefined ? { note: e.note } : {}),
        });
      case 'edit':
        return ChatLine.parse({ i, at: e.at, kind: 'edit', of: idx(e.ref), text: e.text });
      case 'delete':
        return ChatLine.parse({ i, at: e.at, kind: 'delete', of: idx(e.ref) });
      case 'react':
        return ChatLine.parse({ i, at: e.at, kind: 'react', of: idx(e.ref), person: e.person, emoji: e.emoji });
    }
  });

  const problems = checkChat(lines);
  if (problems.length > 0) throw new Error(`${sk.name}: ${problems.join('; ')}`);
  return { name: sk.name, lines };
}

/** JSONL, one line per row, keys in schema order (zod writes them in that order), ending with a newline. */
export function serializeChat(chat: Chat): string {
  return `${chat.lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}
