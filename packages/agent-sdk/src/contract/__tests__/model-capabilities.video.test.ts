import { describe, it, expect } from 'vitest';
import { modelSupportsVideoInput, modelSupportsImageInput } from '../model-capabilities.js';

describe('modelSupportsVideoInput — Gemini is the only lane that takes video', () => {
  it('gemini-3.8-flash: true', () => expect(modelSupportsVideoInput('gemini-3.8-flash')).toBe(true));
  it('every other seeded picker model: false, even ones that see images', () => {
    for (const id of ['gpt-5.6-luna', 'claude-sonnet-5', 'grok-4.6', 'muse-spark-1.3-contributor', 'deepseek-v4-flash']) {
      expect(modelSupportsVideoInput(id)).toBe(false);
    }
    expect(modelSupportsImageInput('gpt-5.6-luna')).toBe(true); // control: image ≠ video
  });
  it('an unknown id: false (default is blind, never a surprise upload)', () => {
    expect(modelSupportsVideoInput('nonesuch-model-9')).toBe(false);
  });
});
