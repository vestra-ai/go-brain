// nami brain v2 — §3b convoCorrection: a cheap, harness-agnostic repair-marker
// heuristic that ROUTES an episode to the capture judge when a user types a
// free-text correction ("no, it's X not Y"). Such a turn produces a plain `user`
// block with no HITL/deny signal, so the §3a salience prefilter would silently
// habituate it and lose the highest-value signal. This is the universal Tier-1
// floor: it works on any transcript and EXTRACTS NOTHING — it only reports whether
// a repair marker fired after a substantive agent action.

import type { JournalBlock } from './episode.js';

/**
 * Repair markers, word-boundary and case-insensitive. A bare opener like
 * "no thanks" must NOT fire on its own — that is enforced by the preceding-action
 * guard in detectConvoCorrection, not by the markers themselves.
 */
export const REPAIR_MARKERS: readonly RegExp[] = [
  /\bno\b/i,
  /\bactually\b/i,
  /\bwrong\b/i,
  /\bi meant\b/i,
  /\bnot /i,
  /\bshould be\b/i,
  /\bthat's not\b/i,
];

/** Blocks that count as a substantive agent action preceding a user correction. */
const SUBSTANTIVE: ReadonlySet<JournalBlock['kind']> = new Set([
  'assistant',
  'tool_use',
  'tool_result',
]);

/**
 * Fires ONLY when a `user` block containing a repair marker FOLLOWS at least one
 * substantive agent action (assistant / tool_use / tool_result) earlier in the
 * list. A marker in the first block, or with no preceding action, does NOT fire —
 * a bare "no thanks" opener is not a correction. Returns whether it fired and the
 * unique markers that matched (lowercased, trimmed). Pure; no I/O.
 */
export function detectConvoCorrection(
  blocks: JournalBlock[],
): { hit: boolean; matched: string[] } {
  const matched = new Set<string>();
  let sawSubstantive = false;
  for (const block of blocks) {
    if (block.kind === 'user') {
      if (sawSubstantive) {
        for (const marker of REPAIR_MARKERS) {
          const m = marker.exec(block.text);
          if (m) matched.add(m[0].trim().toLowerCase());
        }
      }
    } else if (SUBSTANTIVE.has(block.kind)) {
      sawSubstantive = true;
    }
  }
  return { hit: matched.size > 0, matched: [...matched] };
}
