// packages/agent-sdk/src/contract/__tests__/suggestion-prompt.test.ts
import { describe, it, expect } from 'vitest';
import { SUGGESTION_SYSTEM } from '../suggestion-prompt.js';

describe('SUGGESTION_SYSTEM prompt', () => {
  it('is a non-empty string that constrains the model to ONE next-message, no preamble', () => {
    expect(typeof SUGGESTION_SYSTEM).toBe('string');
    expect(SUGGESTION_SYSTEM.length).toBeGreaterThan(40);
    // Must instruct a single plain-text suggestion with no commentary/preamble.
    expect(SUGGESTION_SYSTEM.toLowerCase()).toContain('next');
    expect(SUGGESTION_SYSTEM.toLowerCase()).toContain('only');
  });
});
