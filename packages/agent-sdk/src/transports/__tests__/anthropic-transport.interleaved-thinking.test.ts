import { describe, it, expect, vi } from 'vitest';
import { AnthropicMessagesTransport } from '../anthropic-transport.js';

/**
 * The Anthropic transport's verbatim-replay channel.
 *
 * `capturedOrderedBlocks()` mirrors `capturedReasoning()`: the loop reads it AFTER
 * readStream to ride the ordered blocks onto the assistant journal entry. It is
 * UNGATED: every round that returned content captures the provider's message as
 * sent. The old gate predicted which shapes the split projection could rebuild,
 * and each shape it missed was a permanent wedge (09-16, 09-22).
 */

function makeMockClient(events: unknown[]) {
  const stream = vi.fn(() => ({
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
    async finalMessage() {
      return { stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 3 } } as unknown;
    },
  }));
  return { messages: { stream } } as any;
}

function baseParams() {
  return {
    model: 'claude-opus-4-8',
    system: 'S',
    tools: [{ name: 'Read', description: 'r', input_schema: { type: 'object' } }] as unknown[],
    history: [{ role: 'user', content: 'go' }] as unknown,
    maxTokens: 8192,
  };
}

function* thinking(index: number, text: string, signature: string) {
  yield { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } };
  yield { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: text } };
  yield { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } };
  yield { type: 'content_block_stop', index };
}
function* toolUse(index: number, id: string, name: string, input: object) {
  yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } };
  yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } };
  yield { type: 'content_block_stop', index };
}

async function drain(t: AnthropicMessagesTransport) {
  const stream = t.callModel({ ...baseParams() } as any);
  // The stash is populated as readStream runs — consume it fully first.
  for await (const _ of t.readStream(stream)) { /* consume */ }
}

describe('AnthropicMessagesTransport.capturedOrderedBlocks — verbatim channel on every round', () => {
  it('returns the verbatim blocks for an interleaved think→tool→think→tool turn', async () => {
    const events = [
      ...thinking(0, 'A', 'sigA'),
      ...toolUse(1, 'tu_1', 'Read', { path: '/a' }),
      ...thinking(2, 'B', 'sigB'),
      ...toolUse(3, 'tu_2', 'Read', { path: '/b' }),
    ];
    const t = new AnthropicMessagesTransport({ client: makeMockClient(events) });
    await drain(t);
    expect(t.capturedOrderedBlocks()).toEqual([
      { type: 'thinking', thinking: 'A', signature: 'sigA' },
      { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/a' } },
      { type: 'thinking', thinking: 'B', signature: 'sigB' },
      { type: 'tool_use', id: 'tu_2', name: 'Read', input: { path: '/b' } },
    ]);
  });

  it('returns the channel for a redacted_thinking block on a tool turn', async () => {
    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'BLOB' } },
      { type: 'content_block_stop', index: 0 },
      ...toolUse(1, 'tu_1', 'Read', { path: '/a' }),
    ];
    const t = new AnthropicMessagesTransport({ client: makeMockClient(events) });
    await drain(t);
    expect(t.capturedOrderedBlocks()).toEqual([
      { type: 'redacted_thinking', data: 'BLOB' },
      { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/a' } },
    ]);
  });

  it('captures an ordinary single-thinking-then-tool turn too (no shape is predicted)', async () => {
    const events = [...thinking(0, 'A', 'sigA'), ...toolUse(1, 'tu_1', 'Read', { path: '/a' })];
    const t = new AnthropicMessagesTransport({ client: makeMockClient(events) });
    await drain(t);
    expect(t.capturedOrderedBlocks()).toEqual([
      { type: 'thinking', thinking: 'A', signature: 'sigA' },
      { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/a' } },
    ]);
  });

  it('captures a thinking-only turn with no tool_use', async () => {
    const events = [...thinking(0, 'A', 'sigA')];
    const t = new AnthropicMessagesTransport({ client: makeMockClient(events) });
    await drain(t);
    expect(t.capturedOrderedBlocks()).toEqual([{ type: 'thinking', thinking: 'A', signature: 'sigA' }]);
  });

  it('captures a plain text turn', async () => {
    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
    ];
    const t = new AnthropicMessagesTransport({ client: makeMockClient(events) });
    await drain(t);
    expect(t.capturedOrderedBlocks()).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('never carries the previous round channel into a stream that dies before finalMessage', async () => {
    const events = [...thinking(0, 'A', 'sigA'), ...toolUse(1, 'tu_1', 'Read', { path: '/a' })];
    const t = new AnthropicMessagesTransport({ client: makeMockClient(events) });
    await drain(t);
    expect(t.capturedOrderedBlocks()).toBeDefined();

    const dying = {
      async *[Symbol.asyncIterator]() {
        yield* thinking(0, 'B', 'sigB');
        throw new Error('socket closed');
      },
      async finalMessage() {
        throw new Error('unreachable');
      },
    };
    await expect(async () => {
      for await (const _ of t.readStream(dying as never)) { /* consume */ }
    }).rejects.toThrow('socket closed');
    expect(t.capturedOrderedBlocks()).toBeUndefined();
  });
});

/**
 * Prod 09-16 — the wedge, at its source.
 *
 * With TOOL_DEFER_V1 on, Anthropic appends its own `tool_search_tool_regex` server
 * tool and RUNS IT INSIDE the reply. The turn came back as
 * `thinking > server_tool_use > tool_search_result > thinking > tool_use`, and the
 * accumulator modelled exactly four block types — text, thinking,
 * redacted_thinking, tool_use — binning everything else as `{ kind: 'other' }`
 * with the comment "carry no payload we accumulate here". True of the block's own
 * content; false of everything signed AFTER it.
 *
 * So the journal kept `thinking > thinking > tool_use`, and the second signature —
 * computed over the two discarded blocks — could never validate again. Worse, the
 * drop also blinded the guard built for precisely this: the interleave test asks
 * "is there thinking AFTER the first non-thinking block?", and once the server
 * blocks vanish the two thinkings are adjacent, so the answer is no and the
 * verbatim channel never fired.
 *
 * The cure is to stop reconstructing what the provider already hands us whole:
 * `finalMessage()` carries every block, including the types this SDK does not
 * model, so the channel is sourced from THAT.
 */
function makeMockClientWithFinal(events: unknown[], content: unknown[]) {
  const stream = vi.fn(() => ({
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
    async finalMessage() {
      return { stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 3 }, content } as unknown;
    },
  }));
  return { messages: { stream } } as any;
}

describe('capturedOrderedBlocks — blocks this SDK does not model', () => {
  /** The exact prod shape: a server tool ran between two signed thinking blocks. */
  const SERVER_TURN = [
    { type: 'thinking', thinking: 'A', signature: 'sigA' },
    { type: 'server_tool_use', id: 'srv_1', name: 'tool_search_tool_regex', input: { q: 'present' } },
    { type: 'tool_search_result', tool_use_id: 'srv_1', content: [{ type: 'text', text: 'found' }] },
    { type: 'thinking', thinking: 'B', signature: 'sigB' },
    { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
  ];
  // The stream the accumulator sees: it has no handler for the two server blocks,
  // so on its own it yields only the thinking pair and the tool_use.
  const EVENTS = [
    ...thinking(0, 'A', 'sigA'),
    ...thinking(3, 'B', 'sigB'),
    ...toolUse(4, 'tu_1', 'Bash', { command: 'ls' }),
  ];

  it('captures EVERY block the provider sent, in order, including unmodelled ones', async () => {
    const t = new AnthropicMessagesTransport({
      client: makeMockClientWithFinal(EVENTS, SERVER_TURN),
    });
    await drain(t);
    const got = t.capturedOrderedBlocks();
    expect(got).toBeDefined();
    expect(got!.map((b) => b.type)).toEqual([
      'thinking', 'provider_raw', 'provider_raw', 'thinking', 'tool_use',
    ]);
  });

  it('keeps the unmodelled block byte-for-byte, so the later signature still validates', async () => {
    const t = new AnthropicMessagesTransport({
      client: makeMockClientWithFinal(EVENTS, SERVER_TURN),
    });
    await drain(t);
    const raw = t.capturedOrderedBlocks()!.filter((b) => b.type === 'provider_raw');
    expect(raw).toHaveLength(2);
    expect((raw[0] as { raw: unknown }).raw).toEqual(SERVER_TURN[1]);
    expect((raw[1] as { raw: unknown }).raw).toEqual(SERVER_TURN[2]);
  });

  it('falls back to the accumulator when the provider gives no final content', async () => {
    // Older SDK / a mock without `content`: the channel must still behave as before
    // rather than throwing or going blank.
    const interleaved = [
      ...thinking(0, 'A', 'sigA'),
      ...toolUse(1, 'tu_1', 'Read', { path: '/a' }),
      ...thinking(2, 'B', 'sigB'),
    ];
    const t = new AnthropicMessagesTransport({ client: makeMockClient(interleaved) });
    await drain(t);
    expect(t.capturedOrderedBlocks()!.map((b) => b.type)).toEqual([
      'thinking', 'tool_use', 'thinking',
    ]);
  });

  it('captures an ordinary turn from final content as well', async () => {
    const plain = [
      { type: 'thinking', thinking: 'A', signature: 'sigA' },
      { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} },
    ];
    const t = new AnthropicMessagesTransport({
      client: makeMockClientWithFinal(
        [...thinking(0, 'A', 'sigA'), ...toolUse(1, 'tu_1', 'Read', {})],
        plain,
      ),
    });
    await drain(t);
    expect(t.capturedOrderedBlocks()).toEqual(plain);
  });
});

/**
 * Subagents keep their history in memory and may share one transport instance —
 * in parallel. The per-instance stash cannot serve them, so the round's verbatim
 * content rides its own `done` event, and pushAssistant takes it.
 */
describe('the verbatim channel on the done event (subagent path)', () => {
  const SERVER_TURN = [
    { type: 'thinking', thinking: 'A', signature: 'sigA' },
    { type: 'server_tool_use', id: 'srv_1', name: 'tool_search_tool_regex', input: { pattern: 'x' } },
    { type: 'tool_search_tool_result', tool_use_id: 'srv_1', content: { type: 'tool_search_tool_search_result', tool_references: [] } },
    { type: 'thinking', thinking: 'B', signature: 'sigB' },
    { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
  ];
  const EVENTS = [...thinking(0, 'A', 'sigA'), ...thinking(3, 'B', 'sigB'), ...toolUse(4, 'tu_1', 'Bash', { command: 'ls' })];

  it('the done event carries this round’s content exactly as sent', async () => {
    const t = new AnthropicMessagesTransport({ client: makeMockClientWithFinal(EVENTS, SERVER_TURN) });
    let replay: unknown;
    for await (const ev of t.readStream(t.callModel({ ...baseParams() } as any))) {
      if (ev.kind === 'done') replay = ev.replay;
    }
    expect((replay as Array<{ type: string }>).map((b) => b.type)).toEqual([
      'thinking', 'provider_raw', 'provider_raw', 'thinking', 'tool_use',
    ]);
  });

  it('pushAssistant with the replay sends the provider message back unchanged (server blocks and all)', async () => {
    const t = new AnthropicMessagesTransport({ client: makeMockClientWithFinal(EVENTS, SERVER_TURN) });
    let replay: any;
    for await (const ev of t.readStream(t.callModel({ ...baseParams() } as any))) {
      if (ev.kind === 'done') replay = ev.replay;
    }
    const h = t.emptyHistory() as Array<{ role: string; content: unknown }>;
    // The fallback blocks (what the subagent used to send) would drop both server blocks.
    t.pushAssistant(h, [{ type: 'tool_use', toolUseId: 'tu_1', toolName: 'Bash', toolInput: { command: 'ls' } } as never], replay);
    expect(h).toEqual([{ role: 'assistant', content: SERVER_TURN }]);
  });

  it('two interleaved streams on ONE transport each get their own round (no shared stash)', async () => {
    const other = [{ type: 'text', text: 'other conversation' }];
    let call = 0;
    const client = {
      messages: {
        stream: vi.fn(() => {
          const mine = call++ === 0;
          return {
            async *[Symbol.asyncIterator]() {
              for (const e of mine ? EVENTS : []) yield e;
            },
            async finalMessage() {
              return { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: mine ? SERVER_TURN : other };
            },
          };
        }),
      },
    } as any;
    const t = new AnthropicMessagesTransport({ client });
    const a = t.readStream(t.callModel({ ...baseParams() } as any))[Symbol.asyncIterator]();
    const b = t.readStream(t.callModel({ ...baseParams() } as any))[Symbol.asyncIterator]();
    const drainTo = async (it: AsyncIterator<any>) => {
      for (let r = await it.next(); !r.done; r = await it.next()) if (r.value.kind === 'done') return r.value.replay;
    };
    const [ra, rb] = await Promise.all([drainTo(a), drainTo(b)]);
    expect(ra.map((x: { type: string }) => x.type)).toEqual(['thinking', 'provider_raw', 'provider_raw', 'thinking', 'tool_use']);
    expect(rb).toEqual([{ type: 'text', text: 'other conversation' }]);
  });
});
