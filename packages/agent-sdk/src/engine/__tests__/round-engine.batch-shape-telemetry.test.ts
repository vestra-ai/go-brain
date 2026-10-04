/**
 * Per-round tool-batch SEGMENT SHAPE telemetry (`custom` key `tool_batch_shape`).
 *
 * The question this exists to answer in one SQL predicate: when a user asked for
 * three subagents "in parallel" and got them one at a time, WAS IT the harness or
 * the model? Answering it previously meant reconstructing round boundaries by hand
 * out of `usage source:'round'` journal entries — forensics that produced a
 * confident WRONG answer in both directions (the turn-shaped `messages` view reads
 * N rounds as one batch; an unscoped journal grouping folds a SUBAGENT's Agent
 * calls into its parent's round).
 *
 * So the assertions here are deliberately SHAPE assertions, never booleans. The
 * load-bearing pair is `three rounds of one Agent` vs `one round of three Agents`:
 * both spawn three subagents, both are "telemetry emitted", and only the recorded
 * shape tells them apart. A telemetry leg that cannot distinguish them records
 * nothing of value, which is exactly the state this replaces.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { GateResult, ToolCall } from '../../contract/harness.js';
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
import { runOneRound, type RoundDeps, type RoundState } from '../round-engine.js';

/** The recorded segment shape, as the journal holds it. */
interface BatchShape {
  round: number;
  api: string;
  model: string;
  tools: number;
  eligible: number;
  agents: number;
  widths: number[];
}

function makeScriptedTransport(rounds: StreamEvent[][], api = 'openai_responses'): Transport {
  let i = 0;
  const t: Partial<Transport> = {
    api,
    provider: 'openai',
    defaultModel: () => 'gpt-5.6-luna',
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
  lastUsageModel: 'gpt-5.6-luna',
});

/** A journal fake that keeps ONLY the `tool_batch_shape` rows, in append order. */
function makeShapeJournal(): { journal: Journal; shapes: BatchShape[]; allKinds: string[] } {
  const shapes: BatchShape[] = [];
  const allKinds: string[] = [];
  let n = 0;
  const journal = {
    append: async (e: { payload: { type: string; key?: string; data?: unknown } }) => {
      n += 1;
      allKinds.push(e.payload.type === 'custom' ? `custom:${e.payload.key}` : e.payload.type);
      if (e.payload.type === 'custom' && e.payload.key === 'tool_batch_shape') {
        shapes.push(e.payload.data as BatchShape);
      }
      return { uuid: `u${n}` } as unknown as JournalEntry;
    },
  } as unknown as Journal;
  return { journal, shapes, allKinds };
}

function mainDeps(transport: Transport, journal: Journal, over: Partial<RoundDeps> = {}): RoundDeps {
  return {
    ctx: { taskId: 't', sessionId: 's', cwd: '', model: 'gpt-5.6-luna', config: {}, signal: new AbortController().signal },
    cfg: { journal, reconstructionCheck: 'off' },
    transport,
    rc: createRunContext('t'),
    harness: allowHarness,
    dispatcher: createNativeHookDispatcher(allowHarness),
    tools: [],
    providerTools: [],
    system: 'sys',
    onPause,
    onAuthHalt: undefined,
    requestedModel: 'gpt-5.6-luna',
    cachePrefixHint: undefined,
    history: transport.emptyHistory(),
    turnBlocks: [],
    pendingTodoBlocks: [],
    ...over,
  } as RoundDeps;
}

async function drive(deps: RoundDeps, st: RoundState): Promise<void> {
  const gen = runOneRound(deps, st);
  let n = await gen.next();
  while (!n.done) n = await gen.next();
}

/** Drive N scripted rounds through ONE RunContext (so `round` increments honestly). */
async function driveRounds(
  rounds: StreamEvent[][],
  tools: RawToolOptions[],
  over: Partial<RoundDeps> = {},
): Promise<{ shapes: BatchShape[]; allKinds: string[] }> {
  const { journal, shapes, allKinds } = makeShapeJournal();
  const transport = makeScriptedTransport(rounds);
  const deps = mainDeps(transport, journal, { tools, ...over });
  for (let i = 0; i < rounds.length; i += 1) await drive(deps, freshState());
  return { shapes, allKinds };
}

const doneEv = (stop = 'tool_use'): StreamEvent =>
  ({ kind: 'done', stopReason: stop, usage: { inputTokens: 1, outputTokens: 1 } });

const toolUse = (id: string, name: string): StreamEvent =>
  ({ kind: 'tool_use', toolUse: { id, name, input: { tag: id } } });

/** A trivially-fast fake tool; `concurrencySafe` mirrors the real read-only family. */
function fakeTool(name: string, concurrencySafe = false): RawToolOptions {
  return {
    name,
    description: `fake ${name}`,
    parameters: z.object({ tag: z.string() }),
    ...(concurrencySafe ? { concurrencySafe: true } : {}),
    execute: async (input) => `${name}:${(input as { tag: string }).tag}`,
  };
}

const agentDef = fakeTool('Agent');

describe('runOneRound — tool_batch_shape telemetry', () => {
  it('THE DISCRIMINATOR: 3 rounds of one Agent and 1 round of three Agents record DIFFERENT shapes', async () => {
    // The founder's report: three subagents, strictly sequential. The model emitted
    // ONE Agent per round, so the engine never saw a batch to run concurrently.
    const sequential = await driveRounds(
      [
        [toolUse('a1', 'Agent'), doneEv()],
        [toolUse('a2', 'Agent'), doneEv()],
        [toolUse('a3', 'Agent'), doneEv()],
      ],
      [agentDef],
    );
    expect(sequential.shapes).toEqual([
      { round: 1, api: 'openai_responses', model: 'gpt-5.6-luna', tools: 1, eligible: 1, agents: 1, widths: [] },
      { round: 2, api: 'openai_responses', model: 'gpt-5.6-luna', tools: 1, eligible: 1, agents: 1, widths: [] },
      { round: 3, api: 'openai_responses', model: 'gpt-5.6-luna', tools: 1, eligible: 1, agents: 1, widths: [] },
    ]);

    // The compliant shape: same three subagents, ONE round, one 3-wide run.
    const batched = await driveRounds(
      [[toolUse('a1', 'Agent'), toolUse('a2', 'Agent'), toolUse('a3', 'Agent'), doneEv()]],
      [agentDef],
    );
    expect(batched.shapes).toEqual([
      { round: 1, api: 'openai_responses', model: 'gpt-5.6-luna', tools: 3, eligible: 3, agents: 3, widths: [3] },
    ]);

    // Both spawned three subagents. Only the SHAPE separates them — a leg that
    // recorded "a batch happened" or "n rounds emitted telemetry" could not.
    const spawned = (s: BatchShape[]): number => s.reduce((n, r) => n + r.agents, 0);
    expect(spawned(sequential.shapes)).toBe(spawned(batched.shapes));
    expect(sequential.shapes.flatMap((s) => s.widths)).toEqual([]);
    expect(batched.shapes.flatMap((s) => s.widths)).toEqual([3]);
  });

  it('records ONLY the concurrent runs’ widths, not every segment’s', async () => {
    // [TaskCreate, TaskCreate, Agent, Agent, Agent] partitions to
    // S[tc1,tc2] then C[a1,a2,a3]. Recording `segments.map(len)` instead of
    // `segments.filter(concurrent).map(len)` yields [2,3] — the sequential
    // segment masquerading as a second parallel run.
    const { shapes } = await driveRounds(
      [[
        toolUse('tc1', 'TaskCreate'), toolUse('tc2', 'TaskCreate'),
        toolUse('a1', 'Agent'), toolUse('a2', 'Agent'), toolUse('a3', 'Agent'),
        doneEv(),
      ]],
      [fakeTool('TaskCreate'), agentDef],
    );
    expect(shapes).toHaveLength(1);
    expect(shapes[0].widths).toEqual([3]);
    expect(shapes[0]).toMatchObject({ tools: 5, eligible: 3, agents: 3 });
  });

  it('two runs split by a barrier record TWO widths, not one merged width', async () => {
    // [Agent, Agent, Write, Agent, Agent] — the undeclared Write is a hard
    // barrier, so this is C[2] · S[1] · C[2], NOT one 4-wide run. A scalar
    // `maxWidth`/`runs` field, or summing the widths, collapses the distinction.
    const { shapes } = await driveRounds(
      [[
        toolUse('a1', 'Agent'), toolUse('a2', 'Agent'),
        toolUse('w1', 'Write'),
        toolUse('a3', 'Agent'), toolUse('a4', 'Agent'),
        doneEv(),
      ]],
      [agentDef, fakeTool('Write')],
    );
    expect(shapes[0].widths).toEqual([2, 2]);
    expect(shapes[0]).toMatchObject({ tools: 5, eligible: 4, agents: 4 });
  });

  it('counts concurrencySafe reads as eligible but NOT as agents', async () => {
    const { shapes } = await driveRounds(
      [[toolUse('r1', 'Read'), toolUse('g1', 'Grep'), toolUse('a1', 'Agent'), doneEv()]],
      [fakeTool('Read', true), fakeTool('Grep', true), agentDef],
    );
    // All three are consecutive and eligible → one 3-wide mixed run (W3-2).
    expect(shapes[0]).toEqual({
      round: 1, api: 'openai_responses', model: 'gpt-5.6-luna',
      tools: 3, eligible: 3, agents: 1, widths: [3],
    });
  });

  it('THE GATE: a lone Agent round IS recorded; a lone undeclared tool round is NOT', async () => {
    // The cheap `tools >= 2` gate would silence exactly the defect shape — a
    // round whose single tool_use is an Agent. It must survive the gate; a
    // single Bash (one possible shape, always) must not pay for a row.
    const { shapes, allKinds } = await driveRounds(
      [
        [toolUse('b1', 'Bash'), doneEv()],
        [toolUse('a1', 'Agent'), doneEv()],
      ],
      [fakeTool('Bash'), agentDef],
    );
    expect(shapes).toEqual([
      { round: 2, api: 'openai_responses', model: 'gpt-5.6-luna', tools: 1, eligible: 1, agents: 1, widths: [] },
    ]);
    // …and the skipped round really did journal (it is gated, not journal-less).
    expect(allKinds.filter((k) => k === 'custom:tool_batch_shape')).toHaveLength(1);
    expect(allKinds).toContain('assistant');
  });

  it('a round of two undeclared tools is recorded (a real partition) with no concurrent run', async () => {
    const { shapes } = await driveRounds(
      [[toolUse('b1', 'Bash'), toolUse('b2', 'Bash'), doneEv()]],
      [fakeTool('Bash')],
    );
    expect(shapes[0]).toMatchObject({ tools: 2, eligible: 0, agents: 0, widths: [] });
  });

  it('a text-only round records nothing', async () => {
    const { shapes } = await driveRounds([[doneEv('end_turn')]], [agentDef]);
    expect(shapes).toEqual([]);
  });

  it('a SUBAGENT round records nothing — its partition is a hard-wired constant', async () => {
    // partitionToolBatch returns one sequential segment whenever !mainLoop, so
    // there is no decision to observe; writing these rows would re-create the
    // scope mixing that corrupted the parent-vs-child round counts.
    const { journal, shapes } = makeShapeJournal();
    const transport = makeScriptedTransport([[
      toolUse('a1', 'Agent'), toolUse('a2', 'Agent'), doneEv(),
    ]]);
    const deps = {
      ...mainDeps(transport, journal, { tools: [agentDef] }),
      rc: undefined,
      dispatcher: undefined,
      sub: { foldRoundCost: () => {}, persistRound: async () => {}, execCtx: {} },
    } as unknown as RoundDeps;
    await drive(deps, freshState());
    expect(shapes).toEqual([]);
  });

  it('tags the row with the ARM and the COMMITTED model, so no join is needed', async () => {
    const { journal, shapes } = makeShapeJournal();
    const transport = makeScriptedTransport(
      [[toolUse('a1', 'Agent'), toolUse('a2', 'Agent'), doneEv()]],
      'anthropic_messages',
    );
    await drive(mainDeps(transport, journal, { tools: [agentDef] }), freshState());
    expect(shapes[0].api).toBe('anthropic_messages');
    expect(shapes[0].model).toBe('gpt-5.6-luna');
  });

  it('a journal-less run is unaffected (no throw, no row)', async () => {
    const transport = makeScriptedTransport([[toolUse('a1', 'Agent'), doneEv()]]);
    const deps = {
      ...mainDeps(transport, undefined as unknown as Journal, { tools: [agentDef] }),
      cfg: {},
    } as RoundDeps;
    await expect(drive(deps, freshState())).resolves.toBeUndefined();
  });
});
