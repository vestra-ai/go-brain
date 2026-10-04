import { isContextEntry, type JournalEntry, type NewEntry } from '../../contract/journal.js';
import type { SubagentPathSegment } from '../../contract/subagent-path.js';
import type { ContentBlock } from '../../contract/blocks.js';
import type { InteractionKind, InteractionOutcome } from '../../contract/interaction.js';
import type { JsonlStore } from './jsonl-store.js';
import { errCode, errText, quarantineEvent } from './integrity-events.js';
import { MirrorSeqConflictError, MirrorShortError, type MirrorMarker, type SessionStore } from './session-store.js';
import type { Clock } from './clock.js';
import {
  planMaterialization,
  buildResolvedInteractionData,
  buildDeferredResultContent,
  computeSuspendedToolUseIds,
  isDeferredResultContent,
  WEAVE_REEXECUTE_TOOL,
} from '../interaction/strategy.js';
import { pruneScreenshots, type ScreenshotPrunePolicy } from '../compaction/prune-screenshots.js';
import { pruneSnapshots } from '../compaction/prune-snapshots.js';
import { applyMediaRail } from '../compaction/media-rail.js';
import { keepToolResultsAdjacent } from './result-adjacency.js';
import { forwardResumeBreadcrumbText, type ResolvedPause } from './resume-breadcrumb.js';
import { projectPlan, type PlanTodo } from './plan.js';
import { mirrorWindow } from './mirror-clamp.js';
import { awaitedLater, capTurnEndFlush } from './lossless-mirror.js';
import { mayHaveRunSideEffect, MAY_HAVE_RUN_MESSAGE } from './side-effect-classifier.js';
import { AutoFlushTimers } from './auto-flush.js';
import { checkpointEntry, readFromCheckpoint, rewindNeedsWholeFile, wholeFile } from './checkpoint.js';
import { keepLastToolResultPerId, projectScope } from './scope.js';
import { applyRewind } from './rewind.js';

export { keepLastToolResultPerId, projectScope } from './scope.js';

/** A composio re_execute directive from reconcileInteractions — the caller (T3) re-dispatches. */
export interface ReExecuteDirective {
  toolUseId: string;
  interactionId: string;
  kind: InteractionKind;
  toolName: string;
  /**
   * T11b (durable subagent deep-HITL, Phase B) — the bound tool_use's scope path,
   * copied from its journal entry header. PRESENT only when the pause was raised by a
   * subagent at depth ≥ 1 (the leaf inner tool_use is scope-tagged by T10): the
   * sandbox's `materializeReExecute` keys on it to route a subagent RE-ENTRY
   * (re-enter the leaf from journaled state) instead of a main-level leaf re-dispatch.
   * ABSENT for a main-agent pause and a flag-OFF collapse (bound to the `Agent`
   * tool_use, which carries no path) ⇒ the directive is byte-identical to today.
   */
  agentPath?: SubagentPathSegment[];
  /**
   * P3.3 (durable Weave pause) — the PENDING marker's captured-leaf hash, copied
   * onto a Weave-bound directive so the sandbox threads it into the script
   * re-dispatch as the one-shot approval/deny match key. Absent on every
   * non-Weave directive ⇒ byte-identical.
   */
  weavePending?: { contentHash: string; nodeSpecHash?: string; scopeId?: string };
}

/**
 * A forward-resume directive from reconcileInteractions — a pause that was DEFERRED
 * (its tool_use already answered by a `{status:'deferred'}` result while the binding
 * interaction stayed resolved:false) and has SINCE resolved. The deferred slot is
 * immutable (A6), so the kernel does NOT splice a second tool_result in place; it
 * settles the interaction row and signals the caller to continue forward as a fresh,
 * full-context turn.
 */
export interface ForwardResumeDirective {
  toolUseId: string;
  interactionId: string;
  kind: InteractionKind;
  toolName: string;
  outcome: InteractionOutcome;
}

export interface ReconcileResult {
  /** Resolved composio_auth interactions whose original tool must be re-run by the caller. */
  reExecute: ReExecuteDirective[];
  /** Deferred pauses that have since resolved → settle the row, continue forward (no in-place edit). */
  forwardResume: ForwardResumeDirective[];
}

/**
 * P3 (bounded drain) — the ONE source of the interrupt-seal wording. The plain
 * form is the historic heal text; the elapsed form is the drain-EXPIRY seal
 * (the dispatch outlived abort+grace, so the underlying command may still be
 * running — the journal tells the model/user that truthfully). The conformance
 * contract (`assertInterruptSeals`) prefix-matches `Interrupted by user.` so
 * BOTH wordings satisfy it — any rewording here ships with that assertion
 * updated in the same commit.
 */
export function interruptedSealText(elapsedMs?: number): string {
  return elapsedMs === undefined
    ? 'Interrupted by user.'
    : `Interrupted by user. [aborted after ${Math.round(elapsedMs / 1000)}s; the command may still be running]`;
}

/** A `resolved:false` interaction's binding info, keyed by the tool_use it paused. */
interface PendingInteraction {
  interactionId: string;
  kind: InteractionKind;
  toolName: string;
  /** P3.3 — the Weave pause's captured-leaf hash (see PendingInteractionData). */
  weavePending?: { contentHash: string; nodeSpecHash?: string; scopeId?: string };
}

/** Map toolUseId → its pending (resolved:false) interaction binding. */
function pendingInteractionsByToolUse(all: JournalEntry[]): Map<string, PendingInteraction> {
  const map = new Map<string, PendingInteraction>();
  for (const e of all) {
    if (e.payload.type !== 'interaction' || e.payload.resolved !== false) continue;
    const d = e.payload.data as {
      toolUseId?: string; kind?: InteractionKind; toolName?: string;
      weavePending?: { contentHash: string; nodeSpecHash?: string; scopeId?: string };
    } | undefined;
    if (typeof d?.toolUseId === 'string') {
      map.set(d.toolUseId, {
        interactionId: e.payload.interactionId,
        kind: (d.kind ?? 'custom') as InteractionKind,
        toolName: d.toolName ?? '',
        ...(d.weavePending !== undefined ? { weavePending: d.weavePending } : {}),
      });
    }
  }
  return map;
}

/**
 * SUSPEND a paused turn (spec §4): drop every `tool_use` that is bound to an
 * UNRESOLVED interaction and not yet answered, so the projected history ends on a
 * clean assistant/tool boundary the provider accepts (an orphan `tool_use` would
 * make the Messages/Responses API reject the request). PURE; runs on the RAW entry
 * list BEFORE `applyCompaction` (the precedence in §8.7). The durable JSONL keeps
 * the `tool_use` — this only shapes the projection. Identity (same reference) when
 * nothing is suspended.
 */
export function suspendPending(all: JournalEntry[]): JournalEntry[] {
  const suspended = computeSuspendedToolUseIds(all);
  if (suspended.size === 0) return all;
  return all.filter((e) => !(e.payload.type === 'tool_use' && suspended.has(e.payload.toolUseId)));
}

/**
 * K5-FIX-D: the suspended `tool_use`s that are STILL LIVE after compaction — the
 * ONLY ones that may block a continue from driving. `computeSuspendedToolUseIds`
 * over the RAW journal also flags a tool_use that was COMPACTED AWAY, because its
 * binding interaction's `resolved:false` survives forever (e.g. an abandoned or
 * cap-failed continue). But a compacted-away tool_use is gone from the model's
 * view — it is NOT an orphan the next turn would choke on — so it must never
 * strand future continues. Intersect with the post-compaction `tool_use`s so a
 * continue re-suspends ONLY for a genuinely-live unanswered tool. PURE.
 */
export function liveSuspendedToolUseIds(all: JournalEntry[]): Set<string> {
  const suspended = computeSuspendedToolUseIds(all);
  if (suspended.size === 0) return suspended;
  // P2.0: on anchor-loss this degrades to the pre-compaction live set (still
  // alive, never throws); the loud report fires from the Journal-owned call
  // sites (project/reconcile), which carry the onIntegrityEvent dep.
  const live = new Set(
    applyCompaction(all)
      .entries.filter((e) => e.payload.type === 'tool_use')
      .map((e) => (e.payload as { toolUseId: string }).toolUseId),
  );
  return new Set([...suspended].filter((id) => live.has(id)));
}

/**
 * Continue-alongside: for every LIVE-suspended tool_use, a deferred tool_result to
 * append so the slot is answered (the projection stops dropping it) while the
 * binding interaction stays resolved:false (resolvable later). Pure. Uses
 * liveSuspendedToolUseIds so a compacted-away pause is never re-materialized.
 */
export function planDeferrals(all: JournalEntry[], note?: string): { toolUseId: string; content: string }[] {
  return [...liveSuspendedToolUseIds(all)].map((toolUseId) => ({
    toolUseId,
    content: buildDeferredResultContent(note),
  }));
}

/**
 * P2.0 — a loud substrate-integrity signal. `compaction_anchor_missing`: a
 * compaction anchor (summary or firstKept entry) is missing from the readable
 * journal — the projection DEGRADES to the pre-compaction view instead of
 * throwing. `journal_line_quarantined`: the store routed a bad line to the
 * `.corrupt` sidecar (deduped there); the salvage fields identify what was lost
 * when the line was parseable JSON — e.g. a quarantined pending-interaction line
 * becomes VISIBLE instead of silently stubbing an approved tool.
 * `mirror_overflow_dropped`: the mirror stayed unreachable past the retry
 * buffer cap and the OLDEST pending entries were dropped from the mirror queue
 * (the local JSONL still has them — recovery is a backfill, not data loss).
 * `journal_append_failed`: the local JSONL write itself rejected — the entry is
 * NOT durable and the append still rejects to its caller; the event is what makes
 * the WHY visible, carrying the errno `code` (ruling R68). That code is the whole
 * point: the journal is the biggest writer on the box, so an out-of-space disk
 * announces itself here first, and a driver that can read `ENOSPC` off the event
 * can name the condition instead of logging one more failed turn.
 * The driver should surface all of these (raw HarnessEvent / server log).
 */
export type JournalIntegrityEvent =
  | { kind: 'compaction_anchor_missing'; boundaryUuid: string; detail: string }
  | {
      kind: 'journal_line_quarantined';
      lineNo: number;
      reason: 'parse' | 'shape' | 'version' | 'torn';
      payloadType?: string;
      toolUseId?: string;
      interactionId?: string;
    }
  | { kind: 'mirror_overflow_dropped'; count: number }
  /** A lossless mirror (JOURNAL_LOSSLESS_MIRROR_V1) is still unreachable past that cap: nothing is dropped. */
  | { kind: 'mirror_backlog'; count: number }
  /** Storage refused an entry whole for good (too large): the lossless mirror holds the plain clamp of it. */
  | { kind: 'mirror_whole_entry_refused'; seq: number; bytes: number }
  | { kind: 'journal_append_failed'; code?: string; detail: string }
  /** A task's FIRST turn (hintNew('first-turn')) could not read the mirror and started fresh. */
  | { kind: 'mirror_unreadable_started_fresh'; detail: string }
  | { kind: 'heal_failed'; interrupted: boolean; code?: string; detail: string } // the post-throw heal failed (engine/heal-on-error.ts)
  /** Continue anywhere: the local journal was behind or diverged from the mirror's top and was rebuilt from it.
   *  `unverifiable`: its line at the top's seq could not be read and nothing readable chained from the top. */
  | { kind: 'journal_caught_up'; verdict: 'behind' | 'diverged'; reason?: 'unverifiable'; mirrorMaxSeq: number; localMaxSeq: number }
  /** Continue anywhere: the mirror refused a flush because it holds different entries at those seqs. */
  | { kind: 'mirror_seq_conflict'; seqs: number[] }
  /** Continue anywhere: a failed rebuild could not put the local file back; it is kept at `aside` (null: there was none). */
  | { kind: 'journal_catch_up_undo_failed'; aside: string | null; detail: string };

/** What Journal.catchUp did to make the journal at least as new as the mirror's top (see there). */
export type CatchUpOutcome = 'current' | 'ahead' | 'hydrated' | 'rehydrated' | 'diverged';

export interface JournalDeps {
  taskId: string;
  workspaceId: string;
  jsonl: JsonlStore;
  mirror: SessionStore;
  clock: Clock;
  /** Called when a mirror batch fails (best-effort; never throws to the caller). */
  onMirrorError?: (err: unknown) => void;
  /** P2.0 — called when the journal detects an integrity degradation (see JournalIntegrityEvent). */
  onIntegrityEvent?: (e: JournalIntegrityEvent) => void;
  /**
   * Bedrock S5 P4 — cross-host recovery read. When true AND the local JSONL is
   * EMPTY, hydration falls back to `mirror.load(taskId)` and WRITES THROUGH the
   * fetched entries to the local JSONL (so the fresh machine now owns them). A
   * populated JSONL always wins and the mirror is never consulted — the volume
   * stays the source of truth. Wired to KERNEL_JOURNAL_MIRROR in query-manager;
   * OMITTED (falsy) everywhere else ⇒ hydration is byte-identical to today.
   */
  hydrateFromMirror?: boolean;
  /**
   * R5 — the tail of the journal this one replaces in the same process (`settled()` of a disposed
   * actor's journal): hydrate waits for it, so two Journals never write one file at once.
   */
  after?: Promise<unknown> | undefined;
  /** JOURNAL_CHECKPOINT_V1 (R2, checkpoint.ts): a compaction writes its replacement history, and a
   *  hydrate starts at the newest one. OMITTED ⇒ neither: byte-identical. */
  checkpoint?: boolean;
  /**
   * Continue anywhere (spec §6.3): when set, the journal flushes its mirror this many ms after its LAST
   * append, and at most twice this after a busy stretch's first append (auto-flush.ts), so a closed lid
   * loses at most the last few seconds. Wired ONLY on the Mac lane (JOURNAL_EAGER_MIRROR=1 with
   * CONTINUITY_JOURNAL_V1). Absent → flushes only at the turn boundary, exactly as before.
   */
  autoFlushMs?: number;
  screenshotPrune?: ScreenshotPrunePolicy; // SCREENSHOT_PRUNE_CACHE_V1 (prune-screenshots.ts); OMITTED ⇒ the legacy prune: byte-identical
}

export interface ConversationState {
  messages: JournalEntry[]; // context entries in order, post-compaction
  leaf: string | null;
  /**
   * K4C-3 D2: true when this projection LEADS with a compaction summary (a
   * compaction is in effect, so `messages[0]` is the stable summary head). The
   * engine threads this to the transport as `cachePrefixHint.summaryLeading` so a
   * token-aware transport can anchor a cache breakpoint on the stable prefix.
   * Absent/false on an uncompacted projection ⇒ byte-identical default.
   */
  compactionSummaryLeading?: boolean;
  /**
   * Phase 3 (§1.4) — the current todo list, folded from this scope's `plan`
   * entries (main-agent scope; a subagent's own todos are read via
   * `projectPlan(projectScope(all, childScope))` directly — see plan.ts).
   * Survives compaction (folded from the PRE-compaction `main` list, same as
   * every other non-context state channel) so a summarized-away todo still
   * shows up in the panel.
   */
  todos: PlanTodo[];
}

/**
 * A task's append-only journal: local JSONL is the durable source of truth, with a
 * best-effort mirror flushed off the turn's critical path.
 *
 * SINGLE-WRITER per task: exactly one harness loop owns a task's journal. The kernel
 * does not support multiple concurrent writers to the same task journal. As cheap
 * in-process insurance, appends are serialized through a private promise chain so that
 * uuid/parentUuid/seq/leaf are assigned atomically per append even if a caller fires
 * two appends without awaiting between them.
 */
export class Journal {
  private leafUuid: string | null = null;
  private nextSeq = 0;
  private hydration: Promise<void> | undefined;
  /** What a caller that knows this task is NEW told it (hintNew). */
  private newTask: 'minted' | 'first-turn' | undefined;
  private pendingMirror: JournalEntry[] = [];
  private projectionCache: { leaf: string | null; state: ConversationState } | null = null;
  /**
   * P2.8 — leaf-keyed memo of liveSuspendedToolUseIds(). The routing gate
   * (query-manager `_hasLiveSuspended`) queries the live-suspended set once per
   * dispatch; caching it by leaf makes a repeat query on an UNCHANGED journal O(1),
   * and it is provably consistent — it is the SCAN result, keyed by the same leaf
   * that gates projectionCache, nulled on every append + rematerialize. Chosen over a
   * parallel increment/decrement counter: the count is a non-local derivation
   * (resolved:false interaction ∩ unanswered tool_use ∩ post-compaction live), so a
   * counter maintained across the many HITL append sites would be drift-prone state
   * tracking existing state — this cache DERIVES the answer from the entries instead.
   */
  private liveSuspendedCache: { leaf: string | null; ids: Set<string> } | null = null;
  /** Serializes appends so concurrent callers can't interleave the leaf mutation. */
  private tail: Promise<unknown> = Promise.resolve();
  /**
   * P2.6 — the in-memory read-model: every journal entry, materialized ONCE by
   * doHydrate's full read and then kept in sync by doAppend (the entry object is
   * already in hand). project()/heal/reconcile/defer read THIS instead of
   * re-scanning the JSONL from disk every round. Disk stays the source of truth —
   * see materializedEntries for the external-mutation guard.
   */
  private entries: JournalEntry[] = [];
  /**
   * P2.6 — the JSONL mtime as of the last time `entries` was known to equal disk
   * (recorded at full materialization + refreshed lazily on the consume path). A
   * cheap `stat` on the consume path detects an EXTERNAL mutation (none in prod) and
   * forces a re-read through the quarantine pipeline. null = the file does not exist yet.
   */
  private entriesMtimeMs: number | null = null;
  /**
   * P2.6 — set by doAppend so the consume path can tell an mtime bump caused by OUR
   * own appends (read-model already in sync → just refresh the baseline) from an
   * EXTERNAL mutation (must re-read). Keeps append off the stat syscall entirely —
   * the append hot path stays byte-for-byte the cost it was, plus an O(1) array push.
   */
  private entriesDirtiedByAppend = false;
  /** R2 — the read-model came from a checkpoint: what a compaction dropped before it was never read. */
  private partial = false;

  constructor(private readonly deps: JournalDeps) {
    // P2.0 review fix — forward each (store-deduped) quarantined line as a loud
    // integrity event so substrate damage is visible the moment hydration sees it.
    // Optional-call: test doubles pass structural jsonl stubs without the hook.
    deps.jsonl.onBadLine?.((info) => this.reportIntegrity(quarantineEvent(info)));
  }

  /**
   * P2.0 review fix — the single integrity-report seam (public: the engine's post-throw heal reports through
   * it too). Driver dep first; else ONE loud console.warn line, so a degrade is never fully silent.
   */
  reportIntegrity(e: JournalIntegrityEvent): void {
    if (this.deps.onIntegrityEvent) {
      this.deps.onIntegrityEvent(e);
      return;
    }
    console.warn(`[JOURNAL_INTEGRITY] task=${this.deps.taskId} ${JSON.stringify(e)}`);
  }

  /** The task this journal owns (read-only). T10: lets a subagent loop tag its own
   *  scoped entries with the SAME task/tenant as the rest of this per-task journal,
   *  so the subagent journaling can't drift from the journal's actual identity. */
  get taskId(): string { return this.deps.taskId; }
  /** The tenant boundary (workspaceId) this journal owns (read-only). See `taskId`. */
  get workspaceId(): string { return this.deps.workspaceId; }

  /** Resolves once every append queued so far has landed (or failed): what a replacement waits on. */
  settled(): Promise<void> {
    return this.tail.then(() => undefined);
  }

  /** O(1) append: assign ids in-memory, write the local JSONL line, queue the mirror.
   *  Serialized via the tail chain to preserve the single-writer leaf/seq invariant. */
  append(e: NewEntry): Promise<JournalEntry> {
    const run = this.tail.then(() => this.doAppend(e));
    this.tail = run.catch(() => {}); // keep the chain alive even if one append rejects
    return run;
  }

  private async doAppend(e: NewEntry): Promise<JournalEntry> {
    await this.hydrate();
    const entry: JournalEntry = {
      ...e,
      uuid: this.deps.clock.uuid(),
      parentUuid: this.leafUuid,
      seq: this.nextSeq++,
      timestamp: e.timestamp || this.deps.clock.now(),
    };
    try {
      await this.deps.jsonl.append(entry); // local SoT — durable
    } catch (err) {
      // R68 — the write that fails FIRST when the disk fills is this one, and until
      // now its rejection only travelled up the promise chain, where it read as one
      // more failed turn. Reported here it keeps its errno, so a driver can name the
      // condition ('ENOSPC') rather than guess at a message. The append still
      // rejects: the entry is not durable, and no caller may be told otherwise.
      this.reportIntegrity({ kind: 'journal_append_failed', ...errCode(err), detail: errText(err) });
      throw err;
    }
    this.leafUuid = entry.uuid;
    this.entries.push(entry);            // P2.6: keep the read-model in sync (entry already in hand)
    this.entriesDirtiedByAppend = true;  // P2.6: our write bumped the file mtime (no stat on the hot path)
    this.projectionCache = null;         // invalidate derived state on append
    this.liveSuspendedCache = null;      // P2.8: the leaf advanced → recompute on next query
    this.pendingMirror.push(entry);      // mirror is flushed at turn boundary, NOT here
    if (this.deps.autoFlushMs !== undefined) this.autoFlush.arm(this.deps.autoFlushMs);
    return entry;
  }

  async leaf(): Promise<string | null> {
    await this.hydrate();
    return this.leafUuid;
  }

  /** P2.0 — mirror back-pressure cap: beyond this, drop OLDEST (loud event). A lossless store is
   *  never shed: past this it hears `mirror_backlog`, and the local JSONL holds what it lacks. */
  private static readonly MIRROR_MAX_BUFFER = 5_000;
  /** JOURNAL_LOSSLESS_MIRROR_V1: what the mirror lacks of the entries this journal opened with, asked
   *  at hydrate and put at the head of the queue by the first flush. */
  private owed: Promise<JournalEntry[]> | undefined;
  /** P2.0 — per-flush drain cap. flushMirror is awaited on the turn's critical path (before AGENT_END), so a
   *  recovered backlog must amortize across turn boundaries — 2 windows/turn — instead of stalling one turn on ~25 POSTs. */
  private static readonly MIRROR_WINDOWS_PER_FLUSH = 2;
  /** P2.0 — serializes overlapping flush calls onto ONE drain (unserialized splices interleave and can lose a window: neither sent nor re-queued). */
  private flushInFlight: Promise<void> | null = null;
  /** §6.2: the mirror refused a flush as a conflict; the next catch-up hydrates from it even if its marker matches. */
  private refusedByMirror = false;
  private checkingFile = false; // catchUp is re-reading a file changed from outside: no flush starts (doFlushMirror's head)
  /** deps.autoFlushMs: the debounce every append re-arms, and its max wait (auto-flush.ts). */
  private readonly autoFlush = new AutoFlushTimers(() => { void this.flushMirror(); });

  /** How many entries are still queued for the mirror: what the mirror would lack if this
   *  journal went now (a task's teardown reports it; the local JSONL holds them either way). */
  get pendingMirrorCount(): number { return this.pendingMirror.length; }

  /** The newest seq, and the oldest still queued for the mirror (undefined: none): a write-ahead's span (spec §6.3); leafNow: the newest uuid, unawaited (R3's fork anchor, fork.ts). */
  get topSeq(): number | undefined { return this.nextSeq > 0 ? this.nextSeq - 1 : undefined; }
  get oldestPendingSeq(): number | undefined { return this.pendingMirror[0]?.seq; }
  get leafNow(): string | null { return this.leafUuid; }
  /** True after the mirror refused a flush as a conflict, until a catch-up rebuilds from it; and whether this
   *  process has read the file yet (a first turn's catch-up pays that read: the cold case of spec §11a's gate). */
  get needsCatchUp(): boolean { return this.refusedByMirror; }
  get materialized(): boolean { return this.hydration !== undefined; }

  /** Flush queued entries to the mirror. Best-effort: never throws, never blocks a turn.
   *  P2.0 retry contract: the pending queue is cleared ONLY on a successful write — a failed window stays at
   *  the HEAD and the next turn-boundary flush retries it (the old code cleared first, so one failure dropped the batch forever). */
  flushMirror(): Promise<void> {
    if (this.flushInFlight) return this.flushInFlight; // concurrent callers await the SAME drain
    const run = this.doFlushMirror();
    this.flushInFlight = run.finally(() => { this.flushInFlight = null; });
    return this.flushInFlight;
  }

  /** The turn end's flush (flushTurnRecords). A lossless mirror is waited on at most TURN_END_FLUSH_MS: the
   *  drain goes on behind flushInFlight, its head leaves only on success, and owed() resends what the mirror lacks. */
  flushMirrorAtTurnEnd(capMs?: number): Promise<void> {
    return this.deps.mirror.owed ? capTurnEndFlush(this.flushMirror(), capMs) : this.flushMirror();
  }

  private async doFlushMirror(): Promise<void> {
    if (this.refusedByMirror || this.checkingFile) return; // §6.2: nothing more is sent until a catch-up rebuilds from the mirror
    const owed = this.owed;
    this.owed = undefined;
    for (let w = 0; w < Journal.MIRROR_WINDOWS_PER_FLUSH; w++) {
      try { // owed() rejects as a conflict when this file's entry at the mirror's top is another (§6.2): refused below
        if (owed && w === 0) this.pendingMirror = [...(await owed), ...this.pendingMirror]; // all older than anything appended since
        if (this.pendingMirror.length === 0) return;
        const { batch, wire } = mirrorWindow(this.pendingMirror, this.deps.mirror.owed !== undefined);
        await this.deps.mirror.appendBatch(this.deps.taskId, wire);
        this.pendingMirror.splice(0, batch.length); // clear ONLY on success (by ORIGINAL length)
      } catch (err) {
        // Head stays; the next turn-boundary flush retries from here.
        this.deps.onMirrorError?.(err);
        if (err instanceof MirrorSeqConflictError) {
          // Spec §6.2: another computer wrote this task. Stop flushing (the queue stays, the local
          // file keeps it) and make the next delivery's catch-up rebuild from the mirror.
          this.refusedByMirror = true;
          this.reportIntegrity({ kind: 'mirror_seq_conflict', seqs: err.conflicts.map((c) => c.seq) });
          return;
        }
        if (this.pendingMirror.length > Journal.MIRROR_MAX_BUFFER && this.deps.mirror.owed) {
          this.reportIntegrity({ kind: 'mirror_backlog', count: this.pendingMirror.length });
        } else if (this.pendingMirror.length > Journal.MIRROR_MAX_BUFFER) {
          const dropped = this.pendingMirror.splice(0, this.pendingMirror.length - Journal.MIRROR_MAX_BUFFER);
          // The local JSONL still has the dropped entries; a mirror backfill path is future recovery-slice work.
          this.reportIntegrity({ kind: 'mirror_overflow_dropped', count: dropped.length });
        }
        return;
      }
    }
    // Window budget spent with a backlog LEFT: chain the rest on a macrotask so it lands WITHOUT a next turn (prod task
    // 95076757, 2026-09-02: exactly 400 of a 16-minute turn's entries mirrored, the rest waited for a turn that never came).
    // flushMirror's in-flight guard serializes the chain; the catch above returns first, so a failure stops it (head-requeue retries at the next boundary).
    if (this.pendingMirror.length > 0) (setTimeout(() => { void this.flushMirror(); }, 0) as { unref?: () => void }).unref?.();
  }

  /**
   * P2.6 — the in-memory read-model backing project()/heal/reconcile/defer. Filled
   * once by doHydrate, kept in sync by doAppend, so the whole-file re-scan those four
   * used to do EACH round is gone. Disk stays the source of truth: a cheap mtime stat
   * detects an EXTERNAL mutation of the JSONL (nothing writes it out-of-band in prod)
   * and re-reads through the SAME quarantine pipeline as hydrate (read() → validate →
   * migrate), never a raw parse. Returns the live array by REFERENCE — every consumer
   * derives a filtered/sorted copy (project) or snapshots what it needs before it
   * appends (heal/reconcile/defer), so no defensive per-round copy is needed.
   */
  private async materializedEntries(): Promise<JournalEntry[]> {
    await this.hydrate();
    const mtime = await this.deps.jsonl.mtimeMs();
    if (mtime === this.entriesMtimeMs) return this.entries; // untouched since last sync
    if (this.entriesDirtiedByAppend) {
      // OUR appends bumped the mtime; the read-model is already in sync — just
      // rebaseline. (A concurrent external writer would need to violate the
      // single-writer invariant to race here; none exists in prod.)
      this.entriesMtimeMs = mtime;
      this.entriesDirtiedByAppend = false;
      return this.entries;
    }
    await this.rematerialize(); // mtime moved with no append of ours → external mutation
    return this.entries;
  }

  /** P2.6 — an external mutation was detected: re-read the whole JSONL through the
   *  quarantine pipeline and replace the read-model. Leaf/seq are NOT advanced (a
   *  disk-scanning project() never moved them either); the stale derived cache is
   *  dropped so the next projection recomputes over the fresh entries. */
  private async rematerialize(): Promise<void> {
    const fresh: JournalEntry[] = [];
    for await (const entry of this.deps.jsonl.read()) fresh.push(entry);
    this.entries = fresh;
    this.entriesMtimeMs = await this.deps.jsonl.mtimeMs();
    this.entriesDirtiedByAppend = false;
    this.partial = false;
    this.projectionCache = null;
    this.liveSuspendedCache = null; // P2.8: entries replaced → drop the derived live-suspended memo
  }

  /** The message list the model sees. Warm = O(1) from cache; cold = streamed replay. */
  async project(): Promise<ConversationState> {
    await this.hydrate();
    if (this.projectionCache && this.projectionCache.leaf === this.leafUuid) {
      return this.projectionCache.state;
    }
    const all = await this.materializedEntries();
    // T11a: the MAIN context projection is SCOPED to the main agent — subagent-scoped
    // entries (those carrying an `agentPath`, written by a nested subagent loop) are
    // excluded so a subagent's inner conversation never leaks into the main agent's model
    // context. The exclusion is applied to the SAME list `suspendPending` and
    // `projectionLeadsWithSummary` consume, so all three stay consistent. A journal with
    // NO subagent entries ⇒ `main` deep-equals `all` ⇒ the pipeline below is
    // byte-identical to before T11a (the no-subagent path).
    // The whole-journal suspension scans (liveSuspendedToolUseIds / computeSuspended…)
    // stay depth-blind BY DESIGN — they are not re-scoped here.
    // T11b: a real tool_result SUPERSEDES an earlier one for the same tool_use id — the
    // subagent RE-ENTRY answers the parent `Agent` tool_use (A1) for real, but A1 already
    // carries the pause's {status:'deferred'} placeholder; two tool_results for one id is a
    // malformed request. Keep-last-per-id keeps the real answer. Identity (same contents)
    // for every journal with ≤1 result per id ⇒ flag-off / depth-0 deferred / normal turns
    // are byte-identical. Runs on the main scope (the only place A1's pair lives).
    const main = keepLastToolResultPerId(projectScope(all, undefined));
    // P2.4: applyRewind runs BEFORE suspend+compaction — it drops the abandoned span
    // (context appended after the pivot but before the last rewind_boundary) so the
    // model sees history as of the pivot. Non-context state survives; identity (same
    // reference) when no rewind_boundary exists ⇒ byte-identical to the no-rewind path.
    const rewound = applyRewind(main);
    // K5: suspendPending runs on the RAW list BEFORE applyCompaction (§8.7 precedence)
    // — a tool_use paused on an unresolved interaction is dropped from the projection
    // so the model never sees an orphan tool_use; the durable JSONL keeps it.
    //
    // Task 6: pruneScreenshots is the SINGLE native screenshot-prune authority. It
    // runs LAST — on the POST-compaction context list — so "keep latest 2" = the
    // latest 2 image-bearing tool_results the model will actually see (running it on
    // the raw `all` could keep 2 that compaction then drops → zero real screenshots).
    // It never deletes/reorders entries (tool_use↔tool_result pairing + the
    // leading-compaction-summary invariant below both stay valid) and is projection-
    // only — the raw append-only JSONL is never mutated. Identity (same reference)
    // when there are ≤2 image-bearing tool_results, so the non-browser path is free.
    //
    // Cobrowse P1: pruneSnapshots chains immediately after — the text twin for
    // stale AX page-snapshots, under the same contract (post-compaction, never
    // deletes, identity when ≤2). It is DATA-gated: it matches the
    // SNAPSHOT_TEXT_HEADER line only the BROWSER_PERCEPTION_V2 snapshot renderer
    // emits, so the kernel stays env-free and flag-off is byte-identical for free.
    const compaction = applyCompaction(suspendPending(rewound), (info) =>
      this.reportIntegrity({ kind: 'compaction_anchor_missing', ...info }),
    );
    // Media-refs S0: applyMediaRail runs LAST — the physics bound (count+bytes) over ALL image blocks the
    // model will see: user uploads, and Read-tool images, which skip the screenshot prune under
    // SCREENSHOT_PRUNE_CACHE_V1 (without it that prune counts them). Identity under budget: byte-identical.
    // keepToolResultsAdjacent runs FIRST on the context list: a result the journal
    // recorded after a later turn (live 28edef30) moves back beside its call, so the
    // prunes and every wire dialect see the pairing the providers require. Identity
    // for every journal the live loop writes.
    const messages = applyMediaRail(
      pruneSnapshots(pruneScreenshots(keepToolResultsAdjacent(compaction.entries.filter(isContextEntry)), this.deps.screenshotPrune)), this.deps.screenshotPrune?.rail,
    );
    // K4C-3 D2: the projection leads with a compaction summary iff a compaction is
    // in effect — `applyCompaction` then puts the summary entry FIRST and it
    // survives `isContextEntry`, so `messages[0].uuid === lastBoundary.summaryUuid`.
    const compactionSummaryLeading = projectionLeadsWithSummary(rewound, messages); // R4b: a compaction a rewind dropped never leads
    // Phase 3 (§1.4): fold from `main` (pre-compaction, pre-suspend) — todos are
    // non-context state (CONTEXT_POLICY:false) and must survive compaction/
    // suspension exactly like `mode`/`interaction` entries do.
    const todos = projectPlan(main);
    const state: ConversationState = { messages, leaf: this.leafUuid, compactionSummaryLeading, todos };
    // P2.0: a DEGRADED projection (lost compaction anchor) is never cached — the
    // anchor may be restored (e.g. mirror recovery), so recompute next round.
    if (!compaction.degraded) {
      this.projectionCache = { leaf: this.leafUuid, state };
    }
    return state;
  }

  /** Stream raw entries from the local JSONL file (public for transcript adapters). */
  read(): AsyncIterable<JournalEntry> {
    return this.deps.jsonl.read();
  }

  /**
   * P2.8 — the raw in-memory read-model as a per-dispatch SNAPSHOT: every journal
   * entry in append order, materialized ONCE at hydration (P2.6) and kept in sync by
   * doAppend, behind the SAME mtime-guarded external-mutation check project() uses.
   * The per-dispatch scan helpers (construction-params, cost-seed, live-suspended,
   * step-memo) read THIS instead of re-opening + re-parsing the WHOLE JSONL from disk
   * on every call — the read-amplification that made native-arm TTFT scale with
   * conversation length (one dispatch drained the file 3–5×). Byte-identical entries
   * to draining read() (the read-model is filled via the same validate/migrate
   * pipeline), and disk stays the source of truth. Returns the live array by
   * REFERENCE, readonly to callers: every consumer only reads or derives a copy.
   */
  async snapshot(): Promise<readonly JournalEntry[]> {
    return this.materializedEntries();
  }

  /**
   * P2.8 — the LIVE-suspended tool_use ids (see liveSuspendedToolUseIds), memoized by
   * leaf so a repeat query on an unchanged journal is O(1) (the routing gate reads it
   * once per dispatch). Reads the in-memory read-model — no disk. Provably equal to a
   * fresh `liveSuspendedToolUseIds(await snapshot())`; the invariant test asserts that
   * equality across arbitrary suspend/resume/compaction sequences.
   */
  async liveSuspendedIds(): Promise<Set<string>> {
    const all = await this.materializedEntries();
    if (this.liveSuspendedCache && this.liveSuspendedCache.leaf === this.leafUuid) {
      return this.liveSuspendedCache.ids;
    }
    const ids = liveSuspendedToolUseIds(all);
    this.liveSuspendedCache = { leaf: this.leafUuid, ids };
    return ids;
  }

  /** Force the durable JSONL to disk — the abort-seal barrier (D4). The store is
   *  private, so this is the public seam the engine awaits after healOnError. */
  async fsync(): Promise<void> {
    await this.deps.jsonl.fsync();
  }

  /** Move the leaf pointer; subsequent appends fork from there (rewind/fork). */
  async branch(fromUuid: string): Promise<void> {
    await this.hydrate();
    this.leafUuid = fromUuid;
    this.projectionCache = null;
  }

  /**
   * P2.4 — rewind the projected CONTEXT to a chosen pivot entry. Appends a durable
   * `rewind_boundary` (non-context) recording the pivot, then forks the leaf via
   * `branch` so subsequent appends continue FROM the pivot. project() then excludes
   * the abandoned span (context after the pivot, before this marker) via applyRewind.
   * Disk is never rewritten and non-context state (todos/usage/interactions) is
   * untouched — a rewind rewinds the conversation, not the accounting. Idempotent
   * across resume: the marker + fork rebuild identically from the durable journal.
   */
  async rewindTo(pivotUuid: string): Promise<void> {
    await this.hydrate(); // R2: a pivot a checkpoint dropped is read back, whole file, before the marker
    if (this.partial && rewindNeedsWholeFile(this.entries, pivotUuid)) await this.rematerialize(); // R4b: and one before its compaction (checkpoint.ts)
    await this.append({
      taskId: this.deps.taskId, rootTaskId: this.deps.taskId, spawnDepth: 0,
      workspaceId: this.deps.workspaceId, agentId: 'system', principal: { kind: 'system' },
      timestamp: '', payload: { type: 'rewind_boundary', pivotUuid },
    });
    await this.branch(pivotUuid);
  }

  /** Append a compact_boundary entry. The summary/relink content is produced by the
   *  context engine (K4); here we only record the splice durably. */
  async compact(splice: {
    summaryUuid: string; preservedUuids: string[]; firstKeptId: string;
    trigger: 'auto' | 'manual'; preTokens: number; postTokens: number;
    base: Omit<NewEntry, 'payload'>;
  }): Promise<JournalEntry> {
    const { base, ...b } = splice;
    const boundaryEntry: NewEntry = { ...base, payload: { type: 'compact_boundary', ...b } };
    if (!this.deps.checkpoint) return this.append(boundaryEntry);
    // R2: the boundary and its checkpoint are ONE unit on the tail chain, so no other append (a
    // helper's, a usage row) lands between them; the reader trusts only a checkpoint at boundary+1.
    const run = this.tail.then(async () => {
      const boundary = await this.doAppend(boundaryEntry);
      const checkpoint = checkpointEntry(this.entries, boundary);
      if (checkpoint) await this.doAppend(checkpoint).catch(() => {}); // a cache: its failure is reported, never the compaction's
      return boundary;
    });
    this.tail = run.catch(() => {});
    return run;
  }

  /** Make the chain replayable against any provider: every tool_use must have a
   *  tool_result. On crash/interrupt, synthesize error results for orphans —
   *  EXCEPT a tool_use SUSPENDED on an unresolved interaction (K5): explained (the human
   *  is mid-response), not crashed; the continue path materializes it later, and a stub
   *  here would collide with the real resolution. `crashSealText` (L6 crash resume): a benign crash orphan's text in
   *  place of the empty stub; `mayHaveRunText`: the may-have-run card's, e.g. a step another device's close cut. */
  async healOrphanedToolUse(interrupted = false, crashSealText?: string, mayHaveRunText?: string): Promise<void> {
    const all = await this.materializedEntries();
    const seen = new Set<string>();
    const answered = new Set<string>();
    // F1: capture each tool_use's name+input so the crash-heal can classify a may-have-run
    // side effect and seal a fail-closed "verify" card for it.
    const toolInfo = new Map<string, { name: string; input: unknown }>();
    for (const e of all) {
      if (e.payload.type === 'tool_use') {
        seen.add(e.payload.toolUseId);
        toolInfo.set(e.payload.toolUseId, { name: e.payload.name, input: e.payload.input });
      }
      if (e.payload.type === 'tool_result') answered.add(e.payload.toolUseId);
    }
    const suspended = computeSuspendedToolUseIds(all); // K5: bound to an unresolved interaction
    for (const id of seen) {
      if (answered.has(id)) continue;
      if (suspended.has(id)) continue; // suspended, not orphaned — the continue materializes it
      await this.append(this.synthesizedErrorResult(id, interrupted, toolInfo.get(id), undefined, crashSealText, mayHaveRunText));
    }
  }

  /**
   * P3 (bounded drain) — seal ONE tool_use whose in-flight dispatch outlived the
   * post-abort grace window, with the truthful elapsed wording
   * (`interruptedSealText(elapsedMs)`). Appended through the NORMAL append path
   * (the P2.6 read-model stays in sync), so the abort catch's later
   * healOrphanedToolUse sees this id as answered and never double-seals it.
   */
  async sealInterruptedToolUse(toolUseId: string, elapsedMs: number): Promise<JournalEntry> {
    return this.append(this.synthesizedErrorResult(toolUseId, true, undefined, elapsedMs));
  }

  private synthesizedErrorResult(
    toolUseId: string,
    interrupted = false,
    toolInfo?: { name: string; input: unknown },
    elapsedMs?: number, crashSealText?: string, mayHaveRunText = MAY_HAVE_RUN_MESSAGE,
  ): NewEntry {
    // D3: scoped interrupt text. ONLY a genuine user-abort (interrupted=true) seals
    // with a NON-EMPTY "Interrupted by user." text block — converter-safe (the
    // journal→provider converter keeps only text blocks), giving the model a truthful
    // signal on redirect and rendering as the UI's Interrupted card. P3: a drain-expiry
    // seal (elapsedMs set) carries the aborted-after wording — the dispatch outlived
    // abort+grace, so the underlying command may still be running.
    //
    // F1 (Weave Phase 2b, design §6.2/§8-F1): a CRASH orphan (interrupted=false) of a
    // MAY-HAVE-RUN side-effecting tool (a `curl -X POST`, a Composio send) seals a
    // fail-closed "verify before retrying" card instead of the neutral empty stub — so a
    // re-fired external side effect is never SILENTLY invited on resume (a clean error would
    // read as "it failed", and the model might blindly re-send). A benign crash orphan is never
    // labeled an interrupt: the NEUTRAL empty stub, or the caller's `crashSealText` (L6 resume).
    // Classified from the journaled tool name+input → no schema change, crash-heal path only.
    const blocks: ContentBlock[] = interrupted
      ? [{ type: 'text', text: interruptedSealText(elapsedMs) } as ContentBlock]
      : toolInfo && mayHaveRunSideEffect(toolInfo.name, toolInfo.input)
        ? [{ type: 'text', text: mayHaveRunText } as ContentBlock]
        : crashSealText ? [{ type: 'text', text: crashSealText } as ContentBlock] : [];
    return {
      taskId: this.deps.taskId, rootTaskId: this.deps.taskId, spawnDepth: 0,
      workspaceId: this.deps.workspaceId,
      agentId: 'system', principal: { kind: 'system' }, timestamp: '',
      payload: {
        type: 'tool_result',
        toolUseId,
        blocks,
        isError: true,
      },
    };
  }

  /**
   * The CONTINUE path's kernel reconciliation (spec §6/§8) — "how to proceed after
   * a resolution trigger." For every orphan `tool_use` (no `tool_result` yet):
   *  - bound to a `resolved:false` interaction → fetch its outcome via the injected,
   *    DB-free `getResolution`:
   *      • outcome present → `planMaterialization(kind, outcome)`:
   *          - `result` → MATERIALIZE: append the real `tool_result` from the outcome
   *            (unless the bound `tool_use` was already compacted away — then no-op:
   *            append nothing to context, §7) + append the resolution `interaction`
   *            entry to settle it.
   *          - `re_execute` (composio_auth) → collect a directive; append NOTHING
   *            (the caller/T3 re-dispatches the original tool, then appends both).
   *      • outcome null (still pending) → leave suspended (project() suspends it).
   *  - bound to NO interaction → a true crash orphan → synthesize an error stub
   *    (subsumes healOrphanedToolUse). The interaction-bound branch ALWAYS precedes
   *    the synthesize branch.
   *
   * Idempotent: an orphan that already has a `tool_result` is skipped, so a replay
   * or double-trigger appends nothing. The kernel never reads the DB — the server
   * hands resolutions in via `getResolution`.
   */
  async reconcileInteractions(
    getResolution: (interactionId: string) => Promise<InteractionOutcome | null>,
  ): Promise<ReconcileResult> {
    const all = await this.materializedEntries();

    const answered = new Set<string>();
    const toolUses = new Map<string, string>(); // toolUseId → name
    // F1: toolUseId → input, so a true-crash-orphan of a may-have-run side-effecting tool
    // heals to a fail-closed "verify" card (design §6.2/§8-F1).
    const toolInput = new Map<string, unknown>();
    // T11b — toolUseId → its scope path (T10 scope-tags a subagent's inner tool_use).
    // Stamped onto the re_execute directive so the sandbox routes a subagent RE-ENTRY.
    const toolUseAgentPath = new Map<string, SubagentPathSegment[]>();
    for (const e of all) {
      if (e.payload.type === 'tool_result') answered.add(e.payload.toolUseId);
      else if (e.payload.type === 'tool_use') {
        toolUses.set(e.payload.toolUseId, e.payload.name);
        toolInput.set(e.payload.toolUseId, e.payload.input);
        if (e.agentPath && e.agentPath.length) toolUseAgentPath.set(e.payload.toolUseId, e.agentPath);
      }
    }
    const pending = pendingInteractionsByToolUse(all);
    const liveAfterCompaction = new Set(
      applyCompaction(all, (info) =>
        this.reportIntegrity({ kind: 'compaction_anchor_missing', ...info }),
      )
        .entries.filter((e) => e.payload.type === 'tool_use')
        .map((e) => (e.payload as { toolUseId: string }).toolUseId),
    );

    const reExecute: ReExecuteDirective[] = [];
    const forwardResume: ForwardResumeDirective[] = [];

    // Map toolUseId → its tool_result TEXT, scanned alongside `answered`. A tool_result
    // payload is { toolUseId; blocks: ContentBlock[]; isError? } — its content lives in a
    // text block, NOT a top-level `.content` field.
    const resultText = (blocks: { type?: string; text?: string }[] | undefined): string =>
      (blocks?.find((b) => b.type === 'text')?.text) ?? '';
    const resultContent = new Map<string, string>();
    for (const e of all) {
      if (e.payload.type === 'tool_result') {
        resultContent.set(e.payload.toolUseId, resultText(e.payload.blocks as { type?: string; text?: string }[]));
      }
    }

    // FORWARD-RESUME (A6): a pause that was DEFERRED (slot answered with a
    // `{status:'deferred'}` result while the interaction stayed resolved:false) and has
    // SINCE resolved → settle the row + emit a directive. The deferred slot is immutable,
    // so we never splice a second tool_result; the caller continues forward as a fresh
    // turn. A still-pending deferral (getResolution null) stays deferred.
    for (const [toolUseId, p] of pending) {
      const content = resultContent.get(toolUseId);
      if (content === undefined || !isDeferredResultContent(content)) continue; // not a deferred-open pause
      const outcome = await getResolution(p.interactionId);
      if (!outcome) continue; // still pending → stay deferred
      await this.append(this.resolvedInteractionEntry(p.interactionId, outcome)); // settle the row
      forwardResume.push({ toolUseId, interactionId: p.interactionId, kind: p.kind, toolName: p.toolName, outcome });
    }

    for (const [toolUseId, name] of toolUses) {
      if (answered.has(toolUseId)) continue; // already complete (incl. deferred) — idempotent no-op
      const p = pending.get(toolUseId);
      if (!p) {
        // A SCOPE-TAGGED tool_use (a subagent's inner call, agentPath-stamped) is NOT a
        // main-scope crash orphan: it lives in the subagent scope (the main projection
        // excludes it) and is settled by the subagent re-entry, not here. Synthesizing a
        // MAIN-scope heal for it planted a reverse-orphan tool_result the projection then
        // had to strip (live task 1067a95b: the weave node's inner Bash got a bogus
        // main-scope error result). Only a MAIN-scope orphan is a real crash to seal.
        if (toolUseAgentPath.has(toolUseId)) continue;
        // true crash orphan — F1: seal a fail-closed may-have-run card for a side-effecting tool.
        await this.append(this.synthesizedErrorResult(toolUseId, false, { name, input: toolInput.get(toolUseId) }));
        continue;
      }
      const outcome = await getResolution(p.interactionId);
      if (!outcome) continue; // still pending → re-suspend
      // native-redrive: pass the bound tool name so a subagent (`Agent`) pause
      // re-executes (re-spawns the subagent) instead of materializing
      // `{"status":"allowed"}` as the Agent tool_use's result.
      const plan = planMaterialization(p.kind, outcome, p.toolName);
      // T11b (Phase-B DENY gap) — a SCOPE-TAGGED bound tool_use (the leaf inner tool of a
      // depth-≥1 subagent pause) routes through subagent RE-ENTRY for BOTH allow AND deny.
      // `planMaterialization` returns `result` for ANY deny, which would otherwise take the
      // `resolution_is_result` branch below and materialize the leaf's declined result
      // UNSCOPED into the MAIN journal — an orphan (its tool_use is scope-tagged away) that
      // also strands the parent `Agent` tool_use on its {status:'deferred'} placeholder. The
      // re_execute directive carries the agentPath, so the sandbox re-enters the subagent
      // with a scope-tagged declined leaf result, lets it react, and settles the parent —
      // exactly like the allow path. A main-agent / flag-OFF pause has no agentPath ⇒
      // `isScopeTagged` is false ⇒ the routing below is byte-identical to today (an allow
      // tool_permission/composio_auth still re_executes; a main-agent deny still materializes).
      const agentPath = toolUseAgentPath.get(toolUseId);
      const isScopeTagged = agentPath !== undefined && agentPath.length > 0;
      // P3.3 (durable Weave pause) — a pause BOUND to a `Weave` tool_use is keyed on
      // the JOURNALED tool_use name (the PENDING marker's toolName is the LEAF call's
      // name, what the approval card shows). It routes to a re_execute directive for
      // ALLOW *and* DENY: the sandbox re-dispatches the SCRIPT with a one-shot leaf
      // decision, so a deny completes the script PAST the denied node (mirroring the
      // T11b scope-tagged-deny precedent) — the deny prose must never settle as the
      // Weave tool_result (the model expects WeaveOutput JSON there).
      const isWeaveBound = name === WEAVE_REEXECUTE_TOOL;
      if (plan.action === 're_execute' || isScopeTagged || isWeaveBound) {
        // §8.7 no-op: a re_execute tool_use (a REAL side-effect, e.g. GMAIL_SEND_EMAIL)
        // compacted away before resolution must NOT be re-dispatched — that re-sends the
        // email AND orphans a tool_result for a tool_use the projection no longer contains.
        // Same guard the resolution_is_result branch already applies; only settle the row.
        if (liveAfterCompaction.has(toolUseId)) {
          reExecute.push({
            toolUseId, interactionId: p.interactionId, kind: p.kind,
            // P3.3 — a Weave-bound directive carries the TOOL_USE name so the sandbox
            // re-dispatches the Weave tool, never the leaf; every other directive keeps
            // the marker-first fallback verbatim.
            toolName: isWeaveBound ? name : (p.toolName || name),
            // T11b — conditional spread: a main-agent / flag-OFF directive omits the key
            // entirely (path-less), byte-identical to today.
            ...(isScopeTagged ? { agentPath } : {}),
            ...(isWeaveBound && p.weavePending !== undefined ? { weavePending: p.weavePending } : {}),
          });
          continue; // T3 re-dispatches + appends the result + the resolved interaction entry
        }
        await this.append(this.resolvedInteractionEntry(p.interactionId, outcome));
        continue;
      }
      // resolution_is_result: materialize in place (unless compacted away → no-op).
      if (liveAfterCompaction.has(toolUseId)) {
        await this.append(this.materializedResult(toolUseId, plan.content, plan.isError));
      }
      await this.append(this.resolvedInteractionEntry(p.interactionId, outcome));
    }
    return { reExecute, forwardResume };
  }

  /**
   * Append a deferred tool_result for each live-suspended tool_use so the user's
   * NEXT turn runs off a valid history, WITHOUT resolving the interaction. The
   * pause stays resolvable; a late resolution becomes a forward continuation
   * (reconcileInteractions forwardResume branch), never a retroactive edit.
   */
  async deferSuspended(note?: string): Promise<string[]> {
    const all = await this.materializedEntries();
    const deferrals = planDeferrals(all, note);
    for (const d of deferrals) {
      await this.append(this.materializedResult(d.toolUseId, d.content, false));
    }
    return deferrals.map((d) => d.toolUseId);
  }

  /**
   * Forward-resume breadcrumb (HITL T5): a DEFERRED pause has SINCE resolved
   * (reconcileInteractions emitted a forwardResume directive). The deferred slot is
   * immutable (A6) — we do NOT splice a second tool_result. Instead we append ONE
   * user-role entry framed as a SYSTEM notification so the model re-decides the
   * deferred work as a fresh, full-context turn (the `[SYSTEM_RESUME]` pattern applied
   * FORWARD). It occupies a user-role slot — the only slot the provider APIs accept as
   * the latest message the model answers — but is attributed to the SYSTEM principal,
   * NOT the human (`agentId: 'system'`, `principal: { kind: 'system' }`), so it is never
   * mistaken for a user message. One combined entry names every resolved tool, worded by
   * its kind and outcome (resume-breadcrumb.ts). Returns the appended entry. No new
   * JournalPayload kind — it is an ordinary `user` entry.
   */
  async appendForwardResumeBreadcrumb(resolved: readonly ResolvedPause[]): Promise<JournalEntry> {
    const text = forwardResumeBreadcrumbText(resolved);
    return this.append({
      taskId: this.deps.taskId, rootTaskId: this.deps.taskId, spawnDepth: 0,
      workspaceId: this.deps.workspaceId,
      agentId: 'system', principal: { kind: 'system' }, timestamp: '',
      payload: { type: 'user', blocks: [{ type: 'text', text } as ContentBlock] },
    });
  }

  /**
   * World-delta breadcrumb (HITL T3): a resume that arrives long after the pause (or on a
   * recycled runner) gets a system notice so the model does not assume filesystem/process
   * state survived. Same entry shape/principal as appendForwardResumeBreadcrumb — a user-
   * role slot (the only slot the provider APIs accept as the latest message) attributed to
   * the SYSTEM principal ({kind:'system'}), never the human. The engine builds the text
   * (humanDuration lives in the engine, beside worldDeltaMeetsThreshold; the kernel must
   * not import the engine) and passes it in. Returns the appended entry.
   */
  async appendWorldDeltaBreadcrumb(text: string): Promise<JournalEntry> {
    return this.append({
      taskId: this.deps.taskId, rootTaskId: this.deps.taskId, spawnDepth: 0,
      workspaceId: this.deps.workspaceId,
      agentId: 'system', principal: { kind: 'system' }, timestamp: '',
      payload: { type: 'user', blocks: [{ type: 'text', text } as ContentBlock] },
    });
  }

  private materializedResult(toolUseId: string, content: string, isError: boolean): NewEntry {
    return {
      taskId: this.deps.taskId, rootTaskId: this.deps.taskId, spawnDepth: 0,
      workspaceId: this.deps.workspaceId,
      agentId: 'system', principal: { kind: 'system' }, timestamp: '',
      payload: {
        type: 'tool_result', toolUseId, isError,
        blocks: [{ type: 'text', text: content } as ContentBlock],
      },
    };
  }

  private resolvedInteractionEntry(interactionId: string, outcome: InteractionOutcome): NewEntry {
    return {
      taskId: this.deps.taskId, rootTaskId: this.deps.taskId, spawnDepth: 0,
      workspaceId: this.deps.workspaceId,
      agentId: 'system', principal: { kind: 'system' }, timestamp: '',
      payload: {
        type: 'interaction', interactionId, resolved: true,
        data: buildResolvedInteractionData(outcome, this.deps.clock.now()),
      },
    };
  }

  /** Told by a caller that KNOWS the task is new, before its first hydration. 'minted': this
   *  process minted the id (a spawn appends before its tasks row exists, so a read gets 403) —
   *  hydration does not ask. 'first-turn': the server marked its first delivery — a read that
   *  FAILS starts it fresh, loudly, since nothing of it is mirrored; a read that answers wins. */
  hintNew(kind: 'minted' | 'first-turn'): void {
    if (this.newTask !== 'minted') this.newTask = kind;
  }

  /**
   * Continue anywhere, slice 1 (spec §6.1): make this journal at least as new as the mirror before
   * a turn, given the mirror's top (`marker`; null = the mirror holds nothing). Runs inside the
   * append tail chain, so no append can interleave.
   *   current     — local tail equals the top (the fast path: no I/O beyond the existing hydrate)
   *   ahead       — local holds the top's entry and more (unflushed); the owed flush sends the rest
   *   hydrated    — local was empty; the existing hydrate-from-mirror filled it
   *   rehydrated  — local was behind the top; set aside, hydrated from the mirror
   *   diverged    — local disagrees with the top at the same seq (or the mirror refused us, or its
   *                 line there cannot be read and nothing readable chains from the top); set aside,
   *                 hydrated from the mirror. The mirror is the truth (spec I1).
   * A rebuild the mirror answers short of its own marker REJECTS, with the local file put back as it was.
   */
  catchUp(marker: MirrorMarker | null): Promise<CatchUpOutcome> {
    const run = this.tail.then(() => this.doCatchUp(marker));
    this.tail = run.catch(() => {});
    return run;
  }

  private async doCatchUp(marker: MirrorMarker | null): Promise<CatchUpOutcome> {
    let wasEmptyBefore = this.hydration === undefined && (await this.deps.jsonl.mtimeMs()) === null;
    await this.hydrate();
    // No rows mirrored: the local copy (or nothing) is the truth. No mirror reads wired (the
    // cloud with KERNEL_JOURNAL_MIRROR off, tests): nothing to catch up from; never set aside.
    if (marker === null || !this.deps.hydrateFromMirror) return 'current';
    // The file as it is now. GONE though this journal holds entries (tidy pruned it), or CHANGED by no append of
    // ours (another writer): open it again as a fresh process would, so leaf and seq follow the file (rematerialize
    // keeps them). The queue (this process's real appends; nothing above the mirror's top is checked there) never
    // crosses blind: GONE, it is sent first (the hydrate reads it back), and when it cannot all be sent the catch-up
    // rejects with nothing re-read; CHANGED, it stays only if the file holds every queued entry at its seq with its
    // uuid, else it is refused and the set-aside rebuild below drops it (the mirror wins). No flush starts meanwhile.
    // In practice only GONE fires: CHANGED is skipped while entriesDirtiedByAppend, which is how a journal rests
    // between turns (its last act was an append; only a read of the read-model since clears it).
    const mtime = await this.deps.jsonl.mtimeMs();
    const vanished = mtime === null && this.entries.length > 0;
    if (vanished || (mtime !== this.entriesMtimeMs && !this.entriesDirtiedByAppend)) {
      if (vanished && !(await this.drainQueue())) {
        throw new Error(`journal catch-up: the local file is gone and ${this.pendingMirror.length} queued entries could not be sent; nothing was re-read`);
      }
      let stale = false;
      let checked = false;
      this.checkingFile = true;
      try {
        await this.flushInFlight?.catch(() => {});
        wasEmptyBefore = mtime === null;
        this.forgetReadModel();
        this.deps.jsonl.reopen?.();
        await this.hydrate();
        stale = !(await this.holdsAll(this.pendingMirror));
        checked = true;
      } finally {
        // A re-read that throws checked nothing: its queue is refused too. ORed, so a 409 that answered meanwhile stands.
        this.checkingFile = false;
        this.refusedByMirror ||= stale || (!checked && this.pendingMirror.length > 0);
      }
    }
    const localTop = this.entries.at(-1);
    let verdict: 'current' | 'ahead' | 'behind' | 'diverged';
    let unverifiable = false;
    if (this.refusedByMirror) verdict = 'diverged';
    else if (!localTop || localTop.seq < marker.maxSeq) verdict = 'behind';
    else {
      // Diverged only on proof: a READABLE local entry at the top's seq with another uuid. A line there
      // this build cannot read (a newer build's payload, damage) is the same history when a readable
      // entry chains from the top; only with neither proof is it diverged, and said so.
      const atTop = await this.localFind((e) => e.seq === marker.maxSeq);
      if (atTop) verdict = atTop.uuid !== marker.lastUuid ? 'diverged' : localTop.seq === marker.maxSeq ? 'current' : 'ahead';
      else if (await this.localFind((e) => e.parentUuid === marker.lastUuid)) verdict = 'ahead';
      else {
        verdict = 'diverged';
        unverifiable = true;
      }
    }
    // Hydrated is told after the comparison, not instead of it: a predecessor's appends (deps.after)
    // can fill a file that was absent when this began, and such a copy is compared like any other.
    if (verdict === 'current' || verdict === 'ahead') return wasEmptyBefore ? 'hydrated' : verdict;
    // A flush in flight belongs to the copy being set aside: start no new one (doFlushMirror's
    // head) and let it answer first, or its late answer would splice or refuse the rebuilt queue.
    this.refusedByMirror = true;
    await this.flushInFlight?.catch(() => {});
    // A set-aside that throws leaves refusedByMirror set and this copy in place: it must not flush.
    const aside = await this.deps.jsonl.setAside('.superseded');
    this.reset();
    this.newTask = undefined; // the marker says the mirror holds this task: no new-task hint may skip its read
    try {
      await this.hydrate(); // local file gone → the existing hydrate-from-mirror path
      const top = this.entries.at(-1);
      if (!top || top.seq < marker.maxSeq) {
        throw new MirrorShortError(top?.seq ?? -1, marker.maxSeq);
      }
    } catch (err) {
      // A mirror that cannot answer, or answers short of its own marker: never serve an emptied or
      // shortened journal (2026-09-28: a restart at seq 0). The local file goes back as it was and the
      // turn fails visibly. That copy is still behind or diverged, and the mirror checks only the seqs
      // it holds, so its entries above the top would splice: it stays unflushed.
      try {
        await this.deps.jsonl.undoSetAside(aside);
      } catch (undoErr) {
        // The copy stays at `aside` (setAside puts the next ones beside it); the turn fails with what
        // failed the rebuild, not with this.
        this.reportIntegrity({ kind: 'journal_catch_up_undo_failed', aside, detail: errText(undoErr) });
      } finally {
        this.reset();
        this.refusedByMirror = true;
      }
      throw err;
    }
    this.reportIntegrity({
      kind: 'journal_caught_up', verdict, ...(unverifiable ? { reason: 'unverifiable' as const } : {}),
      mirrorMaxSeq: marker.maxSeq, localMaxSeq: localTop?.seq ?? -1,
    });
    return verdict === 'behind' ? 'rehydrated' : 'diverged';
  }

  /** A readable local entry `pred` accepts: the read-model's, or, when the read-model was rebuilt from a
   *  checkpoint (R2) and lacks what its compaction dropped, the file's (the durable source of truth). */
  private async localFind(pred: (e: JournalEntry) => boolean): Promise<JournalEntry | undefined> {
    for (let i = this.entries.length - 1; i >= 0; i--) if (pred(this.entries[i])) return this.entries[i];
    if (!this.partial) return undefined;
    for await (const e of this.deps.jsonl.read()) if (pred(e)) return e;
    return undefined;
  }

  /** Flush until nothing is queued or owed, or a flush makes no progress (journal-flush.ts drainMirror's
   *  loop). True when all of it was sent; a refusal stops it. */
  private async drainQueue(): Promise<boolean> {
    let before = Number.POSITIVE_INFINITY;
    while (!this.refusedByMirror && (this.owed !== undefined || (this.pendingMirror.length > 0 && this.pendingMirror.length < before))) {
      if (this.owed === undefined) before = this.pendingMirror.length;
      await this.flushMirror();
    }
    return !this.refusedByMirror && this.owed === undefined && this.pendingMirror.length === 0;
  }

  /** Whether the file holds every one of `queued` at its seq with its uuid: the read-model answers, and
   *  the file itself for what a read-model rebuilt from a checkpoint (R2) lacks. */
  private async holdsAll(queued: readonly JournalEntry[]): Promise<boolean> {
    const held = new Map(this.entries.map((e) => [e.seq, e.uuid]));
    const want = new Map(queued.filter((q) => held.get(q.seq) !== q.uuid).map((q) => [q.seq, q.uuid]));
    if (want.size === 0) return true;
    if (!this.partial) return false;
    for await (const e of this.deps.jsonl.read()) if (want.get(e.seq) === e.uuid) want.delete(e.seq);
    return want.size === 0;
  }

  /** Forget every in-memory view of the file (leaf and seq included), so the next hydrate reads it from scratch.
   *  The mirror queue and its pending auto-flush stay (reset drops them): any flush goes through refusedByMirror. */
  private forgetReadModel(): void {
    this.hydration = undefined;
    this.entries = [];
    this.partial = false;
    this.leafUuid = null;
    this.nextSeq = 0;
    this.owed = undefined;
    this.projectionCache = null;
    this.liveSuspendedCache = null;
    this.entriesMtimeMs = null;
    this.entriesDirtiedByAppend = false;
  }

  /** forgetReadModel, and the mirror queue is DROPPED too (with its pending auto-flush): it belongs to the
   *  set-aside copy, which the mirror refused or outran. */
  private reset(): void {
    this.forgetReadModel();
    this.pendingMirror = [];
    this.refusedByMirror = false;
    this.autoFlush.clear();
  }

  /** Cold-start: rebuild leaf + seq once. Concurrent first-calls share one hydration; one that
   *  FAILED (a mirror read that could not answer) is forgotten, so the next call retries. */
  private hydrate(): Promise<void> {
    return (this.hydration ??= this.doHydrate().catch((err: unknown) => {
      this.hydration = undefined;
      throw err;
    }));
  }

  /** Rebuild leaf + seq from the local JSONL, after the writer sets a torn last line aside (R5; one that
   *  fails here is retried, and reported, by the first append). Bedrock S5 P4: on a genuinely-empty local
   *  JSONL AND hydrateFromMirror, fall back to the off-box mirror (cross-host recovery), written through. */
  private async doHydrate(): Promise<void> {
    await this.deps.after; // R5: a predecessor's in-flight appends land before this one reads or repairs
    await this.deps.jsonl.repairTail?.().catch(() => {});
    // P2.6: materialize the read-model here (the full read already happens) so project()/heal/
    // reconcile/defer never re-scan the file; the entries stay resident as the read-model, by design.
    // R2: from the newest checkpoint backwards when it can answer (checkpoint.ts), else the whole file.
    const rebuilt = this.deps.checkpoint ? await readFromCheckpoint(this.deps.jsonl).catch(() => null) : null;
    this.entries = rebuilt?.entries ?? [];
    this.partial = rebuilt?.partial ?? false;
    if (!rebuilt) for await (const entry of this.deps.jsonl.read()) this.entries.push(entry);
    const last = this.entries.at(-1);
    if (last) [this.leafUuid, this.nextSeq] = [last.uuid, last.seq + 1];
    // A lossless mirror is sent what it still lacks of this file (a queue lost with its process); its refusal is the flush's.
    const mirror = this.deps.mirror; // R2: a read-model from a checkpoint asks about the whole file, off the hydrate
    if (this.entries.length > 0 && mirror.owed) this.owed = awaitedLater(!this.partial ? mirror.owed(this.deps.taskId, this.entries.slice())
      : wholeFile(this.deps.jsonl).catch(() => []).then((all) => mirror.owed?.(this.deps.taskId, all) ?? []));
    if (this.entries.length === 0 && this.deps.hydrateFromMirror) {
      await this.hydrateFromMirror();
    }
    this.entriesMtimeMs = await this.deps.jsonl.mtimeMs();
  }

  /**
   * Cross-host recovery (Bedrock S5 P4): the local JSONL was empty, so reconstruct
   * from the mirror and WRITE THROUGH, all or nothing (JsonlStore.replaceWith: a write that
   * dies part-way leaves no file, never a prefix), and advance leaf/seq. The fresh machine now
   * owns the journal locally; the next append chains contiguously off the mirror's
   * leaf. `mirror.load` answers null only when the mirror holds no rows (a new task
   * starts fresh) and THROWS when it cannot read: that rejects the hydration (and the
   * turn that needed it), which `hydrate` forgets so the next call retries — never a
   * fresh start over a task the mirror knows (2026-09-28: a null for "unreachable" used
   * to restart the conversation at seq 0, after the tidy sweeper had pruned the file).
   * The written-through entries are NOT queued for re-mirror (not append()), and a
   * re-POST would be idempotent anyway (task_id,seq).
   */
  private async hydrateFromMirror(): Promise<void> {
    if (this.newTask === 'minted') return;
    let entries: JournalEntry[] | null;
    try {
      entries = await this.deps.mirror.load(this.deps.taskId);
    } catch (err) {
      // Only a first turn with no local file may shrug a failed read off (hintNew).
      if (this.newTask !== 'first-turn' || (await this.deps.jsonl.mtimeMs()) !== null) throw err;
      this.reportIntegrity({ kind: 'mirror_unreadable_started_fresh', detail: errText(err) });
      return;
    }
    if (!entries || entries.length === 0) return;
    await this.deps.jsonl.replaceWith(entries);
    for (const entry of entries) {
      this.entries.push(entry); // P2.6: the read-model owns the written-through entries too
      this.leafUuid = entry.uuid;
      this.nextSeq = entry.seq + 1;
    }
  }
}

/**
 * Apply compaction splices to produce the projected entry list.
 *
 * CONTRACT (index-anchor-free, order-explicit):
 *  - If there is NO `compact_boundary` entry in `all` → return `all` unchanged (identity).
 *    This is K0's normal path.
 *  - Otherwise, take the LAST `compact_boundary`'s payload `b`:
 *      • `firstKeptSeq` = seq of the entry whose uuid === b.firstKeptId.
 *        If not found → throw (`compaction firstKeptId not found: <id>`). Never default to 0.
 *      • The summary entry (uuid === b.summaryUuid) must exist.
 *        If not found → throw (`compaction summaryUuid not found: <id>`).
 *      • Kept list = the summary entry FIRST (it represents compressed history, so it leads),
 *        then every OTHER entry in original/seq order where
 *        `e.uuid !== b.summaryUuid && (b.preservedUuids.includes(e.uuid) || e.seq >= firstKeptSeq)`.
 *  The summary/preserved entries are appended BEFORE the boundary (lower seq), so an
 *  index slice would wrongly exclude them — this projection is intentionally not anchored
 *  to the boundary's position. The `compact_boundary` entry itself is non-context and is
 *  dropped by the later `isContextEntry` filter; it is never re-included here.
 */
/**
 * K4C-3 D2 — pure, cheap signal: does this projection LEAD with a compaction
 * summary? True iff the raw list carries a `compact_boundary` AND the projected
 * head is that boundary's summary entry (so the model's first message is the
 * stable post-compaction prefix). Index 0 lookup + one reverse scan; never throws
 * (a missing/empty projection → false). The engine threads this to the transport.
 */
function projectionLeadsWithSummary(all: JournalEntry[], projected: JournalEntry[]): boolean {
  if (projected.length === 0) return false;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].payload.type === 'compact_boundary') {
      const summaryUuid = (all[i].payload as { summaryUuid: string }).summaryUuid;
      return projected[0].uuid === summaryUuid;
    }
  }
  return false;
}

function applyCompaction(
  all: JournalEntry[],
  onDegraded?: (info: { boundaryUuid: string; detail: string }) => void,
): { entries: JournalEntry[]; degraded: boolean } {
  let boundaryEntry: JournalEntry | null = null;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].payload.type === 'compact_boundary') {
      boundaryEntry = all[i];
      break;
    }
  }
  if (!boundaryEntry) return { entries: all, degraded: false }; // identity — no compaction has happened

  const boundary = boundaryEntry; // const-capture so the closure below keeps the non-null narrowing
  const b = boundary.payload as Extract<JournalEntry['payload'], { type: 'compact_boundary' }>;
  // P2.0 — a missing anchor (e.g. its line was quarantined) DEGRADES to the
  // pre-compaction projection (all entries, failed boundary dropped) with a loud
  // report, instead of throwing and bricking project()/reconcile/suspend. The
  // anchor may be restored later (mirror recovery), so callers must not cache a
  // degraded result.
  const degrade = (detail: string): { entries: JournalEntry[]; degraded: true } => {
    onDegraded?.({ boundaryUuid: boundary.uuid, detail });
    return { entries: all.filter((e) => e.uuid !== boundary.uuid), degraded: true };
  };

  const firstKept = all.find((e) => e.uuid === b.firstKeptId);
  if (!firstKept) return degrade(`compaction firstKeptId not found: ${b.firstKeptId}`);
  const firstKeptSeq = firstKept.seq;

  const summary = all.find((e) => e.uuid === b.summaryUuid);
  if (!summary) return degrade(`compaction summaryUuid not found: ${b.summaryUuid}`);

  // Summary leads (compressed history); then preserved + firstKept-onward in original order.
  const rest = all.filter(
    (e) => e.uuid !== b.summaryUuid && (b.preservedUuids.includes(e.uuid) || e.seq >= firstKeptSeq),
  );
  return { entries: [summary, ...rest], degraded: false };
}

