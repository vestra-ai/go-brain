import { describe, it, expect } from 'vitest';
import { resolveNodeSkills, visibleToolset } from '../skills-scope.js';

const parentSkills = [
  { slug: 'deep-research', tools: ['WebSearch', 'WebFetch', 'Read'] },
  { slug: 'code-review', tools: ['Read', 'Grep', 'Bash'] },
];

describe('resolveNodeSkills — AC-R3 skills quarantine', () => {
  it('general-purpose inherits the parent skill set', () => {
    expect(resolveNodeSkills(true, [], parentSkills)).toBe(parentSkills);
  });

  it('a custom type does NOT inherit parent skills — gets ONLY its own (possibly empty) list', () => {
    const own = [{ slug: 'deep-research', tools: ['WebSearch', 'WebFetch'] }];
    expect(resolveNodeSkills(false, own, parentSkills)).toBe(own);
  });

  it('a custom type with no declared skills gets an empty list, never the parent set', () => {
    expect(resolveNodeSkills(false, [], parentSkills)).toEqual([]);
  });
});

describe('visibleToolset — toolset ∩ ⋃(skill.tools)', () => {
  it('with zero skills attached, the declared toolset stands unchanged', () => {
    expect(visibleToolset(['Bash', 'Read', 'Write'], [])).toEqual(['Bash', 'Read', 'Write']);
  });

  it('with skills attached, only tools covered by a skill remain visible', () => {
    const skills = [{ slug: 'deep-research', tools: ['WebSearch', 'WebFetch'] }];
    const result = visibleToolset(['Bash', 'WebSearch', 'WebFetch', 'Read'], skills);
    expect(result).toEqual(['WebSearch', 'WebFetch']);
  });

  it('a tool covered by ANY attached skill is visible (union across skills)', () => {
    const skills = [
      { slug: 'a', tools: ['WebSearch'] },
      { slug: 'b', tools: ['Bash'] },
    ];
    const result = visibleToolset(['WebSearch', 'Bash', 'Read'], skills);
    expect(result).toEqual(['WebSearch', 'Bash']);
  });

  it('a tool NOT covered by any attached skill is excluded even if in the declared toolset', () => {
    const skills = [{ slug: 'narrow', tools: ['Read'] }];
    expect(visibleToolset(['Bash', 'Read'], skills)).toEqual(['Read']);
  });

  it('preserves the ORIGINAL toolset order (not the skill declaration order)', () => {
    const skills = [{ slug: 's', tools: ['Read', 'Bash'] }];
    expect(visibleToolset(['Bash', 'Read'], skills)).toEqual(['Bash', 'Read']);
  });
});
