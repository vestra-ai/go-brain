/**
 * Mixed-batch Agent parallelism — a round of [TaskCreate, TaskCreate, TaskUpdate,
 * Agent, Agent, Agent] must run the three Agent dispatches CONCURRENTLY. The historic
 * condition demoted the whole round to the sequential path whenever ANY tool_use was
 * non-Agent, so diligent todo bookkeeping in the dispatch round silently serialized
 * "parallel" subagents.
 *
 * Discovered while investigating prod task 7f77166a (three subagents that *looked*
 * serialized). Whether that turn hit THIS path (todos + Agent calls in one round) or
 * the sibling UI/event-ordering artifact (Agent calls in their own round; batched
 * PASS-2 emission made concurrent dispatches look sequential) is still under
 * investigation — so these tests reproduce the CODE PATH deterministically rather
 * than assert the exact prod turn. The condition is real either way.
 *
 * The generalization under test: runs of ≥2 CONSECUTIVE Agent tool_uses execute
 * through the concurrent `:turnbatch` pool; every non-Agent tool_use — and any
 * lone Agent — executes sequentially, preserving exact batch order (a non-Agent
 * tool between Agent runs is a BARRIER). Invariant guards ride along: subagent
 * (deps.sub) batches stay fully sequential (P2.2 gate 5), a paused sibling in a
 * concurrent run settles {pausedHalt} while the rest finish (T5/T6), and the
 * fuel tank (Weave Floor §1a) still denies concurrent Agent nodes before launch.
 */
import { describe, it, expect } from 'vitest';
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
import { defaultNodeReserveUsd, _resetFuelTanksForTest } from '../fuel-tank.js';
import { resolveCapabilities } from '../../contract/model-capabilities.js';
import { runOneRound, partitionToolBatch, type RoundDeps, type RoundState } from '../round-engine.js';

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

/** tool_use/tool_result block emission order, as `type:toolUseId` strings. */
const blockSeq = (events: HarnessEvent[]): string[] =>
  events
    .filter((e): e is Extract<HarnessEvent, { kind: 'block' }> => e.kind === 'block')
    .map((e) => e.block as { type: string; toolUseId?: string })
    .filter((b) => b.type === 'tool_use' || b.type === 'tool_result')
    .map((b) => `${b.type}:${b.toolUseId}`);

/** raw `subagent:start` events, as `{ toolUseId, agentSlug }`, in emission order. */
const startSeq = (events: HarnessEvent[]): Array<{ toolUseId: string; agentSlug: unknown }> =>
  events
    .filter((e): e is Extract<HarnessEvent, { kind: 'raw' }> =>
      e.kind === 'raw' && (e as { event: string }).event === 'subagent:start')
    .map((e) => {
      const d = e.data as { toolUseId: string; agentSlug: unknown };
      return { toolUseId: d.toolUseId, agentSlug: d.agentSlug };
    });

/**
 * A compact, order-preserving projection of the lane-relevant events: a tool_use
 * block (`tu:id`), a synthesized/real subagent:start raw event (`start:id`), and a
 * tool_result block (`res:id`). Proves the K3 emission order — every start rides
 * up-front with its block in PASS 1, before any PASS-2 result drains.
 */
const laneSeq = (events: HarnessEvent[]): string[] =>
  events.flatMap((e) => {
    if (e.kind === 'block') {
      const b = e.block as { type: string; toolUseId?: string };
      if (b.type === 'tool_use') return [`tu:${b.toolUseId}`];
      if (b.type === 'tool_result') return [`res:${b.toolUseId}`];
      return [];
    }
    if (e.kind === 'raw' && (e as { event: string }).event === 'subagent:start') {
      return [`start:${(e.data as { toolUseId: string }).toolUseId}`];
    }
    return [];
  });

/**
 * The shared fake `Agent` def. Tracks live overlap (`active.max`) and holds each
 * call on a PER-RUN barrier (input.run) until `widths[run]` siblings have
 * entered — so genuinely-concurrent dispatches all overlap deterministically. A
 * timeout fallback releases a call the barrier never fills, so a wrongly-
 * sequential path FAILS the overlap assertion fast instead of hanging the test.
 */
function makeAgentDef(widths: Record<string, number>, log: string[]) {
  const active = { now: 0, max: 0 };
  const entered: Record<string, number> = {};
  const waiters: Record<string, Array<() => void>> = {};
  const def: RawToolOptions = {
    name: 'Agent',
    description: 'fake subagent',
    parameters: z.object({ tag: z.string(), run: z.string() }),
    execute: async (input) => {
      const { tag, run } = input as { tag: string; run: string };
      log.push(`start:${tag}`);
      active.now += 1;
      active.max = Math.max(active.max, active.now);
      entered[run] = (entered[run] ?? 0) + 1;
      const runWaiters = (waiters[run] ??= []);
      await new Promise<void>((resolve) => {
        runWaiters.push(resolve);
        if (entered[run] >= (widths[run] ?? Infinity)) for (const w of runWaiters.splice(0)) w();
        setTimeout(resolve, 200);
      });
      active.now -= 1;
      log.push(`end:${tag}`);
      return `agent:${tag}`;
    },
  };
  return { def, active };
}

/** A non-Agent tool that logs start/end around a real await (order probe). */
function makeSeqDef(name: string, log: string[]): RawToolOptions {
  return {
    name,
    description: `fake ${name}`,
    parameters: z.object({ tag: z.string() }),
    execute: async (input) => {
      const tag = (input as { tag: string }).tag;
      log.push(`start:${tag}`);
      await new Promise((r) => setTimeout(r, 5));
      log.push(`end:${tag}`);
      return `${name}:${tag}`;
    },
  };
}

describe('runOneRound — mixed-batch Agent parallelism', () => {
  it('mixed round: bookkeeping tools + 3 Agents in one round — the Agents overlap, batch order preserved', async () => {
    const log: string[] = [];
    const { def: agentDef, active } = makeAgentDef({ r1: 3 }, log);
    const transport = makeScriptedTransport([[
      toolUse('tc1', 'TaskCreate', { tag: 'tc1' }),
      toolUse('tc2', 'TaskCreate', { tag: 'tc2' }),
      toolUse('tu1', 'TaskUpdate', { tag: 'tu1' }),
      toolUse('a1', 'Agent', { tag: 'a1', run: 'r1' }),
      toolUse('a2', 'Agent', { tag: 'a2', run: 'r1' }),
      toolUse('a3', 'Agent', { tag: 'a3', run: 'r1' }),
      doneEv(),
    ]]);
    const st = freshState();
    const { events, round } = await drive(
      mainDeps(transport, { tools: [makeSeqDef('TaskCreate', log), makeSeqDef('TaskUpdate', log), agentDef] }),
      st,
    );
    // THE BUG: one non-Agent tool_use demoted the whole round to sequential.
    expect(active.max).toBe(3);
    // Batch-order results, bookkeeping first.
    expect(round.results.map((r) => r.text)).toEqual([
      'TaskCreate:tc1', 'TaskCreate:tc2', 'TaskUpdate:tu1', 'agent:a1', 'agent:a2', 'agent:a3',
    ]);
    // K3 emission order: sequential tools pairwise, then the Agent run's
    // tool_use blocks up-front (PASS 1) followed by its results in batch order.
    expect(blockSeq(events)).toEqual([
      'tool_use:tc1', 'tool_result:tc1',
      'tool_use:tc2', 'tool_result:tc2',
      'tool_use:tu1', 'tool_result:tu1',
      'tool_use:a1', 'tool_use:a2', 'tool_use:a3',
      'tool_result:a1', 'tool_result:a2', 'tool_result:a3',
    ]);
  });

  it('a non-Agent tool between Agent runs is a BARRIER: run 1 settles, then the barrier, then run 2', async () => {
    const log: string[] = [];
    const { def: agentDef, active } = makeAgentDef({ r1: 2, r2: 2 }, log);
    const transport = makeScriptedTransport([[
      toolUse('a1', 'Agent', { tag: 'a1', run: 'r1' }),
      toolUse('a2', 'Agent', { tag: 'a2', run: 'r1' }),
      toolUse('w1', 'Write', { tag: 'w1' }),
      toolUse('a3', 'Agent', { tag: 'a3', run: 'r2' }),
      toolUse('a4', 'Agent', { tag: 'a4', run: 'r2' }),
      doneEv(),
    ]]);
    const st = freshState();
    const { events, round } = await drive(
      mainDeps(transport, { tools: [agentDef, makeSeqDef('Write', log)] }),
      st,
    );
    // Each 2-wide run overlaps internally, but never ACROSS the barrier.
    expect(active.max).toBe(2);
    const idx = (s: string) => log.indexOf(s);
    expect(Math.max(idx('start:a1'), idx('start:a2'))).toBeLessThan(Math.min(idx('end:a1'), idx('end:a2')));
    expect(idx('start:w1')).toBeGreaterThan(Math.max(idx('end:a1'), idx('end:a2')));
    expect(idx('end:w1')).toBeLessThan(Math.min(idx('start:a3'), idx('start:a4')));
    expect(Math.max(idx('start:a3'), idx('start:a4'))).toBeLessThan(Math.min(idx('end:a3'), idx('end:a4')));
    expect(round.results.map((r) => r.text)).toEqual(['agent:a1', 'agent:a2', 'Write:w1', 'agent:a3', 'agent:a4']);
    expect(blockSeq(events)).toEqual([
      'tool_use:a1', 'tool_use:a2', 'tool_result:a1', 'tool_result:a2',
      'tool_use:w1', 'tool_result:w1',
      'tool_use:a3', 'tool_use:a4', 'tool_result:a3', 'tool_result:a4',
    ]);
  });

  it('a LONE Agent in a mixed round stays on the sequential path (strict serialization)', async () => {
    const log: string[] = [];
    const { def: agentDef, active } = makeAgentDef({ solo: 1 }, log);
    const transport = makeScriptedTransport([[
      toolUse('w1', 'Write', { tag: 'w1' }),
      toolUse('a1', 'Agent', { tag: 'a1', run: 'solo' }),
      toolUse('w2', 'Write', { tag: 'w2' }),
      doneEv(),
    ]]);
    const st = freshState();
    const { events } = await drive(
      mainDeps(transport, { tools: [agentDef, makeSeqDef('Write', log)] }),
      st,
    );
    expect(active.max).toBe(1);
    expect(log).toEqual(['start:w1', 'end:w1', 'start:a1', 'end:a1', 'start:w2', 'end:w2']);
    expect(blockSeq(events)).toEqual([
      'tool_use:w1', 'tool_result:w1',
      'tool_use:a1', 'tool_result:a1',
      'tool_use:w2', 'tool_result:w2',
    ]);
  });

  it('a SUBAGENT (deps.sub) all-Agent batch stays fully sequential (P2.2 gate 5 — deadlock discipline)', async () => {
    const log: string[] = [];
    // Barrier width 2: if the sub path ever went concurrent both calls would
    // enter together (active.max 2); sequential leaves each to the timeout.
    const { def: agentDef, active } = makeAgentDef({ r1: 2 }, log);
    const transport = makeScriptedTransport([[
      toolUse('a1', 'Agent', { tag: 'a1', run: 'r1' }),
      toolUse('a2', 'Agent', { tag: 'a2', run: 'r1' }),
      doneEv(),
    ]]);
    const st = freshState();
    const deps: RoundDeps = {
      ctx: { taskId: 'sub-t', sessionId: 's', cwd: '', model: 'm', config: {}, signal: new AbortController().signal },
      cfg: {},
      transport,
      harness: allowHarness,
      tools: [agentDef],
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
        foldRoundCost: () => {},
        persistRound: async () => {},
        execCtx: {},
      },
    } as RoundDeps;
    const { round } = await drive(deps, st);
    expect(active.max).toBe(1);
    expect(log).toEqual(['start:a1', 'end:a1', 'start:a2', 'end:a2']);
    expect(round.results.map((r) => r.text)).toEqual(['agent:a1', 'agent:a2']);
  });

  it('a paused sibling inside a concurrent run settles {pausedHalt}; the rest overlap, journal withholds only its result', async () => {
    const appended: Array<{ type: string; toolUseId?: string }> = [];
    const fakeJournal = {
      append: async (e: { payload: { type: string; toolUseId?: string } }) => {
        appended.push({ type: e.payload.type, ...(e.payload.toolUseId !== undefined && { toolUseId: e.payload.toolUseId }) });
        return { uuid: `u${appended.length}` } as unknown as JournalEntry;
      },
    } as unknown as Journal;
    const log: string[] = [];
    // a2 pauses at the GATE (never reaches execute) → only a1/a3 enter: width 2.
    const { def: agentDef, active } = makeAgentDef({ r1: 2 }, log);
    const pausingHarness = {
      gateTool: async (c: ToolCall): Promise<GateResult> =>
        c.toolCallId === 'a2'
          ? ({ decision: 'needs_human', interactionKind: 'tool_permission' } as GateResult)
          : ({ decision: 'allow' } as GateResult),
    };
    const transport = makeScriptedTransport([[
      toolUse('tc1', 'TaskCreate', { tag: 'tc1' }),
      toolUse('a1', 'Agent', { tag: 'a1', run: 'r1' }),
      toolUse('a2', 'Agent', { tag: 'a2', run: 'r1' }),
      toolUse('a3', 'Agent', { tag: 'a3', run: 'r1' }),
      doneEv(),
    ]]);
    const st = freshState();
    const { events, round } = await drive(
      mainDeps(transport, {
        cfg: { journal: fakeJournal },
        harness: pausingHarness,
        dispatcher: createNativeHookDispatcher(pausingHarness),
        tools: [makeSeqDef('TaskCreate', log), agentDef],
      }),
      st,
    );
    // The unpaused siblings still ran concurrently.
    expect(active.max).toBe(2);
    // The paused sibling settled {pausedHalt} while the batch completed. A pause is
    // a TYPED outcome now — isError:false, the pause rides pausedHalt (not the error
    // channel), so the persisted card renders "awaiting", never a red error chip.
    expect(round.results).toHaveLength(4);
    expect(round.results[2]).toMatchObject({ toolUseId: 'a2', pausedHalt: true, isError: false });
    expect(round.results.map((r) => r.toolUseId)).toEqual(['tc1', 'a1', 'a2', 'a3']);
    // Journal: tool_result entries for everyone EXCEPT the paused tool (withheld
    // so the suspend/continue machinery sees a genuinely-unanswered tool_use).
    const journaledResults = appended.filter((e) => e.type === 'tool_result').map((e) => e.toolUseId);
    expect(journaledResults).toEqual(['tc1', 'a1', 'a3']);
    // Per-tool ACTION billing skips the paused tool (it re-bills on resume).
    const billed = events
      .filter((e): e is Extract<HarnessEvent, { kind: 'raw' }> => e.kind === 'raw' && (e as { event: string }).event === 'agent:tool_billing')
      .map((e) => (e.data as { toolUseId: string }).toolUseId);
    expect(billed).toEqual(['tc1', 'a1', 'a3']);
  });

  it('the partition function itself: shapes the batch into concurrent/sequential runs (pure)', () => {
    const P = (t: string[]) => t.map((name, i) => ({ id: `${name[0]}${i}`, name, input: {} }));
    // render a partition as `C[ids]` / `S[ids]` for a compact, exhaustive assertion
    const shape = (names: string[], mainLoop: boolean) =>
      partitionToolBatch(P(names), mainLoop).map((s) => `${s.concurrent ? 'C' : 'S'}[${s.tus.map((t) => t.id).join(',')}]`);

    // the exact prod shape: bookkeeping then a 3-wide Agent run
    expect(shape(['TaskCreate', 'TaskCreate', 'TaskUpdate', 'Agent', 'Agent', 'Agent'], true))
      .toEqual(['S[T0,T1,T2]', 'C[A3,A4,A5]']);
    // all-Agent → the historic single full-width concurrent run
    expect(shape(['Agent', 'Agent', 'Agent'], true)).toEqual(['C[A0,A1,A2]']);
    expect(shape(['Agent', 'Agent'], true)).toEqual(['C[A0,A1]']);
    // a non-Agent BETWEEN two runs splits them and stays sequential (barrier)
    expect(shape(['Agent', 'Agent', 'Write', 'Agent', 'Agent'], true)).toEqual(['C[A0,A1]', 'S[W2]', 'C[A3,A4]']);
    // lone Agents never race: they coalesce INTO the surrounding sequential run
    expect(shape(['Write', 'Agent', 'Write'], true)).toEqual(['S[W0,A1,W2]']);
    expect(shape(['Agent', 'Write', 'Agent'], true)).toEqual(['S[A0,W1,A2]']); // two lone Agents, no run
    expect(shape(['Agent', 'Agent', 'Write'], true)).toEqual(['C[A0,A1]', 'S[W2]']);
    expect(shape(['Write', 'Agent', 'Agent'], true)).toEqual(['S[W0]', 'C[A1,A2]']);
    // single tools
    expect(shape(['Write'], true)).toEqual(['S[W0]']);
    expect(shape(['Agent'], true)).toEqual(['S[A0]']); // lone Agent → sequential
    // subagent path (mainLoop=false): NEVER concurrent — one sequential segment
    expect(shape(['Agent', 'Agent', 'Agent'], false)).toEqual(['S[A0,A1,A2]']);
    expect(partitionToolBatch([], false)).toEqual([]);
    expect(partitionToolBatch([], true)).toEqual([]);
  });

  it('fuel tank (§1a) still denies concurrent Agent nodes inside a mixed round — skip note, never dispatched', async () => {
    _resetFuelTanksForTest();
    const MODEL = 'claude-sonnet-4-6';
    const reserve = defaultNodeReserveUsd(MODEL, resolveCapabilities(MODEL).maxOutputTokens);
    const log: string[] = [];
    const { def: agentDef } = makeAgentDef({ r1: 2 }, log);
    const transport = makeScriptedTransport([[
      toolUse('tc1', 'TaskCreate', { tag: 'tc1' }),
      toolUse('a1', 'Agent', { tag: 'a1', run: 'r1' }),
      toolUse('a2', 'Agent', { tag: 'a2', run: 'r1' }),
      doneEv(),
    ]]);
    const st = freshState();
    const { round } = await drive(
      mainDeps(transport, {
        // Ceiling below ONE node's reserve → every concurrent Agent is denied
        // before launch (deterministic, timing-independent).
        ctx: { taskId: 'mixed-fuel-t', sessionId: 's', cwd: '', model: MODEL, config: {}, signal: new AbortController().signal },
        cfg: { sessionFuelTankUsd: reserve / 2 },
        tools: [makeSeqDef('TaskCreate', log), agentDef],
      }),
      st,
    );
    // The sequential barrier tool ran; neither Agent was ever dispatched.
    expect(log).toEqual(['start:tc1', 'end:tc1']);
    expect(round.results[0]).toMatchObject({ toolUseId: 'tc1', text: 'TaskCreate:tc1' });
    for (const r of round.results.slice(1)) {
      expect(r.text).toContain('Skipped: session fuel ceiling');
      expect((r as { fuelDenied?: boolean }).fuelDenied).toBe(true);
      expect(r.isError).toBe(false);
    }
    _resetFuelTanksForTest();
  });
});

/**
 * Live concurrent lane starts — the "parallel subagents render as queued" artifact.
 *
 * PASS 2 drains each lane's PushQueue strictly in batch order, so a lane's REAL
 * `subagent:start` (pushed by the Agent tool into that lane's queue) is WITHHELD
 * until the lane's drain turn. The web, seeing no events for a lane that is
 * genuinely executing, invents a "queued" state — so a 3-wide concurrent batch
 * renders 1 running / 2 queued (verified live on staging task
 * febc47c6-4727-42c5-8b5e-1f8ffd250dac: all three sealed within 68s, yet the card
 * showed 2 queued the whole time).
 *
 * The fix: PASS 1 (the SOLE emitter — K3 preserved) synthesizes each lane's
 * `subagent:start` up-front, right after its tool_use block, deterministically in
 * batch order. The child's own later start (PASS-2 drain) is a benign duplicate the
 * server materialize (last-write-wins on toolUseId) and web handler (init-if-absent/
 * monotonic, #1399) dedupe by design. Single-child spawns only — a children[] batch
 * (no top-level subagent_type) keeps its natural per-child start timing.
 */
describe('runOneRound — live concurrent lane starts (kill the replay artifact)', () => {
  it('a concurrent Agent run emits every lane\'s subagent:start UP-FRONT (batch order), before any PASS-2 result drains', async () => {
    const log: string[] = [];
    const { def: agentDef } = makeAgentDef({ r1: 3 }, log);
    const transport = makeScriptedTransport([[
      toolUse('a1', 'Agent', { tag: 'a1', run: 'r1', subagent_type: 'researcher' }),
      toolUse('a2', 'Agent', { tag: 'a2', run: 'r1', subagent_type: 'writer' }),
      toolUse('a3', 'Agent', { tag: 'a3', run: 'r1', subagent_type: 'critic' }),
      doneEv(),
    ]]);
    const st = freshState();
    const { events } = await drive(mainDeps(transport, { tools: [agentDef] }), st);

    // Three starts, in batch order, carrying the raw slug from tu.input.subagent_type
    // (the server enriches name/icon/color from its slug-keyed cache — the engine
    // does NOT resolve display names).
    expect(startSeq(events)).toEqual([
      { toolUseId: 'a1', agentSlug: 'researcher' },
      { toolUseId: 'a2', agentSlug: 'writer' },
      { toolUseId: 'a3', agentSlug: 'critic' },
    ]);
    // The wire shape matches the Agent tool's own emit EXACTLY so the server/web
    // pipeline treats it identically (raw + native + slug-keyed data).
    const rawStarts = events.filter(
      (e): e is Extract<HarnessEvent, { kind: 'raw' }> =>
        e.kind === 'raw' && (e as { event: string }).event === 'subagent:start',
    );
    expect(rawStarts[0]).toMatchObject({
      kind: 'raw',
      engine: 'native',
      event: 'subagent:start',
      data: { taskId: 't', toolUseId: 'a1', agentSlug: 'researcher' },
    });
    // K3 order: PASS 1 emits every tool_use block + its start up-front (block→start
    // per lane), THEN PASS 2 drains results in batch order. No start or block trails
    // a result — the "queued" fallback the web invents is now impossible.
    expect(laneSeq(events)).toEqual([
      'tu:a1', 'start:a1', 'tu:a2', 'start:a2', 'tu:a3', 'start:a3',
      'res:a1', 'res:a2', 'res:a3',
    ]);
  });

  it('an INLINE lane (name, no subagent_type) emits its start up-front too — an inline batch must not render as queued', async () => {
    // The shape staging task 7a85ef80 actually produced: the model spawned
    // on-the-fly specialists with `{ name, prompt }` and NO `subagent_type`
    // (agent-tool's inline lane, whose agent.slug IS the caller's `name`).
    // Reading only `subagent_type` left every inline lane with no up-front start,
    // so a genuinely concurrent inline batch rendered 1 running / N-1 queued —
    // the exact "parallel subagents ran sequentially" artifact this block kills.
    const log: string[] = [];
    const { def: agentDef } = makeAgentDef({ r1: 3 }, log);
    const transport = makeScriptedTransport([[
      toolUse('a1', 'Agent', { tag: 'a1', run: 'r1', name: 'italy-essay-writer' }),
      toolUse('a2', 'Agent', { tag: 'a2', run: 'r1', name: 'france-essay-writer' }),
      // The documented `'custom'` sentinel is the inline lane too — `name` is the slug.
      toolUse('a3', 'Agent', { tag: 'a3', run: 'r1', subagent_type: 'custom', name: 'spain-essay-writer' }),
      doneEv(),
    ]]);
    const st = freshState();
    const { events } = await drive(mainDeps(transport, { tools: [agentDef] }), st);

    expect(startSeq(events)).toEqual([
      { toolUseId: 'a1', agentSlug: 'italy-essay-writer' },
      { toolUseId: 'a2', agentSlug: 'france-essay-writer' },
      { toolUseId: 'a3', agentSlug: 'spain-essay-writer' },
    ]);
    expect(laneSeq(events)).toEqual([
      'tu:a1', 'start:a1', 'tu:a2', 'start:a2', 'tu:a3', 'start:a3',
      'res:a1', 'res:a2', 'res:a3',
    ]);
  });

  it('a children[] batch still emits NO up-front start — it keeps its natural per-child timing', async () => {
    // Out of scope by design (one Agent tool_use fans out N children with their own
    // ids); widening the slug read to `name` must not drag it in.
    const log: string[] = [];
    const { def: agentDef } = makeAgentDef({ r1: 2 }, log);
    const transport = makeScriptedTransport([[
      toolUse('c1', 'Agent', { tag: 'c1', run: 'r1', children: [{ subagent_type: 'researcher', prompt: 'p', description: 'd' }] }),
      toolUse('c2', 'Agent', { tag: 'c2', run: 'r1', children: [{ subagent_type: 'writer', prompt: 'p', description: 'd' }] }),
      doneEv(),
    ]]);
    const st = freshState();
    const { events } = await drive(mainDeps(transport, { tools: [agentDef] }), st);
    expect(startSeq(events)).toEqual([]);
  });

  it('the child\'s own later subagent:start (PASS-2 drain) is NOT suppressed — the synthesized start is additive (duplicate is safe)', async () => {
    // A def that, like agent-tool.ts, pushes its OWN subagent:start into the lane
    // queue before returning — the PASS-2 "duplicate" the server/web dedupe by design.
    const def: RawToolOptions = {
      name: 'Agent',
      description: 'fake subagent that emits its own start',
      parameters: z.object({ tag: z.string(), run: z.string() }),
      execute: async (input, ctx) => {
        const { tag } = input as { tag: string };
        ctx.pushEvent?.({
          kind: 'raw',
          engine: 'native',
          event: 'subagent:start',
          data: { taskId: 't', toolUseId: tag, agentSlug: `resolved-${tag}` },
        });
        return `agent:${tag}`;
      },
    };
    const transport = makeScriptedTransport([[
      toolUse('a1', 'Agent', { tag: 'a1', run: 'r1', subagent_type: 'researcher' }),
      toolUse('a2', 'Agent', { tag: 'a2', run: 'r1', subagent_type: 'writer' }),
      doneEv(),
    ]]);
    const st = freshState();
    const { events } = await drive(mainDeps(transport, { tools: [def] }), st);

    // TWO starts per lane: the synthesized up-front one (raw slug, PASS 1) AND the
    // child's own during its drain (resolved slug, PASS 2). The child's own is NOT
    // suppressed — this is the duplicate the downstream dedupe handles.
    expect(startSeq(events)).toEqual([
      { toolUseId: 'a1', agentSlug: 'researcher' },
      { toolUseId: 'a2', agentSlug: 'writer' },
      { toolUseId: 'a1', agentSlug: 'resolved-a1' },
      { toolUseId: 'a2', agentSlug: 'resolved-a2' },
    ]);
  });

  it('a lone (sequential) Agent emits NO synthesized start even WITH subagent_type — PASS-1 emission is concurrent-run only', async () => {
    const log: string[] = [];
    const { def: agentDef } = makeAgentDef({ solo: 1 }, log);
    const transport = makeScriptedTransport([[
      toolUse('w1', 'Write', { tag: 'w1' }),
      toolUse('a1', 'Agent', { tag: 'a1', run: 'solo', subagent_type: 'researcher' }),
      toolUse('w2', 'Write', { tag: 'w2' }),
      doneEv(),
    ]]);
    const st = freshState();
    const { events } = await drive(
      mainDeps(transport, { tools: [agentDef, makeSeqDef('Write', log)] }),
      st,
    );
    // The sequential path emits the child's real start at natural time; the engine
    // synthesizes nothing here.
    expect(startSeq(events)).toEqual([]);
  });

  it('a SUBAGENT (deps.sub) all-Agent batch emits NO synthesized start (never concurrent — P2.2 gate 5)', async () => {
    const log: string[] = [];
    const { def: agentDef } = makeAgentDef({ r1: 2 }, log);
    const transport = makeScriptedTransport([[
      toolUse('a1', 'Agent', { tag: 'a1', run: 'r1', subagent_type: 'researcher' }),
      toolUse('a2', 'Agent', { tag: 'a2', run: 'r1', subagent_type: 'writer' }),
      doneEv(),
    ]]);
    const st = freshState();
    const deps: RoundDeps = {
      ctx: { taskId: 'sub-t', sessionId: 's', cwd: '', model: 'm', config: {}, signal: new AbortController().signal },
      cfg: {},
      transport,
      harness: allowHarness,
      tools: [agentDef],
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
        foldRoundCost: () => {},
        persistRound: async () => {},
        execCtx: {},
      },
    } as RoundDeps;
    const { events } = await drive(deps, st);
    expect(startSeq(events)).toEqual([]);
  });

  it('a children[] batch tool_use (no top-level subagent_type) in a concurrent run gets NO synthesized start (out of scope)', async () => {
    const log: string[] = [];
    const { def: agentDef } = makeAgentDef({ r1: 2 }, log);
    const transport = makeScriptedTransport([[
      toolUse('a1', 'Agent', { tag: 'a1', run: 'r1', subagent_type: 'researcher' }),
      // children[] shape: no top-level subagent_type → out of scope, no synth start.
      toolUse('a2', 'Agent', { tag: 'a2', run: 'r1', children: [{ subagent_type: 'x', prompt: 'p' }] }),
      doneEv(),
    ]]);
    const st = freshState();
    const { events } = await drive(mainDeps(transport, { tools: [agentDef] }), st);
    // Only the single-child lane gets a synthesized start.
    expect(startSeq(events)).toEqual([{ toolUseId: 'a1', agentSlug: 'researcher' }]);
  });
});

/**
 * W3-2 — concurrencySafe read-only batches. `RawToolOptions.concurrencySafe: true`
 * declares "no side effects and no ordering dependence on other calls in the same
 * batch"; the partitioner then forms a concurrent run from ≥2 CONSECUTIVE calls that
 * are Agent OR concurrencySafe (undeclared = sequential, fail-closed). Three Reads
 * and a Grep in one round were four serial round-trips; now they overlap through the
 * SAME `:turnbatch` pool + P3 drain bounds the Agent runs use. Hard rules pinned
 * here: journal append order = wire order for a mixed run (even when a later member
 * settles first), the subagent path NEVER forms a run, and the §1a admission stack
 * (fuel tank / global semaphore) keeps gating Agent members while never denying a
 * concurrencySafe member (the sequential path never fuel-gated plain tools).
 */
describe('runOneRound — concurrencySafe read-only batches (W3-2)', () => {
  /** A concurrencySafe def that tracks overlap in a SHARED `active` counter and
   *  settles under the test's control (holdUntil / onDone) — deterministic, no
   *  timing races: overlap is proven by construction, not by sleeps. */
  function makeSafeDef(
    name: string,
    log: string[],
    active: { now: number; max: number },
    opts: { holdUntil?: Promise<void>; onDone?: () => void } = {},
  ): RawToolOptions {
    return {
      name,
      description: `fake ${name}`,
      parameters: z.object({ tag: z.string() }),
      concurrencySafe: true,
      execute: async (input) => {
        const tag = (input as { tag: string }).tag;
        log.push(`start:${tag}`);
        active.now += 1;
        active.max = Math.max(active.max, active.now);
        if (opts.holdUntil) await opts.holdUntil;
        else await new Promise((r) => setTimeout(r, 5));
        active.now -= 1;
        log.push(`end:${tag}`);
        opts.onDone?.();
        return `${name}:${tag}`;
      },
    };
  }

  it('the partition function with a second predicate: Agent-or-safe runs form; absent predicate is fail-closed', () => {
    const P = (t: string[]) => t.map((name, i) => ({ id: `${name[0]}${i}`, name, input: {} }));
    const safe = (...names: string[]) => (n: string) => names.includes(n);
    const shape = (names: string[], mainLoop: boolean, pred?: (n: string) => boolean) =>
      partitionToolBatch(P(names), mainLoop, pred).map((s) => `${s.concurrent ? 'C' : 'S'}[${s.tus.map((t) => t.id).join(',')}]`);

    // ≥2 consecutive safe calls → a concurrent run (the 3-Reads-and-a-Grep win).
    expect(shape(['Read', 'Grep'], true, safe('Read', 'Grep'))).toEqual(['C[R0,G1]']);
    expect(shape(['Read', 'Read', 'Read', 'Grep'], true, safe('Read', 'Grep'))).toEqual(['C[R0,R1,R2,G3]']);
    // An unmarked tool is a BARRIER, exactly like a non-Agent tool between Agent runs.
    expect(shape(['Read', 'Grep', 'Write', 'Read'], true, safe('Read', 'Grep'))).toEqual(['C[R0,G1]', 'S[W2,R3]']);
    // Agent OR safe: a lone Agent beside a safe call still makes a ≥2 run (mixed run).
    expect(shape(['Read', 'Agent'], true, safe('Read'))).toEqual(['C[R0,A1]']);
    expect(shape(['Agent', 'Read', 'Agent'], true, safe('Read'))).toEqual(['C[A0,R1,A2]']);
    // A lone safe call coalesces into the sequential run (run of 1 never races).
    expect(shape(['Write', 'Read', 'Write'], true, safe('Read'))).toEqual(['S[W0,R1,W2]']);
    // FAIL-CLOSED: no predicate (or an all-false one) = today's Agent-only behavior.
    expect(shape(['Read', 'Grep'], true)).toEqual(['S[R0,G1]']);
    expect(shape(['Read', 'Grep'], true, () => false)).toEqual(['S[R0,G1]']);
    // Agent-only runs are untouched by the predicate being present.
    expect(shape(['Agent', 'Agent', 'Read'], true, safe())).toEqual(['C[A0,A1]', 'S[R2]']);
    // The SUBAGENT path never forms a run, marker or not.
    expect(shape(['Read', 'Grep'], false, safe('Read', 'Grep'))).toEqual(['S[R0,G1]']);
  });

  it('a Read+Grep round overlaps; journal + wire order stay BATCH order even when Grep settles first', async () => {
    const appended: Array<{ type: string; toolUseId?: string }> = [];
    const fakeJournal = {
      append: async (e: { payload: { type: string; toolUseId?: string } }) => {
        appended.push({ type: e.payload.type, ...(e.payload.toolUseId !== undefined && { toolUseId: e.payload.toolUseId }) });
        return { uuid: `u${appended.length}` } as unknown as JournalEntry;
      },
    } as unknown as Journal;
    const log: string[] = [];
    const active = { now: 0, max: 0 };
    // Read is HELD until Grep completes — so the LATER batch member settles FIRST,
    // and only the PASS-2 batch-order drain can keep the journal in wire order.
    let releaseRead!: () => void;
    const readHeld = new Promise<void>((r) => { releaseRead = r; });
    const readDef = makeSafeDef('Read', log, active, { holdUntil: readHeld });
    const grepDef = makeSafeDef('Grep', log, active, { onDone: () => releaseRead() });
    const transport = makeScriptedTransport([[
      toolUse('r1', 'Read', { tag: 'r1' }),
      toolUse('g1', 'Grep', { tag: 'g1' }),
      doneEv(),
    ]]);
    const st = freshState();
    const { events, round } = await drive(
      // reconstructionCheck off: the append-only fake journal has no project();
      // journal ORDER is asserted below via the append capture itself.
      mainDeps(transport, { cfg: { journal: fakeJournal, reconstructionCheck: 'off' }, tools: [readDef, grepDef] }),
      st,
    );
    // Both genuinely in flight at once, and Grep finished while Read still ran.
    expect(active.max).toBe(2);
    expect(log).toEqual(['start:r1', 'start:g1', 'end:g1', 'end:r1']);
    // Results settle in BATCH order regardless of completion order.
    expect(round.results.map((r) => r.text)).toEqual(['Read:r1', 'Grep:g1']);
    // Wire order: PASS 1 emits both tool_use blocks up-front, PASS 2 drains results
    // in batch order — the same two-phase shape a concurrent Agent run has.
    expect(blockSeq(events)).toEqual([
      'tool_use:r1', 'tool_use:g1', 'tool_result:r1', 'tool_result:g1',
    ]);
    // THE LOAD-BEARING INVARIANT: journal append order = wire order.
    expect(appended.filter((e) => e.type === 'tool_use' || e.type === 'tool_result')
      .map((e) => `${e.type}:${e.toolUseId}`)).toEqual([
      'tool_use:r1', 'tool_use:g1', 'tool_result:r1', 'tool_result:g1',
    ]);
    // No synthesized subagent:start for non-Agent lanes (no subagent_type input).
    expect(startSeq(events)).toEqual([]);
    // Per-tool ACTION billing rides for both, batch order (parity with sequential).
    const billed = events
      .filter((e): e is Extract<HarnessEvent, { kind: 'raw' }> => e.kind === 'raw' && (e as { event: string }).event === 'agent:tool_billing')
      .map((e) => (e.data as { toolUseId: string }).toolUseId);
    expect(billed).toEqual(['r1', 'g1']);
  });

  it('UNDECLARED tools stay sequential (fail-closed): the same round without the marker is pairwise', async () => {
    const log: string[] = [];
    const transport = makeScriptedTransport([[
      toolUse('r1', 'Read', { tag: 'r1' }),
      toolUse('g1', 'Grep', { tag: 'g1' }),
      doneEv(),
    ]]);
    const st = freshState();
    const { events } = await drive(
      mainDeps(transport, { tools: [makeSeqDef('Read', log), makeSeqDef('Grep', log)] }),
      st,
    );
    expect(log).toEqual(['start:r1', 'end:r1', 'start:g1', 'end:g1']);
    expect(blockSeq(events)).toEqual([
      'tool_use:r1', 'tool_result:r1', 'tool_use:g1', 'tool_result:g1',
    ]);
  });

  it('a concurrencySafe call beside a lone Agent forms ONE mixed run (Agent-or-safe) and overlaps', async () => {
    const log: string[] = [];
    const active = { now: 0, max: 0 };
    let releaseRead!: () => void;
    const readHeld = new Promise<void>((r) => { releaseRead = r; });
    const readDef = makeSafeDef('Read', log, active, { holdUntil: readHeld });
    const agentDef: RawToolOptions = {
      name: 'Agent',
      description: 'fake subagent',
      parameters: z.object({ tag: z.string() }),
      execute: async (input) => {
        const tag = (input as { tag: string }).tag;
        log.push(`start:${tag}`);
        active.now += 1;
        active.max = Math.max(active.max, active.now);
        await new Promise((r) => setTimeout(r, 5));
        active.now -= 1;
        log.push(`end:${tag}`);
        releaseRead();
        return `agent:${tag}`;
      },
    };
    const transport = makeScriptedTransport([[
      toolUse('r1', 'Read', { tag: 'r1' }),
      toolUse('a1', 'Agent', { tag: 'a1' }),
      doneEv(),
    ]]);
    const st = freshState();
    const { events, round } = await drive(mainDeps(transport, { tools: [readDef, agentDef] }), st);
    // The Agent started while the Read was still in flight: one 2-wide run.
    expect(active.max).toBe(2);
    expect(log).toEqual(['start:r1', 'start:a1', 'end:a1', 'end:r1']);
    expect(round.results.map((r) => r.text)).toEqual(['Read:r1', 'agent:a1']);
    expect(blockSeq(events)).toEqual([
      'tool_use:r1', 'tool_use:a1', 'tool_result:r1', 'tool_result:a1',
    ]);
  });

  it('the fuel tank (§1a) keeps gating Agent members of a mixed run but NEVER denies a concurrencySafe member', async () => {
    _resetFuelTanksForTest();
    const MODEL = 'claude-sonnet-4-6';
    const reserve = defaultNodeReserveUsd(MODEL, resolveCapabilities(MODEL).maxOutputTokens);
    const log: string[] = [];
    const active = { now: 0, max: 0 };
    const readDef = makeSafeDef('Read', log, active);
    const { def: agentDef } = makeAgentDef({ r1: 2 }, log);
    const transport = makeScriptedTransport([[
      toolUse('r1', 'Read', { tag: 'r1' }),
      toolUse('a1', 'Agent', { tag: 'a1', run: 'r1' }),
      toolUse('a2', 'Agent', { tag: 'a2', run: 'r1' }),
      doneEv(),
    ]]);
    const st = freshState();
    const { events, round } = await drive(
      mainDeps(transport, {
        // Ceiling below ONE node's reserve → every Agent member is denied before
        // launch; the Read member must run anyway (sequential never fuel-gated it).
        ctx: { taskId: 'safe-fuel-t', sessionId: 's', cwd: '', model: MODEL, config: {}, signal: new AbortController().signal },
        cfg: { sessionFuelTankUsd: reserve / 2 },
        tools: [readDef, agentDef],
      }),
      st,
    );
    // One 3-wide run formed (two-phase emission), the Read executed…
    expect(blockSeq(events)).toEqual([
      'tool_use:r1', 'tool_use:a1', 'tool_use:a2',
      'tool_result:r1', 'tool_result:a1', 'tool_result:a2',
    ]);
    expect(log).toContain('start:r1');
    expect(round.results[0]).toMatchObject({ toolUseId: 'r1', text: 'Read:r1' });
    // …while both Agent nodes were denied at admission, never dispatched.
    for (const r of round.results.slice(1)) {
      expect(r.text).toContain('Skipped: session fuel ceiling');
      expect((r as { fuelDenied?: boolean }).fuelDenied).toBe(true);
    }
    expect(log).not.toContain('start:a1');
    expect(log).not.toContain('start:a2');
    _resetFuelTanksForTest();
  });

  it('a SUBAGENT (deps.sub) batch of concurrencySafe tools STAYS fully sequential', async () => {
    const log: string[] = [];
    const active = { now: 0, max: 0 };
    const readDef = makeSafeDef('Read', log, active);
    const grepDef = makeSafeDef('Grep', log, active);
    const transport = makeScriptedTransport([[
      toolUse('r1', 'Read', { tag: 'r1' }),
      toolUse('g1', 'Grep', { tag: 'g1' }),
      doneEv(),
    ]]);
    const st = freshState();
    const deps: RoundDeps = {
      ctx: { taskId: 'sub-safe-t', sessionId: 's', cwd: '', model: 'm', config: {}, signal: new AbortController().signal },
      cfg: {},
      transport,
      harness: allowHarness,
      tools: [readDef, grepDef],
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
        foldRoundCost: () => {},
        persistRound: async () => {},
        execCtx: {},
      },
    } as RoundDeps;
    const { round } = await drive(deps, st);
    expect(active.max).toBe(1);
    expect(log).toEqual(['start:r1', 'end:r1', 'start:g1', 'end:g1']);
    expect(round.results.map((r) => r.text)).toEqual(['Read:r1', 'Grep:g1']);
  });
});
