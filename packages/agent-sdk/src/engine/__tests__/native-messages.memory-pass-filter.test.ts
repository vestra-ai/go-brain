/**
 * Nami P1.1 — the hot memory pass must be invisible to the MODEL, not just the UI.
 *
 * The end-of-task sweep is journaled as a normal `user` turn + `assistant` FACT
 * reply, so every later projection replayed it into context — and the model's
 * "most recent exchange" became the sweep, producing replies like "I saved the
 * useful context from this task" to the user's next real message (prod task
 * 20b112b2, 2026-08-03). The fix: the pass's user entry carries `control:'memory'`
 * and both wire projections (Anthropic + OpenAI Responses) strip the pass turn —
 * the marked user entry plus everything chained under it via parentUuid, with the
 * chain STOPPING at any real (unmarked) user entry so a later real turn that
 * happens to parent onto a dropped entry survives.
 *
 * project() itself is untouched: billing/audit consumers still see the pass.
 */
import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { journalToAnthropicMessages } from '../native-messages.js';
import { journalToOpenAIResponsesInput } from '../../transports/openai-responses-messages.js';
import type { JournalEntry, JournalPayload } from '../../contract/journal.js';

function entry(
  uuid: string,
  parentUuid: string | null,
  seq: number,
  payload: JournalPayload,
): JournalEntry {
  return {
    uuid,
    parentUuid,
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

/** real turn → memory-pass turn → next real user turn (parented onto the pass reply). */
function journalWithPass(): JournalEntry[] {
  return [
    entry('u1', null, 1, { type: 'user', blocks: [{ type: 'text', text: 'make an image' }] }),
    entry('a1', 'u1', 2, { type: 'assistant', blocks: [{ type: 'text', text: 'Generating now.' }] }),
    entry('u2', 'a1', 3, {
      type: 'user',
      control: 'memory',
      blocks: [{ type: 'text', text: 'Now do a silent end-of-task memory sweep.' }],
    }),
    entry('a2', 'u2', 4, { type: 'assistant', blocks: [{ type: 'text', text: 'FACT [identity] user builds Vestra.' }] }),
    // Real follow-up parented onto the PASS REPLY (the prod shape: next user turn
    // chains wherever the driver left off). Must survive the strip.
    entry('u3', 'a2', 5, { type: 'user', blocks: [{ type: 'text', text: 'where is my image' }] }),
    entry('a3', 'u3', 6, { type: 'assistant', blocks: [{ type: 'text', text: 'Here it is.' }] }),
  ];
}

const anthropicText = (m: Anthropic.MessageParam): string => JSON.stringify(m.content);

describe('memory-pass turns are stripped from model projections', () => {
  it('journalToAnthropicMessages drops the pass user entry and its reply, keeps real turns', () => {
    const out = journalToAnthropicMessages(journalWithPass());
    const all = out.map(anthropicText).join('\n');
    expect(all).not.toContain('memory sweep');
    expect(all).not.toContain('FACT [identity]');
    expect(out).toHaveLength(4);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(anthropicText(out[2])).toContain('where is my image');
  });

  it('journalToOpenAIResponsesInput drops the same turns', () => {
    const out = journalToOpenAIResponsesInput(journalWithPass());
    const all = JSON.stringify(out);
    expect(all).not.toContain('memory sweep');
    expect(all).not.toContain('FACT [identity]');
    expect(out).toHaveLength(4);
  });

  it('drops a stray tool_use/tool_result chained under the pass turn', () => {
    const entries = [
      entry('u1', null, 1, { type: 'user', blocks: [{ type: 'text', text: 'hi' }] }),
      entry('a1', 'u1', 2, { type: 'assistant', blocks: [{ type: 'text', text: 'hello' }] }),
      entry('u2', 'a1', 3, {
        type: 'user',
        control: 'memory',
        blocks: [{ type: 'text', text: 'sweep' }],
      }),
      entry('a2', 'u2', 4, { type: 'assistant', blocks: [{ type: 'text', text: 'FACT [other] x' }] }),
      entry('tu1', 'a2', 5, { type: 'tool_use', toolUseId: 'call_1', name: 'remember', input: {} }),
      entry('tr1', 'tu1', 6, { type: 'tool_result', toolUseId: 'call_1', blocks: [{ type: 'text', text: 'saved' }] }),
    ] as JournalEntry[];
    const out = journalToAnthropicMessages(entries);
    expect(JSON.stringify(out)).not.toContain('call_1');
    expect(out).toHaveLength(2);
  });

  // The journal path rebuilds the request from project() on EVERY turn, so the
  // sweep's OWN model call projects a journal whose FINAL entry is the marked
  // user prompt (its reply does not exist yet). Stripping it there would send
  // the sweep request with no user turn at all: no FACT lines, no deposits, the
  // memory pass silently dead. An in-flight (trailing) marked entry must
  // survive; it gets stripped only after its reply lands.
  it('keeps a trailing marked user entry (the in-flight pass driving its own turn)', () => {
    const entries = [
      entry('u1', null, 1, { type: 'user', blocks: [{ type: 'text', text: 'make an image' }] }),
      entry('a1', 'u1', 2, { type: 'assistant', blocks: [{ type: 'text', text: 'Done.' }] }),
      entry('u2', 'a1', 3, {
        type: 'user',
        control: 'memory',
        blocks: [{ type: 'text', text: 'Now do a silent end-of-task memory sweep.' }],
      }),
    ] as JournalEntry[];
    const anthropic = journalToAnthropicMessages(entries);
    expect(anthropic).toHaveLength(3);
    expect(anthropicText(anthropic[2])).toContain('memory sweep');
    const openai = journalToOpenAIResponsesInput(entries);
    expect(JSON.stringify(openai)).toContain('memory sweep');
  });

  it('a journal with no marked entries projects byte-identically', () => {
    const entries = journalWithPass().filter(
      (e) => !(e.payload.type === 'user' && e.payload.control === 'memory') && e.uuid !== 'a2',
    );
    const before = JSON.stringify(journalToAnthropicMessages(entries));
    expect(before).toContain('where is my image');
    expect(JSON.stringify(journalToAnthropicMessages(entries))).toBe(before);
  });
});
