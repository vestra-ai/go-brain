/**
 * DeepSeek FIRST-PARTY lane (founder ruling 2026-08-13: Pro rides the official
 * API — the 0813 GA build, ~4x cheaper — while Flash stays on Fireworks).
 *
 * Two seams are DeepSeek-specific and pinned here:
 *   1. The client branch: its own key + base URL (the server credential proxy
 *      in production), so concurrent GPT / open-model / deepseek sessions in
 *      one process never share a base.
 *   2. Usage spelling: api.deepseek.com reports `prompt_cache_hit_tokens` /
 *      `prompt_cache_miss_tokens` (docs-verified 2026-08-13) — NOT OpenAI's
 *      `prompt_tokens_details.cached_tokens`. The normalizer must read both,
 *      and the OpenAI spelling must stay byte-identical.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type OpenAI from 'openai';
import type { ContentBlock } from '../../contract/blocks.js';
import { ChatCompletionsTransport } from '../chat-completions-transport.js';
import { openAIClientFor } from '../openai-endpoints.js';
import {
  deepseekReasoningEffort,
  normalizeChatUsage,
  withReasoning,
  withoutReasoningContent,
} from '../chat-completions-messages.js';

describe('openAIClientFor(deepseek)', () => {
  afterEach(() => {
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_BASE_URL;
  });

  it('THROWS — the direct lane was removed 2026-08-17 (Google Limited Use), never a silent fallback', () => {
    // A silent fall-through to the default branch would hand DeepSeek traffic
    // OpenAI credentials; a revived branch would send user data to
    // api.deepseek.com again. Both are wrong — the only correct behavior is loud.
    process.env.DEEPSEEK_API_KEY = 'ambient-key';
    process.env.DEEPSEEK_BASE_URL = 'https://server.example/api/proxy/deepseek/v1';
    expect(() => openAIClientFor('deepseek')).toThrow(/removed/);
  });
});

describe('reasoning replay — reasoning_content returns to a model that reads it back', () => {
  const blocks: ContentBlock[] = [
    { type: 'thinking', thinking: 'the chain of thought' },
    { type: 'text', text: 'the answer' },
  ];

  it('a legacy round carries its thinking as a real reasoning_content field', () => {
    const msg = withReasoning({ role: 'assistant', content: 'the answer' }, blocks);
    expect((msg as { reasoning_content?: string }).reasoning_content).toBe('the chain of thought');
    expect(msg.content).toBe('the answer');
  });

  it('withoutReasoningContent strips it for a model that does not read it back', () => {
    const msg = withReasoning({ role: 'assistant', content: 'the answer' }, blocks);
    const [stripped] = withoutReasoningContent([msg]);
    const wire = JSON.stringify(stripped);
    expect(wire).not.toContain('chain of thought');
    expect(wire).not.toContain('reasoning_content');
    expect(stripped.content).toBe('the answer');
  });

  it('thinking-free turns stay untouched (no empty reasoning_content key)', () => {
    const msg = withReasoning({ role: 'assistant', content: 'plain' }, [{ type: 'text', text: 'plain' }]);
    expect('reasoning_content' in (msg as unknown as Record<string, unknown>)).toBe(false);
    expect(withoutReasoningContent([msg])[0]).toBe(msg);
  });
});

describe('deepseekReasoningEffort', () => {
  it("maps 'medium' up to 'high' — their accepted set is low|high|max", () => {
    expect(deepseekReasoningEffort('medium')).toBe('high');
    expect(deepseekReasoningEffort('high')).toBe('high');
    expect(deepseekReasoningEffort('low')).toBe('low');
    expect(deepseekReasoningEffort(undefined)).toBeUndefined();
  });
});

describe('normalizeChatUsage — DeepSeek first-party cache spelling', () => {
  it('reads prompt_cache_hit/miss_tokens into the exclusive-input convention', () => {
    const usage = normalizeChatUsage({
      prompt_tokens: 100,
      completion_tokens: 7,
      total_tokens: 107,
      prompt_cache_hit_tokens: 80,
      prompt_cache_miss_tokens: 20,
    } as unknown as OpenAI.Completions.CompletionUsage);
    expect(usage).toEqual({
      inputTokens: 20,
      outputTokens: 7,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 0,
    });
  });

  it('a hit count exceeding prompt_tokens is clamped, never negative input', () => {
    const usage = normalizeChatUsage({
      prompt_tokens: 50,
      completion_tokens: 1,
      prompt_cache_hit_tokens: 90,
    } as unknown as OpenAI.Completions.CompletionUsage);
    expect(usage.cacheReadInputTokens).toBe(50);
    expect(usage.inputTokens).toBe(0);
  });

  it('the OpenAI/Fireworks spelling is byte-identical to before (the untouched axis)', () => {
    const usage = normalizeChatUsage({
      prompt_tokens: 100,
      completion_tokens: 5,
      total_tokens: 105,
      prompt_tokens_details: { cached_tokens: 60 },
    } as unknown as OpenAI.Completions.CompletionUsage);
    expect(usage).toEqual({
      inputTokens: 40,
      outputTokens: 5,
      cacheReadInputTokens: 60,
      cacheCreationInputTokens: 0,
    });
  });
});

describe('readStream — the chat lane persists reasoning as a terminal thinking_block', () => {
  function chunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return { choices: [{ delta, ...extra }], ...( {} ) } as never;
  }

  it('yields ONE thinking_block (full reasoning) before tool_use/done, so the engine journals it and the deepseek replay has something to stash', async () => {
    const stream = (async function* () {
      yield chunk({ reasoning_content: 'first ' });
      yield chunk({ reasoning_content: 'second' });
      yield chunk({ tool_calls: [{ index: 0, id: 't1', function: { name: 'calc', arguments: '{}' } }] });
      yield chunk({}, { finish_reason: 'tool_calls' });
      yield { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } } as never;
    })();
    const t = new ChatCompletionsTransport({ client: { chat: { completions: {} } } as never });
    const events: Array<{ kind: string; thinking?: string }> = [];
    for await (const ev of t.readStream(stream as never)) events.push(ev as never);
    const kinds = events.map((e) => e.kind);
    const tb = events.find((e) => e.kind === 'thinking_block');
    expect(tb?.thinking).toBe('first second');
    // thinking_block leads the terminal sequence (before tool_use, before done).
    expect(kinds.indexOf('thinking_block')).toBeLessThan(kinds.indexOf('tool_use'));
    expect(kinds.indexOf('thinking_block')).toBeLessThan(kinds.indexOf('done'));
  });

  it('reasoning-free streams yield NO thinking_block (byte-identical non-thinking lanes)', async () => {
    const stream = (async function* () {
      yield chunk({ content: 'plain answer' });
      yield chunk({}, { finish_reason: 'stop' });
      yield { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } } as never;
    })();
    const t = new ChatCompletionsTransport({ client: { chat: { completions: {} } } as never });
    const kinds: string[] = [];
    for await (const ev of t.readStream(stream as never)) kinds.push((ev as { kind: string }).kind);
    expect(kinds).not.toContain('thinking_block');
  });
});
