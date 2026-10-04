/**
 * The kernel journal's local file: one newline-terminated JSON record per entry, append-only.
 *
 * CRASH-SAFE APPEND (harness to nine, R5). What a reader may rely on, and why it holds:
 *
 *  - A record is COMMITTED when its terminating newline is in the file. JSON.stringify never
 *    writes a raw newline, and no proper prefix of a stringified object parses (its closing
 *    brace is its last byte), so a write cut short by a kill or a full disk leaves at most ONE
 *    partial line, at the tail, that can never be taken for a record.
 *  - The writer never writes after a partial record. Before its first append (Journal's hydrate
 *    asks for it first, so a load sets the tail aside too), and again after any append that
 *    failed, `repairTail` reads the last line: a complete record that lost only its newline is
 *    sealed (the newline is added); a line that does not parse (a torn write, NULs a power cut
 *    left, damage) is copied to the `<path>.corrupt` sidecar (its exact bytes too, base64, when
 *    it ends inside a character), the sidecar is fsync'd, and only then is the line cut from the
 *    file, and only if the file has not grown meanwhile. Nothing leaves the file that is not
 *    first kept aside; a kill during a repair at worst records the same bytes in the sidecar twice.
 *  - Readers never repair (a concurrent reader would see an append in flight as a torn tail):
 *    read() skips a partial final line and quarantines bad lines anywhere else.
 *
 * FSYNC POLICY. An append is one appendFile on an O_APPEND descriptor and is NOT fsync'd: the
 * kernel owns the bytes once the write returns, so every acknowledged entry survives a process
 * death (kill -9, OOM, a runner restart). A kernel or VM crash can lose what the page cache had
 * not written back yet (Linux writes dirty pages back within about 30 s) since the last barrier;
 * the off-box mirror, flushed at every turn boundary, keeps a copy of those entries. The barriers
 * that fsync: the abort seal (Journal.fsync: the file and its directory), a hydration
 * write-through (replaceWith: temp file synced, renamed, directory synced), and a tail repair
 * (the sidecar synced before the cut, the journal synced after it). An fsync per append was
 * rejected: a disk flush on every entry of the hot path, for a crash class the mirror covers.
 */
import { createReadStream, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import type { JournalEntry } from '../../contract/journal.js';
import { CURRENT_JOURNAL_VERSION, migrateEntry, validateJournalEntry } from './validate-entry.js';
import type { JournalWriteGuard } from './writer-lock.js';

/**
 * P2.0 — why a line was quarantined instead of yielded. R5: `torn` is a last line with no
 * newline that does not parse (a write cut short), set aside by repairTail.
 */
export interface JsonlBadLineInfo {
  line: string;
  lineNo: number;
  reason: 'parse' | 'shape' | 'version' | 'torn';
  errors?: string[];
}

/** The suffix of a hydration in progress (replaceWith). The tidy sweeper names the same one. */
export const HYDRATING_SUFFIX = '.hydrating';
/** replaceWith writes in chunks of about this many characters. */
const REPLACE_CHUNK_CHARS = 1 << 20;

/** The local source of truth: one newline-delimited JSON file per task. */
export class JsonlStore {
  /** Warn-once-per-file-per-reason (the old `warnedTorn` discipline, per reason). */
  private readonly warnedReasons = new Set<JsonlBadLineInfo['reason']>();
  private warnedTorn = false;
  /**
   * P2.0 review fix — quarantine idempotency. project() re-reads the whole file
   * every round (and a degraded anchor-loss projection is deliberately uncached),
   * so without dedup the sidecar grows by bad-lines × reads and onBadLine
   * re-fires each pass. The file is append-only, so lineNo is a stable identity
   * for a physical line; dedup per store instance on (lineNo, reason), gating
   * BOTH the sidecar append AND the callback.
   */
  private readonly quarantinedLines = new Set<string>();
  private readonly badLineListeners: Array<(info: JsonlBadLineInfo) => void> = [];
  /**
   * R5 — the tail check this store has done (or is doing): resolved once the file is known to
   * end on a record boundary. Forgotten when it fails and after any append that fails, so the
   * next append looks at the tail again (a short write may have left a partial line).
   */
  private tailRepair: Promise<void> | undefined;
  /**
   * JOURNAL_ONE_WRITER_V1 (writer-lock.ts): asked before EVERY write this store makes, so a writer
   * that does not own the file (another process, a superseded Journal) is refused before it writes.
   * Absent: no lock, byte-identical.
   */
  private readonly writeGuard: JournalWriteGuard | undefined;

  constructor(
    private readonly path: string,
    opts: { onBadLine?: (info: JsonlBadLineInfo) => void; writeGuard?: JournalWriteGuard } = {},
  ) {
    if (opts.onBadLine) this.badLineListeners.push(opts.onBadLine);
    this.writeGuard = opts.writeGuard;
  }

  /** P2.0 — subscribe to quarantine reports (Journal wires its integrity channel here). */
  onBadLine(listener: (info: JsonlBadLineInfo) => void): void {
    this.badLineListeners.push(listener);
  }

  /**
   * O(1) sequential append — the fastest durable write pattern. R5: never onto a partial line
   * (repairTail first, once per store), and a failed write makes the next append check again.
   */
  async append(entry: JournalEntry): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true });
    await this.repairTail();
    await this.writeGuard?.ensureHeld();
    try {
      await fs.appendFile(this.path, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
      this.tailRepair = undefined; // a short write (ENOSPC, EIO) may have left a partial line
      throw err;
    }
    this.writeGuard?.touch();
  }

  /**
   * R5 — make the file end on a record boundary before anything is written after it. Shared by
   * concurrent callers; a failure is forgotten so the next call retries. Called by the writer
   * only (Journal's hydrate, and append): a reader must never cut what may be an append in flight.
   */
  repairTail(): Promise<void> {
    return (this.tailRepair ??= this.doRepairTail().catch((err: unknown) => {
      this.tailRepair = undefined;
      throw err;
    }));
  }

  private async doRepairTail(): Promise<void> {
    let fh: FileHandle;
    try {
      fh = await fs.open(this.path, 'r+');
    } catch (err) {
      if ((err as { code?: unknown }).code === 'ENOENT') return; // no file yet: nothing to repair
      throw err;
    }
    try {
      const size = (await fh.stat()).size;
      if (size === 0) return;
      const terminated = (await readBytes(fh, size - 1, 1))[0] === NEWLINE;
      const end = terminated ? size - 1 : size;
      const start = (await lastNewlineBefore(fh, end)) + 1;
      const bytes = await readBytes(fh, start, end - start);
      const line = bytes.toString('utf8');
      if (!line.trim() || parses(line)) {
        // A whole record (or a blank) that lost only its newline is sealed, never cut.
        if (!terminated) {
          await this.writeGuard?.ensureHeld();
          await fh.write('\n', size, 'utf8');
        }
        return;
      }
      await this.writeGuard?.ensureHeld();
      const lineNo = (await countNewlines(fh, start)) + 1;
      const reason: JsonlBadLineInfo['reason'] = terminated ? 'parse' : 'torn';
      // Kept aside FIRST, durably: if the sidecar cannot be written the line stays in the file
      // (and the append that asked fails), because a cut that was not kept would be a deletion.
      // A write cut inside a multi-byte character decodes to U+FFFD: the exact bytes ride beside it.
      const exact = line.includes('\uFFFD') ? { bytesBase64: bytes.toString('base64') } : {};
      await appendDurably(`${this.path}.corrupt`, JSON.stringify({ lineNo, reason, line, ...exact }) + '\n');
      // The line may be another writer's append still landing (a disposed actor's Journal, before
      // its tail settled): if the file moved since it was read, cut nothing; the next append looks
      // again. The copy just kept is then a harmless extra.
      if ((await fh.stat()).size !== size) {
        this.tailRepair = undefined;
        return;
      }
      await fh.truncate(start);
      await fh.sync();
      console.warn(`[JsonlStore] set aside a ${reason} last line (line ${lineNo}) of ${this.path} → .corrupt sidecar`);
      const info: JsonlBadLineInfo = { line, lineNo, reason };
      for (const listener of this.badLineListeners) listener(info);
    } finally {
      await fh.close().catch(() => {});
    }
  }

  /**
   * Write `entries` as this file's WHOLE content, all or nothing: into `<path>.hydrating`,
   * fsync'd, then renamed into place. A write that dies part-way (ENOSPC, EIO, a kill) leaves
   * NO `<path>` — never a prefix that a later read takes for the whole journal (a non-empty
   * file skips the mirror, and its next appends would collide with the seqs the mirror holds).
   * A leftover `.hydrating` from an earlier death is truncated here and never read; the tidy
   * sweeper removes a stale one. A failure here removes it and rethrows.
   */
  async replaceWith(entries: JournalEntry[]): Promise<void> {
    const tmp = `${this.path}${HYDRATING_SUFFIX}`;
    await fs.mkdir(dirname(this.path), { recursive: true });
    await this.writeGuard?.ensureHeld();
    let fh: import('node:fs/promises').FileHandle | undefined;
    try {
      fh = await fs.open(tmp, 'w');
      let chunk = '';
      for (const entry of entries) {
        chunk += JSON.stringify(entry) + '\n';
        if (chunk.length >= REPLACE_CHUNK_CHARS) {
          await fh.write(chunk, null, 'utf8');
          chunk = '';
        }
      }
      if (chunk) await fh.write(chunk, null, 'utf8');
      await fh.sync();
      await fh.close();
      fh = undefined;
      await fs.rename(tmp, this.path);
    } catch (err) {
      await fh?.close().catch(() => {});
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    this.tailRepair = Promise.resolve(); // R5: every line of the file is one this call wrote whole
    await this.fsync(); // the rename's directory entry
  }

  /**
   * Continue anywhere (spec §6.1): move this journal's file aside so a hydrate can write the mirror's
   * copy in its place, and answer where it went (null: there was no file). A copy not put back is
   * never overwritten: it takes the first free name of `<path><suffix>`, `.1`, `.2`, and only when
   * all three are taken, the oldest of them (by mtime). Set-aside copies are forensic, read back only
   * by undoSetAside. What this store knew of the old file goes with it (reopen). The `<path>.corrupt`
   * sidecar stays where it is, so the line numbers it names are the OLD file's (now the set-aside copy's).
   */
  async setAside(suffix: string): Promise<string | null> {
    await this.writeGuard?.ensureHeld();
    const names = [`${this.path}${suffix}`, `${this.path}${suffix}.1`, `${this.path}${suffix}.2`];
    const ages = await Promise.all(names.map((name) => fs.stat(name).then((st) => st.mtimeMs, (err: unknown) => {
      if ((err as { code?: unknown }).code === 'ENOENT') return null;
      throw err;
    })));
    const free = ages.indexOf(null);
    const to = names[free !== -1 ? free : ages.indexOf(Math.min(...(ages as number[])))];
    try {
      await fs.rename(this.path, to);
    } catch (err) {
      if ((err as { code?: unknown }).code !== 'ENOENT') throw err;
      this.reopen();
      return null;
    }
    this.reopen();
    return to;
  }

  /**
   * Put back what setAside did (`aside` is its answer): that copy returns to `<path>` byte for byte,
   * over whatever was written there since; when nothing was set aside, what was written is removed.
   */
  async undoSetAside(aside: string | null): Promise<void> {
    await this.writeGuard?.ensureHeld();
    if (aside) await fs.rename(aside, this.path);
    else await fs.rm(this.path, { force: true });
    this.reopen();
    await this.fsync(); // the rename's directory entry
  }

  /** A different file may be at `path` now (set aside, put back, written from outside): its tail is
   *  checked again before an append (R5), and its line numbers name its own lines. */
  reopen(): void {
    this.tailRepair = undefined;
    this.quarantinedLines.clear();
  }

  /** Force the appended bytes (and the dir entry) to disk — the abort-seal
   *  durability barrier. Modeled on query-manager's fsyncSessionFile recipe.
   *  No-op when the file does not exist yet; best-effort (never throws). */
  async fsync(): Promise<void> {
    try {
      await fs.access(this.path);
    } catch {
      return; // nothing written yet
    }
    let fh: import('node:fs/promises').FileHandle | undefined;
    let dirFh: import('node:fs/promises').FileHandle | undefined;
    try {
      fh = await fs.open(this.path, 'r');
      await fh.sync();
      dirFh = await fs.open(dirname(this.path), 'r');
      await dirFh.sync();
    } catch (err) {
      console.warn(`[JsonlStore] fsync failed for ${this.path}: ${String(err)}`);
    } finally {
      await fh?.close().catch(() => {});
      await dirFh?.close().catch(() => {});
    }
  }

  /** P2.6 — the file's mtime in ms, or null if it does not exist yet. Lets the
   *  Journal's in-memory read-model cheaply detect an EXTERNAL mutation (nothing
   *  writes this file out-of-band in prod) and re-read through read()'s quarantine
   *  pipeline. Best-effort: any stat error → null. */
  async mtimeMs(): Promise<number | null> {
    try {
      return (await fs.stat(this.path)).mtimeMs;
    } catch {
      return null;
    }
  }

  /** Stream entries in append order at constant memory (never loads the whole file). */
  async *read(): AsyncIterable<JournalEntry> {
    try {
      await fs.access(this.path);
    } catch {
      return; // no file yet → empty, no error
    }
    const rl = createInterface({
      input: createReadStream(this.path, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    try {
      let lineNo = 0;
      // A parse failure is only CORRUPTION if a non-empty line follows it; on the
      // final line it is a torn tail (normal crash-mid-append residue) and keeps
      // the legacy warn-once-skip with NO sidecar record. Defer the verdict until
      // we see what follows.
      let pendingTorn: { line: string; lineNo: number } | null = null;
      for await (const line of rl) {
        lineNo++;
        if (!line.trim()) continue;
        if (pendingTorn) {
          await this.quarantine(pendingTorn.line, pendingTorn.lineNo, 'parse');
          pendingTorn = null;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          pendingTorn = { line, lineNo };
          continue;
        }
        const v = validateJournalEntry(parsed);
        if (!v.ok) {
          // Distinguish a FUTURE-version line (downgrade safety) from a wrong-shape
          // line structurally — never by matching the error strings.
          const reason = isFutureVersion(parsed) ? 'version' : 'shape';
          await this.quarantine(line, lineNo, reason, v.errors);
          continue;
        }
        yield migrateEntry(v.entry);
      }
      if (pendingTorn && !this.warnedTorn) {
        this.warnedTorn = true;
        console.warn(`[JsonlStore] skipping torn final JSONL line in ${this.path}`);
      }
    } finally {
      rl.close();
    }
  }

  /**
   * R2 (JOURNAL_CHECKPOINT_V1) — read BACKWARDS from the end until `stop` accepts an entry, so a
   * rebuild from a checkpoint never touches the bytes before it. Answers that entry (null when
   * the file holds none: `entries` is then the whole file), every entry after it in file order,
   * and how many lines it parsed. Null when any line it reaches does not parse or validate: the
   * caller reads forwards instead, where read() quarantines it with its line number. Never writes.
   */
  async readBack(
    stop: (e: JournalEntry) => boolean,
  ): Promise<{ stopped: JournalEntry | null; entries: JournalEntry[]; linesRead: number } | null> {
    let fh: FileHandle;
    try {
      fh = await fs.open(this.path, 'r');
    } catch (err) {
      if ((err as { code?: unknown }).code === 'ENOENT') return { stopped: null, entries: [], linesRead: 0 };
      throw err;
    }
    const after: JournalEntry[] = []; // newest first
    let linesRead = 0;
    let stopped: JournalEntry | null = null;
    /** One whole line: 'go' on (blank, or an entry kept), 'stop' at the stop entry, 'bad' to give up. */
    const take = (bytes: Buffer): 'go' | 'stop' | 'bad' => {
      const line = bytes.toString('utf8');
      if (!line.trim()) return 'go';
      linesRead++;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return 'bad';
      }
      const v = validateJournalEntry(parsed);
      if (!v.ok) return 'bad';
      const entry = migrateEntry(v.entry);
      if (stop(entry)) {
        stopped = entry;
        return 'stop';
      }
      after.push(entry);
      return 'go';
    };
    try {
      let parts: Buffer[] = []; // the start of the file's next line, already read (file order)
      for (let pos = (await fh.stat()).size; pos > 0; ) {
        const len = Math.min(READ_BACK_CHUNK, pos);
        pos -= len;
        const chunk = await readBytes(fh, pos, len);
        let end = chunk.length;
        for (let nl = chunk.lastIndexOf(NEWLINE, end - 1); nl !== -1; nl = nl > 0 ? chunk.lastIndexOf(NEWLINE, nl - 1) : -1) {
          const verdict = take(Buffer.concat([chunk.subarray(nl + 1, end), ...parts]));
          if (verdict === 'bad') return null;
          if (verdict === 'stop') return { stopped, entries: after.reverse(), linesRead };
          parts = [];
          end = nl;
        }
        parts.unshift(chunk.subarray(0, end));
      }
      const verdict = take(Buffer.concat(parts)); // the first line of the file
      if (verdict === 'bad') return null;
      return { stopped, entries: after.reverse(), linesRead };
    } finally {
      await fh.close().catch(() => {});
    }
  }

  /**
   * P2.0 — route a bad line to the `<path>.corrupt` sidecar (append-only, one JSON
   * object per line) instead of silently dropping it, so mirror recovery / forensics
   * can restore or inspect it later. Best-effort: a quarantine failure must never
   * break replay. Warns loudly once per file per reason.
   */
  private async quarantine(
    line: string,
    lineNo: number,
    reason: JsonlBadLineInfo['reason'],
    errors?: string[],
  ): Promise<void> {
    const dedupKey = `${lineNo}:${reason}`;
    if (this.quarantinedLines.has(dedupKey)) return; // already sidecar'd + reported
    this.quarantinedLines.add(dedupKey);
    if (!this.warnedReasons.has(reason)) {
      this.warnedReasons.add(reason);
      console.warn(`[JsonlStore] quarantining ${reason}-invalid JSONL line ${lineNo} in ${this.path} → .corrupt sidecar`);
    }
    try {
      await fs.appendFile(
        `${this.path}.corrupt`,
        JSON.stringify({ lineNo, reason, ...(errors ? { errors } : {}), line }) + '\n',
        'utf8',
      );
    } catch {
      // best-effort — never break replay because the sidecar could not be written
    }
    const info: JsonlBadLineInfo = { line, lineNo, reason, ...(errors ? { errors } : {}) };
    for (const listener of this.badLineListeners) listener(info);
  }
}

const NEWLINE = 0x0a;
/** readBack reads this much of the file at a time, from its end. */
const READ_BACK_CHUNK = 1 << 20;

/** True when `line` is JSON. A record cut short never is: its closing brace is its last byte. */
function parses(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

/** Exactly the bytes at [position, position + length) (fewer only if the file is shorter). */
async function readBytes(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, position + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return buf.subarray(0, got);
}

/** The offset of the last newline before `end`, or -1: read backwards, 64 KB at a time. */
async function lastNewlineBefore(fh: FileHandle, end: number): Promise<number> {
  const chunk = 1 << 16;
  for (let pos = end; pos > 0; ) {
    const len = Math.min(chunk, pos);
    pos -= len;
    const at = (await readBytes(fh, pos, len)).lastIndexOf(NEWLINE);
    if (at !== -1) return pos + at;
  }
  return -1;
}

/** How many newlines precede `end` (the 1-based line number read() gives the next line, minus 1). */
async function countNewlines(fh: FileHandle, end: number): Promise<number> {
  const chunk = 1 << 20;
  let n = 0;
  for (let pos = 0; pos < end; ) {
    const buf = await readBytes(fh, pos, Math.min(chunk, end - pos));
    if (buf.length === 0) break;
    for (let at = buf.indexOf(NEWLINE); at !== -1; at = buf.indexOf(NEWLINE, at + 1)) n++;
    pos += buf.length;
  }
  return n;
}

/** Append `text` and fsync it, and the directory that holds the file (it may be new). Throws. */
async function appendDurably(file: string, text: string): Promise<void> {
  const fh = await fs.open(file, 'a');
  try {
    await fh.write(text, null, 'utf8');
    await fh.sync();
  } finally {
    await fh.close().catch(() => {});
  }
  const dirFh = await fs.open(dirname(file), 'r');
  try {
    await dirFh.sync();
  } finally {
    await dirFh.close().catch(() => {});
  }
}

/** True when a parsed line declares a journal schema version NEWER than this build reads. */
function isFutureVersion(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  const v = (parsed as Record<string, unknown>).v;
  return typeof v === 'number' && v > CURRENT_JOURNAL_VERSION;
}
