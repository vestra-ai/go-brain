import { describe, expect, it } from 'vitest';
import type { JevAnswer } from '../jev.js';
import { LIVE_RECIPES, PASSED_SETS } from '../live-gate.js';
import { buildQuestions, isSearchChoice, QUESTION_NAMES, QUESTION_NUMBER, QUESTION_VERSIONS, RECIPE_CHOICES } from '../questions.js';
import { hasSecret } from '../secrets.js';
import { choicePasses, gatePasses, loadRecorded, loadRows, rowInput, scoreChoices, scoreSet, searchRecall, TestRow, type Recorded } from '../testset.js';

const rows = loadRows();

describe('the chat test set', () => {
  it('parses, with unique ids', () => {
    expect(rows.length).toBeGreaterThanOrEqual(50);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it('labels every question at least 6 times, at least twice in Hinglish', () => {
    for (const name of QUESTION_NAMES) {
      const labelled = rows.filter((r) => r.expect[name] !== undefined);
      expect(labelled.length, name).toBeGreaterThanOrEqual(6);
      expect(labelled.filter((r) => r.lang === 'hinglish').length, name).toBeGreaterThanOrEqual(2);
    }
    expect(rows.filter((r) => r.expect.risky === true).length).toBeGreaterThanOrEqual(5);
  });

  it('never quotes a row inside a question (that would inflate recall)', () => {
    for (const row of rows) {
      const asJson = JSON.stringify(buildQuestions(rowInput(row)).questions).toLowerCase();
      expect(asJson.includes(row.text.toLowerCase()), row.id).toBe(false);
    }
  });

  it('holds no secrets', () => {
    for (const row of rows) expect(hasSecret(row.text), row.id).toBe(false);
  });
});

describe('scoreSet', () => {
  const n = (p: number): JevAnswer => ({ type: 'noul', noul: p });
  const two = [
    TestRow.parse({ id: 's1', lang: 'en', speaker: 'p_priya', text: 'lol same', expect: { for_go: false } }),
    TestRow.parse({ id: 's2', lang: 'hinglish', speaker: 'p_arjun', text: 'koi trains dekho', expect: { for_go: true } }),
  ];
  const recorded = (s2: Record<string, JevAnswer>, versions: Record<string, string> = QUESTION_VERSIONS): Recorded => ({
    model: 'jev-1.13.0',
    recorded_at: '2026-10-06T10:00:00Z',
    versions,
    answers: { s1: { q1_chatter: n(0.97), q1_addressed: n(0.02) }, s2 },
  });
  const forGo = (r: Recorded) => scoreSet(two, r).find((s) => s.name === 'for_go')!;

  it('passes a question that is always right and sure', () => {
    const s = forGo(recorded({ q1_addressed: n(0.95), q1_chatter: n(0.03) }));
    expect(s).toMatchObject({ labelled: 2, right: 2, wrong: [], recall: 1, stale: false, missing: 0 });
    expect(s.byLang.hinglish).toEqual({ labelled: 1, right: 1 });
    expect(gatePasses(s)).toBe(true);
  });

  it('fails a question with one wrong sure answer', () => {
    const s = forGo(recorded({ q1_addressed: n(0.01), q1_chatter: n(0.97) }));
    expect(s.wrong).toEqual(['s2']);
    expect(gatePasses(s)).toBe(false);
  });

  it('fails a question whose wording changed since the recording', () => {
    const s = forGo(recorded({ q1_addressed: n(0.95), q1_chatter: n(0.03) }, { ...QUESTION_VERSIONS, for_go: '000000000000' }));
    expect(s.stale).toBe(true);
    expect(gatePasses(s)).toBe(false);
  });

  it('counts a missing recording as a failure', () => {
    const s = scoreSet(two, null).find((x) => x.name === 'for_go')!;
    expect(s.missing).toBe(2);
    expect(gatePasses(s)).toBe(false);
  });
});

describe('question 10 on the set', () => {
  const choice = (probabilities: Record<string, number>): JevAnswer => {
    const [top, confidence] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]!;
    return { type: 'choice', choice: top, confidence, probabilities };
  };
  const row = (id: string, recipe: string | null) => TestRow.parse({ id, lang: 'en', speaker: 'p_rahul', text: `line ${id}`, expect: { recipe } });
  const set = [row('f1', 'flights'), row('b1', 'buses'), row('x1', null), row('x2', null), row('x3', null)];
  const none = choice({ flights: 0.01, stays: 0.01, trains: 0.01, buses: 0.01, none: 0.96 });
  const rec = (answers: Record<string, JevAnswer>): Recorded => ({
    model: 'jev-1.13.0',
    recorded_at: '2026-10-07T10:00:00Z',
    versions: QUESTION_VERSIONS,
    answers: Object.fromEntries(set.map((r) => [r.id, { q10_recipe: answers[r.id] ?? none }])),
  });
  const recipe = (r: Recorded) => scoreSet(set, r).find((s) => s.name === 'recipe')!;

  it('scores each choice on its own', () => {
    const s = recipe(rec({ f1: choice({ flights: 0.93, stays: 0.02, trains: 0.02, buses: 0.02, none: 0.01 }), b1: choice({ trains: 0.5, buses: 0.45, flights: 0, stays: 0, none: 0.05 }) }));
    expect(s.byValue).toEqual({
      flights: { labelled: 1, right: 1, wrong: 0, unsure: 0 },
      buses: { labelled: 1, right: 0, wrong: 0, unsure: 1 },
      none: { labelled: 3, right: 3, wrong: 0, unsure: 0 },
    });
    expect(searchRecall(s)).toBe(0.5);
    expect(gatePasses(s)).toBe(true);
  });

  it('never passes a reader that is only ever sure of none, however many none rows it gets right', () => {
    const torn = choice({ flights: 0.45, stays: 0.05, trains: 0.0, buses: 0.45, none: 0.05 });
    const s = recipe(rec({ f1: torn, b1: torn }));
    expect(s.recall).toBe(0.6);
    expect(s.wrong).toEqual([]);
    expect(searchRecall(s)).toBe(0);
    expect(gatePasses(s)).toBe(false);
  });

  it('scores the live read: a pick still in shadow is none on both sides', () => {
    const rows = [...set, row('p1', 'pnr'), row('p2', 'pnr')];
    const base = rec({ f1: choice({ flights: 0.95, none: 0.05 }), b1: choice({ buses: 0.95, none: 0.05 }) });
    const r: Recorded = {
      ...base,
      answers: {
        ...base.answers,
        p1: { q10_recipe: choice({ pnr: 0.95, trains: 0.02, none: 0.03 }) },
        // A PNR line read as a trains search would start one: wrong live.
        p2: { q10_recipe: choice({ pnr: 0.03, trains: 0.94, none: 0.03 }) },
      },
    };
    const live = scoreSet(rows, r).find((x) => x.name === 'recipe')!;
    expect(live.byValue!.none).toEqual({ labelled: 5, right: 4, wrong: 1, unsure: 0 });
    expect(live.wrong).toEqual(['p2']);
    // Choice by choice, as Jev read it.
    const pnr = scoreChoices(rows, r).find((c) => c.choice === 'pnr')!;
    expect(pnr).toMatchObject({ labelled: 2, right: 1, missed: ['p2'], wrong: [] });
    expect(scoreChoices(rows, r).find((c) => c.choice === 'trains')!.wrong).toEqual(['p2']);
    expect(choicePasses(pnr)).toBe(false);
  });

  it('passes a choice only with no wrong pick, no miss, enough rows and most of them read', () => {
    const rows = ['a', 'b', 'c', 'd'].map((x) => row(`g${x}`, 'guide'));
    const sureGuide = { q10_recipe: choice({ guide: 0.96, none: 0.04 }) };
    const r = (unsure: number): Recorded => ({
      ...rec({}),
      answers: Object.fromEntries(rows.map((x, i) => [x.id, i < unsure ? { q10_recipe: choice({ guide: 0.6, none: 0.4 }) } : sureGuide])),
    });
    const guide = (u: number) => scoreChoices(rows, r(u)).find((c) => c.choice === 'guide')!;
    expect(guide(0)).toMatchObject({ labelled: 4, right: 4, unsure: 0, recall: 1 });
    expect(choicePasses(guide(0))).toBe(true);
    expect(choicePasses(guide(2))).toBe(true);
    expect(choicePasses(guide(3))).toBe(false);
    expect(choicePasses(scoreChoices(rows.slice(0, 3), r(0)).find((c) => c.choice === 'guide')!)).toBe(false);
  });

  it('fails on one wrong pick', () => {
    const s = recipe(rec({ f1: choice({ flights: 0.93, stays: 0.02, trains: 0.02, buses: 0.02, none: 0.01 }), b1: choice({ flights: 0.01, stays: 0.01, trains: 0.9, buses: 0.07, none: 0.01 }) }));
    expect(s.wrong).toEqual(['b1']);
    expect(s.byValue!.buses).toEqual({ labelled: 1, right: 0, wrong: 1, unsure: 0 });
    expect(gatePasses(s)).toBe(false);
  });
});

describe('the live gate', () => {
  it('lists only the searches and choices that pass their own gate on the recorded answers as live choices of question 10', () => {
    expect(LIVE_RECIPES.every((c) => RECIPE_CHOICES.includes(c))).toBe(true);
    const fast = LIVE_RECIPES.filter((c) => !isSearchChoice(c));
    if (fast.length === 0) return;
    const choices = scoreChoices(rows, loadRecorded());
    for (const c of fast) expect(choicePasses(choices.find((x) => x.choice === c)!), c).toBe(true);
  });

  it('lists only questions whose recorded answers pass their gate', () => {
    if (PASSED_SETS.length === 0) return;
    const rec = loadRecorded();
    expect(rec, 'PASSED_SETS is not empty, so testsets/recorded/jev-1.13.0.json must exist').not.toBeNull();
    expect(rec!.model).toBe('jev-1.13.0');
    const scores = scoreSet(rows, rec);
    for (const number of PASSED_SETS) {
      const name = QUESTION_NAMES.find((q) => QUESTION_NUMBER[q] === number)!;
      const s = scores.find((x) => x.name === name)!;
      expect(gatePasses(s), `${name}: ${JSON.stringify(s)}`).toBe(true);
    }
  });
});
