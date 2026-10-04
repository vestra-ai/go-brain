/**
 * writer-lock.ts — ONE WRITER PER JOURNAL FILE, across processes (JOURNAL_ONE_WRITER_V1).
 *
 * The journal's single-writer invariant (seq and parentUuid assigned in memory, one tail chain)
 * holds only while ONE Journal object writes a file. Two can: a disposed actor's Journal still
 * finishing an interrupted run while the task's next actor opens a second one (the in-process
 * half, journal-registry.ts), or an old runner draining after a rotation while its successor
 * takes the same task on the same box (this file). Two appenders interleave whole records, and
 * the file forks: duplicate seqs, two children of one parent. Codex holds a writer lock per
 * rollout for the same reason (codex-rs/rollout/src/writer_lock.rs, an OS file lock).
 *
 * Node has no flock, so the lock is a lease file beside the journal (`<journal>.writer`),
 * created with O_EXCL and holding who owns it: pid, the process start time (Linux, so a reused
 * pid is not taken for the owner), the kernel's boot id, the runner's boot id and lease epoch, and
 * a random token. The owner keeps a handle on the file it created and, through THAT handle,
 * refreshes its mtime (a heartbeat) and records a lease epoch it gains after taking the lock.
 *
 * NEVER CORRUPTS. Every write the JSONL store makes (append, tail repair, hydrate write-through,
 * set-aside) first asks `ensureHeld()`, which also FENCES: a reclaim always makes a new file (a
 * new inode), so an owner whose lock was taken finds a stranger's inode and is refused before it
 * writes. A busy lock is waited for, then refused. Nothing ever writes without holding it.
 *
 * THE STALE-OWNER RULE, tied to the runner lease. A holder is reclaimed when
 *   - it wrote the lock under another kernel boot: the box was rebooted or replaced and the lock
 *     rode the workspace pack (a thaw keeps the boot id). Its pid and start time name nothing here,
 *     and a fresh boot hands out the same small pids again, so neither can be trusted, or
 *   - its process is gone (pid not alive), or its pid now names another process (start time), or
 *   - the server has fenced it: its lease epoch is older than ours, AND the journal has had no
 *     write for `idleMs` (so it is not mid-append; a straggler write later is refused by the fence),
 *   - or the record cannot be read and has not been touched for `staleMs` (a creation that died).
 * A live holder that is not fenced is never reclaimed: we wait `waitMs`, then refuse. A writer just
 * refused for that holder refuses again at once (no second wait) while the same holder keeps the
 * file, so a turn failing on a busy journal does not pay `waitMs` on every one of its writes.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

/** Who is writing, as the lock file records it. */
export interface WriterIdentity {
  pid: number;
  /** The runner's per-boot id (runner-lease getRunnerHolder). */
  holder: string;
  /** The runner's lease epoch, when it holds the lease (a successor's is higher). */
  epoch?: number;
  /** /proc/<pid>/stat start time (Linux): tells a reused pid from the owner. */
  startTime?: string;
  /** The kernel's boot id (Linux, kernelBootId): a pid and a start time mean nothing under another boot. */
  bootId?: string;
}

interface LockRecord extends WriterIdentity {
  token: string;
  acquiredAt: string;
}

/** Another writer owns the file and is alive and not fenced: refused after waiting. */
export class JournalWriterBusyError extends Error {
  readonly code = 'journal_writer_busy';
}

/** This writer no longer owns the file (taken over, or released): the write is refused. */
export class JournalFencedError extends Error {
  readonly code = 'journal_writer_fenced';
}

/** What the JSONL store asks before every write. */
export interface JournalWriteGuard {
  /** Resolves only when this writer owns the file right now; rejects otherwise. Never writes the journal. */
  ensureHeld(): Promise<void>;
  /** A write landed: refresh the heartbeat. Fire-and-forget. */
  touch(): void;
  /** Give the file up for good: later writes through this guard are refused. */
  release(): Promise<void>;
}

export interface WriterLockOptions {
  identity: () => WriterIdentity;
  /** The journal file the lock guards: its mtime says whether a holder is mid-write. */
  journalPath: string;
  /** How long a would-be writer waits for a live holder before refusing. */
  waitMs?: number;
  pollMs?: number;
  /** Heartbeat cadence while held. */
  heartbeatMs?: number;
  /** An unreadable lock untouched this long is a creation that died. */
  staleMs?: number;
  /** A fenced holder is reclaimed only once the journal has been quiet this long. */
  idleMs?: number;
  /** After a refusal, how long a retry refuses at once (no new wait) while the same holder keeps the file. */
  busyHoldMs?: number;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  startTimeOf?: (pid: number) => string | undefined;
  sleep?: (ms: number) => Promise<void>;
}

export const WRITER_LOCK_SUFFIX = '.writer';

/** Is `pid` a live process? EPERM is alive (someone else's). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: unknown }).code === 'EPERM';
  }
}

/** Linux: field 22 of /proc/<pid>/stat (after the parenthesised command name). Elsewhere undefined. */
export function procStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch {
    return undefined;
  }
}

/** Linux: this kernel boot's id. A thaw keeps it; a reboot or a new box does not. Elsewhere undefined. */
export function kernelBootId(): string | undefined {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

const code = (err: unknown): unknown => (err as { code?: unknown }).code;

function parseRecord(text: string): LockRecord | null {
  try {
    const rec = JSON.parse(text) as LockRecord;
    return typeof rec?.token === 'string' && typeof rec.pid === 'number' ? rec : null;
  } catch {
    return null;
  }
}

export class JournalWriterLock implements JournalWriteGuard {
  readonly lockPath: string;
  private readonly token = randomUUID();
  /** While held: the lock file's inode (the fence), a handle on THAT inode, and what the file says. */
  private held: { ino: number; fh: FileHandle; rec: LockRecord } | null = null;
  private acquiring: Promise<void> | undefined;
  private released = false;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  /** The last refusal: the holder it named, and until when a retry refuses at once. */
  private busy: { token: string | null; until: number } | undefined;
  /** Everything done through the handle (heartbeat, epoch, close), one at a time. */
  private io: Promise<void> = Promise.resolve();

  constructor(private readonly opts: WriterLockOptions) {
    this.lockPath = `${opts.journalPath}${WRITER_LOCK_SUFFIX}`;
  }

  async ensureHeld(): Promise<void> {
    if (this.released) throw new JournalFencedError(`journal writer released: ${this.lockPath}`);
    const held = this.held;
    if (!held) {
      await (this.acquiring ??= this.acquire().finally(() => { this.acquiring = undefined; }));
      return;
    }
    // The fence: a reclaim always makes a new file, so the same inode is still ours.
    let ino: number;
    try {
      ino = (await fs.stat(this.lockPath)).ino;
    } catch (err) {
      if (code(err) !== 'ENOENT') throw err;
      this.lose();
      throw new JournalFencedError(`journal writer lock removed under its owner: ${this.lockPath}`);
    }
    if (ino === held.ino) return;
    const rec = await this.readRecord();
    if (rec?.token === this.token && (await this.adoptOwn())) return;
    this.lose();
    throw new JournalFencedError(`journal writer lock taken over (now ${describe(rec)}): ${this.lockPath}`);
  }

  touch(): void {
    if (!this.held || this.released) return;
    void this.enqueue(() => this.beat());
  }

  async release(): Promise<void> {
    this.released = true;
    this.stopHeartbeat();
    const held = this.held;
    if (!held) return;
    this.held = null;
    await this.enqueue(() => held.fh.close());
    const rec = await this.readRecord();
    if (rec?.token === this.token) await fs.rm(this.lockPath, { force: true }).catch(() => {});
  }

  /**
   * The heartbeat, through our handle: it can only ever touch the file WE created, never a
   * reclaimer's new lock at the same path. A lock taken lease-less (a write before the runner held
   * its lease) records no epoch, so no successor could ever fence it by the lease: it gains the
   * runner's epoch here, rewritten in place (same inode, same token).
   */
  private async beat(): Promise<void> {
    const held = this.held;
    if (!held || this.released) return;
    const id = this.opts.identity();
    if (id.epoch !== undefined && id.epoch !== held.rec.epoch) {
      const rec: LockRecord = { ...id, token: this.token, acquiredAt: held.rec.acquiredAt };
      const body = Buffer.from(JSON.stringify(rec), 'utf8');
      await held.fh.write(body, 0, body.length, 0);
      await held.fh.truncate(body.length);
      await held.fh.sync();
      held.rec = rec;
      return;
    }
    const t = new Date((this.opts.now ?? Date.now)());
    await held.fh.utimes(t, t);
  }

  private enqueue(job: () => Promise<unknown>): Promise<void> {
    this.io = this.io.then(job).then(() => undefined, () => undefined);
    return this.io;
  }

  private hold(fh: FileHandle, rec: LockRecord, ino: number): void {
    const prev = this.held;
    this.held = { ino, fh, rec };
    if (prev && prev.fh !== fh) void this.enqueue(() => prev.fh.close());
    this.busy = undefined;
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => this.touch(), this.opts.heartbeatMs ?? 15_000);
      this.heartbeat.unref?.();
    }
  }

  private lose(): void {
    const held = this.held;
    this.held = null;
    this.stopHeartbeat();
    if (held) void this.enqueue(() => held.fh.close());
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private async acquire(): Promise<void> {
    const now = this.opts.now ?? Date.now;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = now() + (this.opts.waitMs ?? 15_000);
    for (;;) {
      if (await this.createExclusive()) return;
      const rec = await this.readRecord();
      if (rec?.token === this.token && (await this.adoptOwn())) return;
      if (await this.isStale(rec)) {
        // The moved-aside lock is removed only AFTER our create: while it exists its inode cannot be
        // reused for ours, so the fenced owner's inode check can never mistake our lock for its own.
        const aside = await this.reclaim(rec);
        try {
          if (await this.createExclusive()) return;
        } finally {
          if (aside) await fs.rm(aside, { force: true }).catch(() => {});
        }
        continue;
      }
      if (now() >= deadline || this.refusedJustNow(rec, now())) {
        this.busy = { token: rec?.token ?? null, until: now() + (this.opts.busyHoldMs ?? 30_000) };
        throw new JournalWriterBusyError(`journal ${this.opts.journalPath} has an active writer (${describe(rec)})`);
      }
      await sleep(this.opts.pollMs ?? 250);
    }
  }

  /** We refused for this same holder moments ago: the wait was paid, so refuse again without one. */
  private refusedJustNow(rec: LockRecord | null, at: number): boolean {
    return this.busy !== undefined && at < this.busy.until && this.busy.token === (rec?.token ?? null);
  }

  /** O_EXCL create with our record. False when a lock is already there. */
  private async createExclusive(): Promise<boolean> {
    let fh: FileHandle;
    try {
      fh = await fs.open(this.lockPath, 'wx');
    } catch (err) {
      if (code(err) === 'EEXIST') return false;
      throw err;
    }
    try {
      const rec: LockRecord = { ...this.opts.identity(), token: this.token, acquiredAt: new Date((this.opts.now ?? Date.now)()).toISOString() };
      await fh.write(JSON.stringify(rec), null, 'utf8');
      await fh.sync();
      this.hold(fh, rec, (await fh.stat()).ino);
    } catch (err) {
      // The file is ours (we just created it) and says nothing yet: take it back out.
      await fh.close().catch(() => {});
      await fs.rm(this.lockPath, { force: true }).catch(() => {});
      throw err;
    }
    return true;
  }

  /** The file at the path carries our token on another inode (a restored copy): hold it through a handle on IT. */
  private async adoptOwn(): Promise<boolean> {
    let fh: FileHandle;
    try {
      fh = await fs.open(this.lockPath, 'r+');
    } catch {
      return false;
    }
    try {
      const rec = parseRecord(await fh.readFile('utf8'));
      if (rec?.token === this.token) {
        this.hold(fh, rec, (await fh.stat()).ino);
        return true;
      }
    } catch {
      // unreadable: not provably ours
    }
    await fh.close().catch(() => {});
    return false;
  }

  private async readRecord(): Promise<LockRecord | null> {
    try {
      return parseRecord(await fs.readFile(this.lockPath, 'utf8'));
    } catch {
      return null;
    }
  }

  private async mtimeOf(path: string): Promise<number | null> {
    try {
      return (await fs.stat(path)).mtimeMs;
    } catch {
      return null;
    }
  }

  private async isStale(rec: LockRecord | null): Promise<boolean> {
    const now = (this.opts.now ?? Date.now)();
    if (!rec) {
      // A creation that died between O_EXCL and its write, or damage: stale once untouched long enough.
      const m = await this.mtimeOf(this.lockPath);
      return m === null || now - m > (this.opts.staleMs ?? 60_000);
    }
    const mine = this.opts.identity();
    // Written under another kernel boot: whatever its pid names now, it is not the writer.
    if (rec.bootId !== undefined && mine.bootId !== undefined && rec.bootId !== mine.bootId) return true;
    const isAlive = this.opts.isAlive ?? pidAlive;
    if (!isAlive(rec.pid)) return true;
    const startTimeOf = this.opts.startTimeOf ?? procStartTime;
    const live = startTimeOf(rec.pid);
    if (rec.startTime !== undefined && live !== undefined && live !== rec.startTime) return true;
    // Fenced by the lease: the server gave a successor a higher epoch. Only once the journal is quiet,
    // so the holder is not mid-append; a straggler write after this is refused by its own fence.
    if (rec.epoch !== undefined && mine.epoch !== undefined && rec.epoch < mine.epoch) {
      const lastWrite = await this.mtimeOf(this.opts.journalPath);
      return lastWrite === null || now - lastWrite >= (this.opts.idleMs ?? 30_000);
    }
    return false;
  }

  /**
   * Move the stale lock aside (rename: exactly one reclaimer wins it) and check we moved the lock we
   * judged; a fresh one created in between is put back. Then the caller's O_EXCL create decides, and
   * removes the aside copy (returned) after it.
   */
  private async reclaim(judged: LockRecord | null): Promise<string | null> {
    const aside = `${this.lockPath}.stale-${randomUUID()}`;
    try {
      await fs.rename(this.lockPath, aside);
    } catch (err) {
      if (code(err) === 'ENOENT') return null; // someone else reclaimed it first
      throw err;
    }
    let moved: LockRecord | null = null;
    try {
      moved = JSON.parse(await fs.readFile(aside, 'utf8')) as LockRecord;
    } catch {
      moved = null;
    }
    if ((moved?.token ?? null) !== (judged?.token ?? null)) {
      // We took a lock someone created after our judgement: give it back (same inode) if the slot is still empty.
      await fs.link(aside, this.lockPath).catch(() => {});
    }
    return aside;
  }
}

function describe(rec: LockRecord | null): string {
  if (!rec) return 'an unreadable lock';
  return `pid ${rec.pid}, runner ${rec.holder}${rec.epoch !== undefined ? `, lease epoch ${rec.epoch}` : ''}`;
}
