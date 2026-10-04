import { describe, it, expect } from 'vitest';
import {
  parsePage,
  serializePage,
  parseArticle,
  serializeArticle,
  type PageFrontmatter,
  type WikiArticle,
} from '../wiki.js';

// --- fixtures -------------------------------------------------------------

/**
 * A real Phase 1 page, byte-for-byte in the shape `serializeEditorArticle` writes it:
 * the `editor: v2` marker spliced in above the spine, inline-flow lists, and
 * `sourceClaimIds` entries carrying a `:<confidence>` suffix.
 */
const PHASE1_PAGE = [
  '---',
  'editor: v2',
  'title: Acme Inc',
  'type: company',
  'created: 2026-08-01T09:00:00.000Z',
  'updated: 2026-08-02T09:00:00.000Z',
  'aliases: []',
  'related: [sahil-verma, project-atlas]',
  'sources: 2',
  'confidence: high',
  'userEdited: false',
  'sourceClaimIds: [clm_1:0.8, clm_2:0.9]',
  '---',
  '## Summary',
  'Acme works with [[sahil-verma]]. [s1]',
].join('\n');

const page = (over: Partial<PageFrontmatter> = {}): PageFrontmatter => ({
  title: 'Sahil Verma',
  type: 'person',
  aliases: [],
  updated: '2026-08-29',
  ...over,
});

// --- unknown keys survive -------------------------------------------------

describe('parsePage / serializePage — open frontmatter', () => {
  it('carries an unknown key through parse → serialize → parse', () => {
    const raw = ['---', 'title: Sahil', 'type: person', 'relation: co-founder', '---', 'body'].join('\n');

    const once = parsePage(raw);
    expect(once.frontmatter.relation).toBe('co-founder');

    const back = parsePage(serializePage(once));
    expect(back.frontmatter.relation).toBe('co-founder');
    expect(back.body).toBe('body');
  });

  it('preserves a nested cites map', () => {
    const raw = [
      '---',
      'title: Sahil',
      'type: person',
      'cites:',
      '  s1:',
      '    - ev:tasks:gmail:abc123',
      '    - ev:notes:xyz789',
      '  s2:',
      '    - ev:tasks:slack:def456',
      '---',
      'body [s1]',
    ].join('\n');

    const once = parsePage(raw);
    expect(once.frontmatter.cites).toEqual({
      s1: ['ev:tasks:gmail:abc123', 'ev:notes:xyz789'],
      s2: ['ev:tasks:slack:def456'],
    });

    const back = parsePage(serializePage(once));
    expect(back.frontmatter.cites).toEqual(once.frontmatter.cites);
  });

  it('preserves a wikilink-valued key (the value must not re-parse as a nested list)', () => {
    const raw = ['---', 'title: Sahil', 'type: person', 'org: "[[entities/companies/vestra]]"', '---', 'body'].join(
      '\n',
    );

    const once = parsePage(raw);
    expect(once.frontmatter.org).toBe('[[entities/companies/vestra]]');

    // The serializer must re-quote it: an unquoted `[[x]]` is a nested flow sequence in YAML.
    const md = serializePage(once);
    expect(parsePage(md).frontmatter.org).toBe('[[entities/companies/vestra]]');
  });

  it('orders the spine keys first and unknown keys after, in insertion order', () => {
    const md = serializePage({
      frontmatter: { ...page(), zeta: 'z', relation: 'co-founder' },
      body: 'body',
    });
    const keys = md
      .split('\n---\n')[0]
      .split('\n')
      .slice(1)
      .filter((l) => /^[a-zA-Z]\w*:/.test(l))
      .map((l) => l.slice(0, l.indexOf(':')));

    expect(keys).toEqual(['title', 'type', 'updated', 'aliases', 'zeta', 'relation']);
  });

  it('is byte-stable across a second serialize (no drift on re-write)', () => {
    const first = serializePage(parsePage(PHASE1_PAGE));
    const second = serializePage(parsePage(first));
    expect(second).toBe(first);
  });
});

// --- today's pages keep working ------------------------------------------

describe('parseArticle — today’s on-disk pages', () => {
  it('parses a real Phase 1 page, keeping the spine, the editor marker and provenance', () => {
    const a = parseArticle(PHASE1_PAGE, 'acme-inc');

    expect(a.frontmatter.title).toBe('Acme Inc');
    expect(a.frontmatter.type).toBe('company');
    expect(a.frontmatter.created).toBe('2026-08-01T09:00:00.000Z');
    expect(a.frontmatter.updated).toBe('2026-08-02T09:00:00.000Z');
    expect(a.frontmatter.aliases).toEqual([]);
    expect(a.frontmatter.related).toEqual(['sahil-verma', 'project-atlas']);
    expect(a.frontmatter.sources).toBe(2);
    expect(a.frontmatter.confidence).toBe('high');
    expect(a.frontmatter.userEdited).toBe(false);
    expect(a.frontmatter.sourceClaimIds).toEqual(['clm_1:0.8', 'clm_2:0.9']);
    // the marker the editor pass stamps — now a real key that round-trips
    expect(a.frontmatter.editor).toBe('v2');
    expect(a.body).toBe('## Summary\nAcme works with [[sahil-verma]]. [s1]');
  });

  it('round-trips the editor marker through serializeArticle', () => {
    const a = parseArticle(PHASE1_PAGE, 'acme-inc');
    expect(parseArticle(serializeArticle(a), 'acme-inc').frontmatter.editor).toBe('v2');
  });

  it('coerces a numeric-looking title back to a string', () => {
    const a = parseArticle('---\ntitle: 2026\ntype: concept\n---\nbody', 'y2026');
    expect(a.frontmatter.title).toBe('2026');
  });

  it('keeps the spine of a legacy page whose title holds a colon (YAML cannot parse it)', () => {
    // The pre-YAML serializer wrote titles raw, so this shape is on disk today. Losing
    // the spine here would unpin a userEdited page and let the dream overwrite it.
    const raw = [
      '---',
      'title: Vestra: the company',
      'type: company',
      'userEdited: true',
      'aliases: [Bash]',
      '---',
      '## Summary',
      'body',
    ].join('\n');

    const a = parseArticle(raw, 'vestra');
    expect(a.frontmatter.title).toBe('Vestra: the company');
    expect(a.frontmatter.userEdited).toBe(true);
    expect(a.frontmatter.aliases).toEqual(['Bash']);
    expect(a.body).toBe('## Summary\nbody');
  });
});

// --- what the legacy fallback protects, and what it does not --------------

describe('parseArticle — the bound on legacy protection', () => {
  it('keeps a bracketed legacy title that YAML reshapes into a list', () => {
    // The old serializer wrote titles raw, so `[Bash]` is a literal title on disk. YAML
    // reads it as a one-item list, which coerces to '' — the title would vanish silently.
    const a = parseArticle('---\ntitle: [Bash]\ntype: person\n---\nbody', 'bash');
    expect(a.frontmatter.title).toBe('[Bash]');
  });

  it('keeps a colon-bearing legacy alias that YAML reshapes into a map entry', () => {
    // `[Vestra: Bash, Sahil]` is a flow sequence holding a single-pair MAP in YAML; the
    // map entry coerces to '' and is filtered out, so the alias disappears without a trace.
    const a = parseArticle('---\ntitle: T\naliases: [Vestra: Bash, Sahil]\n---\nbody', 't');
    expect(a.frontmatter.aliases).toEqual(['Vestra: Bash', 'Sahil']);
  });

  it('leaves a key YAML read as a plain scalar alone — the comment case is bounded, not repaired', () => {
    // `#` opens a YAML comment, so this title reads as 'Acme' where the old parser kept the
    // whole line. That block is VALID YAML and reading it as YAML is the point of the task:
    // only reshapes into a type the key cannot hold are repaired, never a shorter scalar.
    // This test exists to pin the bound so it cannot drift silently.
    const a = parseArticle('---\ntitle: Acme # 1 in sales\ntype: person\n---\nbody', 'acme');
    expect(a.frontmatter.title).toBe('Acme');
  });

  it('contributes only the legacy key vocabulary — a nested block never becomes invented top-level keys', () => {
    // A colon-bearing title forces the legacy line parser, which sees a nested `cites:` map
    // as three flat lines. Those must not become keys: unknown keys persist now, so invented
    // junk (`s1`, `- ev`) would be written straight back to disk on the next write.
    const raw = [
      '---',
      'title: Vestra: the company',
      'type: company',
      'userEdited: true',
      'cites:',
      '  s1:',
      '    - ev:tasks:a',
      '---',
      'body',
    ].join('\n');

    const a = parseArticle(raw, 'vestra');
    expect(a.frontmatter.title).toBe('Vestra: the company');
    expect(a.frontmatter.userEdited).toBe(true);
    expect(Object.keys(a.frontmatter).sort()).toEqual([
      'aliases',
      'confidence',
      'created',
      'related',
      'sources',
      'title',
      'type',
      'updated',
      'userEdited',
    ]);

    const md = serializeArticle(a);
    expect(md).not.toContain('s1:');
    expect(md).not.toContain('- ev');
    expect(md).not.toContain('cites:');
  });
});

// --- degrade-safety -------------------------------------------------------

describe('parsePage — degrade-safe', () => {
  it('never throws on malformed YAML and keeps the body intact', () => {
    const raw = ['---', '\tthis: [is: not', '  valid- yaml', '---', '## Summary', 'body text'].join('\n');

    const p = parsePage(raw);
    expect(p.body).toBe('## Summary\nbody text');
    expect(p.frontmatter.title).toBe('');
    expect(p.frontmatter.aliases).toEqual([]);
  });

  it('returns a minimal spine and the whole input as body when there is no frontmatter block', () => {
    const p = parsePage('# Just markdown\nno fences here');
    expect(p.body).toBe('# Just markdown\nno fences here');
    expect(p.frontmatter.title).toBe('');
    expect(p.frontmatter.type).toBe('concept');
  });

  it('degrades a scalar frontmatter block to the minimal spine', () => {
    const p = parsePage('---\njust a bare string\n---\nbody');
    expect(p.frontmatter.title).toBe('');
    expect(p.body).toBe('body');
  });
});

// --- the aliases still serve their call sites -----------------------------

describe('parseArticle / serializeArticle aliases', () => {
  it('round-trips a full WikiArticle unchanged', () => {
    const article: WikiArticle = {
      slug: 'sahil-verma',
      frontmatter: {
        title: 'Sahil Verma',
        type: 'person',
        created: '2026-06-01',
        updated: '2026-06-10',
        aliases: ['Sahil', 'S. Verma'],
        related: ['acme-inc'],
        sources: 3,
        confidence: 'medium',
        userEdited: false,
        sourceClaimIds: ['c1:0.8'],
      },
      body: '## Summary\nSahil leads [[acme-inc]]. [s1]',
    };
    expect(parseArticle(serializeArticle(article), 'sahil-verma')).toEqual(article);
  });

  it('keeps an unknown key on a WikiArticle round-trip', () => {
    const article: WikiArticle = {
      slug: 'sahil-verma',
      frontmatter: { ...page(), created: '', related: [], sources: 0, confidence: 'low', userEdited: false, relation: 'co-founder' },
      body: 'body',
    };
    expect(parseArticle(serializeArticle(article), 'sahil-verma').frontmatter.relation).toBe('co-founder');
  });
});
