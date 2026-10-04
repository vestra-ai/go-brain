/**
 * The nightly bench's alarm: which numbers it judges, the four thresholds at their edges,
 * and the cases that must never page anyone (no baseline yet, the live half unarmed, a
 * different model).
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_SCHEMA,
  THRESHOLDS,
  compareMetrics,
  metricsOf,
  readBaseline,
  renderComparison,
  toBaseline,
  type BenchMetrics,
} from '../compare.js';
import type { BenchReport, RunReport } from '../report.js';
import type { LiveReport } from '../live/run-live.js';

const run = (wire: string, model: string, contextTokens: number, flagsOn: string[] = []): RunReport =>
  ({ wire, model, flagsOn, sent: { contextTokens, wireBytes: 0, wireBytesPerRound: 0, contextTokensPerRound: 0 } }) as unknown as RunReport;

const live = (over: Partial<LiveReport['totals']> = {}, model = 'deepseek-v4.1-flash'): LiveReport =>
  ({
    model,
    totals: { tasks: 6, passed: 6, costUsd: 0.06, costPerTaskUsd: 0.01, promptTokens: 1, promptTokensPerTask: 1, cacheHitShare: 0.8, firstTokenMsMedian: 500, firstToolMsMedian: 2000, totalMsMedian: 6000, ...over },
  }) as unknown as LiveReport;

const BASE: BenchMetrics = {
  replay: { 'anthropic_messages claude-sonnet-5-5': 10_000, 'gemini gemini-3.8-flash': 8_000 },
  live: { model: 'deepseek-v4.1-flash', cacheHitShare: 0.8, firstToolMsMedian: 2000, costPerTaskUsd: 0.01, passed: 6, tasks: 6 },
};
const regressedMetrics = (current: BenchMetrics) => compareMetrics(BASE, current).findings.filter((f) => f.regressed).map((f) => f.metric);

describe('bench compare: tonight folded into the judged numbers', () => {
  it('replay: tokens summed per lane across runs; a --compare report counts only its flags-off pass', () => {
    const report = {
      runs: [run('gemini', 'g', 100), run('gemini', 'g', 50), run('gemini', 'g', 999, ['TOOL_SEARCH_V1']), run('anthropic_messages', 'c', 70)],
      comparison: { flags: ['TOOL_SEARCH_V1'] },
    } as unknown as BenchReport;
    expect(metricsOf(report, null)).toEqual({ replay: { 'gemini g': 150, 'anthropic_messages c': 70 }, live: null });
  });

  it('live: the totals the alarm reads, and the flags the run had on (sorted)', () => {
    expect(metricsOf(null, live()).live).toEqual({ ...BASE.live, flagsOn: [] });
    const withFlags = { ...live(), flagsOn: ['Z_V1', 'TOOLS_MIDSTREAM_V1'] } as LiveReport;
    expect(metricsOf(null, withFlags).live?.flagsOn).toEqual(['TOOLS_MIDSTREAM_V1', 'Z_V1']);
  });
});

describe('bench compare: the live flags must match the baseline\'s', () => {
  const flagged = (flagsOn: string[] | undefined): BenchMetrics => ({ replay: BASE.replay, live: { ...BASE.live!, ...(flagsOn ? { flagsOn } : {}) } });

  it('a different flag set is not compared: it fails, naming both sets', () => {
    const r = compareMetrics(flagged(['TOOLS_MIDSTREAM_V1']), flagged([]));
    expect(r.regressed).toBe(true);
    expect(r.findings.find((f) => f.metric === 'live half')?.note).toBe('baseline ran with flags [TOOLS_MIDSTREAM_V1], tonight with []: not comparable');
  });

  it('the same set in another order passes; a baseline written before the field reads as no flags', () => {
    expect(compareMetrics(flagged(['A_V1', 'B_V1']), flagged(['B_V1', 'A_V1'])).regressed).toBe(false);
    expect(compareMetrics(flagged(undefined), flagged([])).regressed).toBe(false);
  });

  it('the nightly runs the live half with the baseline\'s flags', () => {
    const wf = readFileSync(fileURLToPath(new URL('../../../../.github/workflows/bench-nightly.yml', import.meta.url)), 'utf8');
    expect(wf).toContain(`jq -r '(.live.flagsOn // []) | join(",")' packages/agent-sdk/bench/baseline.json`);
    expect(wf).toContain('${flags:+--flags "$flags"}');
  });

  it('a missing FIREWORKS_BENCH_KEY leaves the live half unarmed (warned), never a nightly page', () => {
    const wf = readFileSync(fileURLToPath(new URL('../../../../.github/workflows/bench-nightly.yml', import.meta.url)), 'utf8');
    expect(wf).toContain(`$([ "$LIVE_RAN" = true ] && echo --expect-live)`);
    expect(wf).not.toContain(`$([ "$LIVE_WANTED" = true ] && echo --expect-live)`);
    expect(wf).toContain('Harness bench live half unarmed');
  });
});

describe('bench compare: the four thresholds, at their edges', () => {
  const at = (live: Partial<NonNullable<BenchMetrics['live']>>, replay: Partial<BenchMetrics['replay']> = {}): BenchMetrics => ({
    replay: { ...BASE.replay, ...replay } as Record<string, number>,
    live: { ...BASE.live!, ...live },
  });

  it('the same numbers pass', () => {
    expect(compareMetrics(BASE, BASE).regressed).toBe(false);
  });

  it('prompt tokens: +5% passes, more fails, per lane', () => {
    expect(regressedMetrics(at({}, { 'gemini gemini-3.8-flash': 8_400 }))).toEqual([]);
    expect(regressedMetrics(at({}, { 'gemini gemini-3.8-flash': 8_401 }))).toEqual(['prompt tokens, gemini gemini-3.8-flash']);
  });

  it('cache hit: 5 points down passes, more fails; a rise never fails', () => {
    expect(regressedMetrics(at({ cacheHitShare: 0.75 }))).toEqual([]);
    expect(regressedMetrics(at({ cacheHitShare: 0.749 }))).toEqual(['cache hit share']);
    expect(regressedMetrics(at({ cacheHitShare: 0.99 }))).toEqual([]);
  });

  it('time to first tool: needs more than +20% AND at least +1500 ms (a 6-call median is noisy)', () => {
    // +20.05% but only +401 ms: noise, not a regression.
    expect(regressedMetrics(at({ firstToolMsMedian: 2401 }))).toEqual([]);
    // +74.95% but +1499 ms: still under the absolute floor.
    expect(regressedMetrics(at({ firstToolMsMedian: 3499 }))).toEqual([]);
    expect(regressedMetrics(at({ firstToolMsMedian: 3500 }))).toEqual(['time to first tool (median ms)']);
    // A big absolute jump on a slow baseline still needs the percentage.
    const slow: BenchMetrics = { ...BASE, live: { ...BASE.live!, firstToolMsMedian: 10_000 } };
    expect(compareMetrics(slow, { ...slow, live: { ...slow.live!, firstToolMsMedian: 11_600 } }).regressed).toBe(false);
    expect(compareMetrics(slow, { ...slow, live: { ...slow.live!, firstToolMsMedian: 12_001 } }).regressed).toBe(true);
  });

  it('dollars per task: +15% passes, more fails', () => {
    expect(regressedMetrics(at({ costPerTaskUsd: 0.0115 }))).toEqual([]);
    expect(regressedMetrics(at({ costPerTaskUsd: 0.0116 }))).toEqual(['dollars per task']);
  });

  it('the thresholds are the brief\'s, plus the review\'s noise floor and dead-lane drop', () => {
    expect(THRESHOLDS).toEqual({ promptTokensPct: 5, cacheHitPoints: 5, firstToolPct: 20, costPerTaskPct: 15, firstToolMinMs: 1500, passedDrop: 2 });
  });

  it('a dead lane fails: no task done (even with no baseline), or 2 or more fewer than the baseline', () => {
    expect(regressedMetrics(at({ passed: 0, costPerTaskUsd: 0 }))).toContain('tasks done');
    expect(compareMetrics({ replay: {}, live: null }, { replay: {}, live: { ...BASE.live!, passed: 0 } }).regressed).toBe(true);
    expect(regressedMetrics(at({ passed: 4 }))).toEqual(['tasks done']);
    expect(regressedMetrics(at({ passed: 5 }))).toEqual([]);
  });
});

describe('bench compare: what never pages anyone', () => {
  it('no baseline yet: everything reported, nothing fails', () => {
    const r = compareMetrics({ replay: {}, live: null }, { replay: { 'gemini g': 5 }, live: BASE.live });
    expect(r.regressed).toBe(false);
    expect(r.findings.find((f) => f.metric === 'prompt tokens, gemini g')?.note).toBe('no baseline yet');
    expect(r.findings.find((f) => f.metric === 'cache hit share')?.note).toBe('no baseline yet');
  });

  it('the live half was not asked for tonight (a dispatch with live off): a note, never a failure', () => {
    const r = compareMetrics(BASE, { replay: BASE.replay, live: null }, THRESHOLDS, { expectLive: false });
    expect(r.regressed).toBe(false);
    expect(r.findings.find((f) => f.metric === 'live half')?.note).toMatch(/did not run/);
  });

  it('one fewer task done is shown, not failed', () => {
    const r = compareMetrics(BASE, { replay: BASE.replay, live: { ...BASE.live!, passed: 5 } });
    expect(r.regressed).toBe(false);
    expect(r.findings.find((f) => f.metric === 'tasks done')?.note).toBe('1 fewer done than the baseline');
  });
});

describe('bench compare: once a baseline exists, a missing half fails', () => {
  it('the live half wanted but not run, against a live baseline', () => {
    const r = compareMetrics(BASE, { replay: BASE.replay, live: null });
    expect(r.regressed).toBe(true);
    expect(r.findings.find((f) => f.metric === 'live half')?.note).toMatch(/baseline has a live half/);
  });

  it('another live model than the baseline\'s', () => {
    const r = compareMetrics(BASE, { replay: BASE.replay, live: { ...BASE.live!, model: 'gemini-3.8-flash' } });
    expect(r.regressed).toBe(true);
  });

  it('a replay lane the baseline has that is missing tonight', () => {
    const r = compareMetrics(BASE, { replay: { 'gemini gemini-3.8-flash': 8_000 }, live: BASE.live });
    expect(r.regressed).toBe(true);
    expect(r.findings.find((f) => f.metric === 'prompt tokens, anthropic_messages claude-sonnet-5-5')?.note).toBe('missing tonight, but the baseline has it');
  });

  it('with no live baseline, a missing live half is still only a note', () => {
    const r = compareMetrics({ replay: BASE.replay, live: null }, { replay: BASE.replay, live: null });
    expect(r.regressed).toBe(false);
  });
});

describe('bench compare: the baseline file', () => {
  it('the checked-in baseline is armed: five replay lanes, the live half on DeepSeek V4.1 Flash with TOOLS_MIDSTREAM_V1, 6 of 6 done', () => {
    const b = readBaseline(fileURLToPath(new URL('../baseline.json', import.meta.url)));
    expect(b.schema).toBe(BASELINE_SCHEMA);
    expect(b.recordedAt).not.toBeNull();
    expect(Object.keys(b.replay).sort()).toEqual([
      'anthropic_messages claude-sonnet-5-5',
      'gemini gemini-3.8-flash',
      'gemini_interactions gemini-3.8-flash',
      'openai_chat_completions deepseek-v4-flash',
      'openai_responses gpt-5.6-luna',
    ]);
    expect(b.live).toMatchObject({ model: 'deepseek-v4.1-flash', flagsOn: ['TOOLS_MIDSTREAM_V1'], passed: 6, tasks: 6 });
    // Judged against itself it is within every threshold.
    expect(renderComparison(compareMetrics(b, b), b)).toMatch(/within thresholds/);
  });

  it('round trip: written, read back, judged equal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-baseline-'));
    const path = join(dir, 'b.json');
    writeFileSync(path, JSON.stringify(toBaseline(BASE, 'test', '2026-10-02T00:00:00.000Z')));
    const b = readBaseline(path);
    expect(compareMetrics(b, BASE).regressed).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8')).recordedAt).toBe('2026-10-02T00:00:00.000Z');
  });

  it('a file of another schema is refused, not silently read as empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-baseline-'));
    const path = join(dir, 'b.json');
    writeFileSync(path, JSON.stringify({ schema: 'something/else' }));
    expect(() => readBaseline(path)).toThrow(/not a vestra.harness-bench-baseline/);
  });

  it('the report says REGRESSION and names the metric', () => {
    const r = compareMetrics(BASE, { ...BASE, live: { ...BASE.live!, costPerTaskUsd: 0.02 } });
    const md = renderComparison(r, toBaseline(BASE, 'test', '2026-10-02'));
    expect(md).toMatch(/REGRESSION/);
    expect(md).toMatch(/\| dollars per task \| 0\.01 \| 0\.02 \| \+100\.0% \| \+15% \| \*\*REGRESSED\*\* \|/);
  });
});
