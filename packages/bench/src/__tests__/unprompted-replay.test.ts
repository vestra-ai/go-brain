// Offline replay of the 2026-10-06 live run's goa-300 (run 37488230324, fixtures/live-2026-10-06.json): each line with the reflex
// read Jev really gave it, through Go's wake decision and its "why you woke" note as they are now. Go posted 15 times
// with nobody asking; each came from a turn woken by a line that didn't name Go and that Jev was unsure about.
import { readFileSync } from 'node:fs';
import { quietNote } from '@go/brain/dist/composer/wakes.js';
import { asksWhatTheyMissed, namesGoInText } from '@go/brain/dist/trips/names-go.js';
import { wakesComposer } from '@go/brain/dist/trips/intake.js';
import { describe, expect, it } from 'vitest';
import { loadChat, type SayLine } from '../chat.js';
import type { ReflexRead } from '../bench-reflex.js';

interface LiveRun {
  chat: string;
  score: { speak: { unprompted: Array<{ afterLine: number; text: string }> } };
  jev: { reads: Array<{ line: number; acted: ReflexRead }> };
  asks: Array<{ line: number }>;
}

const evidence = JSON.parse(readFileSync(new URL('./fixtures/live-2026-10-06.json', import.meta.url), 'utf8')) as { live: LiveRun[] };
const live = evidence.live.find((x) => x.chat === 'goa-300');
if (!live) throw new Error('the 2026-10-06 run has no goa-300');
const chat = loadChat('goa-300');
const reads = new Map(live.jev.reads.map((r) => [r.line, r.acted]));

const say = (i: number): SayLine | null => {
  const l = chat.lines[i];
  return l !== undefined && l.kind === 'say' && l.person !== 'go' ? l : null;
};
const readOf = (l: SayLine): ReflexRead => {
  const r = reads.get(l.i);
  if (!r) throw new Error(`no Jev read for line ${l.i}`);
  return r;
};
/** Go's wake decision before this change: a line woke Go unless it was sure chatter. */
const wokeBefore = (l: SayLine): boolean => namesGoInText(l.text) || !(readOf(l).forGo.sure && readOf(l).forGo.value === false);
const wakesNow = (l: SayLine): boolean => wakesComposer(namesGoInText(l.text), readOf(l), l.text);

/** "Why you woke" for a turn of these lines, as the composer now gets it. */
function noteFor(lines: SayLine[]): string | null {
  const messages = lines.map((l) => ({ message_id: `m_${l.i}`, seq: l.i + 2, author: { kind: 'person', person_id: l.person }, text: l.text }));
  const items = lines.map((l) => ({
    id: `w_${l.i}`, tripId: 't_goa', kind: 'message', ref: `m_${l.i}`, dueAt: new Date(), payload: { messageId: `m_${l.i}`, namesGo: namesGoInText(l.text) },
  }));
  return quietNote(items as never, { trip: {}, messages, seq: 400 } as never);
}

/** The line that woke the turn behind each unasked post: the last line at or before it that woke Go then. */
const triggers = live.score.speak.unprompted.map((u) => {
  for (let i = u.afterLine; i >= 0; i--) {
    const l = say(i);
    if (l && reads.has(i) && wokeBefore(l)) return l;
  }
  throw new Error(`nothing woke Go before the post after line ${u.afterLine}`);
});

describe('the 15 posts nobody asked for, replayed through the wake as it is now', () => {
  it('every one was woken by a line that did not name Go and that Jev was unsure about', () => {
    expect(triggers).toHaveLength(15);
    for (const l of triggers) {
      expect(namesGoInText(l.text), l.text).toBe(false);
      expect(readOf(l).forGo.sure, l.text).toBe(false);
    }
  });

  it('the five "what did I miss" lines no longer wake Go: the App gives each person their own catch-up', () => {
    const missed = triggers.filter((l) => asksWhatTheyMissed(l.text));
    expect(missed.map((l) => l.i)).toEqual([14, 15, 165, 224, 277]);
    for (const l of missed) expect(wakesNow(l), l.text).toBe(false);
  });

  it('the other ten still wake Go, each with the note: the group talking, answer only facts, else stay quiet', () => {
    const rest = triggers.filter((l) => !asksWhatTheyMissed(l.text));
    expect(rest).toHaveLength(10);
    for (const l of rest) {
      expect(wakesNow(l), l.text).toBe(true);
      expect(noteFor([l]), l.text).toContain(`#${l.i + 2} doesn't name you, so it is the group talking`);
    }
  });

  it('the 12 asks still wake Go, and none of their turns carries the note', () => {
    expect(live.asks.map((a) => a.line)).toEqual([9, 20, 54, 73, 103, 122, 143, 175, 209, 241, 271, 298]);
    for (const { line } of live.asks) {
      const l = say(line)!;
      expect(wakesNow(l), l.text).toBe(true);
      // 103 ends Meher's burst that named Go on line 101: one turn, lines 99 to 103.
      const turn = line === 103 ? [99, 100, 101, 102, 103].map((i) => say(i)!) : [l];
      expect(noteFor(turn), l.text).toBeNull();
    }
  });

  it('wakes over the whole chat: five fewer, all of them "what did I miss"', () => {
    const lines = chat.lines.flatMap((x) => {
      const l = say(x.i);
      return l && reads.has(l.i) ? [l] : [];
    });
    const before = lines.filter(wokeBefore);
    const now = lines.filter(wakesNow);
    const dropped = before.filter((l) => !wakesNow(l));
    expect(dropped.every((l) => asksWhatTheyMissed(l.text))).toBe(true);
    expect(now.length).toBe(before.length - dropped.length);
    const noted = now.filter((l) => !namesGoInText(l.text) && noteFor([l]) !== null).length;
    console.log(`UNPROMPTED-REPLAY goa-300: lines that woke Go ${before.length} -> ${now.length} (dropped ${dropped.length}: ${dropped.map((l) => l.i).join(', ')}); turns with the note ${noted}`);
  });
});
