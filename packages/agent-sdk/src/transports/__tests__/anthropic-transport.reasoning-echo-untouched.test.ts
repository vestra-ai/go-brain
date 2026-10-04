import { describe, it, expect, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicMessagesTransport } from '../anthropic-transport.js';
import type { ContentBlock } from '../../contract/blocks.js';
import type { ProviderHistory, Transport } from '../../engine/transport.js';

// Spy client mirroring the existing anthropic-transport tests' injection pattern
// (anthropic-transport.output-format.test.ts: `new AnthropicMessagesTransport({ client })`
// with a `{ messages: { stream } }` client).
function transportWithSpy() {
  const stream = vi.fn().mockReturnValue((async function* () {})());
  const client = { messages: { stream } } as unknown as Anthropic;
  return { transport: new AnthropicMessagesTransport({ client }), stream };
}

describe('AnthropicMessagesTransport — §4.3a invariant: reasoning-item echo never leaks in', () => {
  it('callModel sends NO include:[reasoning.encrypted_content] (OpenAI-only field)', () => {
    const { transport, stream } = transportWithSpy();
    transport.callModel({
      model: 'claude-sonnet-4-6',
      system: 's',
      tools: [],
      history: [] as ProviderHistory,
      maxTokens: 4096,
    });
    const body = stream.mock.calls[0][0] as Record<string, unknown>;
    expect('include' in body).toBe(false);
  });

  it('pushAssistant emits ONLY anthropic content blocks — no {type:"reasoning", encrypted_content} item', () => {
    const { transport } = transportWithSpy();
    const history = transport.emptyHistory() as ProviderHistory;
    transport.pushAssistant(history, [
      { type: 'tool_use', toolUseId: 'tu_1', toolName: 'f', toolInput: {} } as unknown as ContentBlock,
    ]);
    const json = JSON.stringify(history);
    expect(json).not.toContain('encrypted_content');
    expect(json).not.toMatch(/"type":"reasoning"/);
  });

  it('the Anthropic Transport does not implement capturedReasoning (OpenAI-only seam)', () => {
    const { transport } = transportWithSpy();
    // capturedReasoning is an OPTIONAL member of the Transport interface (the
    // OpenAI-only seam); access it through the interface type — the concrete
    // AnthropicMessagesTransport deliberately does not declare it.
    expect((transport as Transport).capturedReasoning).toBeUndefined();
  });
});
