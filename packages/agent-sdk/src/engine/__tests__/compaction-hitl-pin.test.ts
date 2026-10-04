/**
 * K5 §8.7 — COMPACTION KEEPS A PAUSED HUMAN QUESTION (the "K5 pin", wired).
 *
 * `planCompaction` has pinned a paused `tool_use` since T1 (kernel/compaction/__tests__/
 * hitl-pin.test.ts), but the ONE production caller, `runCompaction`, never handed it the
 * ids — and could not have pinned on the projection anyway, because `project()` suspends
 * a paused `tool_use` OUT of the list the model sees. So on a long-lived session the
 * cut could land past the question the agent asked; the user's answer then materialized
 * a `tool_result` with no `tool_use` to pair with, and the wire dropped it: the agent no
 * longer remembered asking.
 *
 * This test runs the PRODUCTION body on a real journal and asserts the end-to-end truth:
 * after the compaction, the answer still pairs with the question in the projection.
 *
 * Fails if `pausedToolUseIds` is dropped from the `planCompaction` call in
 * `runCompaction` (compaction-run.ts), AND fails if the paused tool_use is not re-seated
 * into the planner's `entries` (`reseatPausedToolUses`) — either mutation lets the natural
 * cut drop the question. Both were run against this test before it shipped.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { runCompaction, type CompactionDeps } from '../compaction-run.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { JournalEntry, NewEntry } from '../../contract/journal.js';
import type { ContentBlock } from '../../contract/blocks.js';

const BODY = 'word '.repeat(400); // ~520 estimated tokens per entry
const PAUSED = 'tu-ask';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const base = (taskId: string): Omit<NewEntry, 'payload'> => ({
  taskId,
  rootTaskId: taskId,
  spawnDepth: 0,
  workspaceId: 'w',
  agentId: 'native',
  principal: { kind: 'agent', agentId: 'native' },
  timestamp: '',
});

async function makeJournal(taskId: string): Promise<Journal> {
  const dir = await mkdtemp(join(tmpdir(), `k5-pin-${process.pid}-`));
  dirs.push(dir);
  return new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2024-01-01T00:00:00.000Z'),
  });
}

const text = (t: string) => [{ type: 'text', text: t } as ContentBlock];
const user = (j: Journal, t: string, body: string) =>
  j.append({
    ...base(t),
    principal: { kind: 'user', userId: 'u' },
    payload: { type: 'user', blocks: text(body) },
  });
const assistant = (j: Journal, t: string, body: string) =>
  j.append({
    ...base(t),
    payload: {
      type: 'assistant',
      blocks: text(body),
      api: 'anthropic_messages',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    },
  });
const toolUse = (j: Journal, t: string, id: string, name: string) =>
  j.append({ ...base(t), payload: { type: 'tool_use', toolUseId: id, name, input: {} } });
const toolResult = (j: Journal, t: string, id: string, body: string) =>
  j.append({ ...base(t), payload: { type: 'tool_result', toolUseId: id, blocks: text(body) } });

/**
 * [ask, round 0, ASK ROUND (assistant + paused tool_use + unresolved interaction),
 *  rounds 2..4]. The tail after the pause is ~3 rounds (~3,100 tokens), so a 2,000-token
 * keep window's natural cut lands INSIDE the tail — past the question. A session that
 * carried on past a pending question: the shape the pin exists for.
 */
async function pausedJournal(taskId: string, answeredInPlace = false): Promise<Journal> {
  const j = await makeJournal(taskId);
  await user(j, taskId, `the one ask ${BODY}`);
  await assistant(j, taskId, `step 0 ${BODY}`);
  await toolUse(j, taskId, 'tu-0', 'Read');
  await toolResult(j, taskId, 'tu-0', `result 0 ${BODY}`);
  await assistant(j, taskId, `which one do you mean? ${BODY}`);
  await toolUse(j, taskId, PAUSED, 'AskUserQuestion');
  await j.append({
    ...base(taskId),
    payload: {
      type: 'interaction',
      interactionId: 'i-ask',
      resolved: false,
      data: { kind: 'ask_question', toolUseId: PAUSED, toolName: 'AskUserQuestion' },
    },
  });
  if (answeredInPlace) await answer(j, taskId);
  for (let i = 2; i < 5; i++) {
    await assistant(j, taskId, `step ${i} ${BODY}`);
    await toolUse(j, taskId, `tu-${i}`, 'Read');
    await toolResult(j, taskId, `tu-${i}`, `result ${i} ${BODY}`);
  }
  return j;
}

/** The user answers: the interaction resolves and the continue materializes the result. */
async function answer(j: Journal, taskId: string): Promise<void> {
  await j.append({
    ...base(taskId),
    payload: {
      type: 'interaction',
      interactionId: 'i-ask',
      resolved: true,
      data: { outcome: { behavior: 'allow' } },
    },
  });
  await toolResult(j, taskId, PAUSED, 'the blue one');
}

function summarizingTransport(summary: string): FakeTransport {
  class T extends FakeTransport {
    constructor() {
      super([
        { kind: 'text', text: summary },
        {
          kind: 'done',
          stopReason: 'end_turn',
          usage: { inputTokens: 500, outputTokens: 30 } as NormalizedUsage,
        } as StreamEvent,
      ]);
    }
    override computeCostUsd(): number {
      return 0.03;
    }
  }
  return new T();
}

function makeDeps(journal: Journal, taskId: string): CompactionDeps {
  const cfg = { journal, compaction: {}, runtimeConfig: { sessionId: 's', userId: 'u' } };
  return {
    ctx: { taskId, model: 'claude-sonnet-4-5', config: cfg },
    transport: summarizingTransport('SUMMARY'),
    dispatcher: { dispatch: async () => [] },
    compactionBase: () => base(taskId),
    runSignal: () => new AbortController().signal,
  } as unknown as CompactionDeps;
}

const ids = (entries: JournalEntry[], type: 'tool_use' | 'tool_result') =>
  entries.filter((e) => e.payload.type === type).map((e) => (e.payload as { toolUseId: string }).toolUseId);

const KEEP_WINDOW = 2_000;

describe('runCompaction — K5 §8.7: the cut retreats to keep a paused human question', () => {
  it('after compaction the answer still pairs with the question in the projection', async () => {
    const taskId = 'k5-pin';
    const j = await pausedJournal(taskId);
    // The pause suspends the question out of the projection the planner is handed.
    const before = (await j.project()).messages;
    expect(ids(before, 'tool_use')).not.toContain(PAUSED);

    const result = await runCompaction(makeDeps(j, taskId), before, {
      trigger: 'auto',
      keepWindowTokens: KEEP_WINDOW,
      resumesTurn: true,
    });
    expect(result).not.toBeNull();

    // The cut retreated to the ask round: its assistant entry is the first kept.
    const all = await j.snapshot();
    const boundary = all.find((e) => e.payload.type === 'compact_boundary')!;
    const firstKept = all.find((e) => e.uuid === (boundary.payload as { firstKeptId: string }).firstKeptId)!;
    const pausedEntry = all.find((e) => e.payload.type === 'tool_use' && e.payload.toolUseId === PAUSED)!;
    expect(firstKept.seq).toBeLessThan(pausedEntry.seq);

    // …so when the user answers, the question and the answer are BOTH in the model's view.
    await answer(j, taskId);
    const after = (await j.project()).messages;
    expect(ids(after, 'tool_use')).toContain(PAUSED);
    expect(ids(after, 'tool_result')).toContain(PAUSED);
    // and it still compacted SOMETHING: the ask and round 0 are gone (the pin retreats, it doesn't skip).
    expect(ids(after, 'tool_use')).not.toContain('tu-0');
  });

  it('CONTROL: the same window on the same journal, once the question is ANSWERED, cuts past it', async () => {
    // Proves the window is small enough that only the pin keeps the ask round above:
    // answered IN PLACE (a normal round), the pair is contiguous, nothing is paused, and
    // the natural cut drops it whole.
    const taskId = 'k5-pin-control';
    const j = await pausedJournal(taskId, true);
    const before = (await j.project()).messages;
    expect(ids(before, 'tool_use')).toContain(PAUSED);

    const result = await runCompaction(makeDeps(j, taskId), before, {
      trigger: 'auto',
      keepWindowTokens: KEEP_WINDOW,
      resumesTurn: true,
    });
    expect(result).not.toBeNull();
    const after = (await j.project()).messages;
    expect(ids(after, 'tool_use')).not.toContain(PAUSED);
    expect(ids(after, 'tool_result')).not.toContain(PAUSED);
  });
});
