/**
 * T9b — THE BASH DRILL, at the harness level: a SINGLE-ASK, MANY-ROUND task compacts.
 *
 * This is the fleet-wide half of the bug. A long Bash task is one user message and
 * many tool rounds: the journal holds exactly ONE `user` entry until the person types
 * again, and a round appends `assistant` / `tool_use` / `tool_result` — never another
 * `user`. The planner's forward snap therefore ran off the end at every round head,
 * the refusal was swallowed to a `console.warn`, and the run kept growing until the
 * provider rejected it (`context_exceeded`). That is the runner-OOM class.
 *
 * Driven through the REAL harness loop with only the provider transport scripted, so
 * what fires here is what fires in production.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import { COMPACTION_SPLIT_TURN_SECTION } from '../../contract/compaction-prompt.js';
import { COMPACTION_FAILED_EVENT } from '../compaction-run.js';
import type { NewEntry } from '../../contract/journal.js';
import type { ContentBlock } from '../../contract/blocks.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { NativeConfig } from '../native-config.js';

const SESSION_COMPACTED_EVENT = 'session:compacted';
/** ~200k estimated tokens — past claude-sonnet-4-5's 160k trigger, one entry. */
const HUGE_ASK = 'trace the whole repository, file by file. '.repeat(20_000);

/** Journal directories this file created, removed after each test (no tmpdir litter). */
const dirs: string[] = [];

afterEach(async () => {
  delete process.env.COMPACTION_V2;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function doneEvent(): StreamEvent {
  return { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1000, outputTokens: 20 } as NormalizedUsage };
}

class ScriptedTransport extends FakeTransport {
  calls = 0;
  systems: string[] = [];
  constructor(private readonly steps: StreamEvent[][]) {
    super([]);
  }
  override callModel(p: Parameters<FakeTransport['callModel']>[0]): StreamEvent[] {
    super.callModel(p);
    this.systems.push(p.system);
    const step = this.steps[Math.min(this.calls, this.steps.length - 1)];
    this.calls += 1;
    return step;
  }
  override computeCostUsd(): number {
    return 0.02;
  }
}

const base = (taskId: string): Omit<NewEntry, 'payload'> => ({
  taskId,
  rootTaskId: taskId,
  spawnDepth: 0,
  workspaceId: 'w',
  agentId: 'native',
  principal: { kind: 'agent', agentId: 'native' },
  timestamp: '',
});

function makeJournal(taskId: string): Journal {
  const dir = join(tmpdir(), `t9b-${process.pid}-${Math.random().toString(36).slice(2)}`);
  dirs.push(dir);
  const path = join(dir, `${taskId}.jsonl`);
  return new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(path),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2024-01-01T00:00:00.000Z'),
  });
}

/** Chat-shaped seed: alternating user/assistant turns totalling ~targetTokens. */
async function seedChatTurns(j: Journal, taskId: string, targetTokens: number): Promise<void> {
  const chunk = 'context '.repeat(500); // ~4000 chars ≈ 1000 tokens
  const turns = Math.ceil(targetTokens / 2000);
  for (let i = 0; i < turns; i++) {
    await j.append({
      ...base(taskId),
      principal: { kind: 'user', userId: 'u' },
      payload: { type: 'user', blocks: [{ type: 'text', text: `q${i} ${chunk}` } as ContentBlock] },
    });
    await j.append({
      ...base(taskId),
      payload: {
        type: 'assistant',
        blocks: [{ type: 'text', text: `a${i} ${chunk}` } as ContentBlock],
        api: 'anthropic_messages',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
      },
    });
  }
}

async function runTurn(opts: {
  taskId: string;
  journal: Journal;
  transport: ScriptedTransport;
  ask: string;
  keepWindowTokens?: number;
  model?: string;
  /** Further USER turns, run after `ask` in the same run (one RunContext). */
  more?: string[];
}): Promise<HarnessEvent[]> {
  const cfg = {
    onAttached: () => {},
    maxTurns: 6,
    transport: opts.transport,
    journal: opts.journal,
    compaction: { keepWindowTokens: opts.keepWindowTokens ?? 2_000 },
    // Elision spills the full bodies before a stub can reach the wire.
    workingDir: join(tmpdir(), `t9b-wd-${process.pid}-${Math.random().toString(36).slice(2)}`),
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = {
    taskId: opts.taskId,
    sessionId: 's-t9b',
    cwd: '/tmp',
    model: opts.model ?? 'claude-sonnet-4-5',
    signal: new AbortController().signal,
    config: cfg,
  };
  const input = (async function* (): AsyncIterable<UserTurn> {
    for (const text of [opts.ask, ...(opts.more ?? [])]) yield { text };
  })();
  const events: HarnessEvent[] = [];
  for await (const ev of new NativeHarness().run(input, ctx)) events.push(ev);
  return events;
}

const raws = (events: HarnessEvent[], name: string): HarnessEvent[] =>
  events.filter((e) => e.kind === 'raw' && (e as { event?: string }).event === name);

describe('T9b — a single-ask, many-round task compacts instead of growing forever', () => {
  it('compacts at a round head with ONE user entry in the journal (RED before T9b: refused every round)', async () => {
    process.env.COMPACTION_V2 = '1';
    const taskId = 't9b-one-ask';
    const transport = new ScriptedTransport([
      // Round 1: call a tool, so round 2 opens with assistant/tool_use/tool_result appended.
      [{ kind: 'tool_use', toolUse: { id: 'tu-0', name: 'noop', input: {} } }, doneEvent()],
      // Round 2's head compacts; this same step answers the summarize AND the round.
      [{ kind: 'text', text: 'SUMMARY OF THE ASK' }, doneEvent()],
    ]);

    const events = await runTurn({ taskId, journal: makeJournal(taskId), transport, ask: HUGE_ASK });

    expect(raws(events, SESSION_COMPACTED_EVENT)).toHaveLength(1);
    // The cut landed inside the turn, so the summarize was told so.
    const summarizeSystem = transport.systems.find((s) => s.includes(COMPACTION_SPLIT_TURN_SECTION));
    expect(summarizeSystem).toBeDefined();
  });

  it('the ROUND-1 head, with nothing but the ask in the journal, refuses BY NAME instead of silently', async () => {
    process.env.COMPACTION_V2 = '1';
    const taskId = 't9b-round-one';
    const transport = new ScriptedTransport([
      [{ kind: 'tool_use', toolUse: { id: 'tu-0', name: 'noop', input: {} } }, doneEvent()],
      [{ kind: 'text', text: 'SUMMARY OF THE ASK' }, doneEvent()],
    ]);

    const events = await runTurn({ taskId, journal: makeJournal(taskId), transport, ask: HUGE_ASK });

    // Round 1 has only the ask — there is genuinely nothing to cut to, and it SAYS so.
    const failures = raws(events, COMPACTION_FAILED_EVENT) as Array<{ data: { reason: string } }>;
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].data.reason).toBe('no_valid_cut');
  });

  it('a SHORT single-ask task still does not compact — the threshold is unchanged', async () => {
    process.env.COMPACTION_V2 = '1';
    const taskId = 't9b-short-ask';
    const transport = new ScriptedTransport([
      [{ kind: 'tool_use', toolUse: { id: 'tu-0', name: 'noop', input: {} } }, doneEvent()],
      [{ kind: 'text', text: 'answer' }, doneEvent()],
    ]);

    const events = await runTurn({ taskId, journal: makeJournal(taskId), transport, ask: 'small ask' });

    expect(raws(events, SESSION_COMPACTED_EVENT)).toHaveLength(0);
    expect(raws(events, COMPACTION_FAILED_EVENT)).toHaveLength(0);
  });
});

describe('T9b — the CHAT shape is unchanged: same threshold, no earlier compaction', () => {
  it('a chat-shaped journal BELOW the trigger does not compact', async () => {
    process.env.COMPACTION_V2 = '1';
    const taskId = 't9b-chat-under';
    const j = makeJournal(taskId);
    await seedChatTurns(j, taskId, 60_000); // well under the 160k trigger
    const transport = new ScriptedTransport([[{ kind: 'text', text: 'answer' }, doneEvent()]]);

    const events = await runTurn({ taskId, journal: j, transport, ask: 'next question' });

    expect(raws(events, SESSION_COMPACTED_EVENT)).toHaveLength(0);
    expect(transport.calls).toBe(1); // no summarize call
  });

  it('a chat cut whose raw cut lands ON a `user` entry is IDENTICAL to pre-T9b — no split clause', async () => {
    process.env.COMPACTION_V2 = '1';
    const taskId = 't9b-chat-user-cut';
    const j = makeJournal(taskId);
    await seedChatTurns(j, taskId, 200_000); // past the 160k trigger
    const transport = new ScriptedTransport([
      [{ kind: 'text', text: 'SUMMARY OF EARLIER WORK' }, doneEvent()],
      [{ kind: 'text', text: 'answer' }, doneEvent()],
    ]);

    // 1,000 tokens keeps only the newest (tiny) user entry, so the raw cut lands on it.
    const events = await runTurn({ taskId, journal: j, transport, ask: 'next question', keepWindowTokens: 1_000 });

    expect(raws(events, SESSION_COMPACTED_EVENT)).toHaveLength(1);
    const boundary = (await j.snapshot()).find((e) => e.payload.type === 'compact_boundary')!;
    const firstKept = (await j.snapshot()).find(
      (e) => e.uuid === (boundary.payload as { firstKeptId: string }).firstKeptId,
    )!;
    expect(firstKept.payload.type).toBe('user');
    // A `user` cut is not a split turn, so the summarize prompt is byte-identical.
    expect(transport.systems.some((s) => s.includes(COMPACTION_SPLIT_TURN_SECTION))).toBe(false);
  });

  it('a chat cut whose raw cut lands MID-TURN keeps MORE than before, and says the turn was split', async () => {
    // THE ONE THING A CHAT SESSION SEES DIFFERENTLY. Pre-T9b the cut snapped FORWARD
    // past the assistant turn to the next `user` entry; now it stops at the assistant
    // boundary the raw cut already reached — a strict SUPERSET of the old kept span
    // (never less context) — and the summary is told the turn was split.
    process.env.COMPACTION_V2 = '1';
    const taskId = 't9b-chat-split-cut';
    const j = makeJournal(taskId);
    await seedChatTurns(j, taskId, 200_000);
    const transport = new ScriptedTransport([
      [{ kind: 'text', text: 'SUMMARY OF EARLIER WORK' }, doneEvent()],
      [{ kind: 'text', text: 'answer' }, doneEvent()],
    ]);

    // 2,000 tokens reaches back past the newest user entry into the assistant turn.
    const events = await runTurn({ taskId, journal: j, transport, ask: 'next question', keepWindowTokens: 2_000 });

    expect(raws(events, SESSION_COMPACTED_EVENT)).toHaveLength(1);
    const snapshot = await j.snapshot();
    const boundary = snapshot.find((e) => e.payload.type === 'compact_boundary')!;
    const firstKept = snapshot.find(
      (e) => e.uuid === (boundary.payload as { firstKeptId: string }).firstKeptId,
    )!;
    // Pre-T9b this would have been the trailing `user` entry; the assistant turn before
    // it was summarized away. It is now KEPT verbatim.
    expect(firstKept.payload.type).toBe('assistant');
    // T9c (Ruling 85) FLIPPED THIS LEG, and the old expectation was the bug. The cut
    // lands mid-turn, so `splitTurn` is true — but the retained span holds later `user`
    // turns AND this turn's own fresh ask, so the summarized prefix belongs to a turn
    // that ended several turns ago. Telling the summarizer "the turn is still in
    // progress… do not describe it as finished" about that span made the summary
    // misreport state to the next model call. The section now rides the same truth as
    // the continuation marker: live turn AND no real ask retained.
    expect(transport.systems.some((s) => s.includes(COMPACTION_SPLIT_TURN_SECTION))).toBe(false);
  });
});

// ─── B1: the trigger reads the provider's count, not only the estimate ──────────
//
// The chars/4 ledger never sees replayed encrypted reasoning, so on gpt-6-luna it read
// 60-65% of the real input. Task c00b391e: +54 estimated vs +7,459 real per round, crossed
// OpenAI's 272K line at round 18 and first compacted at round 31 (352K). The 244.8K trigger
// now reads the last request's reported input plus what was appended since.

describe('B1 — the trigger fires from the provider-reported input', () => {
  /** Round 1 calls a tool and reports `usage`; round 2's head decides; round 2 answers. */
  function roundOneReports(usage: NormalizedUsage): ScriptedTransport {
    return new ScriptedTransport([
      [{ kind: 'tool_use', toolUse: { id: 'tu-0', name: 'noop', input: {} } }, { kind: 'done', stopReason: 'tool_use', usage }],
      [{ kind: 'text', text: 'SUMMARY OF EARLIER WORK' }, doneEvent()],
      [{ kind: 'text', text: 'answer' }, doneEvent()],
    ]);
  }

  it('compacts when round 1 REPORTS ~245K real input, though the estimate reads ~10K', async () => {
    process.env.COMPACTION_V2 = '1';
    const taskId = 'b1-trigger-real';
    const j = makeJournal(taskId);
    await seedChatTurns(j, taskId, 10_000); // the estimate: far under the 244.8K trigger
    // 200K uncached + 38K cache read = 238K counted; +7,459 out; + the tool pair appended.
    const transport = roundOneReports({
      inputTokens: 200_000,
      cacheReadInputTokens: 38_000,
      outputTokens: 7_459,
    } as NormalizedUsage);

    const events = await runTurn({ taskId, journal: j, transport, ask: 'keep going', model: 'gpt-6-luna' });

    expect(raws(events, SESSION_COMPACTED_EVENT)).toHaveLength(1);
    expect(transport.calls).toBe(3); // round 1, the summarize at round 2's head, round 2
  });

  it('does NOT compact when the reported input is small — the count moves the trigger, it does not arm it', async () => {
    process.env.COMPACTION_V2 = '1';
    const taskId = 'b1-trigger-small';
    const j = makeJournal(taskId);
    await seedChatTurns(j, taskId, 10_000);
    const transport = roundOneReports({ inputTokens: 12_000, outputTokens: 54 } as NormalizedUsage);

    const events = await runTurn({ taskId, journal: j, transport, ask: 'keep going', model: 'gpt-6-luna' });

    expect(raws(events, SESSION_COMPACTED_EVENT)).toHaveLength(0);
    expect(transport.calls).toBe(2);
  });

  it('flag OFF: the estimate alone decides, exactly as before', async () => {
    const taskId = 'b1-trigger-off';
    const j = makeJournal(taskId);
    await seedChatTurns(j, taskId, 10_000);
    const transport = roundOneReports({
      inputTokens: 200_000,
      cacheReadInputTokens: 38_000,
      outputTokens: 7_459,
    } as NormalizedUsage);

    const events = await runTurn({ taskId, journal: j, transport, ask: 'keep going', model: 'gpt-6-luna' });

    expect(raws(events, SESSION_COMPACTED_EVENT)).toHaveLength(0);
  });
});

// ─── B1 review: two things that blinded the fix at a USER-TURN boundary ──────────

/** ~15,000 estimated tokens of tool output per seeded turn — enough for elision to cut. */
const FAT_RESULT = 'result-line-of-output '.repeat(2_700);

async function seedFatToolTurns(j: Journal, taskId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await j.append({
      ...base(taskId),
      principal: { kind: 'user', userId: 'u' },
      payload: { type: 'user', blocks: [{ type: 'text', text: `q${i}` } as ContentBlock] },
    });
    await j.append({ ...base(taskId), payload: { type: 'tool_use', toolUseId: `tu-${i}`, name: 'Read', input: { file_path: `/f${i}` } } });
    await j.append({
      ...base(taskId),
      payload: { type: 'tool_result', toolUseId: `tu-${i}`, blocks: [{ type: 'text', text: FAT_RESULT } as ContentBlock] },
    });
    await j.append({
      ...base(taskId),
      payload: { type: 'assistant', blocks: [{ type: 'text', text: `a${i}` } as ContentBlock], api: 'anthropic_messages', provider: 'anthropic', model: 'fake-model' },
    });
  }
}

describe('B1 review — a new user turn does not blind the fix', () => {
  afterEach(() => {
    delete process.env.CONTEXT_ELISION_V1;
  });

  it('two user turns, one round each, elision ON: the second turn\'s head fires from the measured count', async () => {
    // prepareElision mints a NEW map every user turn. Compared by identity, the count went
    // stale at every turn's first head, so a chat (one round per turn) never used it.
    process.env.COMPACTION_V2 = '1';
    process.env.CONTEXT_ELISION_V1 = '1';
    const taskId = 'b1-elision-turns';
    const j = makeJournal(taskId);
    await seedFatToolTurns(j, taskId, 16); // ~240K raw; elided to well under fake-model's 160K trigger
    const transport = new ScriptedTransport([
      // Turn 1, round 1: the provider counts 160,000 input tokens.
      [{ kind: 'text', text: 'answer one' }, { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 160_000, outputTokens: 500 } as NormalizedUsage }],
      // Turn 2's head: the summarize.
      [{ kind: 'text', text: 'SUMMARY OF EARLIER WORK' }, doneEvent()],
      // Turn 2, round 1.
      [{ kind: 'text', text: 'answer two' }, doneEvent()],
    ]);

    const events = await runTurn({ taskId, journal: j, transport, ask: 'first', more: ['second'], model: 'fake-model' });

    // Elision really ran on BOTH turns — two maps, so identity alone would have gone stale.
    const elisionRows = (await j.snapshot()).filter(
      (e) => e.payload.type === 'custom' && (e.payload as { key: string }).key === 'context_elision',
    );
    expect(elisionRows).toHaveLength(2);
    expect(raws(events, SESSION_COMPACTED_EVENT)).toHaveLength(1);
    // Call order round (8192), summarize (4096: fake-model does not reason), round.
    expect(transport.maxTokensSeen).toEqual([8_192, 4_096, 8_192]);
  });

  it('a compaction that refused in turn 1 gets one attempt at turn 2\'s head, not a wait counted in rounds', async () => {
    process.env.COMPACTION_V2 = '1';
    const taskId = 'b1-retry-per-turn';
    const j = makeJournal(taskId);
    await seedChatTurns(j, taskId, 200_000); // past claude-sonnet-4-5's 160K trigger
    const transport = new ScriptedTransport([
      // Turn 1's head: the summarize reasons and writes nothing — refused, the wait is armed.
      [{ kind: 'thinking', text: 'thinking at length' }, { kind: 'done', stopReason: 'max_tokens', usage: { inputTokens: 1_000, outputTokens: 8_192 } as NormalizedUsage }],
      [{ kind: 'text', text: 'answer one' }, doneEvent()],
      // Turn 2's head, ONE round later — still inside the 2-round wait, and it tries anyway.
      [{ kind: 'text', text: 'SUMMARY OF EARLIER WORK' }, doneEvent()],
      [{ kind: 'text', text: 'answer two' }, doneEvent()],
    ]);

    const events = await runTurn({ taskId, journal: j, transport, ask: 'first', more: ['second'] });

    const failures = raws(events, COMPACTION_FAILED_EVENT) as Array<{ data: { reason: string } }>;
    expect(failures.map((f) => f.data.reason)).toEqual(['empty_summary']);
    expect(raws(events, SESSION_COMPACTED_EVENT)).toHaveLength(1);
    expect(transport.calls).toBe(4);
  });
});
