/**
 * P2.1 Task 4 — journal every SETTLED model round as a `usage` payload.
 *
 * The harness folds a round's cost into `cumulativeCostUsd` at the moment the cost
 * is known (the stream-terminal `done`). This suite locks in that at EACH such fold
 * — a main round, a compaction summarize, and the structured-output epilogue — the
 * journal now carries one `usage` entry recording that spend:
 *   { type:'usage', intelligence:costUsd, actions:0, compute:0,
 *     raw:{ costUsd, model, source, inputTokens, outputTokens } }.
 *
 * `usage` is CONTEXT_POLICY:false, so these entries never replay into the model
 * context — projections/wire bodies stay unchanged (proven by the transport
 * baseline conformance). This is purely durable accounting state so a crashed
 * multi-round turn can seed its completed rounds' cost from the journal (Task 5).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import { sumJournaledCostUsd } from '../native-journal.js';
import type { ContentBlock } from '../../contract/blocks.js';
import type { JournalEntry, JournalPayload, NewEntry } from '../../contract/journal.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { NativeConfig } from '../native-config.js';
import type { OutputFormat } from '../../contract/output-format.js';
import type { ToolHost } from '../../ports/tool-host-port.js';
import type { RawToolOptions, OnAuthHalt } from '../../tools/tool-types.js';

const MODEL = 'claude-sonnet-4-6';

// ── scripted transport (prices off usage.costUsd, serves rounds in order) ───────

function doneEvent(
  costUsd: number,
  inputTokens: number,
  outputTokens: number,
  stopReason = 'end_turn',
): StreamEvent {
  return { kind: 'done', stopReason, usage: { inputTokens, outputTokens, costUsd } as NormalizedUsage };
}

class ScriptTransport extends FakeTransport {
  private idx = 0;
  constructor(private readonly rounds: StreamEvent[][]) {
    super([]);
  }
  override callModel(): StreamEvent[] {
    const round = this.rounds[Math.min(this.idx, this.rounds.length - 1)];
    this.idx += 1;
    return round;
  }
  override computeCostUsd(usage: NormalizedUsage): number {
    return (usage as { costUsd?: number }).costUsd ?? 0;
  }
}

/** A ToolHost with a single no-op tool so a round can emit a tool_use and continue. */
class NoopToolHost implements ToolHost {
  async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
    const tool: RawToolOptions = {
      name: 'noop',
      description: 'no-op tool that keeps the turn going for a second round',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      execute: () => 'ok',
    };
    return { tools: [tool], onAuthHalt: async () => {} };
  }
}

// ── journal + ctx builders ──────────────────────────────────────────────────

const dir = join(tmpdir(), `usage-journal-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const makeJournal = (taskId: string): Journal => new Journal({
  taskId,
  workspaceId: 'w',
  jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
  mirror: new InMemorySessionStore(),
  clock: sequentialClock('2026-01-01T00:00:00.000Z'),
});

function buildCtx(
  taskId: string,
  transport: FakeTransport,
  journal: Journal,
  extra: Partial<NativeConfig> = {},
): HarnessContext<NativeConfig> {
  const cfg = {
    onAttached: () => {},
    maxTurns: 10,
    transport,
    toolHost: new NoopToolHost(),
    journal,
    abilities: [],
    ...extra,
  } as unknown as NativeConfig;
  return { taskId, sessionId: `s-${taskId}`, cwd: '/tmp', model: MODEL, signal: new AbortController().signal, config: cfg };
}

async function readEntries(j: Journal): Promise<JournalEntry[]> {
  const all: JournalEntry[] = [];
  for await (const e of j.read()) all.push(e);
  return all;
}

const usageEntries = (entries: JournalEntry[]): Array<Extract<JournalPayload, { type: 'usage' }>> =>
  entries.filter((e) => e.payload.type === 'usage').map((e) => e.payload as Extract<JournalPayload, { type: 'usage' }>);

async function drive(ctx: HarnessContext<NativeConfig>, turn: UserTurn = { text: 'go' }): Promise<void> {
  const harness = new NativeHarness();
  const input = (async function* (): AsyncIterable<UserTurn> { yield turn; })();
  for await (const _ of harness.run(input, ctx)) { /* drain */ }
}

/** Seed a user/assistant turn directly so a later compaction has a valid cut. */
const seedBase = (taskId: string): Omit<NewEntry, 'payload'> => ({
  taskId, rootTaskId: taskId, spawnDepth: 0, workspaceId: 'w', agentId: 'native',
  principal: { kind: 'agent', agentId: 'native' }, timestamp: '',
});
async function seedTurn(j: Journal, taskId: string, n: number, text: string): Promise<void> {
  await j.append({
    ...seedBase(taskId),
    principal: { kind: 'user', userId: 'u' },
    payload: { type: 'user', blocks: [{ type: 'text', text: `q${n}: ${text}` } as ContentBlock] },
  });
  await j.append({
    ...seedBase(taskId),
    payload: {
      type: 'assistant',
      blocks: [{ type: 'text', text: `a${n}: ${text}` } as ContentBlock],
      api: 'anthropic_messages', provider: 'anthropic', model: MODEL,
    },
  });
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('native journal — usage payload at every settled model round (P2.1 T4)', () => {
  it('journals one source:round usage entry per settled round, raw.costUsd = the round cost', async () => {
    const j = makeJournal('rounds');
    // Round 0 emits a tool_use (loop continues); round 1 ends the turn cleanly.
    const transport = new ScriptTransport([
      [{ kind: 'tool_use', toolUse: { id: 'tu-0', name: 'noop', input: {} } }, doneEvent(0.03, 100, 20)],
      [{ kind: 'text', text: 'done' }, doneEvent(0.01, 50, 5)],
    ]);
    await drive(buildCtx('rounds', transport, j));

    const usage = usageEntries(await readEntries(j));
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({ type: 'usage', intelligence: 0.03, actions: 0, compute: 0 });
    expect(usage[0].raw).toEqual({ costUsd: 0.03, model: MODEL, source: 'round', inputTokens: 100, outputTokens: 20 });
    expect(usage[1].raw).toEqual({ costUsd: 0.01, model: MODEL, source: 'round', inputTokens: 50, outputTokens: 5 });
    // intelligence mirrors the authoritative raw.costUsd.
    expect(usage[1]).toMatchObject({ intelligence: 0.01 });
  });

  it('a warm /compact adds a source:compaction usage entry carrying the summarize cost', async () => {
    const j = makeJournal('compact');
    for (let n = 0; n < 4; n++) {
      await seedTurn(j, 'compact', n, 'the quick brown fox jumps over the lazy dog repeatedly');
    }
    // The only model call this turn is the compaction summarize (a control turn drives no round).
    const transport = new ScriptTransport([
      [{ kind: 'text', text: 'SUMMARY OF PRIOR CONTEXT' }, doneEvent(0.02, 200, 10)],
    ]);
    const ctx = buildCtx('compact', transport, j, {
      compaction: { thresholdPct: 0.99, keepWindowTokens: 20_000 },
    } as Partial<NativeConfig>);
    await drive(ctx, { text: '', control: 'compact' });

    const compaction = usageEntries(await readEntries(j)).filter((p) => p.raw && (p.raw as { source?: string }).source === 'compaction');
    expect(compaction).toHaveLength(1);
    expect(compaction[0].raw).toEqual({ costUsd: 0.02, model: MODEL, source: 'compaction', inputTokens: 200, outputTokens: 10 });
    expect(compaction[0]).toMatchObject({ intelligence: 0.02 });
  });

  it('the structured-output epilogue adds a source:epilogue usage entry', async () => {
    const j = makeJournal('epilogue');
    // Main round completes cleanly; the epilogue makes ONE constrained call → valid JSON.
    const transport = new ScriptTransport([
      [{ kind: 'text', text: 'answer' }, doneEvent(0.03, 100, 20)],
      [{ kind: 'text', text: '{"answer":"hi"}' }, doneEvent(0.005, 40, 8)],
    ]);
    const schema: OutputFormat = {
      type: 'json_schema',
      name: 'ans',
      schema: { type: 'object', additionalProperties: false, properties: { answer: { type: 'string' } }, required: ['answer'] },
    };
    await drive(buildCtx('epilogue', transport, j, { outputFormat: schema } as Partial<NativeConfig>));

    const epilogue = usageEntries(await readEntries(j)).filter((p) => p.raw && (p.raw as { source?: string }).source === 'epilogue');
    expect(epilogue).toHaveLength(1);
    // The epilogue cost is a delta of cumulatives at the fold, so assert the dollar
    // figure with float tolerance; the rest of the payload is exact.
    const raw = epilogue[0].raw as { costUsd: number; model: string; source: string; inputTokens: number; outputTokens: number };
    expect(raw).toMatchObject({ model: MODEL, source: 'epilogue', inputTokens: 40, outputTokens: 8 });
    expect(raw.costUsd).toBeCloseTo(0.005, 9);
    expect(epilogue[0].intelligence).toBeCloseTo(0.005, 9);
  });

  // PR-1300 review (note 4): the two disclosed epilogue behaviors, now covered.
  it('epilogue retries aggregate into exactly ONE entry carrying the summed cost', async () => {
    const j = makeJournal('epi-retry');
    // Main round; then attempt 1 returns malformed JSON, attempt 2 valid → the
    // single source:'epilogue' entry must carry BOTH attempts' spend (0.004+0.006).
    const transport = new ScriptTransport([
      [{ kind: 'text', text: 'answer' }, doneEvent(0.03, 100, 20)],
      [{ kind: 'text', text: 'not-json{{' }, doneEvent(0.004, 40, 6)],
      [{ kind: 'text', text: '{"answer":"hi"}' }, doneEvent(0.006, 42, 9)],
    ]);
    const schema: OutputFormat = {
      type: 'json_schema',
      name: 'ans',
      schema: { type: 'object', additionalProperties: false, properties: { answer: { type: 'string' } }, required: ['answer'] },
    };
    await drive(buildCtx('epi-retry', transport, j, { outputFormat: schema } as Partial<NativeConfig>));

    const epilogue = usageEntries(await readEntries(j)).filter((p) => p.raw && (p.raw as { source?: string }).source === 'epilogue');
    expect(epilogue).toHaveLength(1); // one aggregate entry, never one-per-attempt
    expect((epilogue[0].raw as { costUsd: number }).costUsd).toBeCloseTo(0.01, 9);
  });

  it('a fail-closed preflight (unconstrainable schema, zero epilogue calls) writes NO epilogue entry', async () => {
    const j = makeJournal('epi-preflight');
    const transport = new ScriptTransport([
      [{ kind: 'text', text: 'answer' }, doneEvent(0.03, 100, 20)],
    ]);
    // A schema outside the constrainable subset (top-level non-object) fails the
    // preflight before any constrained model call.
    const schema = { type: 'json_schema', name: 'bad', schema: { type: 'array' } } as unknown as OutputFormat;
    await drive(buildCtx('epi-preflight', transport, j, { outputFormat: schema } as Partial<NativeConfig>));

    const epilogue = usageEntries(await readEntries(j)).filter((p) => p.raw && (p.raw as { source?: string }).source === 'epilogue');
    expect(epilogue).toHaveLength(0); // delta==0 gate: no model call → no entry
  });

  // PR-1300 review (kill-analysis follow-through): the settlement-ordering invariant
  // Task 5's seed depends on — a round's usage entry never precedes its assistant entry.
  it('every source:round usage entry FOLLOWS its round assistant/tool entry (settlement invariant)', async () => {
    const j = makeJournal('ordering');
    const transport = new ScriptTransport([
      [{ kind: 'tool_use', toolUse: { id: 'tu-0', name: 'noop', input: {} } }, doneEvent(0.03, 100, 20)],
      [{ kind: 'text', text: 'done' }, doneEvent(0.01, 50, 5)],
    ]);
    await drive(buildCtx('ordering', transport, j));
    const entries = await readEntries(j);
    for (const [i, e] of entries.entries()) {
      if (e.payload.type !== 'usage' || (e.payload.raw as { source?: string })?.source !== 'round') continue;
      const before = entries.slice(0, i).map((x) => x.payload.type);
      // The settled round's durable output (assistant entry) must already be present.
      expect(before).toContain('assistant');
    }
  });
});

describe('sumJournaledCostUsd', () => {
  it('sums raw.costUsd over usage entries only, ignoring non-usage entries', () => {
    const mk = (payload: JournalPayload): JournalEntry => ({
      uuid: 'u', parentUuid: null, seq: 0, taskId: 't', rootTaskId: 't', spawnDepth: 0,
      workspaceId: 'w', agentId: 'native', principal: { kind: 'system' }, timestamp: '', payload,
    });
    const entries: JournalEntry[] = [
      mk({ type: 'usage', intelligence: 0.03, actions: 0, compute: 0, raw: { costUsd: 0.03, model: MODEL, source: 'round', inputTokens: 1, outputTokens: 1 } }),
      mk({ type: 'user', blocks: [] }),
      mk({ type: 'usage', intelligence: 0.02, actions: 0, compute: 0, raw: { costUsd: 0.02, model: MODEL, source: 'compaction', inputTokens: 1, outputTokens: 1 } }),
    ];
    expect(sumJournaledCostUsd(entries)).toBeCloseTo(0.05, 9);
  });

  it('is 0 for a journal with no usage entries', () => {
    expect(sumJournaledCostUsd([])).toBe(0);
  });
});
