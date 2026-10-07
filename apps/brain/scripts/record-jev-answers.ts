/**
 * Records Jev's real answers for every row of the reflex test set, writes them for CI, and prints the
 * scores and a bar sweep. Needs Go's eval key (never the product key: a burst can get a key refused
 * for minutes). Run by hand:
 *   TYPESAFE_API_KEY=... pnpm --filter @go/brain jev:record
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJev, JEV_MODEL, type JevAnswer } from '../src/reflex/jev.js';
import { buildQuestions, buildState, QUESTION_VERSIONS } from '../src/reflex/questions.js';
import { formatScores, loadRows, RECORDED_PATH, rowInput, scoreSet, sweep, type Recorded } from '../src/reflex/testset.js';

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

const recorded: Recorded = { model, recorded_at: new Date().toISOString(), versions: QUESTION_VERSIONS, answers };
const out = fileURLToPath(RECORDED_PATH);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(recorded, null, 1)}\n`);
console.log(`wrote ${out}`);
const at = (q: number) => Math.round([...times].sort((x, y) => x - y)[Math.min(times.length - 1, Math.floor(q * times.length))]!);
console.log(`jev call, all questions: p50 ${at(0.5)} ms, p90 ${at(0.9)} ms, max ${at(1)} ms over ${times.length} calls`);
console.log(formatScores(scoreSet(rows, recorded)).join('\n'));
console.log(sweep(rows, recorded).join('\n'));
