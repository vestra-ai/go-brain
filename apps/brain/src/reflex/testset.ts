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
import { LIVE_RECIPES } from './live-gate.js';
import { buildQuestions, QUESTION_NAMES, QUESTION_VERSIONS, RECIPE_CHOICES, type QuestionName, type RecipeChoice, type ReflexInput } from './questions.js';
import { liveRecipe, readAnswers } from './read.js';
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
    recipe: z.enum(RECIPE_CHOICES).nullable().optional(),
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
  record: 'recordKind', reaction: 'reaction', risky: 'risky', opening: 'opening', recipe: 'recipe',
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
  /** Per expected value ("none" for null): rows, right, sure and wrong, and unsure. Reaction and recipe only. */
  byValue?: Record<string, { labelled: number; right: number; wrong: number; unsure: number }>;
}

/**
 * What a question must reach on the set before it may act live. Wrong sure answers are never allowed, except question 8's
 * false alarms, which only add caution. Question 10 must also reach minRecall on the rows that ask for a search, so a
 * reader that always says none cannot pass on the none rows alone.
 */
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
  recipe: { minRecall: 0.5, maxWrong: 0 },
};

const BY_VALUE: ReadonlySet<QuestionName> = new Set(['reaction', 'recipe']);

/** A row's question 10 label as the live read can meet it: a choice still in shadow is "none" there. */
const liveLabel = (v: RecipeChoice | null, live: readonly RecipeChoice[]): RecipeChoice | null => (v !== null && !live.includes(v) ? null : v);

/**
 * Each question as it acts live. Question 10 is scored on its live read (read.ts liveRecipe): a choice still in shadow is
 * "none" on both sides, so a sure pick of one on a line that asks for it is right, and on a line that asks for a live
 * search it is a miss (the search would not start early). scoreChoices scores every choice as Jev read it.
 */
export function scoreSet(rows: TestRow[], rec: Recorded | null, bars: Bars = BARS, live: readonly RecipeChoice[] = LIVE_RECIPES): QuestionScore[] {
  return QUESTION_NAMES.map((name) => {
    const s: QuestionScore = {
      name, labelled: 0, sure: 0, right: 0, wrong: [], recall: 0,
      byLang: { en: { labelled: 0, right: 0 }, hinglish: { labelled: 0, right: 0 } },
      stale: !rec || rec.versions[name] !== QUESTION_VERSIONS[name],
      missing: 0,
    };
    for (const row of rows) {
      const label = row.expect[name];
      if (label === undefined) continue;
      const expected = name === 'recipe' ? liveLabel(label as RecipeChoice | null, live) : label;
      const input = rowInput(row);
      const answers = rec?.answers[row.id] ?? null;
      if (!answers) s.missing += 1;
      const facts = codeFacts(input.message, input.pack, input.runningTasks);
      const would = readAnswers(answers, facts, buildQuestions(input).taskKeys, bars).would;
      const got = (name === 'recipe' ? liveRecipe(would.recipe ?? { value: null, sure: false }, live) : would[FIELD[name]]) ?? { value: null, sure: false };
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
      const key = String(expected ?? 'none');
      const v = BY_VALUE.has(name) ? ((s.byValue ??= {})[key] ??= { labelled: 0, right: 0, wrong: 0, unsure: 0 }) : null;
      if (v) v.labelled += 1;
      if (!got.sure) {
        if (v) v.unsure += 1;
        continue;
      }
      s.sure += 1;
      if (got.value === expected) {
        s.right += 1;
        s.byLang[row.lang].right += 1;
        if (v) v.right += 1;
      } else {
        s.wrong.push(row.id);
        if (v) v.wrong += 1;
      }
    }
    s.recall = s.labelled ? s.right / s.labelled : 0;
    return s;
  });
}

/** One choice of question 10 as Jev read it, before the live list: what it would do once it acts. */
export interface ChoiceScore {
  choice: RecipeChoice;
  /** Rows that ask for it. */
  labelled: number;
  right: number;
  unsure: number;
  /** Rows that ask for it, read sure as another choice or as none. */
  missed: string[];
  /** Rows read sure as it that ask for another choice or for none: what would act wrongly once it is live. */
  wrong: string[];
  recall: number;
  /** The recording was made with different question wording, or rows that ask for it have no recorded answers. */
  stale: boolean;
  missing: number;
}

/** What a choice must reach before it joins LIVE_RECIPES: no wrong pick and no miss, and most of its rows read. */
export const CHOICE_GATE = { minLabelled: 4, minRecall: 0.5 };

export function scoreChoices(rows: TestRow[], rec: Recorded | null, bars: Bars = BARS): ChoiceScore[] {
  const stale = !rec || rec.versions['recipe'] !== QUESTION_VERSIONS.recipe;
  const scores = new Map<RecipeChoice, ChoiceScore>(
    RECIPE_CHOICES.map((choice) => [choice, { choice, labelled: 0, right: 0, unsure: 0, missed: [], wrong: [], recall: 0, stale, missing: 0 }]),
  );
  for (const row of rows) {
    const expected = row.expect.recipe;
    if (expected === undefined) continue;
    const input = rowInput(row);
    const answers = rec?.answers[row.id] ?? null;
    const facts = codeFacts(input.message, input.pack, input.runningTasks);
    const got = readAnswers(answers, facts, buildQuestions(input).taskKeys, bars).would.recipe ?? { value: null, sure: false };
    const own = expected === null ? null : scores.get(expected)!;
    if (own) {
      own.labelled += 1;
      if (!answers) own.missing += 1;
      if (!got.sure) own.unsure += 1;
      else if (got.value === expected) own.right += 1;
      else own.missed.push(row.id);
    }
    if (got.sure && got.value !== null && got.value !== expected) scores.get(got.value)!.wrong.push(row.id);
  }
  return [...scores.values()].map((c) => ({ ...c, recall: c.labelled ? c.right / c.labelled : 0 }));
}

export function choicePasses(c: ChoiceScore): boolean {
  return !c.stale && c.missing === 0 && c.labelled >= CHOICE_GATE.minLabelled && c.wrong.length === 0 && c.missed.length === 0 && c.recall >= CHOICE_GATE.minRecall;
}

export function formatChoices(choices: ChoiceScore[]): string[] {
  return choices.map(
    (c) =>
      `${choicePasses(c) ? 'PASS' : 'FAIL'} q10 ${c.choice.padEnd(14)} right=${c.right}/${c.labelled} (${c.recall.toFixed(2)}) unsure=${c.unsure} missed=${c.missed.length}${c.missed.length ? ` (${c.missed.join(',')})` : ''} wrong=${c.wrong.length}${c.wrong.length ? ` (${c.wrong.join(',')})` : ''}${c.stale ? ' STALE' : ''}${c.missing ? ` missing=${c.missing}` : ''}${LIVE_RECIPES.includes(c.choice) ? ' live' : ''}`,
  );
}

/** Recall on the rows that expect a search (question 10), leaving the none rows out. */
export function searchRecall(s: QuestionScore): number {
  const asks = Object.entries(s.byValue ?? {}).filter(([value]) => value !== 'none').map(([, v]) => v);
  const labelled = asks.reduce((n, v) => n + v.labelled, 0);
  return labelled ? asks.reduce((n, v) => n + v.right, 0) / labelled : 0;
}

export function gatePasses(s: QuestionScore): boolean {
  const g = GATES[s.name];
  if (s.name === 'recipe' && searchRecall(s) < g.minRecall) return false;
  return !s.stale && s.missing === 0 && s.wrong.length <= g.maxWrong && s.recall >= g.minRecall;
}

export const SWEEPS: Array<{ name: QuestionName; bar: string; values: number[]; apply: (b: Bars, v: number) => Bars }> = [
  { name: 'for_go', bar: 'chatterMin', values: [0.8, 0.85, 0.9, 0.95], apply: (b, v) => ({ ...b, for_go: { ...b.for_go, chatterMin: v } }) },
  { name: 'for_go', bar: 'notAddressedMax', values: [0.05, 0.1, 0.15, 0.2, 0.25, 0.3], apply: (b, v) => ({ ...b, for_go: { ...b.for_go, notAddressedMax: v } }) },
  { name: 'for_go', bar: 'addressedMin', values: [0.8, 0.85, 0.9, 0.95], apply: (b, v) => ({ ...b, for_go: { ...b.for_go, addressedMin: v } }) },
  { name: 'complete', bar: 'namedMin', values: [0.4, 0.45, 0.5, 0.55, 0.6, 0.7], apply: (b, v) => ({ ...b, complete: { ...b.complete, namedMin: v } }) },
  { name: 'size', bar: 'kindMin', values: [0.8, 0.85, 0.9, 0.95], apply: (b, v) => ({ ...b, size: { ...b.size, kindMin: v } }) },
  { name: 'size', bar: 'otherMax', values: [0.1, 0.2, 0.3], apply: (b, v) => ({ ...b, size: { ...b.size, otherMax: v } }) },
  { name: 'task', bar: 'pickMin', values: [0.7, 0.8, 0.85, 0.9], apply: (b, v) => ({ ...b, task: { ...b.task, pickMin: v } }) },
  { name: 'fact', bar: 'yesMin', values: [0.6, 0.7, 0.8, 0.9], apply: (b, v) => ({ ...b, fact: { ...b.fact, yesMin: v } }) },
  { name: 'record', bar: 'kindMin', values: [0.6, 0.7, 0.8, 0.9], apply: (b, v) => ({ ...b, record: { ...b.record, kindMin: v } }) },
  { name: 'reaction', bar: 'pickMin', values: [0.8, 0.85, 0.9, 0.95], apply: (b, v) => ({ ...b, reaction: { ...b.reaction, pickMin: v } }) },
  { name: 'risky', bar: 'raiseAt', values: [0.3, 0.4, 0.5, 0.6], apply: (b, v) => ({ ...b, risky: { ...b.risky, raiseAt: v } }) },
  { name: 'opening', bar: 'yesMin', values: [0.8, 0.85, 0.9, 0.95], apply: (b, v) => ({ ...b, opening: { ...b.opening, yesMin: v } }) },
  { name: 'recipe', bar: 'pickMin', values: [0.5, 0.6, 0.7, 0.8, 0.9], apply: (b, v) => ({ ...b, recipe: { ...b.recipe, pickMin: v } }) },
  { name: 'recipe', bar: 'rivalMax', values: [0.1, 0.2, 0.3, 0.4], apply: (b, v) => ({ ...b, recipe: { ...b.recipe, rivalMax: v } }) },
];

/** One line per bar value: how recall and wrong answers move. Pick the value with zero wrong and the best recall. */
export function sweep(rows: TestRow[], rec: Recorded): string[] {
  const lines: string[] = [];
  for (const sw of SWEEPS) {
    for (const v of sw.values) {
      const s = scoreSet(rows, rec, sw.apply(BARS, v)).find((x) => x.name === sw.name)!;
      const asks = sw.name === 'recipe' ? ` search_recall=${searchRecall(s).toFixed(2)}` : '';
      lines.push(`${sw.name.padEnd(9)} ${sw.bar}=${v.toFixed(2)} recall=${s.recall.toFixed(2)}${asks} wrong=${s.wrong.length}${s.wrong.length ? ` (${s.wrong.join(',')})` : ''}`);
    }
  }
  return lines;
}

export function formatScores(scores: QuestionScore[]): string[] {
  return scores.flatMap((s) => {
    const lang = (l: 'en' | 'hinglish') => (s.byLang[l].labelled ? (s.byLang[l].right / s.byLang[l].labelled).toFixed(2) : '-');
    const line = `${gatePasses(s) ? 'PASS' : 'FAIL'} ${s.name.padEnd(9)} recall=${s.recall.toFixed(2)} (en ${lang('en')}, hinglish ${lang('hinglish')}) sure=${s.sure}/${s.labelled} wrong=${s.wrong.length}${s.wrong.length ? ` (${s.wrong.join(',')})` : ''}${s.stale ? ' STALE' : ''}${s.missing ? ` missing=${s.missing}` : ''}${s.name === 'recipe' ? ` search_recall=${searchRecall(s).toFixed(2)}` : ''}`;
    const values = Object.entries(s.byValue ?? {}).map(
      ([value, v]) => `     ${s.name}=${value.padEnd(7)} right=${v.right}/${v.labelled} (${(v.right / v.labelled).toFixed(2)}) wrong=${v.wrong} unsure=${v.unsure}`,
    );
    return [line, ...values];
  });
}
