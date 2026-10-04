import { describe, it, expect } from 'vitest';
import { computeJournalStats } from '../journal-stats.js';
import type { JournalEntry } from '../../../contract/journal.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let _seq = 0;
function entry(
  type: JournalEntry['payload']['type'],
  timestamp: string,
  extra: Partial<JournalEntry['payload']> = {},
): JournalEntry {
  const seq = _seq++;
  // Build minimal payload union-safe objects
  let payload: JournalEntry['payload'];
  if (type === 'user') {
    payload = { type: 'user', blocks: [] };
  } else if (type === 'assistant') {
    payload = { type: 'assistant', blocks: [] };
  } else if (type === 'tool_use') {
    payload = { type: 'tool_use', toolUseId: (extra as any).toolUseId ?? `tu-${seq}`, name: 'bash', input: {} };
  } else if (type === 'tool_result') {
    payload = { type: 'tool_result', toolUseId: (extra as any).toolUseId ?? `tu-${seq}`, blocks: [] };
  } else if (type === 'usage') {
    payload = { type: 'usage', intelligence: 0, actions: 0, compute: 0 };
  } else if (type === 'compact_boundary') {
    payload = { type: 'compact_boundary', summaryUuid: 'x', preservedUuids: [], firstKeptId: 'y', trigger: 'auto', preTokens: 0, postTokens: 0 };
  } else if (type === 'label') {
    payload = { type: 'label', name: 'x' };
  } else if (type === 'system') {
    payload = { type: 'system', event: 'test' };
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
    timestamp,
    payload,
  };
}

function toolUseEntry(toolUseId: string, timestamp: string): JournalEntry {
  const seq = _seq++;
  return {
    uuid: `entry-${seq}`,
    parentUuid: `entry-${seq - 1}`,
    seq,
    taskId: 't',
    rootTaskId: 't',
    spawnDepth: 0,
    workspaceId: 'w',
    agentId: 'g',
    principal: { kind: 'system' },
    timestamp,
    payload: { type: 'tool_use', toolUseId, name: 'bash', input: {} },
  };
}

function toolResultEntry(toolUseId: string, timestamp: string): JournalEntry {
  const seq = _seq++;
  return {
    uuid: `entry-${seq}`,
    parentUuid: `entry-${seq - 1}`,
    seq,
    taskId: 't',
    rootTaskId: 't',
    spawnDepth: 0,
    workspaceId: 'w',
    agentId: 'g',
    principal: { kind: 'system' },
    timestamp,
    payload: { type: 'tool_result', toolUseId, blocks: [] },
  };
}

// Reset seq before each describe group
function resetSeq() { _seq = 0; }

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('computeJournalStats — empty journal', () => {
  it('returns all-null / zero-turn stats for an empty entry list', () => {
    resetSeq();
    const stats = computeJournalStats([]);
    expect(stats.turnCount).toBe(0);
    expect(stats.modelLatencyP50Ms).toBeNull();
    expect(stats.modelLatencyP95Ms).toBeNull();
    expect(stats.toolDispatchP50Ms).toBeNull();
    expect(stats.toolDispatchP95Ms).toBeNull();
    expect(stats.medianToolCallsPerTurn).toBeNull();
  });
});

describe('computeJournalStats — single turn model latency', () => {
  it('computes model latency as assistant.timestamp − preceding user.timestamp', () => {
    resetSeq();
    // user at T=0, assistant at T=1000ms → model latency = 1000ms
    const entries: JournalEntry[] = [
      entry('user', '2026-01-01T00:00:00.000Z'),
      entry('assistant', '2026-01-01T00:00:01.000Z'),
    ];
    const stats = computeJournalStats(entries);
    expect(stats.turnCount).toBe(1);
    expect(stats.modelLatencyP50Ms).toBe(1000);
    expect(stats.modelLatencyP95Ms).toBe(1000);
  });
});

describe('computeJournalStats — p50/p95 over multiple turns', () => {
  it('computes exact median on odd count (no interpolation)', () => {
    resetSeq();
    // Three turns with model latencies: 100ms, 200ms, 300ms
    // user0 @ 0, assistant @ 100 → 100ms
    // user1 @ 200, assistant @ 400 → 200ms
    // user2 @ 500, assistant @ 800 → 300ms
    const entries: JournalEntry[] = [
      entry('user',      '2026-01-01T00:00:00.000Z'),
      entry('assistant', '2026-01-01T00:00:00.100Z'),
      entry('user',      '2026-01-01T00:00:00.200Z'),
      entry('assistant', '2026-01-01T00:00:00.400Z'),
      entry('user',      '2026-01-01T00:00:00.500Z'),
      entry('assistant', '2026-01-01T00:00:00.800Z'),
    ];
    const stats = computeJournalStats(entries);
    expect(stats.turnCount).toBe(3);
    // sorted [100, 200, 300], p50 = index floor(3*0.5) = floor(1.5) = 1 → 200
    expect(stats.modelLatencyP50Ms).toBe(200);
    // p95 = index floor(3*0.95) = floor(2.85) = 2 → 300
    expect(stats.modelLatencyP95Ms).toBe(300);
  });
});

describe('computeJournalStats — tool dispatch latency', () => {
  it('computes tool dispatch as tool_result.timestamp − matching tool_use.timestamp by toolUseId', () => {
    resetSeq();
    // tool_use at T=0, tool_result at T=500ms → dispatch = 500ms
    const entries: JournalEntry[] = [
      entry('user', '2026-01-01T00:00:00.000Z'),
      toolUseEntry('tu-1', '2026-01-01T00:00:00.100Z'),
      toolResultEntry('tu-1', '2026-01-01T00:00:00.600Z'),
      entry('assistant', '2026-01-01T00:00:00.700Z'),
    ];
    const stats = computeJournalStats(entries);
    expect(stats.toolDispatchP50Ms).toBe(500);
    expect(stats.toolDispatchP95Ms).toBe(500);
  });

  it('skips orphaned tool_use with no matching tool_result', () => {
    resetSeq();
    // orphaned tu-2 (no tool_result) should not count
    const entries: JournalEntry[] = [
      entry('user', '2026-01-01T00:00:00.000Z'),
      toolUseEntry('tu-1', '2026-01-01T00:00:00.100Z'),
      toolResultEntry('tu-1', '2026-01-01T00:00:00.600Z'), // 500ms
      toolUseEntry('tu-2', '2026-01-01T00:00:00.700Z'),   // orphaned
      entry('assistant', '2026-01-01T00:00:00.800Z'),
    ];
    const stats = computeJournalStats(entries);
    // Only one tool dispatch recorded (tu-1 = 500ms); tu-2 has no result
    expect(stats.toolDispatchP50Ms).toBe(500);
  });
});

describe('computeJournalStats — tool calls per turn', () => {
  it('counts tool_use per turn and computes median', () => {
    resetSeq();
    // Turn 1: 2 tool calls. Turn 2: 1 tool call.
    const entries: JournalEntry[] = [
      entry('user',      '2026-01-01T00:00:00.000Z'),
      toolUseEntry('tu-a', '2026-01-01T00:00:00.100Z'),
      toolResultEntry('tu-a', '2026-01-01T00:00:00.200Z'),
      toolUseEntry('tu-b', '2026-01-01T00:00:00.300Z'),
      toolResultEntry('tu-b', '2026-01-01T00:00:00.400Z'),
      entry('assistant', '2026-01-01T00:00:00.500Z'),
      entry('user',      '2026-01-01T00:00:01.000Z'),
      toolUseEntry('tu-c', '2026-01-01T00:00:01.100Z'),
      toolResultEntry('tu-c', '2026-01-01T00:00:01.200Z'),
      entry('assistant', '2026-01-01T00:00:01.300Z'),
    ];
    const stats = computeJournalStats(entries);
    expect(stats.turnCount).toBe(2);
    // sorted [1, 2], p50 = floor(2*0.5) = floor(1) = 1 → 2
    expect(stats.medianToolCallsPerTurn).toBe(2);
  });
});

describe('computeJournalStats — non-context payload types are ignored', () => {
  it('ignores usage, compact_boundary, and label entries in latency calculations', () => {
    resetSeq();
    // Turn 1: user @ 0, usage noise, assistant @ 1000ms
    const entries: JournalEntry[] = [
      entry('user',            '2026-01-01T00:00:00.000Z'),
      entry('usage',           '2026-01-01T00:00:00.100Z'), // non-context noise
      entry('compact_boundary','2026-01-01T00:00:00.200Z'), // non-context noise
      entry('label',           '2026-01-01T00:00:00.300Z'), // non-context noise
      entry('assistant',       '2026-01-01T00:00:01.000Z'),
    ];
    const stats = computeJournalStats(entries);
    // Model latency = assistant(1000ms) - user(0ms) = 1000ms; non-context entries irrelevant
    expect(stats.turnCount).toBe(1);
    expect(stats.modelLatencyP50Ms).toBe(1000);
  });
});
