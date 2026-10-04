import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, type JournalIntegrityEvent } from '../journal.js';
import { JsonlStore } from '../jsonl-store.js';
import { sequentialClock } from '../clock.js';
import type { JournalEntry, NewEntry } from '../../../contract/journal.js';
import type { SessionStore } from '../session-store.js';

const dir = join(tmpdir(), `mirror-retry-test-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const u = (): NewEntry => ({ taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g', principal: { kind: 'system' }, timestamp: '', payload: { type: 'system', event: 'x' } });

const make = (taskId: string, mirror: SessionStore, onIntegrityEvent?: (e: JournalIntegrityEvent) => void) => new Journal({
  taskId,
  workspaceId: 'w',
  jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
  mirror,
  clock: sequentialClock('T'),
  ...(onIntegrityEvent ? { onIntegrityEvent } : {}),
});

describe('flushMirror retry (P2.0 — clear only on success)', () => {
  it('a failed batch re-queues at the head and lands on the next flush (no permanent loss)', async () => {
    const calls: JournalEntry[][] = [];
    let fail = true;
    const mirror: SessionStore = {
      appendBatch: async (_t, b) => { if (fail) { fail = false; throw new Error('boom'); } calls.push(b); },
      load: async () => null, listTasks: async () => [],
    };
    const j = make('t-requeue', mirror);
    await j.append(u()); await j.flushMirror();     // fails; TODAY this drops the batch forever
    await j.append(u()); await j.flushMirror();     // succeeds
    expect(calls.flat().map((e) => e.seq)).toEqual([0, 1]); // both survive, in order
  });

  it('drains a >200-entry backlog in windows on one flush call', async () => {
    const calls: JournalEntry[][] = [];
    const mirror: SessionStore = {
      appendBatch: async (_t, b) => { calls.push(b); },
      load: async () => null, listTasks: async () => [],
    };
    const j = make('t-window', mirror);
    for (let i = 0; i < 250; i++) await j.append(u());
    await j.flushMirror();
    expect(calls.map((c) => c.length)).toEqual([200, 50]);   // windowed, fully drained
    expect(calls.flat().map((e) => e.seq)).toEqual([...Array(250).keys()]); // in order
    await j.flushMirror();
    expect(calls.map((c) => c.length)).toEqual([200, 50]);   // nothing left to send
  });

  it('caps one flush call at 2 windows (400 rows) — a recovered backlog amortizes across turns, never stalls one', async () => {
    // flushMirror is awaited on the turn's critical path (before AGENT_END); an
    // unbounded drain of a 5000-entry backlog would be ~25 sequential POSTs.
    const calls: JournalEntry[][] = [];
    const mirror: SessionStore = {
      appendBatch: async (_t, b) => { calls.push(b); },
      load: async () => null, listTasks: async () => [],
    };
    const j = make('t-cap', mirror);
    for (let i = 0; i < 1000; i++) await j.append(u());
    await j.flushMirror();
    expect(calls.map((c) => c.length)).toEqual([200, 200]);  // exactly 2 windows this turn
    expect(calls.flat().map((e) => e.seq)).toEqual([...Array(400).keys()]);
    await j.flushMirror();                                    // next turn boundary
    expect(calls.map((c) => c.length)).toEqual([200, 200, 200, 200]);
    await j.flushMirror();
    expect(calls.flat().map((e) => e.seq)).toEqual([...Array(1000).keys()]); // 600 remainder drained in order
  });

  it('two concurrent flushMirror calls share ONE drain — zero entries lost on a mid-drain failure', async () => {
    // Unserialized overlapping flushes interleave splices; the review reproduced
    // 200 entries vanishing (neither sent nor re-queued).
    const calls: JournalEntry[][] = [];
    let failOnce = true;
    const mirror: SessionStore = {
      appendBatch: async (_t, b) => {
        await new Promise((r) => setTimeout(r, 5)); // hold the window so the calls overlap
        if (failOnce && b[0]?.seq === 200) { failOnce = false; throw new Error('mid-drain boom'); }
        calls.push(b);
      },
      load: async () => null, listTasks: async () => [],
    };
    const j = make('t-concurrent', mirror);
    for (let i = 0; i < 400; i++) await j.append(u());
    await Promise.all([j.flushMirror(), j.flushMirror()]); // concurrent — must coalesce
    await j.flushMirror(); // retry the failed window
    const seqs = calls.flat().map((e) => e.seq);
    expect(seqs).toEqual([...Array(400).keys()]); // every entry landed exactly once, in order
  });

  it('still never throws and reports via onMirrorError on failure', async () => {
    const onMirrorError = vi.fn();
    const mirror: SessionStore = {
      appendBatch: async () => { throw new Error('pg down'); },
      load: async () => null, listTasks: async () => [],
    };
    const j = new Journal({
      taskId: 't-err', workspaceId: 'w',
      jsonl: new JsonlStore(join(dir, 't-err.jsonl')),
      mirror, clock: sequentialClock('T'), onMirrorError,
    });
    await j.append(u());
    await expect(j.flushMirror()).resolves.toBeUndefined();
    expect(onMirrorError).toHaveBeenCalledOnce();
  });

  it('beyond the 5000-entry buffer cap, drops OLDEST with a loud mirror_overflow_dropped event', async () => {
    const events: JournalIntegrityEvent[] = [];
    let allow = false;
    const calls: JournalEntry[][] = [];
    const mirror: SessionStore = {
      appendBatch: async (_t, b) => { if (!allow) throw new Error('down'); calls.push(b); },
      load: async () => null, listTasks: async () => [],
    };
    const j = make('t-overflow', mirror, (e) => events.push(e));
    for (let i = 0; i < 5001; i++) await j.append(u());
    await j.flushMirror(); // fails → buffer (5001) exceeds cap → drop 1 oldest
    expect(events).toEqual([expect.objectContaining({ kind: 'mirror_overflow_dropped', count: 1 })]);
    allow = true;
    // Drain across turn boundaries (each flush caps at 2 windows = 400 rows).
    for (let i = 0; i < 13; i++) await j.flushMirror();
    const seqs = calls.flat().map((e) => e.seq);
    expect(seqs).toHaveLength(5000);
    expect(seqs[0]).toBe(1); // seq 0 was the dropped-oldest
    expect(seqs[seqs.length - 1]).toBe(5000);
  });
});
