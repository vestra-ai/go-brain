import { describe, it, expect } from 'vitest';
import { KNOWN_MODEL_IDS, resolveCapabilities } from '../model-capabilities.js';
import { resolveOpenAIReasoning } from '../../transports/thinking-support.js';

// GPT-6.1 Sol (2026-09-29) replaces GPT-6 Sol like for like (2026-09-30): same page-
// verified limits (1.05M context, 128K output, >272K premium threshold, text + image
// in) and GPT-6 Sol's ceiling. Its effort is medium (founder 2026-10-01: "gpt 6.1 sol
// medium" for every task), which is also OpenAI's own default for it. Its own row, never
// a lookalike's: 'gpt-6-sol' is not a substring of 'gpt-6.1-sol', and no bare 'gpt-6'
// or 'gpt-6.1' alias row exists.
describe('model-capabilities — gpt-6.1-sol', () => {
  it('resolves its OWN row (and a dated snapshot collapses onto it)', () => {
    const caps = resolveCapabilities('gpt-6.1-sol');
    expect(caps).toMatchObject({
      id: 'gpt-6.1-sol',
      provider: 'openai',
      tokenizerId: 'o200k_base',
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      premiumInputThreshold: 272_000,
      preferredMaxInputTokens: 272_000,
    });
    expect(caps.api).toBeUndefined(); // OpenAI's house dialect: the Responses transport
    expect(caps.thinking).toEqual({ mode: 'reasoning', effort: 'medium', effortCeiling: 'max' });
    expect(resolveCapabilities('gpt-6.1-sol-2026-09-29').id).toBe('gpt-6.1-sol');
    expect(KNOWN_MODEL_IDS).toContain('gpt-6.1-sol');
  });

  it('shadows nothing and is shadowed by nothing', () => {
    expect(resolveCapabilities('gpt-6-sol').id).toBe('gpt-6-sol');
    expect(resolveCapabilities('gpt-6-astra').id).toBe('gpt-6-astra');
    expect(resolveCapabilities('gpt-6-luna').id).toBe('gpt-6-luna');
    expect(resolveCapabilities('gpt-5.6-sol').id).toBe('gpt-5.6-sol');
  });

  it('asks the wire for effort medium with a summary', () => {
    expect(resolveOpenAIReasoning('gpt-6.1-sol')).toEqual({ effort: 'medium', summary: 'auto' });
  });

  it('moves only its own effort: 6 Sol and 5.6 Sol keep high', () => {
    expect(resolveCapabilities('gpt-6-sol').thinking.effort).toBe('high');
    expect(resolveCapabilities('gpt-5.6-sol').thinking.effort).toBe('high');
  });
});
