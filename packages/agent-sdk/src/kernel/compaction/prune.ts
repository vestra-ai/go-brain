/**
 * K4-T1b — The prune tier: context-edit microcompaction.
 *
 * A **pure projection-time policy** that truncates the bodies of OLD, LARGE
 * `tool_result` blocks past an age/size threshold. This is a cheaper intermediate
 * tier that runs BEFORE the full summarize-compaction (T1/T2).
 *
 * Precedent: Anthropic context-editing (prune-not-summarize). The durable journal
 * is NEVER touched — this transforms only the in-memory projection the harness
 * sends to the model. No model call, no I/O, no clock, no schema change.
 *
 * PURITY CONTRACT:
 *   - Imports only @bash/shared (type) + the sibling token-ledger (estimateTokens).
 *   - No @anthropic-ai, no @openai, no provider SDK, no clock, no FS.
 *   - Never throws — degenerate input (empty blocks, null text) tolerated silently.
 *
 * PAIR-SAFE + IDEMPOTENT:
 *   - NEVER deletes a tool_result entry (that would orphan its paired tool_use).
 *   - Only shrinks its body text to the deterministic stub
 *     `[pruned: <n> tokens of tool output elided]` (n = the heuristic estimate).
 *   - Already-stubbed results are skipped (idempotent).
 *   - Unchanged entries are returned by the SAME reference (no churn for callers).
 *
 * ELIGIBILITY: a tool_result at idxFromNewest (= entries.length - 1 - i) is eligible
 *   iff idxFromNewest > cfg.ageThresholdEntries
 *    AND estimateTokens(joined body text) > cfg.sizeThresholdTokens
 *    AND it is not already a stub.
 *
 * T2 calls:
 *   pruneToolResults(messages, { ...DEFAULT_COMPACTION.prune, ...cfg.compaction?.prune })
 * BEFORE the token-% trigger predicate (prune may bring the ledger under threshold,
 * skipping the expensive model-call summarize that round).
 */

import type { JournalEntry } from '../../contract/journal.js';
import { estimateTokens } from '../journal/token-ledger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Configuration for the prune tier.
 *
 * Defaults (wired in T2, not hard-coded here):
 *   ageThresholdEntries: 40   — only prune results older than this many entries
 *   sizeThresholdTokens: 2000 — only prune results whose body exceeds this
 */
export interface PruneConfig {
  /** How many entries from the newest a tool_result must be to be eligible. */
  ageThresholdEntries: number;
  /** Minimum estimated token count of the body for eligibility. */
  sizeThresholdTokens: number;
}

// ─── Stub detection ───────────────────────────────────────────────────────────

/** The deterministic stub prefix used to detect already-pruned entries. */
const STUB_PREFIX = '[pruned:';

function isAlreadyStub(blocks: ReadonlyArray<{ type: string; text?: string }>): boolean {
  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string' && b.text.startsWith(STUB_PREFIX)) {
      return true;
    }
  }
  return false;
}

// ─── pruneToolResults ─────────────────────────────────────────────────────────

/**
 * Pure, idempotent, pair-safe prune pass over a journal projection.
 *
 * Single linear pass. Returns a new array where eligible tool_result entries
 * have their body replaced with the deterministic stub. All other entries are
 * returned by the same reference. Never throws.
 */
export function pruneToolResults(
  entries: ReadonlyArray<JournalEntry>,
  cfg: PruneConfig,
): JournalEntry[] {
  const n = entries.length;
  const result: JournalEntry[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const e = entries[i];
    const p = e.payload;

    if (p.type !== 'tool_result') {
      // Non-tool_result entries are never touched — return same reference.
      result[i] = e;
      continue;
    }

    const idxFromNewest = n - 1 - i;

    // Age gate: must be older than the threshold.
    if (idxFromNewest <= cfg.ageThresholdEntries) {
      result[i] = e;
      continue;
    }

    // Already a stub — idempotent: skip, return same reference.
    const blocks = p.blocks as Array<{ type: string; text?: string }>;
    if (isAlreadyStub(blocks)) {
      result[i] = e;
      continue;
    }

    // Estimate body size.
    const bodyText = blocks
      .map((b) => (b.type === 'text' && b.text ? b.text : ''))
      .join(' ');
    const tokenCount = estimateTokens(bodyText);

    // Size gate: must exceed threshold.
    if (tokenCount <= cfg.sizeThresholdTokens) {
      result[i] = e;
      continue;
    }

    // Eligible — shallow-clone entry with pruned body.
    const stub = `[pruned: ${tokenCount} tokens of tool output elided]`;
    const prunedPayload: typeof p = {
      ...p,
      blocks: [{ type: 'text', text: stub }],
    };
    result[i] = { ...e, payload: prunedPayload };
  }

  return result;
}
