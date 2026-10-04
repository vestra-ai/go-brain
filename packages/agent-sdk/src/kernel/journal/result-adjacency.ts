/**
 * keepToolResultsAdjacent — the projection's pairing rule: a `tool_result` sits right
 * after the run of `tool_use` entries its call belongs to, before any later call or turn.
 *
 * The journal records entries in TIME order, and time order is not always wire order.
 * Live prod task 28edef30 (2026-09-28): a stale approval card resolved while another
 * Bash step was paused, and its continue wrote the forward-resume breadcrumb (a
 * user-role entry) straight after that step's open tool_use. When the step was approved
 * its result landed AFTER the breadcrumb. Every provider needs the result right after
 * its call (Anthropic: "tool_use ids were found without tool_result blocks immediately
 * after"; Chat Completions and Gemini have the same rule), and every later turn replayed
 * the same journal, so the task could never run again.
 *
 * The same late result also lands after LATER CALLS of its own batch: a paused call
 * followed by sequential siblings journals [use a, use b, result b, use c, result c],
 * and a's result (from the continue, or the defer when the person types instead) comes
 * last. The Anthropic and Gemini projections open a new assistant turn at `use c` when
 * they cannot replay the round's sealed message (an older journal, or a task that
 * switched models), so a's result answered the wrong turn: the Anthropic floor had to
 * repair it loudly, and Gemini's orphan strip dropped the call and its result silently.
 * Found by the pairing property test (history-pairing.property.test.ts).
 *
 * The writes are true to what happened; the projection owns the wire order. A call's
 * UNIT is its run of consecutive tool_use entries plus the tool_result run that follows
 * it. A result that landed outside its call's unit moves up to the end of that unit,
 * keeping the relative order of results. Nothing is dropped and nothing moves before its
 * call, so a journal already in this shape reads fixed with no data surgery.
 *
 * PURE. Identity (same reference) when every result already sits in its call's unit,
 * which is every journal the live loop writes before a pause resolves, so those
 * projections are byte-identical.
 */

import type { JournalEntry } from '../../contract/journal.js';

export function keepToolResultsAdjacent(entries: JournalEntry[]): JournalEntry[] {
  // unitEnd[i] (i a tool_use) = the index of the first entry after i's unit: the next
  // tool_use that follows a tool_result, or the first non-tool entry (entries.length when none).
  const unitEnd = new Array<number>(entries.length);
  for (let i = 0; i < entries.length;) {
    if (entries[i].payload.type !== 'tool_use') { i++; continue; }
    const start = i;
    while (i < entries.length && entries[i].payload.type === 'tool_use') i++;
    while (i < entries.length && entries[i].payload.type === 'tool_result') i++;
    for (let k = start; k < i; k++) unitEnd[k] = i;
  }

  const callAt = new Map<string, number>(); // toolUseId → index of its tool_use
  const insertBefore = new Map<number, JournalEntry[]>(); // boundary index → results to place ahead of it
  const moved = new Set<number>();
  entries.forEach((e, i) => {
    if (e.payload.type === 'tool_use') {
      callAt.set(e.payload.toolUseId, i);
      return;
    }
    if (e.payload.type !== 'tool_result') return;
    const call = callAt.get(e.payload.toolUseId);
    if (call === undefined) return; // no call before it (compacted away): the request floor's orphan strip owns it
    const boundary = unitEnd[call];
    if (i < boundary) return; // already in its call's unit
    const list = insertBefore.get(boundary) ?? [];
    list.push(e);
    insertBefore.set(boundary, list);
    moved.add(i);
  });
  if (moved.size === 0) return entries;

  const out: JournalEntry[] = [];
  entries.forEach((e, i) => {
    const hoisted = insertBefore.get(i);
    if (hoisted) out.push(...hoisted);
    if (!moved.has(i)) out.push(e);
  });
  return out;
}
