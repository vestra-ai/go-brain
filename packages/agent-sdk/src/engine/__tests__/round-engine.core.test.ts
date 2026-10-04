/**
 * P2.2 (Task 6, step 4) — direct unit coverage of round-engine.ts's MAIN-caller
 * paths that the integration suites reach only through real providers: the
 * thinking/ordered-blocks channels, the reasoning attach, the push-event drain,
 * unknown tools on both batch flavors, the usage-append never-throw catch, the
 * retry helper's abort/recovery/exhaustion edges, and the subagent
 * settle-on-abort at the model-call boundary. Together with the conformance
 * suites (main caller) and round-engine.shared.test.ts (subagent caller) this
 * carries the shared-file statement coverage past the spec's ≥90% gate.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { RawToolOptions } from '../../tools/tool-types.js';
import type {
  StreamEvent,
  Transport,
  NormalizedUsage,
  ProviderHistory,
  ProviderStream,
} from '../transport.js';
import type { Journal } from '../../kernel/index.js';
import { createRunContext } from '../run-context.js';
import { createNativeHookDispatcher } from '../native-hooks.js';
import {
  runOneRound,
  startStreamWithRetry,
  type RoundDeps,
  type RoundState,
} from '../round-engine.js';

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

/** Main-caller deps with overridable pieces (rc + dispatcher = the main union branch). */
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

const doneEv = (stop = 'end_turn', inTok = 1, outTok = 1): StreamEvent =>
  ({ kind: 'done', stopReason: stop, usage: { inputTokens: inTok, outputTokens: outTok } });

describe('runOneRound — main-caller channels (direct drive)', () => {
  it('thinking deltas yield live; signed thinking blocks collect and lead the in-memory assistant fold', async () => {
    const transport = makeScriptedTransport([[
      { kind: 'thinking', text: 'hmm' } as StreamEvent,
      { kind: 'thinking_block', thinking: 'hmm done', signature: 'sig1' } as StreamEvent,
      { kind: 'text', text: 'answer' },
      doneEv(),
    ]]);
    const history = transport.emptyHistory();
    const st = freshState();
    const { events } = await drive(mainDeps(transport, { history }), st);
    expect(events.some((e) => e.kind === 'block' && (e as { block: { type: string } }).block.type === 'thinking')).toBe(true);
    expect(st.thinkingBlocks).toEqual([{ type: 'thinking', thinking: 'hmm done', signature: 'sig1' }]);
    // In-memory fold: thinking leads, then text.
    const pushed = (history as unknown as Array<{ role: string; blocks?: unknown[] }>).find((m) => m.role === 'assistant');
    expect(pushed?.blocks?.[0]).toMatchObject({ type: 'thinking', thinking: 'hmm done' });
  });

  it('thinking_start stream event surfaces as a thinking_start HarnessEvent BEFORE the thinking block', async () => {
    const transport = makeScriptedTransport([[
      { kind: 'thinking_start' } as StreamEvent,
      { kind: 'thinking', text: 'hmm' } as StreamEvent,
      { kind: 'text', text: 'answer' },
      doneEv(),
    ]]);
    const st = freshState();
    const { events } = await drive(mainDeps(transport, { history: transport.emptyHistory() }), st);
    const startIdx = events.findIndex((e) => e.kind === 'thinking_start');
    const thinkIdx = events.findIndex(
      (e) => e.kind === 'block' && (e as { block: { type: string } }).block.type === 'thinking',
    );
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(thinkIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeLessThan(thinkIdx);
  });

  it('capturedOrderedBlocks (verbatim channel) projects order-preserving blocks on the no-journal path, dropping redacted_thinking', async () => {
    const transport = makeScriptedTransport([[
      { kind: 'text', text: 'a' },
      { kind: 'tool_use', toolUse: { id: 'x1', name: 'nope_tool', input: {} } },
      doneEv('tool_use'),
    ]]);
    transport.capturedOrderedBlocks = () => [
      { type: 'text', text: 'a' },
      { type: 'thinking', thinking: 'th', signature: 's' },
      { type: 'tool_use', id: 'x1', name: 'nope_tool', input: {} },
      { type: 'redacted_thinking', data: 'zzz' },
    ] as never;
    const history = transport.emptyHistory();
    const st = freshState();
    await drive(mainDeps(transport, { history }), st);
    const pushed = (history as unknown as Array<{ role: string; blocks?: Array<{ type: string }> }>).find((m) => m.role === 'assistant');
    expect(pushed?.blocks?.map((b) => b.type)).toEqual(['text', 'thinking', 'tool_use']); // redacted dropped
  });

  it('capturedReasoning attaches HEAD items to the assistant entry and per-call items to the tool_use entry', async () => {
    const appended: Array<{ type: string; reasoning?: unknown }> = [];
    const fakeJournal = {
      append: vi.fn(async (e: { payload: { type: string; reasoning?: unknown } }) => {
        appended.push({ type: e.payload.type, reasoning: e.payload.reasoning });
        return { uuid: `u${appended.length}` } as unknown as JournalEntry;
      }),
    } as unknown as Journal;
    const transport = makeScriptedTransport([[
      { kind: 'text', text: 'a' },
      { kind: 'tool_use', toolUse: { id: 'c1', name: 'echo', input: { msg: 'x' } } },
      doneEv('tool_use'),
    ]]);
    transport.capturedReasoning = () => [
      { id: 'r0', encryptedContent: 'HEAD', callId: null, issuer: 'iss' },
      { id: 'r1', encryptedContent: 'PERCALL', callId: 'c1' },
    ] as never;
    const echo: RawToolOptions = {
      name: 'echo', description: 'echo', parameters: z.object({ msg: z.string() }),
      execute: async (input) => `echo:${(input as { msg: string }).msg}`,
    };
    const st = freshState();
    await drive(mainDeps(transport, { cfg: { journal: fakeJournal }, tools: [echo] }), st);
    const asst = appended.find((e) => e.type === 'assistant');
    expect(asst?.reasoning).toEqual([{ id: 'r0', encryptedContent: 'HEAD', issuer: 'iss' }]);
    const tu = appended.find((e) => e.type === 'tool_use');
    expect(tu?.reasoning).toEqual([{ id: 'r1', encryptedContent: 'PERCALL' }]);
  });

  it('a usage-append failure never unsettles the round (guarded catch-warn)', async () => {
    const fakeJournal = {
      append: vi.fn(async (e: { payload: { type: string } }) => {
        if (e.payload.type === 'usage') throw new Error('mirror down');
        return { uuid: 'u1' } as unknown as JournalEntry;
      }),
    } as unknown as Journal;
    const transport = makeScriptedTransport([[{ kind: 'text', text: 'ok' }, doneEv()]]);
    const st = freshState();
    const { round } = await drive(mainDeps(transport, { cfg: { journal: fakeJournal } }), st);
    expect(st.roundAppended).toBe(true); // settled despite the usage-append throw
    expect(round.roundCostUsd).toBeGreaterThan(0);
  });

  it('sequential batch: pushEvent drains live, todo blocks drain after the result, unknown tool errors', async () => {
    const transport = makeScriptedTransport([[
      { kind: 'tool_use', toolUse: { id: 'p1', name: 'pusher', input: {} } },
      { kind: 'tool_use', toolUse: { id: 'u1', name: 'ghost', input: {} } },
      doneEv('tool_use'),
    ]]);
    const pusher: RawToolOptions = {
      name: 'pusher', description: 'pushes an event', parameters: z.object({}),
      execute: async (_i, c) => {
        (c as { pushEvent?: (ev: HarnessEvent) => void }).pushEvent?.({ kind: 'raw', engine: 'native', event: 'custom:probe', data: {} });
        (c as { getCumulativeCostUsd?: () => number }).getCumulativeCostUsd?.();
        return 'pushed';
      },
    };
    const pendingTodoBlocks = [{ type: 'todo', todos: [] } as never];
    const st = freshState();
    const { events, round } = await drive(mainDeps(transport, { tools: [pusher], pendingTodoBlocks }), st);
    // the pushed raw event was yielded live, before the tool_result block
    const rawIdx = events.findIndex((e) => e.kind === 'raw' && (e as { event: string }).event === 'custom:probe');
    const resIdx = events.findIndex((e) => e.kind === 'block' && (e as { block: { type: string } }).block.type === 'tool_result');
    expect(rawIdx).toBeGreaterThanOrEqual(0);
    expect(rawIdx).toBeLessThan(resIdx);
    // the seeded todo block drained
    expect(events.some((e) => e.kind === 'block' && (e as { block: { type: string } }).block.type === 'todo')).toBe(true);
    expect(pendingTodoBlocks).toHaveLength(0);
    // the unknown tool produced the error result
    expect(round.results[1]).toMatchObject({ toolUseId: 'u1', text: 'Unknown tool: ghost', isError: true });
  });

  it('concurrent all-Agent batch: known Agent dispatches (queue drained), unknown Agent errors, todos drain', async () => {
    const transport = makeScriptedTransport([[
      { kind: 'tool_use', toolUse: { id: 'a1', name: 'Agent', input: { n: 1 } } },
      { kind: 'tool_use', toolUse: { id: 'a2', name: 'Agent', input: { n: 2 } } },
      doneEv('tool_use'),
    ]]);
    // ONE def named Agent — both tool_uses hit it (REEXECUTE_BOUND_TOOLS membership
    // makes the batch concurrent); its execute pushes a live event.
    const agentDef: RawToolOptions = {
      name: 'Agent', description: 'fake agent', parameters: z.object({ n: z.number() }),
      execute: async (_i, c) => {
        (c as { pushEvent?: (ev: HarnessEvent) => void }).pushEvent?.({ kind: 'raw', engine: 'native', event: 'sub:probe', data: {} });
        (c as { getCumulativeCostUsd?: () => number }).getCumulativeCostUsd?.();
        return 'agent-done';
      },
    };
    const pendingTodoBlocks = [{ type: 'todo', todos: [] } as never];
    const st = freshState();
    const { events, round } = await drive(mainDeps(transport, { tools: [agentDef], pendingTodoBlocks }), st);
    expect(round.results.map((r) => r.text)).toEqual(['agent-done', 'agent-done']);
    expect(events.filter((e) => e.kind === 'raw' && (e as { event: string }).event === 'sub:probe')).toHaveLength(2);
    expect(pendingTodoBlocks).toHaveLength(0);

    // and the UNKNOWN-Agent flavor: no def at all → both resolve as unknown-tool errors.
    const transport2 = makeScriptedTransport([[
      { kind: 'tool_use', toolUse: { id: 'b1', name: 'Agent', input: {} } },
      { kind: 'tool_use', toolUse: { id: 'b2', name: 'Agent', input: {} } },
      doneEv('tool_use'),
    ]]);
    const st2 = freshState();
    const { round: r2 } = await drive(mainDeps(transport2, { tools: [] }), st2);
    expect(r2.results.every((r) => r.isError && r.text === 'Unknown tool: Agent')).toBe(true);
  });

  it('a NON-abort mid-stream throw propagates out of the main path (iterateTurn catch owns it)', async () => {
    const transport = makeScriptedTransport([[{ kind: 'text', text: 'x' }, doneEv()]]);
    transport.readStream = async function* () {
      yield { kind: 'text', text: 'partial' } as StreamEvent;
      throw new Error('provider blew up');
    };
    const st = freshState();
    await expect(drive(mainDeps(transport), st)).rejects.toThrow('provider blew up');
    expect(st.assistantText).toBe('partial'); // the D1 scratch kept the in-flight text for the seal
  });
});

describe('startStreamWithRetry — abort + recovery edges (direct)', () => {
  const params = (transport: Transport, signal?: AbortSignal) => ({
    model: 'm', maxTokens: 100, system: 's',
    tools: [] as never[], history: transport.emptyHistory(),
    ...(signal !== undefined ? { signal } : {}),
  });

  it('a pre-aborted signal short-circuits with AbortError before any model call', async () => {
    const transport = makeScriptedTransport([]);
    const callSpy = vi.spyOn(transport, 'callModel');
    const ac = new AbortController();
    ac.abort();
    await expect(startStreamWithRetry(params(transport, ac.signal), transport, {})).rejects.toMatchObject({ name: 'AbortError' });
    expect(callSpy).not.toHaveBeenCalled();
  });

  it('an abort DURING the call rethrows without retrying', async () => {
    const ac = new AbortController();
    const transport = makeScriptedTransport([]);
    transport.callModel = () => {
      ac.abort();
      throw new Error('socket closed');
    };
    await expect(startStreamWithRetry(params(transport, ac.signal), transport, {})).rejects.toThrow('socket closed');
  });

  it('invalid_encrypted_content: disables reasoning replay ONCE and retries', async () => {
    let calls = 0;
    const transport = makeScriptedTransport([[doneEv()]]);
    const origCall = transport.callModel.bind(transport);
    transport.callModel = (req) => {
      calls += 1;
      if (calls === 1) throw new Error('400 undecryptable');
      return origCall(req);
    };
    transport.classifyError = () =>
      ({ kind: 'model_error', raw: { subtype: 'invalid_encrypted_content', errors: [] } }) as never;
    transport.disableReasoningReplay = vi.fn();
    const started = await startStreamWithRetry(params(transport), transport, {});
    expect(started.model).toBe('m');
    expect(transport.disableReasoningReplay).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
  });

  it('exhausted transient budget with no fallback rethrows the last error', async () => {
    const transport = makeScriptedTransport([]);
    transport.callModel = () => { throw new Error('always 529'); };
    await expect(
      startStreamWithRetry(params(transport), transport, { retry: { maxAttempts: 1 } }),
    ).rejects.toThrow('always 529');
  });
});

describe('runOneRound — subagent settle-on-abort at the model-call boundary', () => {
  it('an abort that surfaces inside startStreamWithRetry settles instead of throwing (sub only)', async () => {
    const ac = new AbortController();
    const transport = makeScriptedTransport([]);
    transport.callModel = () => {
      ac.abort();
      throw new Error('socket closed');
    };
    const st = freshState();
    const deps: RoundDeps = {
      ctx: { taskId: 't', sessionId: 's', cwd: '', model: 'm', config: {}, signal: new AbortController().signal },
      cfg: { signal: ac.signal },
      transport,
      harness: allowHarness,
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
      sub: {
        foldRoundCost: () => { throw new Error('must not fold an aborted round'); },
        persistRound: async () => { throw new Error('must not persist an aborted round'); },
        execCtx: {},
      },
    } as RoundDeps;
    const gen = runOneRound(deps, st);
    const n = await gen.next();
    expect(n.done).toBe(true);
    expect((n.value as { abortedMidStream?: true }).abortedMidStream).toBe(true);
    expect((n.value as { roundCostUsd: number }).roundCostUsd).toBe(0);
  });
});
