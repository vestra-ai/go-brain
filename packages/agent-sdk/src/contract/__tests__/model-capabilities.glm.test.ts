import { describe, it, expect } from 'vitest';
import { resolveCapabilities } from '../model-capabilities.js';
import type { CachePolicy, ModelCapabilities } from '../model-capabilities.js';

// GLM 5.2 rides the OpenAI Chat Completions breadth transport on the SHARED
// `fireworks` provider lane (migrated off the retired Z.ai/`zhipu` lane). It keeps
// its own 'Z.ai' DISPLAY brand in the web picker, but its infra provider is fireworks.

const OPENAI_CACHE: CachePolicy = {
  minCacheableTokens: 1024,
  breakpointBudget: 0,
  lookbackBlocks: 0,
  intermediateBlocks: 0,
};

describe('resolveCapabilities — GLM 5.2 seed row (Fireworks lane)', () => {
  it('glm-5.2 resolves to the exact Fireworks capability record', () => {
    expect(resolveCapabilities('glm-5.2')).toEqual<ModelCapabilities>({
      id: 'glm-5.2',
      provider: 'fireworks',
      tokenizerId: 'o200k_base',
      api: 'openai_chat_completions', // load-bearing: selectNativeTransport routes on this FIRST
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      thinking: { mode: 'reasoning', effort: 'high', replaysReasoning: true }, // probed 2026-09-23
      contextAware: false,
      cache: OPENAI_CACHE, // automatic-prefix; the Chat Completions arm has no breakpoint placement
      supportsImageInput: false, // Fireworks OSS lane is text-only (hard-400s on image_url)
      available: false, // Fireworks answers 404 for glm-5p2 since 2026-10-04
      unavailableReason: 'GLM 5.2 was retired by its provider. Pick another model to continue.',
    });
  });

  it('the api override is present (without it GLM would fall to the Anthropic transport)', () => {
    expect(resolveCapabilities('glm-5.2').api).toBe('openai_chat_completions');
  });
});

describe('inferProvider — glm* prefix → fireworks (unseeded ids)', () => {
  it('an unseeded glm* id infers provider fireworks', () => {
    expect(resolveCapabilities('glm-9-future').provider).toBe('fireworks');
  });
  it('an unseeded glm* id gets the automatic-prefix (OpenAI) cache policy, not Anthropic', () => {
    // Defense-in-depth: the Fireworks Chat Completions API does not support Anthropic breakpoints.
    expect(resolveCapabilities('glm-9-future').cache.breakpointBudget).toBe(0);
    expect(resolveCapabilities('glm-9-future').cache.ttl).toBeUndefined();
  });
});

describe('GLM does not collide with any other provider family', () => {
  it('glm-5.2 is fireworks; no claude/gpt id resolves to fireworks', () => {
    expect(resolveCapabilities('glm-5.2').provider).toBe('fireworks');
    for (const id of ['claude-opus-4-8', 'gpt-5.5', 'gpt-5.4-mini']) {
      expect(resolveCapabilities(id).provider).not.toBe('fireworks');
    }
  });
  it('the glm-5.2 row precedes the gpt rows (no substring shadowing)', () => {
    // 'glm-5.2' shares no substring with the gpt family; assert each still resolves to itself.
    expect(resolveCapabilities('glm-5.2').id).toBe('glm-5.2');
    expect(resolveCapabilities('gpt-5.5').id).toBe('gpt-5.5');
  });
});
