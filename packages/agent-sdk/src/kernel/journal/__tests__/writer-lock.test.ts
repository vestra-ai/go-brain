/**
 * JOURNAL_ONE_WRITER_V1, across processes (writer-lock.ts): one writer per journal file.
 *
 * A second process (an old runner draining after a rotation, its successor taking the same task) is
 * waited for and refused while it lives and is not fenced; a crashed owner's lock is reclaimed; a
 * holder the server fenced (an older lease epoch) is reclaimed once its journal is quiet; and an
 * owner whose lock was taken is refused before it writes (the fence), so nothing is ever written
 * by two hands.
 *
 * Revert proofs: drop the liveness check and a live second process is reclaimed under; drop the
 * fence and a taken-over owner appends beside the new one; drop the dead-pid rule and a crashed
 * runner's lock blocks the task forever; drop the kernel boot rule and a lock that rode the
 * workspace pack onto a new box blocks the task whenever its pid is reused; drop the refusal memory
 * and every write of a failing turn waits again; drop the epoch rewrite and a lock taken lease-less
 * can never be fenced by a successor; rewrite it through the path instead of the handle and a
 * fenced owner clobbers its successor's lock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { JournalEntry } from '../../../contract/journal.js';
import { JsonlStore } from '../jsonl-store.js';
import {
  JournalWriterLock,
  JournalWriterBusyError,
  JournalFencedError,
  WRITER_LOCK_SUFFIX,
  kernelBootId,
  type WriterIdentity,
} from '../writer-lock.js';

let dir: string;
let journalPath: string;
const children: ChildProcess[] = [];

beforeEach(async () => {
  dir = join(tmpdir(), `writer-lock-${process.pid}-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  journalPath = join(dir, 'task.jsonl');
});
afterEach(async () => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  await fs.rm(dir, { recursive: true, force: true });
});

const me = (over: Partial<WriterIdentity> = {}): WriterIdentity => ({ pid: process.pid, holder: 'boot-a', ...over });

function lock(identity: () => WriterIdentity, over: Partial<ConstructorParameters<typeof JournalWriterLock>[0]> = {}): JournalWriterLock {
  return new JournalWriterLock({ journalPath, identity, waitMs: 60, pollMs: 10, heartbeatMs: 60_000, ...over });
}

/** Write a lock file the way another process would have (its own token and identity). */
async function foreignLock(rec: Partial<WriterIdentity> & { pid: number }): Promise<string> {
  const token = randomUUID();
  await fs.writeFile(`${journalPath}${WRITER_LOCK_SUFFIX}`, JSON.stringify({ holder: 'boot-other', ...rec, token, acquiredAt: new Date().toISOString() }));
  return token;
}

const lockRecord = async (path = `${journalPath}${WRITER_LOCK_SUFFIX}`): Promise<Record<string, unknown>> =>
  JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>;
const lockToken = async (): Promise<string | undefined> => (await lockRecord()).token as string | undefined;

/** A real second process that stays alive until killed. */
function liveProcess(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

const entry = (seq: number): JournalEntry => ({
  uuid: `u${seq}`, parentUuid: seq === 0 ? null : `u${seq - 1}`, seq, taskId: 't', rootTaskId: 't', spawnDepth: 0,
  workspaceId: 'w', agentId: 'g', principal: { kind: 'system' }, timestamp: 'T',
  payload: { type: 'system', event: 'x' },
} as unknown as JournalEntry);

describe('one writer per journal file, across processes', () => {
  it('the first writer takes the lock; a second writer is waited for and then refused while the first lives', async () => {
    const a = lock(() => me());
    await a.ensureHeld();
    const b = lock(() => me({ holder: 'boot-b' }));
    await expect(b.ensureHeld()).rejects.toBeInstanceOf(JournalWriterBusyError);
    await a.ensureHeld(); // still the owner
  });

  it('a second PROCESS holding the lock is refused while it is alive, and reclaimed once it has died', async () => {
    const child = liveProcess();
    await new Promise((r) => child.once('spawn', r));
    await foreignLock({ pid: child.pid! });
    const ours = lock(() => me());
    await expect(ours.ensureHeld()).rejects.toBeInstanceOf(JournalWriterBusyError);
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    await ours.ensureHeld();
    const rec = JSON.parse(await fs.readFile(`${journalPath}${WRITER_LOCK_SUFFIX}`, 'utf8')) as { pid: number };
    expect(rec.pid).toBe(process.pid);
  });

  it('a crashed owner\'s lock is reclaimed at once (its pid is gone)', async () => {
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((r) => dead.once('exit', r));
    const stale = await foreignLock({ pid: dead.pid! });
    const ours = lock(() => me());
    await ours.ensureHeld();
    expect(await lockToken()).not.toBe(stale);
  });

  it('a reused pid is not taken for the owner: a start time that no longer matches is stale', async () => {
    await foreignLock({ pid: process.pid, startTime: 'an-older-process' });
    const ours = lock(() => me({ holder: 'boot-b' }), { startTimeOf: () => 'this-process' });
    await ours.ensureHeld();
  });

  it('a holder the server fenced (older lease epoch) is reclaimed only once its journal has gone quiet', async () => {
    await fs.writeFile(journalPath, '');
    await foreignLock({ pid: process.pid, epoch: 3, holder: 'boot-old' });
    const ours = lock(() => me({ holder: 'boot-new', epoch: 4 }), { idleMs: 30_000 });
    // The journal was just written: the old runner may be mid-append, so it is waited for.
    await expect(ours.ensureHeld()).rejects.toBeInstanceOf(JournalWriterBusyError);
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(journalPath, past, past);
    await ours.ensureHeld();
  });

  it('a live holder on the SAME epoch is never reclaimed (the lease does not say it is gone)', async () => {
    await fs.writeFile(journalPath, '');
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(journalPath, past, past);
    await foreignLock({ pid: process.pid, epoch: 4 });
    const ours = lock(() => me({ holder: 'boot-b', epoch: 4 }));
    await expect(ours.ensureHeld()).rejects.toBeInstanceOf(JournalWriterBusyError);
  });

  it('an unreadable lock is a creation in progress while fresh, and stale once untouched', async () => {
    await fs.writeFile(`${journalPath}${WRITER_LOCK_SUFFIX}`, '');
    const ours = lock(() => me(), { staleMs: 60_000 });
    await expect(ours.ensureHeld()).rejects.toBeInstanceOf(JournalWriterBusyError);
    const past = new Date(Date.now() - 120_000);
    await fs.utimes(`${journalPath}${WRITER_LOCK_SUFFIX}`, past, past);
    await ours.ensureHeld();
  });

  it('the fence: an owner whose lock was taken over is refused before it writes, and the file gets nothing from it', async () => {
    const old = lock(() => me({ holder: 'boot-old' }));
    const store = new JsonlStore(journalPath, { writeGuard: old });
    await store.append(entry(0));
    // A successor takes the file over (the reclaim path makes a NEW lock file: a new inode).
    await fs.rename(`${journalPath}${WRITER_LOCK_SUFFIX}`, `${journalPath}${WRITER_LOCK_SUFFIX}.gone`);
    const successor = lock(() => me({ holder: 'boot-new' }));
    await successor.ensureHeld();
    await expect(store.append(entry(1))).rejects.toBeInstanceOf(JournalFencedError);
    const lines = (await fs.readFile(journalPath, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('a released writer refuses every later write; its lock file is removed for the next owner', async () => {
    const a = lock(() => me());
    const store = new JsonlStore(journalPath, { writeGuard: a });
    await store.append(entry(0));
    await a.release();
    await expect(fs.stat(`${journalPath}${WRITER_LOCK_SUFFIX}`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.append(entry(1))).rejects.toBeInstanceOf(JournalFencedError);
    const next = lock(() => me({ holder: 'boot-b' }));
    await next.ensureHeld();
  });

  it('a store without a guard writes exactly as before (flag off: no lock file at all)', async () => {
    const store = new JsonlStore(journalPath);
    await store.append(entry(0));
    await expect(fs.stat(`${journalPath}${WRITER_LOCK_SUFFIX}`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a lock written under another kernel boot is reclaimed though its pid is alive and its start time matches', async () => {
    // The lock rode the workspace pack onto a new box (an auto-upgrade): a fresh boot hands out the same
    // small pids, and a quick boot the same start ticks, so only the boot id tells them apart.
    const stale = await foreignLock({ pid: process.pid, startTime: 'tick-412', bootId: 'kernel-old' });
    const ours = lock(() => me({ holder: 'boot-b', bootId: 'kernel-new' }), { startTimeOf: () => 'tick-412' });
    await ours.ensureHeld();
    expect(await lockToken()).not.toBe(stale);
    expect((await lockRecord()).bootId).toBe('kernel-new');
  });

  it('under the SAME kernel boot (a thaw keeps it) a live holder is still waited for and refused', async () => {
    await foreignLock({ pid: process.pid, startTime: 'tick-412', bootId: 'kernel-1' });
    const ours = lock(() => me({ holder: 'boot-b', bootId: 'kernel-1' }), { startTimeOf: () => 'tick-412' });
    await expect(ours.ensureHeld()).rejects.toBeInstanceOf(JournalWriterBusyError);
  });

  it('kernelBootId reads this kernel boot (Linux) and is undefined where there is none', () => {
    const path = '/proc/sys/kernel/random/boot_id';
    expect(kernelBootId()).toBe(existsSync(path) ? readFileSync(path, 'utf8').trim() : undefined);
  });

  it('a refusal is paid once: the next write while the same holder keeps the file refuses at once, with no new wait', async () => {
    let t = Date.now();
    let waits = 0;
    const clock = { now: () => t, sleep: async (ms: number) => { t += ms; waits += 1; } };
    await foreignLock({ pid: process.pid });
    const ours = lock(() => me({ holder: 'boot-b' }), { waitMs: 15_000, pollMs: 250, busyHoldMs: 30_000, ...clock });

    await expect(ours.ensureHeld()).rejects.toBeInstanceOf(JournalWriterBusyError);
    expect(waits).toBe(60); // the first refusal waited the full 15 s
    waits = 0;
    await expect(ours.ensureHeld()).rejects.toBeInstanceOf(JournalWriterBusyError);
    await expect(ours.ensureHeld()).rejects.toBeInstanceOf(JournalWriterBusyError);
    expect(waits).toBe(0);

    // Each retry still looks: the holder lets go, and the next write takes the file at once.
    await fs.rm(`${journalPath}${WRITER_LOCK_SUFFIX}`);
    await ours.ensureHeld();
    expect(waits).toBe(0);
  });

  it('the refusal memory is for that holder and that window: a new holder, or a quiet spell, is waited for again', async () => {
    let t = Date.now();
    let waits = 0;
    const clock = { now: () => t, sleep: async (ms: number) => { t += ms; waits += 1; } };
    await foreignLock({ pid: process.pid });
    const ours = lock(() => me({ holder: 'boot-b' }), { waitMs: 1_000, pollMs: 250, busyHoldMs: 30_000, ...clock });
    await expect(ours.ensureHeld()).rejects.toBeInstanceOf(JournalWriterBusyError);
    waits = 0;
    await foreignLock({ pid: process.pid }); // another holder now
    await expect(ours.ensureHeld()).rejects.toBeInstanceOf(JournalWriterBusyError);
    expect(waits).toBe(4);
    waits = 0;
    t += 31_000; // the window has passed
    await expect(ours.ensureHeld()).rejects.toBeInstanceOf(JournalWriterBusyError);
    expect(waits).toBe(4);
  });

  it('a lock taken lease-less gains the runner epoch at its next heartbeat, so a successor can fence it', async () => {
    let epoch: number | undefined;
    const a = lock(() => me({ holder: 'boot-old', ...(epoch !== undefined ? { epoch } : {}) }));
    const store = new JsonlStore(journalPath, { writeGuard: a });
    await store.append(entry(0)); // before the runner held its lease
    expect((await lockRecord()).epoch).toBeUndefined();
    const token = await lockToken();

    epoch = 7; // the runner takes its lease
    a.touch();
    await vi.waitFor(async () => expect((await lockRecord()).epoch).toBe(7), { timeout: 2_000, interval: 10 });
    expect(await lockToken()).toBe(token); // rewritten in place: same owner, same lock

    // A successor at a higher epoch now fences the quiet holder (it could never have before).
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(journalPath, past, past);
    const successor = lock(() => me({ holder: 'boot-new', epoch: 8 }), { idleMs: 30_000 });
    await successor.ensureHeld();
    await expect(store.append(entry(1))).rejects.toBeInstanceOf(JournalFencedError);
  });

  it("the epoch rewrite goes through the owner's handle: a fenced owner never touches its successor's lock", async () => {
    let epoch: number | undefined;
    const old = lock(() => me({ holder: 'boot-old', ...(epoch !== undefined ? { epoch } : {}) }));
    await old.ensureHeld();
    // Taken over: the reclaim moved the old lock aside and created a new one at the path.
    const aside = `${journalPath}${WRITER_LOCK_SUFFIX}.gone`;
    await fs.rename(`${journalPath}${WRITER_LOCK_SUFFIX}`, aside);
    const successor = lock(() => me({ holder: 'boot-new', epoch: 9 }));
    await successor.ensureHeld();
    const theirs = await fs.readFile(`${journalPath}${WRITER_LOCK_SUFFIX}`, 'utf8');

    epoch = 4;
    old.touch();
    await vi.waitFor(async () => expect((await lockRecord(aside)).epoch).toBe(4), { timeout: 2_000, interval: 10 });
    expect(await fs.readFile(`${journalPath}${WRITER_LOCK_SUFFIX}`, 'utf8')).toBe(theirs);
  });
});
