/**
 * report — the harness bench's JSON report and its markdown tables.
 *
 * Every size is measured on the request body the real transport built. "est tokens"
 * is the engine's own estimateTokens (max of chars/4 and words x 1.3) over the JSON of
 * what occupies the model's context: a tool Anthropic holds back behind defer_loading
 * is on the wire (bytes) but not in context (tokens). The shape is pinned by
 * __tests__/bench.test.ts; change it there first.
 */
import type { ToolSearchRail } from '../src/engine/tool-search.js';
import type { WireFormat } from './fixtures.js';

export const REPORT_SCHEMA = 'vestra.harness-bench/v1';

export interface PrefixSize {
  wireBytes: number;
  contextTokens: number;
  tools: number;
  toolsInContext: number;
}

export interface RunReport {
  fixture: string;
  recordedWire: string;
  wire: WireFormat;
  model: string;
  family: string;
  flagsOn: string[];
  rail: ToolSearchRail;
  rounds: number;
  requests: number;
  toolCalls: number;
  toolCallsPerRound: number;
  /** System plus tools on the first request. */
  standingPrefix: PrefixSize;
  perRequest: Array<{ wireBytes: number; contextTokens: number; stableShare: number | null }>;
  sent: { wireBytes: number; contextTokens: number; wireBytesPerRound: number; contextTokensPerRound: number };
  /** Share of request N+1 (bytes, cache render order) identical to request N; null with one request. */
  prefixStability: { mean: number | null; min: number | null };
  /** Wall time of the replayed run minus the bench's own serialization; the model costs nothing here. */
  harnessMs: number;
  reconstructionMismatches: number;
}

export interface LaneSummary {
  rail: ToolSearchRail;
  standingPrefix: PrefixSize;
  sentWireBytes: number;
  sentContextTokens: number;
  prefixStabilityMean: number | null;
}

export interface LaneComparison {
  family: string;
  wire: WireFormat;
  model: string;
  off: LaneSummary;
  on: LaneSummary;
}

export interface BenchReport {
  schema: typeof REPORT_SCHEMA;
  catalog: { tools: number; deferrable: number; stubbed: string[]; source: Record<string, unknown> };
  runs: RunReport[];
  comparison: {
    flags: string[];
    /** Flags on in BOTH passes: the comparison measures `flags` on top of these. */
    base: string[];
    recordings: number;
    /** Recorded calls to a deferred tool: zero means the flags-on replay never searched or loaded one. */
    deferredToolCalls: number;
    lanes: LaneComparison[];
  } | null;
}

const sum = (xs: number[]): number => xs.reduce((s, n) => s + n, 0);
const meanOf = (xs: number[]): number | null => (xs.length ? sum(xs) / xs.length : null);

/** One lane's runs folded into the numbers the before and after table compares. */
export function summarizeLane(runs: RunReport[]): LaneSummary {
  const first = runs[0];
  if (!first) throw new Error('summarizeLane: no runs');
  return {
    rail: first.rail,
    standingPrefix: first.standingPrefix,
    sentWireBytes: sum(runs.map((r) => r.sent.wireBytes)),
    sentContextTokens: sum(runs.map((r) => r.sent.contextTokens)),
    prefixStabilityMean: meanOf(runs.flatMap((r) => (r.prefixStability.mean === null ? [] : [r.prefixStability.mean]))),
  };
}

const n = (x: number): string => Math.round(x).toLocaleString('en-US');
const kb = (x: number): string => (x / 1024).toFixed(1);
const pct = (x: number | null): string => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const delta = (off: number, on: number): string => {
  const d = off === 0 ? 0 : ((on - off) / off) * 100;
  return `${d > 0 ? '+' : ''}${d.toFixed(1)}%`;
};

function table(headers: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

export function renderBaseline(runs: RunReport[]): string {
  return table(
    [
      'run', 'wire', 'rounds', 'requests', 'tool calls / round', 'KB sent / round', 'est tokens / round',
      'standing prefix, est tokens', 'prefix stability mean (min)', 'harness ms',
    ],
    runs.map((r) => [
      r.fixture, r.wire, String(r.rounds), String(r.requests), r.toolCallsPerRound.toFixed(2),
      kb(r.sent.wireBytesPerRound), n(r.sent.contextTokensPerRound), n(r.standingPrefix.contextTokens),
      r.prefixStability.mean === null ? 'n/a' : `${pct(r.prefixStability.mean)} (${pct(r.prefixStability.min)})`,
      r.harnessMs.toFixed(1),
    ]),
  );
}

export function renderComparison(c: NonNullable<BenchReport['comparison']>): string {
  return table(
    [
      'family', 'wire', 'model', 'rail off → on', 'standing prefix est tokens, off → on', 'change',
      'prefix on the wire KB, off → on', 'est tokens sent, all runs, off → on', 'change', 'prefix stability, off → on',
    ],
    c.lanes.map((l) => [
      l.family, l.wire, l.model, `${l.off.rail} → ${l.on.rail}`,
      `${n(l.off.standingPrefix.contextTokens)} → ${n(l.on.standingPrefix.contextTokens)}`,
      delta(l.off.standingPrefix.contextTokens, l.on.standingPrefix.contextTokens),
      `${kb(l.off.standingPrefix.wireBytes)} → ${kb(l.on.standingPrefix.wireBytes)}`,
      `${n(l.off.sentContextTokens)} → ${n(l.on.sentContextTokens)}`,
      delta(l.off.sentContextTokens, l.on.sentContextTokens),
      `${pct(l.off.prefixStabilityMean)} → ${pct(l.on.prefixStabilityMean)}`,
    ]),
  );
}

/** What the before and after table can and cannot claim, stated beside it. */
export function comparisonCaveat(c: NonNullable<BenchReport['comparison']>): string {
  const calls =
    c.deferredToolCalls === 0
      ? `None of the ${c.recordings} replayed recordings calls a deferred tool, so the flags-on replay never pays a ToolSearch round or re-loads a schema.`
      : `${c.deferredToolCalls} recorded call(s) reach a deferred tool, but the recordings carry no ToolSearch round, so the flags-on replay never pays one.`;
  return (
    `${calls} The change column is therefore an upper bound on prefix savings, reached by sessions that never ` +
    'need a deferred tool. Tokens are estimates (estimateTokens), and a long session shows a smaller percentage, ' +
    'because its history outgrows the fixed prefix.'
  );
}

export function renderMarkdown(r: BenchReport): string {
  const compared = r.comparison?.flags ?? [];
  const base = r.comparison?.base ?? [];
  const baseline = r.runs.filter((x) => !x.flagsOn.some((f) => compared.includes(f)));
  const out = [
    '## Harness bench, replay half',
    '',
    `Catalog: ${r.catalog.tools} tools (${r.catalog.deferrable} deferrable)` +
      (r.catalog.stubbed.length ? `, replay stubs for ${r.catalog.stubbed.join(', ')}` : '') + '. ' +
      'Sizes are measured on the request body each real transport built; est tokens is the engine\'s ' +
      'estimateTokens heuristic, not a provider tokenizer.',
    '',
    base.length ? `### Baseline (${base.join(' + ')} on)` : '### Baseline (TOOL_SEARCH_V1 and TOOL_DEFER_V1 off)',
    '',
    renderBaseline(baseline),
  ];
  if (r.comparison) {
    const over = base.length ? ` (with ${base.join(' + ')} on in both)` : '';
    out.push('', `### ${r.comparison.flags.join(' + ')}: off versus on${over}`, '', comparisonCaveat(r.comparison), '', renderComparison(r.comparison));
  }
  return `${out.join('\n')}\n`;
}
