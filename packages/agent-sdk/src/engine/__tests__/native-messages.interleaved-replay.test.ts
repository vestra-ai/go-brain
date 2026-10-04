import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { journalToAnthropicMessages } from '../native-messages.js';
import type { JournalEntry, JournalPayload } from '../../contract/journal.js';

/**
 * PR2 — journal → Anthropic Messages replay for an INTERLEAVED thinking + tool_use
 * turn. The integration test the plan demands (an in-memory accumulator stub would
 * not catch journal-projection bugs — that gap let PR1's Critical slip past round 1).
 *
 * A turn that emitted think(A)→tool(1)→think(B)→tool(2) is journaled as ONE
 * `assistant` entry carrying the verbatim `anthropicBlocks` channel, plus the usual
 * separate `tool_use` + `tool_result` entries (kept for tool-result matching, orphan
 * healing, suspend/continue). On replay, the assistant message MUST be the verbatim
 * order, the tool_use entries MUST NOT double-fold, and the tool_results follow.
 */

let seq = 0;
function entry(payload: JournalPayload): JournalEntry {
  seq += 1;
  return {
    uuid: `u${seq}`,
    parentUuid: seq === 1 ? null : `u${seq - 1}`,
    seq,
    taskId: 't',
    rootTaskId: 't',
    spawnDepth: 0,
    workspaceId: 'w',
    agentId: 'native',
    principal: { kind: 'agent', agentId: 'native' },
    timestamp: '2026-06-26T00:00:00.000Z',
    payload,
  };
}

function interleavedJournal(): JournalEntry[] {
  seq = 0;
  return [
    entry({ type: 'user', blocks: [{ type: 'text', text: 'compare a and b' }] }),
    entry({
      type: 'assistant',
      // `blocks` is the frontend/persist shape (thinking-first bucket, no tool_use).
      blocks: [{ type: 'thinking', thinking: 'A', signature: 'sigA' }],
      // The verbatim wire channel — emission order with tool_use interleaved.
      anthropicBlocks: [
        { type: 'thinking', thinking: 'A', signature: 'sigA' },
        { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/a' } },
        { type: 'thinking', thinking: 'B', signature: 'sigB' },
        { type: 'tool_use', id: 'tu_2', name: 'Read', input: { path: '/b' } },
      ],
    }),
    entry({ type: 'tool_use', toolUseId: 'tu_1', name: 'Read', input: { path: '/a' } }),
    entry({ type: 'tool_use', toolUseId: 'tu_2', name: 'Read', input: { path: '/b' } }),
    entry({ type: 'tool_result', toolUseId: 'tu_1', blocks: [{ type: 'text', text: 'file a' }] }),
    entry({ type: 'tool_result', toolUseId: 'tu_2', blocks: [{ type: 'text', text: 'file b' }] }),
  ];
}

describe('journalToAnthropicMessages — interleaved thinking + tool_use replay', () => {
  it('replays the assistant turn in EXACT emission order, with signatures intact', () => {
    const messages = journalToAnthropicMessages(interleavedJournal());
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant!.content).toEqual([
      { type: 'thinking', thinking: 'A', signature: 'sigA' },
      { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/a' } },
      { type: 'thinking', thinking: 'B', signature: 'sigB' },
      { type: 'tool_use', id: 'tu_2', name: 'Read', input: { path: '/b' } },
    ]);
  });

  it('does NOT double-fold: the separate tool_use entries are not re-appended', () => {
    const messages = journalToAnthropicMessages(interleavedJournal());
    // Exactly ONE assistant message; exactly two tool_use blocks total across it.
    const assistants = messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    const toolUseCount = (assistants[0].content as Anthropic.ContentBlockParam[]).filter(
      (b) => b.type === 'tool_use',
    ).length;
    expect(toolUseCount).toBe(2);
  });

  it('the thinking block stays FIRST even after the validity floor runs', () => {
    const messages = journalToAnthropicMessages(interleavedJournal());
    const assistant = messages.find((m) => m.role === 'assistant')!;
    const blocks = assistant.content as Anthropic.ContentBlockParam[];
    // The 2nd thinking block must remain at index 2 (after tool_use 1), NOT hoisted
    // to index 1 — that hoist is exactly the signature-invalidating reorder.
    expect(blocks[1].type).toBe('tool_use');
    expect(blocks[2].type).toBe('thinking');
  });

  it('projects the tool_results as user turns after the assistant message', () => {
    const messages = journalToAnthropicMessages(interleavedJournal());
    const lastUser = messages[messages.length - 1];
    expect(lastUser.role).toBe('user');
    const resultIds = (lastUser.content as Anthropic.ContentBlockParam[])
      .filter((b): b is Anthropic.ToolResultBlockParam => b.type === 'tool_result')
      .map((b) => b.tool_use_id);
    // Both parallel results merge into the trailing user turn (validity floor).
    expect(resultIds).toContain('tu_1');
    expect(resultIds).toContain('tu_2');
  });

  it('falls back to the default projection when a channel tool_use was suspend-dropped', () => {
    // suspendPending() drops a paused tool_use ENTRY from the projection before this
    // runs, but the verbatim channel (on the assistant entry) still references it.
    // Emitting it would re-orphan the paused tool_use → 400. Guard: when any channel
    // tool_use id is missing from the projected tool_use entries, DON'T use the
    // channel — fall back to the default split projection (which suspendPending
    // already shaped correctly). Here tu_2's entry is absent (suspended).
    seq = 0;
    const journal: JournalEntry[] = [
      entry({ type: 'user', blocks: [{ type: 'text', text: 'go' }] }),
      entry({
        type: 'assistant',
        blocks: [{ type: 'thinking', thinking: 'A', signature: 'sigA' }],
        anthropicBlocks: [
          { type: 'thinking', thinking: 'A', signature: 'sigA' },
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/a' } },
          { type: 'thinking', thinking: 'B', signature: 'sigB' },
          { type: 'tool_use', id: 'tu_2', name: 'Pause', input: {} },
        ],
      }),
      // Only tu_1 survives (tu_2 was suspended → its entry dropped by suspendPending).
      entry({ type: 'tool_use', toolUseId: 'tu_1', name: 'Read', input: { path: '/a' } }),
      entry({ type: 'tool_result', toolUseId: 'tu_1', blocks: [{ type: 'text', text: 'a' }] }),
    ];
    const messages = journalToAnthropicMessages(journal);
    const assistant = messages.find((m) => m.role === 'assistant')!;
    const ids = (assistant.content as Anthropic.ContentBlockParam[])
      .filter((b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use')
      .map((b) => b.id);
    // The suspended tu_2 must NOT appear on the wire; the surviving tu_1 still folds.
    expect(ids).toContain('tu_1');
    expect(ids).not.toContain('tu_2');
  });

  it('round-trips a redacted_thinking block ahead of a tool_use', () => {
    seq = 0;
    const journal: JournalEntry[] = [
      entry({ type: 'user', blocks: [{ type: 'text', text: 'do it' }] }),
      entry({
        type: 'assistant',
        blocks: [],
        anthropicBlocks: [
          { type: 'redacted_thinking', data: 'BLOB' },
          { type: 'tool_use', id: 'tu_r', name: 'Bash', input: { command: 'ls' } },
        ],
      }),
      entry({ type: 'tool_use', toolUseId: 'tu_r', name: 'Bash', input: { command: 'ls' } }),
      entry({ type: 'tool_result', toolUseId: 'tu_r', blocks: [{ type: 'text', text: 'ok' }] }),
    ];
    const messages = journalToAnthropicMessages(journal);
    const assistant = messages.find((m) => m.role === 'assistant')!;
    expect(assistant.content).toEqual([
      { type: 'redacted_thinking', data: 'BLOB' },
      { type: 'tool_use', id: 'tu_r', name: 'Bash', input: { command: 'ls' } },
    ]);
  });
});
