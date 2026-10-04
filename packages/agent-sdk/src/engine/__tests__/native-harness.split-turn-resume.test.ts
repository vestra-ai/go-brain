/**
 * T9c — after a SPLIT-TURN compaction the resumed round is told to continue the task.
 *
 * THE DRILL (staging task fe222a7a, runner build e4bb8de3e). A one-ask task — `cat` 30
 * files, one Bash call each — crossed the trigger at round 23 and compacted correctly
 * (T9b working: preTokens 213,655 → postTokens 12,060, firstKept an `assistant` entry).
 * The projection the next round saw was [summary(user), assistant/tool rounds…] and
 * nothing else: a split turn's retained work holds NO user message, because the only
 * real ask was summarized away. Every chat-trained model reads the leading user-role
 * entry as the live objective — and that entry was now a document whose first line read
 * `## Latest request — "Produce the structured summary…"`. The model wrote a summary,
 * the turn ended `completed` at file 23 of 30, and the task was silently abandoned.
 *
 * The prompt half of the fix stops the summary naming the WRONG request. THIS half puts
 * the right instruction in the channel the objective actually lives in: one engine-minted
 * `user` entry, appended by `runCompaction` when `plan.splitTurn` is true.
 *
 * Driven through the REAL harness loop with only the provider transport scripted, so
 * what fires here is what fires in production. `historyFromJournal` and `pushUser` are
 * given faithful minimal bodies (FakeTransport stubs them to `[]`) precisely so the
 * PROJECTION each model call receives is visible — that projection is the thing under
 * test, and a helper that injected the marker itself would pin nothing (Ruling 75).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage, type ProviderHistory } from '../transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import { COMPACTION_NOOP_NOTICE } from '../../contract/compaction-prompt.js';
import { fenceRecall } from '../recall.js';
import {
  COMPACTION_SPLIT_TURN_CONTINUE_MARKER,
  isEngineInjectedUserText,
  isRecallFence,
} from '../../contract/injected-user-text.js';
import type { NewEntry, JournalEntry } from '../../contract/journal.js';
import type { ContentBlock } from '../../contract/blocks.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { NativeConfig } from '../native-config.js';

const SESSION_COMPACTED_EVENT = 'session:compacted';
/** ~200k estimated tokens — past claude-sonnet-4-5's 160k trigger, one entry. */
const HUGE_ASK = 'read every file in the repository and report what you find. '.repeat(20_000);

const dirs: string[] = [];
afterEach(async () => {
  delete process.env.COMPACTION_V2;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function doneEvent(): StreamEvent {
  return {
    kind: 'done',
    stopReason: 'end_turn',
    usage: { inputTokens: 1000, outputTokens: 20 } as NormalizedUsage,
  };
}

/** One projected wire message, in the shape this file's transport mints. */
interface WireMsg {
  role: string;
  text: string;
}

const textOf = (e: JournalEntry): string => {
  const p = e.payload as { blocks?: Array<{ text?: string }> };
  return (p.blocks ?? []).map((b) => b.text ?? '').join('');
};

/**
 * FakeTransport with a REAL journal→wire projection, so `p.history` on each call is
 * the projection the production loop built. Everything else is FakeTransport's.
 */
class ProjectingTransport extends FakeTransport {
  calls = 0;
  /** A frozen copy of `p.history` per call — `pushUser` mutates in place. */
  histories: WireMsg[][] = [];
  constructor(private readonly steps: StreamEvent[][]) {
    super([]);
  }
  override historyFromJournal(entries: JournalEntry[]): ProviderHistory {
    return entries.map((e) => ({ role: e.payload.type, text: textOf(e) })) as ProviderHistory;
  }
  override pushUser(h: ProviderHistory, text: string): void {
    (h as unknown as WireMsg[]).push({ role: 'user', text });
  }
  override pushAssistant(h: ProviderHistory): void {
    (h as unknown as WireMsg[]).push({ role: 'assistant', text: '' });
  }
  override pushToolResult(h: ProviderHistory): void {
    (h as unknown as WireMsg[]).push({ role: 'tool_result', text: '' });
  }
  override callModel(p: Parameters<FakeTransport['callModel']>[0]): StreamEvent[] {
    super.callModel(p);
    this.histories.push((p.history as unknown as WireMsg[]).map((m) => ({ ...m })));
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
  const dir = join(tmpdir(), `t9c-${process.pid}-${Math.random().toString(36).slice(2)}`);
  dirs.push(dir);
  return new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2024-01-01T00:00:00.000Z'),
  });
}

/** Chat-shaped seed: alternating user/assistant turns totalling ~targetTokens. */
async function seedChatTurns(j: Journal, taskId: string, targetTokens: number): Promise<void> {
  const chunk = 'context '.repeat(500);
  for (let i = 0; i < Math.ceil(targetTokens / 2000); i++) {
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
  transport: ProjectingTransport;
  ask: string;
  keepWindowTokens?: number;
  recallHits?: string[];
  /** Drive a CONTROL turn (`/compact`) instead of an ordinary ask. */
  control?: 'compact';
}): Promise<HarnessEvent[]> {
  let hit = 0;
  const cfg = {
    onAttached: () => {},
    maxTurns: 6,
    transport: opts.transport,
    journal: opts.journal,
    compaction: { keepWindowTokens: opts.keepWindowTokens ?? 2_000 },
    ...(opts.recallHits && {
      // One hit per consult, in order. `''` is the abstain contract — nothing is
      // appended for that round — which is how a leg puts a fence on exactly the
      // round it means to.
      recall: { readRelevant: async () => opts.recallHits![hit++] ?? '' },
    }),
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = {
    taskId: opts.taskId,
    sessionId: 's-t9c',
    cwd: '/tmp',
    model: 'claude-sonnet-4-5',
    signal: new AbortController().signal,
    config: cfg,
  };
  const input = (async function* (): AsyncIterable<UserTurn> {
    yield { text: opts.ask, ...(opts.control && { control: opts.control }) } as UserTurn;
  })();
  const events: HarnessEvent[] = [];
  for await (const ev of new NativeHarness().run(input, ctx)) events.push(ev);
  return events;
}

const raws = (events: HarnessEvent[], name: string): HarnessEvent[] =>
  events.filter((e) => e.kind === 'raw' && (e as { event?: string }).event === name);

/** The one-ask script: round 1 calls a tool; round 2's head compacts, and the same
 *  step answers both the summarize one-shot and the resumed round. */
const oneAskSteps = (): StreamEvent[][] => [
  [{ kind: 'tool_use', toolUse: { id: 'tu-0', name: 'noop', input: {} } }, doneEvent()],
  [{ kind: 'text', text: '## Latest request — read every file in the repository' }, doneEvent()],
];

describe('T9c — a split-turn compaction resumes the task', () => {
  it('appends the continuation marker to the projection the RESUMED round receives', async () => {
    process.env.COMPACTION_V2 = '1';
    const taskId = 't9c-one-ask';
    const transport = new ProjectingTransport(oneAskSteps());

    const events = await runTurn({ taskId, journal: makeJournal(taskId), transport, ask: HUGE_ASK });

    expect(raws(events, SESSION_COMPACTED_EVENT)).toHaveLength(1);
    // Calls: [round 1, the summarize one-shot, the resumed round]. The last one is the
    // round that decides whether the task continues or answers with a summary.
    const resumed = transport.histories[transport.histories.length - 1];
    expect(resumed.filter((m) => m.text === COMPACTION_SPLIT_TURN_CONTINUE_MARKER)).toHaveLength(1);
  });

  it('the marker is the LAST user-role message, after the summary and the retained tail', async () => {
    process.env.COMPACTION_V2 = '1';
    const taskId = 't9c-order';
    const transport = new ProjectingTransport(oneAskSteps());

    await runTurn({ taskId, journal: makeJournal(taskId), transport, ask: HUGE_ASK });

    const resumed = transport.histories[transport.histories.length - 1];
    const users = resumed.filter((m) => m.role === 'user');
    // The summary leads (it replaced the span), the marker closes.
    expect(users.length).toBeGreaterThanOrEqual(2);
    expect(users[0].text).toContain('Latest request');
    expect(users[users.length - 1].text).toBe(COMPACTION_SPLIT_TURN_CONTINUE_MARKER);
    // …and it is NOT the whole projection: the retained work is still there.
    expect(resumed.some((m) => m.role !== 'user')).toBe(true);
  });

  it('a recall fence lands AFTER the marker — the round head consults once the marker is in', async () => {
    // Round-head order: compactTurnHead (compaction → marker → re-project) THEN
    // prepareRoundHead's consultRecall. The fence is attenuating DATA, so it may sit
    // last; the marker must still be the last user-role message that is not a fence.
    process.env.COMPACTION_V2 = '1';
    const taskId = 't9c-recall-after';
    const transport = new ProjectingTransport(oneAskSteps());

    await runTurn({
      taskId,
      journal: makeJournal(taskId),
      transport,
      ask: HUGE_ASK,
      // Round 1 abstains ON PURPOSE. A fence appended before the compaction is a
      // `user` entry, so the planner's forward snap lands the cut ON IT and the cut
      // stops being a split turn — worth knowing, and not the case under test here.
      recallHits: ['', 'the repo root is ~/workspace/agents/bash'],
    });

    const resumed = transport.histories[transport.histories.length - 1];
    const users = resumed.filter((m) => m.role === 'user');
    const markerIdx = users.findIndex((m) => m.text === COMPACTION_SPLIT_TURN_CONTINUE_MARKER);
    expect(markerIdx).toBeGreaterThan(-1);
    // Every user message after the marker is a recall fence.
    expect(users.slice(markerIdx + 1).every((m) => isRecallFence(m.text))).toBe(true);
    // And there IS one, or this leg proved nothing.
    expect(users.slice(markerIdx + 1).some((m) => isRecallFence(m.text))).toBe(true);
  });

  it('the marker is journaled as engine-minted — `injected` at the mint, and the registry claims it', async () => {
    process.env.COMPACTION_V2 = '1';
    const taskId = 't9c-injected';
    const journal = makeJournal(taskId);

    await runTurn({ taskId, journal, transport: new ProjectingTransport(oneAskSteps()), ask: HUGE_ASK });

    const entry = (await journal.snapshot()).find(
      (e) => e.payload.type === 'user' && textOf(e) === COMPACTION_SPLIT_TURN_CONTINUE_MARKER,
    );
    expect(entry).toBeDefined();
    // BY FIELD — what policy/injection-screen.ts reads first.
    expect((entry!.payload as { injected?: string }).injected).toBe('engine');
    // …and BY BYTES, the fallback for journals written before that field existed.
    expect(isEngineInjectedUserText(COMPACTION_SPLIT_TURN_CONTINUE_MARKER)).toBe(true);
  });
});

describe('T9c — a CHAT-shaped compaction is byte-identical: no marker', () => {
  it('a cut that lands ON a `user` entry mints nothing', async () => {
    // MUTATION that proves this gate: drop `plan.splitTurn` from the append condition
    // in runCompaction and this test goes red while the split-turn legs stay green.
    process.env.COMPACTION_V2 = '1';
    const taskId = 't9c-chat-user-cut';
    const journal = makeJournal(taskId);
    await seedChatTurns(journal, taskId, 200_000);
    const transport = new ProjectingTransport([
      [{ kind: 'text', text: 'SUMMARY OF EARLIER WORK' }, doneEvent()],
      [{ kind: 'text', text: 'answer' }, doneEvent()],
    ]);

    // 1,000 tokens keeps only the newest (tiny) user entry, so the cut lands on it.
    const events = await runTurn({
      taskId, journal, transport, ask: 'next question', keepWindowTokens: 1_000,
    });

    expect(raws(events, SESSION_COMPACTED_EVENT)).toHaveLength(1);
    const boundary = (await journal.snapshot()).find((e) => e.payload.type === 'compact_boundary')!;
    const firstKept = (await journal.snapshot()).find(
      (e) => e.uuid === (boundary.payload as { firstKeptId: string }).firstKeptId,
    )!;
    expect(firstKept.payload.type).toBe('user'); // not a split turn
    expect(
      (await journal.snapshot()).some((e) => textOf(e) === COMPACTION_SPLIT_TURN_CONTINUE_MARKER),
    ).toBe(false);
    expect(
      transport.histories.some((h) => h.some((m) => m.text === COMPACTION_SPLIT_TURN_CONTINUE_MARKER)),
    ).toBe(false);
  });
});

describe('the warm `/compact` no-op notice still reaches the user', () => {
  it('a refused `/compact` finalizes with the notice block and makes NO model call', async () => {
    // D4's shape, through the REAL run loop. The window fix (an engine-minted user entry
    // is not a turn) is what routes this shape to `no_valid_cut` instead of a billed
    // summarize — so MORE shapes now land on the refusal path, and the user-facing half
    // of it had no coverage at all. The notice rides the terminal turn_end's blocks,
    // which the sandbox accumulates into `turnBlocks` and ships on AGENT_END
    // (run-driver.ts) — it is never streamed, which is why a socket watching for text
    // deltas sees only `agent:status compacting`.
    process.env.COMPACTION_V2 = '1';
    const taskId = 't9c-noop-notice';
    const journal = makeJournal(taskId);
    await journal.append({
      ...base(taskId),
      principal: { kind: 'user', userId: 'u' },
      payload: {
        type: 'user',
        blocks: [{ type: 'text', text: 'summarise the last 3 emails from stripe' } as ContentBlock],
      },
    });
    await journal.append({
      ...base(taskId),
      principal: { kind: 'user', userId: 'u' },
      payload: {
        type: 'user',
        blocks: [{ type: 'text', text: fenceRecall('keshav is in delhi') } as ContentBlock],
        injected: 'engine',
      },
    } as never);
    await journal.append({
      ...base(taskId),
      payload: {
        type: 'assistant',
        blocks: [{ type: 'text', text: 'ok' } as ContentBlock],
        api: 'anthropic_messages',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
      },
    });

    const transport = new ProjectingTransport([[{ kind: 'text', text: 'unused' }, doneEvent()]]);
    const events = await runTurn({ taskId, journal, transport, ask: '', control: 'compact' });

    const turnEnd = events.filter((e) => e.kind === 'turn_end').at(-1) as
      | { blocks?: Array<{ type: string; text?: string }> }
      | undefined;
    expect(turnEnd).toBeDefined();
    expect(turnEnd!.blocks?.some((b) => b.text === COMPACTION_NOOP_NOTICE)).toBe(true);
    // No compaction happened, so nothing was billed and nothing was said twice.
    expect(raws(events, SESSION_COMPACTED_EVENT)).toHaveLength(0);
    expect(transport.histories).toHaveLength(0);
  });
});
