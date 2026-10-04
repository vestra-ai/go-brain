import { isContextEntry, type JournalEntry, type JournalPayload } from '../../contract/journal.js';
import type { InteractionOutcome } from '../../contract/interaction.js';
import { buildResolvedInteractionData } from '../interaction/strategy.js';
import { isCheckpoint } from './checkpoint.js';
import { liveSuspendedToolUseIds } from './journal.js';
import type { JsonlStore } from './jsonl-store.js';
import { mirrorWindow } from './mirror-clamp.js';
import type { SessionStore } from './session-store.js';

/**
 * TASK_FORK_V1 (harness to nine, R3): a new task that starts from another task's conversation as
 * it stood at the end of one of its turns.
 *
 * THE FORK POINT is a journal entry uuid, the ANCHOR: what the runner recorded as the leaf of the
 * task's journal when the turn ended (the turn's assistant row carries it as `sdk_message_uuid`,
 * apps/sandbox stream/fork-anchor.ts). Nothing is guessed from counting turns or comparing clocks:
 * an anchor the journal does not hold is refused. The cut runs through the anchor and on over what
 * that same turn wrote just after it ended: the result of a call it left open (an interrupt seal),
 * and the state records between. It stops at the first other context entry, and at any compaction
 * or rewind marker (those belong to what came next).
 *
 * WHAT THE CHILD GETS: the parent's entries up to the cut, uuid, parentUuid and seq unchanged (so
 * every compaction anchor, rewind pivot and parent link inside them still resolves), relabelled as
 * the child's own (taskId, and rootTaskId where it named the parent), then one `custom` entry keyed
 * {@link FORK_ORIGIN_KEY} naming the parent task, the anchor, and the latest token usage the parent
 * recorded at or before it (Codex's compaction `latest_token_usage_record`: a reader learns how
 * full the inherited context is without scanning back for it). The header goes AFTER the copy:
 * everything before it is inherited, everything after it is the child's, and a reader that must
 * not inherit something (the helper roster: apps/sandbox stream/teammate-registry.ts) resets at it.
 * A `custom` entry, not a new payload type: every validator, the server and an older runner
 * already accept it.
 *
 * NEVER PAUSED. A turn that ended on an ask still waiting for its answer (a live suspended
 * tool call) is no fork point: the caller refuses it ({@link forkStartsPaused}). Cutting before
 * that call instead would leave the round's assistant entry, whose verbatim replay channels
 * (anthropicBlocks, responsesOutput, geminiContent, chatMessage) carry the call itself, so the
 * child's first request would send a call with no result; cutting before the whole round would
 * start the child mid-turn while its copied transcript shows the paused turn. Refusing keeps the
 * child's journal a prefix that ends where a turn ended settled, in step with its transcript. An
 * ask the parent DEFERRED (its slot answered, the ask itself still open) is copied closed: it is
 * the parent's to answer, so the child never holds an open ask that no card of its own backs.
 *
 * WHAT IT DOES NOT GET: the parent's bill. A `usage` entry is copied with its cost zeroed (its token
 * counts kept: they describe the conversation), so the resume cost seed and the billing reconciler,
 * which both sum `raw.costUsd` over the journal, start the child at zero, as the copied message rows
 * do (duplicateMessagesForBranch strips their credit figures). A checkpoint (R2) is copied with its
 * data dropped, the shape the mirror clamp already gives a big one: its embedded copies would carry
 * the costs back in, and a child without one simply reads its journal in full.
 */
export const FORK_ORIGIN_KEY = 'fork_origin';

/** The fork header's data. */
export interface ForkOrigin {
  parentTaskId: string;
  /** The anchor: the parent entry the fork was taken at. */
  parentUuid: string;
  parentSeq: number;
  /**
   * The parent's last main-loop round at or before the cut, as the provider counted it: the
   * context the child inherits, so its totals start where the parent's stood. Absent when the
   * copy holds no such usage entry (a turn from before usage was journaled).
   */
  latestUsage?: ForkUsage;
}

/** One round's token usage, as a `usage` entry's `raw` records it. */
export interface ForkUsage {
  inputTokens: number;
  outputTokens: number;
  model?: string;
  /** The seq of the usage entry it was read from. */
  atSeq: number;
}

/** Where the cut falls, or -1 when the journal does not hold the anchor. */
export function forkCutIndex(entries: readonly JournalEntry[], anchorUuid: string): number {
  const at = entries.findIndex((e) => e.uuid === anchorUuid);
  if (at === -1) return -1;
  const open = new Set<string>();
  for (const e of entries.slice(0, at + 1)) {
    if (e.payload.type === 'tool_use') open.add(e.payload.toolUseId);
    else if (e.payload.type === 'tool_result') open.delete(e.payload.toolUseId);
  }
  let cut = at;
  for (let i = at + 1; i < entries.length && open.size > 0; i++) {
    const p = entries[i].payload;
    if (p.type === 'tool_result' && open.delete(p.toolUseId)) cut = i;
    else if (isContextEntry(entries[i]) || p.type === 'compact_boundary' || p.type === 'rewind_boundary') break;
  }
  return cut;
}

/** The child's journal: the parent's entries through `cut`, relabelled, then the fork header. */
export function forkEntries(
  parent: readonly JournalEntry[],
  cut: number,
  child: { taskId: string; uuid: string; timestamp: string },
): JournalEntry[] {
  const anchor = parent[cut];
  if (!anchor) throw new Error(`journal fork: no entry at cut ${cut}`);
  // An ask answered inside the copy keeps its record as it was: only one still open at the cut is closed.
  const answered = new Set<string>();
  for (const e of parent.slice(0, cut + 1)) if (e.payload.type === 'interaction' && e.payload.resolved) answered.add(e.payload.interactionId);
  const copied = parent.slice(0, cut + 1).map((e) => inherit(e, anchor.taskId, child.taskId, child.timestamp, answered));
  const last = copied[copied.length - 1];
  const latestUsage = latestUsageThrough(parent, cut);
  const origin: ForkOrigin = {
    parentTaskId: anchor.taskId, parentUuid: anchor.uuid, parentSeq: anchor.seq,
    ...(latestUsage ? { latestUsage } : {}),
  };
  copied.push({
    uuid: child.uuid, parentUuid: last.uuid, seq: last.seq + 1,
    taskId: child.taskId, rootTaskId: child.taskId, spawnDepth: 0, workspaceId: last.workspaceId,
    agentId: 'system', principal: { kind: 'system' }, timestamp: child.timestamp,
    payload: { type: 'custom', key: FORK_ORIGIN_KEY, data: origin },
  });
  return copied;
}

/** The fork header this entry carries, or null. */
export function forkOriginOf(e: JournalEntry): ForkOrigin | null {
  if (e.payload.type !== 'custom' || e.payload.key !== FORK_ORIGIN_KEY) return null;
  const d = e.payload.data as Partial<ForkOrigin> | null | undefined;
  if (typeof d?.parentTaskId !== 'string' || typeof d.parentUuid !== 'string' || typeof d.parentSeq !== 'number') return null;
  const u = d.latestUsage;
  const usage = u && typeof u.inputTokens === 'number' && typeof u.outputTokens === 'number' && typeof u.atSeq === 'number'
    ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens, atSeq: u.atSeq, ...(typeof u.model === 'string' ? { model: u.model } : {}) }
    : undefined;
  return { parentTaskId: d.parentTaskId, parentUuid: d.parentUuid, parentSeq: d.parentSeq, ...(usage ? { latestUsage: usage } : {}) };
}

/**
 * The last main-loop ROUND's `usage` entry at or before `cut` that names its tokens: never a
 * subagent's own rounds, and never a compaction or epilogue call (those measure another request,
 * e.g. the pre-compaction size). An entry without a `source` is from before sources were journaled.
 */
function latestUsageThrough(entries: readonly JournalEntry[], cut: number): ForkUsage | undefined {
  for (let i = cut; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.payload.type !== 'usage' || (e.agentPath?.length ?? 0) > 0) continue;
    const raw = e.payload.raw as { inputTokens?: unknown; outputTokens?: unknown; model?: unknown; source?: unknown } | undefined;
    if (raw?.source !== undefined && raw.source !== 'round') continue;
    if (typeof raw?.inputTokens !== 'number' || typeof raw.outputTokens !== 'number') continue;
    return { inputTokens: raw.inputTokens, outputTokens: raw.outputTokens, atSeq: e.seq, ...(typeof raw.model === 'string' ? { model: raw.model } : {}) };
  }
  return undefined;
}

/** True when the fork would start the child paused: a call in the copy still waits on an ask. */
export function forkStartsPaused(parent: readonly JournalEntry[], cut: number): boolean {
  return liveSuspendedToolUseIds(parent.slice(0, cut + 1)).size > 0;
}

/** What a copied open ask is closed with: the parent's to answer, never the child's. */
export const FORKED_ASK_CLOSED: InteractionOutcome = {
  behavior: 'deny',
  reason: 'aborted',
  message: 'This question belongs to the task this one was branched from; it is closed here.',
};

function inherit(e: JournalEntry, parentTaskId: string, childTaskId: string, closedAt: string, answered: ReadonlySet<string>): JournalEntry {
  const p = e.payload;
  const payload: JournalPayload =
    p.type === 'usage'
      ? { ...p, intelligence: 0, raw: p.raw !== null && typeof p.raw === 'object' ? { ...p.raw, costUsd: 0 } : p.raw }
      : isCheckpoint(e) && p.type === 'custom'
        ? { ...p, data: null }
        : p.type === 'interaction' && p.resolved === false && !answered.has(p.interactionId)
          ? { type: 'interaction', interactionId: p.interactionId, resolved: true, data: buildResolvedInteractionData(FORKED_ASK_CLOSED, closedAt) }
          : p;
  return {
    ...e,
    taskId: childTaskId,
    rootTaskId: e.rootTaskId === parentTaskId ? childTaskId : e.rootTaskId,
    payload,
  };
}

/** The child's journal file already exists: a fork never writes over a journal. */
export class ForkTargetExistsError extends Error {
  constructor(path: string) {
    super(`journal fork: ${path} already exists`);
    this.name = 'ForkTargetExistsError';
  }
}

/**
 * Write the child's journal as its whole file, all or nothing (JsonlStore.replaceWith: a temp file,
 * fsync'd, renamed into place, so a death part-way leaves no file, never a prefix: R5), and refuse
 * when the file is already there. The mirror is a separate step ({@link mirrorForkedJournal}): a
 * long journal's upload must not hold up the answer the server is waiting on.
 */
export async function writeForkedJournal(jsonl: JsonlStore, path: string, entries: readonly JournalEntry[]): Promise<void> {
  if ((await jsonl.mtimeMs()) !== null) throw new ForkTargetExistsError(path);
  await jsonl.replaceWith([...entries]);
}

/**
 * Hand the child's inherited entries to its mirror, in the same windows a journal's own flush uses,
 * so a box that opens the child cold (continue anywhere) reads the inherited history too: nothing
 * else would ever send it, since none of it was appended. A lossless mirror would also be sent what
 * it lacks at the child journal's first open (`owed`), so a failure here heals there.
 */
export async function mirrorForkedJournal(store: SessionStore, taskId: string, entries: readonly JournalEntry[]): Promise<void> {
  const whole = store.owed !== undefined;
  for (let pending: readonly JournalEntry[] = entries; pending.length > 0; ) {
    const { batch, wire } = mirrorWindow(pending, whole);
    await store.appendBatch(taskId, wire);
    pending = pending.slice(batch.length);
  }
}
