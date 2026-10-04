import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../journal.js';
import { JsonlStore } from '../jsonl-store.js';
import { InMemorySessionStore } from '../session-store.js';
import { sequentialClock } from '../clock.js';
import { projectTokenCount } from '../token-ledger.js';
import { planCompaction } from '../../compaction/compactor.js';
import type { NewEntry } from '../../../contract/journal.js';

const dir = join(tmpdir(), `compaction-test-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const make = (taskId = 't') => new Journal({
  taskId,
  workspaceId: 'w',
  jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
  mirror: new InMemorySessionStore(),
  clock: sequentialClock('2026-01-01T00:00:00.000Z'),
});
const base = { taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g', timestamp: '', principal: { kind: 'system' } as const };
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
const textOf = (m: { payload: unknown }) =>
  ((m.payload as { blocks: { text: string }[] }).blocks[0]?.text);

describe('Journal compaction projection', () => {
  it('projects summary FIRST, then preserved + firstKept-onward in order; drops old non-preserved entries', async () => {
    const j = make();
    const m0 = await j.append(userMsg('m0-old-dropped'));   // old, not preserved → dropped
    const m1 = await j.append(assistantMsg('m1-preserved')); // old, preserved → kept
    const m2 = await j.append(userMsg('m2-old-dropped'));    // old, not preserved → dropped
    const m3 = await j.append(userMsg('m3-recent-kept'));    // firstKept → kept
    await j.append(assistantMsg('m4-recent-kept'));          // after firstKept → kept
    const summary = await j.append(assistantMsg('SUMMARY'));   // the compressed-history summary

    await j.compact({
      base,
      summaryUuid: summary.uuid,
      preservedUuids: [m1.uuid],
      firstKeptId: m3.uuid,
      trigger: 'auto', preTokens: 100, postTokens: 10,
    });

    const state = await j.project();
    const texts = state.messages.map(textOf);
    // Summary leads (compressed history); then preserved + firstKept-onward in seq order.
    expect(texts).toEqual(['SUMMARY', 'm1-preserved', 'm3-recent-kept', 'm4-recent-kept']);
    // The dropped entries must not appear.
    expect(texts).not.toContain('m0-old-dropped');
    expect(texts).not.toContain('m2-old-dropped');
    // Sanity: m0/m2 were genuinely older than firstKept.
    expect(m0.seq).toBeLessThan(m3.seq);
    expect(m2.seq).toBeLessThan(m3.seq);
  });

  it('survives a restart and projects compaction correctly from cold replay', async () => {
    const j1 = make();
    await j1.append(userMsg('old-dropped'));
    const keep = await j1.append(userMsg('recent-kept'));
    const summary = await j1.append(assistantMsg('SUMMARY'));
    await j1.compact({
      base, summaryUuid: summary.uuid, preservedUuids: [], firstKeptId: keep.uuid,
      trigger: 'auto', preTokens: 1, postTokens: 1,
    });
    // Fresh process over the same on-disk file.
    const j2 = make();
    const state = await j2.project();
    expect(state.messages.map(textOf)).toEqual(['SUMMARY', 'recent-kept']);
  });

  // P2.0 anchor-loss contract: a missing anchor DEGRADES to the pre-compaction
  // projection with a loud onIntegrityEvent — it no longer throws/bricks.
  // (Full degrade coverage lives in journal.anchor-loss.test.ts.)
  it('degrades (never throws) when firstKeptId does not exist', async () => {
    const j = make();
    await j.append(userMsg('a'));
    const summary = await j.append(assistantMsg('SUMMARY'));
    await j.compact({
      base, summaryUuid: summary.uuid, preservedUuids: [], firstKeptId: 'nonexistent-id',
      trigger: 'manual', preTokens: 1, postTokens: 1,
    });
    const state = await j.project();
    expect(state.messages.map(textOf)).toEqual(['a', 'SUMMARY']); // pre-compaction view, alive
  });

  it('degrades (never throws) when summaryUuid does not exist', async () => {
    const j = make();
    const keep = await j.append(userMsg('a'));
    await j.compact({
      base, summaryUuid: 'no-summary', preservedUuids: [], firstKeptId: keep.uuid,
      trigger: 'manual', preTokens: 1, postTokens: 1,
    });
    const state = await j.project();
    expect(state.messages.map(textOf)).toEqual(['a']); // pre-compaction view, alive
  });

  it('no compact_boundary → identity (all context entries returned in order)', async () => {
    const j = make();
    await j.append(userMsg('one'));
    await j.append(assistantMsg('two'));
    const state = await j.project();
    expect(state.messages.map(textOf)).toEqual(['one', 'two']);
  });

  // ─── K4C-3 D2: the compaction-aware cache signal on the projection ───────────

  it('K4C-3: sets compactionSummaryLeading=true once the projection leads with a compaction summary', async () => {
    const j = make();
    await j.append(userMsg('old-dropped'));
    const keep = await j.append(userMsg('recent-kept'));
    const summary = await j.append(assistantMsg('SUMMARY'));
    await j.compact({
      base, summaryUuid: summary.uuid, preservedUuids: [], firstKeptId: keep.uuid,
      trigger: 'auto', preTokens: 1, postTokens: 1,
    });
    const state = await j.project();
    expect(state.compactionSummaryLeading).toBe(true);
    // It is genuinely the summary at the head (the engine's anchor target).
    expect(textOf(state.messages[0])).toBe('SUMMARY');
  });

  it('K4C-3: compactionSummaryLeading is falsy on an UNcompacted projection (byte-identical default)', async () => {
    const j = make();
    await j.append(userMsg('one'));
    await j.append(assistantMsg('two'));
    const state = await j.project();
    expect(state.compactionSummaryLeading).toBeFalsy();
  });
});

// ─── K4-T1 integration: the real Compactor against a real Journal ─────────────────
// Drives planCompaction (kernel-pure planner) → harness-side splice recording
// (append summary as a `user` entry + Journal.compact()) → re-project, end-to-end.

const big = (label: string) => `${label} ${'word '.repeat(60)}`; // ~80 tok by word-count

describe('K4-T1 Compactor — integration with the real Journal', () => {
  it('Step 9: real-Compactor turn-boundary — summary leads, kept turns in order, dropped absent', async () => {
    const j = make();
    await j.append(userMsg(big('u0-old-dropped')));        // turn 1 (dropped)
    await j.append(assistantMsg(big('a0-old-dropped')));
    const keep = await j.append(userMsg(big('u1-recent-kept'))); // turn 2 (firstKept)
    await j.append(assistantMsg(big('a1-recent-kept')));

    const before = await j.project();
    const preTokens = projectTokenCount(before.messages).messages;

    const plan = await planCompaction({
      entries: before.messages,
      keepWindowTokens: 160, // keeps the recent turn (~158 tok); drops turn 1
      preTokens,
      summarize: async () => 'SUMMARY',
    });
    expect(plan.firstKeptId).toBe(keep.uuid);

    // Harness side: append the summary as a `user` entry, then record the splice.
    const summary = await j.append(userMsg(plan.summaryText));
    await j.compact({
      base,
      summaryUuid: summary.uuid,
      preservedUuids: plan.preservedUuids,
      firstKeptId: plan.firstKeptId,
      trigger: plan.trigger,
      preTokens,                 // caller-measured (pre-plan); the plan returns only postTokens
      postTokens: plan.postTokens,
    });

    const after = await j.project();
    const texts = after.messages.map(textOf);
    expect(texts[0]).toBe('SUMMARY');                          // summary leads
    expect(texts.slice(1)).toEqual([                           // kept turns in seq order
      big('u1-recent-kept'),
      big('a1-recent-kept'),
    ]);
    expect(texts).not.toContain(big('u0-old-dropped'));        // dropped turns absent
    expect(texts).not.toContain(big('a0-old-dropped'));
  });

  it('Step 10: split-turn FOLD round-trip — exactly ONE compact_boundary recorded', async () => {
    const j = make();
    // A long old turn with two tool rounds (would conceptually split) + a recent turn.
    await j.append(userMsg(big('u0')));
    await j.append(assistantMsg(big('a0')));
    const keep = await j.append(userMsg(big('u1-recent')));
    await j.append(assistantMsg(big('a1-recent')));

    const before = await j.project();
    const preTokens = projectTokenCount(before.messages).messages;

    let summarizeCalls = 0;
    const plan = await planCompaction({
      entries: before.messages,
      keepWindowTokens: 160,
      preTokens,
      summarize: async () => { summarizeCalls++; return 'FOLDED'; },
    });
    expect(summarizeCalls).toBe(1);
    expect(plan.firstKeptId).toBe(keep.uuid);

    const summary = await j.append(userMsg(plan.summaryText));
    await j.compact({
      base, summaryUuid: summary.uuid, preservedUuids: plan.preservedUuids,
      firstKeptId: plan.firstKeptId, trigger: plan.trigger,
      preTokens, postTokens: plan.postTokens,
    });

    // Count compact_boundary entries via read() → exactly 1 (no schema widening / dual leak).
    let boundaries = 0;
    for await (const e of j.read()) {
      if (e.payload.type === 'compact_boundary') boundaries++;
    }
    expect(boundaries).toBe(1);
  });

  it('Step 11: re-compaction subsumes prior — NEW summary leads, old summary gone', async () => {
    const j = make();
    await j.append(userMsg(big('u0-first-old')));
    await j.append(assistantMsg(big('a0-first-old')));
    const keep1 = await j.append(userMsg(big('u1-mid')));
    await j.append(assistantMsg(big('a1-mid')));

    // First compaction.
    const b1 = await j.project();
    const pre1 = projectTokenCount(b1.messages).messages;
    const plan1 = await planCompaction({
      entries: b1.messages, keepWindowTokens: 160,
      preTokens: pre1,
      summarize: async () => 'SUMMARY-1',
    });
    expect(plan1.firstKeptId).toBe(keep1.uuid);
    const s1 = await j.append(userMsg(plan1.summaryText));
    await j.compact({
      base, summaryUuid: s1.uuid, preservedUuids: plan1.preservedUuids,
      firstKeptId: plan1.firstKeptId, trigger: plan1.trigger,
      preTokens: pre1, postTokens: plan1.postTokens,
    });

    // The projection now leads with SUMMARY-1.
    const mid = await j.project();
    expect(mid.messages.map(textOf)[0]).toBe('SUMMARY-1');

    // Append more turns, then compact AGAIN over the new projection.
    await j.append(assistantMsg(big('a-more')));
    const keep2 = await j.append(userMsg(big('u2-newest')));
    await j.append(assistantMsg(big('a2-newest')));

    const b2 = await j.project();
    // Sanity: the second projection still leads with the prior summary.
    expect(b2.messages[0] && textOf(b2.messages[0])).toBe('SUMMARY-1');

    const pre2 = projectTokenCount(b2.messages).messages;
    const plan2 = await planCompaction({
      entries: b2.messages, keepWindowTokens: 160,
      preTokens: pre2,
      summarize: async (toSummarize) => {
        // The new toSummarize INCLUDES the prior summary (subsumption).
        expect(textOf(toSummarize[0])).toBe('SUMMARY-1');
        return 'SUMMARY-2';
      },
    });
    expect(plan2.firstKeptId).toBe(keep2.uuid);
    const s2 = await j.append(userMsg(plan2.summaryText));
    await j.compact({
      base, summaryUuid: s2.uuid, preservedUuids: plan2.preservedUuids,
      firstKeptId: plan2.firstKeptId, trigger: plan2.trigger,
      preTokens: pre2, postTokens: plan2.postTokens,
    });

    // Last boundary wins (journal.ts:175-180): NEW summary leads, old summary subsumed.
    const after = await j.project();
    const texts = after.messages.map(textOf);
    expect(texts[0]).toBe('SUMMARY-2');
    expect(texts).not.toContain('SUMMARY-1');
    expect(texts).toContain(big('u2-newest'));
  });
});
