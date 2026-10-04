import type { JournalEntry } from '../../contract/journal.js';

/**
 * The journal mirror. Local-first JSONL is the source of truth; this is a
 * best-effort replica (Postgres in prod) used for server queries, projections,
 * and cross-host resume. Implementations MUST NOT be on the turn's critical path.
 */
export interface SessionStore {
  appendBatch(taskId: string, entries: JournalEntry[]): Promise<void>;
  /**
   * The task's mirrored entries in seq order, or null when the mirror holds NO rows for it.
   * THROWS when it cannot tell: a null that meant "unreachable" would let hydrate start a
   * task the mirror knows over at seq 0.
   */
  load(taskId: string): Promise<JournalEntry[] | null>;
  listTasks(workspaceId: string): Promise<string[]>;
  /**
   * JOURNAL_LOSSLESS_MIRROR_V1 (LosslessSessionStore). Present only on a store that takes every
   * entry WHOLE and so may never be shed: the journal then sends it entries unclamped, never drops
   * its queue, and asks this once per open which of its local entries the mirror still lacks.
   * An unanswered ask is `[]` (the entries stay on disk for the next open). It REJECTS only with a
   * MirrorSeqConflictError: the local entry at the mirror's top is another one (continue anywhere
   * §6.2), so nothing above that top may be sent, and the journal is refused as for a 409.
   * Absent ⇒ the journal clamps and sheds exactly as before.
   */
  owed?(taskId: string, local: readonly JournalEntry[]): Promise<JournalEntry[]>;
}

/** Continue anywhere (spec §6.1): the mirror's top for a task, as the server marks a delivery. */
export interface MirrorMarker {
  maxSeq: number;
  lastUuid: string;
}

/** The mirror refused a batch: it holds a DIFFERENT entry at one of its seqs (spec §6.2). */
export class MirrorSeqConflictError extends Error {
  constructor(readonly conflicts: Array<{ seq: number; heldUuid: string | null }>) {
    super(`mirror holds a different entry at seq ${conflicts[0]?.seq}`);
    this.name = 'MirrorSeqConflictError';
  }
}

/** A catch-up's rebuild read the mirror up to `answeredSeq` only, short of its own marker (an interior
 *  gap, or rows that do not validate): the local file is put back and the turn fails (Journal.catchUp). */
export class MirrorShortError extends Error {
  constructor(readonly answeredSeq: number, readonly markerSeq: number) {
    super(`journal catch-up: the mirror answered up to seq ${answeredSeq}, short of its marker ${markerSeq}`);
    this.name = 'MirrorShortError';
  }
}

/** What the mirror holds of one task: its lowest and highest seq and how many rows (one per seq). */
export interface MirrorHolding {
  minSeq: number;
  maxSeq: number;
  rowCount: number;
  /** The uuid of its entry at `maxSeq`: what a resend above the top is checked against (§6.2).
   *  Absent when the server did not name it: that resend cannot be checked, and goes as before. */
  lastUuid?: string;
}

/** In-memory fake for tests. */
export class InMemorySessionStore implements SessionStore {
  private byTask = new Map<string, JournalEntry[]>();

  async appendBatch(taskId: string, entries: JournalEntry[]): Promise<void> {
    const cur = this.byTask.get(taskId) ?? [];
    this.byTask.set(taskId, [...cur, ...entries]);
  }
  async load(taskId: string): Promise<JournalEntry[] | null> {
    return this.byTask.get(taskId) ?? null;
  }
  async listTasks(workspaceId: string): Promise<string[]> {
    const out: string[] = [];
    for (const [taskId, entries] of this.byTask) {
      if (entries[0]?.workspaceId === workspaceId) out.push(taskId);
    }
    return out;
  }
  async holding(taskId: string): Promise<MirrorHolding | null> {
    const rows = this.byTask.get(taskId) ?? [];
    const seqs = rows.map((e) => e.seq);
    if (seqs.length === 0) return null;
    const maxSeq = Math.max(...seqs);
    return { minSeq: Math.min(...seqs), maxSeq, rowCount: new Set(seqs).size, lastUuid: rows.find((e) => e.seq === maxSeq)!.uuid };
  }
  async heldSeqs(taskId: string): Promise<number[]> {
    return [...new Set((this.byTask.get(taskId) ?? []).map((e) => e.seq))].sort((a, b) => a - b);
  }
}
