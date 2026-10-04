import { describe, it, expect, vi } from 'vitest';
import { AnthropicMessagesTransport } from '../anthropic-transport.js';
import type { StreamEvent } from '../../engine/transport.js';

/**
 * readStream must yield a `thinking_start` StreamEvent the moment a thinking block
 * OPENS (content_block_start type=thinking), BEFORE its first `thinking` fragment —
 * so the UI mounts the thinking pill + timer immediately (Anthropic's summarized
 * adaptive thinking lags the block start by seconds). Non-thinking turns never yield
 * it → byte-identical.
 */

function makeMockClient(events: unknown[]) {
  const stream = vi.fn(() => ({
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
    async finalMessage() {
      return { stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 3 } } as unknown;
    },
  }));
  return { messages: { stream } } as any;
}

function baseParams() {
  return {
    model: 'claude-opus-4-8',
    system: 'S',
    tools: [] as unknown[],
    history: [{ role: 'user', content: 'go' }] as unknown,
    maxTokens: 8192,
  };
}

async function collect(t: AnthropicMessagesTransport): Promise<StreamEvent[]> {
  const stream = t.callModel({ ...baseParams() } as any);
  const out: StreamEvent[] = [];
  for await (const ev of t.readStream(stream)) out.push(ev);
  return out;
}

function* thinking(index: number, text: string) {
  yield { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } };
  yield { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: text } };
  yield { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'sig' } };
  yield { type: 'content_block_stop', index };
}

describe('AnthropicMessagesTransport.readStream — thinking_start', () => {
  it('yields thinking_start BEFORE the first thinking fragment', async () => {
    const t = new AnthropicMessagesTransport({ client: makeMockClient([...thinking(0, 'hmm')]) });
    const events = await collect(t);
    const startIdx = events.findIndex((e) => e.kind === 'thinking_start');
    const firstThinkIdx = events.findIndex((e) => e.kind === 'thinking');
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(firstThinkIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeLessThan(firstThinkIdx);
    expect(events[firstThinkIdx]).toEqual({ kind: 'thinking', text: 'hmm' });
  });

  it('yields one thinking_start per thinking block (two blocks → two starts)', async () => {
    const events = await collect(
      new AnthropicMessagesTransport({ client: makeMockClient([...thinking(0, 'A'), ...thinking(1, 'B')]) }),
    );
    expect(events.filter((e) => e.kind === 'thinking_start')).toHaveLength(2);
  });

  it('does NOT yield thinking_start for a plain-text turn (byte-identical)', async () => {
    const events = await collect(
      new AnthropicMessagesTransport({
        client: makeMockClient([
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
          { type: 'content_block_stop', index: 0 },
        ]),
      }),
    );
    expect(events.some((e) => e.kind === 'thinking_start')).toBe(false);
  });
});
