import { isContextEntry, type JournalEntry, type NewEntry } from '../../contract/journal.js';
import { isEngineInjectedUserText } from '../../contract/injected-user-text.js';
import { isDelegatedResultContent } from '../interaction/strategy.js';
import { migrateEntry, validateJournalEntry } from './validate-entry.js';
import type { JsonlStore } from './jsonl-store.js';

/**
 * JOURNAL_CHECKPOINT_V1 (harness to nine, R2): rebuild a journal from its last compaction, not
 * from its first line.
 *
 * WHAT IT IS. When a compaction lands, the journal appends, right after its `compact_boundary`, a
 * `custom` entry keyed {@link CHECKPOINT_KEY} that holds every entry the journal still needs from
 * before that point (the "replacement history"). A fresh process then reads the file BACKWARDS
 * from its end to the newest checkpoint and never touches the bytes before it: its read-model is
 * `[...checkpoint.entries, checkpoint, ...entries after it]`, and `project()` over that is
 * identical to `project()` over the whole file. A `custom` entry, not a new payload type or a
 * field on the boundary: every validator, the server and a downgraded runner already accept it,
 * and a mirror that clamps a big row clamps the checkpoint to `data: null` (mirror-clamp.ts: the
 * next open then reads in full), never the boundary, and never into a context entry.
 *
 * ONE UNIT WITH ITS BOUNDARY. Journal.compact appends the boundary and the checkpoint in one link
 * of the append chain, so nothing lands between them; the reader trusts a checkpoint only at
 * boundary.seq + 1 with the boundary as its parent (anything else reads in full).
 *
 * WHAT IT DROPS, and why each kept kind is kept. Only a main-scope CONTEXT entry that this
 * compaction drops from the model's view (not its summary, not preserved, before its first kept
 * entry) AND that is older than the current turn, unless something still points at it:
 *  - every non-context entry (usage, plan, interaction, mode, custom, step_result, teammate_def,
 *    rewind and compaction markers) is state; it is carried whole (an earlier checkpoint is not:
 *    it is superseded, and carrying it would nest);
 *  - every subagent-scoped entry (a subagent's conversation is not the main compaction's to drop);
 *  - the current turn, from its real start (the injection screen reads the whole turn, compacted
 *    part included; `turnStartSeq` is its `currentTurnKey` boundary, pinned by a test);
 *  - a tool call or result whose id an interaction names, and a tool call never answered (the
 *    continue and heal paths read them);
 *  - a rewind's pivot (the rewind needs its seq); a later rewind to a pivot this dropped makes
 *    the journal read in full first (Journal.rewindTo);
 *  - a user entry the engine wrote (`injected`: the engine handover, hook context), a block of
 *    type `media` (the watch tool's source list), a delegated helper result (the roster rebuild).
 * A consumer of `Journal.snapshot()` that needs older conversation reads `Journal.read()` (the
 * disk, always whole) or, better, writes the state it needs as a non-context record.
 *
 * WHAT IT COSTS. Each checkpoint is a whole copy: every state record, every subagent entry and the
 * current turn so far. So a task that compacts k times writes k copies of its state, a turn that
 * outlives several compactions is copied once per compaction, and a subagent-heavy task copies its
 * subagents each time: disk grows about k x (state + subagents + current turn), not k x the window.
 * Bounded per checkpoint: one that would not drop at least half of the read-model is not written
 * (checkpointEntry), and a rebuild then starts at the previous one, or reads in full.
 */
export const CHECKPOINT_KEY = 'journal_checkpoint';

/** The checkpoint's data: the boundary it follows, and what the journal keeps from before it. */
export interface CheckpointData {
  boundaryUuid: string;
  entries: JournalEntry[];
}

/** The checkpoint this entry carries, or null when it is not one (or its data is not whole). */
export function checkpointOf(e: JournalEntry): CheckpointData | null {
  if (e.payload.type !== 'custom' || e.payload.key !== CHECKPOINT_KEY) return null;
  const d = e.payload.data as Partial<CheckpointData> | null | undefined;
  const boundaryUuid = d?.boundaryUuid;
  const entries = d?.entries;
  if (typeof boundaryUuid !== 'string' || !Array.isArray(entries)) return null;
  if (!entries.every((x) => validateJournalEntry(x).ok)) return null;
  const boundary = entries.find((x) => x.uuid === boundaryUuid);
  return boundary?.payload.type === 'compact_boundary' ? { boundaryUuid, entries } : null;
}

/**
 * The checkpoint entry to append right after `boundary` (already in `all`), or null when it would
 * not drop at least half of the read-model's entries: then it would mostly copy the journal (a
 * huge subagent tree, a turn that outlived several compactions), so none is written and a rebuild
 * starts at the previous checkpoint, or reads in full. That bounds what one checkpoint costs.
 */
export function checkpointEntry(all: readonly JournalEntry[], boundary: JournalEntry): NewEntry | null {
  const entries = checkpointRetained(all, boundary);
  if (entries.length * 2 > all.length) return null;
  const data: CheckpointData = { boundaryUuid: boundary.uuid, entries };
  return {
    taskId: boundary.taskId, rootTaskId: boundary.rootTaskId, spawnDepth: boundary.spawnDepth,
    workspaceId: boundary.workspaceId, agentId: 'system', principal: { kind: 'system' }, timestamp: '',
    payload: { type: 'custom', key: CHECKPOINT_KEY, data },
  };
}

/** The entries of `all` a rebuild from this boundary still needs (the rules in the header). */
export function checkpointRetained(all: readonly JournalEntry[], boundary: JournalEntry): JournalEntry[] {
  const b = boundary.payload;
  const live = all.filter((e) => !isCheckpoint(e));
  if (b.type !== 'compact_boundary') return live;
  const { firstKeptId, summaryUuid, preservedUuids } = b;
  const firstKept = all.find((e) => e.uuid === firstKeptId);
  if (!firstKept) return live; // an anchor this journal cannot see: drop nothing
  const keepFrom = Math.min(firstKept.seq, turnStartSeq(all));
  const preserved = new Set(preservedUuids);
  const { toolIds, pivots } = referenced(all);
  return live.filter((e) => {
    if (!isContextEntry(e) || (e.agentPath?.length ?? 0) > 0 || e.seq >= keepFrom) return true;
    if (e.uuid === summaryUuid || preserved.has(e.uuid) || pivots.has(e.uuid)) return true;
    const p = e.payload;
    if ((p.type === 'tool_use' || p.type === 'tool_result') && toolIds.has(p.toolUseId)) return true;
    return carriesMarker(e);
  });
}

/** Any checkpoint entry, whole or not: never carried into the next one. */
export function isCheckpoint(e: JournalEntry): boolean {
  return e.payload.type === 'custom' && e.payload.key === CHECKPOINT_KEY;
}

/**
 * The seq of the entry that started the current turn, or -Infinity when there is none (keep
 * everything). The SAME boundary as policy/injection-screen.ts `currentTurnKey` (the kernel may
 * not import policy; a test pins the two together): the last `user` entry that is not a control
 * turn and not engine-minted (a non-user principal, `injected`, an engine marker text, or a
 * compaction summary).
 */
export function turnStartSeq(all: readonly JournalEntry[]): number {
  const summaries = new Set<string>();
  for (const e of all) if (e.payload.type === 'compact_boundary') summaries.add(e.payload.summaryUuid);
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i];
    const p = e.payload;
    if (p.type !== 'user' || p.control !== undefined || summaries.has(e.uuid)) continue;
    if (e.principal.kind !== 'user' || p.injected !== undefined) continue;
    const text = p.blocks.filter((x): x is { type: 'text'; text: string } => x.type === 'text').map((x) => x.text).join('\n');
    if (!isEngineInjectedUserText(text)) return e.seq;
  }
  return -Infinity;
}

/** Tool ids still referenced (named by an interaction, or called and never answered) and rewind pivots. */
function referenced(all: readonly JournalEntry[]): { toolIds: Set<string>; pivots: Set<string> } {
  const toolIds = new Set<string>();
  const pivots = new Set<string>();
  const answered = new Set<string>();
  for (const e of all) {
    const p = e.payload;
    if (p.type === 'tool_result') answered.add(p.toolUseId);
    else if (p.type === 'rewind_boundary') pivots.add(p.pivotUuid);
    else if (p.type === 'interaction') {
      const id = (p.data as { toolUseId?: unknown } | undefined)?.toolUseId;
      if (typeof id === 'string') toolIds.add(id);
    }
  }
  for (const e of all) if (e.payload.type === 'tool_use' && !answered.has(e.payload.toolUseId)) toolIds.add(e.payload.toolUseId);
  return { toolIds, pivots };
}

/** An engine-written user entry, a media block, or a delegated helper result (the header's last rule). */
function carriesMarker(e: JournalEntry): boolean {
  const p = e.payload;
  if (p.type === 'user' && p.injected !== undefined) return true;
  const blocks = (p as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks)) return false;
  return blocks.some((x: { type?: unknown; content?: unknown }) =>
    x.type === 'media' || (p.type === 'tool_result' && x.type === 'tool_result' && isDelegatedResultContent(x.content)));
}

/**
 * The read-model a fresh process rebuilds: the newest checkpoint's entries, the checkpoint, and
 * every entry after it (`tail`, in file order). Null when that would not equal a full read: a
 * checkpoint not written right behind its boundary, a rewind whose pivot it lacks (the projection
 * would skip the rewind), or a rewind back past the checkpoint's own compaction (R4b: the rewind
 * drops that compaction, and the projection falls back to an older one whose boundary the
 * checkpoint kept but whose summary it did not, so it would degrade). The caller reads in full;
 * the next compaction's checkpoint, written after the rewind, restores the fast path.
 */
export function rebuiltEntries(checkpoint: JournalEntry, tail: readonly JournalEntry[]): JournalEntry[] | null {
  const data = checkpointOf(checkpoint);
  if (!data) return null;
  // Written as one unit with its boundary (Journal.compact): anything between the two was written
  // by something else and is in neither, so such a checkpoint is never trusted.
  const boundary = data.entries.find((e) => e.uuid === data.boundaryUuid);
  if (!boundary || checkpoint.seq !== boundary.seq + 1 || checkpoint.parentUuid !== boundary.uuid) return null;
  const entries = [...data.entries.map(migrateEntry), checkpoint, ...tail];
  const seqOf = new Map(entries.map((e) => [e.uuid, e.seq]));
  for (const e of entries) {
    if (e.payload.type !== 'rewind_boundary') continue;
    const pivotSeq = seqOf.get(e.payload.pivotUuid);
    if (pivotSeq === undefined) return null;
    // Its window (pivot, marker) holds the checkpoint's boundary. One written before the checkpoint ends before it.
    if (pivotSeq < boundary.seq && e.seq > boundary.seq) return null;
  }
  return entries;
}

/**
 * R4b: does a rewind to `pivotUuid` need the whole file, on a read-model rebuilt from a checkpoint?
 * When the pivot is not in it, and when the pivot precedes its newest compaction: the rewind drops
 * that compaction and the projection falls back to an older one, whose summary the checkpoint did
 * not keep (only its boundary).
 */
export function rewindNeedsWholeFile(entries: readonly JournalEntry[], pivotUuid: string): boolean {
  const pivot = entries.find((e) => e.uuid === pivotUuid);
  if (!pivot) return true;
  let newestCompaction = -1;
  for (const e of entries) if (e.payload.type === 'compact_boundary') newestCompaction = Math.max(newestCompaction, e.seq);
  return pivot.seq < newestCompaction;
}

/**
 * Journal hydrate's read under JOURNAL_CHECKPOINT_V1: backwards from the end to the newest
 * checkpoint. `partial` is true when the read-model came from one (the bytes before it were never
 * read). A file with no checkpoint was read whole on the way (`partial` false, nothing is read
 * twice). Null when this cannot answer (a line that does not parse or validate, a checkpoint that
 * is not whole, a rewind it cannot place, a store without readBack): the caller reads forwards.
 */
export async function readFromCheckpoint(
  jsonl: Partial<Pick<JsonlStore, 'readBack'>>,
): Promise<{ entries: JournalEntry[]; partial: boolean; linesRead: number } | null> {
  const back = await jsonl.readBack?.(isCheckpoint);
  if (!back) return null;
  if (!back.stopped) return { entries: back.entries, partial: false, linesRead: back.linesRead };
  const entries = rebuiltEntries(back.stopped, back.entries);
  return entries ? { entries, partial: true, linesRead: back.linesRead } : null;
}

/** Every entry of the file, forwards (the mirror's owed() is asked about the whole of it). */
export async function wholeFile(jsonl: Pick<JsonlStore, 'read'>): Promise<JournalEntry[]> {
  const all: JournalEntry[] = [];
  for await (const e of jsonl.read()) all.push(e);
  return all;
}
