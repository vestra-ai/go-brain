import { describe, it, expect } from 'vitest';
import { buildSkillMd, parseAbilityHooks, isAbilityHookEvent, ABILITY_HOOK_EVENTS } from '../../index.js';

describe('ability chain (relocated into the SDK contract)', () => {
  it('builds a SKILL.md from a minimal skill', () => {
    const md = buildSkillMd({ slug: 'demo', description: 'd', icon: null, content: null });
    expect(typeof md).toBe('string');
    expect(md).toContain('demo');
  });
  it('parses hooks + validates hook events', () => {
    expect(parseAbilityHooks(undefined)).toBeUndefined();
    expect(typeof isAbilityHookEvent(ABILITY_HOOK_EVENTS[0])).toBe('boolean');
  });
});
