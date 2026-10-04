/**
 * Hardening-I — per-session file read-state (the Read/Edit truth contract).
 *
 * Read records every file it shows here; Edit/Write consult it before mutating so
 * a model cannot edit a file it never Read, nor edit a file that CHANGED on disk
 * since it last Read it (a lost-update guard).
 *
 * Scoping: `createFileViewState` is a FACTORY, not a module-global Map. One store
 * is created per tool-set construction and the Read/Edit/Write builders close over
 * that ONE instance, so the store is per-session — the sandbox process hosts many
 * parallel sessions over one workspace, and a single shared map would let session
 * B's write silently satisfy session A's freshness check (defeating the lost-update
 * guard). This mirrors the per-task `getSession` seam the Bash tool uses.
 */

export interface FileViewRecord {
  /** File mtime (ms) observed at the last successful Read. */
  mtimeMs: number;
  /** File size (bytes) observed at the last successful Read. */
  size: number;
  /** Wall-clock ms of the last successful Read (diagnostics; not used for freshness). */
  lastReadAt: number;
}

export interface FileViewState {
  /** Record a successful Read of an absolute path. */
  record(absPath: string, stat: { mtimeMs: number; size: number }): void;
  /** The read-state for an absolute path, or undefined if never Read this session. */
  get(absPath: string): FileViewRecord | undefined;
}

/** Create a fresh, independent read-state store (one per session/tool-set). */
export function createFileViewState(): FileViewState {
  const byPath = new Map<string, FileViewRecord>();
  return {
    record(absPath, stat) {
      byPath.set(absPath, { mtimeMs: stat.mtimeMs, size: stat.size, lastReadAt: Date.now() });
    },
    get(absPath) {
      return byPath.get(absPath);
    },
  };
}

export type Freshness = 'unread' | 'stale' | 'fresh';

/**
 * Classify a file's mutate-readiness against its recorded read-state:
 *  - `unread`: never Read this session.
 *  - `stale`: Read this session, but mtime or size differs now (changed on disk).
 *  - `fresh`: mtime AND size match the recorded Read.
 */
export function checkFreshness(
  rec: FileViewRecord | undefined,
  current: { mtimeMs: number; size: number },
): Freshness {
  if (!rec) return 'unread';
  if (rec.mtimeMs !== current.mtimeMs || rec.size !== current.size) return 'stale';
  return 'fresh';
}

/** Refusal shown when a mutate targets a file never Read this session. */
export const MSG_UNREAD = 'File has not been Read in this session — Read it first.';
/** Refusal shown when a mutate targets a file changed on disk since the last Read. */
export const MSG_STALE = 'File changed on disk since last Read — Read it again before editing.';
