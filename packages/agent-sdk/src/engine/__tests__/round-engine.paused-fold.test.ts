/**
 * round-engine.paused-fold.test.ts — a pausedHalt tool folds `status:'paused'`,
 * `isError:false` onto its persisted tool_use block, on BOTH the sequential and
 * the concurrent (parallel Agent-batch) executors.
 *
 * The persisted block (turnBlocks) is what MESSAGE_COMPLETE journals and the FE
 * renders on reload. Before this change the fold wrote `status:'error'` for a
 * pause; now a pause is typed — `status:'paused'` drives the "needs you"
 * affordance, never a red error chip.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { ContentBlock } from '../../contract/blocks.js';
import type { RawToolOptions } from '../../tools/tool-types.js';
import type {
  StreamEvent,
  Transport,
  NormalizedUsage,
  ProviderHistory,
  ProviderStream,
} from '../transport.js';
import { createRunContext } from '../run-context.js';
import { createNativeHookDispatcher } from '../native-hooks.js';
import { runOneRound, type RoundDeps, type RoundState } from '../round-engine.js';

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
const onPause = async (): Promise<string> => 'PAUSED_HALT';

const freshState = (): RoundState => ({
  assistantText: '',
  thinkingBlocks: [],
  toolUses: [],
  roundAppended: false,
  inToolBatch: false,
  stopReason: null,
  lastUsage: { inputTokens: 0, outputTokens: 0 },
  lastUsageModel: 'm',
});

function mainDeps(transport: Transport, over: Partial<RoundDeps> = {}): RoundDeps {
  return {
    ctx: { taskId: 't', sessionId: 's', cwd: '', model: 'm', config: {}, signal: new AbortController().signal },
    cfg: {},
    transport,
    rc: createRunContext('t'),
    harness: allowHarness,
    dispatcher: createNativeHookDispatcher(allowHarness),
    tools: [],
    providerTools: [],
    system: 'sys',
    onPause,
    onAuthHalt: undefined,
    requestedModel: 'm',
    cachePrefixHint: undefined,
    history: transport.emptyHistory(),
    turnBlocks: [],
    pendingTodoBlocks: [],
    ...over,
  } as RoundDeps;
}

async function drive(deps: RoundDeps, st: RoundState) {
  const events: HarnessEvent[] = [];
  const gen = runOneRound(deps, st);
  let n = await gen.next();
  while (!n.done) { events.push(n.value); n = await gen.next(); }
  return { events, round: n.value };
}

const toolUse = (id: string, name: string, input: unknown): StreamEvent =>
  ({ kind: 'tool_use', toolUse: { id, name, input } });
const doneEv = (stop = 'tool_use'): StreamEvent =>
  ({ kind: 'done', stopReason: stop, usage: { inputTokens: 1, outputTokens: 1 } });

const tuBlock = (blocks: ContentBlock[], id: string) =>
  blocks.find((b) => (b as { type: string; toolUseId?: string }).type === 'tool_use'
    && (b as { toolUseId?: string }).toolUseId === id) as unknown as { status?: string; isError?: boolean } | undefined;

describe('round-engine — pausedHalt fold (persisted block truth)', () => {
  it('SEQUENTIAL: a paused tool folds status:paused, isError:false onto its persisted block', async () => {
    const turnBlocks: ContentBlock[] = [];
    const pausingHarness = {
      gateTool: async (c: ToolCall): Promise<GateResult> =>
        c.toolName === 'needs_ok'
          ? ({ decision: 'needs_human', interactionKind: 'tool_permission' } as GateResult)
          : ({ decision: 'allow' } as GateResult),
    };
    const tool: RawToolOptions = {
      name: 'needs_ok', description: 'gated', parameters: z.object({}),
      execute: async () => 'ran',
    };
    const transport = makeScriptedTransport([[toolUse('p1', 'needs_ok', {}), doneEv()]]);
    await drive(
      mainDeps(transport, {
        harness: pausingHarness,
        dispatcher: createNativeHookDispatcher(pausingHarness),
        tools: [tool],
        turnBlocks,
      }),
      freshState(),
    );
    const pb = tuBlock(turnBlocks, 'p1');
    expect(pb?.status).toBe('paused');
    expect(pb?.isError).toBe(false);
  });

  it('PARALLEL: a paused Agent sibling folds status:paused, isError:false; the completed sibling folds completed', async () => {
    const turnBlocks: ContentBlock[] = [];
    // a2 pauses at the GATE; a1 runs and completes.
    const pausingHarness = {
      gateTool: async (c: ToolCall): Promise<GateResult> =>
        c.toolCallId === 'a2'
          ? ({ decision: 'needs_human', interactionKind: 'tool_permission' } as GateResult)
          : ({ decision: 'allow' } as GateResult),
    };
    const agentDef: RawToolOptions = {
      name: 'Agent', description: 'fake subagent', parameters: z.object({ run: z.string() }),
      execute: async () => 'agent:done',
    };
    const transport = makeScriptedTransport([[
      toolUse('a1', 'Agent', { run: 'r1' }),
      toolUse('a2', 'Agent', { run: 'r1' }),
      doneEv(),
    ]]);
    await drive(
      mainDeps(transport, {
        harness: pausingHarness,
        dispatcher: createNativeHookDispatcher(pausingHarness),
        tools: [agentDef],
        turnBlocks,
      }),
      freshState(),
    );
    const paused = tuBlock(turnBlocks, 'a2');
    expect(paused?.status).toBe('paused');
    expect(paused?.isError).toBe(false);
    const completed = tuBlock(turnBlocks, 'a1');
    expect(completed?.status).toBe('completed');
    expect(completed?.isError).toBe(false);
  });
});
