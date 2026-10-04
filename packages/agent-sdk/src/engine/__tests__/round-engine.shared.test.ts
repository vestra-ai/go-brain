/**
 * P2.2 (Task 6, step 3) — three-axis proof for the SUBAGENT_SHARED_LOOP swap.
 *
 *  OFF  — golden-identical: covered by subagent-runner.golden.test.ts (untouched)
 *         plus every legacy subagent suite; this file adds nothing on OFF.
 *  ON   — the sanctioned NEW behavior: startStreamWithRetry retry fires on a
 *         failing-then-ok mock, and per-round source:'subagent' usage entries
 *         appear WITH agentPath (charter c).
 *  ON-base — existing subagent behavior still correct under the flag: same
 *         event sequence, same scoped assistant/tool_use/tool_result shapes,
 *         same result fields, pause-at-first-tool semantics, settle-on-abort.
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
import { sumJournaledCostUsd } from '../native-journal.js';
import { toolError } from '../../tools/tool-types.js';

const dir = join(tmpdir(), `round-engine-shared-${process.pid}`);
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

/** A scripted transport: each callModel returns the next pre-baked round of events. */
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
    classifyError: () => ({ kind: 'rate_limited', raw: { subtype: 'rate_limited', errors: [] } }) as never,
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

/** Round 1: two text deltas + a tool_use; round 2: the final answer (golden scenario). */
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

describe('SUBAGENT_SHARED_LOOP — ON: inherited retry (Task 6 axis 2)', () => {
  it('retries a failing-then-ok model call instead of throwing (legacy throws)', async () => {
    let calls = 0;
    const failing = makeScriptedTransport(script());
    const origCall = failing.callModel.bind(failing);
    failing.callModel = (req) => {
      calls += 1;
      if (calls === 1) throw new Error('transient 529');
      return origCall(req);
    };
    const result = await runSubagentLoop({
      transport: failing,
      model: 'm', system: 'sys', userPrompt: 'go', tools: [echoTool()],
      harness: allowHarness, onPause, maxTurns: 5, childId: 'c', onEvent: () => {},
      sharedLoop: true,
      retry: { maxAttempts: 2, backoffMs: 1 },
    });
    expect(calls).toBeGreaterThanOrEqual(3); // 1 failed + retried round 1 + round 2
    expect(result.text).toBe('final answer');
    expect(result.toolUseCount).toBe(1);
  });

  it('switches to the fallback model after the primary budget exhausts', async () => {
    const attempts: string[] = [];
    const failing = makeScriptedTransport(script());
    const origCall = failing.callModel.bind(failing);
    failing.callModel = (req) => {
      const model = (req as { model: string }).model;
      attempts.push(model);
      if (model === 'm') throw new Error('primary down');
      return origCall(req);
    };
    const result = await runSubagentLoop({
      transport: failing,
      model: 'm', system: 'sys', userPrompt: 'go', tools: [echoTool()],
      harness: allowHarness, onPause, maxTurns: 5, childId: 'c', onEvent: () => {},
      sharedLoop: true,
      retry: { maxAttempts: 2, backoffMs: 1, fallbackModel: 'm-fallback' },
    });
    expect(attempts.slice(0, 3)).toEqual(['m', 'm', 'm-fallback']);
    expect(result.text).toBe('final answer');
    // Cost attributes to the COMMITTED (fallback) model via childCost.model? —
    // childCost.model stays opts.model (node identity); the per-round costUsd
    // flowed through computeCostUsd(usage, committedModel) inside the core.
    expect(result.costUsd).toBeCloseTo(0.00042, 10);
  });
});

describe('SUBAGENT_SHARED_LOOP — ON: source:subagent usage entries (charter c)', () => {
  it('appends one agentPath-tagged usage entry per settled round, AFTER its assistant entry', async () => {
    const j = makeJournal('t-usage');
    const path = [seg(1, 'T1')];
    await runSubagentLoop({
      transport: makeScriptedTransport(script()),
      model: 'm', system: 'sys', userPrompt: 'go', tools: [echoTool()],
      harness: allowHarness, onPause, maxTurns: 5, childId: 'c', onEvent: () => {},
      journal: j, subagentPath: path,
      sharedLoop: true,
    });
    const all = await readAll(j);
    const usage = all.filter((e) => e.payload.type === 'usage');
    expect(usage).toHaveLength(2); // one per settled round
    for (const u of usage) {
      expect(u.agentPath).toEqual(path);
      expect(u.principal).toEqual({ kind: 'system' });
      const raw = (u.payload as Extract<JournalEntry['payload'], { type: 'usage' }>).raw as Record<string, unknown>;
      expect(raw.source).toBe('subagent');
      expect(raw.model).toBe('m');
    }
    const r1 = usage[0].payload as Extract<JournalEntry['payload'], { type: 'usage' }>;
    const r2 = usage[1].payload as Extract<JournalEntry['payload'], { type: 'usage' }>;
    expect((r1.raw as { costUsd: number }).costUsd).toBeCloseTo(0.00015, 10); // (10+5)e-5
    expect((r2.raw as { costUsd: number }).costUsd).toBeCloseTo(0.00027, 10); // (20+7)e-5

    // Journal-vs-billed parity (the P2.1 seed's input): Σ journaled === returned costUsd.
    expect(sumJournaledCostUsd(all)).toBeCloseTo(0.00042, 10);

    // Settlement ordering: round 1's usage entry lands AFTER its assistant entry
    // and BEFORE the round's tool_use entry (usage-right-after-assistant, the
    // same window the main loop keeps).
    const types = all.map((e) => e.payload.type);
    expect(types.indexOf('usage')).toBe(types.indexOf('assistant') + 1);
    expect(types.indexOf('usage')).toBeLessThan(types.indexOf('tool_use'));
  });

  it('OFF keeps the journal usage-free (no shadow writes when the flag is dark)', async () => {
    const j = makeJournal('t-off');
    await runSubagentLoop({
      transport: makeScriptedTransport(script()),
      model: 'm', system: 'sys', userPrompt: 'go', tools: [echoTool()],
      harness: allowHarness, onPause, maxTurns: 5, childId: 'c', onEvent: () => {},
      journal: j, subagentPath: [seg(1, 'T1')],
    });
    const all = await readAll(j);
    expect(all.some((e) => e.payload.type === 'usage')).toBe(false);
  });
});

describe('SUBAGENT_SHARED_LOOP — ON-base: existing behavior preserved (Task 6 axis 3)', () => {
  it('emits the golden event sequence and scoped entry shapes (plus sanctioned usage entries)', async () => {
    const j = makeJournal('t-onbase');
    const path = [seg(1, 'T1')];
    const events: SubagentEvent[] = [];
    const result = await runSubagentLoop({
      transport: makeScriptedTransport(script()),
      model: 'm', system: 'sys', userPrompt: 'go', tools: [echoTool()],
      harness: allowHarness, onPause, maxTurns: 5, childId: 'child-golden',
      onEvent: (ev) => events.push(ev),
      journal: j, subagentPath: path,
      sharedLoop: true,
    });

    // The GOLDEN event sequence — identical to the OFF path.
    expect(events).toEqual([
      { kind: 'text', delta: 'check' },
      { kind: 'text', delta: 'ing' },
      { kind: 'tool_use', subToolUseId: 's1', toolName: 'echo', toolInput: { msg: 'hi' } },
      { kind: 'tool_result', subToolUseId: 's1', result: 'echo:hi', isError: false },
      { kind: 'billing', event: { kind: 'raw', engine: 'native', event: 'agent:tool_billing', data: { taskId: '', toolName: 'echo', toolUseId: 's1', isSubagent: true } } },
      { kind: 'text', delta: 'final answer' },
    ]);

    // The GOLDEN journal shapes, once the sanctioned usage entries are set aside.
    const all = await readAll(j);
    const nonUsage = all.filter((e) => e.payload.type !== 'usage');
    expect(
      nonUsage.map((e) => ({ agentPath: e.agentPath, payload: e.payload })),
    ).toEqual([
      {
        agentPath: path,
        payload: {
          type: 'assistant',
          blocks: [{ type: 'text', text: 'checking' }],
          api: 'fake', provider: 'fake', model: 'm',
        },
      },
      {
        agentPath: path,
        payload: { type: 'tool_use', toolUseId: 's1', name: 'echo', input: { msg: 'hi' } },
      },
      {
        agentPath: path,
        payload: {
          type: 'tool_result', toolUseId: 's1',
          blocks: [{ type: 'text', text: 'echo:hi' }], isError: false,
        },
      },
      {
        agentPath: path,
        payload: {
          type: 'assistant',
          blocks: [{ type: 'text', text: 'final answer' }],
          api: 'fake', provider: 'fake', model: 'm',
        },
      },
    ]);

    // The GOLDEN result fields.
    expect(result.text).toBe('final answer');
    expect(result.toolUseCount).toBe(1);
    expect(result.pausedHalt).toBe(false);
    expect(result.costUsd).toBeCloseTo(0.00042, 10);
    expect(result.usage).toEqual({
      inputTokens: 30, outputTokens: 12,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    });
    expect(result.childCost).toEqual({
      childId: 'child-golden', model: 'm',
      usage: { inputTokens: 30, outputTokens: 12, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      costUsd: result.costUsd,
    });
  });

  it('stops at the FIRST paused tool: no tool_result journaled, pause propagated, later tools undispatched', async () => {
    const j = makeJournal('t-pause');
    const path = [seg(1, 'T1')];
    const executed: string[] = [];
    const gated = {
      gateTool: async (c: ToolCall): Promise<GateResult> =>
        c.toolName === 'needs_ok'
          ? { decision: 'needs_human' as const, interactionKind: 'tool_permission' }
          : { decision: 'allow' as const },
    };
    const tools: RawToolOptions[] = [
      echoTool(),
      {
        name: 'needs_ok', description: 'gated', parameters: z.object({}),
        execute: async () => { executed.push('needs_ok'); return 'ran'; },
      },
    ];
    const rounds: StreamEvent[][] = [
      [
        { kind: 'tool_use', toolUse: { id: 'p1', name: 'needs_ok', input: {} } },
        { kind: 'tool_use', toolUse: { id: 'p2', name: 'echo', input: { msg: 'after' } } },
        { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
    ];
    const result = await runSubagentLoop({
      transport: makeScriptedTransport(rounds),
      model: 'm', system: 'sys', userPrompt: 'go', tools,
      harness: gated, onPause, maxTurns: 5, childId: 'c', onEvent: () => {},
      journal: j, subagentPath: path,
      sharedLoop: true,
    });
    expect(result.pausedHalt).toBe(true);
    expect(result.pauseInfo).toMatchObject({ toolUseId: 'p1', toolName: 'needs_ok' });
    expect(executed).toEqual([]); // the gate paused it — execute never ran
    const all = await readAll(j);
    // p1's tool_use is journaled (the attempt is recorded for re-entry); its
    // result is WITHHELD (the resume materializes it); the batch breaks AT p1,
    // so p2 is never dispatched and never journaled — the legacy pause shape.
    const tus = all.filter((e) => e.payload.type === 'tool_use');
    expect(tus).toHaveLength(1);
    expect((tus[0].payload as Extract<JournalEntry['payload'], { type: 'tool_use' }>).toolUseId).toBe('p1');
    expect(all.some((e) => e.payload.type === 'tool_result')).toBe(false);
  });

  it('settle-on-abort: a mid-stream abort returns the settled cost instead of throwing', async () => {
    const ac = new AbortController();
    // Round 1 completes; round 2's stream aborts mid-flight.
    const rounds = script();
    const t = makeScriptedTransport(rounds);
    const origRead = t.readStream.bind(t);
    let round = 0;
    t.readStream = async function* (stream) {
      round += 1;
      if (round === 2) {
        yield { kind: 'text', text: 'par' } as StreamEvent;
        ac.abort();
        const err = new Error('Request was aborted.');
        err.name = 'AbortError';
        throw err;
      }
      yield* origRead(stream);
    };
    const result = await runSubagentLoop({
      transport: t,
      model: 'm', system: 'sys', userPrompt: 'go', tools: [echoTool()],
      harness: allowHarness, onPause, maxTurns: 5, childId: 'c', onEvent: () => {},
      signal: ac.signal,
      sharedLoop: true,
    });
    // Round 1's settled cost survives ((10+5)e-5); the aborted round folds nothing.
    expect(result.costUsd).toBeCloseTo(0.00015, 10);
    expect(result.toolUseCount).toBe(1);
  });
});

describe('TOOL_ERROR_TAXONOMY inside the subagent (P2.2 charter a — execCtx threading)', () => {
  const sentinelRounds = (): StreamEvent[][] => [
    [
      { kind: 'tool_use', toolUse: { id: 'e1', name: 'flaky', input: {} } },
      { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
    [
      { kind: 'text', text: 'done anyway' },
      { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
  ];
  const flakyTool = (): RawToolOptions => ({
    name: 'flaky',
    description: 'returns a typed sentinel',
    parameters: z.object({}),
    execute: async () => toolError('timeout', 'Command failed: slept too long'),
  });

  for (const sharedLoop of [false, true]) {
    const label = sharedLoop ? 'shared loop' : 'legacy loop';
    it(`${label} + flag ON: a sentinel maps to isError:true with the [error:<code>] stamp`, async () => {
      const events: SubagentEvent[] = [];
      await runSubagentLoop({
        transport: makeScriptedTransport(sentinelRounds()),
        model: 'm', system: 'sys', userPrompt: 'go', tools: [flakyTool()],
        harness: allowHarness, onPause, maxTurns: 5, childId: 'c',
        onEvent: (ev) => events.push(ev),
        toolErrorTaxonomy: true,
        ...(sharedLoop ? { sharedLoop: true } : {}),
      });
      const tr = events.find((e) => e.kind === 'tool_result') as Extract<SubagentEvent, { kind: 'tool_result' }>;
      expect(tr.isError).toBe(true);
      expect(tr.result).toBe('Command failed: slept too long [error:timeout]');
    });

    it(`${label} + flag OFF: the sentinel unwraps to its message, isError:false (byte-identical)`, async () => {
      const events: SubagentEvent[] = [];
      await runSubagentLoop({
        transport: makeScriptedTransport(sentinelRounds()),
        model: 'm', system: 'sys', userPrompt: 'go', tools: [flakyTool()],
        harness: allowHarness, onPause, maxTurns: 5, childId: 'c',
        onEvent: (ev) => events.push(ev),
        ...(sharedLoop ? { sharedLoop: true } : {}),
      });
      const tr = events.find((e) => e.kind === 'tool_result') as Extract<SubagentEvent, { kind: 'tool_result' }>;
      expect(tr.isError).toBe(false);
      expect(tr.result).toBe('Command failed: slept too long');
    });
  }
});
