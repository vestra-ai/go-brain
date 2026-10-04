/**
 * T9b rule 4 — A REFUSED COMPACTION IS OBSERVABLE.
 *
 * The round head's never-throw wrapper swallowed every refusal into
 * `console.warn('[NativeHarness] compaction failed', …)`. That is how "an agentic
 * loop can never compact" survived for months: the trigger fired, the planner
 * refused, the run continued uncompacted until it died of `context_exceeded`, and
 * nothing durable said so. Never-throw stays; silence does not.
 *
 * The refusal now carries a NAMED reason and reaches a host two ways:
 *   · a `session:compaction_failed` raw event yielded from the round head, and
 *   · a `custom` journal entry keyed `compaction_failed` — the durable leg, and the
 *     ONLY one available on the manual `/compact` path, which returns a value
 *     instead of yielding events.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { compactTurnHead, type RoundPhaseDeps } from '../native-iterate-round.js';
import { COMPACTION_FAILED_EVENT } from '../compaction-run.js';
import type { JournalEntry, NewEntry } from '../../contract/journal.js';

/** A single ENORMOUS user entry — the one-ask shape, past any trigger, with nothing
 *  after it to cut to. Even the T9b boundary rule has no valid cut here. */
const HUGE = 'the brain index, page after page. '.repeat(26_000);

function userEntry(text: string): JournalEntry {
  return {
    uuid: 'entry-0',
    parentUuid: null,
    seq: 0,
    taskId: 'task-fail',
    rootTaskId: 'task-fail',
    spawnDepth: 0,
    workspaceId: 'w',
    agentId: 'g',
    principal: { kind: 'system' },
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: { type: 'user', blocks: [{ type: 'text', text }] },
  };
}

function makeDeps(appended: NewEntry[]): RoundPhaseDeps {
  const messages = [userEntry(HUGE)];
  const journal = {
    project: async () => ({ messages, leaf: null, compactionSummaryLeading: false }),
    // K5 §8.7 — runCompaction reads the live paused set before it plans; nothing is paused here.
    liveSuspendedIds: async () => new Set<string>(),
    append: async (e: NewEntry) => {
      appended.push(e);
      return { ...e, uuid: 'appended', seq: 1 } as unknown as JournalEntry;
    },
  };
  const cfg = {
    journal,
    compaction: {},
    runtimeConfig: { sessionId: 's', userId: 'u' },
  };
  const ctx = { taskId: 'task-fail', model: 'claude-sonnet-4-5', config: cfg };
  const transport = {
    defaultModel: () => 'claude-sonnet-4-5',
    historyFromJournal: () => [],
    pushUser: () => undefined,
    callModel: () => [],
    readStream: async function* () {
      /* never reached — the planner refuses before any model call */
    },
    computeCostUsd: () => 0,
  };
  const rc = {
    pendingOverflow: undefined,
    elision: null,
    elisionCut: null,
    billing: { roundCounter: { value: 3 }, cumulativeCostUsd: 0, parentOwnCostUsd: 0 },
  };
  return {
    ctx,
    cfg,
    transport,
    rc,
    elision: null,
    makeCompactionDeps: () => ({
      ctx,
      transport,
      dispatcher: { dispatch: async () => [] },
      compactionBase: () => ({
        taskId: 'task-fail',
        rootTaskId: 'task-fail',
        spawnDepth: 0,
        workspaceId: 'w',
        agentId: 'g',
        principal: { kind: 'system' },
        timestamp: '',
      }),
      runSignal: () => new AbortController().signal,
    }),
    runSignal: () => new AbortController().signal,
  } as unknown as RoundPhaseDeps;
}

beforeEach(() => {
  vi.stubEnv('COMPACTION_V2', '1');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a refused compaction is observable (T9b rule 4)', () => {
  it('yields a compaction_failed event carrying the planner\'s NAMED reason', async () => {
    const appended: NewEntry[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const events = [];
    const gen = compactTurnHead(makeDeps(appended), 'system', () => [], []);
    for (;;) {
      const next = await gen.next();
      if (next.done) break;
      events.push(next.value);
    }
    warn.mockRestore();

    const failure = events.find(
      (e) => e.kind === 'raw' && (e as { event: string }).event === COMPACTION_FAILED_EVENT,
    ) as { data: Record<string, unknown> } | undefined;
    expect(failure).toBeDefined();
    expect(failure!.data.reason).toBe('no_valid_cut');
    expect(failure!.data.trigger).toBe('auto');
    expect(failure!.data.taskId).toBe('task-fail');
  });

  it('records the refusal in the journal as a `compaction_failed` custom entry (the durable leg)', async () => {
    const appended: NewEntry[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gen = compactTurnHead(makeDeps(appended), 'system', () => [], []);
    for (;;) {
      if ((await gen.next()).done) break;
    }
    warn.mockRestore();

    const row = appended.find(
      (e) => (e.payload as { type?: string; key?: string }).key === 'compaction_failed',
    );
    expect(row).toBeDefined();
    expect((row!.payload as { data: { reason: string } }).data.reason).toBe('no_valid_cut');
  });

  it('still degrades to no-compaction — the turn is never ended by a refusal', async () => {
    const appended: NewEntry[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const historyIn = ['UNCHANGED'];
    const gen = compactTurnHead(makeDeps(appended), 'system', () => [], historyIn);
    let result;
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        result = next.value;
        break;
      }
    }
    warn.mockRestore();
    expect(result).toBe(historyIn);
  });
});
