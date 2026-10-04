import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildSkillMd, buildAgentMd } from '../ability-synthesis.js';
import { normalizeSkillSource, normalizeAgentSource, KNOWN_SKILL_METADATA_KEYS } from '../ability-frontmatter.js';

const parseYaml = (src: string): unknown => parse(src);

describe('skill synthesis round-trip', () => {
  it('emits every known metadata key and normalize recovers it losslessly', () => {
    const md = buildSkillMd({
      slug: 'higgsfield-generate',
      description: 'Use when the user asks to generate images, video, or audio with Higgsfield.',
      icon: 'sparkles',
      category: 'content-creation',
      color: '#c9a227',
      allowed_tools: 'mcp_search, mcp_invoke, Read, Write',
      tools: ['mcp_invoke'],
      mcps: ['higgsfield'],
      args_schema: { type: 'object', properties: { prompt: { type: 'string' } } },
      content: 'Body text.',
    });
    const r = normalizeSkillSource({ parseYaml, mode: 'reject', slug: 'higgsfield-generate', content: md });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.metadata).toMatchObject({
      name: 'higgsfield-generate',
      description: 'Use when the user asks to generate images, video, or audio with Higgsfield.',
      icon: 'sparkles',
      category: 'content-creation',
      color: '#c9a227',
      'allowed-tools': 'mcp_search, mcp_invoke, Read, Write',
      tools: ['mcp_invoke'],
      mcps: ['higgsfield'],
      args_schema: { type: 'object', properties: { prompt: { type: 'string' } } },
    });
    expect(r.value.body).toBe('Body text.\n');
    // No unknown-key warns: everything the emitter writes is a known key.
    expect(r.value.issues.filter((i) => i.code === 'unknown_key')).toEqual([]);
  });

  it('is byte-identical to the legacy output when new fields are absent', () => {
    const md = buildSkillMd({
      slug: 'cron',
      description: 'Use when scheduling recurring work.',
      icon: 'clock',
      content: 'Body.',
    });
    expect(md).toBe('---\nname: cron\ndescription: Use when scheduling recurring work.\nicon: clock\n---\n\nBody.\n');
  });

  it('accepts a comma-separated tools string and normalizes it to an array', () => {
    const r = normalizeSkillSource({
      parseYaml,
      mode: 'derive',
      slug: 'imported',
      content:
        '---\nname: imported\ndescription: Use when testing imported Claude-format skills round-trip.\ntools: Read, Grep\n---\nBody.',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.metadata.tools).toEqual(['Read', 'Grep']);
  });

  it('keeps allowed-tools in the known key list', () => {
    expect(KNOWN_SKILL_METADATA_KEYS).toContain('allowed-tools');
  });
});

describe('agent synthesis round-trip', () => {
  it('emits icon/model/tools and normalize recovers them', () => {
    const md = buildAgentMd({
      slug: 'creative-director',
      description: 'Use when a content brief needs shaping before generation begins on a project.',
      avatar_url: 'https://cdn.vestra.ai/a.png',
      color: '#c9a227',
      icon: 'wand',
      model: 'inherit',
      tools: ['mcp_invoke', 'Read'],
      prompt: 'You shape briefs.',
    });
    expect(md).toContain('tools: mcp_invoke, Read');
    expect(md).toContain('model: inherit');
    expect(md).toContain('icon: wand');
    const r = normalizeAgentSource({ parseYaml, mode: 'reject', slug: 'creative-director', content: md });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.metadata.tools).toEqual(['mcp_invoke', 'Read']);
      expect(r.value.metadata.model).toBe('inherit');
      expect(r.value.metadata.icon).toBe('wand');
      expect(r.value.body).toBe('You shape briefs.\n');
    }
  });

  it('agent output is byte-identical when new fields are absent', () => {
    const md = buildAgentMd({
      slug: 'scribe',
      description: 'Use when notes need summarizing into a brief.',
      avatar_url: null,
      color: null,
      prompt: 'You summarize.',
    });
    expect(md).toBe('---\nname: scribe\ndescription: Use when notes need summarizing into a brief.\n---\n\nYou summarize.\n');
  });
});
