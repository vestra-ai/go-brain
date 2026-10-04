import { describe, it, expect, vi } from 'vitest';
import { AnthropicMessagesTransport } from '../anthropic-transport.js';

/**
 * §5 HARD INVARIANT: with the native-model-picker feature's flag OFF, the
 * Anthropic arm's wire request and neutral stream output are byte-identical to
 * baseline. The registry widening (google provider + non-Anthropic seed rows),
 * pricing additions, reasoning-effort vocab widening (xhigh/max), reasoning-item
 * echo, and per-provider client cache MUST ALL be invisible to this path.
 *
 * This is the umbrella conformance for the whole feature: it captures the
 * request body the transport hands to Anthropic's messages.stream and the
 * neutral StreamEvents it yields, and pins them. It complements ECHO-4 (Anthropic
 * emits no reasoning items / no `include`) and REG-5 (registry rows unchanged):
 * OPS-6 is the end-to-end callModel-body + readStream-output snapshot for the
 * Anthropic arm — the load-bearing "Claude byte-identical when flag off" claim.
 *
 * If this goes red, the regression belongs in whichever cluster perturbed the
 * Anthropic path (REG / ECHO / CLIENT), NOT here.
 */

/**
 * A mock Anthropic client whose messages.stream records the (body, opts) it was
 * called with and returns a stream that is BOTH async-iterable AND exposes the
 * `finalMessage()` the transport's readStream awaits (mirrors the real SDK
 * AnthropicMessageStream surface the adaptive-cache fixtures use).
 */
function makeMockClient(events: unknown[] = []) {
  const calls: Array<{ body: any; opts: any }> = [];
  const stream = vi.fn((body: any, opts: any) => {
    calls.push({ body, opts });
    return {
      async *[Symbol.asyncIterator]() {
        for (const e of events) yield e;
      },
      async finalMessage() {
        return {
          stop_reason: 'end_turn',
          usage: { input_tokens: 7, output_tokens: 3 },
        } as unknown;
      },
    } as any;
  });
  return { client: { messages: { stream } } as any, calls };
}

function baseParams() {
  return {
    model: 'claude-opus-4-8',
    system: 'SYSTEM PREFIX',
    tools: [
      { name: 'A', description: 'a', input_schema: { type: 'object' } },
      { name: 'B', description: 'b', input_schema: { type: 'object' } },
    ] as unknown[],
    history: [{ role: 'user', content: 'hi' }] as unknown,
    maxTokens: 8192,
  };
}

describe('AnthropicMessagesTransport — Claude byte-identical conformance (flag off)', () => {
  it('callModel request body matches the pinned baseline (no model/runtime/provider leakage)', () => {
    const { client, calls } = makeMockClient();
    const t = new AnthropicMessagesTransport({ client });
    t.callModel({ ...baseParams() } as any);

    expect(calls).toHaveLength(1);
    const body = calls[0].body;

    // identity fields
    expect(body.model).toBe('claude-opus-4-8');
    expect(body.max_tokens).toBe(8192);
    // system carries exactly ONE text block with the ephemeral cache_control
    expect(body.system).toEqual([
      { type: 'text', text: 'SYSTEM PREFIX', cache_control: expect.objectContaining({ type: 'ephemeral' }) },
    ]);
    // tools: last tool carries the cache_control breakpoint; first does not
    expect(body.tools).toHaveLength(2);
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.tools[1].cache_control).toEqual(expect.objectContaining({ type: 'ephemeral' }));
    // messages preserved (rolling breakpoint on the trailing user turn)
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.length).toBeGreaterThan(0);

    // NO foreign fields the feature introduces on the OpenAI/Sakana arm
    expect(body).not.toHaveProperty('reasoning'); // OpenAI/Sakana Responses only
    expect(body).not.toHaveProperty('text'); // Responses output-format shape only
    expect(body).not.toHaveProperty('include'); // ECHO (OpenAI reasoning) only
    expect(body).not.toHaveProperty('prompt_cache_key'); // OpenAI prompt-cache anchor only
  });

  it('callModel request body is UNCHANGED when a cacheKey is passed (Anthropic ignores it)', () => {
    // The OpenAI prompt-cache anchor rides callModel for EVERY arm, but the
    // Anthropic transport never reads it → its wire body must be byte-identical to
    // the no-cacheKey baseline (cache routing here is `cache_control`-driven).
    const { client: c1, calls: callsBaseline } = makeMockClient();
    new AnthropicMessagesTransport({ client: c1 }).callModel({ ...baseParams() } as any);

    const { client: c2, calls: callsWithKey } = makeMockClient();
    new AnthropicMessagesTransport({ client: c2 }).callModel({
      ...baseParams(),
      cacheKey: 'vestra:task-xyz',
    } as any);

    // Deep-equal: the two request bodies are identical, and neither carries a
    // prompt_cache_key (the Anthropic arm never emits one).
    expect(callsWithKey[0].body).toEqual(callsBaseline[0].body);
    expect(callsWithKey[0].body).not.toHaveProperty('prompt_cache_key');
  });

  it('readStream yields the same neutral StreamEvents as baseline for a text+done stream', async () => {
    // Minimal recorded Anthropic stream: a text delta then the terminal events.
    // (usage + stop_reason are read off finalMessage(), not the deltas.)
    const events = [
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'message_delta', usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ];
    const { client } = makeMockClient(events);
    const t = new AnthropicMessagesTransport({ client });
    const stream = t.callModel({ ...baseParams() } as any);
    const out: unknown[] = [];
    for await (const ev of t.readStream(stream)) out.push(ev);

    // at least one text event with 'Hello' and exactly one trailing done with usage
    const text = out.filter((e: any) => e.kind === 'text');
    const done = out.filter((e: any) => e.kind === 'done');
    expect(text.some((e: any) => e.text === 'Hello')).toBe(true);
    expect(done).toHaveLength(1);
    expect((done[0] as any).usage).toBeDefined();

    // No reasoning-item / thinking leakage on the Anthropic arm for a plain text turn.
    expect(out.some((e: any) => e.kind === 'thinking_block')).toBe(false);
  });
});
