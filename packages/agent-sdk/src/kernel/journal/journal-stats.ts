/**
 * K3-T0 — pure journal latency statistics.
 *
 * Computes turn-level latency metrics from a pre-loaded JournalEntry slice.
 * No I/O, no clock reads, no dependencies beyond @bash/shared.
 * Single linear pass. Safe to call from any context — never throws.
 */

import type { JournalEntry } from '../../contract/journal.js';
import { isRealUserTurn } from '../../contract/injected-user-text.js';

export interface JournalTurnStats {
  /** Number of complete user→assistant turn boundaries found. */
  turnCount: number;
  /** p50 model latency (assistant.timestamp − preceding user.timestamp), ms. Null if no turns. */
  modelLatencyP50Ms: number | null;
  /** p95 model latency, ms. Null if no turns. */
  modelLatencyP95Ms: number | null;
  /** p50 tool dispatch latency (tool_result.timestamp − tool_use.timestamp), ms. Null if no dispatches. */
  toolDispatchP50Ms: number | null;
  /** p95 tool dispatch latency, ms. Null if no dispatches. */
  toolDispatchP95Ms: number | null;
  /** Median tool_use count per turn (user→next-user boundary). Null if no turns. */
  medianToolCallsPerTurn: number | null;
}

/** Payload types that contribute to context (and therefore to latency measurement).
 *  Non-context types (usage, compact_boundary, label, mode, custom, interaction) are skipped. */
const CONTEXT_TYPES = new Set<JournalEntry['payload']['type']>([
  'user',
  'assistant',
  'tool_use',
  'tool_result',
  'system',
  'custom_message',
]);

/** Return the percentile value from a pre-sorted numeric array.
 *  Uses floor(len * p), clamped to [0, len-1]. Returns null for empty arrays. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[idx];
}

/**
 * Pure projection over a pre-loaded JournalEntry array.
 * Never reads disk, never throws. All timestamps are ISO 8601 strings.
 */
export function computeJournalStats(entries: JournalEntry[]): JournalTurnStats {
  const modelLatencies: number[] = [];
  const toolDispatches: number[] = [];
  const toolCallsPerTurn: number[] = [];

  /** Timestamp of the last user entry seen (ms since epoch). */
  let lastUserTs: number | null = null;
  /** tool_use entries awaiting a matching tool_result, keyed by toolUseId. */
  const pendingToolUse = new Map<string, number>(); // toolUseId → startMs
  /** tool_use count within the current turn. */
  let currentTurnToolCount = 0;

  for (const e of entries) {
    const type = e.payload.type;

    // Skip non-context types entirely (usage, compact_boundary, label, mode, custom, interaction)
    if (!CONTEXT_TYPES.has(type)) continue;

    const tsMs = Date.parse(e.timestamp);
    if (!Number.isFinite(tsMs)) continue;

    // A turn opens on a REAL user entry only. An engine-minted one (a recall fence,
    // the T9c split-turn continuation marker) is the loop writing into the user
    // channel, and counting it cut one compacted turn into two halves — halving
    // tool-calls-per-turn and measuring model latency from the marker.
    if (type === 'user' && isRealUserTurn(e)) {
      // Close the previous turn's tool count
      if (lastUserTs !== null) {
        toolCallsPerTurn.push(currentTurnToolCount);
      }
      lastUserTs = tsMs;
      currentTurnToolCount = 0;
      // Reset pending tool uses at turn boundary
      pendingToolUse.clear();
    } else if (type === 'assistant') {
      if (lastUserTs !== null) {
        const latency = tsMs - lastUserTs;
        if (latency >= 0) {
          modelLatencies.push(latency);
        }
        // Close this turn — next user will open a new one.
        // We do NOT reset lastUserTs here; it persists until the next user entry
        // so that multi-assistant turns don't double-count. Instead we push
        // tool count at the NEXT user boundary above.
      }
    } else if (type === 'tool_use') {
      const payload = e.payload as { type: 'tool_use'; toolUseId: string };
      pendingToolUse.set(payload.toolUseId, tsMs);
      currentTurnToolCount++;
    } else if (type === 'tool_result') {
      const payload = e.payload as { type: 'tool_result'; toolUseId: string };
      const startMs = pendingToolUse.get(payload.toolUseId);
      if (startMs !== undefined) {
        const dispatch = tsMs - startMs;
        if (dispatch >= 0) {
          toolDispatches.push(dispatch);
        }
        pendingToolUse.delete(payload.toolUseId);
      }
      // orphaned tool_result (no matching tool_use) → silently ignored
    }
    // system, custom_message → context but not latency-relevant; skip
  }

  // Close last turn's tool count if we had at least one user entry
  if (lastUserTs !== null) {
    toolCallsPerTurn.push(currentTurnToolCount);
  }

  const turnCount = modelLatencies.length;

  modelLatencies.sort((a, b) => a - b);
  toolDispatches.sort((a, b) => a - b);
  toolCallsPerTurn.sort((a, b) => a - b);

  return {
    turnCount,
    modelLatencyP50Ms: percentile(modelLatencies, 0.5),
    modelLatencyP95Ms: percentile(modelLatencies, 0.95),
    toolDispatchP50Ms: percentile(toolDispatches, 0.5),
    toolDispatchP95Ms: percentile(toolDispatches, 0.95),
    medianToolCallsPerTurn: toolCallsPerTurn.length > 0 ? percentile(toolCallsPerTurn, 0.5) : null,
  };
}
