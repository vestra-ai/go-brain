/**
 * W3-3 — the PARENT loop's runaway guard (bounded progress on iterateTurn).
 *
 * RED pin (pre-guard): the 2026-08-20 Researcher livelock class on the MAIN
 * loop — a tool that always fails with identical args spun the parent turn for
 * the full maxTurns budget (~5 calls/sec live) with no trip, no steer, no end.
 * subagent-watchdog.ts (PR #2743) covered only the NESTED loops.
 *
 * With the guard: trip at exactly SUBAGENT_RUNAWAY_IDENTICAL_LIMIT consecutive
 * identical failures, the terminal directive lands ONCE as a user-role journal
 * entry at the settle boundary, every post-trip gate is REFUSED with the same
 * terminal text (never executed), and after SUBAGENT_RUNAWAY_GRACE_ROUNDS
 * post-directive rounds the turn FORCE-COMPLETES with its partial output
 * through the NORMAL turn-end path (classifier → `completed`), never a hard
 * kill. Identical SUCCESSES never trip (polling is legitimate) and any success
 * resets the windows — a normal long task is byte-identical.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import {
  SUBAGENT_RUNAWAY_IDENTICAL_LIMIT,
  SUBAGENT_RUNAWAY_GRACE_ROUNDS,
  SUBAGENT_RUNAWAY_DIRECTIVE,
} from '../subagent-watchdog.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { NativeConfig } from '../native-config.js';
import type { ToolHost } from '../../ports/tool-host-port.js';
import type { RawToolOptions, OnAuthHalt } from '../../tools/tool-types.js';

const N = SUBAGENT_RUNAWAY_IDENTICAL_LIMIT;
const GRACE = SUBAGENT_RUNAWAY_GRACE_ROUNDS;

afterEach(() => {
  vi.restoreAllMocks();
});

class ScriptTransport extends FakeTransport {
  calls = 0;
  constructor(private readonly rounds: StreamEvent[][]) {
    super([]);
  }
  override callModel(): StreamEvent[] {
    const r = this.rounds[Math.min(this.calls, this.rounds.length - 1)];
    this.calls += 1;
    return r as StreamEvent[];
  }
  override computeCostUsd(_u: NormalizedUsage): number {
    return 0.0001;
  }
}

const usage: NormalizedUsage = { inputTokens: 1, outputTokens: 1 };

/** One model round: a single tool_use of `name` with the given args (fresh id per round, as live). */
function toolRound(id: string, name: string, input: unknown, leadText?: string): StreamEvent[] {
  return [
    ...(leadText ? [{ kind: 'text', text: leadText } as StreamEvent] : []),
    { kind: 'tool_use', toolUse: { id, name, input } } as StreamEvent,
    { kind: 'done', stopReason: 'tool_use', usage } as StreamEvent,
  ];
}

function textRound(text: string): StreamEvent[] {
  return [
    { kind: 'text', text } as StreamEvent,
    { kind: 'done', stopReason: 'end_turn', usage } as StreamEvent,
  ];
}

function toolHostOf(tools: RawToolOptions[]): ToolHost {
  return {
    async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
      return { tools, onAuthHalt: async () => {} };
    },
  };
}

function makeJournal(taskId: string): Journal {
  const path = join(tmpdir(), `runaway-${process.pid}-${Math.random().toString(36).slice(2)}`, `${taskId}.jsonl`);
  return new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(path),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2024-01-01T00:00:00.000Z'),
  });
}

async function runTurn(opts: {
  taskId: string;
  journal: Journal;
  rounds: StreamEvent[][];
  tools: RawToolOptions[];
  maxTurns?: number;
  /** User turns to drive, in order (default: one). */
  turns?: UserTurn[];
}): Promise<{ events: HarnessEvent[]; entries: JournalEntry[]; transport: ScriptTransport; harness: NativeHarness }> {
  const transport = new ScriptTransport(opts.rounds);
  const cfg = {
    onAttached: () => {},
    maxTurns: opts.maxTurns ?? 30,
    transport,
    toolHost: toolHostOf(opts.tools),
    journal: opts.journal,
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = {
    taskId: opts.taskId,
    sessionId: 's-runaway',
    cwd: '/tmp',
    model: 'fake-model',
    signal: new AbortController().signal,
    config: cfg,
  };
  const turns = opts.turns ?? [{ text: 'go' }];
  const input = (async function* (): AsyncIterable<UserTurn> {
    for (const t of turns) yield t;
  })();
  const events: HarnessEvent[] = [];
  const harness = new NativeHarness();
  for await (const ev of harness.run(input, ctx)) events.push(ev);
  const entries: JournalEntry[] = [];
  for await (const e of opts.journal.read()) entries.push(e);
  return { events, entries, transport, harness };
}

/** A tool that always throws — the dispatcher maps the throw to isError:true. */
function failingTool(name: string): { tool: RawToolOptions; executions: () => number } {
  let n = 0;
  return {
    tool: {
      name,
      description: 'probe',
      parameters: z.object({ q: z.string() }),
      execute: async () => {
        n += 1;
        throw new Error('vendor says 402: payment required');
      },
    },
    executions: () => n,
  };
}

/** The directive is the loop speaking, and must say so at the mint — the
 *  injection screen reads the field, not the sentence. */
const expectMintedEngine = (entries: JournalEntry[]): void => {
  expect(entries.length).toBeGreaterThan(0);
  for (const e of entries) expect((e.payload as { injected?: string }).injected).toBe('engine');
};

const directiveUserEntries = (entries: JournalEntry[]): JournalEntry[] =>
  entries.filter(
    (e) =>
      e.payload.type === 'user' &&
      e.payload.blocks.some((b) => b.type === 'text' && b.text === SUBAGENT_RUNAWAY_DIRECTIVE),
  );

const terminalTurnEnd = (events: HarnessEvent[]): Extract<HarnessEvent, { kind: 'turn_end' }> => {
  const ends = events.filter((e): e is Extract<HarnessEvent, { kind: 'turn_end' }> => e.kind === 'turn_end');
  expect(ends.length).toBe(1);
  return ends[0]!;
};

describe('parent runaway guard — always-failing identical call', () => {
  it(`trips at ${N} identical failures, steers once, denies grace calls, force-completes through the normal turn-end`, async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { tool, executions } = failingTool('web_probe');
    // 14 scripted tool rounds (clamped-repeat past the end): the guard, not the
    // script and not maxTurns, must be what stops the loop.
    const rounds = Array.from({ length: 14 }, (_, k) =>
      toolRound(`t${k}`, 'web_probe', { q: 'probe' }, k === 0 ? 'Partial findings so far.' : undefined),
    );
    const { events, entries, transport } = await runTurn({
      taskId: 'task-runaway-1',
      journal: makeJournal('task-runaway-1'),
      rounds,
      tools: [tool],
      maxTurns: 30,
    });

    // The failing operation executed EXACTLY N times — never again after the trip.
    expect(executions()).toBe(N);
    // Force-complete within grace: trip round + exactly GRACE post-directive rounds.
    expect(transport.calls).toBe(N + GRACE);

    // The terminal directive landed EXACTLY ONCE as a user-role journal entry.
    expect(directiveUserEntries(entries).length).toBe(1);
    expectMintedEngine(directiveUserEntries(entries));

    // Post-trip tool calls were REFUSED with the terminal directive text (never executed).
    const denials = entries.filter(
      (e) =>
        e.payload.type === 'tool_result' &&
        e.payload.isError === true &&
        e.payload.blocks.some((b) => b.type === 'text' && b.text === SUBAGENT_RUNAWAY_DIRECTIVE),
    );
    expect(denials.length).toBe(GRACE);

    // One structured WARN at the trip, on the parent's line.
    const warnLines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('runaway'));
    expect(warnLines.length).toBe(1);
    expect(warnLines[0]).toContain('tool=web_probe');
    expect(warnLines[0]).toContain('taskId=task-runaway-1');

    // The turn ended through the NORMAL turn-end path: one terminal turn_end,
    // outcome COMPLETED (never max_turns, never a hard kill), carrying the
    // partial output, with the tool_use stopReason coerced away.
    const end = terminalTurnEnd(events);
    expect(end.outcome.kind).toBe('completed');
    const completed = end.outcome as Extract<typeof end.outcome, { kind: 'completed' }>;
    expect(completed.summary).toContain('Partial findings so far.');
    expect(completed.numTurns).toBe(N + GRACE);
    expect((end as { paused?: boolean }).paused).toBeUndefined();
    expect(end.stopReason).not.toBe('tool_use');
  });

  it('identical SUCCESSFUL polling never trips — a normal long task is untouched', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let n = 0;
    const poll: RawToolOptions = {
      name: 'poll_status',
      description: 'poll',
      parameters: z.object({ job: z.string() }),
      execute: async () => {
        n += 1;
        return `pending (check ${n})`;
      },
    };
    const spins = N + 4;
    const rounds = [
      ...Array.from({ length: spins }, (_, k) => toolRound(`p${k}`, 'poll_status', { job: 'j1' })),
      textRound('All done.'),
    ];
    const { events, entries, transport } = await runTurn({
      taskId: 'task-runaway-2',
      journal: makeJournal('task-runaway-2'),
      rounds,
      tools: [poll],
      maxTurns: 40,
    });
    expect(n).toBe(spins); // every poll executed — no refusals
    expect(transport.calls).toBe(spins + 1);
    expect(directiveUserEntries(entries).length).toBe(0);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('runaway')).length).toBe(0);
    const end = terminalTurnEnd(events);
    expect(end.outcome.kind).toBe('completed');
    expect((end.outcome as { summary?: string }).summary).toBe('All done.');
  });

  it('the trip latch dies with the turn — turn 2 on the SAME instance executes tools normally', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { tool, executions } = failingTool('web_probe');
    let polls = 0;
    const poll: RawToolOptions = {
      name: 'poll_status',
      description: 'poll',
      parameters: z.object({ job: z.string() }),
      execute: async () => {
        polls += 1;
        return 'pending';
      },
    };
    // Turn 1: the trip script (10 rounds — 8 failing + 2 denied grace).
    // Turn 2 (same instance): one poll round that MUST execute, then text.
    const rounds = [
      ...Array.from({ length: 10 }, (_, k) => toolRound(`t${k}`, 'web_probe', { q: 'probe' })),
      toolRound('p0', 'poll_status', { job: 'j1' }),
      textRound('Second turn done.'),
    ];
    const { events, entries } = await runTurn({
      taskId: 'task-runaway-4',
      journal: makeJournal('task-runaway-4'),
      rounds,
      tools: [tool, poll],
      maxTurns: 30,
      turns: [{ text: 'go' }, { text: 'and now poll the job' }],
    });
    expect(executions()).toBe(N); // turn 1 tripped as usual
    expect(polls).toBe(1); // turn 2's tool RAN — the latch did not survive the turn
    // Exactly the GRACE denials from turn 1 carry the directive — none in turn 2.
    const denials = entries.filter(
      (e) =>
        e.payload.type === 'tool_result' &&
        e.payload.isError === true &&
        e.payload.blocks.some((b) => b.type === 'text' && b.text === SUBAGENT_RUNAWAY_DIRECTIVE),
    );
    expect(denials.length).toBe(GRACE);
    // One trip WARN total (turn 1's); turn 2 never tripped.
    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('runaway')).length).toBe(1);
    const ends = events.filter((e): e is Extract<HarnessEvent, { kind: 'turn_end' }> => e.kind === 'turn_end');
    expect(ends.length).toBe(2);
    expect(ends[1]!.outcome.kind).toBe('completed');
    expect((ends[1]!.outcome as { summary?: string }).summary).toBe('Second turn done.');
  });

  it('a post-turn gate on the SAME instance is not denied (the continue-path materialize shape)', async () => {
    // materializeReExecute (continue-interaction.ts) pre-gates an APPROVED
    // interaction through harness.gateTool BEFORE the next drive turn, on the
    // same NativeHarness instance — a stale trip latch would refuse the
    // approved action with the runaway text. Gating directly after run()
    // settles is that call's exact shape.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { tool } = failingTool('web_probe');
    const rounds = Array.from({ length: 14 }, (_, k) => toolRound(`t${k}`, 'web_probe', { q: 'probe' }));
    const { harness } = await runTurn({
      taskId: 'task-runaway-5',
      journal: makeJournal('task-runaway-5'),
      rounds,
      tools: [tool],
      maxTurns: 30,
    });
    const gate = await harness.gateTool({ toolName: 'web_probe', toolInput: { q: 'probe' }, toolCallId: 'post-run' });
    expect(gate.decision).not.toBe('deny');
  });

  it('a success resets the window — 7 identical failures, a success, 7 more: no trip', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let n = 0;
    const flaky: RawToolOptions = {
      name: 'web_probe',
      description: 'probe',
      parameters: z.object({ q: z.string() }),
      execute: async (input) => {
        n += 1;
        if ((input as { q: string }).q === 'ok') return 'fine';
        throw new Error('still failing');
      },
    };
    const rounds = [
      ...Array.from({ length: N - 1 }, (_, k) => toolRound(`a${k}`, 'web_probe', { q: 'x' })),
      toolRound('mid', 'web_probe', { q: 'ok' }),
      ...Array.from({ length: N - 1 }, (_, k) => toolRound(`b${k}`, 'web_probe', { q: 'x' })),
      textRound('wrapped up'),
    ];
    const { events, entries } = await runTurn({
      taskId: 'task-runaway-3',
      journal: makeJournal('task-runaway-3'),
      rounds,
      tools: [flaky],
      maxTurns: 40,
    });
    expect(n).toBe(2 * (N - 1) + 1); // every call executed — no refusals
    expect(directiveUserEntries(entries).length).toBe(0);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('runaway')).length).toBe(0);
    const end = terminalTurnEnd(events);
    expect(end.outcome.kind).toBe('completed');
    expect((end.outcome as { summary?: string }).summary).toBe('wrapped up');
  });
});
