/**
 * L5 — the turn budget is the turn's owner inside the real loop, and it changes nothing.
 *
 *  · A tool that works for three hours is never cut: the budget carries no clock, so the
 *    turn runs to its own end and the model is called again after the work (the founder
 *    law; #3447's wall deadline was dropped).
 *  · Stop on the budget's root ends the turn EXACTLY as Stop on a plain controller did:
 *    same events, same outcome, same exit reason (the drain rail seals the hung tool).
 *  · Every terminal reports once to end(); the counters mirror the loop; a warm turn
 *    resets them.
 *
 * Scaffold: a scripted transport, real tmp journals, fake timers (the drain grace and
 * the three hours advance instantly). The journal's file I/O stays REAL, so a drive that
 * needs both is walked by `settle` (below), which yields to the real event loop between
 * fake-clock steps.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeHarness } from '../native-harness.js';
import { createTurnBudget, type TurnBudget } from '../turn-budget.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { NativeConfig } from '../native-config.js';
import type { ToolHost } from '../../ports/tool-host-port.js';
import type { RawToolOptions, OnAuthHalt, ToolExecuteContext } from '../../tools/tool-types.js';
import { TOOL_PROGRESS_WINDOW_MS } from '../tool-progress-watch.js';

const THREE_HOURS = 3 * 60 * 60_000;
const USAGE = { inputTokens: 10, outputTokens: 5 } as NormalizedUsage;

const toolRound = (id: string, name: string): StreamEvent[] => [
  { kind: 'tool_use', toolUse: { id, name, input: {} } },
  { kind: 'done', stopReason: 'tool_use', usage: USAGE },
];
const textRound = (text: string): StreamEvent[] => [
  { kind: 'text', text },
  { kind: 'done', stopReason: 'end_turn', usage: USAGE },
];

/** Serves scripted rounds in order (the round after the last repeats it). */
class ScriptTransport extends FakeTransport {
  private idx = 0;
  modelCalls = 0;
  constructor(private readonly rounds: StreamEvent[][]) { super([]); }
  override callModel(): StreamEvent[] {
    this.modelCalls += 1;
    const round = this.rounds[Math.min(this.idx, this.rounds.length - 1)];
    this.idx += 1;
    return round;
  }
}

/** One tool. `workMs` = it resolves after that long; undefined = it never resolves and ignores its signal. */
function toolHostWith(name: string, workMs?: number): { toolHost: ToolHost; toolEntered: Promise<void> } {
  let markEntered!: () => void;
  const toolEntered = new Promise<void>((resolve) => { markEntered = resolve; });
  const toolHost: ToolHost = {
    async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
      const tool: RawToolOptions = {
        name,
        description: workMs === undefined ? 'never resolves' : 'works for a long time, then answers',
        parameters: { type: 'object', properties: {}, additionalProperties: true },
        execute: () => {
          markEntered();
          if (workMs === undefined) return new Promise<never>(() => {});
          return new Promise((resolve) => setTimeout(() => resolve('build finished'), workMs));
        },
      };
      return { tools: [tool], onAuthHalt: async () => {} };
    },
  };
  return { toolHost, toolEntered };
}

function makeJournal(taskId: string): Journal {
  const path = join(tmpdir(), `turn-budget-${process.pid}-${Math.random().toString(36).slice(2)}`, `${taskId}.jsonl`);
  return new Journal({
    taskId, workspaceId: 'w', jsonl: new JsonlStore(path), mirror: new InMemorySessionStore(),
    clock: sequentialClock('2024-01-01T00:00:00.000Z'),
  });
}

/** The context the driver builds: the root signal on ctx and cfg; the budget on cfg when minted. */
function buildCtx(opts: {
  taskId: string; transport: FakeTransport; toolHost: ToolHost; root: AbortController; budget?: TurnBudget;
}): HarnessContext<NativeConfig> {
  const cfg = {
    onAttached: () => {},
    maxTurns: 10,
    transport: opts.transport,
    toolHost: opts.toolHost,
    journal: makeJournal(opts.taskId),
    signal: opts.root.signal,
    ...(opts.budget ? { budget: opts.budget } : {}),
  } as unknown as NativeConfig;
  return { taskId: opts.taskId, sessionId: 's-budget', cwd: '/tmp', model: 'fake-model', signal: opts.root.signal, config: cfg };
}

function turns(...texts: string[]): AsyncIterable<UserTurn> {
  return (async function* () { for (const text of texts) yield { text } as UserTurn; })();
}

/**
 * The REAL setTimeout, captured at module load: before `beforeEach` installs the fake
 * timers (which patch the global and node:timers alike). `settle` yields through it.
 */
const realSetTimeout = globalThis.setTimeout;
const realPause = (): Promise<void> => new Promise((resolve) => { realSetTimeout(resolve, 1); });

const SETTLE_STEP_MS = 10;
const SETTLE_MAX_STEPS = 3_000;

/**
 * Walk a drive to its end under fake timers. A drive waits on two clocks: fake timers (the
 * tool's work, the loop's own) and REAL file I/O (the journal). Each step advances the fake
 * clock a little, then yields one real millisecond so any finished I/O lands before the next
 * step, however slow the machine is. The loop this replaces advanced 200 fake steps with no
 * real yield between them: under coverage the journal writes landed after the last step,
 * the drive then waited on a fake timer nobody advanced, and the test hung (#4078).
 * Bounded: past `maxSteps` it fails with a clear error instead of hanging.
 */
async function settle(p: Promise<void>, label: string, maxSteps = SETTLE_MAX_STEPS): Promise<void> {
  if (globalThis.setTimeout === realSetTimeout) {
    throw new Error('settle: install fake timers first (the real setTimeout is captured at module load, before them)');
  }
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  for (let step = 0; step < maxSteps && !settled; step++) {
    await vi.advanceTimersByTimeAsync(SETTLE_STEP_MS);
    if (!settled) await realPause();
  }
  if (!settled) {
    throw new Error(
      `settle(${label}): the drive did not finish after ${maxSteps} steps ` +
        `(${(maxSteps * SETTLE_STEP_MS) / 1000} s of fake time, at least ${maxSteps} ms of real time); ` +
        `${vi.getTimerCount()} fake timer(s) pending`,
    );
  }
  await p;
}

/**
 * A test that settles gets a ceiling above settle's own bound (two drives of at most
 * SETTLE_MAX_STEPS real milliseconds each, slower under coverage), so a drive that never
 * finishes fails with settle's error, not a bare timeout.
 */
const SETTLE_TIMEOUT_MS = 60_000;

/** Both drives of a comparison start on the same instant, so event timestamps line up. */
const T0 = new Date('2026-09-30T00:00:00.000Z');

/**
 * The events with their clock readings dropped. The settle loop advances fake time in steps
 * while real journal I/O interleaves, so how much fake time a drive takes (and so WHEN each
 * stamp lands) is not the loop's behaviour. These are every clock reading the engine stamps
 * on these events: the tool's start and end, the turn's duration, and the round's time to
 * first token and whole call (`Date.now()` deltas, round-engine.ts). Everything else (every frame, field,
 * outcome, reason and cost) is compared.
 */
const TIMING = new Set(['startTime', 'endTime', 'durationMs', 'ttftMs', 'latencyMs', 'firstTextMs', 'beforeSendMs', 'afterSendMs']);
const untimed = (events: HarnessEvent[]): unknown =>
  JSON.parse(JSON.stringify(events), (k, v) => (TIMING.has(k) ? undefined : v));

type TurnEnd = Extract<HarnessEvent, { kind: 'turn_end' }>;
const turnEnds = (events: HarnessEvent[]): TurnEnd[] => events.filter((e): e is TurnEnd => e.kind === 'turn_end');

describe('NativeHarness × TurnBudget — the owner changes nothing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a tool that works for three hours is never cut: the model is called again after it, the turn completes', async () => {
    const budget = createTurnBudget({ maxRounds: 10 });
    const { toolHost, toolEntered } = toolHostWith('Bash', THREE_HOURS);
    const transport = new ScriptTransport([toolRound('tu-build', 'Bash'), textRound('the build passed')]);
    const ctx = buildCtx({ taskId: 't-long', transport, toolHost, root: budget.controller, budget });

    const events: HarnessEvent[] = [];
    const done = (async () => { for await (const ev of new NativeHarness().run(turns('run the build'), ctx)) events.push(ev); })();
    await toolEntered;
    // Two hours, fifty-nine minutes and fifty-nine seconds in: still working, nothing aborted.
    await vi.advanceTimersByTimeAsync(THREE_HOURS - 1_000);
    // Mutation: re-add a wall deadline under three hours → the root is aborted here.
    expect(budget.signal.aborted).toBe(false);
    expect(budget.ended).toBeNull();
    expect(turnEnds(events)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await done;

    const ends = turnEnds(events);
    expect(ends).toHaveLength(1);
    expect(ends[0].outcome.kind).toBe('completed');
    // The second round head ran three hours after the first. Mutation: a time check read at
    // the round head (no timer at all) with any limit under three hours → the turn ends
    // there and the model is called once.
    expect(transport.modelCalls).toBe(2);
    expect(budget.signal.aborted).toBe(false);
    expect(budget.rounds).toBe(2);
    expect(budget.ended).toBe('completed');
  });

  it('Stop on the budget root ends a hung tool exactly as Stop on a plain controller did: same events, same exit', async () => {
    const drive = async (withBudget: boolean): Promise<{ events: HarnessEvent[]; budget?: TurnBudget }> => {
      vi.setSystemTime(T0);
      const budget = withBudget ? createTurnBudget({ maxRounds: 10 }) : undefined;
      const root = budget?.controller ?? new AbortController();
      const { toolHost, toolEntered } = toolHostWith('Bash');
      const transport = new ScriptTransport([toolRound('tu-hang', 'Bash')]);
      const ctx = buildCtx({ taskId: 't-stop', transport, toolHost, root, ...(budget ? { budget } : {}) });
      const events: HarnessEvent[] = [];
      const done = (async () => { for await (const ev of new NativeHarness().run(turns('run a tool'), ctx)) events.push(ev); })();
      await toolEntered;
      root.abort(); // the person's Stop, through the registered run controller
      await vi.advanceTimersByTimeAsync(5_000); // the drain grace seals the hung tool
      await done;
      return { events, ...(budget ? { budget } : {}) };
    };
    const plain = await drive(false);
    const owned = await drive(true);

    // Mutation: any behaviour the budget adds to the abort path shows up as a diff here.
    expect(untimed(owned.events)).toEqual(untimed(plain.events));
    const ends = turnEnds(owned.events);
    expect(ends).toHaveLength(1);
    expect(ends[0].outcome.kind).toBe('user_aborted');
    expect(ends[0].exitReason).toBe(turnEnds(plain.events)[0].exitReason);
    // The Stop is recorded once: a named exit when the loop names one, else the outcome's kind.
    expect(owned.budget?.ended).toBe('user_aborted');
  });

  it('a completed turn yields the same events with or without an owner', async () => {
    const drive = async (budget?: TurnBudget): Promise<HarnessEvent[]> => {
      vi.setSystemTime(T0);
      const root = budget?.controller ?? new AbortController();
      const transport = new ScriptTransport([toolRound('tu-1', 'Bash'), textRound('done')]);
      const ctx = buildCtx({ taskId: 't-same', transport, toolHost: toolHostWith('Bash', 10).toolHost, root, ...(budget ? { budget } : {}) });
      const events: HarnessEvent[] = [];
      await settle((async () => { for await (const ev of new NativeHarness().run(turns('go'), ctx)) events.push(ev); })(), budget ? 'owned' : 'plain');
      return events;
    };
    const budget = createTurnBudget({ maxSpendUsd: 100, maxRounds: 10 });
    // Mutation: the owner leaks into an event (a field, a reason, an extra frame) → not equal.
    expect(untimed(await drive(budget))).toEqual(untimed(await drive()));
    expect(budget.ended).toBe('completed');
    expect(budget.rounds).toBe(2);
  }, SETTLE_TIMEOUT_MS);

  it('a warm run: each user turn resets the counters and ends once, on its own reason', async () => {
    const budget = createTurnBudget({ maxRounds: 10 });
    const reasons: string[] = [];
    budget.onEnd((r) => reasons.push(r));
    const transport = new ScriptTransport([textRound('one'), textRound('two')]);
    const ctx = buildCtx({ taskId: 't-warm', transport, toolHost: toolHostWith('unused', 1).toolHost, root: budget.controller, budget });
    const events: HarnessEvent[] = [];
    for await (const ev of new NativeHarness().run(turns('first', 'second'), ctx)) events.push(ev);

    expect(turnEnds(events)).toHaveLength(2);
    // Mutation: drop beginTurn() at the turn head → the second end() is a no-op (one reason) and rounds read 2.
    expect(reasons).toEqual(['completed', 'completed']);
    expect(budget.rounds).toBe(1);
  });
});

/** Tools as given; `entered` resolves when the first execute starts. */
function toolHostOf(tools: RawToolOptions[]): { toolHost: ToolHost; entered: Promise<void> } {
  let mark!: () => void;
  const entered = new Promise<void>((resolve) => { mark = resolve; });
  const wrapped = tools.map((t) => ({ ...t, execute: (a: unknown, c: ToolExecuteContext) => { mark(); return t.execute(a, c); } }));
  return { toolHost: { async buildTools() { return { tools: wrapped, onAuthHalt: async () => {} }; } }, entered };
}
const tool = (name: string, execute: RawToolOptions['execute']): RawToolOptions =>
  ({ name, description: name, parameters: { type: 'object', properties: {}, additionalProperties: true }, execute });

describe('TOOL_PROGRESS_WATCHDOG_V1 in the real loop: only proven non-progress cuts, and only that tool', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  const run = (ctx: HarnessContext<NativeConfig>, events: HarnessEvent[]): Promise<void> =>
    (async () => { for await (const ev of new NativeHarness().run(turns('go'), ctx)) events.push(ev); })();

  it('true: a hung tool is sealed after the window, its sibling runs, the model is called again, the turn completes', async () => {
    vi.stubEnv('TOOL_PROGRESS_WATCHDOG_V1', 'true');
    const budget = createTurnBudget({ maxRounds: 10 });
    const { toolHost, entered } = toolHostOf([
      tool('Hang', () => new Promise<never>(() => {})), // ignores its signal, never settles
      tool('Quick', async () => 'quick done'),
    ]);
    const transport = new ScriptTransport([[
      { kind: 'tool_use', toolUse: { id: 'tu-hang', name: 'Hang', input: {} } },
      { kind: 'tool_use', toolUse: { id: 'tu-quick', name: 'Quick', input: {} } },
      { kind: 'done', stopReason: 'tool_use', usage: USAGE },
    ], textRound('moved on')]);
    const ctx = buildCtx({ taskId: 't-cut', transport, toolHost, root: budget.controller, budget });
    const events: HarnessEvent[] = [];
    const done = run(ctx, events);
    await entered;
    await vi.advanceTimersByTimeAsync(TOOL_PROGRESS_WINDOW_MS);
    await settle(done, 'cut');

    const ends = turnEnds(events);
    expect(ends).toHaveLength(1);
    // Mutation: end the turn on the cut (abort the root, or a terminal) → not completed, one model call.
    expect(ends[0].outcome.kind).toBe('completed');
    expect(transport.modelCalls).toBe(2);
    expect(budget.signal.aborted).toBe(false);
    const wire = JSON.stringify(events);
    expect(wire).toContain('Hang stopped: no progress for 20 minutes');
    expect(wire).toContain('quick done');
    expect(wire).not.toContain('Quick stopped');
    expect(console.warn).toHaveBeenCalledWith('[tool-watchdog] cut Hang after 20 min without progress task=t-cut');
  }, SETTLE_TIMEOUT_MS);

  it('true: a tool that streams every minute for three hours is never cut', async () => {
    vi.stubEnv('TOOL_PROGRESS_WATCHDOG_V1', 'true');
    const { toolHost, entered } = toolHostOf([tool('Bash', (_a, c) => new Promise((resolve) => {
      const tick = setInterval(() => c?.pushEvent?.({ kind: 'raw', engine: 'native', event: 'agent:tool_progress', data: {} }), 60_000);
      setTimeout(() => { clearInterval(tick); resolve('build finished'); }, THREE_HOURS);
    }))]);
    const transport = new ScriptTransport([toolRound('tu-b', 'Bash'), textRound('the build passed')]);
    const budget = createTurnBudget({ maxRounds: 10 });
    const events: HarnessEvent[] = [];
    const done = run(buildCtx({ taskId: 't-stream', transport, toolHost, root: budget.controller, budget }), events);
    await entered;
    await vi.advanceTimersByTimeAsync(THREE_HOURS);
    await settle(done, 'stream');
    expect(turnEnds(events)[0].outcome.kind).toBe('completed');
    expect(JSON.stringify(events)).toContain('build finished');
    expect(JSON.stringify(events)).not.toContain('stopped: no progress');
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('[tool-watchdog]'));
  }, SETTLE_TIMEOUT_MS);

  it('true: a foreground Agent whose child keeps running (billed) rounds for two hours is never cut', async () => {
    vi.stubEnv('TOOL_PROGRESS_WATCHDOG_V1', 'true');
    const { toolHost, entered } = toolHostOf([tool('Agent', (_a, c) => new Promise((resolve) => {
      const round = setInterval(() => c?.addCostUsd?.(0.001), 5 * 60_000); // one child round billed
      setTimeout(() => { clearInterval(round); resolve('child report'); }, 2 * 60 * 60_000);
    }))]);
    const transport = new ScriptTransport([toolRound('tu-a', 'Agent'), textRound('used the report')]);
    const budget = createTurnBudget({ maxRounds: 10 });
    const events: HarnessEvent[] = [];
    const done = run(buildCtx({ taskId: 't-agent', transport, toolHost, root: budget.controller, budget }), events);
    await entered;
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    await settle(done, 'agent');
    expect(transport.modelCalls).toBe(2);
    expect(JSON.stringify(events)).toContain('child report');
    expect(JSON.stringify(events)).not.toContain('stopped: no progress');
  }, SETTLE_TIMEOUT_MS);

  it('off, unset and shadow yield the same events for a turn that never goes quiet', async () => {
    const drive = async (raw: string | undefined): Promise<HarnessEvent[]> => {
      vi.unstubAllEnvs();
      if (raw !== undefined) vi.stubEnv('TOOL_PROGRESS_WATCHDOG_V1', raw);
      vi.setSystemTime(T0);
      const transport = new ScriptTransport([toolRound('tu-1', 'Bash'), textRound('done')]);
      const ctx = buildCtx({ taskId: 't-same', transport, toolHost: toolHostWith('Bash', 10).toolHost, root: new AbortController() });
      const events: HarnessEvent[] = [];
      await settle(run(ctx, events), raw ?? 'unset');
      return events;
    };
    const unset = untimed(await drive(undefined));
    // Mutation: any field, frame or reason the watch adds to a turn → not equal.
    expect(untimed(await drive('off'))).toEqual(unset);
    expect(untimed(await drive('shadow'))).toEqual(unset);
  }, SETTLE_TIMEOUT_MS);

  it('Stop under true ends a hung tool exactly as Stop with the flag off: same events, same exit', async () => {
    const drive = async (raw: string | undefined): Promise<HarnessEvent[]> => {
      vi.unstubAllEnvs();
      if (raw !== undefined) vi.stubEnv('TOOL_PROGRESS_WATCHDOG_V1', raw);
      vi.setSystemTime(T0);
      const root = new AbortController();
      const { toolHost, toolEntered } = toolHostWith('Bash');
      const ctx = buildCtx({ taskId: 't-stop2', transport: new ScriptTransport([toolRound('tu-hang', 'Bash')]), toolHost, root });
      const events: HarnessEvent[] = [];
      const done = run(ctx, events);
      await toolEntered;
      root.abort(); // the person's Stop
      await vi.advanceTimersByTimeAsync(5_000); // the drain grace seals the hung tool, as today
      await done;
      return events;
    };
    const off = await drive(undefined);
    const on = await drive('true');
    expect(untimed(on)).toEqual(untimed(off));
    expect(turnEnds(on)[0].outcome.kind).toBe('user_aborted');
  }, SETTLE_TIMEOUT_MS);
});

describe('settle — the drive walker cannot hang', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('outlasts real I/O that lands after hundreds of steps, then advances the fake timer behind it', async () => {
    // The coverage-run shape (#4078): the drive's real I/O lands late (here 300 real ms,
    // far more than the old loop's 200 steps took), THEN the drive waits on a fake timer.
    // Mutation: drop the real pause between steps → the steps run out before the I/O
    // lands, nobody advances the fake timer, and this test times out.
    let finished = false;
    const drive = (async () => {
      await new Promise<void>((resolve) => { realSetTimeout(resolve, 300); });
      await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
      finished = true;
    })();
    await settle(drive, 'late I/O');
    expect(finished).toBe(true);
  }, SETTLE_TIMEOUT_MS);

  it('fails with a clear error, never a hang, when the drive never finishes', async () => {
    // Mutation: drop the bound → this test times out instead of reading the error.
    await expect(settle(new Promise<void>(() => {}), 'stuck', 25)).rejects.toThrow(
      /settle\(stuck\): the drive did not finish after 25 steps/,
    );
  });

  it('carries a failed drive\'s own error, not a timeout', async () => {
    await expect(settle(Promise.reject(new Error('boom')), 'failing')).rejects.toThrow('boom');
  });
});
