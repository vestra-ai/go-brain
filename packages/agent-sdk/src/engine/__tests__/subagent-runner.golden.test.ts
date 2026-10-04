/**
 * P2.2 (Task 6, step 1) — GOLDEN test freezing TODAY's subagent-loop behavior
 * BEFORE the round-engine extraction: the exact onEvent sequence, the exact
 * scope-tagged journal entry shapes, and the exact SubagentRunResult fields for
 * one mocked run (text+tool round, then a final-text round).
 *
 * This is the byte-identity proof for the P2.2 refactor's OFF axis: the
 * extraction commit and the flag-OFF path of the SUBAGENT_SHARED_LOOP swap must
 * keep every assertion here green WITHOUT edits. Any change to this file in
 * those commits is a conformance failure, not a test update.
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
import type { SubagentPathSegment } from '../../contract/subagent-path.js';
import type {
  StreamEvent,
  Transport,
  NormalizedUsage,
  ProviderHistory,
  ProviderStream,
} from '../transport.js';
import { runSubagentLoop, type SubagentEvent } from '../subagent-runner.js';

const dir = join(tmpdir(), `subagent-runner-golden-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const makeJournal = (taskId = 't') => new Journal({
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
    defaultModel: () => 'm',
    emptyHistory: () => [] as unknown as ProviderHistory,
    pushUser: (h) => { (h as unknown[]).push({ role: 'user' }); },
    pushAssistant: (h, blocks) => { (h as unknown[]).push({ role: 'assistant', blocks }); },
    pushToolResult: (h, r) => { (h as unknown[]).push({ role: 'tool_result', r }); },
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

const echoTool = (): RawToolOptions => ({
  name: 'echo',
  description: 'echo',
  parameters: z.object({ msg: z.string() }),
  execute: async (input) => `echo:${(input as { msg: string }).msg}`,
});

const seg = (depth: number, id: string): SubagentPathSegment =>
  ({ depth, agentToolUseId: id, agentSlug: 'researcher', agentName: 'Researcher' });

/** Round 1: two text deltas + a tool_use; round 2: the final answer. */
const script = (): StreamEvent[][] => [
  [
    { kind: 'text', text: 'check' },
    { kind: 'text', text: 'ing' },
    { kind: 'tool_use', toolUse: { id: 's1', name: 'echo', input: { msg: 'hi' } } },
    { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
  ],
  [
    { kind: 'text', text: 'final answer' },
    { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 7 } },
  ],
];

describe('runSubagentLoop — GOLDEN (pre-P2.2 behavior freeze)', () => {
  it('emits the exact event sequence, journal shape, and result for one mocked run', async () => {
    const j = makeJournal('t-golden');
    const path = [seg(1, 'T1')];
    const events: SubagentEvent[] = [];

    const result = await runSubagentLoop({
      transport: makeScriptedTransport(script()),
      model: 'm',
      system: 'sys',
      userPrompt: 'go',
      tools: [echoTool()],
      harness: allowHarness,
      onPause,
      maxTurns: 5,
      childId: 'child-golden',
      onEvent: (ev) => events.push(ev),
      journal: j,
      subagentPath: path,
    });

    // ── GOLDEN 1: the exact neutral event sequence, in order ──────────────────
    expect(events).toEqual([
      { kind: 'text', delta: 'check' },
      { kind: 'text', delta: 'ing' },
      { kind: 'tool_use', subToolUseId: 's1', toolName: 'echo', toolInput: { msg: 'hi' } },
      { kind: 'tool_result', subToolUseId: 's1', result: 'echo:hi', isError: false },
      // The action fee, on the settled result (isSubagent), the one frame this call gets.
      { kind: 'billing', event: { kind: 'raw', engine: 'native', event: 'agent:tool_billing', data: { taskId: '', toolName: 'echo', toolUseId: 's1', isSubagent: true } } },
      { kind: 'text', delta: 'final answer' },
    ]);

    // ── GOLDEN 2: the exact journal entry shapes (headers + payloads), in order ─
    const all = await readAll(j);
    expect(
      all.map((e) => ({
        taskId: e.taskId,
        workspaceId: e.workspaceId,
        agentId: e.agentId,
        principal: e.principal,
        agentPath: e.agentPath,
        payload: e.payload,
      })),
    ).toEqual([
      {
        taskId: 't-golden',
        workspaceId: 'u',
        agentId: 'native',
        principal: { kind: 'agent', agentId: 'native' },
        agentPath: path,
        payload: {
          type: 'assistant',
          blocks: [{ type: 'text', text: 'checking' }],
          api: 'fake',
          provider: 'fake',
          model: 'm',
        },
      },
      {
        taskId: 't-golden',
        workspaceId: 'u',
        agentId: 'native',
        principal: { kind: 'agent', agentId: 'native' },
        agentPath: path,
        payload: { type: 'tool_use', toolUseId: 's1', name: 'echo', input: { msg: 'hi' } },
      },
      {
        taskId: 't-golden',
        workspaceId: 'u',
        agentId: 'native',
        principal: { kind: 'agent', agentId: 'native' },
        agentPath: path,
        payload: {
          type: 'tool_result',
          toolUseId: 's1',
          blocks: [{ type: 'text', text: 'echo:hi' }],
          isError: false,
        },
      },
      {
        taskId: 't-golden',
        workspaceId: 'u',
        agentId: 'native',
        principal: { kind: 'agent', agentId: 'native' },
        agentPath: path,
        payload: {
          type: 'assistant',
          blocks: [{ type: 'text', text: 'final answer' }],
          api: 'fake',
          provider: 'fake',
          model: 'm',
        },
      },
    ]);

    // ── GOLDEN 3: the exact SubagentRunResult ─────────────────────────────────
    expect(result.text).toBe('final answer');
    expect(result.toolUseCount).toBe(1);
    expect(result.pausedHalt).toBe(false);
    // (10+5)*1e-5 + (20+7)*1e-5
    expect(result.costUsd).toBeCloseTo(0.00042, 10);
    expect(result.usage).toEqual({
      inputTokens: 30,
      outputTokens: 12,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    expect(result.childCost).toEqual({
      childId: 'child-golden',
      model: 'm',
      usage: {
        inputTokens: 30,
        outputTokens: 12,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      costUsd: result.costUsd,
    });
  });

  it('journal-less run: same events, empty journal, same result (in-memory path)', async () => {
    const events: SubagentEvent[] = [];
    const result = await runSubagentLoop({
      transport: makeScriptedTransport(script()),
      model: 'm', system: 'sys', userPrompt: 'go', tools: [echoTool()],
      harness: allowHarness, onPause, maxTurns: 5, childId: 'c',
      onEvent: (ev) => events.push(ev),
    });
    expect(events.map((e) => e.kind)).toEqual(['text', 'text', 'tool_use', 'tool_result', 'billing', 'text']);
    expect(result.text).toBe('final answer');
    expect(result.toolUseCount).toBe(1);
  });

  it('model-call throw propagates out (no in-loop retry today — the P2.2 flag adds it)', async () => {
    let calls = 0;
    const failing = makeScriptedTransport(script());
    const origCall = failing.callModel.bind(failing);
    failing.callModel = (req) => {
      calls += 1;
      if (calls === 1) throw new Error('transient 529');
      return origCall(req);
    };
    await expect(
      runSubagentLoop({
        transport: failing,
        model: 'm', system: 'sys', userPrompt: 'go', tools: [echoTool()],
        harness: allowHarness, onPause, maxTurns: 5, childId: 'c', onEvent: () => {},
      }),
    ).rejects.toThrow('transient 529');
  });
});
