import { describe, it, expect } from 'vitest';
import {
  SubagentTypeRegistry,
  SubagentFloorViolationError,
  UnknownSubagentTypeError,
  GENERAL_PURPOSE_TYPE,
  EXPLORER_TYPE,
  RESEARCHER_TYPE,
  BUILT_IN_SUBAGENT_TYPES,
  isBelowModelFloor,
  projectSubagentTypesFromAbilities,
} from '../subagent-type-registry.js';

describe('isBelowModelFloor — structural "never Haiku"', () => {
  it('flags every Haiku id as below the floor', () => {
    expect(isBelowModelFloor('claude-haiku-4-5')).toBe(true);
    expect(isBelowModelFloor('claude-haiku-4-5-20251001')).toBe(true);
  });

  it('does not flag Sonnet/Opus/OpenAI/Fireworks models', () => {
    for (const id of ['claude-sonnet-5', 'claude-opus-4-8', 'gpt-5.5', 'deepseek-v4-pro', 'glm-5.2']) {
      expect(isBelowModelFloor(id)).toBe(false);
    }
  });
});

describe('SubagentTypeRegistry — AC-R1 (Haiku registration REJECTED)', () => {
  it('a security-reviewer type declared with a Haiku model FAILS to register', () => {
    const registry = new SubagentTypeRegistry();
    expect(() =>
      registry.register({ name: 'security-reviewer', description: 'reviews security', model: 'claude-haiku-4-5' }),
    ).toThrow(SubagentFloorViolationError);
    // Registration REJECTED — the type must not exist afterward.
    expect(registry.has('security-reviewer')).toBe(false);
  });

  it('the error names the offending type and model', () => {
    const registry = new SubagentTypeRegistry();
    try {
      registry.register({ name: 'sec', description: 'd', model: 'claude-haiku-4-5-20251001' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SubagentFloorViolationError);
      const e = err as SubagentFloorViolationError;
      expect(e.typeName).toBe('sec');
      expect(e.model).toBe('claude-haiku-4-5-20251001');
    }
  });

  it('a known type resolves to its pinned model/toolset/skills', () => {
    const registry = new SubagentTypeRegistry();
    registry.register({
      name: 'researcher',
      description: 'does research',
      model: 'claude-sonnet-5',
      toolset: ['WebSearch', 'WebFetch', 'Read'],
      skills: ['deep-research'],
    });
    const resolved = registry.resolve('researcher');
    expect(resolved.model).toBe('claude-sonnet-5');
    expect(resolved.toolset).toEqual(['WebSearch', 'WebFetch', 'Read']);
    expect(resolved.skills).toEqual(['deep-research']);
  });

  it('a type with NO pinned model registers fine (inherits the spawner model)', () => {
    const registry = new SubagentTypeRegistry();
    expect(() => registry.register({ name: 'generic', description: 'd' })).not.toThrow();
    expect(registry.resolve('generic').model).toBeUndefined();
  });
});

describe('SubagentTypeRegistry — unknown type error', () => {
  it('resolving an unregistered name throws UnknownSubagentTypeError listing available types', () => {
    const registry = new SubagentTypeRegistry();
    registry.register({ name: 'researcher', description: 'd' });
    try {
      registry.resolve('bogus-type');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownSubagentTypeError);
      const e = err as UnknownSubagentTypeError;
      expect(e.requested).toBe('bogus-type');
      expect(e.available).toContain('researcher');
      expect(e.available).toContain(GENERAL_PURPOSE_TYPE);
    }
  });
});

describe('SubagentTypeRegistry — general-purpose built-in', () => {
  it('general-purpose is always present without explicit registration', () => {
    const registry = new SubagentTypeRegistry();
    expect(registry.has(GENERAL_PURPOSE_TYPE)).toBe(true);
    expect(() => registry.resolve(GENERAL_PURPOSE_TYPE)).not.toThrow();
  });

  it('general-purpose has no pinned model (never floor-checked)', () => {
    const registry = new SubagentTypeRegistry();
    expect(registry.resolve(GENERAL_PURPOSE_TYPE).model).toBeUndefined();
  });
});

describe('SubagentTypeRegistry — first-party built-ins (P2.1)', () => {
  it('explorer and researcher are present in a fresh registry alongside general-purpose', () => {
    const registry = new SubagentTypeRegistry();
    expect(registry.has(GENERAL_PURPOSE_TYPE)).toBe(true);
    expect(registry.has(EXPLORER_TYPE)).toBe(true);
    expect(registry.has(RESEARCHER_TYPE)).toBe(true);
  });

  it('explorer is a read-only search type WITH web reach: toolset Read/Grep/Glob + WebSearch/WebFetch, a baked systemPrompt, no pinned model', () => {
    const explorer = new SubagentTypeRegistry().resolve(EXPLORER_TYPE);
    // P2.3 — research archetypes carry first-class WebSearch/WebFetch (SSRF-guarded,
    // metered); explorer stays read-only (no Write) but can now reach the web.
    expect(explorer.toolset).toEqual(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']);
    expect(explorer.systemPrompt).toBeTruthy();
    expect(explorer.model).toBeUndefined(); // inherit the spawner default
  });

  it('researcher may write AND search the web: toolset Read/Grep/Glob/Write + WebSearch/WebFetch, a baked systemPrompt, no pinned model', () => {
    const researcher = new SubagentTypeRegistry().resolve(RESEARCHER_TYPE);
    expect(researcher.toolset).toEqual(['Read', 'Grep', 'Glob', 'Write', 'WebSearch', 'WebFetch']);
    expect(researcher.systemPrompt).toBeTruthy();
    expect(researcher.model).toBeUndefined();
  });

  it('BUILT_IN_SUBAGENT_TYPES is the single source and names exactly the three first-party types', () => {
    expect(BUILT_IN_SUBAGENT_TYPES.map((t) => t.name)).toEqual([
      GENERAL_PURPOSE_TYPE,
      EXPLORER_TYPE,
      RESEARCHER_TYPE,
    ]);
    // No built-in pins a model (all inherit the spawner default — never floor-checked).
    for (const t of BUILT_IN_SUBAGENT_TYPES) expect(t.model).toBeUndefined();
  });

  it('an installed ability WINS a built-in slug collision at the policy layer (ability replaces the built-in)', () => {
    const registry = projectSubagentTypesFromAbilities([
      { agents: [{ slug: RESEARCHER_TYPE, description: 'ability researcher', prompt: 'ABILITY PROMPT' }] },
    ]);
    // The ability's config replaced the baked researcher — its prompt/description win.
    expect(registry.resolve(RESEARCHER_TYPE).systemPrompt).toBe('ABILITY PROMPT');
    expect(registry.resolve(RESEARCHER_TYPE).description).toBe('ability researcher');
    // explorer + general-purpose remain the built-ins (uncollided).
    expect(registry.has(EXPLORER_TYPE)).toBe(true);
    expect(registry.has(GENERAL_PURPOSE_TYPE)).toBe(true);
  });
});

describe('projectSubagentTypesFromAbilities — ONE registry from the installed roster', () => {
  it('projects every ability agent into a resolvable type', () => {
    const registry = projectSubagentTypesFromAbilities([
      { agents: [{ slug: 'researcher', description: 'does research', prompt: 'You research things.' }] },
      { agents: [{ slug: 'writer', description: 'writes docs', prompt: null }] },
    ]);
    expect(registry.has('researcher')).toBe(true);
    expect(registry.has('writer')).toBe(true);
    expect(registry.resolve('researcher').systemPrompt).toBe('You research things.');
    expect(registry.resolve('writer').systemPrompt).toBeUndefined();
  });

  it('always includes general-purpose alongside the projected roster', () => {
    const registry = projectSubagentTypesFromAbilities([{ agents: [{ slug: 'researcher' }] }]);
    expect(registry.has(GENERAL_PURPOSE_TYPE)).toBe(true);
  });

  it('a single bad agent (pinned to Haiku) is REJECTED via onRejected without failing the whole projection', () => {
    const rejected: Array<{ slug: string; error: Error }> = [];
    const registry = projectSubagentTypesFromAbilities(
      [
        {
          agents: [
            { slug: 'ok-agent', description: 'd' },
            { slug: 'bad-agent', description: 'd', model: 'claude-haiku-4-5' },
          ],
        },
      ],
      (slug, error) => rejected.push({ slug, error }),
    );
    expect(rejected).toEqual([{ slug: 'bad-agent', error: expect.any(Error) }]);
    expect(registry.has('ok-agent')).toBe(true);
    expect(registry.has('bad-agent')).toBe(false);
  });
});

describe('orchestration walls (D2) — `delegates` survives the ability projection', () => {
  it('a projected ability agent carries its delegates flag into the registry', () => {
    const registry = projectSubagentTypesFromAbilities([
      { agents: [{ slug: 'planner', delegates: true }, { slug: 'scribe', delegates: false }, { slug: 'quiet' }] },
    ]);
    expect(registry.resolve('planner').delegates).toBe(true);
    expect(registry.resolve('scribe').delegates).toBe(false);
    expect(registry.resolve('quiet').delegates).toBeUndefined();
  });
});
