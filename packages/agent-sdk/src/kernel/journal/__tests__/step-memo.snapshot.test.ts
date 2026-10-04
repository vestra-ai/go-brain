/**
 * P2.8 — indexStepMemos / lookupStepMemo / createStepMemoSnapshot.
 *
 * The tool-side half of the read-amplification fix: one shared, scope-indexed memo
 * map per run (O(1) lookups) instead of each Agent/Weave `execute` draining +
 * linear-scanning the whole journal from disk. The index must be BYTE-IDENTICAL to
 * findStepMemo, and the shared snapshot must freeze once (a run's own memos are never
 * self-consulted) and be disk-free for a journal-less run.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalEntry } from '../../../contract/journal.js';
import { Journal } from '../journal.js';
import { JsonlStore } from '../jsonl-store.js';
import { InMemorySessionStore } from '../session-store.js';
import { sequentialClock } from '../clock.js';
import {
  findStepMemo, indexStepMemos, lookupStepMemo, createStepMemoSnapshot, appendStepResult,
} from '../step-memo.js';

const dir = join(tmpdir(), `step-memo-snapshot-test-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const make = (taskId = 't') => new Journal({
  taskId, workspaceId: 'w',
  jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
  mirror: new InMemorySessionStore(),
  clock: sequentialClock('2026-01-01T00:00:00.000Z'),
});

const memoEntry = (scope: string, specHash: string, resultText: string, seq = 0): JournalEntry => ({
  uuid: `e${seq}`, parentUuid: seq === 0 ? null : `e${seq - 1}`, seq, taskId: 't', rootTaskId: 't',
  spawnDepth: 0, workspaceId: 'w', agentId: 'system', principal: { kind: 'system' },
  timestamp: '2026-01-01T00:00:00.000Z',
  payload: { type: 'step_result', scope, specHash, status: 'ok', resultText, costUsd: 1, settledAt: 'iso' },
});
const userEntry = (seq: number): JournalEntry => ({
  uuid: `e${seq}`, parentUuid: seq === 0 ? null : `e${seq - 1}`, seq, taskId: 't', rootTaskId: 't',
  spawnDepth: 0, workspaceId: 'w', agentId: 'g', principal: { kind: 'user', userId: 'u' },
  timestamp: 'iso', payload: { type: 'user', blocks: [{ type: 'text', text: 'hi' } as never] },
});

describe('indexStepMemos + lookupStepMemo', () => {
  it('matches findStepMemo for every (scope, specHash), including a MISS', () => {
    const entries = [
      userEntry(0),
      memoEntry('agent:1', 'h1', 'r1', 1),
      memoEntry('weave:x', 'h2', 'r2', 2),
      memoEntry('agent:2', 'h1', 'r3', 3),
    ];
    const index = indexStepMemos(entries);
    for (const [scope, hash] of [['agent:1', 'h1'], ['weave:x', 'h2'], ['agent:2', 'h1'], ['agent:1', 'h2'], ['nope', 'h1']] as const) {
      expect(lookupStepMemo(index, scope, hash)).toEqual(findStepMemo(entries, scope, hash));
    }
  });

  it('is LAST-WINS per (scope, specHash) — same precedence as findStepMemo', () => {
    const entries = [
      memoEntry('s', 'h', 'first', 0),
      memoEntry('s', 'h', 'second', 1),
      memoEntry('s', 'h', 'third', 2),
    ];
    expect(lookupStepMemo(indexStepMemos(entries), 's', 'h')?.resultText).toBe('third');
    expect(findStepMemo(entries, 's', 'h')?.resultText).toBe('third');
  });

  it('ignores non-step_result entries', () => {
    const index = indexStepMemos([userEntry(0), memoEntry('s', 'h', 'r', 1)]);
    expect(index.size).toBe(1);
    expect(lookupStepMemo(index, 's', 'h')?.resultText).toBe('r');
  });
});

describe('createStepMemoSnapshot', () => {
  it('finds a journaled memo and exposes the full read-model via entries()', async () => {
    const j = make();
    await appendStepResult(j, {}, { scope: 'agent:1', specHash: 'h1', status: 'ok', resultText: 'done', costUsd: 0, settledAt: 'iso' });
    const snap = createStepMemoSnapshot(j);
    expect((await snap.find('agent:1', 'h1'))?.resultText).toBe('done');
    expect(await snap.find('agent:1', 'nope')).toBeUndefined();
    expect(await snap.entries()).toEqual(await j.snapshot());
  });

  it('is FROZEN at first consult — a memo appended AFTER is not seen (no same-run self-consult)', async () => {
    const j = make();
    await appendStepResult(j, {}, { scope: 'a', specHash: 'h', status: 'ok', resultText: 'r1', costUsd: 0, settledAt: 'iso' });
    const snap = createStepMemoSnapshot(j);
    expect(await snap.find('a', 'h')).toBeDefined(); // freezes here
    const frozenLen = (await snap.entries()).length;
    await appendStepResult(j, {}, { scope: 'b', specHash: 'h', status: 'ok', resultText: 'r2', costUsd: 0, settledAt: 'iso' });
    expect(await snap.find('b', 'h')).toBeUndefined();   // frozen — post-consult append invisible
    expect((await snap.entries()).length).toBe(frozenLen);
  });

  it('journal-less run yields an empty index and no memos (byte-identical flag-off path)', async () => {
    const snap = createStepMemoSnapshot(undefined);
    expect(await snap.find('any', 'hash')).toBeUndefined();
    expect(await snap.entries()).toEqual([]);
  });
});
