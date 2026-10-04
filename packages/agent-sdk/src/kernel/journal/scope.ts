import type { JournalEntry } from '../../contract/journal.js';
import { subagentIdFromPath, type SubagentId } from '../../contract/subagent-path.js';

// The per-scope readers, moved out of journal.ts (at its size ratchet) unchanged; journal.ts
// re-exports both, so every importer is untouched.

/**
 * T11a (durable subagent deep-HITL, Phase B) — the SCOPED projection reader: the raw
 * journal entries that belong to EXACTLY one agent scope, in `seq` order.
 *
 * `target` is the leaf `SubagentId` (an entry's deepest `agentPath` segment's
 * `agentToolUseId`), or `undefined` for the MAIN agent (entries with no/empty
 * `agentPath`). Selection is EXACT-LEAF-MATCH, never prefix: a subagent's own
 * conversation includes a nested grandchild's `Agent` tool_use + its tool_result (single
 * entries tagged with the SUBAGENT's path) but NOT the grandchild's inner rounds (those
 * carry the grandchild's deeper leaf as their scope).
 *
 * Order is recovered by `seq`, NOT `parentUuid`: the single per-task Journal threads
 * `parentUuid = leafUuid` GLOBALLY, so concurrent distinct-path siblings interleave into
 * one linear chain and a scoped entry's `parentUuid` can point into another scope. Sorting
 * the filtered set by `seq` restores each scope's true within-scope order regardless of
 * the cross-scope chain or the input order. PURE — returns a fresh array, never mutates
 * `entries`. (Whole-journal suspension scans deliberately do NOT use this — they stay
 * depth-blind so deep re-suspend keeps working.)
 */
export function projectScope(
  entries: readonly JournalEntry[],
  target: SubagentId | undefined,
): JournalEntry[] {
  return entries
    .filter((e) => subagentIdFromPath(e.agentPath ?? []) === target)
    .sort((a, b) => a.seq - b.seq);
}

/**
 * T11b (durable subagent deep-HITL, Phase B) — keep only the LAST `tool_result` per
 * `toolUseId`, dropping earlier ones in place (order otherwise preserved).
 *
 * A subagent RE-ENTRY answers the parent `Agent` tool_use (A1) with the real subagent
 * summary AFTER the pause already wrote A1's `{status:'deferred'}` placeholder — so A1
 * carries TWO tool_results. A provider request with two tool_result blocks for one
 * tool_use_id is malformed; the real answer must win. A re-pause likewise leaves two
 * deferred placeholders before the eventual real result; keep-last covers that too.
 *
 * PURE; returns the SAME array reference when no id has >1 result (the normal case:
 * one result per tool_use), so flag-off / depth-0 deferred / every pre-T11b projection
 * is byte-identical.
 */
export function keepLastToolResultPerId(entries: JournalEntry[]): JournalEntry[] {
  const lastIdx = new Map<string, number>();
  let dupes = 0;
  entries.forEach((e, i) => {
    if (e.payload.type !== 'tool_result') return;
    if (lastIdx.has(e.payload.toolUseId)) dupes++;
    lastIdx.set(e.payload.toolUseId, i);
  });
  if (dupes === 0) return entries; // identity — no duplicate results
  return entries.filter(
    (e, i) => e.payload.type !== 'tool_result' || lastIdx.get(e.payload.toolUseId) === i,
  );
}
