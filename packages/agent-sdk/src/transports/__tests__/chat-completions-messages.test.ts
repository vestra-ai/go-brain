import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type OpenAI from 'openai';
import type { JournalEntry, JournalPayload } from '../../contract/journal.js';
import {
  journalToChatCompletionsMessages,
  createChatCompletionsAccumulator,
} from '../chat-completions-messages.js';

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

type Assistant = OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
type Tool = OpenAI.Chat.Completions.ChatCompletionToolMessageParam;

describe('journalToChatCompletionsMessages', () => {
  it('projects user, assistant, tool_use (folded), and tool_result', () => {
    seq = 0;
    const msgs = journalToChatCompletionsMessages([
      entry({ type: 'user', blocks: [{ type: 'text', text: 'hi' }] }),
      entry({ type: 'assistant', blocks: [{ type: 'text', text: 'on it' }] }),
      entry({ type: 'tool_use', toolUseId: 'a', name: 'search', input: { q: 'x' } }),
      entry({ type: 'tool_result', toolUseId: 'a', blocks: [{ type: 'text', text: 'found' }] }),
    ]);

    expect(msgs[0]).toEqual({ role: 'user', content: 'hi' });
    const assistant = msgs[1] as Assistant;
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toBe('on it');
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls?.[0]).toMatchObject({
      id: 'a',
      type: 'function',
      function: { name: 'search', arguments: '{"q":"x"}' },
    });
    const tool = msgs[2] as Tool;
    expect(tool).toEqual({ role: 'tool', tool_call_id: 'a', content: 'found' });
  });

  it('folds a multi-tool round with interleaved results into ONE assistant message that keeps its reasoning (strike 2026-08-13, task fd760456)', () => {
    seq = 0;
    // The journal shape a parallel-tool round actually produces: tool_result
    // entries land in COMPLETION order, interleaved with the round's tool_use
    // entries. Folding only into the LAST message synthesized a reasoning-less
    // assistant per later call — the deepseek lane then replayed a tool loop
    // with no reasoning_content on those messages and DeepSeek 400'd the turn.
    const msgs = journalToChatCompletionsMessages([
      entry({ type: 'user', blocks: [{ type: 'text', text: 'research it' }] }),
      entry({ type: 'assistant', blocks: [{ type: 'thinking', thinking: 'fan out searches' }] }),
      entry({ type: 'tool_use', toolUseId: 'a', name: 'Read', input: {} }),
      entry({ type: 'tool_result', toolUseId: 'a', blocks: [{ type: 'text', text: 'ra' }] }),
      entry({ type: 'tool_use', toolUseId: 'b', name: 'WebSearch', input: { q: '1' } }),
      entry({ type: 'tool_result', toolUseId: 'b', blocks: [{ type: 'text', text: 'rb' }] }),
      entry({ type: 'tool_use', toolUseId: 'c', name: 'WebSearch', input: { q: '2' } }),
      entry({ type: 'tool_result', toolUseId: 'c', blocks: [{ type: 'text', text: 'rc' }] }),
    ]);
    // ONE assistant message carries the whole round's calls — parity with the
    // in-memory pushAssistant shape (one assistant, all tool_calls).
    const assistants = msgs.filter((m) => m.role === 'assistant') as Assistant[];
    expect(assistants).toHaveLength(1);
    expect(assistants[0].tool_calls?.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    // The round's reasoning rides that message as reasoning_content.
    for (const m of msgs) {
      if (m.role === 'assistant' && m.tool_calls !== undefined) {
        expect((m as Assistant & { reasoning_content?: string }).reasoning_content).toBe('fan out searches');
      }
    }
    // Results ride behind it in completion order, ids intact.
    expect(msgs.filter((m) => m.role === 'tool').map((m) => (m as Tool).tool_call_id)).toEqual(['a', 'b', 'c']);
  });

  it('a new assistant entry starts a new round — a later tool_use never folds backward across it', () => {
    seq = 0;
    const msgs = journalToChatCompletionsMessages([
      entry({ type: 'assistant', blocks: [{ type: 'thinking', thinking: 'round one' }] }),
      entry({ type: 'tool_use', toolUseId: 'a', name: 'Bash', input: {} }),
      entry({ type: 'tool_result', toolUseId: 'a', blocks: [{ type: 'text', text: 'ra' }] }),
      entry({ type: 'assistant', blocks: [{ type: 'thinking', thinking: 'round two' }] }),
      entry({ type: 'tool_use', toolUseId: 'b', name: 'Bash', input: {} }),
      entry({ type: 'tool_result', toolUseId: 'b', blocks: [{ type: 'text', text: 'rb' }] }),
    ]);
    const assistants = msgs.filter((m) => m.role === 'assistant') as Assistant[];
    expect(assistants).toHaveLength(2);
    expect(assistants[0].tool_calls?.map((c) => c.id)).toEqual(['a']);
    expect(assistants[1].tool_calls?.map((c) => c.id)).toEqual(['b']);
  });

  it('creates a tool-only assistant message when a tool_use has no preceding assistant', () => {
    seq = 0;
    const msgs = journalToChatCompletionsMessages([
      entry({ type: 'user', blocks: [{ type: 'text', text: 'go' }] }),
      entry({ type: 'tool_use', toolUseId: 'b', name: 'run', input: {} }),
      // P2.0b: paired so the orphan-strip leaves the call under test.
      entry({ type: 'tool_result', toolUseId: 'b', blocks: [{ type: 'text', text: 'ok' }] }),
    ]);
    const assistant = msgs[1] as Assistant;
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toBeNull();
    expect(assistant.tool_calls).toHaveLength(1);
  });

  it('applies the validity floor (empty tool result → placeholder)', () => {
    seq = 0;
    const msgs = journalToChatCompletionsMessages([
      entry({ type: 'assistant', blocks: [{ type: 'text', text: 'x' }] }),
      entry({ type: 'tool_use', toolUseId: 'c', name: 'noop', input: {} }),
      entry({ type: 'tool_result', toolUseId: 'c', blocks: [] }),
    ]);
    const tool = msgs.find((m) => m.role === 'tool') as Tool;
    expect(tool.content).toBe('(no output)');
  });
});

describe('createChatCompletionsAccumulator', () => {
  function chunk(partial: Record<string, unknown>): OpenAI.Chat.Completions.ChatCompletionChunk {
    return partial as unknown as OpenAI.Chat.Completions.ChatCompletionChunk;
  }

  it('accumulates streamed text and a tool call across chunks', () => {
    const acc = createChatCompletionsAccumulator();
    const c1 = chunk({ choices: [{ delta: { content: 'Hel' } }] });
    const c2 = chunk({ choices: [{ delta: { content: 'lo' } }] });
    const c3 = chunk({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'fn', arguments: '{"a":' } }] } }],
    });
    const c4 = chunk({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    for (const c of [c1, c2, c3, c4]) acc.onChunk(c);

    expect(acc.textDelta(c1)).toBe('Hel');
    const tools = acc.toolUses();
    expect(tools).toEqual([{ id: 't1', name: 'fn', input: { a: 1 } }]);
    const final = acc.final();
    expect(final?.stopReason).toBe('tool_calls');
    expect(final?.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  it('surfaces DeepSeek-style reasoning_content as a thinking delta', () => {
    const acc = createChatCompletionsAccumulator();
    const c = chunk({ choices: [{ delta: { reasoning_content: 'thinking...' } }] });
    expect(acc.thinkingDelta(c)).toBe('thinking...');
    expect(acc.textDelta(c)).toBeNull();
  });

  it('returns null final() when the stream produced no terminal chunk', () => {
    const acc = createChatCompletionsAccumulator();
    acc.onChunk(chunk({ choices: [{ delta: { content: 'partial' } }] }));
    expect(acc.final()).toBeNull();
  });

  it('sawUsage() is true when a usage chunk arrives (stream_options.include_usage honored)', () => {
    const acc = createChatCompletionsAccumulator();
    acc.onChunk(chunk({ choices: [{ delta: { content: 'hi' } }] }));
    acc.onChunk(chunk({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } }));
    expect(acc.sawUsage()).toBe(true);
  });

  it('sawUsage() is false when the provider omits the usage chunk (the silent-$0 risk) — final() still defaults to zeros', () => {
    const acc = createChatCompletionsAccumulator();
    acc.onChunk(chunk({ choices: [{ delta: { content: 'hi' } }] }));
    acc.onChunk(chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] })); // terminal, but NO usage
    expect(acc.sawUsage()).toBe(false);
    expect(acc.final()).toMatchObject({ stopReason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } });
  });
});

/**
 * The billing drill's independent leg. `normalizeChatUsage` is subtractive and lossy, so a
 * cost recomputed from its output re-uses its own arithmetic — circular. These pin that the
 * RAW wire counts can be recovered on demand, that the gate is genuinely default-off, and
 * that the log carries token counts and NOTHING else.
 */
describe('raw wire usage debug log (VESTRA_LOG_RAW_USAGE)', () => {
  const FLAG = 'VESTRA_LOG_RAW_USAGE';

  function chunk(partial: Record<string, unknown>): OpenAI.Chat.Completions.ChatCompletionChunk {
    return partial as unknown as OpenAI.Chat.Completions.ChatCompletionChunk;
  }

  /** A terminal chunk carrying usage AND content — the content must never reach the log. */
  function usageChunk(): OpenAI.Chat.Completions.ChatCompletionChunk {
    return chunk({
      id: 'chatcmpl-abc123',
      model: 'deepseek-v4-flash',
      choices: [{ delta: { content: 'SECRET-PROMPT-CONTENT' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 12_000,
        completion_tokens: 400,
        prompt_tokens_details: { cached_tokens: 9_000 },
      },
    });
  }

  let debugSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    debugSpy.mockRestore();
    delete process.env[FLAG];
  });

  it('flag ON: logs exactly the raw token counts, keyed by request id and model', () => {
    process.env[FLAG] = 'true';
    createChatCompletionsAccumulator().onChunk(usageChunk());

    expect(debugSpy).toHaveBeenCalledTimes(1);
    const [message, payload] = debugSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe('[chat-completions] raw wire usage');
    // toEqual, not toMatchObject: an extra key is a FAILURE, not a pass.
    expect(payload).toEqual({
      requestId: 'chatcmpl-abc123',
      model: 'deepseek-v4-flash',
      prompt_tokens: 12_000,
      completion_tokens: 400,
      cached_tokens: 9_000,
    });
  });

  it('flag ON: never logs content, even when the same chunk carries it', () => {
    process.env[FLAG] = 'true';
    createChatCompletionsAccumulator().onChunk(usageChunk());

    expect(JSON.stringify(debugSpy.mock.calls)).not.toContain('SECRET-PROMPT-CONTENT');
  });

  it('flag ON: omits absent wire fields rather than logging them as undefined', () => {
    process.env[FLAG] = 'true';
    createChatCompletionsAccumulator().onChunk(
      chunk({ id: 'r1', model: 'm', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
    );

    const [, payload] = debugSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload).toEqual({ requestId: 'r1', model: 'm', prompt_tokens: 5, completion_tokens: 2 });
    expect(Object.keys(payload)).not.toContain('cached_tokens');
  });

  it('flag UNSET (the default): logs nothing', () => {
    delete process.env[FLAG];
    createChatCompletionsAccumulator().onChunk(usageChunk());

    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("flag set to anything but 'true': logs nothing", () => {
    process.env[FLAG] = 'false';
    createChatCompletionsAccumulator().onChunk(usageChunk());
    process.env[FLAG] = '1';
    createChatCompletionsAccumulator().onChunk(usageChunk());

    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('logging does not disturb the normalization it observes', () => {
    process.env[FLAG] = 'true';
    const acc = createChatCompletionsAccumulator();
    acc.onChunk(usageChunk());

    // prompt_tokens is cache-INCLUSIVE on the wire; NormalizedUsage is exclusive.
    expect(acc.final()?.usage).toMatchObject({
      inputTokens: 3_000,
      outputTokens: 400,
      cacheReadInputTokens: 9_000,
    });
  });
});
