/**
 * The work's answer (task.completed's answer, run.text()): the text of the turn's last round that produced text.
 * summary joins every round's text with no separator, so a narrated run fuses its narration onto the answer; answer
 * is that last text alone, and null for a turn where no round produced any (its fallback line is not an answer).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import { finalAnswer } from '../native-iterate-turn.js';
import { EMPTY_RESPONSE_FALLBACK_TEXT } from '../empty-recovery.js';
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
  const path = join(tmpdir(), `answer-${process.pid}-${Math.random().toString(36).slice(2)}`, `${taskId}.jsonl`);
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
    sessionId: 's-answer',
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


const note: RawToolOptions = { name: 'look_up', description: 'look up', parameters: z.object({ ref: z.string() }), execute: async () => 'found' };
type Completed = { kind: string; summary?: string; answer?: string | null };
const outcomeOf = (events: HarnessEvent[]): Completed => {
  const end = [...events].reverse().find((e) => e.kind === 'turn_end') as { outcome: Completed };
  return end.outcome;
};

describe("a completed turn's answer is the text of its last round that produced text", () => {
  it('a narrated multi-round run: summary fuses every round; answer is the last round only', async () => {
    const { events } = await runTurn({
      taskId: 'task-answer-1', journal: makeJournal('task-answer-1'), tools: [note],
      rounds: [toolRound('t1', 'look_up', { ref: 'TN-48213' }, 'Let me check your booking.'), textRound('Your flight leaves at 06:10.')],
    });
    const outcome = outcomeOf(events);
    expect(outcome.kind).toBe('completed');
    expect(outcome.summary).toBe('Let me check your booking.Your flight leaves at 06:10.');
    expect(outcome.answer).toBe('Your flight leaves at 06:10.');
  });

  it('a one-round run: the answer is its reply', async () => {
    const { events } = await runTurn({ taskId: 'task-answer-2', journal: makeJournal('task-answer-2'), tools: [], rounds: [textRound('All done.')] });
    expect(outcomeOf(events).answer).toBe('All done.');
  });

  it("a run whose last round has no text: the answer is the last text round's words", async () => {
    const silent: StreamEvent[] = [{ kind: 'done', stopReason: 'end_turn', usage } as StreamEvent];
    const { events } = await runTurn({
      taskId: 'task-answer-4', journal: makeJournal('task-answer-4'), tools: [note],
      rounds: [toolRound('t1', 'look_up', { ref: 'TN-48213' }, 'Rebooked you on the 09:15.'), silent],
    });
    const outcome = outcomeOf(events);
    expect(outcome.kind).toBe('completed');
    expect(outcome.summary).toBe('Rebooked you on the 09:15.');
    expect(outcome.answer).toBe('Rebooked you on the 09:15.');
  });

  it('an empty run: the fallback line is its summary, and its answer is null', async () => {
    const empty: StreamEvent[] = [{ kind: 'done', stopReason: 'end_turn', usage } as StreamEvent];
    const { events } = await runTurn({ taskId: 'task-answer-3', journal: makeJournal('task-answer-3'), tools: [], rounds: [empty] });
    const outcome = outcomeOf(events);
    expect(outcome.kind).toBe('completed');
    expect(outcome.summary).toBe(EMPTY_RESPONSE_FALLBACK_TEXT);
    expect(outcome.answer).toBeNull();
  });

  it('finalAnswer: the last text block with words (one per round), past tools, thinking and blank text; null when none', () => {
    expect(finalAnswer([
      { type: 'text', text: 'Checking. ' },
      { type: 'tool_use', id: 't1', name: 'look_up', input: {} },
      { type: 'thinking', thinking: 'the answer is near' },
      { type: 'text', text: 'Leaves at 06:10.' },
    ] as never)).toBe('Leaves at 06:10.');
    expect(finalAnswer([{ type: 'text', text: 'Leaves at 06:10.' }, { type: 'tool_use', id: 't1', name: 'look_up', input: {} }, { type: 'text', text: '  ' }] as never))
      .toBe('Leaves at 06:10.');
    expect(finalAnswer([{ type: 'tool_use', id: 't1', name: 'look_up', input: {} }] as never)).toBeNull();
    expect(finalAnswer([{ type: 'text', text: '  ' }] as never)).toBeNull();
  });
});
