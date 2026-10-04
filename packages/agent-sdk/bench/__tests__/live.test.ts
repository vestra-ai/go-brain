/**
 * The live bench's contract, without spending a cent: the numbers it reads off an event
 * stream, the task checks against a real workspace copy, and one task driven END TO END
 * through the real engine, the real Write tool and the real Chat Completions transport,
 * with only the HTTP client scripted. CI runs this on every PR; the paid run is the
 * lead's (bench:live) and the dispatch workflow's.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../../src/contract/events.js';
import { ChatCompletionsTransport } from '../../src/transports/chat-completions-transport.js';
import type { StreamEvent, Transport } from '../../src/engine/transport.js';
import {
  CLI_OPTIONS,
  LIVE_LANES,
  LIVE_SCHEMA,
  PRODUCT_WORKSPACE_ROOT,
  WORKSPACE_DIR,
  parseCliArgs,
  seedWorkspace,
  isolateEnv,
  liveSystemPrompt,
  measure,
  renderLiveMarkdown,
  runLiveBench,
  runLiveTask,
  summarizeLive,
  timedTransport,
  type LiveTaskReport,
  type StreamClock,
  type TimedEvent,
} from '../live/run-live.js';
import { LIVE_TASKS, pickTasks } from '../live/tasks.js';

const usage = (inputTokens: number, cached: number, outputTokens: number, extra: Partial<Extract<HarnessEvent, { kind: 'usage' }>> = {}): HarnessEvent => ({
  kind: 'usage',
  usage: { inputTokens, outputTokens, cacheReadInputTokens: cached },
  ...extra,
});

describe('live bench: measure() reads one task off its event stream', () => {
  const events: TimedEvent[] = [
    { at: 120, ev: { kind: 'thinking_start' } },
    { at: 300, ev: { kind: 'block', block: { type: 'text', text: 'Looking. ' } } },
    { at: 900, ev: { kind: 'block', block: { type: 'tool_use', toolUseId: 't1', toolName: 'Read', toolInput: {}, status: 'pending', startTime: new Date() } } as HarnessEvent },
    { at: 950, ev: usage(1000, 0, 40, { ttftMs: 110 }) },
    { at: 1400, ev: { kind: 'block', block: { type: 'tool_use', toolUseId: 't2', toolName: 'Grep', toolInput: {}, status: 'pending', startTime: new Date() } } as HarnessEvent },
    { at: 1450, ev: usage(200, 900, 30) },
    // An off-loop side call: metered on its lane, never a round of the task.
    { at: 1500, ev: usage(5000, 0, 10, { lane: 'sweep' }) },
    { at: 2000, ev: { kind: 'block', block: { type: 'text', text: 'Done.' } } },
    { at: 2100, ev: usage(100, 1100, 20) },
    {
      at: 2200,
      ev: {
        kind: 'turn_end',
        outcome: { kind: 'completed', summary: 'Done.', costUsd: 0, numTurns: 3, durationMs: 2200, modelUsage: {}, raw: { subtype: 'success', errors: [] } },
        billing: { cumulativeCostUsd: 0.0012 },
      } as HarnessEvent,
    },
  ];
  const m = measure(events);

  it('phases: first token (thinking counts), first tool, total, the engine ttft', () => {
    expect(m.phases).toEqual({ firstTokenMs: 120, firstToolMs: 900, totalMs: 2200, modelTtftMs: 110 });
  });

  it('rounds and tokens count the main loop only; prompt = uncached + cached + writes', () => {
    expect(m.rounds).toBe(3);
    expect(m.toolCalls).toBe(2);
    expect(m.tokens).toEqual({ input: 1300, cachedInput: 2000, cacheWrite: 0, output: 90, reasoning: 0, prompt: 3300 });
    expect(m.cacheHitShare).toBe(0.606);
  });

  it('cost and outcome come from turn_end; the reply is the completed summary', () => {
    expect(m.costUsd).toBe(0.0012);
    expect(m.outcome).toBe('completed');
    expect(m.finalText).toBe('Done.');
  });

  it('a stream with no turn_end reads as no outcome and the streamed text', () => {
    const cut = measure(events.slice(0, 3));
    expect(cut.outcome).toBe('none');
    expect(cut.finalText).toBe('Looking. ');
    expect(cut.cacheHitShare).toBeNull();
  });
});

describe('live bench: the tasks and their checks', () => {
  const copy = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'live-check-'));
    cpSync(WORKSPACE_DIR, dir, { recursive: true });
    return dir;
  };
  const task = (id: string) => LIVE_TASKS.find((t) => t.id === id)!;

  it('5 to 8 tasks, unique ids, every one with a prompt and a shape', () => {
    expect(LIVE_TASKS.length).toBeGreaterThanOrEqual(5);
    expect(LIVE_TASKS.length).toBeLessThanOrEqual(8);
    expect(new Set(LIVE_TASKS.map((t) => t.id)).size).toBe(LIVE_TASKS.length);
    for (const t of LIVE_TASKS) expect(t.prompt.length && t.shape.length).toBeTruthy();
    expect(() => pickTasks(['nope'])).toThrow(/no task named nope/);
  });

  it('fix-and-test fails on the shipped bug and passes once add() is fixed', () => {
    const dir = copy();
    expect(task('fix-and-test').check(dir, '').pass).toBe(false);
    writeFileSync(join(dir, 'src/math.js'), 'function add(a, b) { return a + b; }\nfunction multiply(a, b) { return a * b; }\nmodule.exports = { add, multiply };\n');
    expect(task('fix-and-test').check(dir, '').pass).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('write-file reads the file the run left, not the reply', () => {
    const dir = copy();
    expect(task('write-file').check(dir, 'I wrote it.').pass).toBe(false);
    writeFileSync(join(dir, 'hello.txt'), 'bench ok\n');
    expect(task('write-file').check(dir, '').pass).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('the answer checks take the right answer and refuse a wrong one', () => {
    expect(task('count-todos').check('', '3').pass).toBe(true);
    expect(task('count-todos').check('', '13').pass).toBe(false);
    expect(task('find-default').check('', 'src/cart.js, 0.15').pass).toBe(true);
    expect(task('find-default').check('', 'src/cart.js, 0.2').pass).toBe(false);
    expect(task('sum-numbers').check('', 'The total is 100.').pass).toBe(true);
    expect(task('summarise').check('', 'The launch moved to Thursday.').pass).toBe(true);
  });
});

/** A scripted OpenAI client: Write hello.txt first, then the final text once the tool result is back. */
function scriptedClient(): OpenAI {
  const c = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ choices: [{ index: 0, delta, ...extra }] });
  const stream = (params: { messages: Array<{ role: string }> }) =>
    (async function* () {
      if (!params.messages.some((m) => m.role === 'tool')) {
        yield c({ content: 'Writing it now.' });
        yield c({ tool_calls: [{ index: 0, id: 'call_w', type: 'function', function: { name: 'Write', arguments: '{"file_path":"hello.txt","content":"bench ok"}' } }] });
        yield c({}, { finish_reason: 'tool_calls' });
        yield { choices: [], usage: { prompt_tokens: 3000, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 0 } } };
      } else {
        yield c({ content: 'Done: hello.txt holds bench ok.' });
        yield c({}, { finish_reason: 'stop' });
        yield { choices: [], usage: { prompt_tokens: 3100, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 2900 } } };
      }
    })();
  return { chat: { completions: { stream } } } as unknown as OpenAI;
}

describe('live bench: one task end to end through the real engine (scripted model)', () => {
  it('write-file: done, measured, priced, and reported', async () => {
    const report = await runLiveBench({ tasks: ['write-file'], transport: () => new ChatCompletionsTransport({ client: scriptedClient() }) });
    expect(report.schema).toBe(LIVE_SCHEMA);
    expect(report.model).toBe('deepseek-v4.1-flash');
    const [t] = report.tasks as [LiveTaskReport];
    expect(t.error).toBeUndefined();
    expect(t.pass, t.detail).toBe(true);
    expect(t.outcome).toBe('completed');
    expect(t.rounds).toBe(2);
    expect(t.toolCalls).toBe(1);
    expect(t.phases.firstTokenMs).not.toBeNull();
    expect(t.phases.firstToolMs).not.toBeNull();
    expect(t.phases.firstToolMs!).toBeLessThanOrEqual(t.phases.totalMs);
    // The provider reports prompt tokens INCLUDING the cached ones; the engine splits them.
    expect(t.tokens.prompt).toBe(6100);
    expect(t.tokens.cachedInput).toBe(2900);
    expect(t.cacheHitShare).toBe(0.475);
    expect(t.costUsd).toBeGreaterThan(0);
    expect(t.costUsd).toBeLessThan(0.01);
    expect(report.totals.passed).toBe(1);
    expect(renderLiveMarkdown(report)).toContain('| write-file | yes |');
  }, 60_000);

  it('the budget stops new tasks once it is spent', async () => {
    const report = await runLiveBench({ tasks: ['write-file', 'summarise'], budgetUsd: 0.000001, transport: () => new ChatCompletionsTransport({ client: scriptedClient() }) });
    // Tasks run in catalog order (summarise first); the first one spends past the cap, so the second never starts.
    expect(report.tasks.map((t) => t.task)).toEqual(['summarise']);
    expect(report.tasks[0]!.costUsd).toBeGreaterThan(0);
    expect(report.stoppedForBudget).toBe(true);
  }, 60_000);

  it('only the cheap lanes exist, and a real run refuses to start without its key', async () => {
    expect(Object.keys(LIVE_LANES).sort()).toEqual(['deepseek-v4.1-flash', 'gemini-3.8-flash']);
    const saved = process.env.FIREWORKS_API_KEY;
    delete process.env.FIREWORKS_API_KEY;
    await expect(runLiveBench({ tasks: ['write-file'] })).rejects.toThrow(/FIREWORKS_API_KEY is not set/);
    if (saved !== undefined) process.env.FIREWORKS_API_KEY = saved;
  });

  it('totals: medians over the tasks that reached a phase', () => {
    const base = measure([]);
    const mk = (task: string, firstToolMs: number | null, totalMs: number, costUsd: number): LiveTaskReport => ({
      ...base,
      phases: { ...base.phases, firstToolMs, totalMs },
      costUsd,
      task,
      shape: '',
      pass: true,
      detail: '',
      reply: '',
    });
    const s = summarizeLive([mk('a', 100, 1000, 0.01), mk('b', null, 3000, 0.02), mk('c', 300, 2000, 0.03)]);
    expect(s.firstToolMsMedian).toBe(200);
    expect(s.totalMsMedian).toBe(2000);
    expect(s.costPerTaskUsd).toBe(0.02);
  });
});

describe('live bench: the per-task cap bites mid-task (the live spend ledger)', () => {
  it('a first round that costs more than the cap ends the task max_budget before a second model call', async () => {
    const task = LIVE_TASKS.find((t) => t.id === 'write-file')!;
    const r = await runLiveTask(task, {
      model: 'deepseek-v4.1-flash',
      transport: () => new ChatCompletionsTransport({ client: scriptedClient() }),
      systemPrompt: liveSystemPrompt(),
      maxBudgetUsd: 0.0001,
    });
    expect(r.outcome).toBe('max_budget');
    expect(r.rounds).toBe(1);
    expect(r.costUsd).toBeGreaterThan(0.0001);
  }, 60_000);
});

describe('live bench: the model never gets the operator\'s environment', () => {
  it('HOME is a throwaway dir and every secret but the lane key leaves the env; the undo restores all of it', () => {
    const before = { ...process.env };
    process.env.FIREWORKS_API_KEY = 'lane-key';
    process.env.OPENAI_API_KEY = 'other-key';
    process.env.SOME_AUTH_TOKEN = 'tok';
    process.env.GH_TOKEN = 'gh';
    const realHome = process.env.HOME;
    const restore = isolateEnv('FIREWORKS_API_KEY');
    try {
      expect(process.env.FIREWORKS_API_KEY).toBe('lane-key');
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
      expect(process.env.SOME_AUTH_TOKEN).toBeUndefined();
      expect(process.env.GH_TOKEN).toBeUndefined();
      expect(process.env.HOME).not.toBe(realHome);
      expect(process.env.HOME).toContain('vestra-live-home-');
    } finally {
      restore();
    }
    expect(process.env.OPENAI_API_KEY).toBe('other-key');
    expect(process.env.HOME).toBe(realHome);
    for (const k of ['FIREWORKS_API_KEY', 'OPENAI_API_KEY', 'SOME_AUTH_TOKEN', 'GH_TOKEN']) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  });

  it('a credential-proxy base URL in the env refuses the run', async () => {
    process.env.FIREWORKS_BASE_URL = 'http://proxy.example';
    try {
      await expect(runLiveBench({ tasks: ['write-file'], transport: () => new ChatCompletionsTransport({ client: scriptedClient() }) })).rejects.toThrow(
        /refusing to run with FIREWORKS_BASE_URL/,
      );
    } finally {
      delete process.env.FIREWORKS_BASE_URL;
    }
  });
});

describe('live bench: the budget is checked, and a crash counts against it', () => {
  const scripted = () => new ChatCompletionsTransport({ client: scriptedClient() });

  it('--budget must be a finite number of dollars in (0, 1]', async () => {
    for (const budgetUsd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.01]) {
      await expect(runLiveBench({ tasks: ['write-file'], budgetUsd, transport: scripted })).rejects.toThrow(/--budget must be/);
    }
  });

  it('a task that crashes charges its whole cap, so crashing tasks cannot run the budget forever', async () => {
    const report = await runLiveBench({
      tasks: ['summarise', 'count-todos', 'find-default'],
      budgetUsd: 0.08,
      transport: () => {
        throw new Error('lane cannot start');
      },
    });
    // $0.05 charged for the first crash, $0.03 (the remaining cap) for the second: the third never starts.
    expect(report.tasks.map((t) => t.error)).toEqual(['lane cannot start', 'lane cannot start']);
    expect(report.stoppedForBudget).toBe(true);
  });
});

describe('live bench: first token and first tool are timed on the provider stream', () => {
  it('the timed transport stamps the first token and the first tool where the stream produced them, and passes the rest through', async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const inner = {
      api: 'openai_chat_completions',
      callModel: () => 'stream',
      async *readStream(): AsyncIterable<StreamEvent> {
        await sleep(15);
        yield { kind: 'text', text: 'Reading.' };
        await sleep(15);
        yield { kind: 'tool_ready', toolUse: { id: 't1', name: 'Read', input: {} } };
        await sleep(15);
        yield { kind: 'tool_use', toolUse: { id: 't1', name: 'Read', input: {} } };
      },
    } as unknown as Transport;
    const clock: StreamClock = { firstTokenMs: null, firstToolMs: null };
    const t0 = performance.now();
    const t = timedTransport(inner, () => t0, clock);
    expect(t.api).toBe('openai_chat_completions');
    const kinds: string[] = [];
    for await (const ev of t.readStream(t.callModel({} as never))) kinds.push(ev.kind);
    expect(kinds).toEqual(['text', 'tool_ready', 'tool_use']);
    expect(clock.firstTokenMs).not.toBeNull();
    expect(clock.firstToolMs).not.toBeNull();
    // The first tool is the mid-stream tool_ready, before the final tool_use landed.
    expect(clock.firstToolMs!).toBeGreaterThan(clock.firstTokenMs!);
    expect(clock.firstToolMs!).toBeLessThan(performance.now() - t0 - 10);
  });

  it('measure() takes the stream clock over the blocks', () => {
    const m = measure([{ at: 900, ev: { kind: 'block', block: { type: 'tool_use', toolUseId: 't', toolName: 'Read', toolInput: {}, status: 'pending', startTime: new Date() } } as HarnessEvent }], {
      firstTokenMs: 100,
      firstToolMs: 400,
    });
    expect(m.phases.firstTokenMs).toBe(100);
    expect(m.phases.firstToolMs).toBe(400);
  });
});

describe('live bench: the prompt names the workspace the task really runs in (2 Oct write-file: 6 rounds, 136 s)', () => {
  it('the box root in the catalog layers is rewritten to the run workspace; the default keeps the box root', () => {
    const ws = '/tmp/vestra-live-x/workspace';
    const p = liveSystemPrompt(ws);
    expect(p).toContain(`Workspace root (absolute): ${ws}`);
    expect(p).toContain(`Files meant for the user belong in: ${ws}/files`);
    expect(p).not.toContain(PRODUCT_WORKSPACE_ROOT);
    expect(liveSystemPrompt()).toContain(`Workspace root (absolute): ${PRODUCT_WORKSPACE_ROOT}`);
  });

  it('a seeded workspace is the clean fixture plus the files/ folder a box has', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'live-seed-')), 'workspace');
    seedWorkspace(dir);
    writeFileSync(join(dir, 'leftover.txt'), 'from the last task');
    seedWorkspace(dir);
    expect(existsSync(join(dir, 'files'))).toBe(true);
    expect(existsSync(join(dir, 'leftover.txt'))).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(['data', 'files', 'notes.md', 'src', 'test.js']);
  });

  it('write-file accepts files/hello.txt, where the product prompt sends files for the person', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'live-wf-')), 'workspace');
    seedWorkspace(dir);
    writeFileSync(join(dir, 'files/hello.txt'), 'bench ok\n');
    const r = LIVE_TASKS.find((t) => t.id === 'write-file')!.check(dir, '');
    expect(r).toEqual({ pass: true, detail: 'files/hello.txt holds "bench ok"' });
  });

  it('every task of a run sees the same prompt, naming the run workspace (so the prompt cache holds across tasks)', async () => {
    const systems: string[] = [];
    const recording = (): OpenAI => {
      const inner = scriptedClient() as unknown as { chat: { completions: { stream: (p: { messages: Array<{ role: string; content?: unknown }> }) => unknown } } };
      const stream = (params: { messages: Array<{ role: string; content?: unknown }> }) => {
        const sys = params.messages.find((m) => m.role === 'system');
        systems.push(typeof sys?.content === 'string' ? sys.content : JSON.stringify(sys?.content));
        return inner.chat.completions.stream(params);
      };
      return { chat: { completions: { stream } } } as unknown as OpenAI;
    };
    const report = await runLiveBench({ tasks: ['write-file', 'sum-numbers'], transport: () => new ChatCompletionsTransport({ client: recording() }) });
    expect(report.tasks).toHaveLength(2);
    expect(systems.length).toBeGreaterThanOrEqual(4);
    expect(new Set(systems).size).toBe(1);
    expect(systems[0]).not.toContain(PRODUCT_WORKSPACE_ROOT);
    expect(systems[0]).toMatch(/Workspace root \(absolute\): \S*vestra-live-\S*\/workspace/);
    // The scripted model writes the relative hello.txt; with the root accepted too, the task is done.
    expect(report.tasks.find((t) => t.task === 'write-file')!.pass).toBe(true);
  }, 60_000);
});

describe('live bench: the CLI refuses what it does not know', () => {
  it('known options parse; an unknown one (the --out that silently wrote nothing) or a missing value throws', () => {
    expect(CLI_OPTIONS).toEqual(['model', 'tasks', 'flags', 'budget', 'json', 'md']);
    expect(parseCliArgs(['--tasks', 'write-file', '--json', 'out.json'])).toEqual({ tasks: 'write-file', json: 'out.json' });
    expect(() => parseCliArgs(['--out', 'report.md'])).toThrow(/unknown argument "--out"/);
    expect(() => parseCliArgs(['--json'])).toThrow(/--json needs a value/);
    expect(() => parseCliArgs(['--json', '--md', 'x'])).toThrow(/--json needs a value/);
  });
});
