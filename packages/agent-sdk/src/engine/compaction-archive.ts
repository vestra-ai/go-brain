/**
 * compaction-archive.ts — Phase 3 (§1.5) durable archival of a dropped
 * compaction span.
 *
 * Writes the FULL pre-compaction span (before it is replaced by a summary) to
 * `${workingDir}/.kernel-archive/${taskId}/<thread>.md` — session/task-
 * NAMESPACED, mirroring the FS context-offload primitive's convention
 * (context-offload.ts). Degrade-safe: an archival failure (or an absent
 * workingDir) must never abort a compaction — the summary is the load-bearing
 * artifact; the archive is a best-effort audit trail underneath it.
 */
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { renderArchiveMarkdown } from '../kernel/compaction/archive.js';
import type { JournalEntry } from '../contract/journal.js';

export interface ArchiveParams {
  droppedEntries: readonly JournalEntry[];
  workingDir: string;
  taskId: string;
  /** A stable per-compaction-event identifier (e.g. the plan's `firstKeptId`). */
  thread: string;
}

export interface ArchiveResult {
  /** Present only when the archive was actually written. */
  path?: string;
}

/** Write the dropped span to disk; never throws. */
export async function archiveDroppedEntries(params: ArchiveParams): Promise<ArchiveResult> {
  const { droppedEntries, workingDir, taskId, thread } = params;
  if (droppedEntries.length === 0) return {};

  const relPath = `.kernel-archive/${taskId}/${thread}.md`;
  const absPath = join(workingDir, relPath);
  try {
    await fs.mkdir(dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, renderArchiveMarkdown(droppedEntries), 'utf8');
    return { path: relPath };
  } catch {
    return {};
  }
}
