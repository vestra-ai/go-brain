import { describe, it, expect } from 'vitest';
import { narrowToolset, narrowToolsetPreservingProtected, PROTECTED_TOOL_NAMES } from '../capability-registry.js';

const built = [{ name: 'Read' }, { name: 'Agent' }, { name: 'Write' }];

describe('capability-registry — the walls end the protected Agent tool', () => {
  it('flag-off shorthand still preserves Agent (byte-identical)', () => {
    expect(PROTECTED_TOOL_NAMES.has('Agent')).toBe(true);
    expect(narrowToolsetPreservingProtected(built, ['Read']).map((t) => t.name)).toEqual(['Read', 'Agent']);
  });
  it('walls on: a toolset means what it says — Agent is dropped unless listed', () => {
    expect(narrowToolset(built, ['Read'], { preserveProtected: false }).map((t) => t.name)).toEqual(['Read']);
    expect(narrowToolset(built, ['Read', 'Agent'], { preserveProtected: false }).map((t) => t.name)).toEqual(['Read', 'Agent']);
  });
});
