import { describe, it, expect } from 'vitest';
import { journalToOpenAIResponsesInput } from '../openai-responses-messages.js';
import type { JournalEntry } from '../../contract/journal.js';

/**
 * PR11 (Hermes parity) — RETIRES THE ORIGINALLY-REPORTED BUG. Every tool-calling turn
 * journaled an assistant entry with text-empty blocks, which the projection pushed as
 * an empty assistant message; the validity floor then rewrote it to '(no content)'
 * BEFORE the function_call → gpt-5.x read itself saying "(no content)" and PARROTED it.
 * Fix (mirrors Hermes codex_responses_adapter): emit NO assistant message for a
 * tool-only turn (content='' only when a HEAD reasoning item needs a following item).
 */

let seq = 0;
function entry(payload: JournalEntry['payload']): JournalEntry {
  seq += 1;
  return {
    uuid: `u${seq}`, parentUuid: seq === 1 ? null : `u${seq - 1}`, seq,
    taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w',
    agentId: 'native', principal: { kind: 'agent', agentId: 'native' },
    timestamp: '2026-06-26T00:00:00.000Z', payload,
  };
}

const isAssistantMsg = (i: unknown): i is { role: string; content: unknown } =>
  typeof i === 'object' && i !== null && 'role' in i && (i as { role?: string }).role === 'assistant';

describe('journalToOpenAIResponsesInput — no (no content) parrot on tool-only turns (PR11)', () => {
  it('emits NO assistant message (and no "(no content)") for a tool-only turn', () => {
    seq = 0;
    const input = journalToOpenAIResponsesInput([
      entry({ type: 'user', blocks: [{ type: 'text', text: 'go' }] }),
      entry({ type: 'assistant', blocks: [], api: 'openai_responses', provider: 'openai' }),
      entry({ type: 'tool_use', toolUseId: 'c1', name: 'Read', input: {} }),
      entry({ type: 'tool_result', toolUseId: 'c1', blocks: [{ type: 'text', text: 'ok' }] }),
    ]);
    // No assistant message at all for the tool-only turn → no placeholder to parrot.
    expect(input.some(isAssistantMsg)).toBe(false);
    // The function_call still projects.
    expect(input.some((i) => (i as { type?: string }).type === 'function_call')).toBe(true);
    // The literal placeholder never appears anywhere in the request.
    expect(JSON.stringify(input)).not.toContain('(no content)');
  });

  it('STILL emits the assistant message when the turn has real text', () => {
    seq = 0;
    const input = journalToOpenAIResponsesInput([
      entry({ type: 'assistant', blocks: [{ type: 'text', text: 'here is the answer' }], api: 'openai_responses', provider: 'openai' }),
    ]);
    const msg = input.find(isAssistantMsg)!;
    expect(msg).toBeTruthy();
    expect((msg as { content: unknown }).content).toBe('here is the answer');
  });

  it('echoes HEAD reasoning with NO invented follower — the "(no content)" parrot came back through it (09-23)', () => {
    seq = 0;
    const input = journalToOpenAIResponsesInput([
      entry({ type: 'assistant', blocks: [], reasoning: [{ id: 'r1', encryptedContent: 'ENC' }], api: 'openai_responses', provider: 'openai' }),
    ]);
    // The head reasoning item is echoed; a reasoning item needs no follower (probed
    // 2026-09-23), and the old content='' one was floored to "(no content)".
    expect(input.some((i) => (i as { type?: string }).type === 'reasoning')).toBe(true);
    expect(input.some(isAssistantMsg)).toBe(false);
    expect(JSON.stringify(input)).not.toContain('(no content)');
  });
});
