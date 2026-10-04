/**
 * native-harness.capture-signal.test.ts — P5 Task 3: the engine emits the
 * write-on-surprise signal at turn finalization.
 *
 * Flag ON (cfg.captureSignal) + a surprising turn (a user correction after
 * substantive turn-1 work) → ONE durable `custom` journal entry
 * (key:'nami_capture') + ONE `raw` NAMI_CAPTURE_SIGNAL HarnessEvent. A bland
 * turn → neither. Flag absent → neither (byte-identical).
 */
import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import { NAMI_CAPTURE_SIGNAL_EVENT } from '../capture-signal.js';
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

function usage(costUsd: number): NormalizedUsage {
  return { inputTokens: 10, outputTokens: 5, costUsd } as NormalizedUsage;
}

class ScriptTransport extends FakeTransport {
  private idx = 0;
  constructor(private readonly rounds: StreamEvent[][]) {
    super([]);
  }
  override callModel(): StreamEvent[] {
    const round = this.rounds[Math.min(this.idx, this.rounds.length - 1)];
    this.idx += 1;
    return round;
  }
  override computeCostUsd(u: NormalizedUsage): number {
    return (u as { costUsd?: number }).costUsd ?? 0;
  }
}

/** Turn 1: one tool round + text; turn 2: text only. */
function rounds(): StreamEvent[][] {
  return [
    [
      { kind: 'tool_use', toolUse: { id: 'tu-1', name: 'noop', input: {} } },
      { kind: 'done', stopReason: 'tool_use', usage: usage(0.01) },
    ],
    [
      { kind: 'text', text: 'deployed to prod' },
      { kind: 'done', stopReason: 'end_turn', usage: usage(0.01) },
    ],
    [
      { kind: 'text', text: 'ok, redoing on staging' },
      { kind: 'done', stopReason: 'end_turn', usage: usage(0.01) },
    ],
  ];
}

function noopToolHost(): ToolHost {
  return {
    async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
      const noop: RawToolOptions = {
        name: 'noop',
        description: 'resolves immediately',
        parameters: { type: 'object', properties: {}, additionalProperties: true },
        execute: async () => 'ok',
      };
      return { tools: [noop], onAuthHalt: async () => {} };
    },
  };
}

function makeJournal(taskId: string): Journal {
  const path = join(tmpdir(), `capture-${process.pid}-${Math.random().toString(36).slice(2)}`, `${taskId}.jsonl`);
  return new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(path),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2024-01-01T00:00:00.000Z'),
  });
}

async function runTurns(opts: {
  taskId: string;
  journal: Journal;
  captureSignal?: boolean;
  turns: string[];
}): Promise<HarnessEvent[]> {
  const cfg = {
    onAttached: () => {},
    maxTurns: 10,
    transport: new ScriptTransport(rounds()),
    toolHost: noopToolHost(),
    journal: opts.journal,
    ...(opts.captureSignal ? { captureSignal: true } : {}),
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = {
    taskId: opts.taskId,
    sessionId: 's-cap',
    cwd: '/tmp',
    model: 'fake-model',
    signal: new AbortController().signal,
    config: cfg,
  };
  const input = (async function* (): AsyncIterable<UserTurn> {
    for (const t of opts.turns) yield { text: t };
  })();
  const events: HarnessEvent[] = [];
  for await (const ev of new NativeHarness().run(input, ctx)) events.push(ev);
  return events;
}

function captureEvents(events: HarnessEvent[]): HarnessEvent[] {
  return events.filter((e) => e.kind === 'raw' && (e as { event?: string }).event === NAMI_CAPTURE_SIGNAL_EVENT);
}

async function captureEntries(journal: Journal): Promise<JournalEntry[]> {
  const out: JournalEntry[] = [];
  for await (const e of journal.read()) {
    if (e.payload.type === 'custom' && e.payload.key === 'nami_capture') out.push(e);
  }
  return out;
}

const CORRECTION_TURNS = ['deploy the app', 'no, that should be staging'];

describe('P5 Task 3 — in-loop capture signal at turn finalization', () => {
  it('flag ON + correction turn → ONE nami_capture journal entry + ONE raw NAMI_CAPTURE_SIGNAL', async () => {
    const journal = makeJournal('t-cap-on');
    const events = await runTurns({ taskId: 't-cap-on', journal, captureSignal: true, turns: CORRECTION_TURNS });
    const raws = captureEvents(events);
    expect(raws.length).toBe(1);
    const data = (raws[0] as { data?: { taskId?: string; surprise?: { correction?: boolean; forcing?: boolean } } }).data;
    expect(data?.taskId).toBe('t-cap-on');
    expect(data?.surprise?.correction).toBe(true);
    expect(data?.surprise?.forcing).toBe(true);
    const entries = await captureEntries(journal);
    expect(entries.length).toBe(1);
    const payload = entries[0].payload as { data?: { surprise?: { correction?: boolean } } };
    expect(payload.data?.surprise?.correction).toBe(true);
  });

  it('flag ON + bland turns → no entry, no event', async () => {
    const journal = makeJournal('t-cap-bland');
    const events = await runTurns({ taskId: 't-cap-bland', journal, captureSignal: true, turns: ['deploy the app'] });
    expect(captureEvents(events).length).toBe(0);
    expect((await captureEntries(journal)).length).toBe(0);
  });

  it('flag ABSENT + correction turn → no entry, no event (byte-identical)', async () => {
    const journal = makeJournal('t-cap-off');
    const events = await runTurns({ taskId: 't-cap-off', journal, turns: CORRECTION_TURNS });
    expect(captureEvents(events).length).toBe(0);
    expect((await captureEntries(journal)).length).toBe(0);
  });
});
