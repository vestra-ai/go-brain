/**
 * L1 (TOOLS_MIDSTREAM_V1) — tools start while the model is still streaming.
 *
 * Each transport emits `tool_ready` the moment one call's arguments are complete
 * (transports/__tests__/tool-ready.test.ts pins all five); the round's early starts
 * (engine/tool-early-start.ts) start a call then when it would have started first anyway,
 * and the batch takes it over in its turn. These tests drive real rounds through a scripted
 * streaming transport on fake timers, so "before the stream ended" is a measured time.
 *
 * Revert proof: with the early starts removed (or the flag off), the first call starts only
 * after the stream ends, and 'a two-tool round' fails on `on.starts.r1 < 20`; without the held
 * pause, 'a call that needs approval' fails on the pause landing before its tool_use entry;
 * without the cancel, 'a stream that fails' fails on the started call never seeing its abort.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GateResult, HarnessContext, ToolCall, UserTurn } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { RawToolOptions, OnAuthHalt, ToolDispatchResult } from '../../tools/tool-types.js';
import type { ToolHost } from '../../ports/tool-host-port.js';
import type { NativeConfig } from '../native-config.js';
import { FakeTransport, type StreamEvent, type Transport, type ProviderHistory, type ProviderStream } from '../transport.js';
import type { Journal as JournalType } from '../../kernel/index.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import { NativeHarness } from '../native-harness.js';
import { createRunContext } from '../run-context.js';
import { createNativeHookDispatcher } from '../native-hooks.js';
import { runOneRound, type RoundDeps, type RoundState } from '../round-engine.js';
import { createEarlyStart } from '../tool-early-start.js';
import { toolsMidstreamEnabled } from '../../policy/feature-flags.js';

const FLAG = 'TOOLS_MIDSTREAM_V1';
afterEach(() => {
  delete process.env[FLAG];
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

/** An append-only journal that records `type:toolUseId` in append order. */
function captureJournal(): { journal: JournalType; appended: string[] } {
  const appended: string[] = [];
  const journal = {
    append: async (e: { payload: { type: string; toolUseId?: string } }) => {
      if (e.payload.toolUseId !== undefined) appended.push(`${e.payload.type}:${e.payload.toolUseId}`);
      return { uuid: `u${appended.length}` } as unknown as JournalEntry;
    },
  } as unknown as JournalType;
  return { journal, appended };
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
    capture?: ReturnType<typeof captureJournal>;
    t0?: number;
  } = {},
): Promise<RoundRun> {
  const t0 = over.t0 ?? Date.now();
  const marks: { streamEnd?: number } = {};
  const transport = streamingTransport(script, marks);
  const harness = over.harness ?? allow;
  const { journal, appended } = over.capture ?? captureJournal();
  const signal = (over.controller ?? new AbortController()).signal;
  const taskId = `l1-${++runs}`;
  const deps = {
    ctx: { taskId, sessionId: 's', cwd: '', model: 'm', config: {}, signal },
    cfg: { journal, reconstructionCheck: 'off', signal },
    transport, rc: createRunContext(taskId), harness, dispatcher: createNativeHookDispatcher(harness),
    tools, providerTools: [], system: 'sys', onPause: over.onPause ?? (async () => 'PAUSED'), onAuthHalt: undefined,
    requestedModel: 'm', cachePrefixHint: undefined, history: transport.emptyHistory(), turnBlocks: [], pendingTodoBlocks: [],
  } as unknown as RoundDeps;
  const st: RoundState = {
    assistantText: '', thinkingBlocks: [], toolUses: [], roundAppended: false, inToolBatch: false,
    stopReason: null, lastUsage: { inputTokens: 0, outputTokens: 0 }, lastUsageModel: 'm',
  };
  const events: HarnessEvent[] = [];
  const run = (async () => {
    const gen = runOneRound(deps, st);
    let n = await gen.next();
    while (!n.done) { events.push(n.value); n = await gen.next(); }
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
    streamEnd: (marks.streamEnd ?? NaN) - t0, wall: Date.now() - t0,
  };
}

/** A shared (concurrencySafe) tool that logs when each call starts and how it ends. */
function sharedTool(name: string, ms: number, log: { starts: Record<string, number>; seen: string[]; t0: () => number }): RawToolOptions {
  return {
    name, description: name, parameters: z.object({ tag: z.string() }), concurrencySafe: true,
    execute: async (input, ctx) => {
      const tag = (input as { tag: string }).tag;
      log.starts[tag] = Date.now() - log.t0();
      log.seen.push(`start:${tag}`);
      ctx?.signal?.addEventListener('abort', () => log.seen.push(`aborted:${tag}`), { once: true });
      ctx?.pushEvent?.({ kind: 'raw', engine: 'native', event: 'probe', data: { tag } });
      await new Promise((r) => setTimeout(r, ms));
      return `${name}:${tag}`;
    },
  };
}

function toolLog(): { starts: Record<string, number>; seen: string[]; t0: () => number; reset: () => number } {
  let t0 = Date.now();
  return { starts: {}, seen: [], t0: () => t0, reset: () => (t0 = Date.now()) };
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

// ── the round ────────────────────────────────────────────────────────────────

describe('tools mid-stream: a real round', () => {
  it('midstream: a two-tool round starts the first call while the model streams the second; results stay in call order', async () => {
    vi.useFakeTimers();
    // The model closes the Read at 10 ms, spends 200 ms streaming the Grep's arguments,
    // closes it at 210 ms and ends the stream at 220 ms. The Read is the slow one.
    const script: Step[] = [
      { wait: 10 }, ready('r1', 'Read'),
      { wait: 200 }, ready('g1', 'Grep'),
      { wait: 10 }, use('r1', 'Read'), use('g1', 'Grep'), DONE,
    ];
    const pass = async () => {
      const log = toolLog();
      const t0 = log.reset();
      const r = await runRound([sharedTool('Read', 300, log), sharedTool('Grep', 10, log)], script, { t0 });
      return { ...r, starts: log.starts };
    };
    const off = await pass();
    process.env[FLAG] = 'true';
    const on = await pass();
    console.info(
      `[L1] time to first tool: flag off ${off.starts.r1} ms, flag on ${on.starts.r1} ms ` +
      `(the stream ends at ${on.streamEnd} ms); round wall time: flag off ${off.wall} ms, flag on ${on.wall} ms`,
    );

    // Off: nothing starts before the stream ends (the tool_ready events are ignored).
    expect(off.streamEnd).toBe(220);
    expect(off.starts.r1).toBeGreaterThanOrEqual(220);
    expect(off.starts.g1).toBeGreaterThanOrEqual(220);
    // On: each call starts the moment it is ready, while the stream is still going…
    expect(on.streamEnd).toBe(220);
    expect(on.starts.r1).toBeLessThan(20);
    expect(on.starts.g1).toBeGreaterThanOrEqual(210);
    expect(on.starts.g1).toBeLessThan(220);
    // …so the round ends about 200 ms sooner.
    expect(on.wall).toBeLessThan(off.wall - 150);

    for (const r of [off, on]) {
      // The Grep finished first; results, blocks and the journal are still in CALL order.
      expect(r.results.map((x) => x.text)).toEqual(['Read:r1', 'Grep:g1']);
      expect(r.blocks).toEqual(['use:r1', 'use:g1', 'res:r1', 'res:g1']);
      expect(r.appended).toEqual(['tool_use:r1', 'tool_use:g1', 'tool_result:r1', 'tool_result:g1']);
    }
    // The live event the Read pushed while the model streamed waited for the Read's block.
    const at = (pred: (e: HarnessEvent) => boolean) => on.events.findIndex(pred);
    const useR1 = at((e) => e.kind === 'block' && (e.block as { type: string; toolUseId?: string }).type === 'tool_use'
      && (e.block as { toolUseId?: string }).toolUseId === 'r1');
    const probeR1 = at((e) => e.kind === 'raw' && e.event === 'probe' && (e.data as { tag: string }).tag === 'r1');
    const resR1 = at((e) => e.kind === 'block' && (e.block as { type: string; toolUseId?: string }).type === 'tool_result'
      && (e.block as { toolUseId?: string }).toolUseId === 'r1');
    expect(useR1).toBeGreaterThanOrEqual(0);
    expect(probeR1).toBeGreaterThan(useR1);
    expect(resR1).toBeGreaterThan(probeR1);
  });

  it('midstream: abort mid-stream cancels the call it started, and nothing is journaled for it', async () => {
    vi.useFakeTimers();
    process.env[FLAG] = 'true';
    const seen: string[] = [];
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const capture = captureJournal();
    const outcome = await outcomeOf(runRound(
      [hangingTool('Read', seen)],
      [{ wait: 10 }, ready('r1', 'Read'), { wait: 1_000 }, use('r1', 'Read'), DONE],
      { controller, capture },
    ));
    expect((outcome as Error).name).toBe('AbortError');
    expect(seen).toEqual(['start:r1', 'aborted:r1']);
    expect(capture.appended).toEqual([]);
  });

  it('midstream: a stream that fails after a call started cancels that call', async () => {
    vi.useFakeTimers();
    process.env[FLAG] = 'true';
    const seen: string[] = [];
    const capture = captureJournal();
    const outcome = await outcomeOf(runRound(
      [hangingTool('Read', seen)],
      [{ wait: 10 }, ready('r1', 'Read'), { wait: 50 }, { fail: new Error('stream severed') }],
      { capture },
    ));
    expect((outcome as Error).message).toBe('stream severed');
    // The turn's own signal never aborted: only the round's cancel can have reached the call.
    expect(seen).toEqual(['start:r1', 'aborted:r1']);
    expect(capture.appended).toEqual([]);
  });

  it('midstream: a later call whose arguments did not parse never runs (no ready, and its schema refuses the torn input)', async () => {
    vi.useFakeTimers();
    process.env[FLAG] = 'true';
    const log = toolLog();
    const t0 = log.reset();
    // The Grep's arguments were torn: its transport sent no tool_ready, and its tool_use
    // carries the `{}` every accumulator degrades a torn call to.
    const r = await runRound(
      [sharedTool('Read', 30, log), sharedTool('Grep', 10, log)],
      [{ wait: 10 }, ready('r1', 'Read'), { wait: 100 }, use('r1', 'Read'), use('g1', 'Grep', {}), DONE],
      { t0 },
    );
    expect(log.starts.r1).toBeLessThan(r.streamEnd);
    expect(log.seen).toEqual(['start:r1']);
    expect(r.results.map((x) => [x.toolUseId, x.isError])).toEqual([['r1', false], ['g1', true]]);
  });

  it('midstream: a call that needs approval holds its pause until its turn, after its tool_use is journaled', async () => {
    vi.useFakeTimers();
    process.env[FLAG] = 'true';
    const log = toolLog();
    const t0 = log.reset();
    const gatedAt: number[] = [];
    const asking = {
      gateTool: async (_c: ToolCall): Promise<GateResult> => {
        gatedAt.push(Date.now() - t0);
        return { decision: 'needs_human', interactionKind: 'tool_permission' } as GateResult;
      },
    };
    const capture = captureJournal();
    let pausedAt = NaN;
    let journaledAtPause: string[] = [];
    const r = await runRound(
      [sharedTool('Read', 10, log)],
      [{ wait: 10 }, ready('r1', 'Read'), { wait: 100 }, use('r1', 'Read'), DONE],
      {
        t0, capture, harness: asking,
        onPause: async () => {
          pausedAt = Date.now() - t0;
          journaledAtPause = [...capture.appended];
          return 'PAUSED';
        },
      },
    );
    // The gate decided while the model streamed; the card waited for the call's turn.
    expect(gatedAt).toEqual([10]);
    expect(pausedAt).toBeGreaterThanOrEqual(r.streamEnd);
    expect(journaledAtPause).toEqual(['tool_use:r1']);
    // Nothing ran before (or without) the approval, and the paused call stays unanswered.
    expect(log.seen).toEqual([]);
    expect(r.results.map((x) => [x.toolUseId, x.pausedHalt === true])).toEqual([['r1', true]]);
    expect(capture.appended).toEqual(['tool_use:r1']);
  });

  it('midstream: a denied call never runs, and its deny lands after its block', async () => {
    vi.useFakeTimers();
    process.env[FLAG] = 'true';
    const log = toolLog();
    const t0 = log.reset();
    const denying = { gateTool: async (): Promise<GateResult> => ({ decision: 'deny', message: 'Not allowed.' }) };
    const r = await runRound(
      [sharedTool('Read', 10, log)],
      [{ wait: 10 }, ready('r1', 'Read'), { wait: 100 }, use('r1', 'Read'), DONE],
      { t0, harness: denying },
    );
    expect(log.seen).toEqual([]);
    expect(r.results.map((x) => [x.toolUseId, x.isError, x.text])).toEqual([['r1', true, 'Not allowed.']]);
    const kinds = r.events
      .filter((e) => (e.kind === 'block' && (e.block as { type: string }).type.startsWith('tool_')) || (e.kind === 'raw' && e.event === 'permission:denied'))
      .map((e) => (e.kind === 'raw' ? 'denied' : ((e as Extract<HarnessEvent, { kind: 'block' }>).block as { type: string }).type));
    expect(kinds).toEqual(['tool_use', 'denied', 'tool_result']);
  });

  it('midstream: the first exclusive call shuts the door; it and everything after it wait for the stream and run in order', async () => {
    vi.useFakeTimers();
    process.env[FLAG] = 'true';
    const log = toolLog();
    const t0 = log.reset();
    const edit: RawToolOptions = {
      name: 'Edit', description: 'Edit', parameters: z.object({ tag: z.string() }),
      execute: async (input) => {
        const tag = (input as { tag: string }).tag;
        log.starts[tag] = Date.now() - t0;
        log.seen.push(`start:${tag}`);
        return `Edit:${tag}`;
      },
    };
    const r = await runRound(
      [sharedTool('Read', 50, log), edit, sharedTool('Grep', 10, log)],
      [
        { wait: 10 }, ready('r1', 'Read'), { wait: 10 }, ready('e1', 'Edit'), { wait: 10 }, ready('g1', 'Grep'),
        { wait: 70 }, use('r1', 'Read'), use('e1', 'Edit'), use('g1', 'Grep'), DONE,
      ],
      { t0 },
    );
    expect(r.streamEnd).toBe(100);
    expect(log.starts.r1).toBe(10);
    expect(log.starts.e1).toBeGreaterThanOrEqual(100);
    expect(log.starts.g1).toBeGreaterThanOrEqual(100);
    expect(log.seen).toEqual(['start:r1', 'start:e1', 'start:g1']);
    expect(r.results.map((x) => x.text)).toEqual(['Read:r1', 'Edit:e1', 'Grep:g1']);
    expect(r.blocks).toEqual(['use:r1', 'res:r1', 'use:e1', 'res:e1', 'use:g1', 'res:g1']);
  });

  it('midstream: an Agent spawn never starts early, and a read the partition overlaps with it still does', async () => {
    vi.useFakeTimers();
    process.env[FLAG] = 'true';
    const log = toolLog();
    const t0 = log.reset();
    const agent: RawToolOptions = {
      name: 'Agent', description: 'a', parameters: z.object({ tag: z.string() }),
      execute: async (input) => {
        const tag = (input as { tag: string }).tag;
        log.starts[tag] = Date.now() - t0;
        return `agent:${tag}`;
      },
    };
    const r = await runRound(
      [agent, sharedTool('Read', 10, log)],
      [{ wait: 10 }, ready('a1', 'Agent'), { wait: 10 }, ready('r1', 'Read'), { wait: 80 }, use('a1', 'Agent'), use('r1', 'Read'), DONE],
      { t0 },
    );
    expect(log.starts.a1).toBeGreaterThanOrEqual(r.streamEnd);
    expect(log.starts.r1).toBe(20);
    expect(r.results.map((x) => x.text)).toEqual(['agent:a1', 'Read:r1']);
  });

  it('midstream: a different call under the ready id is not the one that started; it runs fresh with the final input', async () => {
    vi.useFakeTimers();
    process.env[FLAG] = 'true';
    const log = toolLog();
    const t0 = log.reset();
    const r = await runRound(
      [sharedTool('Read', 50, log)],
      [{ wait: 10 }, ready('r1', 'Read', { tag: 'early' }), { wait: 20 }, use('r1', 'Read', { tag: 'final' }), DONE],
      { t0 },
    );
    expect(log.seen).toEqual(['start:early', 'aborted:early', 'start:final']);
    expect(r.results.map((x) => x.text)).toEqual(['Read:final']);
  });

  it('midstream: the mismatch is said out loud (a warning naming the call)', async () => {
    vi.useFakeTimers();
    process.env[FLAG] = 'true';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = toolLog();
    const t0 = log.reset();
    await runRound(
      [sharedTool('Read', 50, log)],
      [{ wait: 10 }, ready('r1', 'Read', { tag: 'early' }), { wait: 20 }, use('r1', 'Read', { tag: 'final' }), DONE],
      { t0 },
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[tool-early-start] Read r1: the stream\'s final call differs'));
    warn.mockRestore();
  });

  it('midstream: an unreadable exclusive call still shuts the door: the read after it waits for the stream', async () => {
    vi.useFakeTimers();
    process.env[FLAG] = 'true';
    const log = toolLog();
    const t0 = log.reset();
    const edit: RawToolOptions = {
      name: 'Edit', description: 'Edit', parameters: z.object({ tag: z.string() }),
      execute: async () => { log.seen.push('start:e1'); return 'Edit:e1'; },
    };
    const r = await runRound(
      [edit, sharedTool('Read', 10, log)],
      // The Edit's arguments were torn: closed, unreadable. The Read after it is fine.
      [{ wait: 10 }, unreadable('e1', 'Edit'), { wait: 10 }, ready('r1', 'Read'), { wait: 80 }, use('e1', 'Edit', {}), use('r1', 'Read'), DONE],
      { t0 },
    );
    expect(r.streamEnd).toBe(100);
    // Without the report the Read would have started at 20 ms, ahead of the Edit it must follow.
    expect(log.starts.r1).toBeGreaterThanOrEqual(100);
    // The torn Edit never ran (its schema refuses the {} it degraded to); the Read ran after it.
    expect(log.seen).toEqual(['start:r1']);
    expect(r.results.map((x) => [x.toolUseId, x.isError])).toEqual([['e1', true], ['r1', false]]);
  });

  it('midstream: an unreadable shared call never starts early, and the door stays open behind it', async () => {
    vi.useFakeTimers();
    process.env[FLAG] = 'true';
    const log = toolLog();
    const t0 = log.reset();
    const r = await runRound(
      [sharedTool('Read', 10, log), sharedTool('Grep', 10, log)],
      [{ wait: 10 }, unreadable('r1', 'Read'), { wait: 10 }, ready('g1', 'Grep'), { wait: 80 }, use('r1', 'Read', {}), use('g1', 'Grep'), DONE],
      { t0 },
    );
    // The partition overlaps the two reads, so the readable Grep may go at once.
    expect(log.starts.g1).toBe(20);
    expect(log.seen).toEqual(['start:g1']);
    expect(r.results.map((x) => [x.toolUseId, x.isError])).toEqual([['r1', true], ['g1', false]]);
  });
});

describe('tools mid-stream: who may start early', () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    ctx: { taskId: 'gate', sessionId: 's', model: 'm' }, cfg: {}, rc: createRunContext('gate'),
    tools: [], harness: allow, onPause: async () => 'P', onAuthHalt: undefined, ...over,
  }) as unknown as RoundDeps;

  it('midstream off: no early starts at all', () => {
    expect(toolsMidstreamEnabled()).toBe(false);
    expect(createEarlyStart(deps())).toBeUndefined();
  });

  it('midstream: never on a subagent round, never once the turn\'s media settled', () => {
    process.env[FLAG] = 'true';
    expect(createEarlyStart(deps())).toBeDefined();
    expect(createEarlyStart(deps({ sub: { foldRoundCost: () => {}, persistRound: async () => {}, execCtx: {} } }))).toBeUndefined();
    const settled = createRunContext('gate');
    settled.mediaTurnSettled = true;
    expect(createEarlyStart(deps({ cfg: { mediaTurnSettle: true }, rc: settled }))).toBeUndefined();
    // The lock only counts while its flag is on.
    expect(createEarlyStart(deps({ rc: settled }))).toBeDefined();
  });
});

// ── the whole turn: an interrupt while a started call runs ───────────────────

class StreamingScript extends FakeTransport {
  private served = false;
  constructor(private readonly round: Step[]) { super([]); }
  override callModel(p: { signal?: AbortSignal }): StreamEvent[] {
    const steps = this.served ? [END_TURN] : this.round;
    this.served = true;
    return { steps, signal: p.signal } as unknown as StreamEvent[];
  }
  override readStream(stream: unknown): AsyncIterable<StreamEvent> {
    const { steps, signal } = stream as { steps: Step[]; signal?: AbortSignal };
    return play(steps, signal, {});
  }
}

describe('tools mid-stream: an interrupt mid-stream, the whole turn', () => {
  it('midstream: the started call sees the abort, the turn ends user_aborted, and no tool_use is left unanswered', async () => {
    vi.useFakeTimers();
    process.env[FLAG] = 'true';
    const seen: string[] = [];
    const read = hangingTool('Read', seen);
    const toolHost: ToolHost = {
      async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
        return { tools: [read], onAuthHalt: async () => {} };
      },
    };
    const transport = new StreamingScript([{ wait: 10 }, ready('r1', 'Read'), { wait: 60_000 }, use('r1', 'Read'), DONE]);
    const journal = new Journal({
      taskId: 't-l1-abort', workspaceId: 'w',
      jsonl: new JsonlStore(join(tmpdir(), `l1-abort-${process.pid}-${Math.random().toString(36).slice(2)}`, 't.jsonl')),
      mirror: new InMemorySessionStore(), clock: sequentialClock('2024-01-01T00:00:00.000Z'),
    });
    const controller = new AbortController();
    const ctx: HarnessContext<NativeConfig> = {
      taskId: 't-l1-abort', sessionId: 's', cwd: '/tmp', model: 'fake-model', signal: controller.signal,
      config: { onAttached: () => {}, maxTurns: 10, transport, toolHost, journal, signal: controller.signal } as unknown as NativeConfig,
    };
    const events: HarnessEvent[] = [];
    const done = (async () => {
      const input = (async function* (): AsyncIterable<UserTurn> { yield { text: 'read one thing' } as UserTurn; })();
      for await (const ev of new NativeHarness().run(input, ctx)) events.push(ev);
    })();
    // The model has closed the call and is still streaming (for a minute) when the person stops.
    while (seen.length === 0) await vi.advanceTimersByTimeAsync(5);
    controller.abort();
    let finished = false;
    void done.then(() => { finished = true; }, () => { finished = true; });
    while (!finished) await vi.advanceTimersByTimeAsync(50);
    await done;

    expect(seen).toEqual(['start:r1', 'aborted:r1']);
    const ends = events.filter((e): e is Extract<HarnessEvent, { kind: 'turn_end' }> => e.kind === 'turn_end');
    expect(ends.map((e) => e.outcome.kind)).toEqual(['user_aborted']);
    const entries: JournalEntry[] = [];
    for await (const e of journal.read()) entries.push(e);
    // The call never reached the batch, so it was never journaled: nothing to seal.
    expect(entries.filter((e) => e.payload.type === 'tool_use')).toEqual([]);
    expect(entries.filter((e) => e.payload.type === 'tool_result')).toEqual([]);
  });
});
