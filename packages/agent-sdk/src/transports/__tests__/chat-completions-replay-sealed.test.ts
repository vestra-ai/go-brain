/**
 * Chat Completions — the assistant message goes back as the provider streamed it
 * (findings 8, 9). Streaming has no final message, so the sealed message is the
 * deltas' own fields joined in arrival order: content, reasoning_content, any other
 * field, and tool_calls with the provider's ids and RAW argument strings.
 */
import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import type { ContentBlock } from '../../contract/blocks.js';
import type { JournalEntry, JournalPayload } from '../../contract/journal.js';
import { createChatCompletionsAccumulator, journalToChatCompletionsMessages } from '../chat-completions-messages.js';
import { ChatCompletionsTransport } from '../chat-completions-transport.js';
import type { StreamEvent } from '../../engine/transport.js';

type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk;
const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}): Chunk =>
  ({ choices: [{ index: 0, delta, ...extra }] }) as unknown as Chunk;

describe('capture — the message as streamed (finding 8)', () => {
  it('joins every string field in arrival order and keeps raw argument strings + provider ids', () => {
    const acc = createChatCompletionsAccumulator();
    acc.onChunk(chunk({ role: 'assistant', reasoning_content: 'first ' }));
    acc.onChunk(chunk({ reasoning_content: 'second', content: '' }));
    acc.onChunk(chunk({ content: 'Checking.' }));
    acc.onChunk(chunk({ tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'Bash', arguments: '{"command":' } }] }));
    acc.onChunk(chunk({ tool_calls: [{ index: 0, function: { arguments: ' "ls"}' } }] }));
    acc.onChunk(chunk({ tool_calls: [{ index: 1, id: 'call_y', function: { name: 'Read', arguments: '{"path": "a' } }] }));
    acc.onChunk(chunk({}, { finish_reason: 'tool_calls' }));
    expect(acc.message()).toEqual({
      role: 'assistant',
      reasoning_content: 'first second',
      content: 'Checking.',
      tool_calls: [
        { id: 'call_x', type: 'function', function: { name: 'Bash', arguments: '{"command": "ls"}' } },
        { id: 'call_y', type: 'function', function: { name: 'Read', arguments: '{"path": "a' } },
      ],
    });
    // The torn call still dispatches (as {}), but the sealed message keeps what was sent.
    expect(acc.toolUses().map((t) => t.input)).toEqual([{ command: 'ls' }, {}]);
  });

  it('an id-less call gets ONE minted id, shared by its tool_use and the sealed message — never ""', () => {
    const acc = createChatCompletionsAccumulator();
    acc.onChunk(chunk({ tool_calls: [{ index: 0, function: { name: 'Bash', arguments: '{}' } }] }));
    acc.onChunk(chunk({}, { finish_reason: 'tool_calls' }));
    const id = acc.toolUses()[0].id;
    expect(id).not.toBe('');
    expect((acc.message().tool_calls as Array<{ id: string }>)[0].id).toBe(id);
    expect(acc.toolUses()[0].id).toBe(id);
  });

  it('readStream puts the sealed message on the done event', async () => {
    const t = new ChatCompletionsTransport({ client: { chat: { completions: {} } } as never });
    const stream = (async function* () {
      yield chunk({ content: 'hi' });
      yield chunk({}, { finish_reason: 'stop' });
      yield { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } } as unknown as Chunk;
    })();
    const events: StreamEvent[] = [];
    for await (const e of t.readStream(stream as never)) events.push(e);
    expect(events.at(-1)).toMatchObject({ kind: 'done', replay: { dialect: 'openai_chat_completions', message: { role: 'assistant', content: 'hi' } } });
  });
});

describe('a reasoning-only round is sent as a real turn, never "(no content)" (finding 9)', () => {
  let seq = 0;
  const entry = (payload: JournalPayload): JournalEntry => {
    seq += 1;
    return {
      uuid: `u${seq}`, parentUuid: null, seq, taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w',
      agentId: 'native', principal: { kind: 'agent', agentId: 'native' }, timestamp: '2026-09-23T00:00:00.000Z', payload,
    };
  };

  it('journal: a sealed reasoning-only message goes back as streamed', () => {
    const sealed = { role: 'assistant' as const, reasoning_content: 'thinking, cut off by max_tokens' };
    const msgs = journalToChatCompletionsMessages([
      entry({ type: 'user', blocks: [{ type: 'text', text: 'go' }] }),
      entry({ type: 'assistant', blocks: [{ type: 'thinking', thinking: sealed.reasoning_content }], api: 'openai_chat_completions', chatMessage: sealed }),
      entry({ type: 'user', blocks: [{ type: 'text', text: 'and?' }] }),
    ]);
    expect(msgs[1]).toEqual(sealed);
    expect(JSON.stringify(msgs)).not.toContain('(no content)');
  });

  it('journal: a legacy reasoning-only round carries its thinking as reasoning_content, no placeholder', () => {
    const msgs = journalToChatCompletionsMessages([
      entry({ type: 'user', blocks: [{ type: 'text', text: 'go' }] }),
      entry({ type: 'assistant', blocks: [{ type: 'thinking', thinking: 'hm' }] }),
      entry({ type: 'user', blocks: [{ type: 'text', text: 'and?' }] }),
    ]);
    expect(msgs[1]).toEqual({ role: 'assistant', content: '', reasoning_content: 'hm' });
  });

  it('in memory: the no-replay fallback does not invent "(no content)" for a thinking-only round', () => {
    const t = new ChatCompletionsTransport({ client: { chat: { completions: {} } } as never });
    const h = t.emptyHistory() as Array<Record<string, unknown>>;
    t.pushAssistant(h, [{ type: 'thinking', thinking: 'hm' } as ContentBlock]);
    expect(h).toEqual([{ role: 'assistant', content: null, reasoning_content: 'hm' }]);
  });

  it('a truly empty assistant (no content, calls or reasoning) still takes the placeholder', () => {
    const msgs = journalToChatCompletionsMessages([entry({ type: 'assistant', blocks: [] })]);
    expect(msgs).toEqual([{ role: 'assistant', content: '(no content)' }]);
  });
});

describe('legacy reasoning is read only from this dialect (cross-issuer)', () => {
  it('another dialect\'s thinking never becomes this model\'s reasoning_content', () => {
    const e = (payload: JournalPayload): JournalEntry => ({
      uuid: 'x', parentUuid: null, seq: 1, taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w',
      agentId: 'native', principal: { kind: 'agent', agentId: 'native' }, timestamp: '2026-09-23T00:00:00.000Z', payload,
    });
    const [msg] = journalToChatCompletionsMessages([
      e({ type: 'assistant', api: 'anthropic_messages', blocks: [{ type: 'thinking', thinking: 'claude thought', signature: 's' }, { type: 'text', text: 'hi' }] }),
    ]);
    expect(msg).toEqual({ role: 'assistant', content: 'hi' });
  });
});

describe('review fixes — what cannot be sent is repaired, and only that', () => {
  const e = (payload: JournalPayload, n: number): JournalEntry => ({
    uuid: `r${n}`, parentUuid: null, seq: n, taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w',
    agentId: 'native', principal: { kind: 'agent', agentId: 'native' }, timestamp: '2026-09-23T00:00:00.000Z', payload,
  });
  const CUT = { role: 'assistant' as const, reasoning_content: 'r', tool_calls: [{ id: 'call_c', type: 'function', function: { name: 'Read', arguments: '{"path": "a' } }] };

  it('cut-off (invalid JSON) arguments go out as "{}" — GLM 5.2 400s them (probed) — journal and in-memory', () => {
    const msgs = journalToChatCompletionsMessages([
      e({ type: 'assistant', blocks: [], api: 'openai_chat_completions', chatMessage: CUT }, 1),
      e({ type: 'tool_use', toolUseId: 'call_c', name: 'Read', input: {} }, 2),
      e({ type: 'tool_result', toolUseId: 'call_c', blocks: [{ type: 'text', text: 'bad args' }] }, 3),
    ]);
    expect((msgs[0] as { tool_calls: Array<{ function: { arguments: string } }> }).tool_calls[0].function.arguments).toBe('{}');
    const t = new ChatCompletionsTransport({ client: { chat: { completions: {} } } as never });
    const h = t.emptyHistory() as Array<{ tool_calls?: Array<{ function: { arguments: string } }> }>;
    t.pushAssistant(h as never, [], { dialect: 'openai_chat_completions', message: CUT });
    expect(h[0].tool_calls![0].function.arguments).toBe('{}');
    // Valid arguments stay byte-for-byte (spacing included).
    const ok = { ...CUT, tool_calls: [{ ...CUT.tool_calls[0], function: { name: 'Read', arguments: '{"path": "a"}' } }] };
    const h2 = t.emptyHistory() as Array<{ tool_calls?: Array<{ function: { arguments: string } }> }>;
    t.pushAssistant(h2 as never, [], { dialect: 'openai_chat_completions', message: ok });
    expect(h2[0].tool_calls![0].function.arguments).toBe('{"path": "a"}');
  });

  it('a reasoning-only round for a model that does not read reasoning: dropped, or the placeholder between two user turns', () => {
    const bodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
    const client = { chat: { completions: { stream: (b: never) => { bodies.push(b); return (async function* () {})(); } } } } as never;
    const t = new ChatCompletionsTransport({ client });
    const reasoningOnly = { role: 'assistant', reasoning_content: 'thinking, cut off' };
    // After a tool result: dropping it keeps [tool, user] — valid, so it leaves.
    t.callModel({ model: 'grok-4.6', system: 's', tools: [], maxTokens: 10, history: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c', content: 'ok' },
      reasoningOnly,
      { role: 'user', content: 'and?' },
    ] });
    expect(bodies[0].messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    // Between two user turns: dropping would put them side by side — placeholder instead.
    t.callModel({ model: 'grok-4.6', system: 's', tools: [], maxTokens: 10, history: [
      { role: 'user', content: 'go' }, reasoningOnly, { role: 'user', content: 'and?' },
    ] });
    expect(bodies[1].messages[2]).toEqual({ role: 'assistant', content: '(no content)' });
    // A model that reads it back gets the round as sent.
    t.callModel({ model: 'glm-5.2', system: 's', tools: [], maxTokens: 10, history: [
      { role: 'user', content: 'go' }, reasoningOnly, { role: 'user', content: 'and?' },
    ] });
    expect(bodies[2].messages[2]).toEqual(reasoningOnly);
  });
});
