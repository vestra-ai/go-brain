/**
 * Test sets for the reflex: labelled chat lines (English and Hinglish), Jev's real answers recorded
 * once by hand, and a scorer that replays those answers through the readers so CI checks every bar
 * without calling Jev. A question goes live only when its gate passes here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { goaTrip, msg, packOf } from './goa.fixture.js';
import type { JevAnswer } from './jev.js';
import { codeFacts } from './jev-reflex.js';
import { buildQuestions, QUESTION_NAMES, QUESTION_VERSIONS, type QuestionName, type ReflexInput } from './questions.js';
import { readAnswers } from './read.js';
import { BARS, type Bars } from './thresholds.js';

export const TestRow = z.object({
  id: z.string().min(1),
  lang: z.enum(['en', 'hinglish']),
  speaker: z.enum(['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir']),
  text: z.string().min(1).max(800),
  mentions_go: z.boolean().default(false),
  before: z.array(z.object({ speaker: z.string().min(1), text: z.string().min(1) })).max(3).default([]),
  tasks: z.array(z.object({ id: z.string().min(1), brief: z.string().min(1) })).max(5).default([]),
  expect: z.object({
    for_go: z.boolean().optional(),
    complete: z.boolean().optional(),
    size: z.enum(['quick', 'big']).optional(),
    task: z.string().nullable().optional(),
    fact: z.boolean().optional(),
    record: z.enum(['agreed', 'open', 'doing']).nullable().optional(),
    reaction: z.enum(['✅', '👍', '🙌']).nullable().optional(),
    risky: z.boolean().optional(),
    opening: z.boolean().optional(),
  }),
});
export type TestRow = z.infer<typeof TestRow>;

const RecordedFile = z.object({
  model: z.string().min(1),
  recorded_at: z.string().min(1),
  versions: z.record(z.string(), z.string()),
  answers: z.record(z.string(), z.record(z.string(), z.unknown())),
});
export interface Recorded {
  model: string;
  recorded_at: string;
  versions: Record<string, string>;
  answers: Record<string, Record<string, JevAnswer>>;
}

export const TESTSET_PATH = new URL('./testsets/chat.jsonl', import.meta.url);
export const RECORDED_PATH = new URL('./testsets/recorded/jev-1.13.0.json', import.meta.url);

export function loadRows(path: URL | string = TESTSET_PATH): TestRow[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, i) => {
      const parsed = TestRow.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error(`chat.jsonl line ${i + 1}: ${z.prettifyError(parsed.error)}`);
      return parsed.data;
    });
}

export function loadRecorded(path: URL | string = RECORDED_PATH): Recorded | null {
  if (!existsSync(path)) return null;
  // The readers check every answer's shape, so the file only needs the outer shape here.
  return RecordedFile.parse(JSON.parse(readFileSync(path, 'utf8'))) as unknown as Recorded;
}

/** The row as the reflex would see it: earlier lines, then the row's message, in the Goa trip. */
export function rowInput(row: TestRow): ReflexInput {
  const before = row.before.map((b, i) => msg(i + 1, b.speaker, b.text));
  const message = msg(before.length + 1, row.speaker, row.text, { mentions_go: row.mentions_go });
  return { message, pack: packOf([...before, message], goaTrip()), runningTasks: row.tasks };
}

const FIELD = {
  for_go: 'forGo', complete: 'complete', size: 'size', task: 'taskId', fact: 'fact',
  record: 'recordKind', reaction: 'reaction', risky: 'risky', opening: 'opening',
} as const satisfies Record<QuestionName, string>;

export interface QuestionScore {
  name: QuestionName;
  /** Rows labelled for this question (for risky: rows labelled risky). */
  labelled: number;
  sure: number;
  right: number;
  /** Row ids answered sure and wrong (for risky: false alarms). */
  wrong: string[];
  recall: number;
  byLang: Record<'en' | 'hinglish', { labelled: number; right: number }>;
  /** The recording was made with different question wording. */
  stale: boolean;
  /** Labelled rows with no recorded answers. */
  missing: number;
}

/** What a question must reach on the set before it may act live. Wrong sure answers are never allowed, except question 8's false alarms, which only add caution. */
export const GATES: Record<QuestionName, { minRecall: number; maxWrong: number }> = {
  for_go: { minRecall: 0.5, maxWrong: 0 },
  complete: { minRecall: 0.5, maxWrong: 0 },
  size: { minRecall: 0.4, maxWrong: 0 },
  task: { minRecall: 0.5, maxWrong: 0 },
  fact: { minRecall: 0.5, maxWrong: 0 },
  record: { minRecall: 0.4, maxWrong: 0 },
  reaction: { minRecall: 0.3, maxWrong: 0 },
  risky: { minRecall: 0.8, maxWrong: 2 },
  opening: { minRecall: 0.3, maxWrong: 0 },
};

export function scoreSet(rows: TestRow[], rec: Recorded | null, bars: Bars = BARS): QuestionScore[] {
  return QUESTION_NAMES.map((name) => {
    const s: QuestionScore = {
      name, labelled: 0, sure: 0, right: 0, wrong: [], recall: 0,
      byLang: { en: { labelled: 0, right: 0 }, hinglish: { labelled: 0, right: 0 } },
      stale: !rec || rec.versions[name] !== QUESTION_VERSIONS[name],
      missing: 0,
    };
    for (const row of rows) {
      const expected = row.expect[name];
      if (expected === undefined) continue;
      const input = rowInput(row);
      const answers = rec?.answers[row.id] ?? null;
      if (!answers) s.missing += 1;
      const facts = codeFacts(input.message, input.pack, input.runningTasks);
      const got = readAnswers(answers, facts, buildQuestions(input).taskKeys, bars).would[FIELD[name]];
      if (name === 'risky') {
        const raised = got.sure && got.value === true;
        if (expected === true) {
          s.labelled += 1;
          s.byLang[row.lang].labelled += 1;
          if (raised) {
            s.sure += 1;
            s.right += 1;
            s.byLang[row.lang].right += 1;
          }
        } else if (raised) {
          s.sure += 1;
          s.wrong.push(row.id);
        }
        continue;
      }
      s.labelled += 1;
      s.byLang[row.lang].labelled += 1;
      if (!got.sure) continue;
      s.sure += 1;
      if (got.value === expected) {
        s.right += 1;
        s.byLang[row.lang].right += 1;
      } else {
        s.wrong.push(row.id);
      }
    }
    s.recall = s.labelled ? s.right / s.labelled : 0;
    return s;
  });
}

export function gatePasses(s: QuestionScore): boolean {
  const g = GATES[s.name];
  return !s.stale && s.missing === 0 && s.wrong.length <= g.maxWrong && s.recall >= g.minRecall;
}

export const SWEEPS: Array<{ name: QuestionName; bar: string; values: number[]; apply: (b: Bars, v: number) => Bars }> = [
  { name: 'for_go', bar: 'chatterMin', values: [0.8, 0.85, 0.9, 0.95], apply: (b, v) => ({ ...b, for_go: { ...b.for_go, chatterMin: v } }) },
  { name: 'for_go', bar: 'addressedMin', values: [0.8, 0.85, 0.9, 0.95], apply: (b, v) => ({ ...b, for_go: { ...b.for_go, addressedMin: v } }) },
  { name: 'complete', bar: 'yesMin', values: [0.75, 0.8, 0.85, 0.9], apply: (b, v) => ({ ...b, complete: { ...b.complete, yesMin: v } }) },
  { name: 'size', bar: 'kindMin', values: [0.8, 0.85, 0.9, 0.95], apply: (b, v) => ({ ...b, size: { ...b.size, kindMin: v } }) },
  { name: 'size', bar: 'otherMax', values: [0.1, 0.2, 0.3], apply: (b, v) => ({ ...b, size: { ...b.size, otherMax: v } }) },
  { name: 'task', bar: 'pickMin', values: [0.7, 0.8, 0.85, 0.9], apply: (b, v) => ({ ...b, task: { ...b.task, pickMin: v } }) },
  { name: 'fact', bar: 'yesMin', values: [0.6, 0.7, 0.8, 0.9], apply: (b, v) => ({ ...b, fact: { ...b.fact, yesMin: v } }) },
  { name: 'record', bar: 'kindMin', values: [0.6, 0.7, 0.8, 0.9], apply: (b, v) => ({ ...b, record: { ...b.record, kindMin: v } }) },
  { name: 'reaction', bar: 'pickMin', values: [0.8, 0.85, 0.9, 0.95], apply: (b, v) => ({ ...b, reaction: { ...b.reaction, pickMin: v } }) },
  { name: 'risky', bar: 'raiseAt', values: [0.3, 0.4, 0.5, 0.6], apply: (b, v) => ({ ...b, risky: { ...b.risky, raiseAt: v } }) },
  { name: 'opening', bar: 'yesMin', values: [0.8, 0.85, 0.9, 0.95], apply: (b, v) => ({ ...b, opening: { ...b.opening, yesMin: v } }) },
];

/** One line per bar value: how recall and wrong answers move. Pick the value with zero wrong and the best recall. */
export function sweep(rows: TestRow[], rec: Recorded): string[] {
  const lines: string[] = [];
  for (const sw of SWEEPS) {
    for (const v of sw.values) {
      const s = scoreSet(rows, rec, sw.apply(BARS, v)).find((x) => x.name === sw.name)!;
      lines.push(`${sw.name.padEnd(9)} ${sw.bar}=${v.toFixed(2)} recall=${s.recall.toFixed(2)} wrong=${s.wrong.length}${s.wrong.length ? ` (${s.wrong.join(',')})` : ''}`);
    }
  }
  return lines;
}

export function formatScores(scores: QuestionScore[]): string[] {
  return scores.map((s) => {
    const lang = (l: 'en' | 'hinglish') => (s.byLang[l].labelled ? (s.byLang[l].right / s.byLang[l].labelled).toFixed(2) : '-');
    return `${gatePasses(s) ? 'PASS' : 'FAIL'} ${s.name.padEnd(9)} recall=${s.recall.toFixed(2)} (en ${lang('en')}, hinglish ${lang('hinglish')}) sure=${s.sure}/${s.labelled} wrong=${s.wrong.length}${s.wrong.length ? ` (${s.wrong.join(',')})` : ''}${s.stale ? ' STALE' : ''}${s.missing ? ` missing=${s.missing}` : ''}`;
  });
}
