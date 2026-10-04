/**
 * Task 6 — pruneScreenshots: the SINGLE native screenshot-prune authority.
 *
 * A **pure projection-time policy** that bounds browser-screenshot context on the
 * native arm. Every `tool_result` from a browser tool carries a full JPEG
 * screenshot (~100KB). Compaction is image-blind — token counting sees only text,
 * so an image-bearing tool_result is ~0 tokens and never triggers summarize/text-
 * prune. Without this pass, screenshots accumulate every browse step until a
 * non-retryable 413 (Anthropic's 20MB per-request ceiling). This pass keeps the
 * latest `KEEP_RECENT_SCREENSHOTS` image-bearing tool_results intact and replaces
 * the image blocks of every OLDER one with a small text placeholder.
 *
 * SINGLE AUTHORITY: this replaces the dead `createScreenshotPruneHook` on the
 * native arm (which rewrote the Claude-SDK session `.jsonl` the native arm never
 * reads). It is wired into `journal.project()` so it runs AFTER
 * suspendPending+applyCompaction+filter — "keep latest 2" therefore means the
 * latest 2 the model will actually see, not 2 that compaction then drops.
 *
 * The placeholder/keep constants are the CANONICAL shared values; the Claude
 * hook (`apps/sandbox/hooks/screenshot-prune-hook.ts`) imports them from here so
 * the two arms can never drift.
 *
 * PURITY CONTRACT (mirrors prune.ts / the compactor):
 *   - ReadonlyArray in; return the SAME array reference when nothing changes
 *     (≤ KEEP_RECENT_SCREENSHOTS image-bearing tool_results).
 *   - No @anthropic-ai, no @openai, no provider SDK, no clock, no FS.
 *   - Never throws — degenerate input (empty array, empty blocks, missing text)
 *     tolerated silently.
 *
 * PAIR-SAFE + IDEMPOTENT:
 *   - NEVER deletes an entry (that would orphan a tool_use → tool_result pair on
 *     BOTH wire formats); NEVER touches `tool_use` entries.
 *   - NEVER touches USER-uploaded images — only `tool_result` payload images
 *     count toward the keep-window and get stubbed.
 *   - Replaces each image block in an OLD tool_result with the placeholder text
 *     block, preserving sibling TextBlocks in that tool_result.
 *   - Already-stubbed results carry no image, so a re-run does not re-count them
 *     → a second run is deep-equal AND returns identity.
 *
 * SCREENSHOT_PRUNE_CACHE_V1 (the host passes a `ScreenshotPrunePolicy`; absent ⇒ the legacy
 * pass above, byte-identical). Without a policy the pass counts EVERY image-bearing tool_result
 * (a Read of a PNG included), so each image Read past the second stubbed the third-newest: an
 * edit in the middle of the history on every image Read. Under CACHE_TIERING_V1 the request
 * keeps one message breakpoint, whose 20-block lookback cannot reach behind an old edit, so
 * each such edit re-sent the whole conversation at the cache-write price (prod task 28edef30:
 * image Reads 3 to 8 each rewrote 99K to 110K tokens). With a policy:
 *   - only the host's screenshot tools count, by exact name (catalog membership, the tool_use
 *     paired with the result; never a name pattern). A Read image, a user upload or any other
 *     tool's image is left alone (the media rail, media-rail.ts, is their physics bound);
 *   - the stubbing moves in batches: the oldest `floor((n - keep) / batch) * batch` are stubbed,
 *     so the history is edited once per `batch` screenshots, never once per screenshot, and
 *     between those steps every earlier entry is byte-stable (the cache prefix holds);
 *   - the stubs are recomputed from the raw journal on every projection, so after a compaction
 *     (or a rewind) the count starts again from what is still in view, and up to 9 screenshots in
 *     the kept tail show as images again. Not a bug: that boundary rewrites the cache anyway, and
 *     the media rail still bounds them.
 * The rail's own policy under the same flag (`rail`, media-rail.ts) bounds every other image:
 * Read images (fitted to 1568 px at the tool, read-image-fit.ts), user uploads, and a screenshot
 * from a tool outside the catalog (a user's MCP browser, a connector): at most 20, under every
 * lane's inline cap, evicted 6 at a time.
 */

import type { JournalEntry } from '../../contract/journal.js';
import type { ContentBlock } from '../../contract/blocks.js';
import type { MediaRailPolicy } from './media-rail.js';

// ─── Canonical shared constants ─────────────────────────────────────────────────
// EXACT values from apps/sandbox/hooks/screenshot-prune-hook.ts. The Claude hook
// now imports these (replacing its local consts) so the arms can't drift.

/** How many recent image-bearing tool_results to keep un-pruned. */
export const KEEP_RECENT_SCREENSHOTS = 2;

/**
 * SCREENSHOT_PRUNE_CACHE_V1: how many screenshots go stub together. The kept count then sits
 * between KEEP_RECENT_SCREENSHOTS and KEEP_RECENT_SCREENSHOTS + batch - 1 (2 to 9): up to seven
 * more screenshots ride each request, read from the cache at a tenth of the input price, against
 * a whole-history cache write avoided at every step in between.
 */
export const SCREENSHOT_PRUNE_BATCH = 8;

/** SCREENSHOT_PRUNE_CACHE_V1: what the host says a screenshot is, and how many to stub at once. */
export interface ScreenshotPrunePolicy {
  /** The exact names of the tools whose image results are screenshots (catalog membership). */
  tools: ReadonlySet<string>;
  /** Stub in steps of this many (>= 1). */
  batch: number;
  /** The media rail's policy under the same flag (media-rail.ts): a byte budget under every lane's cap, batched eviction. */
  rail?: MediaRailPolicy;
}

/** Text placeholder replacing pruned screenshot image blocks. */
export const SCREENSHOT_PRUNE_PLACEHOLDER =
  '[screenshot from earlier turn — truncated for context efficiency]';

// ─── helpers ────────────────────────────────────────────────────────────────────

/** A tool_result entry that carries at least one image block in its payload. */
function isImageBearingToolResult(e: JournalEntry): boolean {
  const p = e.payload;
  if (p.type !== 'tool_result') return false;
  const blocks = p.blocks as ReadonlyArray<{ type?: string }> | undefined;
  if (!Array.isArray(blocks)) return false;
  return blocks.some((b) => b != null && b.type === 'image');
}

/** The tool name behind each tool_use id in this projection (a result names only its id). */
function toolNamesById(entries: ReadonlyArray<JournalEntry>): Map<string, string> {
  const names = new Map<string, string>();
  for (const e of entries) {
    const p = e.payload;
    if (p.type === 'tool_use') names.set(p.toolUseId, p.name);
  }
  return names;
}

// ─── pruneScreenshots ───────────────────────────────────────────────────────────

/**
 * Pure, idempotent, pair-safe screenshot-prune over a journal projection.
 *
 * Two linear passes: (1) collect the indexes of image-bearing tool_results; if
 * ≤ KEEP_RECENT_SCREENSHOTS, return the SAME reference (identity). (2) Otherwise
 * stub the image blocks of every image-bearing tool_result that is NOT among the
 * latest KEEP_RECENT_SCREENSHOTS, returning a new array where touched entries are
 * shallow-cloned and every other entry is returned by the same reference. Never
 * throws.
 */
export function pruneScreenshots(entries: ReadonlyArray<JournalEntry>, policy?: ScreenshotPrunePolicy): JournalEntry[] {
  const n = entries.length;

  // Pass 1 — find the image-bearing tool_result indexes, in order. With a policy, only
  // results of the host's screenshot tools (by the paired tool_use's exact name) count.
  const names = policy ? toolNamesById(entries) : undefined;
  const imageIdx: number[] = [];
  for (let i = 0; i < n; i++) {
    const e = entries[i];
    if (!isImageBearingToolResult(e)) continue;
    if (names && policy) {
      const name = names.get((e.payload as { toolUseId: string }).toolUseId);
      if (name === undefined || !policy.tools.has(name)) continue;
    }
    imageIdx.push(i);
  }

  // Within the keep-window (or none) → nothing to stub → identity.
  if (imageIdx.length <= KEEP_RECENT_SCREENSHOTS) {
    return entries as JournalEntry[];
  }

  // The OLDEST (imageIdx.length - KEEP_RECENT_SCREENSHOTS) image tool_results get
  // their image blocks stubbed. The latest KEEP_RECENT_SCREENSHOTS keep them. With a
  // policy, the count moves only in whole batches (the history is edited once a batch).
  const over = imageIdx.length - KEEP_RECENT_SCREENSHOTS;
  const batch = policy && Number.isFinite(policy.batch) && policy.batch >= 1 ? Math.floor(policy.batch) : 1;
  const stubCount = Math.floor(over / batch) * batch;
  if (stubCount === 0) return entries as JournalEntry[];
  const stubSet = new Set<number>(imageIdx.slice(0, stubCount));

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
      b != null && b.type === 'image'
        ? ({ type: 'text', text: SCREENSHOT_PRUNE_PLACEHOLDER } as ContentBlock)
        : b,
    );
    result[i] = { ...e, payload: { ...p, blocks: stubbedBlocks } };
  }
  return result;
}
