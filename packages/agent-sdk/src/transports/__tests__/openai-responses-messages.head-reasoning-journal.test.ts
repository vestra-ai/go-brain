import { describe, it, expect } from 'vitest';
import { journalToOpenAIResponsesInput } from '../openai-responses-messages.js';
import { journalToAnthropicMessages } from '../../engine/native-messages.js';
import type { JournalEntry } from '../../contract/journal.js';

/**
 * PR4 P2 — head/orphan (callId:null) encrypted reasoning persisted on the ASSISTANT
 * journal entry (not on a tool_use, because it precedes NO call). On reload the
 * OpenAI projection emits `{type:'reasoning'}` items BEFORE the assistant message so
 * a leading/orphan reasoning survives a journal write→read. The field is
 * OpenAI/Sakana-scoped and ABSENT for Anthropic → journalToAnthropicMessages is
 * byte-identical (it never reads the field).
 */

function baseEntry(seq: number, payload: JournalEntry['payload']): JournalEntry {
  return {
    uuid: `u_${seq}`,
    parentUuid: seq === 0 ? null : `u_${seq - 1}`,
    seq,
    taskId: 't1',
    rootTaskId: 't1',
    spawnDepth: 0,
    workspaceId: 'w1',
    agentId: 'native',
    principal: { kind: 'agent', agentId: 'native' },
    timestamp: '2026-01-01T00:00:00.000Z',
    payload,
  };
}

describe('journalToOpenAIResponsesInput — head/orphan reasoning on the assistant entry (PR4 P2)', () => {
  it('emits {type:reasoning} items BEFORE the assistant message for head reasoning', () => {
    const entries: JournalEntry[] = [
      baseEntry(0, { type: 'user', blocks: [{ type: 'text', text: 'go' }] }),
      baseEntry(1, {
        type: 'assistant',
        blocks: [{ type: 'text', text: 'answer' }],
        api: 'openai_responses',
        provider: 'openai',
        // head/orphan encrypted reasoning that preceded no tool call.
        reasoning: [{ id: 'rs_head', encryptedContent: 'EH' }],
      }),
    ];
    const input = journalToOpenAIResponsesInput(entries);
    const reasoningIdx = input.findIndex((i) => (i as { type?: string }).type === 'reasoning');
    const asstIdx = input.findIndex((i) => (i as { role?: string }).role === 'assistant');
    expect(reasoningIdx).toBeGreaterThanOrEqual(0);
    expect(reasoningIdx).toBeLessThan(asstIdx);
    expect(input[reasoningIdx]).toMatchObject({ type: 'reasoning', id: 'rs_head', encrypted_content: 'EH' });
  });

  it('round-trips: a leading-reasoning turn survives journal write→read with each reasoning before its place', () => {
    // Reproduces the production layout: head reasoning on the assistant entry, then a
    // tool_use carrying its OWN reasoning. On reload BOTH must replay in the right place.
    const entries: JournalEntry[] = [
      baseEntry(0, { type: 'user', blocks: [{ type: 'text', text: 'go' }] }),
      baseEntry(1, {
        type: 'assistant',
        blocks: [],
        api: 'openai_responses',
        provider: 'openai',
        reasoning: [{ id: 'rs_head', encryptedContent: 'EH' }],
      }),
      baseEntry(2, {
        type: 'tool_use',
        toolUseId: 'call_1',
        name: 'do_it',
        input: {},
        reasoning: [{ id: 'rs_call', encryptedContent: 'EC' }],
      }),
      baseEntry(3, { type: 'tool_result', toolUseId: 'call_1', blocks: [{ type: 'text', text: 'ok' }] }),
    ];
    const input = journalToOpenAIResponsesInput(entries);
    const shape = input.map((i) => {
      const it = i as { type?: string; role?: string; encrypted_content?: string; call_id?: string };
      if (it.type === 'reasoning') return `r:${it.encrypted_content}`;
      if (it.role === 'assistant') return 'asst';
      if (it.type === 'function_call') return `fc:${it.call_id}`;
      if (it.type === 'function_call_output') return `out:${it.call_id}`;
      return `u:${it.role}`;
    });
    // No invented empty assistant between them (it floored to "(no content)", 09-23).
    expect(shape).toEqual(['u:user', 'r:EH', 'r:EC', 'fc:call_1', 'out:call_1']);
  });

  it('emits NO reasoning item for an assistant entry without the reasoning field (byte-identical)', () => {
    const entries: JournalEntry[] = [
      baseEntry(0, { type: 'assistant', blocks: [{ type: 'text', text: 'hi' }], api: 'openai_responses', provider: 'openai' }),
    ];
    const input = journalToOpenAIResponsesInput(entries);
    expect(input.some((i) => (i as { type?: string }).type === 'reasoning')).toBe(false);
    expect(input).toEqual([{ role: 'assistant', content: 'hi' }]);
  });
});

describe('journalToAnthropicMessages — PR4 P2 invariant: never sees the assistant reasoning field', () => {
  it('an assistant entry carrying reasoning[] projects byte-identically (no reasoning/encrypted_content leak)', () => {
    const withReasoning: JournalEntry[] = [
      baseEntry(0, {
        type: 'assistant',
        blocks: [{ type: 'text', text: 'hi' }],
        api: 'openai_responses',
        provider: 'openai',
        reasoning: [{ id: 'rs_head', encryptedContent: 'EH' }],
      }),
    ];
    const withoutReasoning: JournalEntry[] = [
      baseEntry(0, {
        type: 'assistant',
        blocks: [{ type: 'text', text: 'hi' }],
        api: 'openai_responses',
        provider: 'openai',
      }),
    ];
    const a = journalToAnthropicMessages(withReasoning);
    const b = journalToAnthropicMessages(withoutReasoning);
    expect(a).toEqual(b);
    const json = JSON.stringify(a);
    expect(json).not.toContain('encrypted_content');
    expect(json).not.toMatch(/"type":"reasoning"/);
    expect(json).not.toContain('EH');
  });
});
