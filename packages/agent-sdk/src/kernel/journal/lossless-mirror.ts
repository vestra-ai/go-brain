import type { JournalEntry } from '../../contract/journal.js';
import type { JournalIntegrityEvent } from './journal.js';
import { clampForMirror, MIRROR_MAX_ENTRY_BYTES } from './mirror-clamp.js';
import { MirrorSeqConflictError, type MirrorHolding, type SessionStore } from './session-store.js';
import { validateJournalEntry } from './validate-entry.js';

/**
 * JOURNAL_LOSSLESS_MIRROR_V1 (harness to nine, R1): a mirror that gives a journal back WHOLE.
 *
 * The plain mirror is not a full copy by design (mirror-clamp.ts): a pasted image becomes a text
 * placeholder and an entry over MIRROR_MAX_ENTRY_BYTES becomes a small note, because a mirror row
 * has to stay small. This store keeps the row small and loses nothing: an entry the clamp would
 * change is first stored WHOLE (the task's storage, via the server relay), and its row is the
 * clamp's own output plus `mirrorRef: 'storage'`. A reader without the flag therefore hydrates
 * exactly what it always did (the clamp markers stay, so the holdings still count the row as a
 * clamp and the tidy sweeper keeps the local copy); a reader with it swaps the whole entry back.
 */

/** Where a mirrored entry is kept whole, by (task, seq, uuid). The runner's: RelayBlobStore. */
export interface MirrorBlobStore {
  /** Keep the whole entry. Idempotent (same key, same bytes). Resolves false when storage will
   *  NEVER take it (too large): a terminal answer. Throws when it could not, this time. */
  put(taskId: string, entry: JournalEntry): Promise<boolean>;
  /** The whole entry, or null when storage holds none at that key. Throws when it cannot tell.
   *  `bytes` is the size the stand-in recorded, so a big entry's read gets a deadline to match. */
  get(taskId: string, seq: number, uuid: string, bytes?: number): Promise<JournalEntry | null>;
}

/** What the mirror holds of a task, and (asked only when that run has holes) exactly which seqs. */
export type HoldingStore = SessionStore & {
  holding(taskId: string): Promise<MirrorHolding | null>;
  heldSeqs(taskId: string): Promise<number[]>;
};

/** A mirror row standing in for an entry kept whole in storage, and that entry's size in bytes. */
export type MirrorStandIn = JournalEntry & { mirrorRef: 'storage'; mirrorBytes: number };

/** How many whole entries one load fetches, and one window uploads, at once. */
const FETCH_AT_ONCE = 8;
const PUT_AT_ONCE = 4;
/** A stand-in is clamped this far under the row cap, so the server's capEntry never cuts `mirrorRef`. */
const STAND_IN_HEADROOM = 64;
/** The most a turn's end waits on a lossless mirror's flush (Journal.flushMirrorAtTurnEnd). */
export const TURN_END_FLUSH_MS = 10_000;

/** `flush`, or `ms`, whichever settles first, on an unref'd timer. The flush itself goes on. */
export function capTurnEndFlush(flush: Promise<void>, ms = TURN_END_FLUSH_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([flush, cap]).finally(() => clearTimeout(timer));
}

/**
 * Continue anywhere (spec §6.2): whether a local file may NOT be sent above the mirror's top. The
 * server refuses only the seqs it already holds, so a blind tail (written after another computer
 * took the task over) would land above the top unchecked. The local entry AT the top must be the
 * mirror's own: the same uuid at the same seq, which a rewind keeps (no parent chain is asked). A
 * file that does not reach above the top has nothing to send there, and a mirror that names no
 * uuid cannot be checked (as before). A file with entries above the top and none readable at it
 * cannot prove its history, so it is refused too.
 */
export function divergesAtTop(held: MirrorHolding, local: readonly JournalEntry[]): boolean {
  if (held.lastUuid === undefined || !local.some((e) => e.seq > held.maxSeq)) return false;
  return local.find((e) => e.seq === held.maxSeq)?.uuid !== held.lastUuid;
}

/** `p`, with a handler attached, so a rejection it holds until someone awaits it is never "unhandled". */
export function awaitedLater<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}

const warn = (taskId: string, e: JournalIntegrityEvent): void => console.warn(`[JOURNAL_INTEGRITY] task=${taskId} ${JSON.stringify(e)}`);
const refKey = (taskId: string, e: JournalEntry): string => `${taskId}/${e.seq}/${e.uuid}`;

export class LosslessSessionStore implements SessionStore {
  /** Entries storage refused for good, so a retried window neither uploads nor reports them again. */
  private readonly refused = new Set<string>();

  constructor(
    private readonly inner: HoldingStore,
    private readonly blobs: MirrorBlobStore,
    private readonly report: (taskId: string, e: JournalIntegrityEvent) => void = warn,
    /** Whether `owed` checks a resend above the top against the mirror's history (divergesAtTop).
     *  The runner's: CONTINUITY_JOURNAL_V1, since only a catch-up can rebuild a refused journal. */
    private readonly historyChecked: () => boolean = () => true,
  ) {}

  /** Each entry the clamp would change goes to storage FIRST (PUT_AT_ONCE at a time), so no
   *  stand-in row ever names an entry that is not there. A failed upload throws before any row is
   *  written: the window stays at the head of the journal's queue and is sent again at the next
   *  boundary. An entry storage refuses for good is mirrored as its plain clamp, loudly and once:
   *  lossy for that one entry, never a wedged queue. */
  async appendBatch(taskId: string, entries: JournalEntry[]): Promise<void> {
    const whole = entries.filter((e) => clampForMirror(e, MIRROR_MAX_ENTRY_BYTES) !== e);
    const stored = new Set<JournalEntry>();
    const toPut = whole.filter((e) => !this.refused.has(refKey(taskId, e)));
    for (let at = 0; at < toPut.length; at += PUT_AT_ONCE) {
      const chunk = toPut.slice(at, at + PUT_AT_ONCE);
      const results = await Promise.allSettled(chunk.map((e) => this.blobs.put(taskId, e)));
      results.forEach((r, i) => {
        const e = chunk[i]!;
        if (r.status === 'rejected') return;
        if (r.value) stored.add(e);
        else {
          this.refused.add(refKey(taskId, e));
          this.report(taskId, { kind: 'mirror_whole_entry_refused', seq: e.seq, bytes: JSON.stringify(e).length });
        }
      });
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) throw failed.reason;
    }
    const rows = entries.map((e) => {
      if (!stored.has(e)) return whole.includes(e) ? clampForMirror(e, MIRROR_MAX_ENTRY_BYTES) : e;
      const standIn: MirrorStandIn = {
        ...clampForMirror(e, MIRROR_MAX_ENTRY_BYTES - STAND_IN_HEADROOM),
        mirrorRef: 'storage',
        mirrorBytes: JSON.stringify(e).length,
      };
      return standIn;
    });
    await this.inner.appendBatch(taskId, rows);
  }

  /** The mirror's rows with every stand-in swapped for its whole entry. A stand-in whose entry
   *  storage no longer holds (or holds for another uuid) hydrates as the stand-in, loudly: the
   *  same degraded entry a plain mirror gives, never a hole in the chain. */
  async load(taskId: string): Promise<JournalEntry[] | null> {
    const rows = await this.inner.load(taskId);
    if (!rows) return rows;
    const out = rows.slice();
    const refs = rows.flatMap((r, i) => ((r as Partial<MirrorStandIn>).mirrorRef === 'storage' ? [i] : []));
    for (let at = 0; at < refs.length; at += FETCH_AT_ONCE) {
      await Promise.all(refs.slice(at, at + FETCH_AT_ONCE).map(async (i) => {
        const row = rows[i] as MirrorStandIn;
        const whole = await this.blobs.get(taskId, row.seq, row.uuid, row.mirrorBytes);
        if (whole && whole.uuid === row.uuid && whole.seq === row.seq && validateJournalEntry(whole).ok) out[i] = whole;
        else console.warn(`[JOURNAL_INTEGRITY] seq ${row.seq} of ${taskId}: its whole entry is not in storage; hydrating the mirror's stand-in`);
      }));
    }
    return out;
  }

  listTasks(workspaceId: string): Promise<string[]> {
    return this.inner.listTasks(workspaceId);
  }

  /** Which of a journal's local entries the mirror lacks: all of them when it holds none, the ones
   *  past its last seq when it holds an unbroken run from seq 0, and otherwise exactly the ones
   *  whose seqs it does not hold (asked of it, so a hole the local file cannot fill is not resent
   *  on every open). Unanswered, it is `[]`, loudly, and the entries wait on disk for the next open
   *  (the tidy sweeper never prunes a file the mirror does not hold whole). It REJECTS, with a
   *  MirrorSeqConflictError at the top, only when the file's entry there is another (divergesAtTop):
   *  nothing is sent, and the journal is refused as for a 409 (Journal.doFlushMirror). */
  async owed(taskId: string, local: readonly JournalEntry[]): Promise<JournalEntry[]> {
    try {
      const held = await this.inner.holding(taskId);
      if (held === null) return local.slice();
      if (this.historyChecked() && divergesAtTop(held, local)) {
        throw new MirrorSeqConflictError([{ seq: held.maxSeq, heldUuid: held.lastUuid ?? null }]);
      }
      if (held.minSeq === 0 && held.rowCount === held.maxSeq + 1) return local.filter((e) => e.seq > held.maxSeq);
      const have = new Set(await this.inner.heldSeqs(taskId));
      return local.filter((e) => !have.has(e.seq));
    } catch (err) {
      if (err instanceof MirrorSeqConflictError) throw err;
      console.warn(`[JOURNAL_INTEGRITY] could not ask the mirror what ${taskId} lacks (${err instanceof Error ? err.message : err}); its local entries wait for the next open`);
      return [];
    }
  }
}
