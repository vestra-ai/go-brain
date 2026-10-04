import { describe, it, expect } from 'vitest';
import { planCompaction, computePausedToolUseIds } from '../compactor.js';
import type { JournalEntry, JournalPayload } from '../../../contract/journal.js';

let _seq = 0;
function entry(payload: JournalPayload): JournalEntry {
  const seq = _seq++;
  return {
    uuid: `entry-${seq}`, parentUuid: seq === 0 ? null : `entry-${seq - 1}`, seq,
    taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g',
    principal: { kind: 'system' }, timestamp: '2026-06-15T00:00:00.000Z', payload,
  };
}
const big = (label: string) => `${label} ${'word '.repeat(60)}`;
const fakeSummarize = async (e: JournalEntry[]) => `SUMMARY(${e.length})`;

describe('K5-T1: computePausedToolUseIds — toolUseIds bound to an UNRESOLVED interaction with no result', () => {
  it('returns the paused tool_use id; excludes answered + resolved', () => {
    const all: JournalEntry[] = [
      entry({ type: 'user', blocks: [{ type: 'text', text: 'go' }] }),
      entry({ type: 'tool_use', toolUseId: 'tuPaused', name: 'X', input: {} }),
      entry({ type: 'interaction', interactionId: 'i1', resolved: false, data: { kind: 'composio_auth', toolUseId: 'tuPaused', toolName: 'X' } }),
      entry({ type: 'tool_use', toolUseId: 'tuDone', name: 'Y', input: {} }),
      entry({ type: 'tool_result', toolUseId: 'tuDone', blocks: [] }),
      entry({ type: 'interaction', interactionId: 'i2', resolved: false, data: { kind: 'ask_question', toolUseId: 'tuDone', toolName: 'Y' } }),
    ];
    const paused = computePausedToolUseIds(all);
    expect([...paused]).toEqual(['tuPaused']); // tuDone is answered → not paused
  });

  it('excludes a tool_use whose interaction is RESOLVED', () => {
    const all: JournalEntry[] = [
      entry({ type: 'tool_use', toolUseId: 'tu1', name: 'X', input: {} }),
      entry({ type: 'interaction', interactionId: 'i1', resolved: false, data: { kind: 'composio_auth', toolUseId: 'tu1', toolName: 'X' } }),
      entry({ type: 'interaction', interactionId: 'i1', resolved: true, data: { outcome: { behavior: 'allow' } } }),
      entry({ type: 'tool_result', toolUseId: 'tu1', blocks: [] }),
    ];
    expect([...computePausedToolUseIds(all)]).toHaveLength(0);
  });
});

describe('K5-T1: avoidOrphanPair PINS a paused tool_use (the cut retreats to preserve it) — assertCompactionPinsPausedToolUse', () => {
  // user/assistant/user/tool_use(paused)/[big tail] — the natural cut drops the paused tool_use;
  // the pin must retreat the cut so it survives to pair with its (future) materialized result.
  //
  // T9b re-rule (fixture only, NOT the assertion): entries 0-1 carry `big()` text
  // instead of 'u0'/'a0'. They are the whole DROPPED span in the retreat case, and
  // the planner now refuses a compaction whose dropped span is no larger than its
  // summary (Hermes's guard) — two 1-token entries lose that comparison to the
  // 3-token fake summary. The token walk never reaches index 0-1 (it stops at
  // index 5), so the CUT this test is about is unchanged in both cases.
  function fixture(): JournalEntry[] {
    _seq = 0;
    return [
      entry({ type: 'user', blocks: [{ type: 'text', text: big('u0') }] }),            // 0
      entry({ type: 'assistant', blocks: [{ type: 'text', text: big('a0') }] }),       // 1
      entry({ type: 'user', blocks: [{ type: 'text', text: 'u1' }] }),                 // 2 (retreat boundary)
      entry({ type: 'tool_use', toolUseId: 'tuPaused', name: 'GMAIL', input: {} }),    // 3 PAUSED (no result)
      entry({ type: 'user', blocks: [{ type: 'text', text: big('u2') }] }),            // 4
      entry({ type: 'assistant', blocks: [{ type: 'text', text: big('a2') }] }),       // 5
      entry({ type: 'user', blocks: [{ type: 'text', text: big('u3') }] }),            // 6
      entry({ type: 'assistant', blocks: [{ type: 'text', text: big('a3') }] }),       // 7
    ];
  }
  const droppedIds = (plan: { droppedEntries: JournalEntry[] }) => plan.droppedEntries.map((e) => e.uuid);

  it('WITHOUT the pin, the natural cut DROPS the paused tool_use', async () => {
    const plan = await planCompaction({ entries: fixture(), keepWindowTokens: 160, preTokens: 0, summarize: fakeSummarize });
    expect(droppedIds(plan)).toContain('entry-3'); // tuPaused dropped (it's just an orphan to the compactor)
  });

  it('WITH the pin, the cut RETREATS so the paused tool_use is KEPT', async () => {
    const entries = fixture();
    const plan = await planCompaction({
      entries, keepWindowTokens: 160, preTokens: 0, summarize: fakeSummarize,
      pausedToolUseIds: new Set(['tuPaused']),
    });
    expect(droppedIds(plan)).not.toContain('entry-3'); // tuPaused preserved on the kept side
    // and it still compacted SOMETHING (the earliest turn) — the pin retreats, it doesn't skip
    expect(plan.droppedEntries.length).toBeGreaterThan(0);
  });
});
