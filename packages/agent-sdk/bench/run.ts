/**
 * run — the harness bench, replay half (harness-to-nine G2).
 *
 * Replays every recorded run (src/__fixtures__/replay) through the real kernel loop
 * once per wire format, with the product's catalog and system prompt, and measures
 * what each request would have put on the wire. Free and deterministic: no key, no
 * network, no model call (harness time is the one wall-clock number).
 *
 *   pnpm --filter @vestra/agent-sdk bench
 *   pnpm --filter @vestra/agent-sdk bench --compare TOOL_SEARCH_V1,TOOL_DEFER_V1
 *   pnpm --filter @vestra/agent-sdk bench --base TOOL_SEARCH_V1,TOOL_DEFER_V1 --compare TOOL_DEFER_WIDE_V1
 *   pnpm --filter @vestra/agent-sdk bench --fixtures 02,08 --json out.json --md out.md
 *   pnpm --filter @vestra/agent-sdk bench --catalog /tmp/catalog.json --compare TOOL_DESC_TRIM_V1
 *
 * `--compare` runs everything twice, the listed flags off then on, and adds the
 * before and after table; `--base` flags stay on in both passes. The markdown goes to
 * stdout unless `--md` names a file. `--catalog` benches another snapshot (say one written
 * by `measure.mjs --scenario staging1001 --snapshot <path>`) instead of the committed one.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFixture } from '../src/engine/replay/fixture.js';
import { replaySession } from '../src/engine/replay/replay-session.js';
import type { ReplayTransport } from '../src/engine/replay/replay-transport.js';
import { estimateTokens } from '../src/kernel/journal/token-ledger.js';
import type { RawToolOptions } from '../src/tools/tool-types.js';
import { widenDeferral } from '../src/engine/tool-search.js';
import { benchTools, LANES, listFixtures, loadCatalog, systemPromptFor, type Catalog, type Fixture, type Lane } from './fixtures.js';
import { REPORT_SCHEMA, renderMarkdown, summarizeLane, type BenchReport, type RunReport } from './report.js';
import { anatomy, BenchTransport, inContext, stableShare } from './wire.js';

/** The flags that shape the standing prefix: always set explicitly, so a shell export never leaks into a baseline. */
export const PREFIX_FLAGS: readonly string[] = ['TOOL_SEARCH_V1', 'TOOL_DEFER_V1', 'TOOL_DEFER_WIDE_V1', 'TOOL_SCHEMA_COMPACT_V1'];

/** Run `fn` with each `controlled` flag set on ('true') iff listed in `on`, else unset; restored after. */
async function withFlags<T>(controlled: readonly string[], on: readonly string[], fn: () => Promise<T>): Promise<T> {
  const saved = controlled.map((k) => [k, process.env[k]] as const);
  for (const k of controlled) {
    if (on.includes(k)) process.env[k] = 'true';
    else delete process.env[k];
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const bytes = (s: string): number => Buffer.byteLength(s);
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Replay one recording through one lane and measure every request it sent. */
export async function runOne(
  fixture: Fixture,
  lane: Lane,
  catalog: Catalog,
  tools: RawToolOptions[],
  flagsOn: readonly string[] = [],
  controlled: readonly string[] = PREFIX_FLAGS,
): Promise<RunReport> {
  return withFlags(controlled, flagsOn, async () => {
    const { system, rail } = systemPromptFor(tools, catalog, lane.model);
    let bench: BenchTransport | undefined;
    let replay: ReplayTransport | undefined;
    const t0 = performance.now();
    const result = await replaySession(fixture.path, {
      tools,
      systemPrompt: system,
      model: lane.model,
      // A cross-dialect mismatch is a finding to report, not a reason to stop the bench.
      reconstructionCheck: 'warn',
      transport: (r) => {
        replay = r;
        return (bench = new BenchTransport(lane.wire, r));
      },
    });
    const wallMs = performance.now() - t0;
    if (!bench || !replay) throw new Error('bench: the replay never built its transport');
    const b = bench;

    const parts = b.bodies.map((body) => anatomy(lane.wire, body));
    const perRequest = parts.map((a, i) => ({
      wireBytes: bytes(b.bodies[i]),
      contextTokens: estimateTokens(JSON.stringify([...a.system, ...a.tools.filter(inContext), ...a.history])),
      stableShare: i === 0 ? null : round3(stableShare(parts[i - 1], a)),
    }));
    const first = parts[0];
    if (!first) throw new Error(`bench: ${fixture.name} sent no request on ${lane.wire}`);
    const shares = perRequest.flatMap((r) => (r.stableShare === null ? [] : [r.stableShare]));
    const rounds = result.transport.calls - result.transport.faultsThrown;
    const toolCalls = result.journal.filter((e) => e.payload.type === 'tool_use').length;
    const sentBytes = perRequest.reduce((s, r) => s + r.wireBytes, 0);
    const sentTokens = perRequest.reduce((s, r) => s + r.contextTokens, 0);
    return {
      fixture: fixture.name,
      recordedWire: replay.api,
      wire: lane.wire,
      model: lane.model,
      family: lane.family,
      flagsOn: [...flagsOn],
      rail,
      rounds,
      requests: b.bodies.length,
      toolCalls,
      toolCallsPerRound: round3(toolCalls / rounds),
      standingPrefix: {
        wireBytes: bytes(JSON.stringify(first.system)) + bytes(JSON.stringify(first.tools)),
        contextTokens: estimateTokens(JSON.stringify([...first.system, ...first.tools.filter(inContext)])),
        tools: first.tools.length,
        toolsInContext: first.tools.filter(inContext).length,
      },
      perRequest,
      sent: {
        wireBytes: sentBytes,
        contextTokens: sentTokens,
        wireBytesPerRound: Math.round(sentBytes / rounds),
        contextTokensPerRound: Math.round(sentTokens / rounds),
      },
      prefixStability: {
        mean: shares.length ? round3(shares.reduce((s, x) => s + x, 0) / shares.length) : null,
        min: shares.length ? Math.min(...shares) : null,
      },
      harnessMs: Math.round((wallMs - b.overheadMs) * 10) / 10,
      reconstructionMismatches: result.mismatches.length,
    };
  });
}

export interface BenchOptions {
  fixtures?: readonly string[];
  lanes?: readonly Lane[];
  /** Flags to compare: every run is made with them off, then on. Empty = baseline only. */
  compare?: readonly string[];
  /** Flags held ON in both passes, so `compare` measures a policy on top of them (e.g. TOOL_DEFER_WIDE_V1 over the two rails). */
  base?: readonly string[];
  catalog?: Catalog;
}

export async function runBench(opts: BenchOptions = {}): Promise<BenchReport> {
  const catalog = opts.catalog ?? loadCatalog();
  const lanes = opts.lanes ?? LANES;
  const fixtures = listFixtures(opts.fixtures);
  const compare = [...(opts.compare ?? [])];
  const base = [...(opts.base ?? [])];
  const controlled = [...new Set([...PREFIX_FLAGS, ...base, ...compare])];
  // Each pass carries the catalog its flags select: a catalog-input flag (a recorded
  // variant, e.g. TOOL_DESC_TRIM_V1) swaps tool entries in; every other flag is read live.
  const { tools, stubbed } = benchTools(catalog, base);
  const onTools = benchTools(catalog, [...base, ...compare]).tools;
  // Recorded calls that reach a deferred tool. The comparison's caveat reads this: a
  // replay only pays a ToolSearch round (or a schema load) if the recording made one.
  // Read under the on-pass flags, so a policy that widens the set counts what it widened.
  const widened = await withFlags(controlled, [...base, ...compare], async () => widenDeferral(onTools));
  const deferred = new Set(widened.filter((t) => t.deferrable === true).map((t) => t.name));
  const deferredToolCalls = fixtures
    .flatMap((f) => parseFixture(readFileSync(f.path, 'utf8')).entries)
    .filter((e) => e.payload.type === 'tool_use' && deferred.has(e.payload.name)).length;

  const pass = async (on: readonly string[], passTools: RawToolOptions[]): Promise<RunReport[]> => {
    const out: RunReport[] = [];
    for (const lane of lanes) {
      for (const f of fixtures) out.push(await runOne(f, lane, catalog, passTools, on, controlled));
    }
    return out;
  };
  const off = await pass(base, tools);
  const on = compare.length ? await pass([...base, ...compare], onTools) : [];
  const ofLane = (runs: RunReport[], l: Lane) => runs.filter((r) => r.wire === l.wire && r.model === l.model);

  return {
    schema: REPORT_SCHEMA,
    catalog: {
      tools: tools.length,
      deferrable: tools.filter((t) => t.deferrable === true).length,
      stubbed,
      source: catalog.source,
    },
    runs: [...off, ...on],
    comparison: compare.length
      ? {
          flags: compare,
          base,
          recordings: fixtures.length,
          deferredToolCalls,
          lanes: lanes.map((l) => ({
            family: l.family,
            wire: l.wire,
            model: l.model,
            off: summarizeLane(ofLane(off, l)),
            on: summarizeLane(ofLane(on, l)),
          })),
        }
      : null,
  };
}

function arg(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const csv = (v: string | undefined): string[] => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

async function main(argv: readonly string[]): Promise<void> {
  const catalogPath = arg(argv, 'catalog');
  const report = await runBench({
    ...(catalogPath ? { catalog: loadCatalog(resolve(catalogPath)) } : {}),
    fixtures: csv(arg(argv, 'fixtures')),
    compare: csv(arg(argv, 'compare')),
    base: csv(arg(argv, 'base')),
  });
  const json = arg(argv, 'json');
  const md = arg(argv, 'md');
  if (json) writeFileSync(resolve(json), `${JSON.stringify(report, null, 2)}\n`);
  if (md) writeFileSync(resolve(md), renderMarkdown(report));
  else process.stdout.write(renderMarkdown(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
