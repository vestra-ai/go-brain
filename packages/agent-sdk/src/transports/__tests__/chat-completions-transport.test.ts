import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import { ChatCompletionsTransport } from '../chat-completions-transport.js';
import type { StreamEvent } from '../../engine/transport.js';

function chunk(partial: Record<string, unknown>): OpenAI.Chat.Completions.ChatCompletionChunk {
  return partial as unknown as OpenAI.Chat.Completions.ChatCompletionChunk;
}

async function* scriptedStream(
  chunks: OpenAI.Chat.Completions.ChatCompletionChunk[],
): AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> {
  for (const c of chunks) yield c;
}

describe('ChatCompletionsTransport', () => {
  const t = new ChatCompletionsTransport();

  it('identifies as the chat-completions wire dialect', () => {
    expect(t.api).toBe('openai_chat_completions');
    expect(t.provider).toBe('openai');
  });

  it('readStream yields text, then tool_use, then exactly one done', async () => {
    const stream = scriptedStream([
      chunk({ choices: [{ delta: { content: 'Hi' } }] }),
      chunk({
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'fn', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      }),
    ]);
    const events: StreamEvent[] = [];
    for await (const e of t.readStream(stream)) events.push(e);

    expect(events.filter((e) => e.kind === 'done')).toHaveLength(1);
    expect(events.find((e) => e.kind === 'text')).toMatchObject({ text: 'Hi' });
    expect(events.find((e) => e.kind === 'tool_use')).toMatchObject({
      toolUse: { id: 'c1', name: 'fn' },
    });
    const done = events.find((e) => e.kind === 'done');
    expect(done).toMatchObject({ stopReason: 'tool_calls', usage: { inputTokens: 7, outputTokens: 3 } });
  });

  it('throws a classifiable error when the stream has no terminal chunk', async () => {
    const stream = scriptedStream([chunk({ choices: [{ delta: { content: 'partial' } }] })]);
    const run = async () => {
      for await (const _e of t.readStream(stream)) void _e;
    };
    await expect(run()).rejects.toThrow(/without a terminal chunk/);
  });

  it('maps finish_reason "length" to a completed (partial) outcome', () => {
    const outcome = t.classifyTermination({
      stopReason: 'max_tokens',
      costUsd: 0,
      numTurns: 1,
      durationMs: 1,
      modelUsage: {},
      summaryText: 'partial answer',
    });
    expect(outcome.kind).toBe('completed');
  });

  it('historyFromJournal returns chat-completions messages', () => {
    const h = t.historyFromJournal([
      {
        uuid: 'u1', parentUuid: null, seq: 1, taskId: 't', rootTaskId: 't',
        spawnDepth: 0, workspaceId: 'w', agentId: 'native',
        principal: { kind: 'agent', agentId: 'native' },
        timestamp: '2026-06-26T00:00:00.000Z',
        payload: { type: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      },
    ]);
    expect(h).toEqual([{ role: 'user', content: 'hello' }]);
  });
});
