/**
 * Harness-9 W2 — the reconstruction invariant: the provider history the round
 * engine is about to SEND must equal what the journal re-derives through the
 * canonical projection. Pure-function contract first (checkReconstruction), then
 * the ONE call site in runOneRound (mode ladder: off / warn / throw + the sink),
 * then the cost of the check on a ~200k-token (~1 MB JSON) history — the number
 * the PR body records.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { checkReconstruction, RECONSTRUCTION_MISMATCH_EVENT } from '../reconstruction-invariant.js';
import { wireMessages, type FrozenElision } from '../context-elision.js';
import { elideProjection } from '../../kernel/compaction/elide.js';
import { journalToAnthropicMessages } from '../native-messages.js';
import { runOneRound, type RoundDeps, type RoundState } from '../round-engine.js';
import { createRunContext } from '../run-context.js';
import { createNativeHookDispatcher } from '../native-hooks.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { NormalizedUsage, ProviderHistory, ProviderStream, StreamEvent, Transport } from '../transport.js';

describe('checkReconstruction', () => {
  it('returns null when the incremental history equals the projection', () => {
    const h = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: 'yo' }] }];
    expect(checkReconstruction({ round: 1, incremental: h, projected: structuredClone(h) })).toBeNull();
  });
  it('names the first diverging index and both heads', () => {
    const a = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: 'yo' }] }];
    const b = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: 'YO' }] }];
    const m = checkReconstruction({ round: 3, incremental: a, projected: b });
    expect(m).toMatchObject({ round: 3, firstDivergingIndex: 1, incrementalLength: 2, projectedLength: 2 });
    expect(m!.incrementalHead).toContain('"yo"');
    expect(m!.projectedHead).toContain('"YO"');
  });
  it('a length mismatch diverges at the shorter length', () => {
    const a = [{ role: 'user', content: 'hi' }];
    const b = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [] }];
    expect(checkReconstruction({ round: 1, incremental: a, projected: b })!.firstDivergingIndex).toBe(1);
  });
  it('compares structurally with stable key order (property order never counts as drift)', () => {
    const a = [{ role: 'user', content: 'hi' }];
    const b = [{ content: 'hi', role: 'user' }];
    expect(checkReconstruction({ round: 1, incremental: a, projected: b })).toBeNull();
  });
  it('an undefined-valued key is absent (JSON semantics), null is a value', () => {
    expect(checkReconstruction({ round: 1, incremental: [{ a: 1, b: undefined }], projected: [{ a: 1 }] })).toBeNull();
    expect(checkReconstruction({ round: 1, incremental: [{ a: 1, b: null }], projected: [{ a: 1 }] })).not.toBeNull();
  });
  it('heads are capped at 200 chars and name the absent side', () => {
    const big = [{ role: 'user', content: 'x'.repeat(1000) }];
    const m = checkReconstruction({ round: 1, incremental: big, projected: [] })!;
    expect(m.incrementalHead.length).toBe(200);
    expect(m.projectedHead).toBe('<absent>');
  });
});

describe('RECONSTRUCTION_MISMATCH_EVENT', () => {
  it('is the agent-namespaced anomaly event name, byte-for-byte', () => {
    // THE PIN. The engine imports no @bash/*, so this constant is a hand-mirror of
    // EVENTS.AGENT_RECONSTRUCTION_MISMATCH. Drift it and nothing else fails: the
    // sandbox emits a name LIFECYCLE_HANDLERS has no entry for, the event is dropped,
    // no error_events row is written — the "reports failure into a void" condition
    // this whole rail exists to close, restored silently under a green suite. The
    // shared half is pinned by tests/events/registry-bytecompat.test.ts (OLD_EVENTS);
    // this is the other half, and it mirrors billing-tripwire.test.ts's pin exactly.
    expect(RECONSTRUCTION_MISMATCH_EVENT).toBe('agent:reconstruction_mismatch');
  });
});

// ── the call site: runOneRound, main loop, journal path ──────────────────────

const dir = join(tmpdir(), `reconstruction-invariant-${process.pid}`);
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

const makeJournal = (taskId: string): Journal =>
  new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2026-01-01T00:00:00.000Z'),
  });

/** A transport whose projection is a DETERMINISTIC function of the entries (unlike
 *  FakeTransport's constant `[]`), so the invariant has something real to compare. */
function projectingTransport(rounds: StreamEvent[][]): Transport {
  let i = 0;
  const t: Partial<Transport> = {
    api: 'fake',
    provider: 'fake',
    defaultModel: () => 'm',
    emptyHistory: () => [] as unknown as ProviderHistory,
    historyFromJournal: (entries: JournalEntry[]) =>
      entries.map((e) => ({ role: e.payload.type, payload: e.payload })) as unknown as ProviderHistory,
    pushUser: (h) => { (h as unknown[]).push({ role: 'user' }); },
    pushAssistant: (h, blocks) => { (h as unknown[]).push({ role: 'assistant', blocks }); },
    pushToolResult: (h, r) => { (h as unknown[]).push({ role: 'tool_result', r }); },
    buildTools: (raw) => raw as unknown[],
    callModel: () =>
      (rounds[i++] ?? [{ kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }]) as unknown as ProviderStream,
    // eslint-disable-next-line require-yield
    readStream: async function* (stream) { for (const ev of stream as StreamEvent[]) yield ev; },
    computeCostUsd: (u: NormalizedUsage) => (u.inputTokens + u.outputTokens) * 0.00001,
    classifyError: (err) => ({ kind: 'model_error', message: String(err), raw: { subtype: 'model_error', errors: [] } }) as never,
  };
  return t as Transport;
}

const allowHarness = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };
const freshState = (): RoundState => ({
  assistantText: '', thinkingBlocks: [], toolUses: [], roundAppended: false, inToolBatch: false,
  stopReason: null, lastUsage: { inputTokens: 0, outputTokens: 0 }, lastUsageModel: 'm',
});
const textRound = (): StreamEvent[] => [
  { kind: 'text', text: 'answer' },
  { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
];

async function seeded(taskId: string): Promise<{ journal: Journal; projected: ProviderHistory; transport: Transport }> {
  const journal = makeJournal(taskId);
  await journal.append({
    taskId, rootTaskId: taskId, spawnDepth: 0, workspaceId: 'w', agentId: 'native',
    principal: { kind: 'user', userId: 'u' }, timestamp: '',
    payload: { type: 'user', blocks: [{ type: 'text', text: 'hi' }] },
  });
  const transport = projectingTransport([textRound(), textRound()]);
  const projected = transport.historyFromJournal((await journal.project()).messages);
  return { journal, projected, transport };
}

function mainDeps(transport: Transport, journal: Journal, history: ProviderHistory, cfg: RoundDeps['cfg'] = {}): RoundDeps {
  return {
    ctx: { taskId: journal.taskId, sessionId: 's', cwd: '', model: 'm', config: {}, signal: new AbortController().signal },
    cfg: { journal, ...cfg },
    transport,
    rc: createRunContext(journal.taskId),
    harness: allowHarness,
    dispatcher: createNativeHookDispatcher(allowHarness),
    tools: [],
    providerTools: [],
    system: 'sys',
    onPause: async () => 'PAUSED',
    onAuthHalt: undefined,
    requestedModel: 'm',
    cachePrefixHint: undefined,
    history,
    turnBlocks: [],
    pendingTodoBlocks: [],
  } as RoundDeps;
}

async function drive(deps: RoundDeps, st: RoundState): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  const gen = runOneRound(deps, st);
  let n = await gen.next();
  while (!n.done) { events.push(n.value); n = await gen.next(); }
  return events;
}

describe('runOneRound — reconstruction check at the request site', () => {
  it('a history equal to the projection passes silently in every mode', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const mode of ['warn', 'throw', 'off'] as const) {
      const { journal, projected, transport } = await seeded(`eq-${mode}`);
      const sink = vi.fn();
      await drive(mainDeps(transport, journal, projected, { reconstructionCheck: mode, onReconstructionMismatch: sink }), freshState());
      expect(sink).not.toHaveBeenCalled();
    }
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('reconstruction'))).toHaveLength(0);
  });

  it("'throw' mode throws a structured error naming the divergence before any model call", async () => {
    const { journal, transport } = await seeded('throw');
    const divergent = [{ role: 'user', payload: { type: 'user', blocks: [{ type: 'text', text: 'NOT hi' }] } }] as unknown as ProviderHistory;
    const sink = vi.fn();
    await expect(
      drive(mainDeps(transport, journal, divergent, { reconstructionCheck: 'throw', onReconstructionMismatch: sink }), freshState()),
    ).rejects.toThrow(/reconstruction mismatch: .*"firstDivergingIndex":0/);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toMatchObject({ round: 1, firstDivergingIndex: 0, incrementalLength: 1, projectedLength: 1 });
    // Nothing was journaled: the throw fired before callModel.
    const entries: JournalEntry[] = [];
    for await (const e of journal.read()) entries.push(e);
    expect(entries.map((e) => e.payload.type)).toEqual(['user']);
  });

  it("'warn' (the default) logs ONCE per turn, feeds the sink every round, and the round still runs", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { journal, transport } = await seeded('warn');
    const divergent = [] as unknown as ProviderHistory;
    const sink = vi.fn();
    const st = freshState();
    // Two rounds on the SAME RoundState (= the same turn): one warning, two sink calls.
    await drive(mainDeps(transport, journal, divergent, { onReconstructionMismatch: sink }), st);
    st.assistantText = ''; st.thinkingBlocks = []; st.toolUses = []; st.roundAppended = false;
    await drive(mainDeps(transport, journal, divergent, { onReconstructionMismatch: sink }), st);
    expect(sink).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('reconstruction_mismatch'))).toHaveLength(1);
    const entries: JournalEntry[] = [];
    for await (const e of journal.read()) entries.push(e);
    expect(entries.filter((e) => e.payload.type === 'assistant')).toHaveLength(2);
  });

  it("'off' never projects and never compares", async () => {
    const { journal, transport } = await seeded('off');
    const spy = vi.spyOn(journal, 'project');
    const sink = vi.fn();
    await drive(mainDeps(transport, journal, [] as unknown as ProviderHistory, { reconstructionCheck: 'off', onReconstructionMismatch: sink }), freshState());
    expect(spy).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
  });

  it('under CONTEXT_ELISION_V1 the check waits for the frozen elision instead of projecting raw', async () => {
    process.env.CONTEXT_ELISION_V1 = '1';
    try {
      const divergent = [] as unknown as ProviderHistory;
      // elision NOT threaded → no projection, no verdict (a raw compare would be a false positive).
      const a = await seeded('elision-absent');
      const spyA = vi.spyOn(a.journal, 'project');
      const sinkA = vi.fn();
      await drive(mainDeps(a.transport, a.journal, divergent, { reconstructionCheck: 'throw', onReconstructionMismatch: sinkA }), freshState());
      expect(spyA).not.toHaveBeenCalled();
      expect(sinkA).not.toHaveBeenCalled();
      // elision threaded (null = nothing elidable this turn) → the check runs.
      const b = await seeded('elision-null');
      const sinkB = vi.fn();
      await expect(
        drive({ ...mainDeps(b.transport, b.journal, divergent, { reconstructionCheck: 'throw', onReconstructionMismatch: sinkB }), elision: null }, freshState()),
      ).rejects.toThrow(/reconstruction mismatch/);
      expect(sinkB).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.CONTEXT_ELISION_V1;
    }
  });

  it('a THROWING sink never ends the turn: warn mode still runs the round; throw mode still throws the mismatch, not the sink', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const divergent = [] as unknown as ProviderHistory;
    const badSink = (): void => { throw new Error('sink exploded'); };
    const a = await seeded('sink-warn');
    await drive(mainDeps(a.transport, a.journal, divergent, { onReconstructionMismatch: badSink }), freshState());
    const entries: JournalEntry[] = [];
    for await (const e of a.journal.read()) entries.push(e);
    expect(entries.filter((e) => e.payload.type === 'assistant')).toHaveLength(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('sink threw'))).toBe(true);
    const b = await seeded('sink-throw');
    await expect(
      drive(mainDeps(b.transport, b.journal, divergent, { reconstructionCheck: 'throw', onReconstructionMismatch: badSink }), freshState()),
    ).rejects.toThrow(/^reconstruction mismatch: /);
  });

  it('a failure INSIDE the check is swallowed with a warning — the turn is never the price of observability', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { journal, transport } = await seeded('inner-fail');
    vi.spyOn(journal, 'project').mockRejectedValueOnce(new Error('disk gone'));
    const sink = vi.fn();
    await drive(mainDeps(transport, journal, [] as unknown as ProviderHistory, { reconstructionCheck: 'throw', onReconstructionMismatch: sink }), freshState());
    expect(sink).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('reconstruction check failed'))).toBe(true);
  });
});

// ── the durable channel + the seam under a REAL elision ──────────────────────

/** Build a real non-null FrozenElision over a journal by running the SHIPPED
 *  elideProjection with an explicit cut (the cut POLICY is elide.test.ts's job;
 *  here we only need stubs actually on the wire). */
async function realElision(journal: Journal): Promise<FrozenElision> {
  const messages = (await journal.project()).messages;
  const cut = { resultCutTokens: 1_000_000, imageCutTokens: 1_000_000, strideTokens: 1000, anchor: null };
  const outcome = elideProjection(messages, cut, { taskId: journal.taskId });
  expect(outcome.replacements.size).toBeGreaterThan(0); // the fixture must really elide
  return {
    replacements: outcome.replacements,
    cut,
    elidedResults: outcome.elidedResults,
    elidedImages: outcome.elidedImages,
    freedTokens: outcome.freedTokens,
  };
}

/** A journal holding a tool_use + a tool_result big enough for the eliding
 *  projection to stub (minResultTokens is 500). */
async function seededWithBigResult(taskId: string): Promise<{ journal: Journal; transport: Transport }> {
  const journal = makeJournal(taskId);
  const base = {
    taskId, rootTaskId: taskId, spawnDepth: 0, workspaceId: 'w', agentId: 'native', timestamp: '',
  };
  await journal.append({ ...base, principal: { kind: 'user', userId: 'u' }, payload: { type: 'user', blocks: [{ type: 'text', text: 'hi' }] } });
  await journal.append({
    ...base, principal: { kind: 'agent', agentId: 'native' },
    payload: { type: 'tool_use', toolUseId: 'tu1', name: 'Read', input: { file_path: '/x' } },
  });
  await journal.append({
    ...base, principal: { kind: 'agent', agentId: 'native' },
    payload: { type: 'tool_result', toolUseId: 'tu1', blocks: [{ type: 'text', text: 'B'.repeat(20_000) }] },
  });
  return { journal, transport: projectingTransport([textRound(), textRound()]) };
}

describe('reconstruction mismatch — the durable channel', () => {
  it('emits ONE agent:reconstruction_mismatch raw event per turn, naming the divergence without transcript bytes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { journal, transport } = await seeded('raw-event');
    const divergent = [] as unknown as ProviderHistory;
    const st = freshState();
    const a = await drive(mainDeps(transport, journal, divergent, {}), st);
    st.assistantText = ''; st.thinkingBlocks = []; st.toolUses = []; st.roundAppended = false;
    const b = await drive(mainDeps(transport, journal, divergent, {}), st);

    const raws = [...a, ...b].filter(
      (e) => e.kind === 'raw' && (e as { event?: string }).event === RECONSTRUCTION_MISMATCH_EVENT,
    );
    // Two diverging rounds on ONE turn ⇒ exactly one durable row, like the console line.
    expect(raws).toHaveLength(1);
    const data = (raws[0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      taskId: journal.taskId,
      round: 1,
      firstDivergingIndex: 0,
      incrementalLength: 0,
      projectedLength: 1,
    });
    // Heads only — the payload names the KIND of divergence, never the content.
    expect(String(data.incrementalHead)).toBe('<absent>');
    expect(String(data.projectedHead).length).toBeLessThanOrEqual(200);
  });

  it('a clean turn emits no event at all', async () => {
    const { journal, projected, transport } = await seeded('raw-event-clean');
    const events = await drive(mainDeps(transport, journal, projected, {}), freshState());
    expect(events.filter((e) => e.kind === 'raw' && (e as { event?: string }).event === RECONSTRUCTION_MISMATCH_EVENT)).toHaveLength(0);
  });

  it("'off' mode emits no event even when the history diverges", async () => {
    const { journal, transport } = await seeded('raw-event-off');
    const events = await drive(
      mainDeps(transport, journal, [] as unknown as ProviderHistory, { reconstructionCheck: 'off' }),
      freshState(),
    );
    expect(events.filter((e) => e.kind === 'raw' && (e as { event?: string }).event === RECONSTRUCTION_MISMATCH_EVENT)).toHaveLength(0);
  });
});

describe('the check under a REAL non-null elision (the configuration a flag flip creates)', () => {
  it('a history built through the elided seam passes; the SAME journal projected RAW is caught', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.CONTEXT_ELISION_V1 = '1';
    try {
      // PASS: history built the way the turn head builds it — project() → wireMessages → historyFromJournal.
      const ok = await seededWithBigResult('elision-real-pass');
      const elisionOk = await realElision(ok.journal);
      const elided = ok.transport.historyFromJournal(
        wireMessages((await ok.journal.project()).messages, elisionOk),
      );
      const sinkOk = vi.fn();
      await drive(
        { ...mainDeps(ok.transport, ok.journal, elided, { reconstructionCheck: 'throw', onReconstructionMismatch: sinkOk }), elision: elisionOk },
        freshState(),
      );
      expect(sinkOk).not.toHaveBeenCalled();

      // FAIL: the raw rebuild — exactly what turn-decisions / severed-stream / compaction-recovery do.
      const bad = await seededWithBigResult('elision-real-fail');
      const elisionBad = await realElision(bad.journal);
      const raw = bad.transport.historyFromJournal((await bad.journal.project()).messages);
      const sinkBad = vi.fn();
      await expect(
        drive(
          { ...mainDeps(bad.transport, bad.journal, raw, { reconstructionCheck: 'throw', onReconstructionMismatch: sinkBad }), elision: elisionBad },
          freshState(),
        ),
      ).rejects.toThrow(/reconstruction mismatch/);
      expect(sinkBad).toHaveBeenCalledTimes(1);
      // It diverges AT the elided tool_result, not somewhere incidental.
      expect(sinkBad.mock.calls[0][0]).toMatchObject({ firstDivergingIndex: 2 });
      expect(String(sinkBad.mock.calls[0][0].projectedHead)).toContain('[elided:');
    } finally {
      delete process.env.CONTEXT_ELISION_V1;
    }
  });
});

// ── cost: the number the PR body records ─────────────────────────────────────

describe('cost of the check on a ~200k-token history', () => {
  it('compares a ~1 MB history in single-digit ms (bounded loosely; the measured number is logged)', () => {
    // 400 messages × ~2.5 KB of text ≈ 1 MB of JSON ≈ 200k tokens.
    const para = 'The quick brown fox jumps over the lazy dog while the journal keeps the truth. ';
    const text = para.repeat(32); // ~2.5 KB
    const history: unknown[] = [];
    const entries: JournalEntry[] = [];
    for (let i = 0; i < 200; i++) {
      history.push({ role: 'user', content: text });
      history.push({ role: 'assistant', content: [{ type: 'text', text }] });
      const base = { uuid: `u${i}`, parentUuid: null, seq: i, taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'native', timestamp: '' };
      entries.push({ ...base, principal: { kind: 'user', userId: 'u' }, payload: { type: 'user', blocks: [{ type: 'text', text }] } } as JournalEntry);
      entries.push({ ...base, principal: { kind: 'agent', agentId: 'native' }, payload: { type: 'assistant', blocks: [{ type: 'text', text }] } } as JournalEntry);
    }
    const bytes = JSON.stringify(history).length;
    const clone = structuredClone(history);
    // Warm-up, then measure.
    checkReconstruction({ round: 0, incremental: history, projected: clone });
    const t0 = performance.now();
    const m = checkReconstruction({ round: 1, incremental: history, projected: clone });
    const compareMs = performance.now() - t0;
    const t1 = performance.now();
    const projected = journalToAnthropicMessages(entries);
    const projectMs = performance.now() - t1;
    expect(m).toBeNull();
    expect(projected).toHaveLength(400);
    console.info(
      `[reconstruction-cost] history=${(bytes / 1024).toFixed(0)}KB messages=${history.length} compare=${compareMs.toFixed(2)}ms project=${projectMs.toFixed(2)}ms`,
    );
    // Generous ceiling — a regression to O(n²) or a pathological allocation trips it; CI
    // timing noise does not. (The brief's sampling threshold is 25 ms per round.)
    expect(compareMs + projectMs).toBeLessThan(process.env.KERNEL_COVERAGE ? 2000 : 250);
  });
});
