/**
 * compare — the nightly bench's regression alarm (harness-to-nine O5).
 *
 * Reads tonight's replay report (../run.ts) and live report (./live/run-live.ts), folds
 * them into the handful of numbers a regression is judged on, and compares those with
 * the checked-in baseline (./baseline.json). A regression past a threshold exits 1, so
 * the nightly job goes red and pages #alerts.
 *
 *   tsx bench/compare.ts --baseline bench/baseline.json --replay replay.json [--live live.json]
 *                        [--md out.md] [--write-baseline next.json]
 *
 * Thresholds (spec 2026-09-30 section 6, the B10 brief):
 *   prompt tokens per lane (replay)   more than +5%
 *   cache hit share (live)            more than 5 points down
 *   time to first tool (live median)  more than +20% AND at least +1500 ms (a 6-call median is noisy)
 *   dollars per task (live)           more than +15%
 *   tasks done (live)                 none done, or 2 or more fewer than the baseline (a dead lane)
 * Once a baseline exists, a half it measured that is missing tonight fails too: a replay
 * lane that vanished, the live half not run when it was expected, or another live model.
 * With no baseline yet, every number is reported and none can fail: `--write-baseline`
 * writes the file to commit (the nightly uploads it as `baseline.next.json`).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BenchReport } from './report.js';
import type { LiveReport } from './live/run-live.js';

export const BASELINE_SCHEMA = 'vestra.harness-bench-baseline/v1';

export const THRESHOLDS = {
  /** Percent growth in a replay lane's prompt tokens that fails the job. */
  promptTokensPct: 5,
  /** Points (out of 100) the live cache hit share may drop. */
  cacheHitPoints: 5,
  /** Percent growth in the live median time to first tool. */
  firstToolPct: 20,
  /** Percent growth in live dollars per task. */
  costPerTaskPct: 15,
  /** The time-to-first-tool alarm also needs this much absolute growth (ms). */
  firstToolMinMs: 1500,
  /** Tasks done this many below the baseline fails (and none done always does). */
  passedDrop: 2,
} as const;
export type Thresholds = { readonly [K in keyof typeof THRESHOLDS]: number };

export interface BenchMetrics {
  /** Per replay lane (`wire model`): est tokens sent across every recorded run. */
  replay: Record<string, number>;
  live: {
    model: string;
    /**
     * The flags the live half ran with (bench:live --flags). The nightly reads the baseline's
     * list and runs with exactly those, and a different set is not compared, so a flag never
     * moves the numbers unseen. Absent on a baseline written before the field: none.
     */
    flagsOn?: string[];
    cacheHitShare: number | null;
    firstToolMsMedian: number | null;
    costPerTaskUsd: number;
    passed: number;
    tasks: number;
  } | null;
}

export interface Baseline extends BenchMetrics {
  schema: typeof BASELINE_SCHEMA;
  /** When and from what the numbers were taken; null until the first write. */
  recordedAt: string | null;
  source: string | null;
}

/** Tonight's numbers. The replay half sums every run of the baseline pass (flags as run); live is null when it did not run. */
export function metricsOf(replay: BenchReport | null, live: LiveReport | null): BenchMetrics {
  const lanes: Record<string, number> = {};
  if (replay) {
    // A `--compare` report holds two passes; the first (the flags-off pass) is the baseline.
    const flags = replay.comparison?.flags ?? [];
    for (const r of replay.runs) {
      if (flags.some((f) => r.flagsOn.includes(f))) continue;
      const key = `${r.wire} ${r.model}`;
      lanes[key] = (lanes[key] ?? 0) + r.sent.contextTokens;
    }
  }
  return {
    replay: lanes,
    live: live
      ? {
          model: live.model,
          flagsOn: [...(live.flagsOn ?? [])].sort(),
          cacheHitShare: live.totals.cacheHitShare,
          firstToolMsMedian: live.totals.firstToolMsMedian,
          costPerTaskUsd: live.totals.costPerTaskUsd,
          passed: live.totals.passed,
          tasks: live.totals.tasks,
        }
      : null,
  };
}

export interface Finding {
  metric: string;
  baseline: number | null;
  current: number | null;
  /** Human change, e.g. "+6.2%" or "-7.0 pts". */
  change: string;
  limit: string;
  regressed: boolean;
  note?: string;
}

const flagsKey = (flags: readonly string[] | undefined): string => [...(flags ?? [])].sort().join(',');

/** Rounded to 1e-9 so a change exactly at a limit (0.2 * 100 = 20.000000000000004 in floats) reads as at it, not past it. */
const tidy = (x: number): number => Math.round(x * 1e9) / 1e9;
const pctChange = (base: number, cur: number): number => (base === 0 ? (cur === 0 ? 0 : Infinity) : tidy(((cur - base) / base) * 100));
const fmtPct = (x: number): string => (Number.isFinite(x) ? `${x > 0 ? '+' : ''}${x.toFixed(1)}%` : 'new');

function growth(
  metric: string,
  base: number | null | undefined,
  cur: number | null | undefined,
  limitPct: number,
  opts: { minAbs?: number; missingFails?: boolean } = {},
): Finding {
  const limit = `+${limitPct}%${opts.minAbs !== undefined ? ` and +${opts.minAbs}` : ''}`;
  if (cur === null || cur === undefined) {
    const fails = opts.missingFails === true && base !== null && base !== undefined;
    return { metric, baseline: base ?? null, current: null, change: 'n/a', limit, regressed: fails, note: fails ? 'missing tonight, but the baseline has it' : 'not measured tonight' };
  }
  if (base === null || base === undefined) return { metric, baseline: null, current: cur, change: 'n/a', limit, regressed: false, note: 'no baseline yet' };
  const d = pctChange(base, cur);
  const pastAbs = opts.minAbs === undefined || cur - base >= opts.minAbs;
  return { metric, baseline: base, current: cur, change: fmtPct(d), limit, regressed: d > limitPct && pastAbs };
}

/**
 * Judge tonight against the baseline. Pure. `expectLive` says whether the live half was
 * meant to run tonight (the nightly, or a dispatch that asked for it): only then is a
 * missing live half against a live baseline a failure.
 */
export function compareMetrics(
  baseline: BenchMetrics,
  current: BenchMetrics,
  t: Thresholds = THRESHOLDS,
  opts: { expectLive?: boolean } = {},
): { findings: Finding[]; regressed: boolean } {
  const findings: Finding[] = [];
  const lanes = [...new Set([...Object.keys(baseline.replay), ...Object.keys(current.replay)])].sort();
  for (const lane of lanes) findings.push(growth(`prompt tokens, ${lane}`, baseline.replay[lane], current.replay[lane], t.promptTokensPct, { missingFails: true }));

  const b = baseline.live;
  const c = current.live;
  const expectLive = opts.expectLive ?? true;
  if (!c) {
    const fails = b !== null && expectLive;
    findings.push({
      metric: 'live half',
      baseline: null,
      current: null,
      change: 'n/a',
      limit: '',
      regressed: fails,
      note: fails ? 'did not run tonight, but the baseline has a live half (unarmed, or the run died)' : 'did not run tonight (unarmed or skipped)',
    });
  } else if (b && b.model !== c.model) {
    findings.push({ metric: 'live half', baseline: null, current: null, change: 'n/a', limit: '', regressed: true, note: `baseline is ${b.model}, tonight ran ${c.model}: record a baseline for ${c.model} or run ${b.model}` });
  } else if (b && flagsKey(b.flagsOn) !== flagsKey(c.flagsOn)) {
    findings.push({
      metric: 'live half',
      baseline: null,
      current: null,
      change: 'n/a',
      limit: '',
      regressed: true,
      note: `baseline ran with flags [${flagsKey(b.flagsOn)}], tonight with [${flagsKey(c.flagsOn)}]: not comparable`,
    });
  } else {
    // Cache hit: an absolute drop in points, not a percentage of a percentage.
    if (c.cacheHitShare === null || !b || b.cacheHitShare === null) {
      findings.push({ metric: 'cache hit share', baseline: b?.cacheHitShare ?? null, current: c.cacheHitShare, change: 'n/a', limit: `-${t.cacheHitPoints} pts`, regressed: false, note: c.cacheHitShare === null ? 'not measured tonight' : 'no baseline yet' });
    } else {
      const pts = tidy((c.cacheHitShare - b.cacheHitShare) * 100);
      findings.push({ metric: 'cache hit share', baseline: b.cacheHitShare, current: c.cacheHitShare, change: `${pts > 0 ? '+' : ''}${pts.toFixed(1)} pts`, limit: `-${t.cacheHitPoints} pts`, regressed: pts < -t.cacheHitPoints });
    }
    findings.push(growth('time to first tool (median ms)', b?.firstToolMsMedian, c.firstToolMsMedian, t.firstToolPct, { minAbs: t.firstToolMinMs }));
    findings.push(growth('dollars per task', b?.costPerTaskUsd, c.costPerTaskUsd, t.costPerTaskPct));
    // A dead lane errors every task: $0 a task and nothing measured would read as a win.
    const noneDone = c.tasks > 0 && c.passed === 0;
    const dropped = b ? b.passed - c.passed : 0;
    const deadLane = noneDone || dropped >= t.passedDrop;
    findings.push({
      metric: 'tasks done',
      baseline: b?.passed ?? null,
      current: c.passed,
      change: b ? `${c.passed - b.passed >= 0 ? '+' : ''}${c.passed - b.passed}` : 'n/a',
      limit: `none done, or -${t.passedDrop}`,
      regressed: deadLane,
      ...(noneDone ? { note: 'no task was done: a dead lane' } : dropped > 0 ? { note: `${dropped} fewer done than the baseline` } : {}),
    });
  }
  return { findings, regressed: findings.some((f) => f.regressed) };
}

export function toBaseline(m: BenchMetrics, source: string, recordedAt: string): Baseline {
  return { schema: BASELINE_SCHEMA, recordedAt, source, ...m };
}

export function readBaseline(path: string): Baseline {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Baseline>;
  if (raw.schema !== BASELINE_SCHEMA) throw new Error(`bench compare: ${path} is not a ${BASELINE_SCHEMA} file`);
  return { schema: BASELINE_SCHEMA, recordedAt: raw.recordedAt ?? null, source: raw.source ?? null, replay: raw.replay ?? {}, live: raw.live ?? null };
}

const show = (x: number | null): string => (x === null ? 'n/a' : Number.isInteger(x) ? x.toLocaleString('en-US') : String(Math.round(x * 10000) / 10000));

export function renderComparison(result: { findings: Finding[]; regressed: boolean }, baseline: Baseline): string {
  const head = result.regressed
    ? '## Harness bench, nightly: REGRESSION'
    : '## Harness bench, nightly: within thresholds';
  const lines = [
    head,
    '',
    baseline.recordedAt ? `Baseline recorded ${baseline.recordedAt} (${baseline.source ?? 'unknown source'}).` : 'No baseline recorded yet: every number below is reported, none can fail. Commit `baseline.next.json` from this run as `packages/agent-sdk/bench/baseline.json` to arm the alarm.',
    '',
    '| metric | baseline | tonight | change | limit | |',
    '|---|---|---|---|---|---|',
    ...result.findings.map((f) => `| ${f.metric} | ${show(f.baseline)} | ${show(f.current)} | ${f.change} | ${f.limit} | ${f.regressed ? '**REGRESSED**' : f.note ?? 'ok'} |`),
    '',
  ];
  return lines.join('\n');
}

function arg(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const readJson = <T>(path: string | undefined): T | null => (path ? (JSON.parse(readFileSync(resolve(path), 'utf8')) as T) : null);

async function main(argv: readonly string[]): Promise<number> {
  const baselinePath = arg(argv, 'baseline');
  if (!baselinePath) throw new Error('bench compare: --baseline <path> is required');
  const baseline = readBaseline(resolve(baselinePath));
  const current = metricsOf(readJson<BenchReport>(arg(argv, 'replay')), readJson<LiveReport>(arg(argv, 'live')));
  const result = compareMetrics(baseline, current, THRESHOLDS, { expectLive: argv.includes('--expect-live') });
  const md = renderComparison(result, baseline);
  const mdPath = arg(argv, 'md');
  if (mdPath) writeFileSync(resolve(mdPath), md);
  else process.stdout.write(md);
  const next = arg(argv, 'write-baseline');
  if (next) {
    const source = process.env.GITHUB_SHA ? `nightly at ${process.env.GITHUB_SHA.slice(0, 10)}` : 'a local run';
    // A night the live half did not run keeps the last live baseline rather than erasing it.
    const merged: BenchMetrics = { replay: current.replay, live: current.live ?? baseline.live };
    writeFileSync(resolve(next), `${JSON.stringify(toBaseline(merged, source, new Date().toISOString()), null, 2)}\n`);
  }
  return result.regressed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(2);
    });
}
