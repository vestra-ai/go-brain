import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { journalToAnthropicMessages } from '../native-messages.js';
import { ensureValidAnthropicRequest } from '../request-validity.js';
import type { AnthropicReplayBlock, JournalEntry, JournalPayload } from '../../contract/journal.js';

/**
 * The provider's signed message goes back exactly as it came — the invariant.
 *
 * Staging 09-22, task a9bb8b6d: the model called a client tool (Skill) and the
 * provider's tool search in the same response. The search's RESULT arrived at the
 * start of the NEXT response, so the continuation led with a non-thinking block:
 *
 *   round 1: thinking, tool_use(Skill), server_tool_use
 *   round 2: tool_search_tool_result, thinking, server_tool_use,
 *            tool_search_tool_result, thinking, tool_use(Bash)
 *
 * The capture was faithful (both rounds journaled verbatim). The validity floor
 * then judged round 2 "not interleaved" — its test required the message to LEAD
 * with thinking — and hoisted both thinking blocks to the front. Anthropic answered
 * every request with "thinking blocks in the latest assistant message cannot be
 * modified", on Opus 5 and again after the move to Opus 5.5. Permanent wedge.
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
    timestamp: '2026-09-22T21:42:00.000Z',
    payload,
  };
}

const raw = (b: Record<string, unknown>): AnthropicReplayBlock => ({ type: 'provider_raw', raw: b });

const ROUND_1: AnthropicReplayBlock[] = [
  { type: 'thinking', thinking: 'check the creative-direction skill first', signature: 'sig1' },
  { type: 'tool_use', id: 'toolu_skill', name: 'Skill', input: { name: 'creative-direction' } },
  raw({ type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_regex', input: { pattern: 'media' } }),
];

const ROUND_2: AnthropicReplayBlock[] = [
  raw({ type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'tool_search_tool_search_result', tool_references: [] } }),
  { type: 'thinking', thinking: 'no media tool seems loaded', signature: 'sig2' },
  raw({ type: 'server_tool_use', id: 'srvtoolu_2', name: 'tool_search_tool_regex', input: { pattern: 'image' } }),
  raw({ type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_2', content: { type: 'tool_search_tool_search_result', tool_references: [] } }),
  { type: 'thinking', thinking: 'check the env for an image key', signature: 'sig3' },
  { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'env' } },
];

function stagingJournal(): JournalEntry[] {
  seq = 0;
  return [
    entry({ type: 'user', blocks: [{ type: 'text', text: 'Create a funny cartoon image at 100x100 pixels.' }] }),
    entry({
      type: 'assistant',
      blocks: [{ type: 'thinking', thinking: 'check the creative-direction skill first', signature: 'sig1' }],
      anthropicBlocks: ROUND_1,
    }),
    entry({ type: 'tool_use', toolUseId: 'toolu_skill', name: 'Skill', input: { name: 'creative-direction' } }),
    entry({ type: 'tool_result', toolUseId: 'toolu_skill', blocks: [{ type: 'text', text: 'skill body' }] }),
    entry({
      type: 'assistant',
      blocks: [
        { type: 'thinking', thinking: 'no media tool seems loaded', signature: 'sig2' },
        { type: 'thinking', thinking: 'check the env for an image key', signature: 'sig3' },
      ],
      anthropicBlocks: ROUND_2,
    }),
    entry({ type: 'tool_use', toolUseId: 'toolu_bash', name: 'Bash', input: { command: 'env' } }),
    entry({ type: 'tool_result', toolUseId: 'toolu_bash', blocks: [{ type: 'text', text: 'OPENAI_API_KEY=<set>' }] }),
  ];
}

/** What the provider sent, as request params — the only legal replay. */
function asSent(blocks: AnthropicReplayBlock[]): unknown[] {
  return blocks.map((b) => (b.type === 'provider_raw' ? b.raw : b));
}

describe('the provider’s signed message is replayed unchanged', () => {
  it('staging 09-22: a continuation that LEADS with a tool-search result keeps its order', () => {
    const assistants = journalToAnthropicMessages(stagingJournal()).filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(2);
    expect(assistants[0].content).toEqual(asSent(ROUND_1));
    expect(assistants[1].content).toEqual(asSent(ROUND_2));
  });

  it('staging 09-22: still unchanged after the next user message arrives (the resume that also failed)', () => {
    const journal = [
      ...stagingJournal(),
      entry({ type: 'user', blocks: [{ type: 'text', text: 'Make it a witty cartoon at 100x100.' }] }),
    ];
    const assistants = journalToAnthropicMessages(journal).filter((m) => m.role === 'assistant');
    expect(assistants[1].content).toEqual(asSent(ROUND_2));
  });

  // The invariant, over shapes no one predicted. Every one of these is a legal
  // provider message; the floor's old repairs would have rewritten each of them.
  const SHAPES: Record<string, AnthropicReplayBlock[]> = {
    'text before thinking': [
      { type: 'text', text: 'on it' },
      { type: 'thinking', thinking: 't', signature: 's' },
      { type: 'tool_use', id: 'tu_a', name: 'Read', input: {} },
    ],
    'server result leading, single thinking': [
      raw({ type: 'web_search_tool_result', tool_use_id: 'srv_x', content: [] }),
      { type: 'thinking', thinking: 't', signature: 's' },
      { type: 'tool_use', id: 'tu_a', name: 'Read', input: {} },
    ],
    'redacted thinking after a server block': [
      raw({ type: 'server_tool_use', id: 'srv_y', name: 'tool_search_tool_regex', input: {} }),
      raw({ type: 'tool_search_tool_result', tool_use_id: 'srv_y', content: { type: 'tool_search_tool_search_result', tool_references: [] } }),
      { type: 'redacted_thinking', data: 'BLOB' },
      { type: 'tool_use', id: 'tu_a', name: 'Read', input: {} },
    ],
  };

  for (const [name, blocks] of Object.entries(SHAPES)) {
    it(`unchanged: ${name}`, () => {
      seq = 0;
      const journal = [
        entry({ type: 'user', blocks: [{ type: 'text', text: 'go' }] }),
        entry({ type: 'assistant', blocks: [], anthropicBlocks: blocks }),
        entry({ type: 'tool_use', toolUseId: 'tu_a', name: 'Read', input: {} }),
        entry({ type: 'tool_result', toolUseId: 'tu_a', blocks: [{ type: 'text', text: 'ok' }] }),
      ];
      const assistant = journalToAnthropicMessages(journal).find((m) => m.role === 'assistant');
      expect(assistant!.content).toEqual(asSent(blocks));
    });
  }
});

describe('ensureValidAnthropicRequest — sealed messages', () => {
  const leadingResult: Anthropic.MessageParam = {
    role: 'assistant',
    content: [
      { type: 'tool_search_tool_result', tool_use_id: 'srv', content: {} } as never,
      { type: 'thinking', thinking: 'a', signature: 's1' },
      { type: 'tool_use', id: 'tu', name: 'Read', input: {} },
    ],
  };
  const history = (a: Anthropic.MessageParam): Anthropic.MessageParam[] => [
    { role: 'user', content: 'go' },
    a,
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu', content: 'ok' }] },
  ];

  it('a sealed message passes through byte-for-byte, even when it does not lead with thinking', () => {
    const out = ensureValidAnthropicRequest(history(leadingResult), new Set([leadingResult]));
    expect(out[1].content).toEqual(leadingResult.content);
  });

  it('an UNSEALED (rebuilt) message still gets the ordinary floor — thinking first', () => {
    const out = ensureValidAnthropicRequest(history(leadingResult));
    expect((out[1].content as Anthropic.ContentBlockParam[])[0].type).toBe('thinking');
  });

  it('a sealed message carrying an empty text block is unreplayable as-is → ordinary floor', () => {
    const withEmpty: Anthropic.MessageParam = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'a', signature: 's1' },
        { type: 'text', text: '' },
        { type: 'thinking', thinking: 'b', signature: 's2' },
        { type: 'tool_use', id: 'tu', name: 'Read', input: {} },
      ],
    };
    const out = ensureValidAnthropicRequest(history(withEmpty), new Set([withEmpty]));
    // The tombstone rule: the empty block was signed over, so the thinking must go.
    expect((out[1].content as Anthropic.ContentBlockParam[]).map((b) => b.type)).toEqual(['tool_use']);
  });

  it('a sealed message whose tool_use lost its result is repaired (new message, no longer sealed)', () => {
    const orphan: Anthropic.MessageParam = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'a', signature: 's1' },
        { type: 'text', text: 'calling' },
        { type: 'tool_use', id: 'tu_gone', name: 'Read', input: {} },
      ],
    };
    const out = ensureValidAnthropicRequest([{ role: 'user', content: 'go' }, orphan], new Set([orphan]));
    expect(out[1].content).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'calling' },
    ]);
  });
});
