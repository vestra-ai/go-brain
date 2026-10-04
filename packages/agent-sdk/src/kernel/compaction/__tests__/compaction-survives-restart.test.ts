/**
 * K4-T3: structural compaction-survives-restart test.
 *
 * FREE test: no API key, no model calls. Uses a fake summarize callback.
 * Runs on every PR as the per-PR gate for the applyCompaction contract.
 *
 * Three cases:
 *  1. Fact turns survive compaction on cold replay.
 *  2. 2nd compaction subsumes 1st summary.
 *  3. No valid cut → planCompaction rejects.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../../journal/journal.js';
import { JsonlStore } from '../../journal/jsonl-store.js';
import { InMemorySessionStore } from '../../journal/session-store.js';
import { sequentialClock } from '../../journal/clock.js';
import { projectTokenCount } from '../../journal/token-ledger.js';
import { planCompaction } from '../compactor.js';
import type { NewEntry } from '../../../contract/journal.js';

// ─── Helpers ────────────────────────────────────────────────────────────────────

const uniqueDir = () => join(tmpdir(), `restart-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Build a Journal rooted at `dir/taskId.jsonl`. */
const make = (dir: string, taskId = 't') =>
  new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2026-01-01T00:00:00.000Z'),
  });

const base = {
  taskId: 't',
  rootTaskId: 't',
  spawnDepth: 0,
  workspaceId: 'w',
  agentId: 'g',
  timestamp: '',
  principal: { kind: 'system' } as const,
};

const userMsg = (text: string): NewEntry => ({
  ...base,
  principal: { kind: 'user', userId: 'u' },
  payload: { type: 'user', blocks: [{ type: 'text', text } as never] },
});

const assistantMsg = (text: string): NewEntry => ({
  ...base,
  principal: { kind: 'agent', agentId: 'g' },
  payload: { type: 'assistant', blocks: [{ type: 'text', text } as never] },
});

/** Token-dense content so keepWindowTokens cuts clearly. */
const dense = (label: string) => `${label}: ${'fact '.repeat(50)}`; // ~60 tokens

const textOf = (e: { payload: unknown }) =>
  ((e.payload as { blocks: { text: string }[] }).blocks[0]?.text ?? '');

// Temp dirs per test — collect for afterEach cleanup.
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) {
    await fs.rm(d, { recursive: true, force: true });
  }
  dirs.length = 0;
});

// ─── Case 1: fact turns survive compaction on cold replay ────────────────────────

describe('compaction-survives-restart', () => {
  it('Case 1: fact turns survive compaction on cold replay', async () => {
    const dir = uniqueDir();
    dirs.push(dir);
    const j1 = make(dir);

    // Old turns (will be dropped by compaction)
    await j1.append(userMsg(dense('fact-a: the server runs on port 3005')));
    await j1.append(assistantMsg(dense('understood fact-a')));
    await j1.append(userMsg(dense('fact-b: Railway service is fabulous-liberation')));
    await j1.append(assistantMsg(dense('understood fact-b')));

    // Recent surviving turn
    const recentTurn = await j1.append(userMsg('recent-surviving-turn'));
    await j1.append(assistantMsg('recent-response'));

    const before = await j1.project();
    const preTokens = projectTokenCount(before.messages).messages;

    // keepWindowTokens=50 forces old dense turns to be dropped.
    const plan = await planCompaction({
      entries: before.messages,
      keepWindowTokens: 50,
      preTokens,
      summarize: async () => 'SUMMARY: test summary of dropped facts',
    });

    // Harness-side recording: append summary user entry, then Journal.compact().
    const summaryEntry = await j1.append(userMsg(plan.summaryText));
    await j1.compact({
      base,
      summaryUuid: summaryEntry.uuid,
      preservedUuids: plan.preservedUuids,
      firstKeptId: plan.firstKeptId,
      trigger: plan.trigger,
      preTokens,
      postTokens: plan.postTokens,
    });

    // Cold replay: new Journal over the SAME on-disk file.
    const j2 = make(dir);
    const state = await j2.project();
    const texts = state.messages.map(textOf);

    // (A) Summary leads.
    expect(texts[0]).toBe('SUMMARY: test summary of dropped facts');

    // (B) Recent turn is present.
    expect(texts).toContain('recent-surviving-turn');
    expect(texts).toContain('recent-response');

    // (C) Dropped turns are absent.
    expect(texts.some(t => t.includes('fact-a'))).toBe(false);
    expect(texts.some(t => t.includes('fact-b'))).toBe(false);

    // (D) Projection does not throw (already proven by reaching here).
    expect(state.messages.length).toBeGreaterThan(0);

    // (E) postTokens > 0.
    expect(plan.postTokens).toBeGreaterThan(0);

    // Confirm firstKeptId resolves to the recent turn.
    expect(plan.firstKeptId).toBe(recentTurn.uuid);
  });

  // ─── Case 2: 2nd compaction subsumes 1st summary ──────────────────────────────

  it('Case 2: 2nd compaction subsumes 1st summary', async () => {
    const dir = uniqueDir();
    dirs.push(dir);
    const j1 = make(dir);

    // First wave of dense old turns.
    await j1.append(userMsg(dense('old-turn-1')));
    await j1.append(assistantMsg(dense('old-response-1')));

    // First compaction cycle.
    const recent1 = await j1.append(userMsg('recent-1'));
    await j1.append(assistantMsg('recent-response-1'));

    const before1 = await j1.project();
    const preTokens1 = projectTokenCount(before1.messages).messages;
    const plan1 = await planCompaction({
      entries: before1.messages,
      keepWindowTokens: 50,
      preTokens: preTokens1,
      summarize: async () => 'SUMMARY-1: first compaction summary',
    });
    expect(plan1.firstKeptId).toBe(recent1.uuid);

    const summaryEntry1 = await j1.append(userMsg(plan1.summaryText));
    await j1.compact({
      base,
      summaryUuid: summaryEntry1.uuid,
      preservedUuids: plan1.preservedUuids,
      firstKeptId: plan1.firstKeptId,
      trigger: plan1.trigger,
      preTokens: preTokens1,
      postTokens: plan1.postTokens,
    });

    // Add more dense turns for the 2nd compaction.
    await j1.append(userMsg(dense('mid-turn-for-2nd-compact')));
    await j1.append(assistantMsg(dense('mid-response-for-2nd-compact')));

    const recent2 = await j1.append(userMsg('recent-2-after-first-compact'));
    await j1.append(assistantMsg('recent-response-2'));

    const before2 = await j1.project();
    const preTokens2 = projectTokenCount(before2.messages).messages;
    const plan2 = await planCompaction({
      entries: before2.messages,
      keepWindowTokens: 50,
      preTokens: preTokens2,
      summarize: async () => 'SUMMARY-2: second compaction subsumes first',
    });
    expect(plan2.firstKeptId).toBe(recent2.uuid);

    const summaryEntry2 = await j1.append(userMsg(plan2.summaryText));
    await j1.compact({
      base,
      summaryUuid: summaryEntry2.uuid,
      preservedUuids: plan2.preservedUuids,
      firstKeptId: plan2.firstKeptId,
      trigger: plan2.trigger,
      preTokens: preTokens2,
      postTokens: plan2.postTokens,
    });

    // Cold replay.
    const j2 = make(dir);
    const state = await j2.project();
    const texts = state.messages.map(textOf);

    // 2nd summary leads.
    expect(texts[0]).toBe('SUMMARY-2: second compaction subsumes first');
    // 1st summary is NOT present (it was in the dropped span for the 2nd compaction).
    expect(texts.some(t => t.includes('SUMMARY-1'))).toBe(false);
    // recent-2 is present.
    expect(texts).toContain('recent-2-after-first-compact');
  });

  // ─── Case 3: no valid cut → planCompaction rejects ────────────────────────────

  it('Case 3: no valid cut → planCompaction rejects', async () => {
    const dir = uniqueDir();
    dirs.push(dir);
    const j = make(dir);

    // Only a single small turn — fits entirely inside keepWindowTokens (200).
    // With keepWindowTokens large enough to hold the whole conversation, rawCutIdx
    // stays at 0 → cutIdx===0 → no valid cut.
    await j.append(userMsg('short message'));
    await j.append(assistantMsg('short reply'));

    const before = await j.project();
    const preTokens = projectTokenCount(before.messages).messages;

    await expect(
      planCompaction({
        entries: before.messages,
        keepWindowTokens: 200, // comfortably fits everything → no cut
        preTokens,
        summarize: async () => 'should not be called',
      }),
    ).rejects.toThrow('planCompaction: no valid turn-boundary cut');
  });
});
