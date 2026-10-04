import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  ALLOWED_TOOLS_HARD_MAX,
  DESCRIPTION_HARD_MAX,
  DESCRIPTION_HARD_MIN,
  assessDescriptionQuality,
  firstProseParagraph,
  normalizeAgentSource,
  normalizeSkillSource,
  splitFrontmatterBlock,
  stripKnownBoilerplate,
} from '../ability-frontmatter.js';

const parseYaml = (src: string): unknown => parse(src);

const TRIGGER_DESC =
  'Manages automated routines — creation, editing, and troubleshooting. Use when the user asks to automate or schedule a recurring task.';

describe('splitFrontmatterBlock', () => {
  it('splits a well-formed block and strips one leading blank line from the body', () => {
    const r = splitFrontmatterBlock('---\nname: x\ndescription: y\n---\n\n# Body\n\nText');
    expect(r.rawYaml).toBe('name: x\ndescription: y');
    expect(r.body).toBe('# Body\n\nText');
  });

  it('returns null yaml for a bare body', () => {
    const r = splitFrontmatterBlock('# Routine\n\nManage automated routines.');
    expect(r.rawYaml).toBeNull();
    expect(r.body).toBe('# Routine\n\nManage automated routines.');
    expect(r.unclosed).toBeUndefined();
  });

  it('treats an unclosed fence as a bare body and marks it unclosed', () => {
    const r = splitFrontmatterBlock('---\nname: x\nno close here');
    expect(r.rawYaml).toBeNull();
    expect(r.body).toBe('---\nname: x\nno close here');
    expect(r.unclosed).toBe(true);
  });

  it('keeps folded block scalars intact in the yaml region', () => {
    const c =
      '---\nname: create-routine\ndescription: >\n  Manages automated routines.\n  Use when the user asks to automate.\n---\n# Routine\n';
    const r = splitFrontmatterBlock(c);
    expect(parseYaml(r.rawYaml!)).toMatchObject({ name: 'create-routine' });
    expect(r.body).toBe('# Routine\n');
  });

  it('handles CRLF fences', () => {
    const r = splitFrontmatterBlock('---\r\nname: x\r\n---\r\n\r\nBody');
    expect(r.rawYaml).toBe('name: x');
    expect(r.body).toBe('Body');
  });

  it('accepts the ... document-end fence as a close', () => {
    const r = splitFrontmatterBlock('---\nname: x\n...\nBody');
    expect(r.rawYaml).toBe('name: x');
    expect(r.body).toBe('Body');
  });

  it('does not treat an indented dashed line as a close fence', () => {
    const c = '---\ndescription: >\n  before\n  ---ish middle\n---\nBody';
    const r = splitFrontmatterBlock(c);
    expect(r.rawYaml).toContain('---ish middle');
    expect(r.body).toBe('Body');
  });
});

describe('normalizeSkillSource', () => {
  const base = { parseYaml, mode: 'derive' as const };

  it('moves inline frontmatter into metadata and returns a bare body, idempotently', () => {
    const content = `---\nname: dropbox\ndescription: Manage Dropbox files. Use when the user asks to upload, share, or organize Dropbox content.\nmcps: [composio]\n---\n\n# Dropbox\nDo things.`;
    const r1 = normalizeSkillSource({ ...base, slug: 'dropbox', content });
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error('unreachable');
    expect(r1.value.metadata.name).toBe('dropbox');
    expect(r1.value.metadata.mcps).toEqual(['composio']);
    expect(r1.value.body.startsWith('# Dropbox')).toBe(true);
    expect(r1.value.frontmatterSource).toBe('inline');

    const r2 = normalizeSkillSource({
      ...base,
      slug: 'dropbox',
      content: r1.value.body,
      existingMetadata: r1.value.metadata as Record<string, unknown>,
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw new Error('unreachable');
    expect(r2.value.body).toBe(r1.value.body);
    expect(r2.value.metadata).toEqual(r1.value.metadata);
    expect(r2.value.frontmatterSource).toBe('metadata');
  });

  it('passes through the seed shape: bare body + existing metadata', () => {
    const r = normalizeSkillSource({
      ...base,
      slug: 'create-routine',
      content: '\n# Routine\n\nManage automated routines.',
      existingMetadata: { name: 'create-routine', description: TRIGGER_DESC },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.frontmatterSource).toBe('metadata');
    expect(r.value.body.trimStart().startsWith('# Routine')).toBe(true);
  });

  it('marks source merged when inline description rides alongside other existing fields', () => {
    const r = normalizeSkillSource({
      ...base,
      slug: 'mix',
      content: `---\ndescription: ${TRIGGER_DESC}\n---\nBody prose.`,
      existingMetadata: { name: 'Fancy Mix', category: 'productivity' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.metadata.name).toBe('Fancy Mix');
    expect(r.value.metadata.category).toBe('productivity');
    expect(r.value.frontmatterSource).toBe('merged');
  });

  it('inline fields win over existing metadata on conflict', () => {
    const r = normalizeSkillSource({
      ...base,
      slug: 'w',
      content: `---\nname: Winner\ndescription: ${TRIGGER_DESC}\n---\nBody.`,
      existingMetadata: { name: 'Loser', description: 'An older stored description that should be replaced entirely.' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.metadata.name).toBe('Winner');
    expect(r.value.metadata.description).toBe(TRIGGER_DESC);
  });

  it('reject mode fails with structured issues when description is unsatisfiable', () => {
    const r = normalizeSkillSource({ parseYaml, mode: 'reject', slug: 'bad', content: '# Just a heading' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.issues.some((i) => i.code === 'missing_description' && i.severity === 'error')).toBe(true);
  });

  it('derive mode derives the description from the first prose paragraph and flags provenance', () => {
    const r = normalizeSkillSource({
      ...base,
      slug: 'world-clock',
      content: '# World Clock\n\nShows the current time in any city the user asks about.\n\nMore below.',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.metadata.name).toBe('world-clock');
    expect(r.value.metadata.description).toBe('Shows the current time in any city the user asks about.');
    expect(r.value.frontmatterSource).toBe('derived');
    expect(r.value.issues.some((i) => i.code === 'derived_description' && i.severity === 'warn')).toBe(true);
  });

  it('derive mode fails when no description can be derived (heading-only body)', () => {
    const r = normalizeSkillSource({ ...base, slug: 'empty', content: '# Title\n\n## Another heading' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.issues.some((i) => i.code === 'missing_description')).toBe(true);
  });

  it('unparseable inline yaml degrades to a warn and falls back to existing metadata', () => {
    const r = normalizeSkillSource({
      ...base,
      slug: 'x',
      content: '---\n: {{bad yaml\n---\nBody prose long enough either way.',
      existingMetadata: { name: 'x', description: TRIGGER_DESC },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.issues.some((i) => i.code === 'unparseable_yaml' && i.severity === 'warn')).toBe(true);
    expect(r.value.metadata.description).toBe(TRIGGER_DESC);
  });

  it('derive mode drops an invalid optional field with a warn instead of failing', () => {
    const r = normalizeSkillSource({
      ...base,
      slug: 'c',
      content: `---\ndescription: ${TRIGGER_DESC}\ncolor: not-a-color\n---\nBody.`,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.metadata.color).toBeUndefined();
    expect(r.value.issues.some((i) => i.code === 'invalid_field' && i.field === 'color' && i.severity === 'warn')).toBe(true);
  });

  it('reject mode hard-fails an invalid optional field', () => {
    const r = normalizeSkillSource({
      parseYaml,
      mode: 'reject',
      slug: 'c',
      content: `---\nname: c\ndescription: ${TRIGGER_DESC}\ncolor: not-a-color\n---\nBody.`,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.issues.some((i) => i.code === 'invalid_field' && i.field === 'color' && i.severity === 'error')).toBe(true);
  });

  it('carries unknown keys through with a warn (license survives)', () => {
    const r = normalizeSkillSource({
      ...base,
      slug: 'theme-factory',
      content: `---\nname: theme-factory\ndescription: ${TRIGGER_DESC}\nlicense: Complete terms in LICENSE.txt\n---\nBody.`,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect((r.value.metadata as Record<string, unknown>).license).toBe('Complete terms in LICENSE.txt');
    expect(r.value.issues.some((i) => i.code === 'unknown_key' && i.field === 'license' && i.severity === 'warn')).toBe(true);
  });

  it('never lets the reserved frontmatter_source key smuggle through inputs', () => {
    const r = normalizeSkillSource({
      ...base,
      slug: 's',
      content: `---\nfrontmatter_source: inline\ndescription: ${TRIGGER_DESC}\n---\nBody.`,
      existingMetadata: { frontmatter_source: 'derived', name: 's' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect((r.value.metadata as Record<string, unknown>).frontmatter_source).toBeUndefined();
  });

  it('derive mode keeps a below-floor description as last resort when the body has no prose', () => {
    const r = normalizeSkillSource({
      ...base,
      slug: 'pdf',
      content: '---\nname: PDF\ndescription: PDF tools\n---\n# PDF\n\n## Only headings here',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.metadata.description).toBe('PDF tools');
    expect(r.value.issues.some((i) => i.code === 'description_thin' && i.severity === 'warn')).toBe(true);
  });

  it('reject mode still enforces the authoring floor on short descriptions', () => {
    const r = normalizeSkillSource({
      parseYaml,
      mode: 'reject',
      slug: 'pdf',
      content: '---\nname: PDF\ndescription: PDF tools\n---\n# PDF',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.issues.some((i) => i.code === 'invalid_field' && i.field === 'description' && i.severity === 'error')).toBe(true);
  });

  it('the ceiling is 1000 — the one number the catalog renders whole (founder call 2026-08-22)', () => {
    // The description IS the trigger surface: the model reads exactly this line
    // per skill. format-catalog.ts imports this same constant as its render cap,
    // so a description that passes here is shown in full, never truncated.
    expect(DESCRIPTION_HARD_MAX).toBe(1000);
  });

  it('reject mode accepts a description at exactly the ceiling', () => {
    const desc = `Use when the user asks to ${'"schedule this", '.repeat(60)}`.slice(0, DESCRIPTION_HARD_MAX);
    expect(desc.length).toBe(DESCRIPTION_HARD_MAX);
    const r = normalizeSkillSource({
      parseYaml,
      mode: 'reject',
      slug: 'at-cap',
      content: '# Body',
      existingMetadata: { name: 'At cap', description: desc },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.metadata.description).toBe(desc);
  });

  it('reject mode refuses a description one char over the ceiling with the bounds message — rewrite the frontmatter', () => {
    const desc = `Use when the user asks to ${'"schedule this", '.repeat(70)}`.slice(0, DESCRIPTION_HARD_MAX + 1);
    const r = normalizeSkillSource({
      parseYaml,
      mode: 'reject',
      slug: 'over-cap',
      content: '# Body',
      existingMetadata: { name: 'Over cap', description: desc },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    const issue = r.issues.find((i) => i.code === 'invalid_field' && i.field === 'description');
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toContain(`${DESCRIPTION_HARD_MIN}–${DESCRIPTION_HARD_MAX}`);
  });

  it('treats an empty-string existing description as absent', () => {
    const r = normalizeSkillSource({
      ...base,
      slug: 'higgsfield-generate',
      content: 'Generates videos with Higgsfield models when the user asks for AI video output.',
      existingMetadata: { name: 'higgsfield-generate', description: '≥' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.metadata.description.length).toBeGreaterThanOrEqual(DESCRIPTION_HARD_MIN);
    expect(r.value.frontmatterSource).toBe('derived');
  });
});

describe('normalizeAgentSource', () => {
  it('keeps the body as the system prompt and validates metadata like skills', () => {
    const r = normalizeAgentSource({
      parseYaml,
      mode: 'derive',
      slug: 'deep-researcher',
      content: 'You are a world-class research analyst.',
      existingMetadata: {
        name: 'deep-researcher',
        description: 'Use when a question needs thorough research — market analysis, competitive landscape, topic deep-dives.',
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.body).toBe('You are a world-class research analyst.');
    expect(r.value.metadata.name).toBe('deep-researcher');
  });

  it('accepts agent-specific fields (avatar_url, model)', () => {
    const r = normalizeAgentSource({
      parseYaml,
      mode: 'reject',
      slug: 'a',
      content: `---\nname: a\ndescription: ${TRIGGER_DESC}\navatar_url: https://cdn.vestra.ai/a.png\nmodel: claude-sonnet-5\n---\nPrompt.`,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.metadata.avatar_url).toBe('https://cdn.vestra.ai/a.png');
    expect(r.value.metadata.model).toBe('claude-sonnet-5');
  });
});

describe('assessDescriptionQuality', () => {
  it('flags thin and non-trigger descriptions as warns', () => {
    const issues = assessDescriptionQuality('Dropbox skill.');
    expect(issues.map((i) => i.code).sort()).toEqual(['description_not_trigger_phrased', 'description_thin']);
    expect(issues.every((i) => i.severity === 'warn')).toBe(true);
  });

  it('passes a trigger-phrased description of healthy length', () => {
    expect(assessDescriptionQuality(TRIGGER_DESC)).toEqual([]);
  });

  it('accepts "Use for …" and "Use whenever …" as trigger phrasing (bloom/creative-direction shapes)', () => {
    expect(
      assessDescriptionQuality('Turn any substantial answer into a Bloom. Use for reports, briefs, research syntheses, or guides.'),
    ).toEqual([]);
    expect(
      assessDescriptionQuality('Creative direction for generated media. Use whenever creating images or video with the media tool.'),
    ).toEqual([]);
  });

  it('flags only the trigger warn for long what-it-is prose', () => {
    const issues = assessDescriptionQuality(
      'A comprehensive toolkit for managing spreadsheets, formulas, pivot tables, and structured data exports.',
    );
    expect(issues.map((i) => i.code)).toEqual(['description_not_trigger_phrased']);
  });
});

describe('firstProseParagraph', () => {
  it('skips headings, blockquotes, lists, tables, and fences', () => {
    const body =
      '# Title\n\n> A quote to skip.\n\n- a list item\n\n```\ncode\n```\n\nThe real first prose paragraph\ncontinues here.\n\nSecond para.';
    expect(firstProseParagraph(body)).toBe('The real first prose paragraph continues here.');
  });

  it('caps at a word boundary around 300 chars', () => {
    const long = `${'word '.repeat(100)}end.`;
    const out = firstProseParagraph(long)!;
    expect(out.length).toBeLessThanOrEqual(301);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns null when only structure exists', () => {
    expect(firstProseParagraph('# H\n\n## H2\n')).toBeNull();
  });
});

describe('stripKnownBoilerplate', () => {
  it('removes the canonical Composio connect blockquote', () => {
    const body =
      '> **Tools in this skill are available via Composio MCP.** Call them using the full name format: `mcp__composio__TOOL_SLUG`. Authentication is handled automatically — if a tool requires auth, the UI shows a connect card. Wait for the user to connect, then retry.\n\n# Render Automation via Composio\nRest.';
    const r = stripKnownBoilerplate(body);
    expect(r.stripped).toBe(true);
    expect(r.body.startsWith('# Render Automation via Composio')).toBe(true);
  });

  it('leaves requirement-bullet variants alone (conservative)', () => {
    const body = '## Requirements\n\n- Composio MCP tools must be available (tools prefixed with `mcp__composio__`)\n';
    const r = stripKnownBoilerplate(body);
    expect(r.stripped).toBe(false);
    expect(r.body).toBe(body);
  });

  it('is a no-op on clean bodies', () => {
    expect(stripKnownBoilerplate('# Clean\n')).toEqual({ body: '# Clean\n', stripped: false });
  });
});

describe('allowed-tools ceiling', () => {
  // The install route (items-routes.handler.ts) normalizes in reject mode: the mode
  // that refused Ankur's 602-character list on prod (task 1b107f70, 2026-09-09).
  const base = { parseYaml, mode: 'reject' as const, slug: 'cornerstone' };
  const toolList = (minChars: number): string => {
    const names: string[] = [];
    for (let i = 0; names.join(', ').length < minChars; i++) names.push(`mcp__vendor__tool_number_${i}`);
    return names.join(', ');
  };
  const withTools = (tools: string) =>
    `---\nname: cornerstone\ndescription: ${TRIGGER_DESC}\nallowed-tools: "${tools}"\n---\n\n# Cornerstone\nWrite the article.`;

  it('keeps a 602-character allowed-tools list whole', () => {
    const tools = toolList(602);
    const r = normalizeSkillSource({ ...base, content: withTools(tools) });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.metadata['allowed-tools']).toBe(tools);
  });

  it('cuts a list past 2000 characters to whole names instead of refusing it', () => {
    const tools = toolList(2600);
    const r = normalizeSkillSource({ ...base, content: withTools(tools) });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    const kept = r.value.metadata['allowed-tools'] as string;
    expect(kept.length).toBeLessThanOrEqual(ALLOWED_TOOLS_HARD_MAX);
    expect(kept.length).toBeGreaterThan(ALLOWED_TOOLS_HARD_MAX - 40);
    // A prefix of whole names: what follows the cut in the source is the next separator.
    expect(tools.startsWith(kept)).toBe(true);
    expect(tools.charAt(kept.length)).toBe(',');
  });

  it('cuts the YAML list form the same way', () => {
    const names = toolList(2600).split(', ');
    const content = `---\nname: cornerstone\ndescription: ${TRIGGER_DESC}\nallowed-tools:\n${names.map((n) => `  - ${n}`).join('\n')}\n---\n\n# Cornerstone\nWrite the article.`;
    const r = normalizeSkillSource({ ...base, content });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    const kept = r.value.metadata['allowed-tools'] as string;
    expect(kept.length).toBeLessThanOrEqual(ALLOWED_TOOLS_HARD_MAX);
    expect(names.join(', ').startsWith(kept)).toBe(true);
  });
});
