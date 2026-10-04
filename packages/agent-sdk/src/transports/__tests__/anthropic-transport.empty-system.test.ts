import { describe, it, expect, vi } from 'vitest';
import { AnthropicMessagesTransport } from '../anthropic-transport.js';

/**
 * Regression: spawning a `general-purpose` subagent (no systemPrompt → the engine
 * hands the transport an empty `system`) 400'd before the child ran with
 * `system.0: cache_control cannot be set for empty text blocks` — Stage A built
 * `system: [{ text: '', cache_control: EPHEMERAL }]` unconditionally.
 *
 * The transport must never emit an invalid block regardless of caller: an empty
 * system OMITS the `system` key (Anthropic accepts an absent system), and the
 * rolling-breakpoint clone helper leaves an empty bare-string message untouched
 * (same empty-text-block class). A NON-empty system stays byte-identical.
 */

function makeMockClient() {
  const calls: Array<{ body: any; opts: any }> = [];
  const stream = vi.fn((body: any, opts: any) => {
    calls.push({ body, opts });
    return {
      async *[Symbol.asyncIterator]() {},
      async finalMessage() {
        return { stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 3 } } as unknown;
      },
    } as any;
  });
  return { client: { messages: { stream } } as any, calls };
}

function baseParams() {
  return {
    model: 'claude-opus-4-8',
    system: 'SYSTEM PREFIX',
    tools: [] as unknown[],
    history: [{ role: 'user', content: 'hi' }] as unknown,
    maxTokens: 8192,
  };
}

describe('AnthropicMessagesTransport — empty system omission', () => {
  it('OMITS the `system` key entirely when p.system is empty', () => {
    const { client, calls } = makeMockClient();
    new AnthropicMessagesTransport({ client }).callModel({ ...baseParams(), system: '' } as any);

    expect(calls).toHaveLength(1);
    const body = calls[0].body;
    // No system key at all — NOT an empty-text block carrying cache_control.
    expect(body).not.toHaveProperty('system');
    // The rest of the request is still well-formed.
    expect(body.model).toBe('claude-opus-4-8');
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it('keeps the system block byte-identical when p.system is non-empty', () => {
    const { client, calls } = makeMockClient();
    new AnthropicMessagesTransport({ client }).callModel({ ...baseParams() } as any);

    const body = calls[0].body;
    expect(body.system).toEqual([
      { type: 'text', text: 'SYSTEM PREFIX', cache_control: expect.objectContaining({ type: 'ephemeral' }) },
    ]);
  });

  it('does NOT wrap an empty bare-string trailing message into an empty cache_control block', () => {
    const { client, calls } = makeMockClient();
    new AnthropicMessagesTransport({ client }).callModel({
      ...baseParams(),
      history: [{ role: 'user', content: '' }],
    } as any);

    const last = calls[0].body.messages.at(-1);
    // Left untouched: still a bare empty string, never a [{ text: '', cache_control }] block.
    expect(last.content).toBe('');
  });

  it('still wraps a non-empty bare-string trailing message with the rolling breakpoint', () => {
    const { client, calls } = makeMockClient();
    new AnthropicMessagesTransport({ client }).callModel({
      ...baseParams(),
      history: [{ role: 'user', content: 'hi' }],
    } as any);

    const last = calls[0].body.messages.at(-1);
    expect(last.content).toEqual([
      { type: 'text', text: 'hi', cache_control: expect.objectContaining({ type: 'ephemeral' }) },
    ]);
  });
});
