import { describe, it, expect } from 'vitest';
import { TOOL_DESCRIPTIONS } from '../descriptions/index.js';

describe('WebFetch description honesty', () => {
  it('does not claim it returns an extract', () => {
    expect(TOOL_DESCRIPTIONS.WebFetch).not.toMatch(/model-relevant extract/i);
  });
  it('states the prompt is advisory context', () => {
    expect(TOOL_DESCRIPTIONS.WebFetch).toMatch(/advisory|prepended|guides? your reading/i);
  });
});
