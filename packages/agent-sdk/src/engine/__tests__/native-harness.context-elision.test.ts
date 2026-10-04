/**
 * CONTEXT_ELISION_V1 — the three flag axes, at the harness level.
 *
 *   OFF  → the wire is BYTE-IDENTICAL to the raw journal projection.
 *   ON   → old tool_result bodies leave the wire as stubs; pairing survives;
 *          the context-usage ledger reports the ELIDED view (coherence).
 *   ON   → a conversation with nothing elidable behaves exactly like OFF.
 *
 * The transport records every array handed to `historyFromJournal`, which IS the
 * wire view, so "byte-identical" is asserted against real bytes rather than
 * inferred from a token count.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage, type ProviderHistory } from '../transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import { projectTokenCount } from '../../kernel/journal/token-ledger.js';
import type { JournalEntry, NewEntry } from '../../contract/journal.js';
import type { ContentBlock } from '../../contract/blocks.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { NativeConfig } from '../native-config.js';

const FLAG = 'CONTEXT_ELISION_V1';
const V2 = 'COMPACTION_V2';

afterEach(() => {
  delete process.env[FLAG];
  delete process.env[V2];
});

function usage(costUsd: number): NormalizedUsage {
  return { inputTokens: 10, outputTokens: 5, costUsd } as NormalizedUsage;
}
function doneEvent(costUsd: number): StreamEvent {
  return { kind: 'done', stopReason: 'end_turn', usage: usage(costUsd) };
}

/** Records the exact entry array every wire projection is built from. */
class RecordingTransport extends FakeTransport {
  wires: JournalEntry[][] = [];
  constructor() {
    super([{ kind: 'text', text: 'ok' }, doneEvent(0.01)]);
  }
  override historyFromJournal(entries: JournalEntry[]): ProviderHistory {
    this.wires.push(entries);
    return super.historyFromJournal(entries);
  }
  override computeCostUsd(u: NormalizedUsage): number {
    return (u as { costUsd?: number }).costUsd ?? 0;
  }
}

const base = (taskId: string): Omit<NewEntry, 'payload'> => ({
  taskId,
  rootTaskId: taskId,
  spawnDepth: 0,
  workspaceId: 'w',
  agentId: 'native',
  principal: { kind: 'agent', agentId: 'native' },
  timestamp: '',
});

function makeJournal(taskId: string): Journal {
  const path = join(
    tmpdir(),
    `elision-${process.pid}-${Math.random().toString(36).slice(2)}`,
    `${taskId}.jsonl`,
  );
  return new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(path),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2024-01-01T00:00:00.000Z'),
  });
}

/** ~15,000 estimated tokens of tool output per turn. */
const fatBody = 'result-line-of-output '.repeat(2_700);

/**
 * Seed `n` user → tool_use → tool_result → assistant rounds. `body` sizes each
 * tool result; a fat body is what pushes the projection past the live window so
 * the cut can advance at all.
 */
async function seedTurns(j: Journal, taskId: string, n: number, body: string): Promise<void> {
  for (let i = 0; i < n; i++) {
    await j.append({
      ...base(taskId),
      principal: { kind: 'user', userId: 'u' },
      payload: { type: 'user', blocks: [{ type: 'text', text: `q${i}` } as ContentBlock] },
    });
    await j.append({
      ...base(taskId),
      payload: { type: 'tool_use', toolUseId: `tu-${i}`, name: 'Read', input: { file_path: `/f${i}` } },
    });
    await j.append({
      ...base(taskId),
      payload: {
        type: 'tool_result',
        toolUseId: `tu-${i}`,
        blocks: [{ type: 'text', text: body } as ContentBlock],
      },
    });
    await j.append({
      ...base(taskId),
      payload: {
        type: 'assistant',
        blocks: [{ type: 'text', text: `a${i}` } as ContentBlock],
        api: 'anthropic_messages',
        provider: 'anthropic',
        model: 'fake-model',
      },
    });
  }
}

async function runTurn(
  taskId: string,
  journal: Journal,
  namiOffloopSweep = false,
  model = 'fake-model',
): Promise<{
  events: HarnessEvent[];
  transport: RecordingTransport;
}> {
  const transport = new RecordingTransport();
  const cfg = {
    onAttached: () => {},
    maxTurns: 4,
    transport,
    journal,
    workingDir: join(tmpdir(), `elision-wd-${process.pid}-${Math.random().toString(36).slice(2)}`),
    compaction: { thresholdPct: 0.99, keepWindowTokens: 50 },
    namiOffloopSweep,
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = {
    taskId,
    sessionId: 's-elision',
    cwd: '/tmp',
    model,
    signal: new AbortController().signal,
    config: cfg,
  };
  const input = (async function* (): AsyncIterable<UserTurn> {
    yield { text: 'next question' };
  })();
  const events: HarnessEvent[] = [];
  for await (const ev of new NativeHarness().run(input, ctx)) events.push(ev);
  return { events, transport };
}

/** Every `[elided:` stub text present in a wire projection. */
function stubs(entries: JournalEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (!('blocks' in e.payload)) continue;
    for (const b of e.payload.blocks as Array<{ text?: string }>) {
      if (typeof b.text === 'string' && b.text.startsWith('[elided:')) out.push(b.text);
    }
  }
  return out;
}

function contextUsage(events: HarnessEvent[]): { messages: number } | null {
  const ev = events.find((e) => e.kind === 'context_usage');
  return ev ? ((ev as { snapshot: { messages: number } }).snapshot ?? null) : null;
}

// ─── AXIS 1: flag OFF is byte-identical ───────────────────────────────────────

describe('CONTEXT_ELISION_V1 — axis 1: OFF is byte-identical', () => {
  it('every wire projection is exactly the raw journal projection', async () => {
    const taskId = 't-elide-off';
    const j = makeJournal(taskId);
    await seedTurns(j, taskId, 16, fatBody);

    const { transport } = await runTurn(taskId, j);
    expect(transport.wires.length).toBeGreaterThan(0);

    // Projected AFTER the run: the turn appends its own user + assistant entries,
    // and appends only ever land at the END, so slicing to each recorded wire's
    // length gives exactly the raw entries that wire covered.
    const raw = (await j.project()).messages;
    for (const wire of transport.wires) {
      // Not just equal in size — the same bytes, in the same order.
      expect(JSON.stringify(wire)).toBe(JSON.stringify(raw.slice(0, wire.length)));
    }
    expect(stubs(transport.wires[0])).toHaveLength(0);
  });
});

// ─── AXIS 2: flag ON elides ───────────────────────────────────────────────────

describe('CONTEXT_ELISION_V1 — axis 2: ON shrinks the wire', () => {
  it('stubs old results, keeps pairing intact, and shrinks the projection', async () => {
    process.env[FLAG] = '1';
    const taskId = 't-elide-on';
    const j = makeJournal(taskId);
    await seedTurns(j, taskId, 16, fatBody);

    const { events, transport } = await runTurn(taskId, j);
    const wire = transport.wires[0];
    // Projected after the run, then trimmed to what this wire covered (appends
    // only land at the end).
    const raw = (await j.project()).messages.slice(0, wire.length);

    // Something was actually elided.
    expect(stubs(wire).length).toBeGreaterThan(0);
    expect(stubs(wire)[0]).toContain('Read');
    expect(stubs(wire)[0]).toContain('.kernel-offload/');

    // PAIR SAFETY: identical structure, identical ids — only content shrank.
    expect(wire).toHaveLength(raw.length);
    for (let i = 0; i < wire.length; i++) {
      expect(wire[i].payload.type).toBe(raw[i].payload.type);
      const a = wire[i].payload;
      const b = raw[i].payload;
      if (a.type === 'tool_result' && b.type === 'tool_result') expect(a.toolUseId).toBe(b.toolUseId);
      if (a.type === 'tool_use' && b.type === 'tool_use') expect(a.toolUseId).toBe(b.toolUseId);
    }

    // The wire is materially smaller than the journal it came from.
    const rawTokens = projectTokenCount(raw).messages;
    const wireTokens = projectTokenCount(wire).messages;
    expect(wireTokens).toBeLessThan(rawTokens / 2);

    // LEDGER COHERENCE: the meter reports the elided view, not the raw journal.
    const snap = contextUsage(events);
    expect(snap).not.toBeNull();
    expect(snap!.messages).toBe(wireTokens);
    expect(snap!.messages).toBeLessThan(rawTokens);
  });

  it('the journal itself keeps full fidelity', async () => {
    process.env[FLAG] = '1';
    const taskId = 't-elide-fidelity';
    const j = makeJournal(taskId);
    await seedTurns(j, taskId, 16, fatBody);
    await runTurn(taskId, j);

    // Re-read the durable journal: no stub was ever written to it.
    const durable: JournalEntry[] = [];
    for await (const e of j.read()) durable.push(e);
    const bodies = durable
      .filter((e) => e.payload.type === 'tool_result')
      .map((e) => ((e.payload as { blocks: Array<{ text?: string }> }).blocks[0]?.text ?? ''));
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) expect(b.startsWith('[elided:')).toBe(false);
  });

  it('the end-of-task off-loop sweep rides the SAME stubs the loop shipped', async () => {
    // The sweep's entire cache argument is that its prefix IS the prefix the turn just
    // wrote (memory-sweep.ts header: same system, same tools, same projection). With
    // elision on, that prefix is the ELIDED view — so a sweep re-projecting the journal
    // raw would send full bodies where the last round sent stubs and miss the cache it
    // exists to hit. This is the sweep half of the 2026-08-13 rollback cause.
    process.env[FLAG] = '1';
    const taskId = 't-elide-sweep';
    const j = makeJournal(taskId);
    await seedTurns(j, taskId, 16, fatBody);
    const { transport } = await runTurn(taskId, j, true);

    // Positive control that the LAST projection really is the sweep's: the identical
    // run with the sweep off makes exactly one fewer.
    const bare = 't-elide-sweep-off';
    const j2 = makeJournal(bare);
    await seedTurns(j2, bare, 16, fatBody);
    const { transport: noSweep } = await runTurn(bare, j2, false);
    expect(transport.wires.length).toBe(noSweep.wires.length + 1);

    const sweepWire = transport.wires[transport.wires.length - 1];
    expect(stubs(transport.wires[0]).length).toBeGreaterThan(0);
    expect(stubs(sweepWire)).toEqual(stubs(transport.wires[0]));
  });

  it('every projection inside one turn carries the SAME stubs (cache stability)', async () => {
    process.env[FLAG] = '1';
    const taskId = 't-elide-stable';
    const j = makeJournal(taskId);
    await seedTurns(j, taskId, 16, fatBody);
    const { transport } = await runTurn(taskId, j);

    // A turn that re-decided per round would bust the prefix cache every round.
    const first = JSON.stringify(stubs(transport.wires[0]));
    for (const wire of transport.wires) expect(JSON.stringify(stubs(wire))).toBe(first);
  });
});

// ─── AXIS 3: flag ON, nothing elidable → base behavior ────────────────────────

describe('CONTEXT_ELISION_V1 — axis 3: ON with nothing elidable', () => {
  it('a short conversation is untouched and the turn completes normally', async () => {
    process.env[FLAG] = '1';
    const taskId = 't-elide-short';
    const j = makeJournal(taskId);
    await seedTurns(j, taskId, 3, 'a small result');

    const { events, transport } = await runTurn(taskId, j);
    const raw = (await j.project()).messages;

    for (const wire of transport.wires) {
      expect(JSON.stringify(wire)).toBe(JSON.stringify(raw.slice(0, wire.length)));
    }
    expect(stubs(transport.wires[0])).toHaveLength(0);
    const end = events.find((e) => e.kind === 'turn_end') as { outcome: { kind: string } } | undefined;
    expect(end?.outcome.kind).toBe('completed');
  });

  it('a long conversation of SMALL results is left alone (minResultTokens holds)', async () => {
    process.env[FLAG] = '1';
    const taskId = 't-elide-small';
    const j = makeJournal(taskId);
    await seedTurns(j, taskId, 20, 'tiny');

    const { transport } = await runTurn(taskId, j);
    const raw = (await j.project()).messages;
    expect(stubs(transport.wires[0])).toHaveLength(0);
    expect(JSON.stringify(transport.wires[0])).toBe(
      JSON.stringify(raw.slice(0, transport.wires[0].length)),
    );
  });
});

// ─── AXIS 4: the budget is the COMPACTION TRIGGER, not the context window ─────

describe('CONTEXT_ELISION_V1 — axis 4: sized against the compaction trigger', () => {
  /** Every `[elided:` stub in the FIRST wire projection of a run. */
  const firstWireStubs = (t: RecordingTransport) => stubs(t.wires[0]);

  it('a real 1M model with a 180k trigger elides at ~120k of conversation', async () => {
    // THE REGRESSION THIS PINS. `prepareElision` used to pass
    // resolveMaxContextTokens(model) — 1,000,000 here — so liveWindow alone was
    // 250,000 and a 120,000-token conversation produced a zero cut. Measured
    // 2026-08-22: 0 of 12,178 staging calls ever cleared that bar. Against the
    // 180,000 compaction trigger the same journal elides.
    process.env[FLAG] = '1';
    process.env[V2] = 'true';
    const taskId = 't-elide-budget';
    const j = makeJournal(taskId);
    // 8 x ~15,000 = ~120,000 of journal text — under the 180,000 trigger, so
    // compaction does not fire and this is genuinely elision's span.
    await seedTurns(j, taskId, 8, fatBody);

    const { transport } = await runTurn(taskId, j, false, 'claude-sonnet-5');
    expect(firstWireStubs(transport).length).toBeGreaterThan(0);
    expect(firstWireStubs(transport)[0]).toContain('Read');
  });

  it('CONTROL: the same run on a model whose trigger is 5x larger elides nothing', async () => {
    // deepseek-v4-flash declares no preferredMaxInputTokens, so its budget is
    // 0.8 x 1,048,576 = 838,861 and liveWindow alone is 209,715. Same journal,
    // same flag, no stubs — which is what proves the case above is reading the
    // budget and not merely "elision is on".
    process.env[FLAG] = '1';
    process.env[V2] = 'true';
    const taskId = 't-elide-budget-control';
    const j = makeJournal(taskId);
    await seedTurns(j, taskId, 8, fatBody);

    const { transport } = await runTurn(taskId, j, false, 'deepseek-v4-flash');
    expect(firstWireStubs(transport)).toHaveLength(0);
  });
});
