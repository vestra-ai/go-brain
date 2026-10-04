/**
 * K4-T1b — pruneToolResults prune-tier tests.
 *
 * Pure in-memory fixtures only. No disk, no Journal, no model call.
 * Mirrors the entry() fixture builder from compactor.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { pruneToolResults } from '../prune.js';
import type { JournalEntry } from '../../../contract/journal.js';
import type { PruneConfig } from '../prune.js';

// ─── Fixture builder ──────────────────────────────────────────────────────────

let _seq = 0;
function resetSeq() {
  _seq = 0;
}

function entry(
  type: JournalEntry['payload']['type'],
  opts: { text?: string; toolUseId?: string; input?: unknown } = {},
): JournalEntry {
  const seq = _seq++;
  const text = opts.text ?? '';
  let payload: JournalEntry['payload'];
  if (type === 'user') {
    payload = { type: 'user', blocks: [{ type: 'text', text }] };
  } else if (type === 'assistant') {
    payload = { type: 'assistant', blocks: [{ type: 'text', text }] };
  } else if (type === 'tool_use') {
    payload = {
      type: 'tool_use',
      toolUseId: opts.toolUseId ?? `tu-${seq}`,
      name: 'bash',
      input: opts.input ?? { cmd: text },
    };
  } else if (type === 'tool_result') {
    payload = {
      type: 'tool_result',
      toolUseId: opts.toolUseId ?? `tu-${seq}`,
      blocks: [{ type: 'text', text }],
    };
  } else if (type === 'compact_boundary') {
    payload = {
      type: 'compact_boundary',
      summaryUuid: 'x',
      preservedUuids: [],
      firstKeptId: 'y',
      trigger: 'auto',
      preTokens: 0,
      postTokens: 0,
    };
  } else {
    payload = { type: 'custom', key: 'x', data: null };
  }
  return {
    uuid: `entry-${seq}`,
    parentUuid: seq === 0 ? null : `entry-${seq - 1}`,
    seq,
    taskId: 't',
    rootTaskId: 't',
    spawnDepth: 0,
    workspaceId: 'w',
    agentId: 'g',
    principal: { kind: 'system' },
    timestamp: '2026-01-01T00:00:00.000Z',
    payload,
  };
}

// A string whose estimateTokens clearly exceeds 2_000 tokens (sizeThresholdTokens default).
// estimateTokens uses max(byChar=len/4, byWord=wordCount*1.3).
// To get > 2_000 tokens: 2_000 * 4 = 8_000 chars. Use "word ".repeat(7000) → ~35_000 chars,
// ~9_100 tokens by char, and 7_000*1.3=9_100 by word → well above 2_000.
const largeBody = 'word '.repeat(7_000);

// A string clearly under the default 2_000-token threshold.
const smallBody = 'tiny result';

// Default config matching the T1b spec defaults.
const DEFAULT_CFG: PruneConfig = {
  ageThresholdEntries: 40,
  sizeThresholdTokens: 2_000,
};

// ─── Case 1: empty input ──────────────────────────────────────────────────────

describe('pruneToolResults — case 1: empty → []', () => {
  it('returns an empty array unchanged', () => {
    resetSeq();
    expect(pruneToolResults([], DEFAULT_CFG)).toEqual([]);
  });
});

// ─── Case 2: all-small tool_results → unchanged (deep-equal) ─────────────────

describe('pruneToolResults — case 2: all-small tool_results → unchanged', () => {
  it('does not prune tool_result entries whose bodies are under sizeThresholdTokens', () => {
    resetSeq();
    // 50 entries so idxFromNewest > ageThresholdEntries=40 for the oldest; small bodies.
    const entries: JournalEntry[] = [];
    for (let i = 0; i < 50; i++) {
      entries.push(entry('tool_use', { toolUseId: `tu-${i}` }));
      entries.push(entry('tool_result', { toolUseId: `tu-${i}`, text: smallBody }));
    }
    const result = pruneToolResults(entries, DEFAULT_CFG);
    expect(result).toEqual(entries);
  });
});

// ─── Case 3: OLD large tool_result gets pruned; others byte-identical ─────────

describe('pruneToolResults — case 3: old large tool_result is pruned', () => {
  it('replaces body of old large tool_result with deterministic stub', () => {
    resetSeq();
    // Build entries: 45 old entries (pair at idx 0-1) + 2 recent (pair at 2-3) + 1 user at 4.
    // Total = 5 entries; idxFromNewest for entry at index 0: 5-1-0 = 4 > ageThresholdEntries=40?
    // No — we need the entry to be > ageThresholdEntries=40 old. Build ~50 entries total
    // so the FIRST tool_result has idxFromNewest = 49 > 40.
    const entries: JournalEntry[] = [];
    const toolUseId = 'tu-old-large';
    // Entry 0 = tool_use (old), entry 1 = tool_result (old, large), rest are small recent pairs.
    entries.push(entry('tool_use', { toolUseId }));
    entries.push(entry('tool_result', { toolUseId, text: largeBody }));
    for (let i = 2; i < 50; i++) {
      entries.push(entry('tool_use', { toolUseId: `tu-${i}` }));
      entries.push(entry('tool_result', { toolUseId: `tu-${i}`, text: smallBody }));
    }
    // Total entries = 2 + 48 = 50.
    // idxFromNewest for entry[1] (the old tool_result): 50-1-1 = 48 > 40 ✓

    const result = pruneToolResults(entries, DEFAULT_CFG);

    // The old large tool_result (index 1) should be pruned.
    const originalTR = entries[1];
    const prunedTR = result[1];
    expect(prunedTR).not.toBe(originalTR); // different reference (shallow clone)
    expect(prunedTR.payload.type).toBe('tool_result');
    const prunedPayload = prunedTR.payload as { type: 'tool_result'; toolUseId: string; blocks: Array<{ type: string; text?: string }> };
    expect(prunedPayload.blocks).toHaveLength(1);
    expect(prunedPayload.blocks[0].text).toMatch(/^\[pruned: \d+ tokens of tool output elided\]$/);

    // Every other entry must be byte-identical (same reference).
    for (let i = 0; i < result.length; i++) {
      if (i === 1) continue;
      expect(result[i]).toBe(entries[i]);
    }
  });
});

// ─── Case 4: RECENT large tool_result → NOT pruned ───────────────────────────

describe('pruneToolResults — case 4: recent large tool_result is NOT pruned', () => {
  it('does not prune a tool_result within the age window even if body is large', () => {
    resetSeq();
    // Only 5 entries total; the tool_result at index 1 has idxFromNewest = 5-1-1 = 3 < 40.
    const toolUseId = 'tu-recent-large';
    const entries: JournalEntry[] = [
      entry('user'),
      entry('tool_use', { toolUseId }),
      entry('tool_result', { toolUseId, text: largeBody }),
      entry('assistant'),
      entry('user'),
    ];
    // idxFromNewest for the tool_result at idx 2: 5-1-2 = 2 < 40 → NOT eligible.

    const result = pruneToolResults(entries, DEFAULT_CFG);

    // All entries returned by reference (none pruned).
    for (let i = 0; i < result.length; i++) {
      expect(result[i]).toBe(entries[i]);
    }
  });
});

// ─── Case 5: pair-safe — entry count unchanged, toolUseId preserved ──────────

describe('pruneToolResults — case 5: pair-safe (entry count unchanged, toolUseId preserved)', () => {
  it('NEVER deletes a tool_result entry; keeps toolUseId intact on pruned entry', () => {
    resetSeq();
    const toolUseId = 'tu-paired';
    const entries: JournalEntry[] = [];
    entries.push(entry('tool_use', { toolUseId }));
    entries.push(entry('tool_result', { toolUseId, text: largeBody }));
    for (let i = 2; i < 50; i++) {
      entries.push(entry('user'));
    }
    // entry at index 1 is the tool_result; idxFromNewest = 50-1-1 = 48 > 40, eligible.

    const result = pruneToolResults(entries, DEFAULT_CFG);

    // Count unchanged.
    expect(result.length).toBe(entries.length);

    // The pruned entry still has the correct toolUseId (pair-safe).
    const pruned = result[1];
    expect(pruned.payload.type).toBe('tool_result');
    const prunedPayload = pruned.payload as { type: 'tool_result'; toolUseId: string; blocks: unknown[] };
    expect(prunedPayload.toolUseId).toBe(toolUseId);

    // The paired tool_use is untouched.
    expect(result[0]).toBe(entries[0]);
  });
});

// ─── Case 6: idempotent ───────────────────────────────────────────────────────

describe('pruneToolResults — case 6: idempotent', () => {
  it('pruneToolResults(pruneToolResults(x)) === pruneToolResults(x) (already-stubbed skipped)', () => {
    resetSeq();
    const toolUseId = 'tu-idem';
    const entries: JournalEntry[] = [];
    entries.push(entry('tool_use', { toolUseId }));
    entries.push(entry('tool_result', { toolUseId, text: largeBody }));
    for (let i = 2; i < 50; i++) {
      entries.push(entry('user'));
    }

    const once = pruneToolResults(entries, DEFAULT_CFG);
    const twice = pruneToolResults(once, DEFAULT_CFG);

    // The pruned entry in `once` should be returned by the SAME reference in `twice`
    // (skipped because it is already a stub).
    expect(twice[1]).toBe(once[1]);

    // The whole result is deep-equal.
    expect(twice).toEqual(once);
  });
});

// ─── Case 7: non-tool_result entries never touched ───────────────────────────

describe('pruneToolResults — case 7: non-tool_result entries never touched', () => {
  it('leaves user, assistant, tool_use, compact_boundary entries by reference', () => {
    resetSeq();
    // 50 entries, none are tool_result.
    const entries: JournalEntry[] = [];
    for (let i = 0; i < 50; i++) {
      if (i % 2 === 0) entries.push(entry('user', { text: largeBody }));
      else entries.push(entry('assistant', { text: largeBody }));
    }

    const result = pruneToolResults(entries, DEFAULT_CFG);

    for (let i = 0; i < result.length; i++) {
      expect(result[i]).toBe(entries[i]);
    }
  });
});

// ─── Case 8: never throws on degenerate entry ─────────────────────────────────

describe('pruneToolResults — case 8: never throws on degenerate input', () => {
  it('tolerates a tool_result with an empty or missing blocks array', () => {
    resetSeq();
    const toolUseId = 'tu-degenerate';
    // tool_result with empty blocks.
    const degeneratePayload: JournalEntry['payload'] = {
      type: 'tool_result',
      toolUseId,
      blocks: [],
    };
    const entries: JournalEntry[] = [];
    // Add the degenerate entry at position 0.
    entries.push({
      uuid: 'entry-0',
      parentUuid: null,
      seq: 0,
      taskId: 't',
      rootTaskId: 't',
      spawnDepth: 0,
      workspaceId: 'w',
      agentId: 'g',
      principal: { kind: 'system' },
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: degeneratePayload,
    });
    // Pad to 50 entries so the degenerate one has idxFromNewest=49 > 40.
    for (let i = 1; i < 50; i++) {
      entries.push(entry('user'));
    }

    // Must not throw regardless of the empty blocks / zero-token body.
    expect(() => pruneToolResults(entries, DEFAULT_CFG)).not.toThrow();
  });
});
