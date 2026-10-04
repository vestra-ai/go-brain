/**
 * round-engine.tool-result-name.test.ts — the live-streamed tool_result block
 * carries the dispatched tool's name, on BOTH the sequential and the concurrent
 * (parallel Agent-batch) executors.
 *
 * Telemetry provenance only. The wire's AGENT_TOOL_RESULT never carried a tool
 * name, so the server's tool_executed / $ai_span / tools_used all logged
 * 'unknown' whenever span pairing missed (an empty callId on the OpenAI arm).
 * The name is in scope here at the yield site (`tu.name`); carrying it forward
 * is what lets the relay resolve a real name. Never rendered.
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

/** The live-streamed tool_result blocks the sink would emit, in yield order. */
function toolResults(events: HarnessEvent[]): Array<{ toolUseId: string; toolName: string | undefined }> {
  return events
    .filter((e): e is Extract<HarnessEvent, { kind: 'block' }> => e.kind === 'block')
    .map((e) => e.block as ContentBlock)
    .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
    .map((b) => ({ toolUseId: b.toolUseId, toolName: b.toolName }));
}

describe('round-engine — tool_result block carries the tool name (telemetry provenance)', () => {
  it('SEQUENTIAL: the yielded tool_result names the dispatched tool', async () => {
    const tool: RawToolOptions = {
      name: 'Bash', description: 'run', parameters: z.object({}),
      execute: async () => 'ran',
    };
    const transport = makeScriptedTransport([[toolUse('s1', 'Bash', {}), doneEv()]]);
    const { events } = await drive(
      mainDeps(transport, { tools: [tool] }),
      freshState(),
    );
    expect(toolResults(events)).toEqual([{ toolUseId: 's1', toolName: 'Bash' }]);
  });

  it('SEQUENTIAL: an UNKNOWN tool still names what the model asked for', async () => {
    // No matching definition → the engine answers "Unknown tool: X" without
    // dispatching. The telemetry still wants the requested name, not 'unknown'.
    const transport = makeScriptedTransport([[toolUse('s2', 'NotARealTool', {}), doneEv()]]);
    const { events } = await drive(mainDeps(transport, { tools: [] }), freshState());
    expect(toolResults(events)).toEqual([{ toolUseId: 's2', toolName: 'NotARealTool' }]);
  });

  it('PARALLEL: every result in an Agent batch names its own tool', async () => {
    const agentDef: RawToolOptions = {
      name: 'Agent', description: 'fake subagent', parameters: z.object({ run: z.string() }),
      execute: async () => 'agent:done',
    };
    const transport = makeScriptedTransport([[
      toolUse('a1', 'Agent', { run: 'r1' }),
      toolUse('a2', 'Agent', { run: 'r2' }),
      doneEv(),
    ]]);
    const { events } = await drive(
      mainDeps(transport, { tools: [agentDef] }),
      freshState(),
    );
    const results = toolResults(events);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.toolName === 'Agent')).toBe(true);
  });

  it('SEQUENTIAL: a paused tool_result still names its tool (pause is a typed outcome)', async () => {
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
    const { events } = await drive(
      mainDeps(transport, {
        harness: pausingHarness,
        dispatcher: createNativeHookDispatcher(pausingHarness),
        tools: [tool],
      }),
      freshState(),
    );
    expect(toolResults(events)).toEqual([{ toolUseId: 'p1', toolName: 'needs_ok' }]);
  });
});
