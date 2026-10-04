/**
 * The race's numbers: one table per dimension (speed, model calls, tokens, dollars, success),
 * each a row per task with both engines side by side, plus the overall line, the per-category
 * success, and the ten tasks a person should check by hand.
 *
 * Speed is read on the task's measured turn (the follow-ups' question, not the reading of the
 * handbook). Model calls, tokens and dollars are the whole task. With two runs a "per task"
 * number is the median of the runs (their mean), and an overall number is the median over
 * tasks. A run that timed out has no time and counts as a failure; a skipped run (a missing
 * precondition) counts as neither and is listed.
 */
import { RACE_ENGINES, type RaceEngine } from './plan.js';
import { listPriceUsd, type RaceRunRecord, type RaceRunsFile } from './record.js';
import type { RaceVerdict } from './judge.js';
import { RACE_CATEGORIES, RACE_TASKS, type RaceCategory } from './tasks.js';

export const RACE_REPORT_SCHEMA = 'vestra.race-report/v1';

export interface JudgedRun extends RaceRunRecord {
  verdict?: RaceVerdict;
}

export interface EngineCell {
  runs: number;
  firstVisibleMs: number | null;
  firstTextMs: number | null;
  firstToolMs: number | null;
  totalMs: number | null;
  modelCalls: number | null;
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  listUsd: number | null;
  ledgerUsd: number | null;
  /** Runs the judge passed, out of runs it judged. */
  passed: number;
  judged: number;
}

export interface TaskRow {
  task: string;
  category: RaceCategory;
  engines: Partial<Record<RaceEngine, EngineCell>>;
}

export interface EngineTotals {
  runs: number;
  skipped: number;
  errored: number;
  timedOut: number;
  firstVisibleMsMedian: number | null;
  firstTextMsMedian: number | null;
  firstToolMsMedian: number | null;
  totalMsMedian: number | null;
  modelCallsMedian: number | null;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  listUsd: number;
  ledgerUsd: number | null;
  passed: number;
  judged: number;
  byCategory: Record<string, { passed: number; judged: number }>;
}

export interface SpotCheck {
  task: string;
  category: RaceCategory;
  why: string;
  /** The Vestra task ids of every run of this task, to open in the app. */
  runs: Array<{ engine: RaceEngine; run: number; taskId: string; pass: boolean | null }>;
}

type SpeedKey = 'firstVisibleMs' | 'firstToolMs' | 'totalMs';

export interface RaceReport {
  schema: typeof RACE_REPORT_SCHEMA;
  model: string;
  where: string;
  startedAt: string;
  seed: number;
  judgeModel: string | null;
  engines: RaceEngine[];
  rows: TaskRow[];
  totals: Partial<Record<RaceEngine, EngineTotals>>;
  /** Tasks where both engines ran: how many each won, per speed metric (lower is better). */
  headToHead: Record<SpeedKey, { native: number; claude_code: number; tie: number }> | null;
  spotCheck: SpotCheck[];
  skipped: Array<{ task: string; engine: RaceEngine; run: number; reason: string }>;
  runs: JudgedRun[];
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round(((s[mid - 1]! + s[mid]!) / 2) * 1000) / 1000;
}

const nums = (xs: ReadonlyArray<number | null | undefined>): number[] => xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

const measureTurnOf = (task: string): number => RACE_TASKS.find((t) => t.id === task)?.measureTurn ?? 0;

function measured(r: RaceRunRecord) {
  return r.turns[measureTurnOf(r.task)] ?? r.turns.at(-1);
}

/** The whole task's model calls: the sum over turns that said, null when none did. */
function modelCallsOf(r: RaceRunRecord): number | null {
  const said = nums(r.turns.map((t) => t.modelCalls));
  return said.length ? sum(said) : null;
}

function cell(runs: readonly JudgedRun[], model: string): EngineCell {
  const usd = runs.map((r) => listPriceUsd(model, r.tokens));
  return {
    runs: runs.length,
    firstVisibleMs: median(nums(runs.map((r) => measured(r)?.firstVisibleMs))),
    firstTextMs: median(nums(runs.map((r) => measured(r)?.firstTextMs))),
    firstToolMs: median(nums(runs.map((r) => measured(r)?.firstToolMs))),
    totalMs: median(nums(runs.map((r) => measured(r)?.totalMs))),
    modelCalls: median(nums(runs.map(modelCallsOf))),
    inputTokens: median(runs.map((r) => r.tokens.input)),
    cachedTokens: median(runs.map((r) => r.tokens.cachedInput)),
    outputTokens: median(runs.map((r) => r.tokens.output)),
    listUsd: usd.every((x) => x !== null) ? median(nums(usd)) : null,
    ledgerUsd: median(nums(runs.map((r) => r.ledgerUsd))),
    passed: runs.filter((r) => r.verdict?.pass === true).length,
    judged: runs.filter((r) => typeof r.verdict?.pass === 'boolean').length,
  };
}

function totalsFor(runs: readonly JudgedRun[], all: readonly JudgedRun[], rows: readonly TaskRow[], engine: RaceEngine, model: string): EngineTotals {
  const cells = rows.map((row) => row.engines[engine]).filter((c): c is EngineCell => c !== undefined);
  const byCategory: EngineTotals['byCategory'] = {};
  for (const cat of RACE_CATEGORIES) {
    const inCat = runs.filter((r) => r.category === cat);
    byCategory[cat] = { passed: inCat.filter((r) => r.verdict?.pass === true).length, judged: inCat.filter((r) => typeof r.verdict?.pass === 'boolean').length };
  }
  const ledger = nums(runs.map((r) => r.ledgerUsd));
  return {
    runs: runs.length,
    skipped: all.filter((r) => r.engine === engine && r.skipped !== undefined).length,
    errored: runs.filter((r) => r.error !== undefined).length,
    timedOut: runs.filter((r) => r.turns.some((t) => t.totalMs === null)).length,
    firstVisibleMsMedian: median(nums(cells.map((c) => c.firstVisibleMs))),
    firstTextMsMedian: median(nums(cells.map((c) => c.firstTextMs))),
    firstToolMsMedian: median(nums(cells.map((c) => c.firstToolMs))),
    totalMsMedian: median(nums(cells.map((c) => c.totalMs))),
    modelCallsMedian: median(nums(cells.map((c) => c.modelCalls))),
    inputTokens: sum(runs.map((r) => r.tokens.input)),
    cachedTokens: sum(runs.map((r) => r.tokens.cachedInput)),
    outputTokens: sum(runs.map((r) => r.tokens.output)),
    listUsd: round6(sum(nums(runs.map((r) => listPriceUsd(model, r.tokens))))),
    ledgerUsd: ledger.length ? round6(sum(ledger)) : null,
    passed: runs.filter((r) => r.verdict?.pass === true).length,
    judged: runs.filter((r) => typeof r.verdict?.pass === 'boolean').length,
    byCategory,
  };
}

function headToHead(rows: readonly TaskRow[]): RaceReport['headToHead'] {
  const both = rows.filter((r) => r.engines.native && r.engines.claude_code);
  if (both.length === 0) return null;
  const tally = (k: SpeedKey) => {
    const out = { native: 0, claude_code: 0, tie: 0 };
    for (const r of both) {
      const a = r.engines.native![k];
      const b = r.engines.claude_code![k];
      if (a === null || b === null) continue;
      if (a < b) out.native++;
      else if (b < a) out.claude_code++;
      else out.tie++;
    }
    return out;
  };
  return { firstVisibleMs: tally('firstVisibleMs'), firstToolMs: tally('firstToolMs'), totalMs: tally('totalMs') };
}

/**
 * The ten tasks a person should open, most telling first: where the engines disagree on
 * success, where the judge and the fact check disagree, where the judge could not read a run,
 * where a run timed out or errored; then one per category not yet covered, then the rest in
 * task order. Deterministic, so two reports of the same runs ask for the same checks.
 */
export function pickSpotChecks(rows: readonly TaskRow[], runs: readonly JudgedRun[], n = 10): SpotCheck[] {
  const reasons = new Map<string, string>();
  const runsOf = (task: string) => runs.filter((r) => r.task === task && r.skipped === undefined);
  const score = (task: string): [number, string] => {
    const rs = runsOf(task);
    const passOf = (e: RaceEngine) => rs.filter((r) => r.engine === e).some((r) => r.verdict?.pass === true);
    const engines = new Set(rs.map((r) => r.engine));
    if (engines.size === 2 && passOf('native') !== passOf('claude_code')) return [5, 'the engines disagree: one passed, the other did not'];
    if (rs.some((r) => r.verdict && r.verdict.criteria.length > 0 && r.verdict.criteria.every((c) => c.met) !== r.verdict.mustSay.pass)) {
      return [4, 'the judge and the fact check disagree'];
    }
    if (rs.some((r) => r.verdict && r.verdict.pass === null)) return [3, 'the judge could not read a run'];
    if (rs.some((r) => r.error !== undefined || r.turns.some((t) => t.totalMs === null))) return [2, 'a run errored or timed out'];
    if (rs.some((r) => r.verdict?.pass === false)) return [1, 'every engine failed it'];
    return [0, ''];
  };
  const scored = rows.map((row, i) => ({ row, i, s: score(row.task) }));
  const picked: typeof scored = [];
  for (const x of [...scored].filter((x) => x.s[0] > 0).sort((a, b) => b.s[0] - a.s[0] || a.i - b.i)) {
    if (picked.length < n) {
      picked.push(x);
      reasons.set(x.row.task, x.s[1]);
    }
  }
  for (const cat of RACE_CATEGORIES) {
    if (picked.length >= n || picked.some((p) => p.row.category === cat)) continue;
    const x = scored.find((s) => s.row.category === cat && !picked.includes(s));
    if (x) {
      picked.push(x);
      reasons.set(x.row.task, `a passing ${cat} task, to confirm the judge's yes`);
    }
  }
  for (const x of scored) {
    if (picked.length >= n) break;
    if (!picked.includes(x)) {
      picked.push(x);
      reasons.set(x.row.task, "to confirm the judge's yes");
    }
  }
  return picked.map(({ row }) => ({
    task: row.task,
    category: row.category,
    why: reasons.get(row.task) ?? '',
    runs: runsOf(row.task).map((r) => ({ engine: r.engine, run: r.run, taskId: r.taskId, pass: r.verdict?.pass ?? null })),
  }));
}

export function buildReport(file: RaceRunsFile, runs: readonly JudgedRun[], judgeModel: string | null): RaceReport {
  const live = runs.filter((r) => r.skipped === undefined);
  const engines = RACE_ENGINES.filter((e) => live.some((r) => r.engine === e));
  const taskOrder = RACE_TASKS.map((t) => t.id);
  const tasks = [...new Set(live.map((r) => r.task))].sort((a, b) => taskOrder.indexOf(a) - taskOrder.indexOf(b));
  const rows: TaskRow[] = tasks.map((task) => {
    const mine = live.filter((r) => r.task === task);
    const row: TaskRow = { task, category: mine[0]!.category as RaceCategory, engines: {} };
    for (const e of engines) {
      const er = mine.filter((r) => r.engine === e);
      if (er.length) row.engines[e] = cell(er, file.model);
    }
    return row;
  });
  const totals: RaceReport['totals'] = {};
  for (const e of engines) totals[e] = totalsFor(live.filter((r) => r.engine === e), runs, rows, e, file.model);
  return {
    schema: RACE_REPORT_SCHEMA,
    model: file.model,
    where: file.where,
    startedAt: file.startedAt,
    seed: file.seed,
    judgeModel,
    engines,
    rows,
    totals,
    headToHead: headToHead(rows),
    spotCheck: pickSpotChecks(rows, live),
    skipped: runs.filter((r) => r.skipped !== undefined).map((r) => ({ task: r.task, engine: r.engine, run: r.run, reason: r.skipped! })),
    runs: runs.map(withoutToolText),
  };
}

/**
 * A run as the report JSON carries it: tool names and errors, never a tool's input or result.
 * A result can hold whatever the box printed (a file listing, an environment key), so that text
 * stays in the runs file the driver wrote, beside the judge, and out of a page that is shared.
 */
function withoutToolText(r: JudgedRun): JudgedRun {
  return { ...r, turns: r.turns.map((t) => ({ ...t, tools: t.tools.map((x) => ({ ...x, input: '[omitted]', result: '[omitted]' })) })) };
}
