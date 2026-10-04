/**
 * T10 (durable subagent deep-HITL, Phase B) Piece 2 — the subagent loop journals
 * its OWN rounds, scope-tagged by the subagent's path, into the PASSED-IN per-task
 * Journal (single-writer preserved).
 *
 * When BOTH `journal` and a non-empty `subagentPath` are present, `runSubagentLoop`
 * appends its assistant text + each tool_use + each tool_result tagged
 * `agentPath: subagentPath`, so a later task can re-enter the subagent from journaled
 * state. When either is absent (main agent / flag-off) it journals NOTHING extra —
 * byte-identical to today.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { RawToolOptions } from '../../tools/tool-types.js';
import { subagentIdFromPath, type SubagentPathSegment } from '../../contract/subagent-path.js';
import type {
  StreamEvent,
  Transport,
  NormalizedUsage,
  ProviderHistory,
  ProviderStream,
} from '../transport.js';
import { runSubagentLoop } from '../subagent-runner.js';

const dir = join(tmpdir(), `subagent-runner-journal-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const make = (taskId = 't') => new Journal({
  taskId,
  workspaceId: 'u',
  jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
  mirror: new InMemorySessionStore(),
  clock: sequentialClock('2026-01-01T00:00:00.000Z'),
});

const readAll = async (j: Journal): Promise<JournalEntry[]> => {
  const all: JournalEntry[] = [];
  for await (const e of j.read()) all.push(e);
  return all;
};

/** A scripted transport: each `callModel` returns the next pre-baked round of events. */
function makeScriptedTransport(rounds: StreamEvent[][]): Transport {
  let i = 0;
  const t: Partial<Transport> = {
    api: 'fake',
    provider: 'fake',
    emptyHistory: () => [] as unknown as ProviderHistory,
    pushUser: (h) => { (h as unknown[]).push({}); },
    pushAssistant: (h) => { (h as unknown[]).push({}); },
    pushToolResult: (h) => { (h as unknown[]).push({}); },
    buildTools: (raw) => raw as unknown[],
    callModel: () =>
      (rounds[i++] ?? [{ kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }]) as unknown as ProviderStream,
    // eslint-disable-next-line require-yield
    readStream: async function* (stream) { for (const ev of stream as StreamEvent[]) yield ev; },
    computeCostUsd: (u: NormalizedUsage) => (u.inputTokens + u.outputTokens) * 0.00001,
  };
  return t as Transport;
}

const allowHarness = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };
const onPause = async (): Promise<string> => 'PAUSED';
const doneEv = (): StreamEvent => ({ kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } });

const echoTool = (): RawToolOptions => ({
  name: 'echo',
  description: 'echo',
  parameters: z.object({ msg: z.string() }),
  execute: async (input) => `echo:${(input as { msg: string }).msg}`,
});

/** A one-tool-then-final-answer script: round 1 = text + tool_use(echo), round 2 = final text. */
const oneToolScript = (subToolUseId: string): StreamEvent[][] => [
  [
    { kind: 'text', text: 'checking' },
    { kind: 'tool_use', toolUse: { id: subToolUseId, name: 'echo', input: { msg: 'hi' } } },
    doneEv(),
  ],
  [{ kind: 'text', text: 'final answer' }, doneEv()],
];

const seg = (depth: number, id: string): SubagentPathSegment =>
  ({ depth, agentToolUseId: id, agentSlug: 'researcher', agentName: 'Researcher' });

const scopeOf = (e: JournalEntry): string | undefined =>
  e.agentPath ? subagentIdFromPath(e.agentPath) : undefined;

describe('runSubagentLoop — scope-tagged journaling (T10 Piece 2)', () => {
  it('journals assistant + tool_use + tool_result tagged with the subagent path', async () => {
    const j = make('t-loop');
    const path = [seg(1, 'T1')];
    await runSubagentLoop({
      transport: makeScriptedTransport(oneToolScript('s1')),
      model: 'm',
      system: 'sys',
      userPrompt: 'go',
      tools: [echoTool()],
      harness: allowHarness,
      onPause,
      maxTurns: 5,
      childId: 'child-loop',
      onEvent: () => {},
      journal: j,
      subagentPath: path,
    });

    const all = await readAll(j);
    // Every journaled entry is scope-tagged to this subagent's leaf id.
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((e) => scopeOf(e) === 'T1')).toBe(true);

    const types = all.map((e) => e.payload.type);
    expect(types).toContain('tool_use');
    expect(types).toContain('tool_result');

    const tu = all.find((e) => e.payload.type === 'tool_use');
    expect((tu!.payload as Extract<JournalEntry['payload'], { type: 'tool_use' }>).toolUseId).toBe('s1');
    const tr = all.find((e) => e.payload.type === 'tool_result');
    const trp = tr!.payload as Extract<JournalEntry['payload'], { type: 'tool_result' }>;
    expect(trp.toolUseId).toBe('s1');
    expect(trp.blocks).toEqual([{ type: 'text', text: 'echo:hi' }]);

    // The subagent's assistant text is captured for faithful re-entry.
    const asst = all.filter((e) => e.payload.type === 'assistant');
    const texts = asst.map(
      (e) => (e.payload as Extract<JournalEntry['payload'], { type: 'assistant' }>).blocks,
    );
    expect(JSON.stringify(texts)).toContain('final answer');
  });

  it('journals NOTHING when no journal is passed (byte-identical main path)', async () => {
    const j = make('t-nojournal');
    await runSubagentLoop({
      transport: makeScriptedTransport(oneToolScript('s1')),
      model: 'm', system: 'sys', userPrompt: 'go', tools: [echoTool()],
      harness: allowHarness, onPause, maxTurns: 5, childId: 'c', onEvent: () => {},
      // no journal, no subagentPath
    });
    // The loop journals to the PASSED journal only; this unrelated journal stays empty.
    expect(await readAll(j)).toEqual([]);
  });

  it('journals NOTHING when a journal is passed but the path is empty', async () => {
    const j = make('t-emptypath');
    await runSubagentLoop({
      transport: makeScriptedTransport(oneToolScript('s1')),
      model: 'm', system: 'sys', userPrompt: 'go', tools: [echoTool()],
      harness: allowHarness, onPause, maxTurns: 5, childId: 'c', onEvent: () => {},
      journal: j,
      subagentPath: [],
    });
    expect(await readAll(j)).toEqual([]);
  });

  it('interleaved siblings: two paths through one Journal recover with zero cross-contamination', async () => {
    const j = make('t-siblings');
    const pathA = [seg(1, 'A')];
    const pathB = [seg(1, 'B')];

    // Both subagents append CONCURRENTLY through the one per-task Journal (single-writer).
    await Promise.all([
      runSubagentLoop({
        transport: makeScriptedTransport(oneToolScript('a1')),
        model: 'm', system: 'sys', userPrompt: 'go-a', tools: [echoTool()],
        harness: allowHarness, onPause, maxTurns: 5, childId: 'child-a', onEvent: () => {},
        journal: j, subagentPath: pathA,
      }),
      runSubagentLoop({
        transport: makeScriptedTransport(oneToolScript('b1')),
        model: 'm', system: 'sys', userPrompt: 'go-b', tools: [echoTool()],
        harness: allowHarness, onPause, maxTurns: 5, childId: 'child-b', onEvent: () => {},
        journal: j, subagentPath: pathB,
      }),
    ]);

    const all = await readAll(j);
    // A local path-filter (real projectScope is T11) recovers each sibling cleanly.
    const a = all.filter((e) => scopeOf(e) === 'A');
    const b = all.filter((e) => scopeOf(e) === 'B');

    // No entry leaked across scopes, and every entry belongs to exactly one sibling.
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(a.length + b.length).toBe(all.length);

    // Each sibling's tool_use carries its OWN sub-tool-use id (no cross-contamination).
    const aTu = a.find((e) => e.payload.type === 'tool_use')!.payload as Extract<JournalEntry['payload'], { type: 'tool_use' }>;
    const bTu = b.find((e) => e.payload.type === 'tool_use')!.payload as Extract<JournalEntry['payload'], { type: 'tool_use' }>;
    expect(aTu.toolUseId).toBe('a1');
    expect(bTu.toolUseId).toBe('b1');

    // Per-sibling relative order is preserved: each sibling's tool_use precedes its tool_result.
    for (const scoped of [a, b]) {
      const tuIdx = scoped.findIndex((e) => e.payload.type === 'tool_use');
      const trIdx = scoped.findIndex((e) => e.payload.type === 'tool_result');
      expect(tuIdx).toBeGreaterThanOrEqual(0);
      expect(trIdx).toBeGreaterThan(tuIdx);
    }
  });
});
