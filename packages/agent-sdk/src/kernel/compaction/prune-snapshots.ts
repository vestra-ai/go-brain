/**
 * Cobrowse P1 (Perception V2) — pruneSnapshots: prune stale AX page-snapshots.
 *
 * A **pure projection-time policy** that bounds AX page-snapshot context on the
 * native arm — the text twin of `pruneScreenshots` (same file, same pipeline
 * slot, same contract). Flag-on (`BROWSER_PERCEPTION_V2`) browse steps emit a
 * large geometry-rendered snapshot text on every `computer_*` tool_result;
 * older snapshots describe page states that no longer exist. This pass keeps
 * the latest `KEEP_RECENT_SNAPSHOTS` snapshot-bearing tool_results intact and
 * replaces the header-matched text block of every OLDER one with a small
 * placeholder that tells the model how to re-fetch (`computer_snapshot`).
 *
 * DATA-GATED, NOT ENV-GATED: a snapshot-bearing tool_result is one carrying a
 * text block that STARTS WITH `SNAPSHOT_TEXT_HEADER` — the first line the
 * flag-on snapshot renderer emits. Every emitter in apps/sandbox
 * `computer-use-tools.ts` places the header-prefixed snapshot at the START of
 * its own text block: `computer_snapshot`'s whole text IS the snapshot, while
 * `computer_navigate`/`computer_back` emit it as a dedicated sibling block
 * after their human-readable text. All of them import the constant from here —
 * same import direction as `KEEP_RECENT_SCREENSHOTS` to the Claude hook — so
 * the arms can never drift. The kernel reads NO env: flag OFF ⇒ the
 * header never exists in any journal ⇒ identity return ⇒ flag-off projections
 * are byte-identical for free.
 *
 * MATCHER / FORGEABILITY: the match is `blocks.some(b => b.text.startsWith(
 * SNAPSHOT_TEXT_HEADER))`. The header at a block's START is registry-emitted
 * and unforgeable by page content: the ax-snapshot sanitizer strips control
 * characters (no newline smuggling) and neutralizes lookalike tokens, and page
 * text is rendered inside the tree body — so even a page that plants the
 * literal header string in visible text can only make it appear MID-text,
 * never as the start of a text block. The placeholder itself does not start
 * with the header, so a stubbed block never re-matches.
 *
 * PURITY CONTRACT (mirrors prune-screenshots.ts / the compactor):
 *   - ReadonlyArray in; return the SAME array reference when nothing changes
 *     (≤ KEEP_RECENT_SNAPSHOTS snapshot-bearing tool_results).
 *   - No @anthropic-ai, no @openai, no provider SDK, no clock, no FS, no env.
 *   - Never throws — degenerate input (empty array, empty blocks, missing text)
 *     tolerated silently.
 *
 * PAIR-SAFE + IDEMPOTENT:
 *   - NEVER deletes an entry (that would orphan a tool_use → tool_result pair
 *     on BOTH wire formats); NEVER touches `tool_use` entries.
 *   - NEVER touches USER entries — only `tool_result` payload text blocks
 *     count toward the keep-window and get stubbed.
 *   - Replaces each header-matched text block in an OLD tool_result with the
 *     placeholder text block, preserving sibling blocks (including screenshot
 *     images — those are `pruneScreenshots` territory).
 *   - Already-stubbed results carry no header, so a re-run does not re-count
 *     them → a second run is deep-equal AND returns identity.
 */

import type { JournalEntry } from '../../contract/journal.js';
import type { ContentBlock } from '../../contract/blocks.js';

// ─── Canonical shared constants ─────────────────────────────────────────────────
// SNAPSHOT_TEXT_HEADER's canonical home is HERE; the sandbox snapshot emitter
// (computer-use-tools.ts) and the Claude-arm hook (screenshot-prune-hook.ts)
// import it so the emitted first line and both pruners' matcher never drift.

/** First line of every flag-on geometry-rendered page snapshot. */
export const SNAPSHOT_TEXT_HEADER = '[page snapshot · visual order]';

/** How many recent snapshot-bearing tool_results to keep un-pruned. */
export const KEEP_RECENT_SNAPSHOTS = 2;

/** Text placeholder replacing pruned (stale) page-snapshot text blocks. */
export const SNAPSHOT_PRUNE_PLACEHOLDER =
  '[page snapshot from an earlier step — superseded; call computer_snapshot for current state]';

// ─── helpers ────────────────────────────────────────────────────────────────────

/** A text block whose text starts with the registry-emitted snapshot header. */
function isSnapshotTextBlock(b: { type?: string; text?: string } | null | undefined): boolean {
  return (
    b != null &&
    b.type === 'text' &&
    typeof b.text === 'string' &&
    b.text.startsWith(SNAPSHOT_TEXT_HEADER)
  );
}

/** A tool_result entry that carries at least one snapshot text block. */
function isSnapshotToolResult(e: JournalEntry): boolean {
  const p = e.payload;
  if (p.type !== 'tool_result') return false;
  const blocks = p.blocks as ReadonlyArray<{ type?: string; text?: string }> | undefined;
  if (!Array.isArray(blocks)) return false;
  return blocks.some((b) => isSnapshotTextBlock(b));
}

// ─── pruneSnapshots ─────────────────────────────────────────────────────────────

/**
 * Pure, idempotent, pair-safe AX-snapshot prune over a journal projection.
 *
 * Two linear passes (the exact shape of `pruneScreenshots`): (1) collect the
 * indexes of snapshot-bearing tool_results; if ≤ KEEP_RECENT_SNAPSHOTS, return
 * the SAME reference (identity). (2) Otherwise stub the header-matched text
 * blocks of every snapshot-bearing tool_result that is NOT among the latest
 * KEEP_RECENT_SNAPSHOTS, returning a new array where touched entries are
 * shallow-cloned and every other entry is returned by the same reference.
 * Never throws.
 */
export function pruneSnapshots(entries: ReadonlyArray<JournalEntry>): JournalEntry[] {
  const n = entries.length;

  // Pass 1 — find the snapshot-bearing tool_result indexes, in order.
  const snapshotIdx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (isSnapshotToolResult(entries[i])) snapshotIdx.push(i);
  }

  // Within the keep-window (or none — the flag-off path) → identity.
  if (snapshotIdx.length <= KEEP_RECENT_SNAPSHOTS) {
    return entries as JournalEntry[];
  }

  // The OLDEST (snapshotIdx.length - KEEP_RECENT_SNAPSHOTS) snapshot tool_results
  // get their snapshot text stubbed. The latest KEEP_RECENT_SNAPSHOTS keep it.
  const stubCount = snapshotIdx.length - KEEP_RECENT_SNAPSHOTS;
  const stubSet = new Set<number>(snapshotIdx.slice(0, stubCount));

  // Pass 2 — rebuild, cloning only the entries we stub; everyone else is the
  // SAME reference (no churn for callers, byte-identical user/assistant/tool_use).
  const result: JournalEntry[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const e = entries[i];
    if (!stubSet.has(i)) {
      result[i] = e;
      continue;
    }
    const p = e.payload as Extract<JournalEntry['payload'], { type: 'tool_result' }>;
    const stubbedBlocks: ContentBlock[] = p.blocks.map((b) =>
      isSnapshotTextBlock(b as { type?: string; text?: string })
        ? ({ type: 'text', text: SNAPSHOT_PRUNE_PLACEHOLDER } as ContentBlock)
        : b,
    );
    result[i] = { ...e, payload: { ...p, blocks: stubbedBlocks } };
  }
  return result;
}
