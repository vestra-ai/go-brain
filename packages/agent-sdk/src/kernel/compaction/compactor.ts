/**
 * K4-T1 — the Compactor: pi's turn-boundary compaction algorithm as a PURE planner.
 *
 * PURITY CONTRACT (mirrors token-ledger.ts / journal-stats.ts):
 *   - No I/O, no clock, no model SDK. Imports only @bash/shared + the sibling ledger.
 *   - `planCompaction` DECIDES the cut and calls the INJECTED `summarize` callback;
 *     it NEVER appends, NEVER calls Journal.compact(), NEVER picks the prompt (that is the
 *     harness's job, T2). The kernel never reaches a model client.
 *   - Every throw is a {@link CompactionPlanError} carrying a NAMED
 *     {@link CompactionFailureReason} (caller = skip, and can meter WHY).
 *
 * WHAT IT ENCODES (decision 1, the pi baseline, plan §2):
 *   1. BOUNDARY cuts only — `firstKeptId` is a `user` OR an `assistant` entry's uuid,
 *      never a `tool_use`, `tool_result`, `system` or `custom_message` one (T9b; see
 *      THE BOUNDARY RULE below).
 *   2. Never orphan a tool_use/tool_result pair (paired by toolUseId).
 *   3. ~20k keep window (NativeConfig.compaction.keepWindowTokens).
 *   4. Split-turn dual-summary → ONE concatenated summaryText (the schema has exactly one
 *      summaryUuid — entry.ts:15; do NOT widen compact_boundary). The planner tells the
 *      injected callback WHEN the cut split a turn (`meta.splitTurn`) so the caller can
 *      instruct the summarizer accordingly; the plan carries the same bit.
 *   5. Re-summarize from the prior firstKeptId — on a 2nd compaction `entries` already leads
 *      with a prior summary `user` entry; the new toSummarize INCLUDES it so the new summary
 *      subsumes the old.
 *   6. Never GROW the history: a compaction whose dropped span is no larger than the
 *      summary that would replace it is refused (Hermes's guard).
 *
 * ─── THE BOUNDARY RULE (T9b) ───────────────────────────────────────────────────
 *
 * The cut used to require a `user` entry, and that is a CHAT assumption. An agentic
 * loop is ONE user message and many tool rounds: a Nami dream pass has exactly one
 * `user` entry (the prompt) and a long single-ask Bash task has one until the user
 * types again. A round appends an `assistant` entry, then SEPARATE `tool_use`
 * entries, then `tool_result` entries — `tool_result` is its own payload type, so a
 * round mints no `user` boundary at all. The forward snap therefore ran off the end
 * of every such journal and the planner refused EVERY compaction worth making; the
 * run then continued uncompacted until it died of `context_exceeded`.
 *
 * The rule is now pi's (`compaction.ts:351` `findValidCutPoints`, `:387-461`
 * `findCutPoint`): a cut point is a context-visible USER-like OR ASSISTANT message,
 * NEVER a tool result — an assistant message OWNS its tool calls, so when the cut
 * lands on one its `tool_use` entries and their results follow it and are KEPT.
 * That maps onto our journal shape as exactly {`user`, `assistant`}: every provider
 * projection folds the `tool_use` entries into the preceding assistant message, so a
 * cut landing on a `tool_use`/`tool_result` would orphan the fold.
 *
 * PRECEDENCE — there is NO preference for a `user` boundary over an `assistant` one.
 * The cut is the NEAREST boundary at/after the raw token-walk cut, then pair-safety
 * (`avoidOrphanPair`) as before. A chat-shaped journal whose raw cut already lands on
 * a `user` entry therefore plans the IDENTICAL cut it planned before T9b; where the
 * raw cut lands mid-turn the new cut is the nearest boundary at/after it, so the kept
 * span is a SUPERSET of the old one (never less context) and `splitTurn` is true.
 *
 * The plan satisfies the FROZEN applyCompaction contract (journal.ts:173-196): the harness
 * appends the summary as a `user` payload, then calls Journal.compact({ firstKeptId, ... }).
 */

import type { JournalEntry } from '../../contract/journal.js';
import { estimateTokens, projectTokenCount } from '../journal/token-ledger.js';
import { computeSuspendedToolUseIds } from '../interaction/strategy.js';
import { isRealUserTurn } from '../../contract/injected-user-text.js';

/**
 * K5 (§8.7): the `toolUseId`s paused on an unresolved interaction — computed from
 * the RAW journal. The caller passes these into `planCompaction` so `avoidOrphanPair`
 * PINS a paused `tool_use` (the compactor's `entries` are the suspended projection,
 * which has dropped it, so the pin needs the raw-journal set handed in). Alias of
 * the shared `computeSuspendedToolUseIds` so the pin and `suspendPending` never drift.
 */
export const computePausedToolUseIds = computeSuspendedToolUseIds;

// ─── Named refusals ─────────────────────────────────────────────────────────────

/**
 * WHY a compaction did not happen. Named, not prosaic, because the round head's
 * never-throw wrapper used to swallow every refusal into one `console.warn` — which
 * is how the "an agentic loop can never compact" bug stayed invisible for months.
 * A host meters and alerts on THIS.
 *
 *  · `no_valid_cut`        no boundary leaves a non-empty dropped side and a
 *                          non-empty kept side (a single un-cuttable pair, or a
 *                          conversation that fits the keep window entirely).
 *  · `summary_not_smaller` the dropped span is no larger than the summary that
 *                          would replace it — compacting would GROW the history
 *                          (Hermes `trajectory_compressor.py:837-844`).
 *  · `summarize_failed`    the injected summarize callback threw — the provider call
 *                          failed. The original error rides on `cause`.
 *  · `empty_summary`       the summarize RETURNED, billed, with no text — a reasoning
 *                          model that spent its whole output cap thinking (gpt-6-luna,
 *                          09-27). Compacting to nothing would drop the span, and rule 6
 *                          cannot see it (0 tokens is smaller than any span).
 *  · `aborted`             the summarize was ABORTED mid-flight (a steer swaps the run
 *                          scope and aborts the old one; a stop aborts outright). Not a
 *                          failure of compaction, and a meter must not page on it.
 *  · `hook_blocked`        X1 (HOOK_PARITY_V1): a PreCompact hook blocked it, before any
 *                          model call (engine/hook-parity.ts). The message is the hook's reason.
 */
export type CompactionFailureReason =
  | 'no_valid_cut'
  | 'summary_not_smaller'
  | 'summarize_failed'
  | 'empty_summary'
  | 'aborted'
  | 'hook_blocked';

/** A refusal from {@link planCompaction}, carrying the named {@link CompactionFailureReason}. */
export class CompactionPlanError extends Error {
  readonly reason: CompactionFailureReason;
  constructor(reason: CompactionFailureReason, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
    this.name = 'CompactionPlanError';
    this.reason = reason;
  }
}

/** The named reason behind any error a compaction site caught, for telemetry. */
export function compactionFailureReason(err: unknown): CompactionFailureReason | 'unknown' {
  return err instanceof CompactionPlanError ? err.reason : 'unknown';
}

// ─── Public contract (EXACT signatures — plan §2) ───────────────────────────────

export interface CompactionInput {
  /** Journal.project() output — isContextEntry-filtered, post-prior-compaction. */
  entries: JournalEntry[];
  /** NativeConfig.compaction.keepWindowTokens (~20_000). */
  keepWindowTokens: number;
  /** projectTokenCount(entries).messages, captured pre-plan (observability). */
  preTokens: number;
  /**
   * CONTRACT: the caller MUST prompt with the STRUCTURED multi-section schema (plan §2b);
   * a generic summary fails the ≥0.90 fact-recall gate. The kernel stays pure — it never
   * picks the prompt, only relays the structured summary the caller produces.
   *
   * `meta.splitTurn` (T9b, additive and OPTIONAL — a callback that ignores it is
   * unchanged) says the cut landed INSIDE a turn: the span being summarized is that
   * turn's PREFIX and its most recent work is retained verbatim after the summary.
   * pi hands that case a different instruction (`TURN_PREFIX_SUMMARIZATION_PROMPT`,
   * `compaction.ts:835`); the kernel only reports the fact — it never picks a prompt.
   */
  summarize: (
    toSummarize: JournalEntry[],
    signal?: AbortSignal,
    meta?: { splitTurn: boolean; retainedHasRealUserTurn: boolean },
  ) => Promise<string>;
  signal?: AbortSignal;
  /**
   * K5 (§8.7): `toolUseId`s paused on an unresolved interaction, from
   * `computePausedToolUseIds(rawJournal)`. `avoidOrphanPair` pins any such
   * `tool_use` on the dropped side (retreats the cut to keep it) so it survives to
   * pair with its future materialized result. NOTE for the caller (T2 wiring): the
   * pin only bites if `entries` still CONTAINS the paused `tool_use` — pass the
   * NON-suspended context projection here, not the suspendPending'd model
   * projection. In the common case the pause halts the turn, so the paused
   * `tool_use` is the most-recent entry (inside the keep window) and is never
   * dropped; the pin is the defense for long-lived / multi-pause sessions.
   */
  pausedToolUseIds?: Set<string>;
}

export interface CompactionPlan {
  /** ONE concatenated summary (single summaryUuid — schema frozen, entry.ts:15). */
  summaryText: string;
  /** uuid of the `user` OR `assistant` entry that becomes the cut point (T9b). */
  firstKeptId: string;
  /**
   * T9b — the cut is NOT a `user` entry, i.e. it landed inside a turn. The dropped
   * span is that turn's PREFIX and the turn's most recent work is retained verbatim
   * after the summary. Same bit the injected `summarize` callback is handed.
   */
  splitTurn: boolean;
  /**
   * T9c — does the RETAINED span still hold a real user turn?
   *
   * `splitTurn` alone does not mean "the LIVE turn was split". A turn ends on a text
   * reply and has no next round head, so the previous turn's growth is first noticed at
   * the NEXT turn's first head: the cut lands inside the completed previous turn while
   * the user's fresh ask sits in the kept span. Everything that claims "the turn is
   * still in progress" — the split-turn prompt section and the continuation marker —
   * has to be false there, and only the kept span can say so. Computed here because the
   * planner is what knows the cut.
   */
  retainedHasRealUserTurn: boolean;
  /** Force-preserved uuids (none in v0; reserved). */
  preservedUuids: string[];
  /** estimateTokens(summaryText) + sum(estimateTokens(keptEntry)) over the kept span. */
  postTokens: number;
  trigger: 'auto' | 'manual';
  /** Entries before firstKeptId — the onPreCompact reflect slice (T7 consumer). */
  droppedEntries: JournalEntry[];
}

// ─── Per-entry token estimate (reuses the T0 ledger, stays consistent) ───────────

/** Per-entry contribution to the messages bucket, via the same rules as
 *  projectTokenCount (so the trigger and the cut math agree byte-for-byte). */
function entryTokens(e: JournalEntry): number {
  return projectTokenCount([e]).messages;
}

// ─── planCompaction ─────────────────────────────────────────────────────────────

/**
 * Pure planner: decide the boundary cut, build the summary via the injected
 * callback, return the plan. Throws a {@link CompactionPlanError} with a named
 * reason (caller treats every one of them as skip).
 */
export async function planCompaction(input: CompactionInput): Promise<CompactionPlan> {
  const { entries, keepWindowTokens, summarize, signal, pausedToolUseIds } = input;

  // ── Rule 1: walk newest→oldest, sum estimateTokens until the running sum exceeds
  // keepWindowTokens. The raw cut is the index of the oldest entry that still fits the
  // window (everything at index >= rawCut is provisionally "kept").
  let running = 0;
  let rawCutIdx = entries.length; // default: nothing fits → cut would drop everything
  for (let i = entries.length - 1; i >= 0; i--) {
    running += entryTokens(entries[i]);
    if (running > keepWindowTokens) {
      // entries[i] is the first entry (oldest-direction) that pushes us over budget;
      // it does NOT fit the window, so the kept span starts at i+1.
      rawCutIdx = i + 1;
      break;
    }
    rawCutIdx = i; // still within budget — provisionally keep from here
  }

  // ── Rule 1 (snap): the cut must land on a BOUNDARY entry (`user` or `assistant` —
  // see THE BOUNDARY RULE in the header). Snap FORWARD (toward newer entries) to the
  // NEAREST boundary at/after the raw cut, so the kept window starts on a message a
  // provider projection can head a request with. No preference between the two kinds.
  let cutIdx = snapForwardToBoundary(entries, rawCutIdx);
  // S-3: the raw cut can land INSIDE the final round — on a 1M lane a single capped tool
  // result is the whole keep window — and then no boundary lies at or after it and the snap
  // runs off the end. Refusing there throws away a cut that exists just BELOW: the round's
  // own `assistant` entry. Hermes retreats when it cannot advance, and the scan below already
  // walks downward, so hand it the last real index instead of the off-the-end sentinel.
  // A raw cut that is ITSELF off the end is a different thing — nothing fits the window at
  // all — and stays a refusal.
  if (cutIdx >= entries.length && rawCutIdx < entries.length) cutIdx = entries.length - 1;

  // ── Rule 2: never orphan a tool_use/tool_result pair. If the kept span starts with a
  // tool_result whose tool_use is dropped (or vice versa), move the cut EARLIER to a
  // boundary that keeps both halves on the same side.
  cutIdx = avoidOrphanPair(entries, cutIdx, pausedToolUseIds);

  if (cutIdx <= 0 || cutIdx >= entries.length) {
    // cutIdx===0 → nothing is dropped (no compaction to do);
    // cutIdx>=length → everything dropped, no kept boundary. Either way: no valid cut.
    throw noValidCut();
  }

  const firstKept = entries[cutIdx];
  if (!isCutBoundary(firstKept)) {
    // Defensive: snap/avoid should always land on a boundary entry; if not, there is no cut.
    throw noValidCut();
  }

  // ── toSummarize = everything before the cut. droppedEntries === toSummarize (rule 4/5:
  // on a 2nd compaction this INCLUDES the leading prior-summary entry → subsumes the old).
  const toSummarize = entries.slice(0, cutIdx);
  // A cut that is not a real user TURN lands INSIDE a turn — pi's split turn.
  //
  // D4: not `payload.type !== 'user'`. An engine-minted user entry (a recall fence, the
  // T9c continuation marker, a hook's continueContext) is a legal cut BOUNDARY —
  // `isCutBoundary` still accepts it and it heads a wire request fine — but the span it
  // opens carries no user message, so the turn IS split and the summarize has to be told.
  const splitTurn = !isRealUserTurn(firstKept);

  // The kept span's own answer to "is there still a real ask in here?" — computed BEFORE
  // the summarize so the callback can be told, since the split-turn section's truth
  // depends on it (see `retainedHasRealUserTurn`).
  const retainedHasRealUserTurn = entries.slice(cutIdx).some(isRealUserTurn);

  // ── Rule 4: ONE summaryText (one summaryUuid — entry.ts:15). The injected callback
  // returns a single string even for a split turn; we never fan out into multiple summaries.
  let summaryText: string;
  try {
    summaryText = await summarize(toSummarize, signal, { splitTurn, retainedHasRealUserTurn });
  } catch (e) {
    // An abort is not a FAILURE: a steer aborts the previous run scope mid-summarize while
    // the live signal is untouched, so the throw lands here rather than on the user_aborted
    // path. Naming it apart is what keeps T11o from paging on ordinary steering.
    const reason: CompactionFailureReason = isAbortShaped(e) ? 'aborted' : 'summarize_failed';
    throw new CompactionPlanError(reason, `planCompaction: summarize ${reason}`, { cause: e });
  }

  // An EMPTY summary is a refusal, never a plan. It used to come back as a plan the caller
  // quietly declined (`return null`), which took the billed summarize down with it: no usage
  // row, no journal entry, and the next round head paid for the same empty answer again.
  // Refused BY NAME, it rides the same rail as every other refusal — spend attached, recorded.
  if (!summaryText.trim()) {
    throw new CompactionPlanError('empty_summary', 'planCompaction: summarize returned an empty summary');
  }

  // ── Rule 6 (Hermes, trajectory_compressor.py:837-844): a span no larger than the
  // summary that replaces it cannot reduce the context — it GROWS the history and
  // still spends a summarize call. Refuse, by name, rather than record a compaction
  // that made things worse. Measured with the same ruler the cut was walked with.
  const droppedTokens = toSummarize.reduce((acc, e) => acc + entryTokens(e), 0);
  const summaryTokens = estimateTokens(summaryText);
  if (summaryTokens >= droppedTokens) {
    throw new CompactionPlanError(
      'summary_not_smaller',
      `planCompaction: summary (${summaryTokens} tok) is not smaller than the span it replaces (${droppedTokens} tok)`,
    );
  }

  // ── postTokens = estimate(summary) + sum(estimate(kept)) over the kept span.
  const keptSpan = entries.slice(cutIdx);
  const postTokens = summaryTokens + keptSpan.reduce((acc, e) => acc + entryTokens(e), 0);

  return {
    summaryText,
    firstKeptId: firstKept.uuid,
    splitTurn,
    retainedHasRealUserTurn,
    preservedUuids: [],
    postTokens,
    trigger: 'auto',
    droppedEntries: toSummarize,
  };
}

/**
 * Abort shape, by NAME only. The kernel is pure — it cannot import the provider SDKs'
 * abort wrapper classes the way `engine/turn-decisions.ts isAbortShapedError` does — but
 * both of those set `name` to `APIUserAbortError`, so the name test covers them.
 */
function isAbortShaped(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'AbortError' || name === 'APIUserAbortError';
}

/** The one refusal message the fleet already pins, now with its named reason. */
function noValidCut(): CompactionPlanError {
  return new CompactionPlanError('no_valid_cut', 'planCompaction: no valid turn-boundary cut');
}

// ─── Cut helpers (pure) ──────────────────────────────────────────────────────────

/**
 * THE cut-boundary predicate (T9b) — the ONE place the rule lives.
 *
 * `user` and `assistant` only. A `tool_use` or `tool_result` is never a boundary:
 * every provider projection folds a round's `tool_use` entries into the preceding
 * assistant message, so a cut there would orphan the fold. `system` and
 * `custom_message` are context entries but not turn heads, so they are not boundaries
 * either — the snap simply walks past them.
 */
function isCutBoundary(entry: JournalEntry): boolean {
  const t = entry.payload.type;
  return t === 'user' || t === 'assistant';
}

/** Snap an index forward (toward newer) to the next boundary entry at or after `idx`.
 *  Returns entries.length if no boundary entry exists from idx onward. */
function snapForwardToBoundary(entries: JournalEntry[], idx: number): number {
  for (let i = Math.max(idx, 0); i < entries.length; i++) {
    if (isCutBoundary(entries[i])) return i;
  }
  return entries.length;
}

/**
 * Rule 2 — never split a tool_use/tool_result pair across the cut.
 *
 * A pair is split when its `tool_use` and `tool_result` land on OPPOSITE sides of the cut
 * (paired by toolUseId, journal.ts:126-127). There are two ways to un-split every pair and
 * still land on a clean boundary:
 *
 *   - BACKWARD retreat: move the cut EARLIER so the whole pair lands on the KEPT side.
 *   - FORWARD snap:      move the cut LATER so the whole pair lands on the DROPPED side.
 *
 * We PREFER the backward retreat (keeps more context; matches the approved N=1 behavior),
 * but a pure retreat can cascade to index 0 and yield "no valid cut" even when a clean
 * FORWARD boundary exists (BUG-1: STACKED cross-turn pairs whose results sit between
 * the raw cut and the recent turn). So when backward fails to make pair-safe progress, we
 * fall back to a forward snap past the straddling pairs — see the LADDER note below for
 * why "the pairs straddled SO FAR", not "the pairs straddling right now".
 *
 * Each chosen cut is re-checked because moving it can pull a NEW pair across the cut. The
 * loop runs until the cut is stable (no straddle) or no valid cut remains. It guarantees
 * exactly one thing: it NEVER returns a cut it has not verified straddle-free — every
 * other outcome is 0, which the caller reports as `no_valid_cut`.
 *
 * ─── WHY IT IS A SCAN AND NOT A CHASE ────────────────────────────────────────
 *
 * This used to CHASE: retreat, re-check, snap forward, re-check, bounded by a guard. The
 * two moves can feed each other — on `[u0, tuP, a1, trP, tuQ, a2, trQ, a3, a4]` the retreat
 * that keeps pair Q whole pulls pair P across the cut, and the forward snap past P pulls Q
 * back — so the walk alternated. Two bugs came out of that: it once RETURNED the unverified
 * cut it happened to hold (orphaning a pair), and its replacement's "2n" bound was not a
 * real bound either (a forward move resets the cut upward, so indices are revisited; at 13
 * interleaved pairs the guard expired and it refused where `entry-40` was safe).
 *
 * So there is no walk. The rule, in one line: SNAP FORWARD; if that boundary straddles a
 * pair, take the nearest safe boundary BELOW it, else the nearest above. The candidates are
 * ENUMERATED — from the raw cut downward, then upward — and the first with no straddling pair
 * wins. Backward first keeps the old preference: the retreat holds the most context. (It
 * usually lands where the old retreat jumped, since every boundary strictly inside a
 * straddling pair straddles it too — but not always, which is why the scan checks rather than
 * jumps.) It visits each index at most once, so it terminates by construction. Cost: up to n
 * candidates, each rebuilding `straddlingPairBounds`'s two maps over the whole projection —
 * O(n²) in the worst case, and only on a journal where nearly every boundary straddles
 * something. Memoizing the pair index across candidates is the fix if a real journal ever
 * makes that matter; none does today.
 *
 * THE ONE GUARANTEE: this never returns a cut it has not verified straddle-free. Every other
 * outcome is 0, which the caller reports as `no_valid_cut` — a degraded turn, where an
 * orphaned pair would be a request the provider rejects.
 */
function avoidOrphanPair(entries: JournalEntry[], cutIdx: number, pausedToolUseIds?: Set<string>): number {
  // The planner's own range gate, mirrored: a cut of 0 means the token walk found NOTHING to
  // drop (the conversation fits the keep window), and a cut at `entries.length` means nothing
  // FITS the window. Both are refusals, not invitations to scan for some other cut — the
  // chase reported them by returning the input unchanged, and the caller rejected it.
  if (cutIdx <= 0 || cutIdx >= entries.length) return 0;

  const safeAt = (i: number): boolean =>
    isCutBoundary(entries[i]) && straddlingPairBounds(entries, i, pausedToolUseIds) === null;

  // BACKWARD first, from the raw cut down to 1 — the retreat keeps the most context. Checking
  // EVERY boundary on the way lands on exactly the one the old retreat jumped to: every
  // boundary strictly inside a straddling pair straddles it too, so the scan skips precisely
  // those and stops at the first one outside them all.
  for (let i = Math.min(cutIdx, entries.length - 1); i >= 1; i--) {
    if (safeAt(i)) return i;
  }
  // Then FORWARD, past the raw cut — the stacked cross-turn case (BUG-1), where dropping the
  // straddling pairs whole is the only pair-safe answer.
  for (let i = Math.max(cutIdx + 1, 1); i < entries.length; i++) {
    if (safeAt(i)) return i;
  }
  return 0; // no pair-safe boundary anywhere → caller throws `no_valid_cut`.
}

/**
 * Find the index bounds of straddling tool pairs relative to `cut`.
 *
 * Pairing is by toolUseId (journal.ts:126-127). A pair straddles when its two halves land on
 * opposite sides of `cut`. Returns the EARLIEST straddling half (backward retreat target) and
 * the LATEST straddling half (forward snap-past target), or null when no pair straddles.
 */
function straddlingPairBounds(
  entries: JournalEntry[],
  cut: number,
  pausedToolUseIds?: Set<string>,
): { earliest: number; latest: number } | null {
  const useIdx = new Map<string, number>();
  const resIdx = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    const p = entries[i].payload;
    if (p.type === 'tool_use') useIdx.set(p.toolUseId, i);
    else if (p.type === 'tool_result') resIdx.set(p.toolUseId, i);
  }

  let earliest = -1;
  let latest = -1;
  const widen = (lo: number, hi: number) => {
    if (earliest < 0 || lo < earliest) earliest = lo;
    if (hi > latest) latest = hi;
  };
  for (const [id, ui] of useIdx) {
    const ri = resIdx.get(id);
    if (ri === undefined) {
      // K5 (§8.7): a PAUSED tool_use (bound to an unresolved interaction, no result)
      // is pinned — treat it like a pair whose result lies on the KEPT side. If the
      // tool_use is on the dropped side, it "straddles" and the cut must retreat to
      // keep it. Truly-orphaned (crashed) tool_uses are still ignored.
      if (pausedToolUseIds?.has(id) && ui < cut) widen(ui, ui);
      continue;
    }
    const useKept = ui >= cut;
    const resKept = ri >= cut;
    if (useKept === resKept) continue; // both halves on the same side — not split.
    widen(Math.min(ui, ri), Math.max(ui, ri));
  }
  return earliest < 0 ? null : { earliest, latest };
}
