/**
 * run-live — the harness bench, live half (harness-to-nine G2b).
 *
 * The replay half (../run.ts) measures what each request WOULD put on the wire, free and
 * offline. This half runs a small fixed set of real tasks (./tasks.ts) end to end
 * through the real engine (NativeHarness, the product's system layers, the real Read /
 * Write / Edit / Bash / Grep / Glob tools in a fresh copy of ./workspace) against a
 * cheap model, and measures what actually happened: time to first token, time to first
 * tool and total wall time, rounds, tool calls, input / cached / output tokens, the
 * cache hit share and dollars, per task, plus whether the task was done.
 *
 *   FIREWORKS_API_KEY=... pnpm --filter @vestra/agent-sdk bench:live
 *   pnpm --filter @vestra/agent-sdk bench:live --model gemini-3.8-flash      (GEMINI_API_KEY)
 *   pnpm --filter @vestra/agent-sdk bench:live --tasks summarise,write-file --json out.json --md out.md
 *   pnpm --filter @vestra/agent-sdk bench:live --flags TOOLS_MIDSTREAM_V1     (listed flags set 'true')
 *
 * It spends money: about $0.05 per full run on DeepSeek V4.1 Flash. Every task carries a
 * per-task cap (maxBudgetUsd) and the run stops starting tasks once `--budget` (default
 * $0.20) is spent. Never an Anthropic key, never Opus: only the lanes below can run.
 * The model's tools act on a throwaway copy of the workspace, never on this repository.
 */
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { HarnessEvent } from '../../src/contract/events.js';
import type { HarnessContext, UserTurn } from '../../src/contract/harness.js';
import { assembleInstructionStack } from '../../src/contract/instruction-stack.js';
import { NativeHarness } from '../../src/engine/native-harness.js';
import type { NativeConfig } from '../../src/engine/native-config.js';
import { createLiveSpendLedger } from '../../src/engine/live-spend.js';
import type { StreamEvent, Transport } from '../../src/engine/transport.js';
import { Journal } from '../../src/kernel/journal/journal.js';
import { JsonlStore } from '../../src/kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../src/kernel/journal/session-store.js';
import { systemClock } from '../../src/kernel/journal/clock.js';
import { makeRuntimeConfig } from '../../src/ports/runtime-config.js';
import { createFileViewState } from '../../src/tools/file-view-state.js';
import { makeBashTool } from '../../src/tools/bash-tool.js';
import { makeEditTool } from '../../src/tools/edit-tool.js';
import { makeGlobTool } from '../../src/tools/glob-tool.js';
import { makeGrepTool } from '../../src/tools/grep-tool.js';
import { makeReadTool } from '../../src/tools/read-tool.js';
import { makeWriteTool } from '../../src/tools/write-tool.js';
import type { RawToolOptions } from '../../src/tools/tool-types.js';
import { ChatCompletionsTransport } from '../../src/transports/chat-completions-transport.js';
import { GeminiInteractionsTransport } from '../../src/transports/gemini-interactions-transport.js';
import { loadCatalog } from '../fixtures.js';
import { pickTasks, type LiveTask } from './tasks.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const WORKSPACE_DIR = join(HERE, 'workspace');
export const LIVE_SCHEMA = 'vestra.harness-bench-live/v1';

/** The cheap lanes the live half may run, and the one key each needs. Nothing else is accepted. */
export const LIVE_LANES = {
  'deepseek-v4.1-flash': { keyEnv: 'FIREWORKS_API_KEY', transport: (): Transport => new ChatCompletionsTransport() },
  'gemini-3.8-flash': { keyEnv: 'GEMINI_API_KEY', transport: (): Transport => new GeminiInteractionsTransport() },
} as const;
export type LiveModel = keyof typeof LIVE_LANES;
export const DEFAULT_MODEL: LiveModel = 'deepseek-v4.1-flash';

export const DEFAULT_BUDGET_USD = 0.2;
export const TASK_BUDGET_USD = 0.05;
const TASK_TIMEOUT_MS = 180_000;
const MAX_TURNS = 12;

export interface TimedEvent {
  /** ms since the task started (performance.now based). */
  at: number;
  ev: HarnessEvent;
}

export interface TaskMeasure {
  phases: {
    /** First streamed text or thinking, wall clock from the turn's start. */
    firstTokenMs: number | null;
    /** First tool call on the stream. */
    firstToolMs: number | null;
    totalMs: number;
    /** The engine's own time-to-first-token for the first model call. */
    modelTtftMs: number | null;
  };
  rounds: number;
  toolCalls: number;
  tokens: {
    /** Uncached input (the engine reports input EXCLUSIVE of the cache buckets). */
    input: number;
    cachedInput: number;
    cacheWrite: number;
    output: number;
    reasoning: number;
    /** Everything the prompts carried: input + cached + cache writes. */
    prompt: number;
  };
  /** cachedInput / prompt, or null with no prompt tokens. */
  cacheHitShare: number | null;
  costUsd: number;
  outcome: string;
  finalText: string;
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** What the timed transport saw on the provider stream itself (ms since the task started). */
export interface StreamClock {
  firstTokenMs: number | null;
  firstToolMs: number | null;
}

/**
 * Read one task's event stream into its numbers. Pure. Only the main loop counts as a
 * round: an off-loop side call (a `lane`d usage) is metered elsewhere and is not the task.
 * `stream` (from {@link timedTransport}) wins for the first token and the first tool: the
 * engine yields a tool_use block only after the round's stream ends, so a tool that starts
 * mid-stream (TOOLS_MIDSTREAM_V1) is visible only on the provider stream.
 */
export function measure(events: readonly TimedEvent[], stream?: StreamClock): TaskMeasure {
  let firstTokenMs: number | null = null;
  let firstToolMs: number | null = null;
  let modelTtftMs: number | null = null;
  let totalMs = 0;
  let rounds = 0;
  const toolIds = new Set<string>();
  const tokens = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, prompt: 0 };
  let costUsd = 0;
  let outcome = 'none';
  let summary: string | undefined;
  const streamed: string[] = [];

  for (const { at, ev } of events) {
    totalMs = Math.max(totalMs, at);
    if (ev.kind === 'thinking_start' && firstTokenMs === null) firstTokenMs = at;
    if (ev.kind === 'block') {
      const b = ev.block;
      if ((b.type === 'text' || b.type === 'thinking') && firstTokenMs === null) firstTokenMs = at;
      if (b.type === 'text') streamed.push(b.text);
      if (b.type === 'tool_use') {
        if (firstToolMs === null) firstToolMs = at;
        toolIds.add(b.toolUseId);
      }
    }
    if (ev.kind === 'usage' && ev.lane === undefined) {
      rounds++;
      if (modelTtftMs === null && ev.ttftMs !== undefined) modelTtftMs = ev.ttftMs;
      const u = ev.usage;
      tokens.input += u.inputTokens;
      tokens.cachedInput += u.cacheReadInputTokens ?? 0;
      tokens.cacheWrite += u.cacheCreationInputTokens ?? 0;
      tokens.output += u.outputTokens;
      tokens.reasoning += u.reasoningTokens ?? 0;
    }
    if (ev.kind === 'turn_end') {
      totalMs = at;
      outcome = ev.outcome.kind;
      costUsd = ev.billing?.cumulativeCostUsd ?? 0;
      if (ev.outcome.kind === 'completed') summary = ev.outcome.summary;
    }
  }
  tokens.prompt = tokens.input + tokens.cachedInput + tokens.cacheWrite;
  if (stream?.firstTokenMs != null) firstTokenMs = stream.firstTokenMs;
  if (stream?.firstToolMs != null) firstToolMs = stream.firstToolMs;
  return {
    phases: {
      firstTokenMs: firstTokenMs === null ? null : Math.round(firstTokenMs),
      firstToolMs: firstToolMs === null ? null : Math.round(firstToolMs),
      totalMs: Math.round(totalMs),
      modelTtftMs,
    },
    rounds,
    toolCalls: toolIds.size,
    tokens,
    cacheHitShare: tokens.prompt > 0 ? round3(tokens.cachedInput / tokens.prompt) : null,
    costUsd,
    outcome,
    finalText: summary && summary.trim() ? summary : streamed.join(''),
  };
}

/** The six tools a live task can use, real, rooted at the task's workspace copy. */
export function liveTools(workspaceDir: string, taskId: string): RawToolOptions[] {
  const wd = (): string => workspaceDir;
  const viewState = createFileViewState();
  return [
    makeReadTool(wd, viewState),
    makeWriteTool(wd, viewState),
    makeEditTool(wd, viewState),
    makeGlobTool(wd),
    makeGrepTool(wd),
    makeBashTool(wd, taskId),
  ];
}

export interface LiveTaskReport extends Omit<TaskMeasure, 'finalText'> {
  task: string;
  shape: string;
  pass: boolean;
  detail: string;
  /** The reply, cut to 400 characters (the check's evidence, and a sanity look). */
  reply: string;
  error?: string;
}

export interface RunTaskOptions {
  model: string;
  /**
   * Where the task runs. The run passes ONE path for every task (cleared and re-seeded
   * each time), because the system prompt names it: the same path keeps the prompt, and
   * so the provider's prompt cache, identical across tasks. Absent: a fresh temp dir.
   */
  workspaceDir?: string;
  /** Built inside the task, so a lane that cannot even construct is a crashed task, not a crashed run. */
  transport: () => Transport;
  systemPrompt: string;
  maxBudgetUsd?: number;
  timeoutMs?: number;
}

const isToolEvent = (ev: StreamEvent): boolean => ev.kind === 'tool_use' || ev.kind === 'tool_ready';
const isTokenEvent = (ev: StreamEvent): boolean => ev.kind === 'text' || ev.kind === 'thinking' || ev.kind === 'thinking_start';

/**
 * The transport, with its provider stream watched: the first token and the first tool
 * (`tool_ready` mid-stream, or `tool_use` at the stream's end) are timed where the
 * provider produced them. Everything else passes straight through to the real transport.
 */
export function timedTransport(inner: Transport, t0: () => number, clock: StreamClock): Transport {
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'readStream') {
        return async function* (stream: unknown): AsyncIterable<StreamEvent> {
          for await (const ev of target.readStream(stream)) {
            if (clock.firstTokenMs === null && isTokenEvent(ev)) clock.firstTokenMs = performance.now() - t0();
            if (clock.firstToolMs === null && isToolEvent(ev)) clock.firstToolMs = performance.now() - t0();
            yield ev;
          }
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** Run one task end to end in a fresh workspace copy and measure it. Never throws: a crash is a failed task. */
export async function runLiveTask(task: LiveTask, opts: RunTaskOptions): Promise<LiveTaskReport> {
  const workspaceDir = opts.workspaceDir ?? mkdtempSync(join(tmpdir(), 'vestra-live-ws-'));
  const journalDir = mkdtempSync(join(tmpdir(), 'vestra-live-journal-'));
  seedWorkspace(workspaceDir);
  const taskId = `bench-live-${task.id}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? TASK_TIMEOUT_MS);
  const events: TimedEvent[] = [];
  const clock: StreamClock = { firstTokenMs: null, firstToolMs: null };
  let t0 = performance.now();
  let error: string | undefined;
  try {
    const transport = timedTransport(opts.transport(), () => t0, clock);
    const journal = new Journal({
      taskId,
      workspaceId: 'bench-live',
      jsonl: new JsonlStore(join(journalDir, 'journal.jsonl')),
      mirror: new InMemorySessionStore(),
      clock: systemClock(),
    });
    const tools = liveTools(workspaceDir, taskId);
    const config: NativeConfig = {
      onAttached: () => {},
      maxTurns: MAX_TURNS,
      maxBudgetUsd: opts.maxBudgetUsd ?? TASK_BUDGET_USD,
      // The ledger is what makes the cap bite MID-task: the engine's wallet gate reads it at
      // every round head and stops before the next model call (turn-ceiling-gate.ts).
      liveSpend: createLiveSpendLedger(),
      systemPrompt: opts.systemPrompt,
      transport,
      journal,
      abilities: [],
      workingDir: workspaceDir,
      signal: ac.signal,
      toolHost: { buildTools: async () => ({ tools, onAuthHalt: async () => {} }) },
      runtimeConfig: makeRuntimeConfig({ userId: 'bench-live', systemPrompt: opts.systemPrompt, workingDir: workspaceDir }),
    };
    const ctx: HarnessContext<NativeConfig> = {
      taskId,
      sessionId: taskId,
      cwd: workspaceDir,
      model: opts.model,
      signal: ac.signal,
      config,
    };
    const prompt = (async function* (): AsyncIterable<UserTurn> {
      yield { text: task.prompt };
    })();
    t0 = performance.now();
    for await (const ev of new NativeHarness().run(prompt, ctx)) events.push({ at: performance.now() - t0, ev });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }
  const m = measure(events, clock);
  const verdict = error ? { pass: false, detail: `run failed: ${error}` } : task.check(workspaceDir, m.finalText);
  rmSync(workspaceDir, { recursive: true, force: true });
  rmSync(journalDir, { recursive: true, force: true });
  const { finalText, ...numbers } = m;
  return {
    task: task.id,
    shape: task.shape,
    ...numbers,
    pass: verdict.pass,
    detail: verdict.detail,
    reply: finalText.slice(0, 400),
    ...(error !== undefined ? { error } : {}),
  };
}

export interface LiveReport {
  schema: typeof LIVE_SCHEMA;
  model: string;
  flagsOn: string[];
  startedAt: string;
  budgetUsd: number;
  /** True when the budget ran out before every task started (the unstarted ones are absent). */
  stoppedForBudget: boolean;
  tasks: LiveTaskReport[];
  totals: {
    tasks: number;
    passed: number;
    costUsd: number;
    costPerTaskUsd: number;
    promptTokens: number;
    promptTokensPerTask: number;
    cacheHitShare: number | null;
    /** Medians over the tasks that reached the phase. */
    firstTokenMsMedian: number | null;
    firstToolMsMedian: number | null;
    totalMsMedian: number | null;
  };
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export function summarizeLive(tasks: readonly LiveTaskReport[]): LiveReport['totals'] {
  const cost = tasks.reduce((s, t) => s + t.costUsd, 0);
  const prompt = tasks.reduce((s, t) => s + t.tokens.prompt, 0);
  const cached = tasks.reduce((s, t) => s + t.tokens.cachedInput, 0);
  const n = tasks.length;
  const nums = (pick: (t: LiveTaskReport) => number | null) => tasks.map(pick).filter((x): x is number => x !== null);
  return {
    tasks: n,
    passed: tasks.filter((t) => t.pass).length,
    costUsd: Math.round(cost * 1e6) / 1e6,
    costPerTaskUsd: n ? Math.round((cost / n) * 1e6) / 1e6 : 0,
    promptTokens: prompt,
    promptTokensPerTask: n ? Math.round(prompt / n) : 0,
    cacheHitShare: prompt > 0 ? round3(cached / prompt) : null,
    firstTokenMsMedian: median(nums((t) => t.phases.firstTokenMs)),
    firstToolMsMedian: median(nums((t) => t.phases.firstToolMs)),
    totalMsMedian: median(nums((t) => t.phases.totalMs)),
  };
}

export interface LiveBenchOptions {
  model?: LiveModel;
  tasks?: readonly string[];
  budgetUsd?: number;
  flags?: readonly string[];
  /** Tests inject a scripted transport; a real run builds the lane's own. */
  transport?: () => Transport;
}

/** The workspace root the catalog's layers were captured with (a cloud box's). */
export const PRODUCT_WORKSPACE_ROOT = '/app/workspace';

/**
 * A clean copy of the fixture at `dir`, with the `files/` folder a cloud box has: the
 * product prompt tells the model that files meant for the person belong there.
 */
export function seedWorkspace(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  cpSync(WORKSPACE_DIR, dir, { recursive: true });
  mkdirSync(join(dir, 'files'), { recursive: true });
}

/**
 * The product's system layers, as the native engine assembles them (the catalog snapshot
 * the replay half uses), with the box's workspace root rewritten to the one the task really
 * runs in. The snapshot was rendered on a cloud box, so it promises `/app/workspace`; left
 * as is, the model writes there first, the workspace confinement refuses it, and the task
 * spends rounds (and minutes of `ls` / `find`) looking for a folder that does not exist,
 * which is the bench measuring itself, not the harness (2 Oct: write-file, 6 rounds, 136 s).
 */
export function liveSystemPrompt(workspaceDir: string = PRODUCT_WORKSPACE_ROOT): string {
  const layers = loadCatalog().systemLayers.map((l) => ({ ...l, text: l.text.split(PRODUCT_WORKSPACE_ROOT).join(workspaceDir) }));
  return assembleInstructionStack(layers, 'native');
}

/** Env that would send a lane through a credential proxy instead of its own key: refused, never used. */
export const REFUSED_ENV: readonly string[] = ['FIREWORKS_BASE_URL', 'GEMINI_BASE_URL', 'GEMINI_AUTH_TOKEN'];
const SECRET_ENV = /(_API_KEY|_AUTH_TOKEN)$/;
const TOKEN_ENV = new Set(['GH_TOKEN', 'GITHUB_TOKEN']);

/**
 * Seal the process for the model's Bash: HOME becomes a throwaway dir (a login shell
 * reloads no real profile) and every secret leaves the env except the lane's own key, so
 * a dev shell's other keys can never reach a model-written command. Returns the undo.
 */
export function isolateEnv(keepKey: string): () => void {
  const saved = { ...process.env };
  const home = mkdtempSync(join(tmpdir(), 'vestra-live-home-'));
  for (const k of Object.keys(process.env)) {
    if (k !== keepKey && (SECRET_ENV.test(k) || TOKEN_ENV.has(k))) delete process.env[k];
  }
  process.env.HOME = home;
  return () => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(home, { recursive: true, force: true });
  };
}

export async function runLiveBench(opts: LiveBenchOptions = {}): Promise<LiveReport> {
  const model = opts.model ?? DEFAULT_MODEL;
  const lane = LIVE_LANES[model];
  if (!lane) throw new Error(`live bench: ${String(model)} is not a live lane (${Object.keys(LIVE_LANES).join(', ')})`);
  if (!opts.transport && !process.env[lane.keyEnv]) throw new Error(`live bench: ${lane.keyEnv} is not set (the ${model} lane needs it)`);
  const budgetUsd = opts.budgetUsd ?? DEFAULT_BUDGET_USD;
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 1) {
    throw new Error(`live bench: --budget must be a number of dollars above 0 and at most 1, got ${String(opts.budgetUsd)}`);
  }
  const proxied = REFUSED_ENV.filter((k) => process.env[k]);
  if (proxied.length) throw new Error(`live bench: refusing to run with ${proxied.join(', ')} set (the bench uses its own key, never a credential proxy)`);
  const flags = [...(opts.flags ?? [])];
  const restore = isolateEnv(lane.keyEnv);
  try {
    for (const f of flags) process.env[f] = 'true';
    // One workspace path for the whole run (see RunTaskOptions.workspaceDir), named in the prompt.
    // Canonical (macOS tmp is a symlink), so the path the prompt names is the one confinement resolves.
    const runDir = realpathSync(mkdtempSync(join(tmpdir(), 'vestra-live-')));
    const workspaceDir = join(runDir, 'workspace');
    const systemPrompt = liveSystemPrompt(workspaceDir);
    const startedAt = new Date().toISOString();
    const reports: LiveTaskReport[] = [];
    let spent = 0;
    let stoppedForBudget = false;
    for (const task of pickTasks(opts.tasks)) {
      if (spent >= budgetUsd) {
        stoppedForBudget = true;
        break;
      }
      const cap = Math.min(TASK_BUDGET_USD, budgetUsd - spent);
      const r = await runLiveTask(task, { model, transport: opts.transport ?? lane.transport, systemPrompt, maxBudgetUsd: cap, workspaceDir });
      // A task that crashed may have spent money the report cannot see: count its whole cap.
      spent += r.error !== undefined ? Math.max(cap, r.costUsd) : r.costUsd;
      reports.push(r);
    }
    rmSync(runDir, { recursive: true, force: true });
    return { schema: LIVE_SCHEMA, model, flagsOn: flags, startedAt, budgetUsd, stoppedForBudget, tasks: reports, totals: summarizeLive(reports) };
  } finally {
    restore();
  }
}

const ms = (x: number | null): string => (x === null ? 'n/a' : `${(x / 1000).toFixed(1)} s`);
const pct = (x: number | null): string => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
const usd = (x: number): string => `$${x.toFixed(4)}`;

export function renderLiveMarkdown(r: LiveReport): string {
  const t = r.totals;
  const lines = [
    `## Harness bench, live: ${r.model}`,
    '',
    `${t.passed} of ${t.tasks} tasks done. ${usd(t.costUsd)} spent (${usd(t.costPerTaskUsd)} per task, budget ${usd(r.budgetUsd)}).` +
      ` Cache hit ${pct(t.cacheHitShare)} of ${t.promptTokens} prompt tokens.` +
      (r.flagsOn.length ? ` Flags on: ${r.flagsOn.join(', ')}.` : '') +
      (r.stoppedForBudget ? ' Stopped early: the budget ran out.' : ''),
    '',
    '| task | done | first token | first tool | total | rounds | tools | prompt tok | cached | output tok | cache hit | cost |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...r.tasks.map(
      (x) =>
        `| ${x.task} | ${x.pass ? 'yes' : 'no'} | ${ms(x.phases.firstTokenMs)} | ${ms(x.phases.firstToolMs)} | ${ms(x.phases.totalMs)} | ` +
        `${x.rounds} | ${x.toolCalls} | ${x.tokens.prompt} | ${x.tokens.cachedInput} | ${x.tokens.output} | ${pct(x.cacheHitShare)} | ${usd(x.costUsd)} |`,
    ),
    `| **median / total** | ${t.passed}/${t.tasks} | ${ms(t.firstTokenMsMedian)} | ${ms(t.firstToolMsMedian)} | ${ms(t.totalMsMedian)} | | | ${t.promptTokens} | | | ${pct(t.cacheHitShare)} | ${usd(t.costUsd)} |`,
    '',
    ...r.tasks.filter((x) => !x.pass).map((x) => `- ${x.task} not done: ${x.detail}`),
    '',
  ];
  return lines.join('\n');
}

/** The CLI's options, every one taking a value. Anything else is refused, never ignored. */
export const CLI_OPTIONS = ['model', 'tasks', 'flags', 'budget', 'json', 'md'] as const;
type CliOption = (typeof CLI_OPTIONS)[number];

/** Parse `--name value` pairs; an unknown option or one with no value throws (a typo like `--out` once wrote nothing, silently). */
export function parseCliArgs(argv: readonly string[]): Partial<Record<CliOption, string>> {
  const out: Partial<Record<CliOption, string>> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const name = flag.startsWith('--') ? flag.slice(2) : '';
    if (!(CLI_OPTIONS as readonly string[]).includes(name)) {
      throw new Error(`live bench: unknown argument ${JSON.stringify(flag)} (options: ${CLI_OPTIONS.map((o) => `--${o}`).join(' ')})`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`live bench: ${flag} needs a value`);
    out[name as CliOption] = value;
  }
  return out;
}
const csv = (v: string | undefined): string[] => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

async function main(argv: readonly string[]): Promise<void> {
  const args = parseCliArgs(argv);
  const model = (args.model ?? DEFAULT_MODEL) as LiveModel;
  const budget = args.budget;
  const report = await runLiveBench({
    model,
    tasks: csv(args.tasks),
    flags: csv(args.flags),
    ...(budget !== undefined ? { budgetUsd: Number(budget) } : {}),
  });
  const json = args.json;
  const md = args.md;
  if (json) writeFileSync(resolve(json), `${JSON.stringify(report, null, 2)}\n`);
  if (md) writeFileSync(resolve(md), renderLiveMarkdown(report));
  else process.stdout.write(renderLiveMarkdown(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
