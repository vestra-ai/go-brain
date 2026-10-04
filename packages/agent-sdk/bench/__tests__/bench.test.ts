/**
 * The harness bench's contract: the report shape (what the tables and any dashboard
 * read), that every recorded round really replays through every wire, and that the
 * deferral comparison the prod flip rests on measures a real difference.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { renderMarkdown, type BenchReport } from '../report.js';
import { benchTools, LANES, loadCatalog } from '../fixtures.js';
import { runBench } from '../run.js';
import { anatomy, cacheKeyOf, stableShare } from '../wire.js';

/** Every leaf path of a value with the types seen there (arrays as `[]`, unioned over elements). */
function shapeOf(value: unknown, path = '', out = new Map<string, Set<string>>()): Map<string, Set<string>> {
  const add = (t: string) => (out.get(path) ?? out.set(path, new Set()).get(path)!).add(t);
  if (value === null) add('null');
  else if (Array.isArray(value)) {
    add('array');
    for (const v of value) shapeOf(v, `${path}[]`, out);
  } else if (typeof value === 'object' && !path.endsWith('catalog.source')) {
    for (const [k, v] of Object.entries(value)) shapeOf(v, path ? `${path}.${k}` : k, out);
  } else add(typeof value);
  return out;
}
const render = (m: Map<string, Set<string>>): string[] =>
  [...m].map(([p, t]) => `${p}: ${[...t].sort().join('|')}`).sort();

describe('harness bench (replay half)', () => {
  let report: BenchReport;
  beforeAll(async () => {
    report = await runBench({ fixtures: ['01', '03'], compare: ['TOOL_SEARCH_V1', 'TOOL_DEFER_V1'] });
  }, 180_000);

  it('harness bench: the report shape is pinned', () => {
    expect(report.schema).toBe('vestra.harness-bench/v1');
    expect(render(shapeOf(report))).toEqual([
      'catalog.deferrable: number',
      'catalog.source: object',
      'catalog.stubbed: array',
      'catalog.stubbed[]: string',
      'catalog.tools: number',
      'comparison.base: array',
      'comparison.deferredToolCalls: number',
      'comparison.flags: array',
      'comparison.flags[]: string',
      'comparison.lanes: array',
      'comparison.lanes[].family: string',
      'comparison.lanes[].model: string',
      ...['off', 'on'].flatMap((s) => [
        `comparison.lanes[].${s}.prefixStabilityMean: number`,
        `comparison.lanes[].${s}.rail: string`,
        `comparison.lanes[].${s}.sentContextTokens: number`,
        `comparison.lanes[].${s}.sentWireBytes: number`,
        `comparison.lanes[].${s}.standingPrefix.contextTokens: number`,
        `comparison.lanes[].${s}.standingPrefix.tools: number`,
        `comparison.lanes[].${s}.standingPrefix.toolsInContext: number`,
        `comparison.lanes[].${s}.standingPrefix.wireBytes: number`,
      ]),
      'comparison.lanes[].wire: string',
      'comparison.recordings: number',
      'runs: array',
      'runs[].family: string',
      'runs[].fixture: string',
      'runs[].flagsOn: array',
      'runs[].flagsOn[]: string',
      'runs[].harnessMs: number',
      'runs[].model: string',
      'runs[].perRequest: array',
      'runs[].perRequest[].contextTokens: number',
      'runs[].perRequest[].stableShare: null|number',
      'runs[].perRequest[].wireBytes: number',
      'runs[].prefixStability.mean: null|number',
      'runs[].prefixStability.min: null|number',
      'runs[].rail: string',
      'runs[].reconstructionMismatches: number',
      'runs[].recordedWire: string',
      'runs[].requests: number',
      'runs[].rounds: number',
      'runs[].sent.contextTokens: number',
      'runs[].sent.contextTokensPerRound: number',
      'runs[].sent.wireBytes: number',
      'runs[].sent.wireBytesPerRound: number',
      'runs[].standingPrefix.contextTokens: number',
      'runs[].standingPrefix.tools: number',
      'runs[].standingPrefix.toolsInContext: number',
      'runs[].standingPrefix.wireBytes: number',
      'runs[].toolCalls: number',
      'runs[].toolCallsPerRound: number',
      'runs[].wire: string',
      'schema: string',
    ].sort());
  });

  it('harness bench: every recorded round replays through all five wire formats, flags off and on', () => {
    expect(report.runs).toHaveLength(2 * 2 * LANES.length);
    expect(new Set(report.runs.map((r) => r.wire))).toEqual(new Set(LANES.map((l) => l.wire)));
    for (const r of report.runs) {
      const recorded = r.fixture.startsWith('03') ? { rounds: 10, faults: 1, toolCalls: 9 } : { rounds: 1, faults: 0, toolCalls: 0 };
      expect(r.rounds, `${r.fixture} on ${r.wire}`).toBe(recorded.rounds);
      expect(r.requests).toBe(recorded.rounds + recorded.faults);
      expect(r.perRequest).toHaveLength(r.requests);
      expect(r.toolCalls).toBe(recorded.toolCalls);
      expect(r.reconstructionMismatches, `${r.fixture} on ${r.wire} ${r.flagsOn.join('+')}`).toBe(0);
      expect(r.standingPrefix.contextTokens).toBeLessThan(r.perRequest[0].contextTokens + 1);
    }
  });

  it('harness bench: tool search and deferral shrink the standing prefix on every model family', () => {
    for (const l of report.comparison!.lanes) {
      expect(l.off.rail, l.wire).toBe('none');
      expect(l.on.rail, l.wire).toBe(l.wire === 'anthropic_messages' ? 'native' : 'client');
      expect(l.on.standingPrefix.contextTokens, l.wire).toBeLessThan(l.off.standingPrefix.contextTokens);
      expect(l.on.sentContextTokens, l.wire).toBeLessThan(l.off.sentContextTokens);
      // The client rail withholds schemas from the wire; the native rail keeps them on
      // the wire (defer_loading) and out of context.
      if (l.on.rail === 'client') expect(l.on.standingPrefix.wireBytes).toBeLessThan(l.off.standingPrefix.wireBytes);
      else expect(l.on.standingPrefix.toolsInContext).toBeLessThan(l.on.standingPrefix.tools);
    }
  });

  it('harness bench: the markdown carries the baseline and the before and after table', () => {
    const md = renderMarkdown(report);
    expect(md).toContain('### Baseline (TOOL_SEARCH_V1 and TOOL_DEFER_V1 off)');
    expect(md).toContain('### TOOL_SEARCH_V1 + TOOL_DEFER_V1: off versus on');
    // The upper-bound caveat rides beside the table: none of these recordings loads a deferred tool.
    expect(report.comparison!.deferredToolCalls).toBe(0);
    expect(md).toContain('None of the 2 replayed recordings calls a deferred tool');
    expect(md).toContain('an upper bound on prefix savings');
    for (const l of LANES) expect(md).toContain(`| ${l.family} | ${l.wire} | ${l.model} |`);
    expect(md).not.toMatch(/[–—]/);
  });
});

/**
 * TOOL_DEFER_WIDE_V1 measured the way the prod decision reads it: on top of the two rails
 * (today's prod), every recording, every wire format.
 */
describe('harness bench: TOOL_DEFER_WIDE_V1 over TOOL_SEARCH_V1 + TOOL_DEFER_V1', () => {
  let report: BenchReport;
  beforeAll(async () => {
    report = await runBench({ base: ['TOOL_SEARCH_V1', 'TOOL_DEFER_V1'], compare: ['TOOL_DEFER_WIDE_V1'] });
  }, 180_000);

  it('wide: every recording replays through all five wire formats, flag off and on, round for round', () => {
    const key = (r: BenchReport['runs'][number]) => `${r.fixture} on ${r.wire}`;
    const off = report.runs.filter((r) => !r.flagsOn.includes('TOOL_DEFER_WIDE_V1'));
    const on = new Map(report.runs.filter((r) => r.flagsOn.includes('TOOL_DEFER_WIDE_V1')).map((r) => [key(r), r]));
    expect(off.length).toBeGreaterThanOrEqual(9 * LANES.length);
    expect(on.size).toBe(off.length);
    for (const r of off) {
      const w = on.get(key(r))!;
      expect(r.reconstructionMismatches, key(r)).toBe(0);
      expect(w.reconstructionMismatches, `${key(r)} wide`).toBe(0);
      expect([w.rounds, w.requests, w.toolCalls], key(r)).toEqual([r.rounds, r.requests, r.toolCalls]);
    }
  });

  it('wide: the standing prefix shrinks on every model family, and Claude reads fewer tools in context', () => {
    expect(report.comparison!.base).toEqual(['TOOL_SEARCH_V1', 'TOOL_DEFER_V1']);
    for (const l of report.comparison!.lanes) {
      expect(l.on.rail, l.wire).toBe(l.off.rail);
      expect(l.on.standingPrefix.contextTokens, l.wire).toBeLessThan(l.off.standingPrefix.contextTokens);
      expect(l.on.sentContextTokens, l.wire).toBeLessThan(l.off.sentContextTokens);
      if (l.on.rail === 'native') expect(l.on.standingPrefix.toolsInContext).toBeLessThan(l.off.standingPrefix.toolsInContext);
      else expect(l.on.standingPrefix.tools).toBeLessThan(l.off.standingPrefix.tools);
    }
    expect(renderMarkdown(report)).toContain(
      '### TOOL_DEFER_WIDE_V1: off versus on (with TOOL_SEARCH_V1 + TOOL_DEFER_V1 on in both)',
    );
  });
});

/**
 * L2 conformance: TOOL_CONCURRENCY_CLASSES_V1 changes WHEN a call runs, never what the model
 * is sent. Every recording, every wire format, flag off then on: the same rounds, the same
 * requests, byte for byte, and the reconstruction check clean in both passes.
 */
describe('harness bench: TOOL_CONCURRENCY_CLASSES_V1 off and on', () => {
  const FLAG = 'TOOL_CONCURRENCY_CLASSES_V1';
  let report: BenchReport;
  beforeAll(async () => {
    report = await runBench({ compare: [FLAG] });
  }, 180_000);

  it('concurrency classes: every recording replays through all five wire formats, flag off and on, byte for byte', () => {
    const key = (r: BenchReport['runs'][number]) => `${r.fixture} on ${r.wire}`;
    const off = report.runs.filter((r) => !r.flagsOn.includes(FLAG));
    const on = new Map(report.runs.filter((r) => r.flagsOn.includes(FLAG)).map((r) => [key(r), r]));
    expect(new Set(off.map((r) => r.wire))).toEqual(new Set(LANES.map((l) => l.wire)));
    expect(off.length).toBeGreaterThanOrEqual(9 * LANES.length);
    expect(on.size).toBe(off.length);
    for (const r of off) {
      const c = on.get(key(r))!;
      expect(r.reconstructionMismatches, key(r)).toBe(0);
      expect(c.reconstructionMismatches, `${key(r)} with the flag on`).toBe(0);
      expect([c.rounds, c.requests, c.toolCalls, c.sent, c.perRequest], key(r))
        .toEqual([r.rounds, r.requests, r.toolCalls, r.sent, r.perRequest]);
    }
  });
});

describe('prefix stability', () => {
  const body = (messages: unknown[], marker: number) =>
    JSON.stringify({
      system: [{ type: 'text', text: 'S' }],
      tools: [{ name: 't' }],
      messages: messages.map((m, i) => (i === marker ? { ...(m as object), cache_control: { type: 'ephemeral' } } : m)),
    });

  it('a moved cache breakpoint is not a prefix change; an appended turn is the only new share', () => {
    const a = { role: 'user', content: 'hello' };
    const b = { role: 'assistant', content: 'hi' };
    const prev = anatomy('anthropic_messages', body([a], 0));
    expect(stableShare(prev, anatomy('anthropic_messages', body([a], -1)))).toBe(1);
    const next = anatomy('anthropic_messages', body([a, b], 1));
    const bytesOf = (xs: unknown[]) => xs.reduce<number>((s, x) => s + cacheKeyOf(x).length, 0);
    expect(stableShare(prev, next)).toBeCloseTo(bytesOf(prev.order) / bytesOf(next.order), 5);
    expect(stableShare(prev, next)).toBeLessThan(1);
  });
});

/**
 * TOOL_DESC_TRIM_V1 is a catalog INPUT: the bench cannot rebuild the catalog under it, so
 * the snapshot records the tool entries its ON build changes (catalog.json `variants`) and
 * the ON pass swaps them in. Pinned here: the swap is by name and in place (the catalog
 * order is a cache prefix), the OFF pass is the committed catalog untouched, and the
 * comparison measures a real drop on every family over today's rails.
 */
describe('harness bench: a catalog-input flag (TOOL_DESC_TRIM_V1) swaps its recorded variant in', () => {
  const FLAG = 'TOOL_DESC_TRIM_V1';
  it('the swap is by name and in place, and only for a pass that has the flag on', () => {
    const catalog = loadCatalog();
    const variant = catalog.variants?.[FLAG] ?? [];
    expect(variant.map((t) => t.name)).toEqual(expect.arrayContaining(['Agent', 'Grep', 'AskUserQuestion', 'Bash', 'Read', 'Monitor', 'TodoUpdate']));
    const off = benchTools(catalog).tools;
    const on = benchTools(catalog, [FLAG]).tools;
    expect(on.map((t) => t.name)).toEqual(off.map((t) => t.name));
    for (const [i, t] of off.entries()) {
      const swapped = variant.find((v) => v.name === t.name);
      expect(t.description).toBe(catalog.tools[i]?.description ?? t.description);
      if (swapped) expect(on[i]?.description).toBe(swapped.description);
      else expect(on[i]?.description).toBe(t.description);
    }
  });

  let report: BenchReport;
  beforeAll(async () => {
    report = await runBench({ fixtures: ['01'], base: ['TOOL_SEARCH_V1', 'TOOL_DEFER_V1', 'TOOL_DEFER_WIDE_V1'], compare: [FLAG] });
  }, 180_000);

  it('every family carries a smaller standing prefix with the flag on, on the same rail', () => {
    for (const l of report.comparison!.lanes) {
      expect(l.on.rail, l.wire).toBe(l.off.rail);
      expect(l.on.standingPrefix.tools, l.wire).toBe(l.off.standingPrefix.tools);
      expect(l.on.standingPrefix.contextTokens, l.wire).toBeLessThan(l.off.standingPrefix.contextTokens - 900);
    }
  });
});

/**
 * T1b finish (harness to nine): the standing prefix the 12K goal is judged on, measured on every
 * CI run and printed in the test log. Before: the committed catalog with TaskOutput and TaskStop
 * back in the wide resident core, as they were. Then the aliases deferred (the committed catalog
 * as it is), then TOOL_SCHEMA_COMPACT_V1 on top. The standing prefix (system plus the tools in
 * context on the first request) is the same for every recording of a lane, so one recording
 * measures it. Monitor is wide-deferred in the committed catalog since T1b to 12K, so both
 * columns here leave it out (the next describe measures that step).
 */
describe('harness bench: T1b finish, the standing prefix before and after', () => {
  const ALIASES = new Set(['TaskOutput', 'TaskStop']);
  const BASE = ['TOOL_SEARCH_V1', 'TOOL_DEFER_V1', 'TOOL_DEFER_WIDE_V1'];
  const COMPACT = 'TOOL_SCHEMA_COMPACT_V1';
  let before: BenchReport;
  let after: BenchReport;
  beforeAll(async () => {
    const committed = loadCatalog();
    const aliasesResident = {
      ...committed,
      tools: committed.tools.map((t) => {
        if (!ALIASES.has(t.name)) return t;
        const { deferrableWide: _wide, ...rest } = t;
        return rest;
      }),
    };
    before = await runBench({ catalog: aliasesResident, base: BASE, fixtures: ['01'] });
    after = await runBench({ base: BASE, compare: [COMPACT], fixtures: ['01'] });
  }, 180_000);

  it('each step shrinks the standing prefix on every model family (the table is logged)', () => {
    const prefix = (r: BenchReport, wire: string, compactOn: boolean): number => {
      const run = r.runs.find((x) => x.wire === wire && x.flagsOn.includes(COMPACT) === compactOn);
      if (!run) throw new Error(`no ${wire} run (compact ${compactOn})`);
      return run.standingPrefix.contextTokens;
    };
    const rows = LANES.map((l) => ({
      wire: l.wire,
      model: l.model,
      before: prefix(before, l.wire, false),
      aliasesDeferred: prefix(after, l.wire, false),
      compact: prefix(after, l.wire, true),
    }));
    console.log(
      'T1b finish, standing prefix (est tokens): wire | model | before | aliases deferred | + TOOL_SCHEMA_COMPACT_V1\n'
      + rows.map((r) => `${r.wire} | ${r.model} | ${r.before} | ${r.aliasesDeferred} | ${r.compact}`).join('\n'),
    );
    for (const r of rows) {
      expect(r.aliasesDeferred, r.wire).toBeLessThan(r.before);
      expect(r.compact, r.wire).toBeLessThan(r.aliasesDeferred);
    }
  });
});

/**
 * T1b to 12K (harness to nine): Monitor leaves the wide resident core (prod, 30 days: 3 of 739
 * tasks that called a tool). Before: the committed catalog with Monitor back in the core, as it
 * was. After: the committed catalog (Monitor wide-deferred), then TOOL_SCHEMA_COMPACT_V1 on top,
 * which staging also runs. The always-sent tokens per model family are printed in the test log;
 * the PR body carries the table. The goal on Claude is 12,000.
 */
describe('harness bench: T1b to 12K, Monitor deferred, the standing prefix before and after', () => {
  const BASE = ['TOOL_SEARCH_V1', 'TOOL_DEFER_V1', 'TOOL_DEFER_WIDE_V1'];
  const COMPACT = 'TOOL_SCHEMA_COMPACT_V1';
  let before: BenchReport;
  let after: BenchReport;
  beforeAll(async () => {
    const committed = loadCatalog();
    const monitorResident = {
      ...committed,
      tools: committed.tools.map((t) => {
        if (t.name !== 'Monitor') return t;
        const { deferrableWide: _wide, ...rest } = t;
        return rest;
      }),
    };
    before = await runBench({ catalog: monitorResident, base: BASE, compare: [COMPACT], fixtures: ['01'] });
    after = await runBench({ base: BASE, compare: [COMPACT], fixtures: ['01'] });
  }, 180_000);

  it('Monitor deferred shrinks the standing prefix on every model family, compact or not (the table is logged)', () => {
    const prefix = (r: BenchReport, wire: string, compactOn: boolean): number => {
      const run = r.runs.find((x) => x.wire === wire && x.flagsOn.includes(COMPACT) === compactOn);
      if (!run) throw new Error(`no ${wire} run (compact ${compactOn})`);
      return run.standingPrefix.contextTokens;
    };
    const rows = LANES.map((l) => ({
      family: l.family,
      model: l.model,
      before: prefix(before, l.wire, false),
      after: prefix(after, l.wire, false),
      compactBefore: prefix(before, l.wire, true),
      compactAfter: prefix(after, l.wire, true),
    }));
    console.log(
      'T1b to 12K, standing prefix (est tokens): family | model | wide before | wide after | + compact before | + compact after\n'
      + rows.map((r) => `${r.family} | ${r.model} | ${r.before} | ${r.after} | ${r.compactBefore} | ${r.compactAfter}`).join('\n'),
    );
    // Mutation: Monitor back in the wide resident core (catalog unmarked) → before equals after.
    for (const r of rows) {
      expect(r.after, r.family).toBeLessThan(r.before);
      expect(r.compactAfter, r.family).toBeLessThan(r.compactBefore);
    }
  });
});

/**
 * T1b to 12K, the second step (harness to nine): TodoGet leaves the wide resident core (prod,
 * 30 days: 6 of 739 tasks; TodoList stays and reads every todo), then TOOL_DESC_LEAN_V1, the
 * safe subset of TOOL_DESC_TRIM_V1 (restatements only, bounds only where strict status holds).
 * Before: the committed catalog with TodoGet back in the core. Each step on staging's real flag
 * set (the wide policy), with TOOL_SCHEMA_COMPACT_V1 off (staging today) and on (once it is
 * lane-safe). The table is printed in the test log; the goal on Claude is 11,900 or under.
 */
describe('harness bench: T1b to 12K, TodoGet deferred and TOOL_DESC_LEAN_V1, before and after', () => {
  const BASE = ['TOOL_SEARCH_V1', 'TOOL_DEFER_V1', 'TOOL_DEFER_WIDE_V1'];
  const COMPACT = 'TOOL_SCHEMA_COMPACT_V1';
  const LEAN = 'TOOL_DESC_LEAN_V1';
  let before: BenchReport;
  let todoDeferred: BenchReport;
  let lean: BenchReport;
  beforeAll(async () => {
    const committed = loadCatalog();
    const todoResident = {
      ...committed,
      tools: committed.tools.map((t) => {
        if (t.name !== 'TodoGet') return t;
        const { deferrableWide: _wide, ...rest } = t;
        return rest;
      }),
    };
    before = await runBench({ catalog: todoResident, base: BASE, compare: [COMPACT], fixtures: ['01'] });
    todoDeferred = await runBench({ base: BASE, compare: [COMPACT], fixtures: ['01'] });
    lean = await runBench({ base: [...BASE, LEAN], compare: [COMPACT], fixtures: ['01'] });
  }, 240_000);

  it('each step shrinks the standing prefix on every model family, compact off and on (the table is logged)', () => {
    const prefix = (r: BenchReport, wire: string, compactOn: boolean): number => {
      const run = r.runs.find((x) => x.wire === wire && x.flagsOn.includes(COMPACT) === compactOn);
      if (!run) throw new Error(`no ${wire} run (compact ${compactOn})`);
      return run.standingPrefix.contextTokens;
    };
    const rows = LANES.map((l) => ({
      family: l.family,
      model: l.model,
      off: [prefix(before, l.wire, false), prefix(todoDeferred, l.wire, false), prefix(lean, l.wire, false)],
      on: [prefix(before, l.wire, true), prefix(todoDeferred, l.wire, true), prefix(lean, l.wire, true)],
    }));
    console.log(
      'T1b to 12K step 2, standing prefix (est tokens): family | model | compact off: before, TodoGet deferred, + TOOL_DESC_LEAN_V1 | compact on: before, TodoGet deferred, + TOOL_DESC_LEAN_V1\n'
      + rows.map((r) => `${r.family} | ${r.model} | ${r.off.join(', ')} | ${r.on.join(', ')}`).join('\n'),
    );
    // Mutation: TodoGet back in the core (catalog unmarked) → the first step is flat; the lean
    // variant dropped from the catalog → the second step is flat.
    for (const r of rows) {
      for (const [name, [b, t, l]] of [['compact off', r.off], ['compact on', r.on]] as const) {
        expect(t, `${r.family} ${name}: TodoGet deferred`).toBeLessThan(b);
        expect(l, `${r.family} ${name}: + TOOL_DESC_LEAN_V1`).toBeLessThan(t);
      }
    }
  });
});

/**
 * TOOL_DESC_LEAN_V1, the bench's pass rate: every recorded run still replays through all five
 * wire formats, flag off and on, round for round, with the reconstruction check clean in both
 * passes, on staging's real flag set (the wide policy) with compaction off (staging today).
 */
describe('harness bench: TOOL_DESC_LEAN_V1 over the wide policy, every recording', () => {
  const LEAN = 'TOOL_DESC_LEAN_V1';
  let report: BenchReport;
  beforeAll(async () => {
    report = await runBench({ base: ['TOOL_SEARCH_V1', 'TOOL_DEFER_V1', 'TOOL_DEFER_WIDE_V1'], compare: [LEAN] });
  }, 180_000);

  it('lean: every recording replays through all five wire formats, flag off and on, round for round', () => {
    const key = (r: BenchReport['runs'][number]) => `${r.fixture} on ${r.wire}`;
    const off = report.runs.filter((r) => !r.flagsOn.includes(LEAN));
    const on = new Map(report.runs.filter((r) => r.flagsOn.includes(LEAN)).map((r) => [key(r), r]));
    expect(off.length).toBeGreaterThanOrEqual(9 * LANES.length);
    expect(on.size).toBe(off.length);
    for (const r of off) {
      const l = on.get(key(r))!;
      expect(r.reconstructionMismatches, key(r)).toBe(0);
      expect(l.reconstructionMismatches, `${key(r)} lean`).toBe(0);
      expect([l.rounds, l.requests, l.toolCalls], key(r)).toEqual([r.rounds, r.requests, r.toolCalls]);
    }
    // Same rail, same resident tool count, a smaller standing prefix on every family.
    for (const c of report.comparison!.lanes) {
      expect(c.on.rail, c.wire).toBe(c.off.rail);
      expect(c.on.standingPrefix.tools, c.wire).toBe(c.off.standingPrefix.tools);
      expect(c.on.standingPrefix.contextTokens, c.wire).toBeLessThan(c.off.standingPrefix.contextTokens);
    }
  });
});

