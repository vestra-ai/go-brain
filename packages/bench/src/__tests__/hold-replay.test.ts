// Offline replay of the 2 s hold: the definitive live run's asks (run 37488230324, docs/demo/evidence), each with the
// answers Jev really gave it, and every burst in goa-50, goa-300 and goa-2000, through Go's "due at once" rule and its
// question 2 reader as they are now. In that run 7 of 18 asks waited about 2.15 s for more lines, and none of the 7
// people sent any.
import { readFileSync } from 'node:fs';
import { readAnswers } from '@go/brain/dist/reflex/read.js';
import { dueAtOnce } from '@go/brain/dist/trips/intake.js';
import { namesGoInText, plainlyNamesGo } from '@go/brain/dist/trips/names-go.js';
import { describe, expect, it } from 'vitest';
import { loadChat, type Chat, type SayLine } from '../chat.js';

interface LiveRun {
  chat: string;
  jev: { reads: Array<{ line: number; p: Record<string, number> }> };
  asks: Array<{ line: number; waited: boolean }>;
}

const evidence = JSON.parse(readFileSync(new URL('../../../../docs/demo/evidence/bench-live-2026-10-06-definitive.json', import.meta.url), 'utf8')) as { live: LiveRun[] };
const START = Date.parse('2026-11-01T10:00:00Z');
/** What Jev said about each line of each chat in that run: question 2's answer, when it has one. */
const complete = new Map(evidence.live.map((run) => [run.chat, new Map(run.jev.reads.map((r) => [r.line, r.p['q2_complete']]))]));

/** The chat as Go's pack holds it after line `upTo`: people's lines, numbered as the replay numbers them. */
function packUpTo(chat: Chat, upTo: number) {
  const messages = chat.lines
    .filter((l): l is SayLine => l.kind === 'say' && l.person !== 'go' && l.i <= upTo)
    .map((l) => ({
      message_id: `m_${l.i}`, seq: l.i + 2, author: { kind: 'person', person_id: l.person }, text: l.text, mentions_go: /@go\b/i.test(l.text),
      sent_at: new Date(START + l.at * 1_000).toISOString(), ...(l.reply_to !== undefined ? { reply_to: `m_${l.reply_to}` } : {}),
    }));
  return { trip: {}, messages, seq: upTo + 2 } as never;
}

/** Due at once, with question 2 read from Jev's recorded answer for the line (unsure when the chat has no recording). */
function due(chat: Chat, l: SayLine): boolean {
  const pack = packUpTo(chat, l.i);
  const m = (pack as { messages: Array<{ message_id: string }> }).messages.find((x) => x.message_id === `m_${l.i}`)!;
  const namesGo = plainlyNamesGo(m as never, pack);
  const p = complete.get(chat.name)?.get(l.i);
  const answers = p === undefined ? null : { q2_complete: { type: 'noul' as const, noul: p } };
  const { would } = readAnswers(answers, { namesGo, secretKinds: [], hasTasks: false, money: false }, []);
  return dueAtOnce(m as never, pack, would, namesGo, false);
}

/** Lines of one person no more than 3 s apart (the replay's burst window), with Go named on one of them. */
function bursts(chat: Chat): SayLine[][] {
  const out: SayLine[][] = [];
  let run: SayLine[] = [];
  for (const l of chat.lines) {
    if (l.kind !== 'say' || l.person === 'go') continue;
    const last = run[run.length - 1];
    if (last && last.person === l.person && l.at - last.at <= 3) run.push(l);
    else {
      if (run.length > 1) out.push(run);
      run = [l];
    }
  }
  if (run.length > 1) out.push(run);
  return out.filter((b) => b.some((l) => namesGoInText(l.text)));
}

describe('the asks that waited in the definitive live run, through the hold as it is now', () => {
  const held = evidence.live.flatMap((run) => {
    const chat = loadChat(run.chat);
    return run.asks.filter((a) => a.waited).map((a) => {
      const l = chat.lines[a.line] as SayLine;
      return { chat: run.chat, line: a.line, text: l.text, dueNow: due(chat, l) };
    });
  });

  it('7 of the 18 asks waited', () => {
    expect(held.map((h) => `${h.chat}:${h.line}`)).toEqual(['goa-300:73', 'goa-300:103', 'goa-300:175', 'goa-300:298', 'goa-50:9', 'goa-50:24', 'goa-50:33']);
  });

  it('6 go at once: the end of the burst that named Go, and the five asks to Go Jev read as whole', () => {
    expect(held.filter((h) => h.dueNow).map((h) => h.text)).toEqual([
      'Go, find us a villa with a pool in North Goa under 8k a head, near the beach',
      'is there a good bakery near Anjuna?',
      '@Go put the three villas to a vote please',
      '@Go quick recap please: allergies, seats, who pays the advance',
      "@Go flights Delhi to Goa Friday evening? Arjun can't leave before 6",
      'Go, find us a villa with a pool in North Goa under 8k a head, near the beach. Check the reviews too',
    ]);
  });

  it('the end of a burst with no end mark that does not name Go still waits: nothing tells it from a line cut short', () => {
    expect(held.filter((h) => !h.dueNow).map((h) => h.text)).toEqual(['for 5 people with luggage']);
  });
});

describe('every burst to Go in the three chats still goes as one turn', () => {
  for (const name of ['goa-50', 'goa-300', 'goa-2000']) {
    it(`${name}: no line before a burst's last is due at once, so the desk holds them for the rest`, () => {
      const chat = loadChat(name);
      const found = bursts(chat);
      expect(found.length, name).toBeGreaterThan(0);
      for (const b of found) {
        for (const l of b.slice(0, -1)) expect(due(chat, l), `${name}:${l.i} ${l.text}`).toBe(false);
      }
      console.log(`HOLD-REPLAY ${name}: ${found.length} bursts to Go (${found.map((b) => `${b[0]!.i}-${b[b.length - 1]!.i}`).join(', ')}); last line due at once in ${found.filter((b) => due(chat, b[b.length - 1]!)).length}`);
    });
  }
});
