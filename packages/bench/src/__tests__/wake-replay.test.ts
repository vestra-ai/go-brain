// Offline replay of the wake gate: each person's line in the live run of 2026-10-06 (run 37488230324, fixtures/live-2026-10-06.json),
// with the answers Jev really gave it, through question 1's reader and Go's wake decision as they are now, against the
// same with the "not spoken to Go" bar at 0.1. The run woke the model for 37.3% / 34.0% of messages, against under 25%.
import { readFileSync } from 'node:fs';
import { looksLikeMoney } from '@go/brain/dist/reflex/money-line.js';
import { isSmallTalk } from '@go/brain/dist/reflex/small-talk.js';
import { readAnswers } from '@go/brain/dist/reflex/read.js';
import { BARS } from '@go/brain/dist/reflex/thresholds.js';
import { wakesComposer } from '@go/brain/dist/trips/intake.js';
import { namesGoInText } from '@go/brain/dist/trips/names-go.js';
import { describe, expect, it } from 'vitest';
import { loadChat, type Chat, type SayLine } from '../chat.js';

interface LiveRun {
  chat: string;
  jev: { reads: Array<{ line: number; ok: boolean; p: Record<string, number> }> };
}

const evidence = JSON.parse(readFileSync(new URL('./fixtures/live-2026-10-06.json', import.meta.url), 'utf8')) as { live: LiveRun[] };
const BEFORE = { ...BARS, for_go: { ...BARS.for_go, notAddressedMax: 0.1 } };

function replay(run: LiveRun) {
  const chat: Chat = loadChat(run.chat);
  const reads = new Map(run.jev.reads.map((r) => [r.line, r]));
  // Go named in the text, or a reply to one of Go's lines.
  const named = (l: SayLine): boolean => {
    const to = l.reply_to === undefined ? undefined : chat.lines[l.reply_to];
    return namesGoInText(l.text) || (to !== undefined && to.kind === 'say' && to.person === 'go');
  };
  const wakes = (l: SayLine, bars: typeof BARS): boolean => {
    const r = reads.get(l.i)!;
    const answers = r.ok ? { q1_addressed: { type: 'noul' as const, noul: r.p['q1_addressed']! }, q1_chatter: { type: 'noul' as const, noul: r.p['q1_chatter']! } } : null;
    const facts = { namesGo: named(l), secretKinds: [], hasTasks: false, money: looksLikeMoney(l.text) };
    return wakesComposer(facts.namesGo, readAnswers(answers, facts, [], bars).would, l.text);
  };
  const lines = chat.lines.filter((l): l is SayLine => l.kind === 'say' && l.person !== 'go' && reads.has(l.i));
  const before = lines.filter((l) => wakes(l, BEFORE));
  const now = lines.filter((l) => wakes(l, BARS));
  return { lines, before, now, dropped: before.filter((l) => !now.includes(l)), named };
}

describe('the wake gate, replayed on the 2026-10-06 live run', () => {
  for (const run of evidence.live) {
    const r = replay(run);

    it(`${run.chat}: every line that no longer wakes Go is labelled not for Go, and none names Go or is about money`, () => {
      expect(r.dropped.length, run.chat).toBeGreaterThan(0);
      for (const l of r.dropped) {
        expect(l.go_should_speak, `${l.i} ${l.text}`).toBe(false);
        expect(r.named(l), `${l.i} ${l.text}`).toBe(false);
        expect(looksLikeMoney(l.text), `${l.i} ${l.text}`).toBe(false);
      }
    });

    it(`${run.chat}: every ask, and every line Go may answer that woke it before, still wakes it`, () => {
      for (const l of r.lines.filter((x) => x.go_should_speak === true)) expect(r.now, `${l.i} ${l.text}`).toContain(l);
      for (const l of r.before.filter((x) => x.go_should_speak === 'either')) expect(r.now, `${l.i} ${l.text}`).toContain(l);
    });

    it(`${run.chat}: the lines that wake Go`, () => {
      expect({ before: r.before.length, now: r.now.length }).toEqual(run.chat === 'goa-300' ? { before: 107, now: 72 } : { before: 18, now: 13 });
      console.log(`WAKE-REPLAY ${run.chat}: lines that wake Go ${r.before.length} -> ${r.now.length} of ${r.lines.length} (dropped ${r.dropped.map((l) => l.i).join(', ')})`);
    });
  }
});

describe('small talk in the three chats, which wakes no model when Jev has no answer', () => {
  for (const name of ['goa-50', 'goa-300', 'goa-2000']) {
    it(`${name}: no ask is small talk, and the only line Go may answer that is opens a burst to Go`, () => {
      const lines = loadChat(name).lines.filter((l): l is SayLine => l.kind === 'say' && l.person !== 'go');
      const talk = lines.filter((l) => !namesGoInText(l.text) && isSmallTalk(l.text));
      expect(talk.filter((l) => l.go_should_speak === true)).toEqual([]);
      for (const l of talk.filter((x) => x.go_should_speak === 'either')) expect(l.text, `${name}:${l.i}`).toBe('ok');
      console.log(`SMALL-TALK ${name}: ${talk.length} of ${lines.length} lines (${[...new Set(talk.map((l) => l.text))].slice(0, 12).join(' | ')})`);
    });
  }
});
