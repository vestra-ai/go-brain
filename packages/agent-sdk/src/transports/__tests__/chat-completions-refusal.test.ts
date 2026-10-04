import { describe, it, expect } from 'vitest';
import { ChatCompletionsTransport } from '../chat-completions-transport.js';
import type { StreamEvent } from '../../engine/transport.js';
import type OpenAI from 'openai';

/**
 * PR7 (Hermes parity) — Chat-Completions `refusal` capture. OpenAI-compat proxies
 * fronting Claude/Bedrock return a safety refusal as `message.refusal` (streamed via
 * `delta.refusal`) with EMPTY content + `finish_reason:'stop'`. We read only
 * content/reasoning/tool_calls/finish, so a refusal became a SILENT BLANK turn with no
 * retry. Mirrors Hermes' chat_completions.py: when the refusal is the SOLE payload (no
 * text, no tool calls), adopt it as content + map the stop reason to a refusal.
 */

type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk;

function streamOf(chunks: Chunk[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function transportWith(chunks: Chunk[]): ChatCompletionsTransport {
  const client = {
    chat: { completions: { stream: () => streamOf(chunks) } },
  } as unknown as OpenAI;
  return new ChatCompletionsTransport({ client });
}

async function drain(t: ChatCompletionsTransport): Promise<StreamEvent[]> {
  const stream = t.callModel({ model: 'claude-via-proxy', system: 's', tools: [], history: [], maxTokens: 100 });
  const out: StreamEvent[] = [];
  for await (const ev of t.readStream(stream)) out.push(ev);
  return out;
}

const refusalChunk = (refusal: string): Chunk =>
  ({ choices: [{ index: 0, delta: { refusal } as never, finish_reason: null }] } as unknown as Chunk);
const stopChunk: Chunk = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } as unknown as Chunk;
const usageChunk: Chunk = { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } } as unknown as Chunk;

describe('ChatCompletionsTransport — refusal capture (PR7)', () => {
  it('promotes a SOLE refusal (no text, no tools) to a text event + refusal stopReason', async () => {
    const out = await drain(transportWith([refusalChunk("I can't help with that."), stopChunk, usageChunk]));
    const text = out.filter((e) => e.kind === 'text') as Array<{ kind: 'text'; text: string }>;
    const done = out.find((e) => e.kind === 'done') as { kind: 'done'; stopReason: string | null };
    expect(text.map((t) => t.text).join('')).toContain("I can't help with that.");
    expect(done.stopReason).toBe('refusal');
  });

  it('does NOT promote when the turn also has visible text (refusal note alongside real work)', async () => {
    const textChunk = { choices: [{ index: 0, delta: { content: 'Here you go.' }, finish_reason: null }] } as unknown as Chunk;
    const out = await drain(transportWith([textChunk, refusalChunk('note'), stopChunk, usageChunk]));
    const done = out.find((e) => e.kind === 'done') as { kind: 'done'; stopReason: string | null };
    const text = out.filter((e) => e.kind === 'text') as Array<{ kind: 'text'; text: string }>;
    // The real content is the turn; stopReason stays a clean stop (not refusal).
    expect(text.map((t) => t.text).join('')).toContain('Here you go.');
    expect(done.stopReason).not.toBe('refusal');
  });

  it('does NOT promote a refusal when the turn made tool calls', async () => {
    const toolChunk = {
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'Read', arguments: '{}' } }] }, finish_reason: null }],
    } as unknown as Chunk;
    const out = await drain(transportWith([refusalChunk('note'), toolChunk, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] } as unknown as Chunk, usageChunk]));
    const done = out.find((e) => e.kind === 'done') as { kind: 'done'; stopReason: string | null };
    const toolUse = out.find((e) => e.kind === 'tool_use');
    expect(toolUse).toBeDefined();
    expect(done.stopReason).not.toBe('refusal');
  });
});
