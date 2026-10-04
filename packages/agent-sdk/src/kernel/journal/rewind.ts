import { isContextEntry, type JournalEntry } from '../../contract/journal.js';

// Moved out of journal.ts (at its size ratchet) unchanged, apart from the export.

/**
 * P2.4 — pure rewind projection. EVERY `rewind_boundary` contributes an abandoned-span
 * window `(pivotSeq, boundarySeq)`; a CONTEXT entry is excluded if it falls in ANY window,
 * so the model sees history as of each pivot. The windows are CUMULATIVE — an earlier
 * rewind's abandoned span never resurrects when a later rewind (whose window doesn't cover
 * it) is added. "Last boundary wins" is the emergent special case: a later rewind to an
 * earlier-or-equal pivot yields a window that subsumes the earlier one. Pre-pivot context,
 * each post-boundary continuation, and ALL non-context state (todos/usage/interactions/
 * boundaries) survive. Runs on the seq-sorted `main` scope, right before `applyCompaction`
 * (so a surviving compaction still composes). Identity (same reference) when there is no
 * resolvable rewind_boundary ⇒ byte-identical to the no-rewind path. A missing pivot (e.g.
 * quarantined) degrades PER-BOUNDARY — its window is skipped, the others still apply, and it
 * never hides everything. PURE — never mutates the input (the read-model is returned by ref).
 *
 * A COMPACTION inside a window goes with it (harness to nine R4b): its summary is a context entry
 * the window drops, so keeping its `compact_boundary` would leave applyCompaction, which reads only
 * the LAST boundary, a boundary with no summary; it would degrade to the whole uncompacted journal
 * (every earlier compaction ignored too) and report `compaction_anchor_missing` on every round.
 * Dropped, the newest compaction at or before the pivot leads instead, or none.
 */
export function applyRewind(all: JournalEntry[]): JournalEntry[] {
  const windows: Array<{ lo: number; hi: number }> = [];
  for (const e of all) {
    if (e.payload.type !== 'rewind_boundary') continue;
    const { pivotUuid } = e.payload as Extract<JournalEntry['payload'], { type: 'rewind_boundary' }>;
    const pivot = all.find((x) => x.uuid === pivotUuid);
    if (!pivot) continue; // pivot lost (e.g. quarantined) → skip THIS boundary, keep the rest
    windows.push({ lo: pivot.seq, hi: e.seq });
  }
  if (windows.length === 0) return all; // identity — no (resolvable) rewind
  return all.filter(
    (e) => !((isContextEntry(e) || e.payload.type === 'compact_boundary') && windows.some((w) => e.seq > w.lo && e.seq < w.hi)),
  );
}
