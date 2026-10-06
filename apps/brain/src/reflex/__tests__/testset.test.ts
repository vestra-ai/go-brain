import { describe, expect, it } from 'vitest';
import type { JevAnswer } from '../jev.js';
import { PASSED_SETS } from '../live-gate.js';
import { buildQuestions, QUESTION_NAMES, QUESTION_NUMBER, QUESTION_VERSIONS } from '../questions.js';
import { hasSecret } from '../secrets.js';
import { gatePasses, loadRecorded, loadRows, rowInput, scoreSet, TestRow, type Recorded } from '../testset.js';

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

describe('the live gate', () => {
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
