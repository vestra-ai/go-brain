/**
 * P2.5 — sibling `subagent:end` drop: LOOP-LEVEL reproduction harness.
 *
 * Founder symptom: a 3-wide parallel Agent batch whose children return
 * ~simultaneously loses 2-of-3 SUBAGENT_END events before the web (#1367's
 * heal then masks the hang). These tests pin the emit→PushQueue→yield boundary
 * inside runOneRound's concurrent PASS-2 drain: every SUBAGENT_* event a child
 * pushes — however simultaneous the settles — must surface from the loop,
 * per-lane ordered (…deltas… end → tool_result), lanes in batch order.
 *
 * The fake Agent mirrors agent-tool.ts's emit(): ctx.pushEvent({kind:'raw',
 * engine:'native', event, data:{taskId, toolUseId, seq, …}}) with a per-child
 * monotonic seq — the same instrumentation runOneChild now stamps in prod.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { RawToolOptions, ToolExecuteContext } from '../../tools/tool-types.js';
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

type RawEv = Extract<HarnessEvent, { kind: 'raw' }>;
const rawSeq = (events: HarnessEvent[], name: string): Array<Record<string, unknown>> =>
  events
    .filter((e): e is RawEv => e.kind === 'raw' && (e as RawEv).event === name)
    .map((e) => e.data as Record<string, unknown>);

/**
 * Lane-relevant projection: subagent raws as `<event>:<toolUseId>`, tool_result
 * blocks as `res:<toolUseId>` — proves per-lane END-before-result and lane order.
 */
const laneEventSeq = (events: HarnessEvent[]): string[] =>
  events.flatMap((e) => {
    if (e.kind === 'raw' && (e as RawEv).event.startsWith('subagent:')) {
      const d = (e as RawEv).data as { toolUseId?: string };
      return [`${(e as RawEv).event.slice('subagent:'.length)}:${d.toolUseId}`];
    }
    if (e.kind === 'block') {
      const b = e.block as { type: string; toolUseId?: string };
      if (b.type === 'tool_result') return [`res:${b.toolUseId}`];
    }
    return [];
  });

/**
 * The emitting fake Agent — mirrors agent-tool.ts runOneChild:
 *  emit(SUBAGENT_START) → work → emit(SUBAGENT_TEXT_DELTA)×n → emit(SUBAGENT_END) → return.
 * A per-run barrier holds every sibling until `width` have arrived, then releases
 * them ALL in the same microtask cascade — the "return ~simultaneously" shape.
 * Each child stamps a per-child monotonic `seq` on every SUBAGENT_* event.
 */
function makeEmittingAgentDef(width: number): RawToolOptions {
  let entered = 0;
  const waiters: Array<() => void> = [];
  return {
    name: 'Agent',
    description: 'fake subagent that emits SUBAGENT_* like the real tool',
    parameters: z.object({ tag: z.string(), deltas: z.number().optional() }),
    execute: async (input, ctx: ToolExecuteContext) => {
      const { tag, deltas = 2 } = input as { tag: string; deltas?: number };
      const toolUseId = ctx.toolCallId ?? tag;
      let seq = 0;
      const emit = (event: string, data: Record<string, unknown>): void => {
        ctx.pushEvent?.({
          kind: 'raw',
          engine: 'native',
          event,
          data: { taskId: 't', toolUseId, seq: seq++, ...data },
        });
      };
      emit('subagent:start', { agentSlug: 'fake', prompt: tag });
      for (let i = 0; i < deltas; i++) emit('subagent:text_delta', { delta: `${tag}-${i}` });
      // Barrier: every sibling parks here; the last arrival releases ALL of them
      // synchronously, so the ENDs are pushed + the dispatches settle in ONE
      // microtask cascade — the tightest "simultaneous return" the loop can see.
      entered += 1;
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        if (entered >= width) for (const w of waiters.splice(0)) w();
      });
      emit('subagent:end', { result: `out:${tag}`, summary: `${tag} finished` });
      return `agent:${tag}`;
    },
  };
}

describe('runOneRound — concurrent PASS-2 drain never drops a sibling subagent:end', () => {
  it('3-wide batch, simultaneous settles: all 3 subagent:end surface, per-lane ordered, no seq gaps', async () => {
    const transport = makeScriptedTransport([[
      toolUse('a1', 'Agent', { tag: 'a1' }),
      toolUse('a2', 'Agent', { tag: 'a2' }),
      toolUse('a3', 'Agent', { tag: 'a3' }),
      doneEv(),
    ]]);
    const { events, round } = await drive(
      mainDeps(transport, { tools: [makeEmittingAgentDef(3)] }),
      freshState(),
    );

    expect(round.results.map((r) => r.text)).toEqual(['agent:a1', 'agent:a2', 'agent:a3']);

    // THE invariant under test: every lane's END surfaces — none coalesced/dropped.
    const ends = rawSeq(events, 'subagent:end');
    expect(ends.map((d) => d.toolUseId)).toEqual(['a1', 'a2', 'a3']);

    // Per-child seq is gap-free: for each lane, the observed seqs are 0..n-1.
    for (const id of ['a1', 'a2', 'a3']) {
      const seqs = events
        .filter((e): e is RawEv => e.kind === 'raw' && String((e as RawEv).event).startsWith('subagent:'))
        .map((e) => e.data as { toolUseId: string; seq: number })
        .filter((d) => d.toolUseId === id)
        .map((d) => d.seq);
      expect(seqs).toEqual(seqs.map((_, i) => i));
    }

    // Per-lane order: start → deltas → end → THEN the lane's tool_result, lanes
    // drained in batch order (PASS-2), plus the PASS-1 synthesized starts up-front.
    const lane = laneEventSeq(events).filter((s) => !s.startsWith('text_delta'));
    expect(lane).toEqual([
      // PASS-1 synthesized starts (round-engine) — no subagent_type in input, so
      // none synthesized here; the tool's own starts stream on the lane drains:
      'start:a1', 'end:a1', 'res:a1',
      'start:a2', 'end:a2', 'res:a2',
      'start:a3', 'end:a3', 'res:a3',
    ]);
  });

  it('staggered settles mid-drain: a sibling that ends while lane 1 is being drained still lands its END', async () => {
    // No barrier (width 1 ⇒ instant release), but stagger the children across
    // macrotasks so a2/a3 settle WHILE PASS-2 is already draining a1's queue.
    let entered = 0;
    const def: RawToolOptions = {
      name: 'Agent',
      description: 'staggered fake subagent',
      parameters: z.object({ tag: z.string() }),
      execute: async (input, ctx: ToolExecuteContext) => {
        const { tag } = input as { tag: string };
        const toolUseId = ctx.toolCallId ?? tag;
        let seq = 0;
        const emit = (event: string, data: Record<string, unknown>): void => {
          ctx.pushEvent?.({ kind: 'raw', engine: 'native', event, data: { taskId: 't', toolUseId, seq: seq++, ...data } });
        };
        emit('subagent:start', { agentSlug: 'fake' });
        const myDelay = entered++ * 5;
        await new Promise((r) => setTimeout(r, myDelay));
        emit('subagent:end', { result: `out:${tag}` });
        return `agent:${tag}`;
      },
    };
    const transport = makeScriptedTransport([[
      toolUse('b1', 'Agent', { tag: 'b1' }),
      toolUse('b2', 'Agent', { tag: 'b2' }),
      toolUse('b3', 'Agent', { tag: 'b3' }),
      doneEv(),
    ]]);
    const { events } = await drive(mainDeps(transport, { tools: [def] }), freshState());
    expect(rawSeq(events, 'subagent:end').map((d) => d.toolUseId)).toEqual(['b1', 'b2', 'b3']);
  });
});
