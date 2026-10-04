/**
 * Task 3 — display enrichment for EVERY tool, not only `Skill`
 * (packages/agent-sdk/src/engine/round-tool-batch.ts:374-380 and :636-642).
 *
 * The ToolDisplayPort (cfg.toolDisplay) used to be invoked only when
 * `tu.name === 'Skill'`; every other tool's persisted tool_use block carried
 * no `display`. These tests prove the port is asked for every tool in a
 * batch — on BOTH the sequential-segment path (beginSequentialToolUse,
 * :636-642) and the concurrent-run path (startConcurrentDispatches,
 * :374-380) — while Skill's existing behaviour (enrichment + cfg.abilities
 * threading) stays intact.
 *
 * Harness copied from ./round-engine.mixed-batch.test.ts (not exported
 * there — see that file for the fuller mixed-batch/partition test suite).
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { ContentBlock, ToolUseBlock } from '../../contract/blocks.js';
import type { ActiveAbility } from '../../contract/active-ability.js';
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
import type { ToolDisplayPort } from '../../ports/tool-display-port.js';

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
  while (!n.done) {
    events.push(n.value);
    n = await gen.next();
  }
  return { events, round: n.value };
}

const doneEv = (stop = 'tool_use'): StreamEvent =>
  ({ kind: 'done', stopReason: stop, usage: { inputTokens: 1, outputTokens: 1 } });

const toolUse = (id: string, name: string, input: unknown): StreamEvent =>
  ({ kind: 'tool_use', toolUse: { id, name, input } });

/** The batch's persisted tool_use blocks, in turnBlocks order. */
const persistedToolUses = (blocks: ContentBlock[]): ToolUseBlock[] =>
  blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use');

function bashDef(opts: { concurrencySafe?: boolean } = {}): RawToolOptions {
  return {
    name: 'Bash',
    description: 'fake Bash',
    parameters: z.object({ command: z.string(), description: z.string().optional() }),
    ...(opts.concurrencySafe ? { concurrencySafe: true as const } : {}),
    execute: async () => 'Bash:done',
  };
}

function readDef(opts: { concurrencySafe?: boolean } = {}): RawToolOptions {
  return {
    name: 'Read',
    description: 'fake Read',
    parameters: z.object({ file_path: z.string() }),
    ...(opts.concurrencySafe ? { concurrencySafe: true as const } : {}),
    execute: async () => 'Read:done',
  };
}

function skillDef(): RawToolOptions {
  return {
    name: 'Skill',
    description: 'fake Skill',
    parameters: z.object({ command: z.string() }),
    execute: async () => 'Skill:done',
  };
}

/** Records every enrich() call's toolName, in call order; returns a fixed display. */
function recorder() {
  const calls: string[] = [];
  const port: ToolDisplayPort = {
    enrich: (call) => {
      calls.push(call.toolName);
      return { category: 'regular', displayText: `Enriched ${call.toolName}` };
    },
  };
  return { port, calls };
}

describe('round-tool-batch display enrichment (Task 3 — every tool, not only Skill)', () => {
  it('asks the ToolDisplayPort for every tool in a SEQUENTIAL segment (Bash, Read)', async () => {
    const { port, calls } = recorder();
    const transport = makeScriptedTransport([[
      toolUse('b1', 'Bash', { command: 'ls', description: 'List files' }),
      toolUse('r1', 'Read', { file_path: '/a' }),
      doneEv(),
    ]]);
    const turnBlocks: ContentBlock[] = [];
    const st = freshState();
    const { round } = await drive(
      mainDeps(transport, { cfg: { toolDisplay: port }, tools: [bashDef(), readDef()], turnBlocks }),
      st,
    );

    // The port sees BOTH tools, in batch order — no longer gated to Skill.
    expect(calls).toEqual(['Bash', 'Read']);
    expect(round.results.map((r) => r.text)).toEqual(['Bash:done', 'Read:done']);

    const persisted = persistedToolUses(turnBlocks);
    expect(persisted.map((b) => b.toolUseId)).toEqual(['b1', 'r1']);
    expect(persisted[0].display?.displayText).toBe('Enriched Bash');
    expect(persisted[1].display?.displayText).toBe('Enriched Read');
  });

  it('asks the ToolDisplayPort for every tool in a CONCURRENT run too (concurrencySafe)', async () => {
    const { port, calls } = recorder();
    const transport = makeScriptedTransport([[
      toolUse('b1', 'Bash', { command: 'ls', description: 'List files' }),
      toolUse('r1', 'Read', { file_path: '/a' }),
      doneEv(),
    ]]);
    const turnBlocks: ContentBlock[] = [];
    const st = freshState();
    await drive(
      mainDeps(transport, {
        cfg: { toolDisplay: port },
        tools: [bashDef({ concurrencySafe: true }), readDef({ concurrencySafe: true })],
        turnBlocks,
      }),
      st,
    );

    // PASS 1 computes/yields each tool's display synchronously in batch order,
    // before any dispatch settles — so call order is deterministic even though
    // the two tools execute concurrently.
    expect(calls).toEqual(['Bash', 'Read']);
    const persisted = persistedToolUses(turnBlocks);
    expect(persisted.map((b) => b.toolUseId)).toEqual(['b1', 'r1']);
    expect(persisted[0].display?.displayText).toBe('Enriched Bash');
    expect(persisted[1].display?.displayText).toBe('Enriched Read');
  });

  it('still enriches Skill (existing behaviour) and threads cfg.abilities through unchanged', async () => {
    const abilities = [{ id: 'ability-1' }] as unknown as ActiveAbility[];
    const calls: string[] = [];
    let receivedAbilities: ActiveAbility[] | undefined;
    const port: ToolDisplayPort = {
      enrich: (call, ab) => {
        calls.push(call.toolName);
        receivedAbilities = ab;
        return { category: 'skill', displayText: 'Enriched Skill' };
      },
    };
    const transport = makeScriptedTransport([[
      toolUse('s1', 'Skill', { command: 'brainstorming' }),
      doneEv(),
    ]]);
    const turnBlocks: ContentBlock[] = [];
    const st = freshState();
    await drive(
      mainDeps(transport, { cfg: { toolDisplay: port, abilities }, tools: [skillDef()], turnBlocks }),
      st,
    );

    expect(calls).toEqual(['Skill']);
    expect(receivedAbilities).toBe(abilities);
    const persisted = persistedToolUses(turnBlocks);
    expect(persisted[0].display?.displayText).toBe('Enriched Skill');
  });
});
