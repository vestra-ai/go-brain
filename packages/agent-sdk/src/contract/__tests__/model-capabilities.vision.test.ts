import { describe, it, expect } from 'vitest';
import { resolveCapabilities, modelSupportsImageInput } from '../model-capabilities.js';

/**
 * Vision (image-input) capability. The Fireworks OSS lane (GLM / DeepSeek) is
 * text-only and hard-400s on an image_url part ("This model does not support
 * image inputs"); Anthropic / OpenAI / Gemini are multimodal. `supportsImageInput`
 * is OPTIONAL and absent-means-capable (mirrors `available?` / isModelAvailable),
 * so only the text-only rows carry the flag and every vision row stays
 * byte-identical. `modelSupportsImageInput` is the single predicate callers use.
 */
describe('modelSupportsImageInput — vision capability gate', () => {
  it('GLM-5.2 (Fireworks, text-only) does NOT support image input', () => {
    expect(modelSupportsImageInput('glm-5.2')).toBe(false);
  });

  it('is case-insensitive (the picker may send "GLM-5.2")', () => {
    expect(modelSupportsImageInput('GLM-5.2')).toBe(false);
  });

  it('DeepSeek V4 (pro + flash) are text-only', () => {
    expect(modelSupportsImageInput('deepseek-v4-pro')).toBe(false);
    expect(modelSupportsImageInput('deepseek-v4-flash')).toBe(false);
  });

  it('Anthropic Claude models support image input', () => {
    expect(modelSupportsImageInput('claude-opus-4-8')).toBe(true);
    expect(modelSupportsImageInput('claude-sonnet-5')).toBe(true);
    expect(modelSupportsImageInput('claude-haiku-4-5')).toBe(true);
  });

  it('OpenAI + Gemini models support image input', () => {
    expect(modelSupportsImageInput('gpt-5.5')).toBe(true);
    expect(modelSupportsImageInput('gemini-3.8-flash')).toBe(true);
  });

  it('unknown Fireworks-inferred ids default to text-only (fail-closed on the OSS lane)', () => {
    // A future GLM/DeepSeek variant not yet seeded still infers provider=fireworks.
    expect(modelSupportsImageInput('glm-6-turbo')).toBe(false);
    expect(modelSupportsImageInput('deepseek-v5')).toBe(false);
  });

  it('unknown non-Fireworks ids default to vision-capable (absent-means-capable)', () => {
    expect(modelSupportsImageInput('claude-opus-9')).toBe(true);
    expect(modelSupportsImageInput('gpt-6')).toBe(true);
  });

  it('the seed field: text-only rows carry supportsImageInput:false; vision rows leave it absent', () => {
    expect(resolveCapabilities('glm-5.2').supportsImageInput).toBe(false);
    // Vision rows stay byte-identical (no key) → absent, which the resolver reads as capable.
    expect(resolveCapabilities('claude-opus-4-8').supportsImageInput).toBeUndefined();
  });
});
