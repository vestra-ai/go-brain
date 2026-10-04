/**
 * Follow-up B item 2 — the wrap-up nudge on the MAIN loop, for a caller-supplied cap.
 *
 * A background helper is not run through runSubagentLoop: it is a teammate-rail actor with
 * a main loop of its own, so follow-up A's per-type cap and its 75% nudge never reached it.
 * On staging task c7612bfd a background researcher ran sixty rounds with nothing in its
 * journal telling it to write anything down, and no cap to stop it.
 *
 * The hard cap is `maxTurns`, which the loop already enforces and already finalizes as
 * max_turns. What was missing is the SOFT half: a caller that sets a cap can now say where
 * the wrap-up lands, and the loop pushes the same directive the subagent loop pushes, ONCE,
 * as a user-side entry at a round boundary. It STEERS: nothing is refused, so the child
 * still has turns to write its report in. Absent (every lead and every teammate) nothing is
 * ever pushed.
 */
import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import { TURN_CAP_DIRECTIVE } from '../subagent-walls.js';
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

const usage: NormalizedUsage = { inputTokens: 1, outputTokens: 1 };

class ScriptTransport extends FakeTransport {
  calls = 0;
  constructor(private readonly rounds: StreamEvent[][]) { super([]); }
  override callModel(): StreamEvent[] {
    const r = this.rounds[Math.min(this.calls, this.rounds.length - 1)];
    this.calls += 1;
    return r as StreamEvent[];
  }
  override computeCostUsd(_u: NormalizedUsage): number { return 0; }
}

/** One searching round. Distinct args every time, so the runaway watchdog never trips. */
const searchRound = (k: number): StreamEvent[] => [
  { kind: 'tool_use', toolUse: { id: `s${k}`, name: 'search', input: { q: `q${k}` } } } as StreamEvent,
  { kind: 'done', stopReason: 'tool_use', usage } as StreamEvent,
];

function makeJournal(taskId: string): Journal {
  const path = join(tmpdir(), `wrapup-${process.pid}-${Math.random().toString(36).slice(2)}`, `${taskId}.jsonl`);
  return new Journal({
    taskId, workspaceId: 'w',
    jsonl: new JsonlStore(path),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2024-01-01T00:00:00.000Z'),
  });
}

function searchTool(): { tool: RawToolOptions; runs: () => number } {
  let n = 0;
  return {
    tool: {
      name: 'search', description: 'search', parameters: z.object({ q: z.string() }),
      execute: async () => { n += 1; return 'results'; },
    },
    runs: () => n,
  };
}

async function runTurns(opts: {
  taskId: string;
  maxTurns: number;
  turnWrapUpAt?: number;
  rounds: StreamEvent[][];
  tool: RawToolOptions;
  turns?: UserTurn[];
}): Promise<{ events: HarnessEvent[]; entries: JournalEntry[]; transport: ScriptTransport }> {
  const transport = new ScriptTransport(opts.rounds);
  const journal = makeJournal(opts.taskId);
  const toolHost: ToolHost = {
    async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
      return { tools: [opts.tool], onAuthHalt: async () => {} };
    },
  };
  const cfg = {
    onAttached: () => {},
    maxTurns: opts.maxTurns,
    ...(opts.turnWrapUpAt !== undefined ? { turnWrapUpAt: opts.turnWrapUpAt } : {}),
    transport, toolHost, journal,
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = {
    taskId: opts.taskId, sessionId: 's-wrapup', cwd: '/tmp', model: 'fake-model',
    signal: new AbortController().signal, config: cfg,
  };
  const turns = opts.turns ?? [{ text: 'find everything' }];
  const input = (async function* (): AsyncIterable<UserTurn> { for (const t of turns) yield t; })();
  const events: HarnessEvent[] = [];
  for await (const ev of new NativeHarness().run(input, ctx)) events.push(ev);
  const entries: JournalEntry[] = [];
  for await (const e of journal.read()) entries.push(e);
  return { events, entries, transport };
}

const wrapUpEntries = (entries: JournalEntry[]): JournalEntry[] =>
  entries.filter((e) => e.payload.type === 'user'
    && e.payload.blocks.some((b) => b.type === 'text' && b.text === TURN_CAP_DIRECTIVE));

const turnEnds = (events: HarnessEvent[]): Array<Extract<HarnessEvent, { kind: 'turn_end' }>> =>
  events.filter((e): e is Extract<HarnessEvent, { kind: 'turn_end' }> => e.kind === 'turn_end');

describe('the main loop wrap-up nudge — a caller-supplied cap gets a caller-supplied warning', () => {
  it("a researcher helper's 40-turn cap: the nudge lands once at round 30, tools stay allowed, the turn ends at 40", async () => {
    const { tool, runs } = searchTool();
    const { events, entries, transport } = await runTurns({
      taskId: 'wrapup-researcher',
      maxTurns: 40,
      turnWrapUpAt: 30,
      rounds: Array.from({ length: 45 }, (_, k) => searchRound(k)),
      tool,
    });

    const pushed = wrapUpEntries(entries);
    expect(pushed).toHaveLength(1);
    // The loop is speaking, and the injection screen reads the FIELD, not the sentence.
    expect((pushed[0]!.payload as { injected?: string }).injected).toBe('engine');
    // WHERE it landed: exactly 30 assistant rounds are behind it, so it arrived at the
    // round the caller named and not at some other one that happens to be before the cap.
    const at = entries.indexOf(pushed[0]!);
    expect(entries.slice(0, at).filter((e) => e.payload.type === 'assistant')).toHaveLength(30);

    // It STEERS: the ten remaining rounds still ran their tools.
    expect(transport.calls).toBe(40);
    expect(runs()).toBe(40);

    // And the cap is still the hard backstop, finalized the way the report leg reads it.
    const ends = turnEnds(events);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.outcome).toMatchObject({ kind: 'max_turns', numTurns: 40 });
  });

  it('no cap named: nothing is ever pushed, and the turn is byte-identical to today', async () => {
    const { tool } = searchTool();
    const { entries, transport } = await runTurns({
      taskId: 'wrapup-absent',
      maxTurns: 5,
      rounds: Array.from({ length: 8 }, (_, k) => searchRound(k)),
      tool,
    });

    expect(wrapUpEntries(entries)).toHaveLength(0);
    expect(transport.calls).toBe(5);
  });

  it('the latch is per TURN: a second user turn gets its own nudge', async () => {
    // Without a reset at the turn boundary a resumed helper would run its whole second
    // turn to the cap with nothing telling it to write anything down.
    const { tool } = searchTool();
    const { entries } = await runTurns({
      taskId: 'wrapup-two-turns',
      maxTurns: 3,
      turnWrapUpAt: 2,
      rounds: Array.from({ length: 12 }, (_, k) => searchRound(k)),
      tool,
      turns: [{ text: 'first' }, { text: 'second' }],
    });

    expect(wrapUpEntries(entries)).toHaveLength(2);
  });

  it('a cap the turn never reaches: no nudge, because the loop stopped short of it', async () => {
    const { tool } = searchTool();
    const { entries, transport } = await runTurns({
      taskId: 'wrapup-short',
      maxTurns: 40,
      turnWrapUpAt: 30,
      // Two searches, then the answer: a helper that finished its work early.
      rounds: [searchRound(0), searchRound(1), [
        { kind: 'text', text: 'Here is what I found.' } as StreamEvent,
        { kind: 'done', stopReason: 'end_turn', usage } as StreamEvent,
      ]],
      tool,
    });

    expect(wrapUpEntries(entries)).toHaveLength(0);
    expect(transport.calls).toBe(3);
  });
});
