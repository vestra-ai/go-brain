// Offline replay of the wake gate: each person's line in the live run of 2026-10-06 (run 37488230324, fixtures/live-2026-10-06.json),
// with the answers Jev really gave it, through question 1's reader and Go's wake decision as they are now. Keshav, 10 Oct:
// "go can interfere in most of the messages". Every line wakes the model but pure banter: Jev's chatter, or a bare ok,
// haha or emoji that doesn't answer Go's own line. The run predates question 11, so it is unsure here.
import { readFileSync } from 'node:fs';
import { looksLikeMoney } from '@go/brain/dist/reflex/money-line.js';
import { isSmallTalk } from '@go/brain/dist/reflex/small-talk.js';
import { readAnswers } from '@go/brain/dist/reflex/read.js';
import { BARS } from '@go/brain/dist/reflex/thresholds.js';
import { wakesComposer } from '@go/brain/dist/trips/intake.js';
import { asksWhatTheyMissed, namesGoInText } from '@go/brain/dist/trips/names-go.js';
import { describe, expect, it } from 'vitest';
import { loadChat, type Chat, type SayLine } from '../chat.js';

interface LiveRun {
  chat: string;
  jev: { reads: Array<{ line: number; ok: boolean; p: Record<string, number> }> };
}

const evidence = JSON.parse(readFileSync(new URL('./fixtures/live-2026-10-06.json', import.meta.url), 'utf8')) as { live: LiveRun[] };

function replay(run: LiveRun, keys: string[] = ['q1_addressed', 'q1_chatter']) {
  const chat: Chat = loadChat(run.chat);
  const reads = new Map(run.jev.reads.map((r) => [r.line, r]));
  // Go named in the text, or a reply to one of Go's lines.
  const named = (l: SayLine): boolean => {
    const to = l.reply_to === undefined ? undefined : chat.lines[l.reply_to];
    return namesGoInText(l.text) || (to !== undefined && to.kind === 'say' && to.person === 'go');
  };
  const afterGo = (l: SayLine): boolean => {
    const prev = chat.lines.slice(0, l.i).reverse().find((x) => x.kind === 'say');
    return prev !== undefined && prev.kind === 'say' && prev.person === 'go';
  };
  const chatter = (l: SayLine): boolean => {
    const p = reads.get(l.i)!.p;
    return (p['q1_chatter'] ?? 0) >= BARS.for_go.chatterMin && (p['q1_addressed'] ?? 1) <= BARS.for_go.addressedMaxForChatter;
  };
  const wakes = (l: SayLine): boolean => {
    const r = reads.get(l.i)!;
    const answers = r.ok ? Object.fromEntries(keys.map((k) => [k, { type: 'noul' as const, noul: r.p[k]! }])) : null;
    const facts = { namesGo: named(l), secretKinds: [], hasTasks: false, money: looksLikeMoney(l.text), smallTalk: isSmallTalk(l.text), answersGo: afterGo(l) };
    return wakesComposer(facts.namesGo, readAnswers(answers, facts, [], BARS).would, l.text);
  };
  const lines = chat.lines.filter((l): l is SayLine => l.kind === 'say' && l.person !== 'go' && reads.has(l.i));
  const now = lines.filter(wakes);
  return { lines, now, quiet: lines.filter((l) => !now.includes(l)), named, chatter };
}

describe('the wake gate, replayed on the 2026-10-06 live run', () => {
  for (const run of evidence.live) {
    const r = replay(run);

    it(`${run.chat}: a line that doesn't wake Go is pure banter: labelled quiet, never naming Go or money, chatter or bare small talk`, () => {
      for (const l of r.quiet) {
        // Meher's "ok" opens her burst to Go (goa-300, 99 to 103): the line that names Go wakes it for the whole burst.
        if (l.text === 'ok' && l.go_should_speak === 'either') continue;
        expect(l.go_should_speak, `${l.i} ${l.text}`).toBe(false);
        expect(r.named(l), `${l.i} ${l.text}`).toBe(false);
        expect(looksLikeMoney(l.text), `${l.i} ${l.text}`).toBe(false);
        expect(r.chatter(l) || isSmallTalk(l.text) || asksWhatTheyMissed(l.text), `${l.i} ${l.text}`).toBe(true);
      }
    });

    it(`${run.chat}: every ask wakes Go, and every line Go may answer but a bare "ok" that opens a burst to Go`, () => {
      for (const l of r.lines.filter((x) => x.go_should_speak === true)) expect(r.now, `${l.i} ${l.text}`).toContain(l);
      for (const l of r.lines.filter((x) => x.go_should_speak === 'either' && x.text !== 'ok')) expect(r.now, `${l.i} ${l.text}`).toContain(l);
    });

    it(`${run.chat}: the lines that wake Go`, () => {
      expect(r.now.length).toBe(run.chat === 'goa-300' ? 230 : 40);
      console.log(`WAKE-REPLAY ${run.chat}: lines that wake Go ${r.now.length} of ${r.lines.length} (quiet ${r.quiet.map((l) => l.i).join(', ')})`);
    });
  }
});

describe('plan talk wakes Go and chatter stays quiet, replayed with questions 1 and 6 as Jev answered them', () => {
  for (const run of evidence.live) {
    it(`${run.chat}: plan questions to the group and agreements wake Go; chatter stays quiet`, () => {
      const r = replay({ ...run, jev: { reads: run.jev.reads.filter((x) => x.ok) } }, ['q1_addressed', 'q1_chatter', 'q6_open', 'q6_agreed']);
      const texts = r.now.map((l) => l.text);
      const quiet = r.quiet.map((l) => l.text);
      if (run.chat === 'goa-50') {
        expect(texts).toContain('Birthday dinner on the 7th somewhere nice? Not a shack pls');
        expect(texts).toContain('+1 pool');
        expect(quiet).toEqual(expect.arrayContaining(['Finallyyyy 😭🙌', 'fine fine 😂']));
      } else {
        expect(texts).toContain('scooty rent karenge na?');
        expect(texts).toContain("who's bringing the flip flops?");
        expect(quiet).toEqual(expect.arrayContaining(['same', "can't wait 🌴"]));
      }
      console.log(`PLAN-WAKE ${run.chat}: ${r.now.length} lines wake Go, ${r.quiet.length} stay quiet`);
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
