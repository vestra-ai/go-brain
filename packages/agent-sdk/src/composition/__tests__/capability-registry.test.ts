import { describe, it, expect } from 'vitest';
import { PROTECTED_TOOL_NAMES, narrowToolsetPreservingProtected } from '../capability-registry.js';

describe('narrowToolsetPreservingProtected — AC-R6 per-role toolset narrowing meets protected-core', () => {
  const tools = [{ name: 'Read' }, { name: 'Bash' }, { name: 'Grep' }, { name: 'Agent' }];

  it('narrows to the declared allowed names (plus Agent, which is always preserved)', () => {
    expect(narrowToolsetPreservingProtected(tools, ['Read', 'Grep']).map((t) => t.name).sort()).toEqual(['Agent', 'Grep', 'Read']);
  });

  it('narrows strictly to the declared names when the built toolset has no Agent to protect', () => {
    const noAgent = [{ name: 'Read' }, { name: 'Bash' }, { name: 'Grep' }];
    expect(narrowToolsetPreservingProtected(noAgent, ['Read', 'Grep']).map((t) => t.name).sort()).toEqual(['Grep', 'Read']);
  });

  it('NEVER drops Agent even when the allow-list omits it', () => {
    const result = narrowToolsetPreservingProtected(tools, ['Read']);
    expect(result.map((t) => t.name)).toContain('Agent');
  });

  it('is a no-op when Agent is not present in the built toolset at all (nothing to protect)', () => {
    const noAgent = [{ name: 'Read' }, { name: 'Bash' }];
    expect(narrowToolsetPreservingProtected(noAgent, ['Read']).map((t) => t.name)).toEqual(['Read']);
  });

  it('PROTECTED_TOOL_NAMES contains exactly Agent (filesystem is deliberately NOT tool-level protected)', () => {
    expect(PROTECTED_TOOL_NAMES.has('Agent')).toBe(true);
    expect(PROTECTED_TOOL_NAMES.has('Read')).toBe(false);
  });
});
