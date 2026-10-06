/**
 * The rehearsal's beat timer and its sheet: each beat of the run sheet with its budget, how long it took and PASS or
 * FAIL, printed as the run sheet's table; and the checks that stop a rehearsal before it starts.
 */
import type { HealthJson } from '@go/brain/dist/admin/register.js';
import { beatOf, DEMO_BEATS, type Beat, type BeatId } from '../scenarios/demo.js';

export type BeatResult = 'PASS' | 'FAIL' | 'NOT REACHED';

export interface BeatRun extends Beat {
  /** From the cue to what had to happen; null when it never happened or is not timed. */
  ms: number | null;
  result: BeatResult;
  note: string;
}

export const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

export class BeatTimer {
  private readonly runs = new Map<BeatId, BeatRun>();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  /**
   * The beat happened now (or at `endedAt`, when the runner checked more before writing it down), `startedAt` after
   * its cue. It passes inside its budget, unless `ok` says otherwise.
   */
  done(id: BeatId, startedAt: number, o: { ok?: boolean; note?: string; endedAt?: number } = {}): BeatRun {
    const beat = beatOf(id);
    const ms = Math.max(0, (o.endedAt ?? this.clock()) - startedAt);
    const budget = beat.budgetMs;
    const inBudget = budget === null || ms <= budget;
    const note = o.note ?? (budget === null || inBudget ? '' : `over by ${secs(ms - budget)}`);
    return this.keep({ ...beat, ms, result: (o.ok ?? true) && inBudget ? 'PASS' : 'FAIL', note });
  }

  /** A beat that is checked, not timed (quiet through the chatter). */
  check(id: BeatId, ok: boolean, note: string): BeatRun {
    return this.keep({ ...beatOf(id), ms: null, result: ok ? 'PASS' : 'FAIL', note });
  }

  /** The beat never happened. */
  miss(id: BeatId, note: string): BeatRun {
    return this.keep({ ...beatOf(id), ms: null, result: 'FAIL', note });
  }

  /** Every beat in the run sheet's order; a beat with no result was not reached. */
  results(): BeatRun[] {
    return DEMO_BEATS.map((b) => this.runs.get(b.id) ?? { ...b, ms: null, result: 'NOT REACHED', note: '' });
  }

  private keep(run: BeatRun): BeatRun {
    const first = this.runs.get(run.id);
    if (first) return first;
    this.runs.set(run.id, run);
    return run;
  }
}

export function passed(runs: BeatRun[]): boolean {
  return runs.every((r) => r.result === 'PASS');
}

/** The timed beat closest to (or furthest over) its budget. */
function slowest(runs: BeatRun[]): string {
  let worst: { run: BeatRun; ms: number; budget: number } | null = null;
  for (const run of runs) {
    if (run.ms === null || run.budgetMs === null) continue;
    if (worst === null || run.ms / run.budgetMs > worst.ms / worst.budget) worst = { run, ms: run.ms, budget: run.budgetMs };
  }
  return worst ? `${worst.run.name}, ${secs(worst.ms)} of ${secs(worst.budget)}` : 'none timed';
}

const cell = (s: string): string => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

export function formatSheet(runs: BeatRun[], o: { go: string; tripId: string | null; at: Date }): string {
  const local = new Date(o.at.getTime() + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ');
  const rows = runs.map(
    (r) => `| ${r.time} | ${cell(r.name)} | ${r.budgetMs === null ? 'none' : secs(r.budgetMs)} | ${r.ms === null ? 'none' : secs(r.ms)} | ${r.result} | ${cell(r.note)} |`,
  );
  const ok = runs.filter((r) => r.result === 'PASS').length;
  return [
    `# Rehearsal, ${local} (Asia/Kolkata)`,
    '',
    `Go: ${o.go}. Trip: ${o.tripId ?? 'none'}.`,
    '',
    '| Time | Beat | Budget | Took | Result | Note |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    `Passed ${ok} of ${runs.length}. Slowest against its budget: ${slowest(runs)}.`,
  ].join('\n');
}

/** One row for the run sheet's "Rehearsal log" table: | Run | Date | Beats passed | Slowest beat | Fixes or cuts |. */
export function logLine(runs: BeatRun[], o: { run: string; date: string; fixes?: string }): string {
  const ok = runs.filter((r) => r.result === 'PASS').length;
  return `| ${o.run} | ${o.date} | ${ok} of ${runs.length} | ${slowest(runs)} | ${cell(o.fixes ?? '')} |`;
}

/**
 * Reasons not to start a full rehearsal at all; empty when it may run. A Server already connected means this is the
 * stage Go (or something real uses it): rehearsals never share the stage Go (master §9), they run on brain-rehearsal.
 */
export function preflight(h: HealthJson): string[] {
  const reasons: string[] = [];
  // The Go itself says which deployment it is; only brain-rehearsal says rehearsal.
  if (h.role !== 'rehearsal') {
    reasons.push(h.role === 'stage'
      ? 'This Go says it is the stage Go (GO_ROLE=stage). Rehearsals never share the stage Go: run against brain-rehearsal (--go its URL, or GO_REHEARSAL_URL).'
      : 'This Go does not say it is the rehearsal Go. Set GO_ROLE=rehearsal on brain-rehearsal (and GO_ROLE=stage on brain), then run again.');
  }
  if (h.server_socket_open) {
    reasons.push('A Server is connected to this Go, so it is the stage Go (or something real uses it). Rehearsals never share the stage Go: run against brain-rehearsal (--go its URL, or GO_REHEARSAL_URL).');
  }
  if (h.calls.mode === 'allowlist' && h.calls.allowlist_count === 0) {
    reasons.push('CALLS_MODE is allowlist but CALLS_ALLOWLIST is empty. Add the teammate who plays the dive shop first: a rehearsal call must only ever reach the team.');
  }
  return reasons;
}
