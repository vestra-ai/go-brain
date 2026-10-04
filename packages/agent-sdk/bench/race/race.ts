/**
 * race: the head-to-head of our native engine against the Claude Code engine on the same
 * model (harness-nine B8c). Three steps, and only the middle one spends:
 *
 *   1. plan: the running order, from a seed (free).
 *        pnpm --filter @vestra/agent-sdk race plan --out race-plan.json [--runs 2] [--seed 7]
 *          [--engines native,claude_code] [--model claude-sonnet-5-5] [--tasks a,b]
 *   2. run: every slot on a real staging box, each engine on its own drill account (apps/server/scripts/drills/race-box.mjs --engine).
 *   3. report: the blind judge, then the tables, the JSON and the page (judge calls only, on Fireworks).
 *        FIREWORKS_API_KEY=... pnpm --filter @vestra/agent-sdk race report --in race-runs-native.json,race-runs-cc.json
 *          --json race-report.json --html ../../mockups/harness-nine/race.html [--judge-model deepseek-v4.1-flash | --no-judge true]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderRaceHtml } from './html.js';
import { DEFAULT_JUDGE_MODEL, assertJudgeModel, judgeRun, type RaceVerdict } from './judge.js';
import { RACE_ENGINES, buildPlan, type RaceEngine } from './plan.js';
import { RACE_RUNS_SCHEMA, type RaceRunsFile } from './record.js';
import { buildReport, type JudgedRun } from './report.js';
import { RACE_TASKS, pickRaceTasks } from './tasks.js';

const OPTIONS = {
  plan: ['out', 'runs', 'seed', 'engines', 'model', 'tasks'],
  report: ['in', 'json', 'html', 'judge-model', 'no-judge'],
} as const;
type Command = keyof typeof OPTIONS;

/** `<command> --name value ...`; an unknown command or option, or one with no value, throws (never ignored). */
export function parseRaceArgs(argv: readonly string[]): { command: Command; opts: Record<string, string> } {
  const command = argv[0] as Command;
  if (!(command in OPTIONS)) throw new Error(`race: the first argument is plan or report, got ${JSON.stringify(argv[0] ?? '')}`);
  const allowed: readonly string[] = OPTIONS[command];
  const opts: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const name = flag.startsWith('--') ? flag.slice(2) : '';
    if (!allowed.includes(name)) throw new Error(`race ${command}: unknown argument ${JSON.stringify(flag)} (options: ${allowed.map((o) => `--${o}`).join(' ')})`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`race ${command}: ${flag} needs a value`);
    opts[name] = value;
  }
  return { command, opts };
}

const csv = (v: string | undefined): string[] => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

export function readRunsFile(path: string): RaceRunsFile {
  const file = JSON.parse(readFileSync(path, 'utf8')) as RaceRunsFile;
  if (file.schema !== RACE_RUNS_SCHEMA) throw new Error(`race report: ${path} is not a race runs file (schema ${String(file.schema)})`);
  return file;
}

/** One engine per account means one runs file per engine: join them, refusing files from different races. */
export function mergeRunsFiles(files: readonly RaceRunsFile[]): RaceRunsFile {
  const first = files[0];
  if (!first) throw new Error('race report: no runs files');
  const odd = files.find((f) => f.model !== first.model || f.seed !== first.seed);
  if (odd) throw new Error(`race report: runs files from different races (${first.model} seed ${first.seed} vs ${odd.model} seed ${odd.seed})`);
  return {
    ...first,
    startedAt: files.map((f) => f.startedAt).sort()[0]!,
    where: [...new Set(files.map((f) => f.where))].join('; '),
    runs: files.flatMap((f) => f.runs).sort((a, b) => a.slot - b.slot),
  };
}

/** Judge every run that ran, a few at a time. */
export async function judgeAll(file: RaceRunsFile, judge: (run: JudgedRun) => Promise<RaceVerdict>, concurrency = 4): Promise<JudgedRun[]> {
  const out: JudgedRun[] = file.runs.map((r) => ({ ...r }));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= out.length) return;
      const run = out[i]!;
      if (run.skipped !== undefined) continue;
      run.verdict = await judge(run);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

async function main(argv: readonly string[]): Promise<void> {
  const { command, opts } = parseRaceArgs(argv);
  if (command === 'plan') {
    if (!opts.out) throw new Error('race plan: --out is required');
    const engines = csv(opts.engines) as RaceEngine[];
    const bad = engines.filter((e) => !(RACE_ENGINES as readonly string[]).includes(e));
    if (bad.length) throw new Error(`race plan: unknown engine ${bad.join(', ')} (${RACE_ENGINES.join(', ')})`);
    const plan = buildPlan({
      tasks: pickRaceTasks(csv(opts.tasks)),
      ...(engines.length ? { engines } : {}),
      ...(opts.runs ? { runs: Number(opts.runs) } : {}),
      ...(opts.seed ? { seed: Number(opts.seed) } : {}),
      ...(opts.model ? { model: opts.model } : {}),
    });
    writeFileSync(opts.out, `${JSON.stringify(plan, null, 2)}\n`);
    console.log(`race plan: ${plan.slots.length} slots (${plan.slots.length / plan.runs} per run, ${plan.runs} runs) on ${plan.model}, seed ${plan.seed} -> ${opts.out}`);
    return;
  }
  if (!opts.in) throw new Error('race report: --in is required');
  const file = mergeRunsFiles(csv(opts.in).map(readRunsFile));
  const noJudge = opts['no-judge'] === 'true';
  const judgeModel = noJudge ? null : (opts['judge-model'] ?? DEFAULT_JUDGE_MODEL);
  let runs: JudgedRun[] = file.runs;
  if (judgeModel) {
    assertJudgeModel(judgeModel);
    const apiKey = process.env.FIREWORKS_API_KEY;
    if (!apiKey) throw new Error('race report: FIREWORKS_API_KEY is not set (the judge needs it); pass --no-judge true for timings and cost only');
    runs = await judgeAll(file, (run) => {
      const task = RACE_TASKS.find((t) => t.id === run.task);
      if (!task) throw new Error(`race report: run ${run.slot} names an unknown task ${run.task}`);
      return judgeRun(task, run, { model: judgeModel, apiKey });
    });
  }
  const report = buildReport(file, runs, judgeModel);
  if (opts.json) writeFileSync(opts.json, `${JSON.stringify(report, null, 2)}\n`);
  if (opts.html) writeFileSync(opts.html, renderRaceHtml(report));
  for (const e of report.engines) {
    const t = report.totals[e]!;
    console.log(`race report: ${e} ${t.passed}/${t.judged} passed, median turn ${t.totalMsMedian ?? 'n/a'} ms, list $${t.listUsd}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
