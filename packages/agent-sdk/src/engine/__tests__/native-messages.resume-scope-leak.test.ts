import { describe, it, expect, vi, afterEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { JournalEntry, JournalPayload } from '../../contract/journal.js';
import { journalToAnthropicMessages } from '../native-messages.js';
import { unansweredToolUseIds } from '../request-validity.js';

/**
 * The live weave-deep resume-400 shape (task 1067a95b): a MAIN-scope Weave tool_use and a
 * SCOPE-TAGGED inner Bash both fold into one assistant turn (an UNSCOPED projection — the
 * runtime shape that `project()` would never produce), and the Weave tool_result lands two
 * turns later, an intervening scope-tagged assistant separating it from its tool_use.
 * Anthropic 400s "tool_use ... without tool_result immediately after". The adjacency floor
 * must (a) fire the LOUD tripwire (so a re-drill hands us the raw shape) and (b) repair the
 * request without dropping content.
 */
const base = {
  taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g',
  principal: { kind: 'system' as const }, timestamp: '',
};
const NODE = [{ depth: 1, agentToolUseId: 'node-1', agentSlug: 'general-purpose', agentName: 'general-purpose' }];

function e(seq: number, payload: JournalPayload, agentPath?: typeof NODE): JournalEntry {
  return { uuid: `e${seq}`, parentUuid: seq === 0 ? null : `e${seq - 1}`, seq, ...base, ...(agentPath ? { agentPath } : {}), payload } as unknown as JournalEntry;
}

function scopeLeakJournal(): JournalEntry[] {
  return [
    e(0, { type: 'user', blocks: [{ type: 'text', text: 'delete the file' } as never] }),
    e(1, { type: 'assistant', blocks: [{ type: 'text', text: 'weaving' } as never] }),
    e(2, { type: 'tool_use', toolUseId: 'toolu_weave', name: 'Weave', input: {} }),
    e(3, { type: 'tool_use', toolUseId: 'toolu_inner', name: 'Bash', input: { command: 'rm x' } }, NODE),
    e(4, { type: 'interaction', interactionId: 'i1', resolved: false, data: { kind: 'tool_permission', toolUseId: 'toolu_weave', toolName: 'Bash', weavePending: { contentHash: 'h' } } }),
    e(5, { type: 'tool_result', toolUseId: 'toolu_inner', blocks: [{ type: 'text', text: 'inner out' } as never], isError: false }, NODE),
    e(6, { type: 'assistant', blocks: [{ type: 'text', text: 'node summary' } as never] }, NODE),
    e(7, { type: 'tool_result', toolUseId: 'toolu_weave', blocks: [{ type: 'text', text: 'weave out' } as never], isError: false }),
    e(8, { type: 'interaction', interactionId: 'i1', resolved: true, data: {} }),
  ];
}

afterEach(() => vi.restoreAllMocks());

describe('native-messages — the weave scope-leak resume-400 shape (live 1067a95b)', () => {
  it('fires the LOUD tripwire AND repairs the request to a valid, content-preserving shape', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const msgs = journalToAnthropicMessages(scopeLeakJournal()) as Anthropic.MessageParam[];

    // (i) The raw shape tripped the loud tripwire with the unanswered id + the seq watermark.
    const fired = err.mock.calls.map((c) => String(c[0]));
    expect(fired.some((l) => l.includes('[hitl-resume-400-tripwire]') && l.includes('toolu_weave'))).toBe(true);
    expect(fired.some((l) => l.includes('journalSeqWatermark=8'))).toBe(true);
    // The floor's own relocate log also fired.
    expect(fired.some((l) => l.includes('[hitl-adjacency-floor-repair]') && l.includes('toolu_weave'))).toBe(true);

    // (ii) Every assistant tool_use is answered in the immediately-following user turn.
    expect(unansweredToolUseIds(msgs)).toEqual([]);
    // (iii) Content preserved (gathered, not stripped) — both results survive on the wire.
    const flat = JSON.stringify(msgs);
    expect(flat).toContain('weave out');
    expect(flat).toContain('inner out');
  });
});
