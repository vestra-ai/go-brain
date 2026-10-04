/**
 * Orchestration walls, D3 — a delegated helper may not hand its whole piece to one child.
 *
 * RED pin (pre-wall): a nested round whose only tool call is a single `Agent` spawn
 * dispatched it, so a helper could relay its entire assignment down one more level —
 * the chain that recursed five deep on prod task 95076757. Under the walls that lone
 * call is refused as a normal tool result (LONE_CHILD_REFUSAL, isError) and NEVER
 * dispatched; two or more siblings in one round, or one call carrying `children[]` of
 * two or more, are a real fan-out and pass. Flag off ⇒ the lone child spawns as today.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { RawToolOptions } from '../../tools/tool-types.js';
import type { StreamEvent, Transport, NormalizedUsage, ProviderHistory, ProviderStream } from '../transport.js';
import { runSubagentLoop } from '../subagent-runner.js';
import { LONE_CHILD_REFUSAL } from '../subagent-walls.js';
import { createRunContext } from '../run-context.js';
import { createNativeHookDispatcher } from '../native-hooks.js';
import { runOneRound, type RoundDeps, type RoundState } from '../round-engine.js';

type Entry = { role: string; text?: string; r?: { toolUseId: string; text: string; isError?: boolean } };
function scripted(rounds: StreamEvent[][]): { t: Transport; history: () => Entry[] } {
  let i = 0;
  let last: Entry[] = [];
  const t: Partial<Transport> = {
    api: 'fake', provider: 'fake', defaultModel: () => 'm',
    emptyHistory: () => { last = []; return last as unknown as ProviderHistory; },
    pushUser: (h, text) => { (h as unknown as Entry[]).push({ role: 'user', text }); },
    pushAssistant: (h) => { (h as unknown as Entry[]).push({ role: 'assistant' }); },
    pushToolResult: (h, r) => { (h as unknown as Entry[]).push({ role: 'tool_result', r: r as never }); },
    buildTools: (raw) => raw as unknown[],
    callModel: () => (rounds[i++] ?? [{ kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }]) as unknown as ProviderStream,
    // eslint-disable-next-line require-yield
    readStream: async function* (stream) { for (const ev of stream as StreamEvent[]) yield ev; },
    computeCostUsd: (u: NormalizedUsage) => (u.inputTokens + u.outputTokens) * 0.00001,
    classifyError: () => ({ kind: 'rate_limited', raw: { subtype: 'rate_limited', errors: [] } }) as never,
  };
  return { t: t as Transport, history: () => last };
}
const allow = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };
let spawns = 0;
const fakeAgent: RawToolOptions = {
  name: 'Agent', description: 'spawn', parameters: z.object({}).passthrough(),
  execute: async () => { spawns += 1; return 'child done'; },
};
let reads = 0;
const fakeRead: RawToolOptions = {
  name: 'Read', description: 'read', parameters: z.object({}).passthrough(),
  execute: async () => { reads += 1; return 'file contents'; },
};
const agentCall = (id: string, input: unknown): StreamEvent[] => [
  { kind: 'tool_use', toolUse: { id, name: 'Agent', input } },
  { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
];
const finish: StreamEvent[] = [{ kind: 'text', text: 'ok' }, { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }];
const run = (t: Transport, walls: boolean) => runSubagentLoop({
  transport: t, model: 'm', system: 'sys', userPrompt: 'go', tools: [fakeAgent], harness: allow,
  onPause: async () => 'PAUSED', maxTurns: 5, onEvent: () => {}, sharedLoop: true, ...(walls ? { walls: true } : {}),
} as never);

/**
 * The MAIN loop's RoundDeps (the `rc`-bearing variant of the union). D3 keys on
 * `deps.sub !== undefined`, so the only way to pin that clause is to drive the OTHER
 * caller of the same round core with the walls cfg on.
 */
const freshState = (): RoundState => ({
  assistantText: '', thinkingBlocks: [], toolUses: [], roundAppended: false,
  inToolBatch: false, stopReason: null,
  lastUsage: { inputTokens: 0, outputTokens: 0 }, lastUsageModel: 'm',
});
async function runMainRound(t: Transport): Promise<{ results: { text: string }[] }> {
  const deps = {
    ctx: { taskId: 't', sessionId: 's', cwd: '', model: 'm', config: {}, signal: new AbortController().signal },
    cfg: { subagentWalls: true },
    transport: t, rc: createRunContext('t'), harness: allow,
    dispatcher: createNativeHookDispatcher(allow),
    tools: [fakeAgent], providerTools: [], system: 'sys', onPause: async () => 'PAUSED',
    onAuthHalt: undefined, requestedModel: 'm', cachePrefixHint: undefined,
    history: t.emptyHistory(), turnBlocks: [], pendingTodoBlocks: [],
  } as unknown as RoundDeps;
  const gen = runOneRound(deps, freshState());
  let n = await gen.next();
  while (!n.done) n = await gen.next();
  return { results: n.value.results as { text: string }[] };
}

describe('nested batch — a lone child is refused under the walls', () => {
  it('ONE Agent call in a nested round is refused with LONE_CHILD_REFUSAL and never spawns', async () => {
    spawns = 0;
    const { t, history } = scripted([agentCall('tu-1', { subagent_type: 'researcher', prompt: 'dig deeper' }), finish]);
    await run(t, true);
    expect(spawns).toBe(0);
    const results = history().filter((e) => e.role === 'tool_result').map((e) => e.r!);
    expect(results[0]).toMatchObject({ toolUseId: 'tu-1', text: LONE_CHILD_REFUSAL, isError: true });
  });
  it('TWO Agent calls in one nested round both spawn', async () => {
    spawns = 0;
    const two: StreamEvent[] = [
      { kind: 'tool_use', toolUse: { id: 'a', name: 'Agent', input: { prompt: 'x' } } },
      { kind: 'tool_use', toolUse: { id: 'b', name: 'Agent', input: { prompt: 'y' } } },
      { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
    ];
    const { t } = scripted([two, finish]);
    await run(t, true);
    expect(spawns).toBe(2);
  });
  it('ONE Agent call carrying children[] of two is a parallel batch and passes', async () => {
    spawns = 0;
    const { t } = scripted([agentCall('tu-1', { children: [{ prompt: 'x' }, { prompt: 'y' }] }), finish]);
    await run(t, true);
    expect(spawns).toBe(1);
  });
  it('flag OFF: a lone child spawns as today', async () => {
    spawns = 0;
    const { t } = scripted([agentCall('tu-1', { prompt: 'x' }), finish]);
    await run(t, false);
    expect(spawns).toBe(1);
  });
  it('a MIXED nested round refuses the lone Agent call and still runs its sibling tool', async () => {
    spawns = 0; reads = 0;
    const mixed: StreamEvent[] = [
      { kind: 'tool_use', toolUse: { id: 'r-1', name: 'Read', input: { path: 'a.ts' } } },
      { kind: 'tool_use', toolUse: { id: 'tu-1', name: 'Agent', input: { prompt: 'x' } } },
      { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
    ];
    const { t, history } = scripted([mixed, finish]);
    await runSubagentLoop({
      transport: t, model: 'm', system: 'sys', userPrompt: 'go', tools: [fakeAgent, fakeRead],
      harness: allow, onPause: async () => 'PAUSED', maxTurns: 5, onEvent: () => {},
      sharedLoop: true, walls: true,
    } as never);
    // The sibling is untouched by the wall; only the lone Agent call is refused.
    expect(reads).toBe(1);
    expect(spawns).toBe(0);
    const results = history().filter((e) => e.role === 'tool_result').map((e) => e.r!);
    expect(results.map((r) => r.toolUseId)).toEqual(['r-1', 'tu-1']);
    expect(results[0].text).toBe('file contents');
    expect(results[1]).toMatchObject({ text: LONE_CHILD_REFUSAL, isError: true });
  });
  it('the refusal reports itself to onSubagentRefused, so the spawner counts it', async () => {
    spawns = 0;
    const kinds: string[] = [];
    const { t } = scripted([agentCall('tu-1', { prompt: 'x' }), finish]);
    await runSubagentLoop({
      transport: t, model: 'm', system: 'sys', userPrompt: 'go', tools: [fakeAgent], harness: allow,
      onPause: async () => 'PAUSED', maxTurns: 5, onEvent: () => {}, sharedLoop: true, walls: true,
      onSubagentRefused: (k: string) => kinds.push(k),
    } as never);
    expect(spawns).toBe(0);
    expect(kinds).toEqual(['lone_child']);
  });
  it('the refusal is counted at DELIVERY, not at the decision — a batch that stops first counts none', async () => {
    // The batch DECIDES the refusal before it dispatches anything. If a sibling pauses the
    // batch before the refused tool_use is reached, the model never receives the refusal —
    // and a refusal nobody was told about is not a wall the run hit. Here the FIRST tool
    // pauses, so the lone Agent call behind it is never delivered and never counted.
    const kinds: string[] = [];
    const pausedThenAgent: StreamEvent[] = [
      { kind: 'tool_use', toolUse: { id: 'r-1', name: 'Read', input: { path: 'a.ts' } } },
      { kind: 'tool_use', toolUse: { id: 'tu-1', name: 'Agent', input: { prompt: 'x' } } },
      { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
    ];
    const { t, history } = scripted([pausedThenAgent, finish]);
    await runSubagentLoop({
      transport: t, model: 'm', system: 'sys', userPrompt: 'go', tools: [fakeAgent, fakeRead],
      harness: {
        gateTool: async (c: ToolCall): Promise<GateResult> =>
          c.toolCallId === 'r-1' ? { decision: 'needs_human', interactionKind: 'ask' } : { decision: 'allow' },
      },
      onPause: async () => 'PAUSED', maxTurns: 5, onEvent: () => {}, sharedLoop: true, walls: true,
      onSubagentRefused: (k: string) => kinds.push(k),
    } as never);
    // The lone Agent call was never answered, so nothing was refused to anyone.
    const answered = history().filter((e) => e.role === 'tool_result').map((e) => e.r!.toolUseId);
    expect(answered).not.toContain('tu-1');
    expect(kinds).toEqual([]);
  });
  it('a real fan-out reports NOTHING — the sink only ever hears about a refusal', async () => {
    spawns = 0;
    const kinds: string[] = [];
    const two: StreamEvent[] = [
      { kind: 'tool_use', toolUse: { id: 'a', name: 'Agent', input: { prompt: 'x' } } },
      { kind: 'tool_use', toolUse: { id: 'b', name: 'Agent', input: { prompt: 'y' } } },
      { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
    ];
    const { t } = scripted([two, finish]);
    await runSubagentLoop({
      transport: t, model: 'm', system: 'sys', userPrompt: 'go', tools: [fakeAgent], harness: allow,
      onPause: async () => 'PAUSED', maxTurns: 5, onEvent: () => {}, sharedLoop: true, walls: true,
      onSubagentRefused: (k: string) => kinds.push(k),
    } as never);
    expect(spawns).toBe(2);
    expect(kinds).toEqual([]);
  });
  it('a LEAF (no Agent tool) that emits one Agent call gets Unknown tool, and counts as no refusal', async () => {
    // D3 binds a holder that CAN delegate. A leaf has no Agent tool to split work across,
    // so LONE_CHILD_REFUSAL ("split it into two ... and launch them together") is advice it
    // cannot act on. It gets the plain unknown-tool answer, and the tree's refusal tally
    // stays clean — a leaf hallucination is not a wall the orchestration hit.
    const kinds: string[] = [];
    const { t, history } = scripted([agentCall('tu-1', { prompt: 'x' }), finish]);
    await runSubagentLoop({
      transport: t, model: 'm', system: 'sys', userPrompt: 'go', tools: [fakeRead], harness: allow,
      onPause: async () => 'PAUSED', maxTurns: 5, onEvent: () => {}, sharedLoop: true, walls: true,
      onSubagentRefused: (k: string) => kinds.push(k),
    } as never);
    const results = history().filter((e) => e.role === 'tool_result').map((e) => e.r!);
    expect(results[0]).toMatchObject({ toolUseId: 'tu-1', text: 'Unknown tool: Agent', isError: true });
    expect(kinds).toEqual([]);
  });
  it('the MAIN turn is not a delegated helper: one Agent call still dispatches under the walls', async () => {
    spawns = 0;
    const { t } = scripted([agentCall('tu-1', { prompt: 'x' })]);
    const { results } = await runMainRound(t);
    // D3 binds a helper that was handed one piece, never the turn the person asked for.
    expect(spawns).toBe(1);
    expect(results.map((r) => r.text)).not.toContain(LONE_CHILD_REFUSAL);
  });
});
