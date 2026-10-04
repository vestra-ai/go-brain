/**
 * JOURNAL_ONE_WRITER_V1, in one process (journal-registry.ts): one live Journal per file.
 *
 * The root cause it closes (found while mapping every appender): forceCleanup interrupts a run
 * without waiting and drops the task's actor at once, so the interrupted run's last writes still go
 * through the OLD Journal, while the task's next actor opens a NEW Journal over the same file. R5
 * (#4157) made the new one wait for the old one's tail as it was at disposal; a write after that
 * ran on a second tail chain, and the file forked (two entries with one seq, two children of one
 * parent). The first test reproduces that fork with two Journals; the rest pin that the registry
 * hands both writers the same instance, and refuses a write through an instance it has dropped.
 *
 * Revert proof: build a second Journal in `open` and the shared-instance case forks exactly like
 * the reproduction.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { JournalPayload, NewEntry } from '../../../contract/journal.js';
import { Journal } from '../journal.js';
import { JsonlStore } from '../jsonl-store.js';
import { InMemorySessionStore } from '../session-store.js';
import { systemClock } from '../clock.js';
import { JournalRegistry } from '../journal-registry.js';
import { JournalWriterLock, JournalFencedError, type JournalWriteGuard } from '../writer-lock.js';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = join(tmpdir(), `journal-registry-${process.pid}-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  path = join(dir, 't.jsonl');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const base = {
  taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g',
  principal: { kind: 'system' as const }, timestamp: '',
};
const note = (text: string): NewEntry => ({ ...base, payload: { type: 'user', blocks: [{ type: 'text', text } as never] } as JournalPayload });

function journalOver(writeGuard?: JournalWriteGuard, after?: Promise<unknown>): Journal {
  return new Journal({
    taskId: 't', workspaceId: 'w', after,
    jsonl: new JsonlStore(path, writeGuard ? { writeGuard } : {}),
    mirror: new InMemorySessionStore(),
    clock: systemClock(), // unique uuids per instance, as in the runner
  });
}

async function onDisk(): Promise<Array<{ seq: number; uuid: string; parentUuid: string | null }>> {
  const text = await fs.readFile(path, 'utf8');
  return text.trim().split('\n').map((l) => JSON.parse(l) as { seq: number; uuid: string; parentUuid: string | null });
}

/** One chain: seqs 0..n-1 in order, each entry the child of the one before. */
function isOneChain(rows: Array<{ seq: number; uuid: string; parentUuid: string | null }>): boolean {
  return rows.every((r, i) => r.seq === i && r.parentUuid === (i === 0 ? null : rows[i - 1].uuid));
}

const registry = (drainMs = 20) =>
  new JournalRegistry<Journal>({
    makeGuard: (p) => new JournalWriterLock({ journalPath: p, identity: () => ({ pid: process.pid, holder: 'boot' }), waitMs: 50, pollMs: 10, heartbeatMs: 60_000 }),
    drainMs,
  });

describe('one live Journal per file in a process', () => {
  it('the root cause: two Journals over one file (an unwinding run and the next actor) fork it', async () => {
    const old = journalOver();
    await old.append(note('the turn'));
    const next = journalOver(undefined, old.settled()); // R5: waits for the old tail AS IT WAS
    await next.append(note('the next message'));
    await old.append(note('the interrupted run\'s late abort seal'));
    const rows = await onDisk();
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 1]); // two entries with one seq
    expect(isOneChain(rows)).toBe(false);
  });

  it('with the registry, the unwinding run and the next actor write through ONE instance: one chain', async () => {
    const r = registry();
    const old = r.open(path, (g) => journalOver(g));
    await old.append(note('the turn'));
    r.release(path, old); // forceCleanup disposes the actor; the run is still unwinding
    const next = r.open(path, (g) => journalOver(g));
    expect(next).toBe(old);
    await next.append(note('the next message'));
    await old.append(note('the interrupted run\'s late abort seal'));
    expect(isOneChain(await onDisk())).toBe(true);
    await r.closeAll();
  });

  it('a released journal is dropped once it settles and drains, and its lock is released', async () => {
    const r = registry(10);
    const j = r.open(path, (g) => journalOver(g));
    await j.append(note('a'));
    expect(await fs.stat(`${path}.writer`).then(() => true)).toBe(true);
    r.release(path, j);
    await new Promise((res) => setTimeout(res, 60));
    expect(r.has(path)).toBe(false);
    await expect(fs.stat(`${path}.writer`)).rejects.toMatchObject({ code: 'ENOENT' });
    // The next actor gets a fresh instance that reads the file back and continues the chain.
    const fresh = r.open(path, (g) => journalOver(g));
    expect(fresh).not.toBe(j);
    await fresh.append(note('b'));
    expect(isOneChain(await onDisk())).toBe(true);
    await r.closeAll();
  });

  it('a write that still arrives through a dropped instance is refused, never written beside the next one', async () => {
    const r = registry(10);
    const old = r.open(path, (g) => journalOver(g));
    await old.append(note('a'));
    r.release(path, old);
    await new Promise((res) => setTimeout(res, 60));
    const next = r.open(path, (g) => journalOver(g));
    await next.append(note('b'));
    await expect(old.append(note('a straggler'))).rejects.toBeInstanceOf(JournalFencedError);
    const rows = await onDisk();
    expect(rows).toHaveLength(2);
    expect(isOneChain(rows)).toBe(true);
    await r.closeAll();
  });

  it('a re-open inside the drain keeps the same instance and cancels the drop', async () => {
    const r = registry(10);
    const j = r.open(path, (g) => journalOver(g));
    r.release(path, j);
    expect(r.open(path, (g) => journalOver(g))).toBe(j);
    await new Promise((res) => setTimeout(res, 60));
    expect(r.has(path)).toBe(true);
    await r.closeAll();
  });

  it('two owners at once share it; it drains only after BOTH release', async () => {
    const r = registry(10);
    const a = r.open(path, (g) => journalOver(g));
    const b = r.open(path, (g) => journalOver(g));
    expect(b).toBe(a);
    r.release(path, a);
    await new Promise((res) => setTimeout(res, 40));
    expect(r.has(path)).toBe(true);
    r.release(path, b);
    await new Promise((res) => setTimeout(res, 60));
    expect(r.has(path)).toBe(false);
  });
});
