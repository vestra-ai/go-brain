import { describe, it, expect, vi, afterEach } from 'vitest';
import { AnthropicMessagesTransport } from '../anthropic-transport.js';
import type { StreamEvent } from '../../engine/transport.js';

/**
 * The runner dropped Anthropic's `usage.cache_creation` split at the source, so every
 * cache write — all of them 1h, the proxy rewrites the TTL — was claimed at the 5m
 * price (1.25x) while Anthropic billed 2x. readStream's `done` now carries the split
 * and computeCostUsd / buildModelUsage price it; a response without the object is
 * byte-identical.
 */
function makeMockClient(usage: unknown) {
  const stream = vi.fn(() => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } };
      yield { type: 'content_block_stop', index: 0 };
    },
    async finalMessage() {
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage } as unknown;
    },
  }));
  return { messages: { stream } } as any;
}

type Done = Extract<StreamEvent, { kind: 'done' }>;

async function done(t: AnthropicMessagesTransport): Promise<Done> {
  const stream = t.callModel({
    model: 'claude-opus-5-5',
    system: 'S',
    tools: [],
    history: [{ role: 'user', content: 'go' }],
    maxTokens: 1024,
  } as any);
  const out: StreamEvent[] = [];
  for await (const ev of t.readStream(stream)) out.push(ev);
  return out.find((e) => e.kind === 'done') as Done;
}

describe('AnthropicMessagesTransport — the 5m/1h cache-write split reaches the claim', () => {
  afterEach(() => {
    delete process.env.BILL_CACHE_WRITE_1H_V1;
  });

  it('done.usage carries the wire split, and computeCostUsd bills the 1h half at 2x input (BILL_CACHE_WRITE_1H_V1 on)', async () => {
    process.env.BILL_CACHE_WRITE_1H_V1 = 'true';
    const t = new AnthropicMessagesTransport({
      client: makeMockClient({
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 1_000,
        cache_creation_input_tokens: 100_000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100_000 },
      }),
    });
    const d = await done(t);
    expect(d.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 1_000,
      cacheCreationInputTokens: 100_000,
      cacheCreation5mInputTokens: 0,
      cacheCreation1hInputTokens: 100_000,
    });
    // opus-5-5: in $4 → the 1h write is $8/MTok; the 5m price would have been $5.
    const usd = t.computeCostUsd(d.usage, 'claude-opus-5-5');
    expect(usd).toBeCloseTo((10 * 4 + 20 * 20 + 1_000 * 0.2 + 100_000 * 8) / 1e6, 12);
    expect(usd).toBeGreaterThan((10 * 4 + 20 * 20 + 1_000 * 0.2 + 100_000 * 5) / 1e6);
    // buildModelUsage's costUSD is the same figure (turn_end.billing sums it).
    expect(t.buildModelUsage(d.usage, 'claude-opus-5-5')['claude-opus-5-5'].costUSD).toBe(usd);
  });

  it('flag off: done.usage still carries the split (the record), and the claim charges every write at the 5m price', async () => {
    const t = new AnthropicMessagesTransport({
      client: makeMockClient({
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 1_000,
        cache_creation_input_tokens: 100_000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100_000 },
      }),
    });
    const d = await done(t);
    expect(d.usage.cacheCreation1hInputTokens).toBe(100_000); // never flagged
    const usd = t.computeCostUsd(d.usage, 'claude-opus-5-5');
    // Mutation: price the split regardless of the flag → $0.80 of writes instead of $0.50.
    expect(usd).toBeCloseTo((10 * 4 + 20 * 20 + 1_000 * 0.2 + 100_000 * 5) / 1e6, 12);
    expect(t.buildModelUsage(d.usage, 'claude-opus-5-5')['claude-opus-5-5'].costUSD).toBe(usd);
  });

  it('a response without cache_creation is byte-identical (no split keys, the 5m price)', async () => {
    const t = new AnthropicMessagesTransport({
      client: makeMockClient({ input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 100_000 }),
    });
    const d = await done(t);
    expect(d.usage).toEqual({ inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 100_000 });
    expect(t.computeCostUsd(d.usage, 'claude-opus-5-5')).toBeCloseTo((10 * 4 + 20 * 20 + 100_000 * 5) / 1e6, 12);
  });
});
