/**
 * COMPACTION_V2 — the mechanical file trail.
 *
 * PURITY CONTRACT (mirrors compactor.ts / trigger.ts / overflow.ts):
 *   - No I/O, no clock, no provider SDK. Pure functions over journal entries.
 *   - Never throws; a malformed entry contributes nothing.
 *
 * ── WHY MECHANICAL AND NOT SUMMARIZED ───────────────────────────────────────
 * "Every file read, created, or modified, with exact paths" is a section of
 * COMPACTION_SYSTEM, which means today it is RECALL: the summarizer re-reads the
 * span and tries to remember every path. That is the one part of a summary a
 * model reliably drops first when the span is long, and it is also the part that
 * needs no intelligence at all — the paths are sitting in the tool_use inputs,
 * exactly and completely. Extracting them mechanically makes the list total by
 * construction, costs zero tokens of summarizer attention, and frees the model to
 * spend its 4k output on the things only it can produce.
 *
 * ── WHY CAPABILITY, NOT TOOL NAMES ──────────────────────────────────────────
 * The read/modified split keys off the caller's side-effect CLASSIFIER (injected
 * as `classify`), which is the repo's single deterministic artifact for what a
 * call does — it already understands builtins, Bash command analysis, MCP verbs,
 * and Composio actions. A hand-list of tool names here would silently omit every
 * tool added after it was written; a capability lookup cannot. The path itself
 * comes from the repo's path-argument CONVENTION (`file_path` and friends), so a
 * new file tool that follows the convention lands in the trail with no
 * registration anywhere.
 *
 * ── WHY IT ACCUMULATES ──────────────────────────────────────────────────────
 * Compaction N drops the span that compaction N-1 summarized. If the trail were
 * rebuilt from only the new span, every compaction would forget the files the
 * previous one recorded, and a long session would end up with a trail covering
 * just its most recent stretch. So the previous summary's trail is parsed back
 * out (this module renders it, so this module can read it) and unioned with the
 * new span's — the trail is cumulative even though each summary is not.
 */

import type { JournalEntry } from '../../contract/journal.js';

/** What a tool call contributed to the trail. `ignore` = not a file touch. */
export type TrailEffect = 'read' | 'modified' | 'ignore';

export interface FileTrail {
  /** Paths observed via read-only calls, first-seen order. */
  read: string[];
  /** Paths observed via mutating calls, first-seen order. */
  modified: string[];
}

export const EMPTY_FILE_TRAIL: FileTrail = { read: [], modified: [] };

/**
 * Per-list cap. The trail rides inside every future summary, so an uncapped list
 * would grow without bound and re-inflate exactly the cost this feature exists to
 * flatten. When a list overflows, the OLDEST entries are dropped: recent files are
 * the ones a resuming agent is about to touch again.
 */
export const FILE_TRAIL_MAX_PATHS = 100;

/**
 * The rendered block's header. A literal constant because {@link renderFileTrail}
 * writes it and {@link parseFileTrail} reads it back — the accumulation contract
 * is that those two never drift.
 */
export const FILE_TRAIL_HEADER = 'Context trail (recorded mechanically from tool calls, not summarized):';

const READ_LABEL = 'Files read:';
const MODIFIED_LABEL = 'Files modified:';

/**
 * Argument names that carry a filesystem path, in precedence order. This is the
 * repo's path-argument CONVENTION (permission-rule-engine.ts and
 * tool-permission-suggestion.ts both key off `file_path` for the whole edit
 * family), not a per-tool registry — a call that follows the convention is
 * picked up whatever it is called.
 *
 * Deliberately EXCLUDES search-shaped arguments (`pattern`, `glob`, `query`): a
 * glob is not a file that was read, and putting one in the trail would make the
 * list lie about what the agent actually saw.
 */
const PATH_ARGUMENT_KEYS: readonly string[] = ['file_path', 'notebook_path', 'path'];

/**
 * Extract the file trail from a span of journal entries.
 *
 * `classify` maps a tool call to its trail effect — the caller injects it so this
 * module stays inside the kernel's sibling-only import surface while still keying
 * off the real side-effect classifier.
 */
export function extractFileTrail(
  entries: JournalEntry[],
  classify: (toolName: string, input: unknown) => TrailEffect,
): FileTrail {
  const read: string[] = [];
  const modified: string[] = [];
  const seenRead = new Set<string>();
  const seenModified = new Set<string>();

  for (const entry of entries) {
    const payload = entry.payload;
    if (payload.type !== 'tool_use') continue;

    const path = pathArgumentOf(payload.input);
    if (path === undefined) continue;

    let effect: TrailEffect;
    try {
      effect = classify(payload.name, payload.input);
    } catch {
      // A classifier hiccup must never abort a compaction — the trail is an
      // enrichment, and an unclassified call simply contributes nothing.
      continue;
    }

    if (effect === 'read' && !seenRead.has(path)) {
      seenRead.add(path);
      read.push(path);
    } else if (effect === 'modified' && !seenModified.has(path)) {
      seenModified.add(path);
      modified.push(path);
    }
  }

  return { read, modified };
}

/**
 * Union two trails, `prev` first (older paths keep their position), capped.
 *
 * A path that was read and is later modified appears in BOTH lists — that is the
 * honest record, and dropping it from `read` would lose the fact that the agent
 * saw the file's original contents.
 */
export function mergeFileTrail(prev: FileTrail, next: FileTrail, cap = FILE_TRAIL_MAX_PATHS): FileTrail {
  return {
    read: capOldestFirst(dedupe([...prev.read, ...next.read]), cap),
    modified: capOldestFirst(dedupe([...prev.modified, ...next.modified]), cap),
  };
}

/**
 * Render a trail as the block appended to a compaction summary. An EMPTY trail
 * renders as the empty string — a session that touched no files gets no block at
 * all, never a "Files read: none" line (same discipline as COMPACTION_SYSTEM's
 * "never write None applicable").
 */
export function renderFileTrail(trail: FileTrail): string {
  if (trail.read.length === 0 && trail.modified.length === 0) return '';
  const lines: string[] = [FILE_TRAIL_HEADER];
  if (trail.read.length > 0) lines.push(READ_LABEL, ...trail.read.map((p) => `- ${p}`));
  if (trail.modified.length > 0) lines.push(MODIFIED_LABEL, ...trail.modified.map((p) => `- ${p}`));
  return lines.join('\n');
}

/**
 * Read a trail back out of a previous summary's text — the other half of the
 * accumulation contract with {@link renderFileTrail}.
 *
 * Paths are one per line behind a `- ` marker precisely so this round-trips
 * exactly: a comma-separated list would corrupt any path containing a comma.
 * Text that carries no trail block yields the empty trail.
 */
export function parseFileTrail(summaryText: string): FileTrail {
  const headerIdx = summaryText.indexOf(FILE_TRAIL_HEADER);
  if (headerIdx < 0) return { read: [], modified: [] };

  const read: string[] = [];
  const modified: string[] = [];
  let current: string[] | null = null;

  for (const line of summaryText.slice(headerIdx + FILE_TRAIL_HEADER.length).split('\n')) {
    if (line === READ_LABEL) { current = read; continue; }
    if (line === MODIFIED_LABEL) { current = modified; continue; }
    if (line.startsWith('- ')) {
      // A path line before any label belongs to no list — skip rather than guess.
      if (current) current.push(line.slice(2));
      continue;
    }
    // Any other non-blank line ends the block: the trail is appended LAST, but a
    // future caller could append after it, and the parse must not swallow that.
    if (line.trim() !== '') break;
  }

  return { read, modified };
}

/** The first path-shaped argument of a tool input, or undefined when there is none. */
function pathArgumentOf(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  for (const key of PATH_ARGUMENT_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

function dedupe(paths: string[]): string[] {
  return [...new Set(paths)];
}

/** Keep the NEWEST `cap` entries (drop from the front — see FILE_TRAIL_MAX_PATHS). */
function capOldestFirst(paths: string[], cap: number): string[] {
  return paths.length <= cap ? paths : paths.slice(paths.length - cap);
}
