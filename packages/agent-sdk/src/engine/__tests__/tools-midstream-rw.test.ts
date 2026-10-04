/**
 * TOOLS_MIDSTREAM_RW_V1 (harness to nine, LOOP) — the read/write gate on top of L1.
 *
 * A shared call starts at its `tool_ready` unless an earlier exclusive call has not settled; an
 * exclusive call starts once every earlier call has settled; a later call queues behind it
 * (Codex tools/parallel.rs). Because an exclusive call may now run before the stream ends, a
 * round that ends first journals the started prefix in call order: on a stream error each call
 * runs to its end and its real result is journaled; on Stop each call gets the abort and its
 * interrupted result is journaled without waiting for it to finish; a call holding a card is
 * cancelled, never run. Real rounds through a scripted streaming transport on fake timers.
 *
 * Revert proof: with the gate off (L1's door), 'an exclusive call starts mid-stream' fails on
 * the Edit starting after the stream; without the fairness rule the Grep starts before the Edit
 * settles; without salvage, both drain cases journal nothing; with salvage waiting on Stop, the
 * Stop case runs past its wall-time bound; a salvage that ignores a held card shows the card or
 * runs the call.
 *
 * The review's teardown hazards, each pinned: drop the abort check in pump and the queued Edit
 * starts after Stop; drop `gateShut` in cancelUntaken and the queued Edit starts after the
 * round let go; keep a gate-pending call in the prefix (or drop the execute guard) and the late
 * verdict shows a card or runs the Edit; salvage only from the stream's catch and the
 * closed-after-the-stream case journals nothing; drop the salvage's drain arming and the hung
 * Bash holds the error for its whole life; settle the salvage with the previous round's usage
 * and the zero-usage case fails.
 *
 * The re-check: let go of left-out calls only after the salvage batch and the Write whose gate
 * allows inside that batch runs unjournaled; drop the salvage-failed mark and the re-issue gate
 * re-asks a round whose calls ran.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { z } from 'zod';
import type { GateResult, ToolCall, HarnessContext } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { RawToolOptions, ToolDispatchResult } from '../../tools/tool-types.js';
import { type StreamEvent, type Transport, type ProviderHistory, type ProviderStream } from '../transport.js';
import type { Journal as JournalType } from '../../kernel/index.js';
import { createRunContext } from '../run-context.js';
import { createNativeHookDispatcher } from '../native-hooks.js';
import { runOneRound, type RoundDeps, type RoundState } from '../round-engine.js';
import { createEarlyStart } from '../tool-early-start.js';
import { reissueSeveredRound } from '../severed-stream.js';
import type { NativeConfig } from '../native-config.js';

const L1 = 'TOOLS_MIDSTREAM_V1';
const RW = 'TOOLS_MIDSTREAM_RW_V1';
afterEach(() => {
  delete process.env[L1];
  delete process.env[RW];
  vi.useRealTimers();
});

// ── a scripted STREAMING transport: events, waits and failures, in order ─────────────

type Step = StreamEvent | { wait: number } | { fail: Error };
const DONE: StreamEvent = { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } };
const END_TURN: StreamEvent = { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
const ready = (id: string, name: string, input: Record<string, unknown> = { tag: id }): StreamEvent =>
  ({ kind: 'tool_ready', toolUse: { id, name, input } });
/** A call the transport closed but could not read (its arguments did not parse). */
const unreadable = (id: string, name: string): StreamEvent => ({ kind: 'tool_ready', toolUse: { id, name, input: undefined } });
const use = (id: string, name: string, input: Record<string, unknown> = { tag: id }): StreamEvent =>
  ({ kind: 'tool_use', toolUse: { id, name, input } });

function abortError(): Error {
  const err = new Error('Request was aborted.');
  err.name = 'AbortError';
  return err;
}

/** setTimeout that rejects with an AbortError the moment `signal` aborts (a real stream does). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()); }, { once: true });
  });
}

async function* play(steps: Step[], signal: AbortSignal | undefined, marks: { streamEnd?: number }): AsyncIterable<StreamEvent> {
  for (const s of steps) {
    if ('wait' in s) await sleep(s.wait, signal);
    else if ('fail' in s) throw s.fail;
    else {
      if (s.kind === 'done') marks.streamEnd = Date.now();
      yield s;
    }
  }
}

function streamingTransport(round: Step[], marks: { streamEnd?: number }): Transport {
  let served = false;
  const t: Partial<Transport> = {
    api: 'fake', provider: 'fake', defaultModel: () => 'm',
    emptyHistory: () => [] as unknown as ProviderHistory,
    pushUser: (h) => { (h as unknown[]).push({ role: 'user' }); },
    pushAssistant: (h, blocks) => { (h as unknown[]).push({ role: 'assistant', blocks }); },
    pushToolResult: (h, r) => { (h as unknown[]).push({ role: 'tool_result', r }); },
    buildTools: (raw) => raw as unknown[],
    callModel: (p) => {
      const steps = served ? [END_TURN] : round;
      served = true;
      return { steps, signal: p.signal } as unknown as ProviderStream;
    },
    readStream: (stream) => {
      const { steps, signal } = stream as { steps: Step[]; signal?: AbortSignal };
      return play(steps, signal, marks);
    },
    computeCostUsd: () => 0,
  };
  return t as Transport;
}

const allow = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };

interface Captured {
  journal: JournalType;
  appended: string[];
  results: string[];
  errors: boolean[];
  /** The `raw` of every usage entry, in append order. */
  usage: Array<{ inputTokens: number; outputTokens: number; costUsd: number }>;
}

/**
 * An append-only journal that records `type:toolUseId` in append order. `delayMs` makes every
 * append take that long (a slow disk, so a salvage batch has a window); `failOn` makes appends of
 * that payload type throw (a journal that will not take the entry).
 */
function captureJournal(opts: { delayMs?: number; failOn?: string } = {}): Captured {
  const appended: string[] = [];
  const results: string[] = [];
  const errors: boolean[] = [];
  const usage: Captured['usage'] = [];
  let seq = 0;
  const journal = {
    append: async (e: { payload: { type: string; toolUseId?: string; isError?: boolean; blocks?: Array<{ text?: string }>; raw?: Captured['usage'][number] } }) => {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (e.payload.type === opts.failOn) throw new Error(`the journal refused the ${opts.failOn} entry`);
      seq += 1;
      if (e.payload.toolUseId !== undefined) appended.push(`${e.payload.type}:${e.payload.toolUseId}`);
      if (e.payload.type === 'tool_result') {
        results.push(e.payload.blocks?.[0]?.text ?? '');
        errors.push(e.payload.isError === true);
      }
      if (e.payload.type === 'usage' && e.payload.raw) usage.push(e.payload.raw);
      return { uuid: `u${seq}`, seq } as unknown as JournalEntry;
    },
    // A call past its drain bound is sealed interrupted (round-tool-sequential).
    sealInterruptedToolUse: async (toolUseId: string) => {
      appended.push(`interrupted:${toolUseId}`);
      return {} as JournalEntry;
    },
  } as unknown as JournalType;
  return { journal, appended, results, errors, usage };
}

let runs = 0;

interface RoundRun {
  results: ToolDispatchResult[];
  events: HarnessEvent[];
  /** tool_use / tool_result blocks as `use:<id>` / `res:<id>`, in emission order. */
  blocks: string[];
  appended: string[];
  /** ms from the round's start to the `done` event (the stream's end). */
  streamEnd: number;
  /** ms from the round's start to its end. */
  wall: number;
  rc: ReturnType<typeof createRunContext>;
}

/**
 * Run ONE round on fake timers, advancing the clock until it settles. `t0` is the round's
 * start, so every time a test reads (tool starts, the stream's end) is relative to it.
 */
async function runRound(
  tools: RawToolOptions[],
  script: Step[],
  over: {
    harness?: typeof allow;
    onPause?: (call: ToolCall, kind: string) => Promise<string>;
    controller?: AbortController;
    capture?: Captured;
    t0?: number;
    drainTimeoutMs?: number;
    /** The previous round's usage, still on the state (the trio persists across rounds). */
    lastUsage?: { inputTokens: number; outputTokens: number };
    /** The consumer closes the round (gen.return()) at the first event this matches. */
    closeAt?: (ev: HarnessEvent) => boolean;
    rc?: ReturnType<typeof createRunContext>;
    st?: RoundState;
  } = {},
): Promise<RoundRun> {
  const t0 = over.t0 ?? Date.now();
  const marks: { streamEnd?: number } = {};
  const transport = streamingTransport(script, marks);
  const harness = over.harness ?? allow;
  const { journal, appended } = over.capture ?? captureJournal();
  const signal = (over.controller ?? new AbortController()).signal;
  const taskId = `l1-${++runs}`;
  const rc = over.rc ?? createRunContext(taskId);
  const deps = {
    ctx: { taskId, sessionId: 's', cwd: '', model: 'm', config: {}, signal },
    cfg: { journal, reconstructionCheck: 'off', signal, ...(over.drainTimeoutMs !== undefined && { drainTimeoutMs: over.drainTimeoutMs }) },
    transport, rc, harness, dispatcher: createNativeHookDispatcher(harness),
    tools, providerTools: [], system: 'sys', onPause: over.onPause ?? (async () => 'PAUSED'), onAuthHalt: undefined,
    requestedModel: 'm', cachePrefixHint: undefined, history: transport.emptyHistory(), turnBlocks: [], pendingTodoBlocks: [],
  } as unknown as RoundDeps;
  const st: RoundState = over.st ?? {
    assistantText: '', thinkingBlocks: [], toolUses: [], roundAppended: false, inToolBatch: false,
    stopReason: null, lastUsage: over.lastUsage ?? { inputTokens: 0, outputTokens: 0 }, lastUsageModel: 'm',
  };
  const events: HarnessEvent[] = [];
  const run = (async () => {
    const gen = runOneRound(deps, st);
    let n = await gen.next();
    while (!n.done) {
      events.push(n.value);
      if (over.closeAt?.(n.value)) {
        await gen.return(undefined as never);
        return { committedModel: 'm', roundCostUsd: 0, results: [] };
      }
      n = await gen.next();
    }
    return n.value;
  })();
  let settled = false;
  run.then(() => { settled = true; }, () => { settled = true; });
  while (!settled) await vi.advanceTimersByTimeAsync(5);
  const result = await run;
  const blocks = events
    .filter((e): e is Extract<HarnessEvent, { kind: 'block' }> => e.kind === 'block')
    .map((e) => e.block as { type: string; toolUseId?: string })
    .filter((b) => b.type === 'tool_use' || b.type === 'tool_result')
    .map((b) => `${b.type === 'tool_use' ? 'use' : 'res'}:${b.toolUseId}`);
  return {
    results: result.results, events, blocks, appended,
    streamEnd: (marks.streamEnd ?? NaN) - t0, wall: Date.now() - t0, rc,
  };
}

/** A shared tool whose call hangs until its signal aborts, then rejects. */
function hangingTool(name: string, seen: string[]): RawToolOptions {
  return {
    name, description: name, parameters: z.object({ tag: z.string() }), concurrencySafe: true,
    execute: (input, ctx) => new Promise<never>((_, reject) => {
      const tag = (input as { tag: string }).tag;
      seen.push(`start:${tag}`);
      ctx?.signal?.addEventListener('abort', () => { seen.push(`aborted:${tag}`); reject(new Error('aborted')); }, { once: true });
    }),
  };
}

const outcomeOf = (p: Promise<unknown>): Promise<unknown> => p.then(() => 'resolved', (e: unknown) => e);

/** Start and end times of every call (ms from the round's start), and what each call saw. */
interface CallLog { starts: Record<string, number>; ends: Record<string, number>; seen: string[]; t0: number }
const callLog = (): CallLog => ({ starts: {}, ends: {}, seen: [], t0: Date.now() });

/** A tool that runs `ms` and logs its start and end; shared (concurrencySafe) or exclusive. */
function timedTool(name: string, ms: number, log: CallLog, shared: boolean): RawToolOptions {
  return {
    name, description: name, parameters: z.object({ tag: z.string() }),
    ...(shared && { concurrencySafe: true }),
    execute: async (input, ctx) => {
      const tag = (input as { tag: string }).tag;
      log.starts[tag] = Date.now() - log.t0;
      log.seen.push(`start:${tag}`);
      ctx?.signal?.addEventListener('abort', () => log.seen.push(`aborted:${tag}`), { once: true });
      await new Promise((r) => setTimeout(r, ms));
      log.ends[tag] = Date.now() - log.t0;
      log.seen.push(`end:${tag}`);
      return `${name}:${tag}`;
    },
  };
}

/** An exclusive tool that hangs until its signal aborts, then rejects (a long Bash). */
function hangingExclusive(name: string, seen: string[]): RawToolOptions {
  return { ...hangingTool(name, seen), concurrencySafe: false };
}

/** A gate that answers `verdict` for `name` only after `ms` (a PreToolUse hook, the injection screen). */
const lateFor = (name: string, ms: number, verdict: GateResult) => ({
  gateTool: async (c: ToolCall): Promise<GateResult> => {
    if (c.toolName !== name) return { decision: 'allow' };
    await new Promise((r) => setTimeout(r, ms));
    return verdict;
  },
});

/** A gate that asks the person about `name` and allows everything else. */
const askingFor = (name: string) => ({
  gateTool: async (c: ToolCall): Promise<GateResult> =>
    c.toolName === name ? ({ decision: 'needs_human', interactionKind: 'tool_permission' } as GateResult) : { decision: 'allow' },
});

describe('the read/write gate: an exclusive call starts mid-stream once the calls before it settle', () => {
  it('rw: Read, then Edit, then Grep: the Edit starts when the Read ends, the Grep when the Edit ends, all before the stream does', async () => {
    vi.useFakeTimers();
    const script: Step[] = [
      { wait: 10 }, ready('r1', 'Read'), { wait: 10 }, ready('e1', 'Edit'), { wait: 10 }, ready('g1', 'Grep'),
      { wait: 270 }, use('r1', 'Read'), use('e1', 'Edit'), use('g1', 'Grep'), DONE,
    ];
    const pass = async (rw: boolean) => {
      process.env[L1] = 'true';
      if (rw) process.env[RW] = 'true';
      else delete process.env[RW];
      const log = callLog();
      const tools = [timedTool('Read', 50, log, true), timedTool('Edit', 30, log, false), timedTool('Grep', 10, log, true)];
      const r = await runRound(tools, script, { t0: log.t0 });
      return { ...r, log };
    };
    const door = await pass(false);
    const gate = await pass(true);
    expect(gate.streamEnd).toBe(300);
    // L1's door: the Edit and everything after it wait for the stream.
    expect(door.log.starts.e1).toBeGreaterThanOrEqual(300);
    expect(door.log.starts.g1).toBeGreaterThanOrEqual(300);
    // The gate: the Read at once; the Edit once the Read has ended; the Grep (shared, but behind
    // the Edit) once the Edit has ended; all while the model is still streaming.
    expect(gate.log.starts.r1).toBeLessThan(20);
    expect(gate.log.starts.e1).toBeGreaterThanOrEqual(gate.log.ends.r1!);
    expect(gate.log.starts.e1).toBeLessThan(300);
    expect(gate.log.starts.g1).toBeGreaterThanOrEqual(gate.log.ends.e1!);
    expect(gate.log.starts.g1).toBeLessThan(300);
    expect(gate.wall).toBeLessThan(door.wall);
    for (const r of [door, gate]) {
      expect(r.results.map((x) => x.text)).toEqual(['Read:r1', 'Edit:e1', 'Grep:g1']);
      expect(r.blocks).toEqual(['use:r1', 'res:r1', 'use:e1', 'res:e1', 'use:g1', 'res:g1']);
      expect(r.appended).toEqual(['tool_use:r1', 'tool_result:r1', 'tool_use:e1', 'tool_result:e1', 'tool_use:g1', 'tool_result:g1']);
    }
  });

  it('rw: a call that cannot start early (its arguments did not parse) holds back everything after an exclusive one', async () => {
    vi.useFakeTimers();
    process.env[L1] = 'true';
    process.env[RW] = 'true';
    const log = callLog();
    const r = await runRound(
      [timedTool('Edit', 10, log, false), timedTool('Read', 10, log, true)],
      [{ wait: 10 }, unreadable('e1', 'Edit'), { wait: 10 }, ready('r1', 'Read'), { wait: 80 }, use('e1', 'Edit'), use('r1', 'Read'), DONE],
      { t0: log.t0 },
    );
    expect(r.streamEnd).toBe(100);
    expect(log.starts.e1).toBeGreaterThanOrEqual(100);
    expect(log.starts.r1).toBeGreaterThanOrEqual(100);
    expect(r.results.map((x) => x.toolUseId)).toEqual(['e1', 'r1']);
  });

  it('rw: an exclusive call whose gate asks the person holds its card until its turn, and the calls behind it wait', async () => {
    vi.useFakeTimers();
    process.env[L1] = 'true';
    process.env[RW] = 'true';
    const log = callLog();
    const capture = captureJournal();
    let pausedAt = NaN;
    let journaledAtPause: string[] = [];
    const r = await runRound(
      [timedTool('Edit', 10, log, false), timedTool('Grep', 10, log, true)],
      [{ wait: 10 }, ready('e1', 'Edit'), { wait: 10 }, ready('g1', 'Grep'), { wait: 80 }, use('e1', 'Edit'), use('g1', 'Grep'), DONE],
      {
        t0: log.t0, capture, harness: askingFor('Edit'),
        onPause: async () => {
          pausedAt = Date.now() - log.t0;
          journaledAtPause = [...capture.appended];
          return 'PAUSED';
        },
      },
    );
    expect(pausedAt).toBeGreaterThanOrEqual(r.streamEnd);
    expect(journaledAtPause).toEqual(['tool_use:e1']);
    expect(log.starts.e1).toBeUndefined();
    // The Grep queued behind the asking Edit never started early.
    expect(log.starts.g1 ?? Infinity).toBeGreaterThanOrEqual(r.streamEnd);
    expect(r.results[0]?.pausedHalt).toBe(true);
  });
});

describe('the read/write gate: a round that ends before the batch journals the started prefix', () => {
  it('rw: a stream error after an Edit started: the Edit runs to its end and the Read and the Edit are journaled with real results', async () => {
    vi.useFakeTimers();
    process.env[L1] = 'true';
    process.env[RW] = 'true';
    const log = callLog();
    const capture = captureJournal();
    let run: RoundRun | undefined;
    const outcome = await outcomeOf((async () => {
      run = await runRound(
        [timedTool('Read', 20, log, true), timedTool('Edit', 200, log, false)],
        [{ wait: 10 }, ready('r1', 'Read'), { wait: 10 }, ready('e1', 'Edit'), { wait: 50 }, { fail: new Error('stream severed') }],
        { t0: log.t0, capture },
      );
    })());
    expect(run).toBeUndefined();
    expect((outcome as Error).message).toBe('stream severed');
    // The Edit started mid-stream, then the stream failed at 70 ms; it ran to its end.
    expect(log.starts.e1).toBeLessThan(70);
    expect(log.seen).toEqual(['start:r1', 'end:r1', 'start:e1', 'end:e1']);
    expect(log.ends.e1).toBeGreaterThanOrEqual(220);
    expect(capture.appended).toEqual(['tool_use:r1', 'tool_result:r1', 'tool_use:e1', 'tool_result:e1']);
    expect(capture.results).toEqual(['Read:r1', 'Edit:e1']);
  });

  it('rw: Stop after an Edit started: it gets the abort, its interrupted result is journaled, and Stop does not wait for it', async () => {
    vi.useFakeTimers();
    process.env[L1] = 'true';
    process.env[RW] = 'true';
    const seen: string[] = [];
    const capture = captureJournal();
    const controller = new AbortController();
    const t0 = Date.now();
    setTimeout(() => controller.abort(), 50);
    let endedAt = NaN;
    const outcome = await outcomeOf(
      runRound([hangingExclusive('Bash', seen)], [{ wait: 10 }, ready('b1', 'Bash'), { wait: 10_000 }, use('b1', 'Bash'), DONE], { controller, capture, t0 })
        .finally(() => { endedAt = Date.now() - t0; }),
    );
    expect((outcome as Error).name).toBe('AbortError');
    expect(seen).toEqual(['start:b1', 'aborted:b1']);
    expect(capture.appended).toEqual(['tool_use:b1', 'tool_result:b1']);
    expect(capture.errors).toEqual([true]);
    // The Bash would never end on its own: Stop came back with the abort, not after a drain.
    expect(endedAt).toBeLessThan(1_000);
  });

  it('rw: a held card is cancelled and its call never runs, on a stream error and on Stop', async () => {
    vi.useFakeTimers();
    process.env[L1] = 'true';
    process.env[RW] = 'true';
    for (const how of ['error', 'stop'] as const) {
      const log = callLog();
      const capture = captureJournal();
      const controller = new AbortController();
      if (how === 'stop') setTimeout(() => controller.abort(), 50);
      let asked = 0;
      const script: Step[] = how === 'error'
        ? [{ wait: 10 }, ready('e1', 'Edit'), { wait: 50 }, { fail: new Error('stream severed') }]
        : [{ wait: 10 }, ready('e1', 'Edit'), { wait: 10_000 }, use('e1', 'Edit'), DONE];
      const outcome = await outcomeOf(runRound([timedTool('Edit', 10, log, false)], script, {
        t0: log.t0, capture, controller, harness: askingFor('Edit'), onPause: async () => { asked++; return 'PAUSED'; },
      }));
      expect(outcome, how).toBeInstanceOf(Error);
      expect(asked, how).toBe(0);
      expect(log.seen, how).toEqual([]);
      expect(capture.appended, how).toEqual([]);
    }
  });

  it('rw: a reads-only prefix is still cancelled when the stream fails, exactly as under L1', async () => {
    vi.useFakeTimers();
    process.env[L1] = 'true';
    process.env[RW] = 'true';
    const seen: string[] = [];
    const capture = captureJournal();
    const outcome = await outcomeOf(runRound(
      [hangingTool('Read', seen)],
      [{ wait: 10 }, ready('r1', 'Read'), { wait: 50 }, { fail: new Error('stream severed') }],
      { capture },
    ));
    expect((outcome as Error).message).toBe('stream severed');
    expect(seen).toEqual(['start:r1', 'aborted:r1']);
    expect(capture.appended).toEqual([]);
  });
});

describe('the read/write gate: the teardown hazards (the #4265 review)', () => {
  it('rw: Stop while a Read hangs and an Edit queues behind it: the Edit never starts, nothing is journaled for it', async () => {
    vi.useFakeTimers();
    process.env[L1] = 'true';
    process.env[RW] = 'true';
    const log = callLog();
    const capture = captureJournal();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const outcome = await outcomeOf(runRound(
      [hangingTool('Read', log.seen), timedTool('Edit', 10, log, false)],
      [{ wait: 10 }, ready('r1', 'Read'), { wait: 10 }, ready('e1', 'Edit'), { wait: 10_000 }, use('r1', 'Read'), use('e1', 'Edit'), DONE],
      { t0: log.t0, capture, controller },
    ));
    expect((outcome as Error).name).toBe('AbortError');
    // The Read settles on the abort, which used to let the queued Edit start after Stop.
    expect(log.seen).toEqual(['start:r1', 'aborted:r1']);
    expect(log.starts.e1).toBeUndefined();
    expect(capture.appended.filter((a) => a.endsWith(':e1'))).toEqual([]);
  });

  it('rw: cancelUntaken shuts the gate: a cancelled Read settling never starts the Edit queued behind it', async () => {
    vi.useFakeTimers();
    process.env[L1] = 'true';
    process.env[RW] = 'true';
    const log = callLog();
    const tools = [hangingTool('Read', log.seen), timedTool('Edit', 10, log, false)];
    const signal = new AbortController().signal;
    const harness = allow;
    const early = createEarlyStart({
      ctx: { taskId: 'cancel', sessionId: 's', cwd: '', model: 'm', config: {}, signal },
      cfg: { reconstructionCheck: 'off', signal },
      transport: streamingTransport([], {}), rc: createRunContext('cancel'), harness, dispatcher: createNativeHookDispatcher(harness),
      tools, providerTools: [], system: 'sys', onPause: async () => 'PAUSED', onAuthHalt: undefined,
      requestedModel: 'm', cachePrefixHint: undefined, history: [], turnBlocks: [], pendingTodoBlocks: [],
    } as unknown as RoundDeps)!;
    early.offer({ id: 'r1', name: 'Read', input: { tag: 'r1' } });
    early.offer({ id: 'e1', name: 'Edit', input: { tag: 'e1' } });
    await vi.advanceTimersByTimeAsync(10);
    expect(log.seen).toEqual(['start:r1']);
    early.cancelUntaken();
    await vi.advanceTimersByTimeAsync(100);
    expect(log.seen).toEqual(['start:r1', 'aborted:r1']);
    expect(log.starts.e1).toBeUndefined();
  });

  it('rw: a gate still deciding when the stream fails: a late ask shows no card, a late allow never runs the Edit', async () => {
    vi.useFakeTimers();
    process.env[L1] = 'true';
    process.env[RW] = 'true';
    const verdicts: GateResult[] = [
      { decision: 'needs_human', interactionKind: 'tool_permission' } as GateResult,
      { decision: 'allow' },
    ];
    for (const verdict of verdicts) {
      const log = callLog();
      const capture = captureJournal();
      let asked = 0;
      const outcome = await outcomeOf(runRound([timedTool('Edit', 10, log, false)],
        [{ wait: 10 }, ready('e1', 'Edit'), { wait: 20 }, { fail: new Error('stream severed') }],
        { t0: log.t0, capture, harness: lateFor('Edit', 120, verdict), onPause: async () => { asked++; return 'PAUSED'; } },
      ));
      // Let the gate answer, 100 ms after the stream failed.
      await vi.advanceTimersByTimeAsync(200);
      expect((outcome as Error).message, verdict.decision).toBe('stream severed');
      expect(asked, verdict.decision).toBe(0);
      expect(log.starts.e1, verdict.decision).toBeUndefined();
      expect(capture.appended, verdict.decision).toEqual([]);
    }
  });

  it('rw: the round is closed after its stream ended but before its batch: the Edit that ran early is still journaled', async () => {
    vi.useFakeTimers();
    process.env[L1] = 'true';
    process.env[RW] = 'true';
    const log = callLog();
    const capture = captureJournal();
    await runRound(
      [timedTool('Edit', 10, log, false)],
      [{ wait: 10 }, ready('e1', 'Edit'), { wait: 50 }, use('e1', 'Edit'), DONE],
      // The consumer stops at the round's usage event: after the stream, before the batch.
      { t0: log.t0, capture, closeAt: (ev) => ev.kind === 'usage' },
    );
    expect(log.seen).toEqual(['start:e1', 'end:e1']);
    expect(capture.appended).toEqual(['tool_use:e1', 'tool_result:e1']);
    expect(capture.results).toEqual(['Edit:e1']);
  });

  it('rw: a stream error with a Bash that never ends: the error comes back within the drain bound, the Bash told to stop', async () => {
    vi.useFakeTimers();
    process.env[L1] = 'true';
    process.env[RW] = 'true';
    const seen: string[] = [];
    const capture = captureJournal();
    const t0 = Date.now();
    let endedAt = NaN;
    const outcome = await outcomeOf(
      runRound([hangingExclusive('Bash', seen)], [{ wait: 10 }, ready('b1', 'Bash'), { wait: 40 }, { fail: new Error('stream severed') }],
        { capture, t0, drainTimeoutMs: 300 })
        .finally(() => { endedAt = Date.now() - t0; }),
    );
    expect((outcome as Error).message).toBe('stream severed');
    // Failed at 50 ms; the drain bound runs from the salvage, so the error is back by ~350 ms.
    expect(endedAt).toBeGreaterThanOrEqual(340);
    expect(endedAt).toBeLessThan(500);
    expect(seen).toEqual(['start:b1', 'aborted:b1']);
    expect(capture.appended).toEqual(['tool_use:b1', 'interrupted:b1']);
  });

  it('rw: the salvaged round journals zero usage (not the previous round\'s) and gets its own round number', async () => {
    vi.useFakeTimers();
    process.env[L1] = 'true';
    process.env[RW] = 'true';
    const log = callLog();
    const capture = captureJournal();
    const rc = createRunContext('zero-usage');
    rc.billing.roundCounter.value = 7;
    const outcome = await outcomeOf(runRound(
      [timedTool('Edit', 10, log, false)],
      [{ wait: 10 }, ready('e1', 'Edit'), { wait: 50 }, { fail: new Error('stream severed') }],
      { t0: log.t0, capture, rc, lastUsage: { inputTokens: 40_000, outputTokens: 1_000 } },
    ));
    expect((outcome as Error).message).toBe('stream severed');
    expect(capture.usage).toEqual([expect.objectContaining({ costUsd: 0, inputTokens: 0, outputTokens: 0 })]);
    // Never read as the provider's count of this request.
    expect(rc.lastRoundInput).toBeNull();
    // Round 7 was the last that settled; the salvaged batch is filed as round 8.
    expect(rc.billing.roundCounter.value).toBe(8);
    expect(capture.appended).toEqual(['tool_use:e1', 'tool_result:e1']);
  });
});

describe('the read/write gate: the re-check (R1, R2)', () => {
  it('rw: a call left out of the prefix is let go before the salvage batch: its gate allowing during the batch never runs it', async () => {
    vi.useFakeTimers();
    process.env[L1] = 'true';
    process.env[RW] = 'true';
    const log = callLog();
    // A slow journal: the salvage batch journaling the Edit takes 100+ ms, a window for the Write's gate.
    const capture = captureJournal({ delayMs: 50 });
    const outcome = await outcomeOf(runRound(
      [timedTool('Edit', 10, log, false), timedTool('Write', 10, log, false)],
      [{ wait: 10 }, ready('e1', 'Edit'), { wait: 15 }, ready('w1', 'Write'), { wait: 15 }, { fail: new Error('stream severed') }],
      // The Write's gate answers allow 40 ms after it starts: after the stream failed, inside the batch.
      { t0: log.t0, capture, harness: lateFor('Write', 40, { decision: 'allow' }) },
    ));
    await vi.advanceTimersByTimeAsync(200);
    expect((outcome as Error).message).toBe('stream severed');
    expect(log.seen).toEqual(['start:e1', 'end:e1']);
    expect(log.starts.w1).toBeUndefined();
    expect(capture.appended).toEqual(['tool_use:e1', 'tool_result:e1']);
  });

  it('rw: a salvage the journal would not take marks the round, and the severed-stream re-issue refuses it', async () => {
    vi.useFakeTimers();
    process.env[L1] = 'true';
    process.env[RW] = 'true';
    const log = callLog();
    const st: RoundState = {
      assistantText: '', thinkingBlocks: [], toolUses: [], roundAppended: false, inToolBatch: false,
      stopReason: null, lastUsage: { inputTokens: 0, outputTokens: 0 }, lastUsageModel: 'm',
    };
    const outcome = await outcomeOf(runRound(
      [timedTool('Edit', 10, log, false)],
      [{ wait: 10 }, { kind: 'text', text: 'Editing.' }, ready('e1', 'Edit'), { wait: 50 }, { fail: new Error('stream severed') }],
      { t0: log.t0, st, capture: captureJournal({ failOn: 'assistant' }) },
    ));
    expect((outcome as Error).message).toBe('stream severed');
    expect(st.salvageFailed).toBe(true);
    vi.useRealTimers();

    // The re-issue gate, with everything else in its favour: refused while the mark stands.
    process.env.NATIVE_STREAM_SEVERED_RETRY = 'true';
    try {
      const transport = {
        classifyError: () => ({ kind: 'network_error', message: 'severed', raw: {} }),
        pushAssistant: () => {}, pushUser: () => {},
      } as unknown as Transport;
      const cfg = { retry: { backoffMs: 1 } } as unknown as NativeConfig;
      const ctx = {} as HarnessContext<NativeConfig>;
      const ask = () => reissueSeveredRound(new Error('severed'), cfg, ctx, transport, st, [], [] as unknown as ProviderHistory, { reissues: 0 }, null);
      expect((await ask()).reissue).toBe(false);
      delete st.salvageFailed;
      expect((await ask()).reissue).toBe(true);
    } finally {
      delete process.env.NATIVE_STREAM_SEVERED_RETRY;
    }
  });
});
