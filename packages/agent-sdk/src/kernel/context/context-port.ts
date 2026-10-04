/**
 * ContextPort — the Nami read/reflect seam (K4 §5).
 *
 * The kernel-pure boundary between the harness loop and the "context engine"
 * (Nami). K4 ships the READ path only: a session-frozen memory PUSH block,
 * surfaced once per session as InstructionStack layer 7 for ALL arms — this
 * closes the native/openai memory-parity gap (the Claude SDK auto-loads
 * MEMORY.md via settingSources; native/openai had no equivalent).
 *
 * ROOT PURITY: this module is PURE (types + the no-op default only). The
 * concrete FILE-reading impl (`VolumeContextPort`, which imports `node:fs`)
 * lives in `./volume-context-port.ts`, exported ONLY from the
 * `@vestra/agent-sdk/engine` batteries entry — so the pure root barrel never
 * drags a Node built-in into a browser bundle of `@vestra/agent-sdk` /
 * `@bash/shared` (the ring-E node:fs-in-root fix).
 *
 * DATA-NEVER-INSTRUCTIONS: recalled memory is wrapped in a NON-IMPERATIVE fenced
 * `<user_memory> … </user_memory>` block. The fence makes recalled memory DATA,
 * never instructions — a model reading it treats it as reference, not as a
 * command to obey. The merge-order conformance test asserts the fence shape.
 */
import type { JournalEntry } from '../../contract/journal.js';

/** What a read/recall is scoped to. The taskId+workspaceId carry the tenant
 *  boundary so P-Nami can stamp `source_task_id` provenance later without
 *  widening this interface. */
export interface ContextQuery {
  workspaceId: string;
  taskId: string;
  /** Optional free-text recall (the `context_query` tool, T7). Absent = the
   *  session-open snapshot (the layer-7 push block computed at session start). */
  query?: string;
}

export interface ContextPort {
  /**
   * READ: produce the frozen-snapshot memory push block (layer 7), computed
   * ONCE per session. Returns '' when there is no memory / no port. The result
   * is DATA-NEVER-INSTRUCTIONS — wrapped in a fenced `<user_memory> … </user_memory>`
   * block. MUST never throw (degrade to '' on any error).
   */
  readSnapshot(query: ContextQuery): Promise<string>;
  /**
   * REFLECT seam: called on each compaction with the dropped span. K4 default =
   * NO-OP (the write-curator is deferred to P-Nami). Best-effort; never blocks
   * or throws into the turn. A concrete P-Nami impl maps `dropped` →
   * ExtractedMemory[] and writes the `user_memory` table — NEVER `memory/` on
   * the FS (the server owns the memory/ FS surface via the Nami keeper).
   * `dropped` carries taskId+workspaceId (the tenant boundary).
   */
  onPreCompact(slice: { dropped: JournalEntry[]; summaryText: string }): Promise<void>;
}

/** No memory / no port. read → ''; reflect → no-op. */
export const NoopContextPort: ContextPort = {
  async readSnapshot(): Promise<string> {
    return '';
  },
  async onPreCompact(): Promise<void> {
    /* no-op */
  },
};
