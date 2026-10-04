/**
 * Orchestration walls, D4 (second half) — TEN Agent calls per assistant message, not
 * twelve. One message must not be able to fill half the 20-slot tree.
 *
 * The cap is not observable as a number, so each case DRIVES a real main-loop round with
 * a concurrent Agent batch and then measures the memoized `:turnbatch` pool by saturating
 * it: the count of bodies that reach their first await IS the effective limit. A test that
 * only read the constant would pass even if the ternary never reached the pool.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { RawToolOptions } from '../../tools/tool-types.js';
import type {
  NormalizedUsage,
  ProviderHistory,
  ProviderStream,
  StreamEvent,
  Transport,
} from '../transport.js';
import { createRunContext } from '../run-context.js';
import { createNativeHookDispatcher } from '../native-hooks.js';
import { runOneRound, batchPoolKey, type RoundDeps, type RoundState } from '../round-engine.js';
import { MAIN_TURN_BATCH_CONCURRENCY } from '../round-tool-batch.js';
import { SUBAGENT_MESSAGE_CONCURRENCY } from '../subagent-walls.js';
import { getSubagentPool, _poolKeysForTest } from '../subagent-pool.js';

const allow = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };
const fakeAgent: RawToolOptions = {
  name: 'Agent',
  description: 'spawn',
  parameters: z.object({}).passthrough(),
  execute: async () => 'child done',
};

function scripted(rounds: StreamEvent[][]): Transport {
  let i = 0;
  const t: Partial<Transport> = {
    api: 'fake', provider: 'fake', defaultModel: () => 'm',
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
    classifyError: () => ({ kind: 'rate_limited', raw: { subtype: 'rate_limited', errors: [] } }) as never,
  };
  return t as Transport;
}

const freshState = (): RoundState => ({
  assistantText: '', thinkingBlocks: [], toolUses: [], roundAppended: false,
  inToolBatch: false, stopReason: null,
  lastUsage: { inputTokens: 0, outputTokens: 0 }, lastUsageModel: 'm',
});

/** Two consecutive Agent calls — the smallest batch partitionToolBatch runs concurrently. */
const twoAgentCalls: StreamEvent[] = [
  { kind: 'tool_use', toolUse: { id: 'a', name: 'Agent', input: { prompt: 'x' } } },
  { kind: 'tool_use', toolUse: { id: 'b', name: 'Agent', input: { prompt: 'y' } } },
  { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
];

/** Drive ONE main-loop round with a concurrent Agent batch on `taskId`. */
async function runMainRound(taskId: string, walls: boolean): Promise<void> {
  const t = scripted([twoAgentCalls]);
  const deps = {
    ctx: { taskId, sessionId: 's', cwd: '', model: 'm', config: {}, signal: new AbortController().signal },
    cfg: walls ? { subagentWalls: true } : {},
    transport: t, rc: createRunContext(taskId), harness: allow,
    dispatcher: createNativeHookDispatcher(allow),
    tools: [fakeAgent], providerTools: [], system: 'sys', onPause: async () => 'PAUSED',
    onAuthHalt: undefined, requestedModel: 'm', cachePrefixHint: undefined,
    history: t.emptyHistory(), turnBlocks: [], pendingTodoBlocks: [],
  } as unknown as RoundDeps;
  const gen = runOneRound(deps, freshState());
  let n = await gen.next();
  while (!n.done) n = await gen.next();
}

/** Saturate the memoized `:turnbatch` pool and report how many bodies ran at once. */
async function effectiveLimit(taskId: string): Promise<number> {
  const key = batchPoolKey(taskId);
  // If the round never acquired the pool there is nothing to measure — say so loudly
  // rather than minting a fresh pool here and reporting its own limit.
  expect(_poolKeysForTest(), 'the round never acquired a :turnbatch pool').toContain(key);
  const pool = getSubagentPool(key, 999);
  let started = 0;
  let open!: () => void;
  const held = new Promise<void>((r) => { open = r; });
  const runs = Array.from({ length: 25 }, () =>
    pool.run(async () => { started += 1; await held; }));
  await new Promise((r) => setTimeout(r, 0));
  const limit = started;
  open();
  await Promise.all(runs);
  return limit;
}

describe('per-message concurrency — 10 under the walls, 12 without', () => {
  it('walls ON: one assistant message runs at most SUBAGENT_MESSAGE_CONCURRENCY children', async () => {
    await runMainRound('pm-on', true);
    expect(await effectiveLimit('pm-on')).toBe(SUBAGENT_MESSAGE_CONCURRENCY);
    expect(SUBAGENT_MESSAGE_CONCURRENCY).toBe(10);
  });

  it('walls OFF: the existing cap is untouched, byte-identical to today', async () => {
    await runMainRound('pm-off', false);
    expect(await effectiveLimit('pm-off')).toBe(MAIN_TURN_BATCH_CONCURRENCY);
    expect(MAIN_TURN_BATCH_CONCURRENCY).toBe(12);
  });

  it('the two caps differ, so neither leg of the ternary can be dead code', () => {
    expect(SUBAGENT_MESSAGE_CONCURRENCY).not.toBe(MAIN_TURN_BATCH_CONCURRENCY);
  });
});
