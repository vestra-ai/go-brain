import { describe, expect, it } from 'vitest';
import type { JevAnswer } from '../jev.js';
import { looksLikeMoney } from '../money-line.js';
import { applyLive, codeOnly, liveRecipe, readAnswers, type CodeFacts } from '../read.js';
import type { QuestionName } from '../questions.js';

const n = (p: number): JevAnswer => ({ type: 'noul', noul: p });
const ch = (probabilities: Record<string, number>): JevAnswer => {
  const [choice, confidence] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]!;
  return { type: 'choice', choice, confidence, probabilities };
};
const plain: CodeFacts = { namesGo: false, secretKinds: [], hasTasks: false, money: false };
const read = (a: Record<string, JevAnswer> | null, facts: CodeFacts = plain, taskKeys: Array<{ key: string; id: string }> = []) =>
  readAnswers(a, facts, taskKeys).would;

describe('question 1: for Go', () => {
  it('is sure chatter only when chatter is high and addressed is low', () => {
    expect(read({ q1_chatter: n(0.95), q1_addressed: n(0.05) }).forGo).toEqual({ value: false, sure: true });
    expect(read({ q1_chatter: n(0.02), q1_addressed: n(0.94) }).forGo).toEqual({ value: true, sure: true });
    expect(read({ q1_chatter: n(0.6), q1_addressed: n(0.4) }).forGo.sure).toBe(false);
  });
  it('is sure not for Go when Jev is sure no one spoke to Go, chatter or not, so a fact or a plan wakes no model', () => {
    expect(read({ q1_chatter: n(0.5), q1_addressed: n(0.06) }).forGo).toEqual({ value: false, sure: true });
    expect(read({ q1_chatter: n(0.3), q1_addressed: n(0.22) }).forGo).toEqual({ value: false, sure: true });
    expect(read({ q1_chatter: n(0.5), q1_addressed: n(0.3) }).forGo.sure).toBe(false);
    expect(read({ q1_chatter: n(0.5), q1_addressed: n(0.06) }, { ...plain, namesGo: true }).forGo).toEqual({ value: true, sure: true });
  });
  it("wakes Go for a line no one spoke to it in when question 6 reads a plan question to the group or an agreement: a point Go can move", () => {
    // Jev's own answers in live run 37488230324.
    const birthday = { q1_addressed: n(0.21), q1_chatter: n(0.22), q6_open: n(0.85), q6_agreed: n(0.05) }; // "Birthday dinner on the 7th somewhere nice? Not a shack pls"
    const scooty = { q1_addressed: n(0.2), q1_chatter: n(0.21), q6_open: n(0.78), q6_agreed: n(0.06) }; // "scooty rent karenge na?"
    const pool = { q1_addressed: n(0.08), q1_chatter: n(0.71), q6_open: n(0.05), q6_agreed: n(0.82) }; // "+1 pool"
    for (const a of [birthday, scooty, pool]) expect(read(a).forGo.sure).toBe(false);
    // Below the plan bar, or with no question 6 answer, it still reads not for Go.
    expect(read({ q1_addressed: n(0.13), q1_chatter: n(0.27), q6_open: n(0.6), q6_agreed: n(0.05) }).forGo).toEqual({ value: false, sure: true }); // "anyone up?"
    expect(read({ q1_addressed: n(0.21), q1_chatter: n(0.22) }).forGo).toEqual({ value: false, sure: true });
    // Banter stays quiet whatever question 6 says: chatter is read first ("Finallyyyy 😭🙌", "haha same").
    expect(read({ q1_addressed: n(0.03), q1_chatter: n(0.93), q6_open: n(0.02), q6_agreed: n(0.71) }).forGo).toEqual({ value: false, sure: true });
    expect(read({ q1_addressed: n(0.02), q1_chatter: n(0.95), q6_open: n(0.9), q6_agreed: n(0.9) }).forGo).toEqual({ value: false, sure: true });
  });
  it('never reads a line about money as not for Go, so it reaches the model; a bare number or a fact without money still skips', () => {
    const notToGo = { q1_chatter: n(0.9), q1_addressed: n(0.03) };
    const facts = (text: string): CodeFacts => ({ ...plain, money: looksLikeMoney(text) });
    for (const text of ['I paid 3,200 for the cab', 'Rahul owes me 1,500', 'paid something for the snacks', 'Arjun owed me for the cab', 'maine paise bhej diye']) {
      expect(read(notToGo, facts(text)).forGo.sure, text).toBe(false);
    }
    // Talk about who will pay, with nothing moved, goes through Jev like any other line (goa-300's lines 198 and 199).
    for (const text of ["we're 5 people", "I'm veg btw", "Who's paying the villa advance? I can put it on my card", 'yes Rahul pays the advance, we UPI him']) {
      expect(read(notToGo, facts(text)).forGo, text).toEqual({ value: false, sure: true });
    }
  });
  it('with no answer from Jev, reads small talk as not for Go and leaves every other line unsure', () => {
    const talk: CodeFacts = { ...plain, smallTalk: true };
    expect(read(null, talk).forGo).toEqual({ value: false, sure: true });
    expect(read({ q1_addressed: n(Number.NaN), q1_chatter: n(Number.NaN) }, talk).forGo).toEqual({ value: false, sure: true });
    expect(read(null).forGo.sure).toBe(false);
    expect(read(null, { ...talk, namesGo: true }).forGo).toEqual({ value: true, sure: true });
    // Jev answered: its reading decides, small talk or not.
    expect(read({ q1_addressed: n(0.95), q1_chatter: n(0.02) }, talk).forGo).toEqual({ value: true, sure: true });
  });

  it('is sure for Go when code saw Go named, whatever Jev says', () => {
    expect(read({ q1_chatter: n(0.99), q1_addressed: n(0.0) }, { ...plain, namesGo: true }).forGo).toEqual({ value: true, sure: true });
  });
  it('reads missing, NaN or out-of-range answers as unsure', () => {
    expect(read({}).forGo.sure).toBe(false);
    expect(read({ q1_chatter: n(Number.NaN), q1_addressed: n(0.0) }).forGo.sure).toBe(false);
    expect(read({ q1_chatter: n(1.7), q1_addressed: n(0.0) }).forGo.sure).toBe(false);
    expect(read(null).forGo.sure).toBe(false);
  });
});

describe('questions 2 and 3', () => {
  it('reads a whole ask to Go and one cut short; a line that does not name Go is never sure-complete', () => {
    const named: CodeFacts = { ...plain, namesGo: true };
    expect(read({ q2_complete: n(0.56) }, named).complete).toEqual({ value: true, sure: true });
    expect(read({ q2_complete: n(0.39) }, named).complete.sure).toBe(false);
    expect(read({ q2_complete: n(0.05) }, named).complete).toEqual({ value: false, sure: true });
    expect(read({ q2_complete: n(0.95) }).complete.sure).toBe(false);
    expect(read({ q2_complete: n(0.05) }).complete).toEqual({ value: false, sure: true });
    expect(read({ q2_complete: n(Number.NaN) }, named).complete.sure).toBe(false);
  });
  it('is sure of a size only when one side clears and every other noul is present and low', () => {
    const quickLow = { q3_quick_answer: n(0.02), q3_quick_search: n(0.03), q3_quick_act: n(0.01) };
    expect(read({ q3_big_compare: n(0.95), q3_big_steps: n(0.2), ...quickLow }).size).toEqual({ value: 'big', sure: true });
    expect(read({ q3_quick_search: n(0.93), q3_quick_answer: n(0.05), q3_quick_act: n(0.0), q3_big_compare: n(0.04), q3_big_steps: n(0.02) }).size)
      .toEqual({ value: 'quick', sure: true });
    expect(read({ q3_big_compare: n(0.95), q3_quick_search: n(0.92), q3_quick_answer: n(0.0), q3_quick_act: n(0.0), q3_big_steps: n(0.0) }).size.sure).toBe(false);
    expect(read({ q3_big_compare: n(0.95), q3_quick_answer: n(0.0) }).size.sure).toBe(false);
  });
});

describe('question 4: which task', () => {
  const keys = [{ key: 't1', id: 'task_villa' }, { key: 't2', id: 'task_flights' }];
  const facts = { ...plain, hasTasks: true };
  it('is sure there is no task when none run', () => {
    expect(read({}).taskId).toEqual({ value: null, sure: true });
  });
  it('picks a task only with the Choice, its own noul and a lead over the others', () => {
    expect(read({ q4_task: ch({ t1: 0.05, t2: 0.9, none: 0.05 }), q4_is_t1: n(0.2), q4_is_t2: n(0.7) }, facts, keys).taskId)
      .toEqual({ value: 'task_flights', sure: true });
    expect(read({ q4_task: ch({ t1: 0.05, t2: 0.9, none: 0.05 }), q4_is_t1: n(0.6), q4_is_t2: n(0.7) }, facts, keys).taskId.sure).toBe(false);
    expect(read({ q4_task: ch({ t1: 0.02, t2: 0.03, none: 0.95 }), q4_is_t1: n(0.05), q4_is_t2: n(0.02) }, facts, keys).taskId)
      .toEqual({ value: null, sure: true });
  });
});

describe('questions 5, 6, 7 and 9', () => {
  it('flags a fact when one kind clears, and no fact only when all are low', () => {
    expect(read({ q5_food: n(0.92), q5_dates: n(0.1), q5_travel: n(0.0), q5_other: n(0.0) }).fact).toEqual({ value: true, sure: true });
    expect(read({ q5_food: n(0.02), q5_dates: n(0.01), q5_travel: n(0.0), q5_other: n(0.05) }).fact).toEqual({ value: false, sure: true });
    expect(read({ q5_food: n(0.5) }).fact.sure).toBe(false);
  });
  it('names exactly one record kind, or none', () => {
    expect(read({ q6_agreed: n(0.9), q6_open: n(0.1), q6_doing: n(0.05) }).recordKind).toEqual({ value: 'agreed', sure: true });
    expect(read({ q6_agreed: n(0.9), q6_open: n(0.85), q6_doing: n(0.05) }).recordKind.sure).toBe(false);
    expect(read({ q6_agreed: n(0.02), q6_open: n(0.01), q6_doing: n(0.0) }).recordKind).toEqual({ value: null, sure: true });
  });
  it('reacts only with a clear winner from the small set', () => {
    expect(read({ q7_reaction: ch({ noted: 0.95, thumbs: 0.02, cheer: 0.01, none: 0.02 }) }).reaction).toEqual({ value: '✅', sure: true });
    expect(read({ q7_reaction: ch({ noted: 0.6, thumbs: 0.35, cheer: 0.0, none: 0.05 }) }).reaction.sure).toBe(false);
    expect(read({ q7_reaction: ch({ noted: 0.02, thumbs: 0.02, cheer: 0.0, none: 0.96 }) }).reaction).toEqual({ value: null, sure: true });
  });
  it('nominates an opening only above its bar', () => {
    expect(read({ q9_group_question: n(0.95), q9_circles: n(0.1), q9_someone_look: n(0.0) }).opening).toEqual({ value: true, sure: true });
    expect(read({ q9_group_question: n(0.7), q9_circles: n(0.1), q9_someone_look: n(0.0) }).opening.sure).toBe(false);
  });
});

describe('question 10: which ixigo search', () => {
  const recipe = (probabilities: Record<string, number>) => read({ q10_recipe: ch(probabilities) }).recipe;
  it('picks a search only with one clear winner', () => {
    expect(recipe({ flights: 0.9, stays: 0.04, trains: 0.03, buses: 0.02, none: 0.01 })).toEqual({ value: 'flights', sure: true });
    expect(recipe({ flights: 0.02, stays: 0.01, trains: 0.03, buses: 0.62, none: 0.32 }).sure).toBe(false);
    expect(recipe({ flights: 0.1, stays: 0.55, trains: 0.0, buses: 0.0, none: 0.35 }).sure).toBe(false);
  });
  it('is sure there is no search when none wins', () => {
    expect(recipe({ flights: 0.05, stays: 0.02, trains: 0.01, buses: 0.0, none: 0.92 })).toEqual({ value: null, sure: true });
  });
  it('reads the asks beyond the searches the same way', () => {
    expect(recipe({ train_status: 0.93, schedule: 0.03, trains: 0.02, none: 0.02 })).toEqual({ value: 'train_status', sure: true });
    // A train's timetable and today's run are close: no clear winner, no pick.
    expect(recipe({ train_status: 0.6, schedule: 0.35, none: 0.05 }).sure).toBe(false);
  });
  it('reads a missing or malformed answer as unsure', () => {
    expect(read(null).recipe).toEqual({ value: null, sure: false });
    expect(read({ q10_recipe: n(0.9) }).recipe).toEqual({ value: null, sure: false });
    expect(recipe({ flights: 1.4, none: 0.1 }).sure).toBe(false);
  });
});

describe('question 8 is raise-only', () => {
  // mulberry32: a small seeded generator so the run is the same every time.
  function rng(seed: number): () => number {
    let a = seed;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  it('never answers sure-safe, over 2,000 random answer sets', () => {
    const r = rng(42);
    const pick = (): JevAnswer | undefined => {
      const x = r();
      if (x < 0.1) return undefined;
      if (x < 0.15) return n(Number.NaN);
      return n(r());
    };
    for (let i = 0; i < 2_000; i += 1) {
      const a: Record<string, JevAnswer> = {};
      for (const k of ['q8_spend', 'q8_steer', 'q8_secret']) {
        const v = pick();
        if (v) a[k] = v;
      }
      const out = read(a);
      expect(out.risky.sure && out.risky.value === false).toBe(false);
      if (out.risky.sure) expect(out.riskWhy!.length).toBeGreaterThan(0);
    }
  });
  it('raises on a spend ask or a steer, and on a secret code found even with no answers at all', () => {
    expect(read({ q8_spend: n(0.8), q8_steer: n(0.7), q8_secret: n(0.0) }).riskWhy).toEqual(['spend', 'steer']);
    const secret = { ...plain, secretKinds: ['card' as const] };
    expect(read(null, secret).risky).toEqual({ value: true, sure: true });
    expect(read({ q8_spend: n(0.0), q8_steer: n(0.0), q8_secret: n(0.0) }, secret).riskWhy).toEqual(['secret']);
  });
});

describe('applyLive', () => {
  const all = { q1_chatter: n(0.97), q1_addressed: n(0.01), q2_complete: n(0.05), q5_food: n(0.95), q5_dates: n(0.0), q5_travel: n(0.0), q5_other: n(0.0), q8_spend: n(0.9) };
  it('acts on live questions and leaves the rest unsure, keeping code facts', () => {
    const facts: CodeFacts = { namesGo: false, secretKinds: ['code'], hasTasks: false, money: false };
    const { would } = readAnswers(all, facts, []);
    const live = new Set<QuestionName>(['for_go', 'complete', 'size']);
    const acted = applyLive(would, live, facts);
    expect(acted.forGo).toEqual({ value: false, sure: true });
    expect(acted.complete).toEqual({ value: false, sure: true });
    expect(would.fact).toEqual({ value: true, sure: true });
    expect(acted.fact.sure).toBe(false);
    expect(acted.risky).toEqual({ value: true, sure: true });
    expect(acted.riskWhy).toEqual(['secret']);
    expect(acted.taskId).toEqual({ value: null, sure: true });
  });
  it('keeps question 10 unsure in shadow, and acts on it live', () => {
    const { would } = readAnswers({ q10_recipe: ch({ flights: 0.02, stays: 0.01, trains: 0.94, buses: 0.02, none: 0.01 }) }, plain, []);
    expect(would.recipe).toEqual({ value: 'trains', sure: true });
    expect(applyLive(would, new Set<QuestionName>(['for_go']), plain).recipe).toEqual({ value: null, sure: false });
    expect(applyLive(would, new Set<QuestionName>(['recipe']), plain).recipe).toEqual({ value: 'trains', sure: true });
  });
  it('acts on a sure pick still in shadow as none, so nothing starts for it and no search is started instead', () => {
    const { would } = readAnswers({ q10_recipe: ch({ pnr: 0.95, trains: 0.02, none: 0.03 }) }, plain, []);
    expect(would.recipe).toEqual({ value: 'pnr', sure: true });
    expect(applyLive(would, new Set<QuestionName>(['recipe']), plain).recipe).toEqual({ value: null, sure: true });
    // Once its choice is live, it acts as read; unsure stays unsure.
    expect(liveRecipe({ value: 'pnr', sure: true }, ['trains', 'pnr'])).toEqual({ value: 'pnr', sure: true });
    expect(liveRecipe({ value: null, sure: false })).toEqual({ value: null, sure: false });
  });
  it('codeOnly has no Jev opinion at all', () => {
    const out = codeOnly(plain);
    expect(out.taskId).toEqual({ value: null, sure: true });
    expect(out.forGo.sure || out.complete.sure || out.size.sure || out.fact.sure || out.reaction.sure || out.risky.sure || out.opening.sure).toBe(false);
    expect(out.recipe).toEqual({ value: null, sure: false });
  });
});
