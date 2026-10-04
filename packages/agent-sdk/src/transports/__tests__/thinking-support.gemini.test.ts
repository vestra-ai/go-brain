import { describe, it, expect, afterEach } from 'vitest';
import { resolveGeminiThinking } from '../thinking-support.js';

afterEach(() => {
  delete process.env.GEMINI_THINKING;
  delete process.env.GEMINI_THINKING_LEVEL;
});

/**
 * Registry-driven like its Anthropic/OpenAI siblings: `thinking.mode === 'reasoning'`
 * → the row's effort as `thinking_level` (+ summaries, so the desk's pill streams);
 * anything else → null (omit both fields). Asserted on stable non-Gemini reasoning
 * rows here; Task 7 pins gemini-3.8-flash itself once seeded.
 */
describe('resolveGeminiThinking', () => {
  it('a reasoning row resolves its registry effort and turns summaries on', () => {
    // gpt-5.4: { mode: 'reasoning', effort: 'medium' } — a stable seeded row.
    expect(resolveGeminiThinking('gpt-5.4')).toEqual({ thinking_level: 'medium', thinking_summaries: 'auto' });
  });

  it('a non-reasoning (unknown-id fallback) row → null', () => {
    expect(resolveGeminiThinking('nonesuch-model-9')).toBeNull();
  });

  it('the env override wins; max/xhigh clamp to high; garbage falls back to the registry effort', () => {
    process.env.GEMINI_THINKING_LEVEL = 'max';
    expect(resolveGeminiThinking('gpt-5.4')?.thinking_level).toBe('high');
    process.env.GEMINI_THINKING_LEVEL = 'minimal';
    expect(resolveGeminiThinking('gpt-5.4')?.thinking_level).toBe('minimal');
    process.env.GEMINI_THINKING_LEVEL = 'turbo';
    expect(resolveGeminiThinking('gpt-5.4')?.thinking_level).toBe('medium');
  });

  it('the kill switch omits thinking entirely', () => {
    process.env.GEMINI_THINKING = 'off';
    expect(resolveGeminiThinking('gpt-5.4')).toBeNull();
  });
});
