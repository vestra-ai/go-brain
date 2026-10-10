/**
 * Records Jev's real answers for every row of the reflex test set, writes them for CI, and prints the
 * scores and a bar sweep. Every question is asked, as Go asks them, but only a question whose wording changed since the
 * last recording is written again: the others keep their recorded answers, which stay valid (JEV_RECORD_ALL=1 writes
 * every question afresh). This run's own scores for every question are printed too, so a gate that moved between two
 * runs of the same wording shows up as drift instead of being committed. Needs Go's eval key (never the product key: a burst can get a key refused
 * for minutes). Run by hand:
 *   TYPESAFE_API_KEY=... pnpm --filter @go/brain jev:record
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJev, JEV_MODEL, type JevAnswer } from '../src/reflex/jev.js';
import { buildQuestions, buildState, QUESTION_NAMES, QUESTION_NUMBER, QUESTION_VERSIONS, type QuestionName } from '../src/reflex/questions.js';
import { formatChoices, formatScores, loadRecorded, loadRows, RECORDED_PATH, rowInput, scoreChoices, scoreSet, sweep, type Recorded } from '../src/reflex/testset.js';

const key = process.env.TYPESAFE_API_KEY;
if (!key) {
  console.error("TYPESAFE_API_KEY is not set. Use Go's eval key.");
  process.exit(1);
}
const model = process.env.JEV_MODEL ?? JEV_MODEL;
const jev = createJev({ apiKey: key, baseUrl: process.env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai', model });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const rows = loadRows();
const answers: Record<string, Record<string, JevAnswer>> = {};
const times: number[] = [];
for (const row of rows) {
  const input = rowInput(row);
  const req = { state: buildState(input), questions: buildQuestions(input).questions, deadlineMs: 5_000 };
  let res = await jev.ask(req);
  if (!res.ok) {
    await pause(2_000);
    res = await jev.ask(req);
  }
  if (!res.ok) {
    console.error(`${row.id}: ${res.fault} ${res.status ?? ''}`);
    process.exit(1);
  }
  answers[row.id] = res.answers;
  times.push(res.totalMs);
  await pause(150);
}

// The last recording of the same model: its answers to the questions whose wording is unchanged are kept.
const last = loadRecorded();
const before = last?.model === model ? last : null;
const changed = (name: QuestionName): boolean => !before || process.env.JEV_RECORD_ALL === '1' || before.versions[name] !== QUESTION_VERSIONS[name];
/** The question an answer's key belongs to: q10_recipe is question 10's, q4_is_t2 question 4's. */
const questionOf = (key: string): QuestionName | undefined => {
  const n = Number(/^q(\d+)_/.exec(key)?.[1]);
  return QUESTION_NAMES.find((q) => QUESTION_NUMBER[q] === n);
};
const rerecorded = QUESTION_NAMES.filter(changed);
const kept: Record<string, Record<string, JevAnswer>> = {};
for (const row of rows) {
  const fresh = Object.entries(answers[row.id] ?? {}).filter(([key]) => { const q = questionOf(key); return q === undefined || changed(q); });
  const old = Object.entries(before?.answers[row.id] ?? {}).filter(([key]) => { const q = questionOf(key); return q !== undefined && !changed(q); });
  kept[row.id] = Object.fromEntries([...old, ...fresh]);
}
const recorded: Recorded & { kept?: { recorded_at: string; questions: string[] } } = {
  model, recorded_at: new Date().toISOString(), versions: QUESTION_VERSIONS, answers: kept,
  ...(before && rerecorded.length < QUESTION_NAMES.length ? { kept: { recorded_at: before.recorded_at, questions: QUESTION_NAMES.filter((q) => !changed(q)) } } : {}),
};
const out = fileURLToPath(RECORDED_PATH);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(recorded, null, 1)}\n`);
console.log(`wrote ${out}`);
const at = (q: number) => Math.round([...times].sort((x, y) => x - y)[Math.min(times.length - 1, Math.floor(q * times.length))]!);
console.log(`jev call, all questions: p50 ${at(0.5)} ms, p90 ${at(0.9)} ms, max ${at(1)} ms over ${times.length} calls`);
console.log(`written again: ${rerecorded.join(', ') || 'none'}; kept from ${before?.recorded_at ?? '-'}: ${QUESTION_NAMES.filter((q) => !changed(q)).join(', ') || 'none'}`);
console.log('\nthis run, every question afresh (drift check, not written):');
console.log(formatScores(scoreSet(rows, { model, recorded_at: recorded.recorded_at, versions: QUESTION_VERSIONS, answers })).join('\n'));
console.log('\nwritten (what CI gates):');
console.log(formatScores(scoreSet(rows, recorded)).join('\n'));
// Question 10 choice by choice, as Jev read it: a shadow choice joins LIVE_RECIPES only once it passes here.
console.log(formatChoices(scoreChoices(rows, recorded)).join('\n'));
console.log(sweep(rows, recorded).join('\n'));
