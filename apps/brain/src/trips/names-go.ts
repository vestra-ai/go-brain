import type { Message } from '../door/methods.js';
import type { TripPack } from './pack.js';

// "Go" spoken to, not "go" the verb: at the start ("Go, find..." but not "go to the beach"),
// at the end after a comma ("thoughts, Go?"), after a greeting ("hey go"), or @go anywhere.
const STARTS = /^\s*@?go\b(?!\s+(?:to|for|and|out|back|ahead|home|there|on|in|with|get|see|eat)\b)/i;
const ENDS = /[,!?]\s*@?go\s*[?!.]*\s*$/i;
const CALLS = /\b(?:hey|hi|hello|ok|okay|thanks|thank you|bhai|yo|dear)\s+@?go\b/i;
const AT = /(^|\s)@go\b/i;

export function namesGoInText(text: string | null | undefined): boolean {
  if (!text) return false;
  return AT.test(text) || STARTS.test(text) || ENDS.test(text) || CALLS.test(text);
}

// A thought plainly ended: ?, ! or one full stop (not "..." or "…"), or an emoji, with trailing spaces, emoji joiners and
// skin tones aside.
const ENDED = /(?:[?!]|(?<!\.)\.|\p{Extended_Pictographic})[\s\uFE0F\u200D\p{Emoji_Modifier}]*$/u;

/** True when the text plainly ends a thought: "@Go flights Friday?" does, "@Go can you" and "@Go one thing..." do not. */
export function endsThought(text: string | null | undefined): boolean {
  return !!text && ENDED.test(text);
}

// Someone back from a break asking the group what they missed: "meeting khatam, what did I miss", "kya miss kiya",
// "catch me up". The App gives each person their own catch-up (the Server's catch_up), so Go never posts one unasked.
const MISSED = /\bwhat(?:'?d| did| have)? i miss(?:ed)?\b|\bkya (?:kya )?miss (?:kiya|hua|ho gaya)\b|\b(?:catch|fill) me (?:up|in)\b/i;

export function asksWhatTheyMissed(text: string | null | undefined): boolean {
  return !!text && MISSED.test(text);
}

/** True when a message plainly names Go: the Server's mentions_go, a reply to Go, or Go spoken to in the text. */
export function plainlyNamesGo(m: Message, pack: TripPack): boolean {
  if (m.mentions_go || namesGoInText(m.text)) return true;
  if (!m.reply_to) return false;
  return pack.messages.find((x) => x.message_id === m.reply_to)?.author.kind === 'go';
}

/** The desk's longest wait (desk.ts maxWaitMs): a line to Go waits at most this long for the rest of its burst. */
export const BURST_MS = 6_000;

/**
 * True when the same person named Go in the last few seconds: this line is the rest of that ask. "@Go one thing", "for
 * my birthday on the 7th", "is there a good bakery near Anjuna?" is one ask in three lines.
 */
export function continuesAskToGo(m: Message, pack: TripPack): boolean {
  return namedGoNearby(m, pack, 'before');
}

/**
 * True when the line is part of an ask to Go: it names Go, or the same person named Go a few seconds before or after it.
 * "ok", "@Go one thing", "for my birthday on the 7th", "is there a good bakery near Anjuna?" are all one ask, and Go's
 * answer is what each of them gets.
 */
export function partOfAskToGo(m: Message, pack: TripPack): boolean {
  return plainlyNamesGo(m, pack) || inBurstToGo(m, pack);
}

/** True when the same person named Go in another line a few seconds before or after this one: a burst to Go. */
export function inBurstToGo(m: Message, pack: TripPack): boolean {
  return namedGoNearby(m, pack, 'before') || namedGoNearby(m, pack, 'after');
}

function namedGoNearby(m: Message, pack: TripPack, side: 'before' | 'after'): boolean {
  if (m.author.kind !== 'person') return false;
  const person = m.author.person_id;
  const sent = Date.parse(m.sent_at);
  return pack.messages.some(
    (x) =>
      (side === 'before' ? x.seq < m.seq : x.seq > m.seq) &&
      x.author.kind === 'person' &&
      x.author.person_id === person &&
      Math.abs(sent - Date.parse(x.sent_at)) <= BURST_MS &&
      plainlyNamesGo(x, pack),
  );
}
