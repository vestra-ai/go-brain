import { describe, it, expect, vi } from 'vitest';
import {
  slugify,
  parseArticle,
  serializeArticle,
  extractWikilinks,
  scanWikilinkMarkers,
  deriveBacklinks,
  selectSalientSubjects,
  buildIndex,
  wikiSlugResolver,
  slugBasename,
  synthesizeWiki,
  selectDirtySubjects,
  pruneOrphanArticles,
  validateGrounding,
  type WikiArticle,
  type WikiFrontmatter,
  type WikiSynthesizer,
  type WikiIndex,
  type Backlinks,
} from '../wiki.js';
import { buildWikiGraph } from '../wiki-graph.js';
import type { Claim } from '../claims.js';

// --- fixtures -------------------------------------------------------------

let idCounter = 0;
const claim = (
  subject: string,
  predicate: string,
  object: string,
  opts: Partial<Claim> = {},
): Claim => ({
  id: `clm_${idCounter++}`,
  subject,
  predicate,
  object,
  sources: [{ kind: 'task', ref: 't1', date: '2026-06-01' }],
  validFrom: '2026-06-01',
  validTo: null,
  observedAt: '2026-06-01',
  supersededBy: null,
  confidence: 0.8,
  decay: 'semi-stable',
  ...opts,
});

const fm = (over: Partial<WikiFrontmatter> = {}): WikiFrontmatter => ({
  title: 'Sahil Verma',
  type: 'person',
  created: '2026-06-01',
  updated: '2026-06-01',
  aliases: [],
  related: [],
  sources: 1,
  confidence: 'high',
  userEdited: false,
  sourceClaimIds: [],
  ...over,
});

// A legacy / pre-provenance frontmatter: the `sourceClaimIds` key is OMITTED entirely
// (the on-disk shape of an article written before provenance existed), so the field is
// genuinely absent (undefined) rather than an explicit empty set.
const fmNoProvenance = (over: Partial<WikiFrontmatter> = {}): WikiFrontmatter => {
  const { sourceClaimIds: _drop, ...rest } = fm(over);
  return rest;
};

// --- slugify --------------------------------------------------------------

describe('slugify', () => {
  it('lowercases, trims and dashes spaces', () => {
    expect(slugify('Sahil Verma')).toBe('sahil-verma');
    expect(slugify('  The User  ')).toBe('the-user');
  });

  it('strips unsafe characters and collapses dashes', () => {
    expect(slugify('Acme, Inc. (US)!')).toBe('acme-inc-us');
    expect(slugify('a/b\\c')).toBe('a-b-c');
  });

  it('is idempotent', () => {
    const once = slugify('Sahil Verma & Co.');
    expect(slugify(once)).toBe(once);
  });

  it('never produces empty for unicode-only input', () => {
    expect(slugify('!!!')).not.toBe('');
  });
});

// --- parse / serialize round-trip ----------------------------------------

describe('parseArticle / serializeArticle', () => {
  it('round-trips frontmatter + body', () => {
    const article: WikiArticle = {
      slug: 'sahil-verma',
      frontmatter: fm({
        aliases: ['Sahil', 'S. Verma'],
        related: ['acme-inc', 'project-atlas'],
        sources: 3,
        confidence: 'medium',
        updated: '2026-06-10',
      }),
      body: '## Summary\nSahil leads [[acme-inc]]. [s1]\n\n## Sources\n- s1: works at Acme (task t1 2026-06-01)',
    };
    const md = serializeArticle(article);
    const back = parseArticle(md, 'sahil-verma');
    expect(back).toEqual(article);
  });

  it('parses with a defaulted/missing frontmatter degrading safely', () => {
    const md = '---\ntitle: Loose\n---\n## Summary\nbody';
    const a = parseArticle(md, 'loose');
    expect(a.frontmatter.title).toBe('Loose');
    expect(a.frontmatter.aliases).toEqual([]);
    expect(a.frontmatter.related).toEqual([]);
    expect(a.frontmatter.userEdited).toBe(false);
    expect(a.body).toContain('## Summary');
  });

  it('reads userEdited:true', () => {
    const md = '---\ntitle: T\ntype: person\nuserEdited: true\n---\nbody';
    expect(parseArticle(md, 't').frontmatter.userEdited).toBe(true);
  });

  it('parses list frontmatter in [a, b] inline form', () => {
    const md = '---\ntitle: T\naliases: [Sahil, S. Verma]\n---\nbody';
    expect(parseArticle(md, 't').frontmatter.aliases).toEqual(['Sahil', 'S. Verma']);
  });
});

// --- wikilinks ------------------------------------------------------------

describe('extractWikilinks', () => {
  it('extracts plain and labelled wikilinks', () => {
    const body = 'See [[acme-inc]] and [[project-atlas|Atlas]] and [[acme-inc]] again.';
    expect(extractWikilinks(body)).toEqual(['acme-inc', 'project-atlas']);
  });

  it('returns [] when there are no links', () => {
    expect(extractWikilinks('no links here [s1]')).toEqual([]);
  });
});

// --- wikilinks: equivalence pins for the single-pass scan -----------------
//
// Extraction used to be `/\[\[([^\]]+?)\]\]/g`, which is O(bytes²) on a body carrying
// many `[[` that never close: the engine retries from every `[[` and the lazy class
// walks to the end of the body each time. 1 MiB of `[` measured at 503 SECONDS for a
// single page — the reconciler's whole 10-minute deadline, where an abort discards the
// pass — and page bodies can be outsider-influenced. Every literal below was captured
// from that regex and committed green against it, so the scan replacing it is provably
// a pure performance change.

/**
 * Verbatim copy of the pre-scan regex extraction. It is the oracle for the generated
 * battery below and the yardstick that keeps the equivalence honest: the pins are what
 * THIS function returns, not a description of the code that replaced it.
 */
const REFERENCE_WIKILINK_RE = /\[\[([^\]]+?)\]\]/g;
const referenceExtractWikilinks = (body: string): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  REFERENCE_WIKILINK_RE.lastIndex = 0;
  while ((m = REFERENCE_WIKILINK_RE.exec(body)) !== null) {
    const target = m[1].split('|')[0].trim();
    if (!target || seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
};

// Shape by shape, what the regex returned. The sharp ones are called out below the table:
// a match is LEFTMOST-then-CONSUMING, its content may hold no `]`, and it needs at least
// one character — three rules that between them decide every degenerate case here.
const MARKER_SHAPES: ReadonlyArray<readonly [string, string, string[]]> = [
  // The content class `[^\]]+?` needs ≥ 1 char, so an empty marker is not a marker, and a
  // whitespace-only one trims away to nothing and is dropped by the `!target` guard.
  ['an empty marker is not a link', '[[]]', []],
  ['a whitespace-only marker is dropped', '[[ ]]', []],
  ['an empty target before a pipe is dropped', '[[|label]]', []],
  ['a pipe-only marker is dropped', '[[|]]', []],
  ['a pipe padded by spaces is still an empty target', '[[ | ]]', []],
  // The content may hold no `]`, so the closer is always the FIRST `]` at or after the
  // opener — a single `]` in between kills the match outright rather than being skipped.
  ['a lone ] inside the marker kills it', '[[a]b]]', []],
  ['openers that never close yield nothing', '[[[[[[', []],
  ['an unterminated [[ at EOF is ignored, earlier links are not', 'See [[acme-inc]] then [[dangling', ['acme-inc']],
  // Leftmost-then-consuming: the outer unclosed `[[` wins the start position and swallows
  // the inner marker, and the scan resumes AFTER the closer it consumed.
  ['an unclosed opener swallows the marker nested in it', '[[a[[b]]', ['a[[b']],
  ['a consumed marker hides the one nested inside it', '[[note [[acme-inc]] tail]]', ['note [[acme-inc']],
  ['a third [ belongs to the target, not the opener', '[[[a]]]', ['[a']],
  ['a trailing third ] is left over', '[[a]]]', ['a']],
  ['a stray ]] before the marker is skipped', ']][[a]]', ['a']],
  ['adjacent markers both parse', '[[a]][[b]]', ['a', 'b']],
  // Target extraction: split on the first pipe, then trim.
  ['a label is split off at the pipe', '[[project-atlas|Atlas]]', ['project-atlas']],
  ['only the first pipe splits', '[[a|b|c]]', ['a']],
  ['a padded target is trimmed', '[[  acme-inc  ]]', ['acme-inc']],
  ['a space before the pipe is trimmed too', '[[foo | label]]', ['foo']],
  ['a newline inside the marker is kept in the target', '[[a\nb]]', ['a\nb']],
  // Markdown's own link syntax never produces `[[`, which is why bracket soup is a
  // hardening case rather than a live one.
  ['a markdown link is not a wikilink', 'a [text](url) and [s1] here', []],
  // The scan walks UTF-16 code units by hand where the regex let the engine do it, so
  // CJK and surrogate pairs have to come back byte-identical.
  ['CJK and emoji targets survive', 'see [[茶 shop]] and [[🙂 note|smile]] ok', ['茶 shop', '🙂 note']],
  ['a surrogate pair is never split', '[[🙂]] and [[a🙂b|x]]', ['🙂', 'a🙂b']],
  // A LONE high or low surrogate is a legal UTF-16 code unit and a legal target character.
  // It is not whitespace, so it survives the trim — the scan must carry it through
  // untouched rather than normalising or dropping it.
  ['a lone unpaired surrogate is carried through', '[[\uD83D]] then [[🙂]]', ['\uD83D', '🙂']],
  ['unpaired surrogates inside targets survive', 'a [[\uD83Db\uDE42]] and [[x\uD83D]] end', ['\uD83Db\uDE42', 'x\uD83D']],
  ['repeats are de-duplicated in first-seen order', '[[z]] [[a]] [[z]] [[a|lbl]]', ['z', 'a']],
];

describe('extractWikilinks — marker bytes', () => {
  for (const [label, body, targets] of MARKER_SHAPES) {
    it(label, () => {
      expect(extractWikilinks(body)).toEqual(targets);
    });
  }

  it('returns exactly what the pre-scan regex returned on every shape above', () => {
    // The table is only a pin if its literals really are the old function's output.
    for (const [label, body, targets] of MARKER_SHAPES) {
      expect({ label, out: referenceExtractWikilinks(body) }).toEqual({ label, out: targets });
    }
  });
});

// --- backlinks ------------------------------------------------------------

describe('deriveBacklinks', () => {
  it('maps targets to the pages that link them with excerpts', () => {
    const pages: WikiArticle[] = [
      { slug: 'sahil-verma', frontmatter: fm({ title: 'Sahil Verma' }), body: 'Sahil leads [[acme-inc]] day to day.' },
      { slug: 'priya', frontmatter: fm({ title: 'Priya' }), body: 'Priya also advises [[acme-inc|Acme]].' },
    ];
    const bl = deriveBacklinks(pages);
    expect(bl['acme-inc']).toHaveLength(2);
    expect(bl['acme-inc'].map((b) => b.from).sort()).toEqual(['priya', 'sahil-verma']);
    expect(bl['acme-inc'][0].title).toBeTruthy();
    expect(bl['acme-inc'][0].excerpt).toContain('acme');
  });

  it('does not create a self-backlink', () => {
    const pages: WikiArticle[] = [
      { slug: 'acme-inc', frontmatter: fm({ title: 'Acme' }), body: 'Acme links to itself [[acme-inc]].' },
    ];
    expect(deriveBacklinks(pages)['acme-inc']).toBeUndefined();
  });

  it('keys the reverse index by the slugified target, not the raw Title-case target', () => {
    const pages: WikiArticle[] = [
      { slug: 'sahil', frontmatter: fm({ title: 'Sahil' }), body: 'Sahil pushed [[Cached-tokens|cache reads]] up.' },
    ];
    const bl = deriveBacklinks(pages);
    expect(bl['cached-tokens']).toHaveLength(1);
    expect(bl['Cached-tokens']).toBeUndefined();
    // excerpt still searches the body for the RAW target
    expect(bl['cached-tokens'][0].excerpt.toLowerCase()).toContain('cached-tokens');
  });

  it('skips a self-link even when the target is Title-case', () => {
    const pages: WikiArticle[] = [
      { slug: 'cached-tokens', frontmatter: fm({ title: 'Cached Tokens' }), body: 'See [[Cached-tokens]] again.' },
    ];
    expect(deriveBacklinks(pages)['cached-tokens']).toBeUndefined();
  });

  it('skips a FILED page’s self-link, however the page spells its own name', () => {
    // The guard compared `slugify(target)` — a flattening — to `page.slug`, a typed
    // path. On a filed brain the two alphabets never meet, so every page that named
    // itself recorded itself among the things that point AT it. Resolution is what
    // decides whether a target is this page, exactly as it does for the graph.
    const pages: WikiArticle[] = [
      {
        slug: 'entities/people/zaf',
        frontmatter: fm({ title: 'Zaf' }),
        body: 'Zaf, [[zaf]], of [[entities/people/zaf]] and [[entities-people-zaf]], hired by [[keshav-musunuri]].',
      },
      { slug: 'entities/people/keshav-musunuri', frontmatter: fm({ title: 'Keshav' }), body: 'The founder.' },
    ];
    const bl = deriveBacklinks(pages);

    // All three spellings of its own name are the same page: none of them is a link.
    expect(bl['zaf']).toBeUndefined();
    expect(bl['entities-people-zaf']).toBeUndefined();
    // …and a link to somebody ELSE still lands, by the key the reader looks up.
    expect(bl['keshav-musunuri']?.map((b) => b.from)).toEqual(['entities/people/zaf']);
  });

  it('a target that names a DIFFERENT page is a link, even from a page of the same stem', () => {
    // The mirror of the rule above: resolution answers the FIRST page a stem names,
    // so a second page wearing that stem is linking its namesake, not itself.
    const pages: WikiArticle[] = [
      { slug: 'entities/people/vestra', frontmatter: fm({ title: 'Vestra Ray' }), body: 'The person.' },
      { slug: 'entities/companies/vestra', frontmatter: fm({ title: 'Vestra' }), body: 'Founded by [[vestra]].' },
    ];
    expect(deriveBacklinks(pages)['vestra']?.map((b) => b.from)).toEqual(['entities/companies/vestra']);
  });
});

// --- backlinks: equivalence pins for the single-pass derivation -----------
//
// Derivation used to re-scan the whole body once per link (`body.search(…)` per
// target). These pin the EXACT excerpt bytes it produced, so the single-pass rewrite
// is provably a pure performance change: every literal below was captured from the
// pre-refactor implementation and committed green against it.

const linkPage = (slug: string, body: string): WikiArticle => ({ slug, frontmatter: fm({ title: slug }), body });

const excerptFor = (target: string, body: string): string => deriveBacklinks([linkPage('src', body)])[target][0].excerpt;

describe('deriveBacklinks — excerpt bytes', () => {
  it('cuts 60 chars before and 80 after the link, with ellipses on both cut ends', () => {
    expect(
      excerptFor(
        'acme-inc',
        'The quarterly review ran long and the numbers were flat, so the whole team met to discuss [[acme-inc]] and what that means for the roadmap in the second half of the year.',
      ),
    ).toBe(
      '…and the numbers were flat, so the whole team met to discuss [[acme-inc]] and what that means for the roadmap in the second half of the year.',
    );
  });

  it('drops the leading ellipsis at the head of the body and the trailing one at its end', () => {
    expect(
      excerptFor(
        'acme-inc',
        '[[acme-inc]] opens the page and the rest of this sentence is only here to make the body longer than the excerpt window so the trailing ellipsis appears.',
      ),
    ).toBe('[[acme-inc]] opens the page and the rest of this sentence is only here to make t…');

    expect(
      excerptFor(
        'acme-inc',
        'This body runs on for a while before it finally gets around to naming the target, which it does right at the very end: [[acme-inc]]',
      ),
    ).toBe('…to naming the target, which it does right at the very end: [[acme-inc]]');
  });

  it('de-duplicates a repeated target and cuts around its FIRST occurrence', () => {
    const bl = deriveBacklinks([
      linkPage(
        'src',
        'First mention of [[acme-inc]] happens up here near the very top of the page body, and a second mention of [[acme-inc]] happens much later on, far away from the first one.',
      ),
    ]);
    expect(bl['acme-inc']).toHaveLength(1);
    expect(bl['acme-inc'][0].excerpt).toBe(
      'First mention of [[acme-inc]] happens up here near the very top of the page body, and a second me…',
    );
  });

  it('cuts around the whole [[target|label]] marker, not just the target', () => {
    expect(
      excerptFor(
        'cached-tokens',
        'Sahil pushed the number up over the quarter, mostly by leaning on [[cached-tokens|cache reads]] instead of re-sending the whole prompt on every single turn.',
      ),
    ).toBe(
      '…pushed the number up over the quarter, mostly by leaning on [[cached-tokens|cache reads]] instead of re-sending the whole prompt on every si…',
    );
  });

  it('treats links inside a code fence and inline code as ordinary links', () => {
    const bl = deriveBacklinks([
      linkPage(
        'src',
        'Prose first.\n\n```md\nA fenced block that still links [[acme-inc]] inside it.\n```\n\nAnd inline code `[[project-atlas]]` too, which today is not treated specially.',
      ),
    ]);
    expect(bl['acme-inc'][0].excerpt).toBe(
      'Prose first. ```md A fenced block that still links [[acme-inc]] inside it. ``` And inline code `[[project-atlas]]` too, which toda…',
    );
    expect(bl['project-atlas'][0].excerpt).toBe(
      '…t still links [[acme-inc]] inside it. ``` And inline code `[[project-atlas]]` too, which today is not treated specially.',
    );
  });

  it('collapses runs of whitespace inside the window and trims the ends', () => {
    expect(
      excerptFor(
        'acme-inc',
        'Whitespace\n\n\tcollapses   around   [[acme-inc]]\n\nin   the\texcerpt window and the result is trimmed at both ends of the slice.',
      ),
    ).toBe('Whitespace collapses around [[acme-inc]] in the excerpt window and the result is trimmed at both ends of…');
  });

  it('matches a target holding regex metacharacters literally', () => {
    expect(
      excerptFor(
        'c-v2',
        'The team argued about [[C++ (v2)|the rewrite]] for most of the afternoon and then went home without deciding anything at all about it.',
      ),
    ).toBe('The team argued about [[C++ (v2)|the rewrite]] for most of the afternoon and then went home without de…');
  });

  // The next three pin behaviours a naive "reuse the extractWikilinks match index"
  // rewrite would silently change. The target is TRIMMED out of the marker, so a padded
  // marker is not the literal the excerpt looks for.

  it('falls back to the first 120 chars when only a whitespace-padded marker exists', () => {
    expect(
      excerptFor(
        'acme-inc',
        'A [[ acme-inc ]] padded target means the excerpt falls back to the first one hundred and twenty characters of the body, trimmed, which is what this long sentence exists to pin down exactly.',
      ),
    ).toBe('A [[ acme-inc ]] padded target means the excerpt falls back to the first one hundred and twenty characters of the body,');
  });

  it('skips a padded marker in favour of a LATER exact one', () => {
    expect(
      excerptFor(
        'acme-inc',
        'A padded [[ acme-inc ]] comes first here, and then a long stretch of filler text runs on before the exact form [[acme-inc]] finally shows up much later in the body.',
      ),
    ).toBe('…a long stretch of filler text runs on before the exact form [[acme-inc]] finally shows up much later in the body.');
  });

  it('finds an exact marker nested inside an earlier unclosed one', () => {
    const bl = deriveBacklinks([
      linkPage(
        'src',
        'An unclosed [[opener swallows a nested [[acme-inc]] here, and a plain [[acme-inc]] appears again much later in the body after a good deal of filler prose.',
      ),
    ]);
    // The nested `[[acme-inc]]` sits at index 39, the plain one much later: the window
    // is cut around the NESTED one, which no consuming left-to-right scan reports.
    expect(bl['acme-inc'][0].excerpt).toBe(
      'An unclosed [[opener swallows a nested [[acme-inc]] here, and a plain [[acme-inc]] appears again much later in the body…',
    );
    expect(bl['opener-swallows-a-nested-acme-inc'][0].excerpt).toBe(
      'An unclosed [[opener swallows a nested [[acme-inc]] here, and a plain [[acme-inc]] appears a…',
    );
  });

  it('keeps page order and first-seen target order', () => {
    const bl = deriveBacklinks([
      linkPage('a', 'Page A links [[zeta]] then [[alpha]] then [[zeta]] again.'),
      linkPage('b', 'Page B links [[alpha]] only.'),
    ]);
    expect(Object.keys(bl)).toEqual(['zeta', 'alpha']);
    expect(bl['alpha'].map((b) => b.from)).toEqual(['a', 'b']);
    expect(bl['zeta']).toHaveLength(1);
  });
});

// --- backlinks: differential oracle + the counted-scan pin ----------------
//
// `referenceDeriveBacklinks` is a verbatim copy of the pre-refactor derivation: a fresh
// whole-body `search` per link. It is the oracle for the generated bodies below and the
// yardstick that keeps the scan-count pin honest — it is the code that scans per link,
// so the assertion that it makes N searches while the shipped function makes zero cannot
// pass vacuously. It pairs with `referenceExtractWikilinks` rather than the shipped
// extraction, so the oracle is the WHOLE pre-scan pipeline and cannot drift when the
// extraction underneath it is rewritten.

const referenceExcerptAround = (body: string, target: string): string => {
  const re = new RegExp(`\\[\\[${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\|[^\\]]*)?\\]\\]`);
  const idx = body.search(re);
  if (idx === -1) return body.slice(0, 120).trim();
  const start = Math.max(0, idx - 60);
  const end = Math.min(body.length, idx + 80);
  return `${start > 0 ? '…' : ''}${body.slice(start, end).replace(/\s+/g, ' ').trim()}${end < body.length ? '…' : ''}`;
};

const referenceDeriveBacklinks = (pages: WikiArticle[]): Backlinks => {
  const out: Backlinks = {};
  for (const page of pages) {
    for (const target of referenceExtractWikilinks(page.body)) {
      const key = slugify(target);
      if (key === page.slug) continue;
      (out[key] ??= []).push({
        from: page.slug,
        title: page.frontmatter.title,
        excerpt: referenceExcerptAround(page.body, target),
      });
    }
  }
  return out;
};

/** Deterministic PRNG so the generated battery is reproducible in CI. */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** A body of prose salted with well-formed, padded, labelled and malformed markers. */
const generatedBody = (rand: () => number): string => {
  const targets = ['acme-inc', 'priya', 'C++ (v2)', 'a', 'cached-tokens', '茶 shop', '🙂 note'];
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const pieces = [
    // Surrogate pairs and CJK are in the mix on purpose: the scan walks UTF-16 code
    // units by hand where the old derivation let a regex do it, so the excerpt window
    // has to land on the same units it used to.
    () => ` ${pick(['team', 'ran', 'the quarter', 'notes', 'x', '茶を飲む', '🙂🙂 ok', 'café'])} `,
    () => `[[${pick(targets)}]]`,
    () => `[[${pick(targets)}|${pick(['label', 'a b', ''])}]]`,
    () => `[[ ${pick(targets)} ]]`,
    () => `[[${pick(targets)} | ${pick(['label', 'x'])}]]`,
    () => '[[',
    () => ']]',
    () => ']',
    () => '|',
    () => '\n\n',
    () => '`code`',
  ];
  let body = '';
  const n = 3 + Math.floor(rand() * 25);
  for (let i = 0; i < n; i++) body += pick(pieces)();
  return body;
};

/**
 * Bracket soup: nothing but the characters the scan makes decisions on, in the
 * proportions that break naive rewrites — runs of `[`, lone `]`, `]]`, pipes, and the
 * odd real target. Prose never looks like this; a hostile or mangled page does.
 */
const generatedSoup = (rand: () => number): string => {
  const pieces = ['[', '[[', '[[[', ']', ']]', ']]]', '|', '||', ' ', '\n', 'acme-inc', '茶', '🙂', 'a'];
  let body = '';
  const n = 2 + Math.floor(rand() * 40);
  for (let i = 0; i < n; i++) body += pieces[Math.floor(rand() * pieces.length)];
  return body;
};

describe('extractWikilinks — matches the pre-scan regex', () => {
  it('is byte-identical over 4000 generated bodies, prose and bracket soup alike', () => {
    const rand = seeded(20260830);
    let extracted = 0;
    for (let i = 0; i < 2000; i++) {
      for (const body of [generatedBody(rand), generatedSoup(rand)]) {
        const expected = referenceExtractWikilinks(body);
        expect({ body, out: extractWikilinks(body) }).toEqual({ body, out: expected });
        extracted += expected.length;
      }
    }
    // The battery has to actually extract links, or it compares empty arrays forever.
    expect(extracted).toBeGreaterThan(2000);
  });
});

describe('extractWikilinks — bracket soup does not blow up', () => {
  /** Regex executions over the body — the engine the quadratic lived inside, metered. */
  const execCallsDuring = (run: () => void): number => {
    const spy = vi.spyOn(RegExp.prototype, 'exec');
    try {
      run();
      return spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
  };

  // What this pin does and does not say: it says NO REGEX ENGINE TOUCHES THE BODY, which
  // is what killed the specific quadratic here (the old pattern spent O(bytes²) inside a
  // single failing `exec`). It does NOT say the scan is linear — a scan that calls no
  // regex can still be quadratic through another primitive. The scan-work pin below is
  // what carries the linearity claim.
  it('hands the body to no regex at all, where the old pattern ran one per link', () => {
    const page = `${'lorem ipsum dolor sit amet consectetur adipiscing elit. '.repeat(200)}[[acme-inc]] and [[priya|P]] and [[acme-inc]] again.`;
    let mine: string[] = [];
    let theirs: string[] = [];
    expect(execCallsDuring(() => void (mine = extractWikilinks(page)))).toBe(0);
    // The yardstick: same page, same answer, one execution per match plus the closing
    // null — so zero-versus-N cannot pass by the function doing nothing.
    expect(execCallsDuring(() => void (theirs = referenceExtractWikilinks(page)))).toBe(4);
    expect(mine).toEqual(theirs);
    expect(mine).toEqual(['acme-inc', 'priya']);
  });

  // The wall-clock ceiling. Bounded on purpose: 64 KiB with a 2-second ceiling, never the
  // megabyte that measured 503 s. Note what this leg does and does not prove — 64 KiB
  // costs the old pattern ~1.2 s on an idle machine (~9.6 s on a loaded one), so it sits
  // UNDER this ceiling when nothing else is running, and a quadratic scan clears it with
  // 5x headroom. It is a coarse regression guard; the scan-work pin below is the proof.
  it('scans 64 KiB of unclosed [[ well inside two seconds', () => {
    const soup = '[['.repeat(32 * 1024);
    expect(soup.length).toBe(64 * 1024);
    expect(extractWikilinks(soup)).toEqual([]);

    // …and the same body with a closer still returns the leftmost consuming match, so
    // the pin is about cost, not about a scan that gave up early.
    expect(extractWikilinks(`${soup}acme-inc]] tail`)).toEqual([`${'['.repeat(64 * 1024 - 2)}acme-inc`]);
  }, 2000);
});

// --- the single-pass pin ---------------------------------------------------
//
// The pins above bound the REGEX ENGINE and the COPYING. Neither bounds the SCANNING, and
// a scan can be quadratic in scanning alone: drop the `closeIdx` cursor cache or the
// `closeIdx === -1` early return from the shipped loop — either one, both reading like dead
// cleverness — and the result still emits identical output, still calls no regex, still
// copies exactly the same characters, and still finishes 64 KiB inside the 2-second
// ceiling with 5x headroom. It is also Theta(bytes²): 8 KiB 1.4 ms, 16 KiB 5 ms,
// 32 KiB 151 ms, 64 KiB 386 ms. The un-cached variant is kept below as the yardstick, so
// these pins fail against the regression they are written for rather than describing the code.
//
// TWO bodies, because the two lines are load-bearing on DIFFERENT shapes and each body is
// blind to the other's mutation:
//   - a body with no `]` at all exits at the early return, so deleting the CACHE costs
//     nothing there — that body pins the early return;
//   - a body with a distant non-closing `]` never reaches the early return, so deleting the
//     EARLY RETURN costs nothing there — that body pins the cache.
// Deleting either line alone is a one-line edit, likelier than deleting both, so neither
// body is redundant. Keep them together.

describe('extractWikilinks — one pass, whatever the [[ count', () => {
  /**
   * Characters the body is WALKED PAST, metered on `indexOf` — the primitive the loop
   * cannot avoid. `slice` meters what is copied; this meters what is looked at, which is
   * where a scan goes quadratic without copying or matching anything extra.
   */
  const scanCharsDuring = (run: () => void): number => {
    const original = String.prototype.indexOf;
    let chars = 0;
    const spy = vi
      .spyOn(String.prototype, 'indexOf')
      .mockImplementation(function (this: string, search: string, position?: number): number {
        const at = original.call(this, search, position);
        chars += (at === -1 ? this.length : at) - (position ?? 0);
        return at;
      });
    try {
      run();
      return chars;
    } finally {
      spy.mockRestore();
    }
  };

  /** The shipped scan with the cursor cache and the early return removed — the yardstick. */
  const uncachedScan = (body: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    let i = 0;
    while (i < body.length) {
      const open = body.indexOf('[[', i);
      if (open === -1) break;
      const from = open + 2;
      const closeIdx = body.indexOf(']', from);
      if (closeIdx > from && body.charCodeAt(closeIdx + 1) === 0x5d) {
        const target = body.slice(from, closeIdx).split('|')[0].trim();
        if (target && !seen.has(target)) {
          seen.add(target);
          out.push(target);
        }
        i = closeIdx + 2;
      } else {
        i = open + 1;
      }
    }
    return out;
  };

  const openSoup = '[['.repeat(32 * 1024); // 64 KiB, not one `]` in it
  const closerSoup = `${'[['.repeat(32 * 1024)} dead] [[ok]] `; // …and 64 KiB with a distant one

  /** Same budget both times; only the body — and so the mutation caught — differs. */
  const walkedWithinBudget = (body: string): string[] => {
    let mine: string[] = [];
    let theirs: string[] = [];
    const mineChars = scanCharsDuring(() => void (mine = extractWikilinks(body)));
    const theirsChars = scanCharsDuring(() => void (theirs = uncachedScan(body)));

    expect(mine).toEqual(theirs); // same answer: the budget constrains HOW, not what
    expect(mineChars).toBeGreaterThan(0);
    expect(mineChars).toBeLessThanOrEqual(body.length * 2);
    expect(theirsChars).toBeGreaterThan(body.length * 1000);
    return mine;
  };

  it('walks 64 KiB of unclosed [[ once — the leg that catches a deleted early return', () => {
    // shipped 65,534 = 1.00x · un-cached 2,147,385,346 = 32,767x
    expect(walkedWithinBudget(openSoup)).toEqual([]);
  });

  it('walks 64 KiB of unclosed [[ before a stray ] once — the leg that catches a deleted cache', () => {
    // shipped 65,550 = 1.00x · un-cached 2,147,713,031 = 32,764x. Here the loop reaches the
    // cache (there IS a `]`), and both sides return a real target, so the equality above
    // compares `['ok']` to `['ok']` rather than the empty-to-empty of the leg before it.
    expect(walkedWithinBudget(closerSoup)).toEqual(['ok']);
  });

  it('walks the body about once whether the page carries one marker or thousands', () => {
    // The brief's item 3, literally: single pass REGARDLESS OF `[[` COUNT. Same body size,
    // three orders of magnitude apart in marker count, same budget.
    //
    // Documentation of the property, NOT a regression guard: both bodies here are
    // well-formed, so no mutation of the two linearity lines is quadratic on them and every
    // one of them passes this leg. The two soup legs above are the ones with teeth.
    const size = 64 * 1024;
    const sparse = `${'x'.repeat(size - 7)}[[a]] `;
    let dense = '';
    for (let n = 0; dense.length < size; n++) dense += `[[t-${n}]] `;
    dense = dense.slice(0, size);

    let sparseTargets: string[] = [];
    let denseTargets: string[] = [];
    const sparseChars = scanCharsDuring(() => void (sparseTargets = extractWikilinks(sparse)));
    const denseChars = scanCharsDuring(() => void (denseTargets = extractWikilinks(dense)));

    expect(sparseTargets).toHaveLength(1); // not vacuous: both really extracted
    expect(denseTargets.length).toBeGreaterThan(5000);
    expect(sparseChars).toBeLessThanOrEqual(sparse.length * 2); // measured 1.00x
    expect(denseChars).toBeLessThanOrEqual(dense.length * 2); // measured 0.63x
  });
});

/**
 * Characters copied out of a body by `slice` while `run` executes — candidate
 * materialization, metered. Counting COPIES rather than calls is what makes this a cost
 * pin: a rewrite that walks the body once but materializes a candidate per opener is
 * still linear in calls and quadratic in bytes moved.
 */
const sliceCharsDuring = (run: () => void): number => {
  const original = String.prototype.slice;
  let chars = 0;
  const spy = vi
    .spyOn(String.prototype, 'slice')
    .mockImplementation(function (this: string, start?: number, end?: number): string {
      const out = original.call(this, start, end);
      chars += out.length;
      return out;
    });
  try {
    run();
    return chars;
  } finally {
    spy.mockRestore();
  }
};

describe('extractWikilinks — the scan copies no more than the page', () => {
  /**
   * The regression this pin exists for: a rewrite that is linear in SCANNING but
   * materializes a candidate at every opener instead of only at a real match. Same
   * answer, and still quadratic in copying on a `[`-run page.
   */
  const perOpenerCandidates = (body: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    let i = 0;
    while (i < body.length) {
      const open = body.indexOf('[[', i);
      if (open === -1) break;
      const close = body.indexOf(']', open + 2);
      if (close === -1) break;
      const candidate = body.slice(open + 2, close);
      if (close > open + 2 && body.charCodeAt(close + 1) === 0x5d) {
        const target = candidate.split('|')[0].trim();
        if (target && !seen.has(target)) {
          seen.add(target);
          out.push(target);
        }
        i = close + 2;
      } else {
        i = open + 1;
      }
    }
    return out;
  };

  // `[`-runs whose first `]` is NOT a closer: every opener in the run is visited and
  // fails, which is exactly where per-opener copying goes quadratic. Real markers are
  // interleaved so the extraction still has work to do.
  let soup = '';
  for (let i = 0; i < 200; i++) soup += `${'[['.repeat(64)} dead] [[target-${i}]] `;

  it('copies at most one page-worth of characters, however many [[ the page holds', () => {
    let targets: string[] = [];
    const chars = sliceCharsDuring(() => void (targets = extractWikilinks(soup)));
    // Matches consume disjoint regions, so the copies cannot add up past the body.
    expect(targets).toHaveLength(200);
    expect(chars).toBeGreaterThan(0);
    expect(chars).toBeLessThanOrEqual(soup.length);
  });

  it('costs a per-opener rewrite an order of magnitude more copying for the same answer', () => {
    // The yardstick: identical output, so the budget above is a real constraint on HOW
    // the answer is reached rather than a restatement of what it is.
    expect(perOpenerCandidates(soup)).toEqual(extractWikilinks(soup));
    const mine = sliceCharsDuring(() => void extractWikilinks(soup));
    const theirs = sliceCharsDuring(() => void perOpenerCandidates(soup));
    expect(theirs).toBeGreaterThan(soup.length * 10);
    expect(mine).toBeLessThan(theirs / 10);
  });
});

describe('deriveBacklinks — matches the pre-refactor derivation', () => {
  it('is byte-identical to the per-link search over 400 generated bodies', () => {
    const rand = seeded(20260829);
    let entries = 0;
    for (let i = 0; i < 400; i++) {
      const pages = [linkPage(`p${i}`, generatedBody(rand)), linkPage(`q${i}`, generatedBody(rand))];
      const expected = referenceDeriveBacklinks(pages);
      // Carry the bodies into the assertion: a bare `toEqual` in a loop reports a diff
      // with no iteration index and no input, and the generator is seeded, so naming the
      // failing pair is the difference between a reproduction and an afternoon.
      const bodies = pages.map((p) => p.body);
      expect({ i, bodies, out: deriveBacklinks(pages) }).toEqual({ i, bodies, out: expected });
      entries += Object.values(expected).reduce((n, list) => n + list.length, 0);
    }
    // The battery has to actually produce backlinks, or the comparison pins nothing.
    expect(entries).toBeGreaterThan(400);
  });
});

describe('deriveBacklinks — scan count does not grow with links', () => {
  const searchCallsDuring = (run: () => void): number => {
    const spy = vi.spyOn(String.prototype, 'search');
    try {
      run();
      return spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
  };

  /** ~`bytes` of filler with `links` distinct markers spread evenly through it. */
  const bigBody = (links: number, bytes: number): string => {
    const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore. ';
    const gap = Math.max(1, Math.floor(bytes / links));
    let body = '';
    for (let i = 0; i < links; i++) {
      body += filler.repeat(Math.ceil(gap / filler.length)).slice(0, gap);
      body += `[[target-${i}]] `;
    }
    return body;
  };

  it('derives a 1 MiB / 2000-link page without a single whole-body re-search', () => {
    const body = bigBody(2000, 1024 * 1024);
    expect(body.length).toBeGreaterThan(1024 * 1024);

    let bl: Backlinks = {};
    expect(searchCallsDuring(() => void (bl = deriveBacklinks([linkPage('src', body)])))).toBe(0);

    // …and it really did the work: every target resolved, with a real excerpt.
    expect(Object.keys(bl)).toHaveLength(2000);
    expect(bl['target-1999'][0].excerpt).toContain('[[target-1999]]');
    expect(bl['target-0'][0].excerpt).toContain('[[target-0]]');
  });

  it('holds the count at zero whether the page carries 20 links or 2000', () => {
    const sparse = linkPage('src', bigBody(20, 1024 * 1024));
    const dense = linkPage('src', bigBody(2000, 1024 * 1024));
    expect(searchCallsDuring(() => void deriveBacklinks([sparse]))).toBe(0);
    expect(searchCallsDuring(() => void deriveBacklinks([dense]))).toBe(0);
  });

  it('costs one whole-body search PER LINK in the pre-refactor derivation it replaces', () => {
    // The yardstick: same page, same output, 500 whole-body scans instead of none.
    const page = linkPage('src', bigBody(500, 64 * 1024));
    let mine: Backlinks = {};
    let theirs: Backlinks = {};
    expect(searchCallsDuring(() => void (mine = deriveBacklinks([page])))).toBe(0);
    expect(searchCallsDuring(() => void (theirs = referenceDeriveBacklinks([page])))).toBe(500);
    expect(mine).toEqual(theirs);
  });

  // Counting searches alone pins "no per-link re-search", not "linear": a rewrite that
  // re-scans per link with `indexOf` or `exec` passes at zero. Metering the bytes COPIED
  // closes that gap on the axis the derivation actually spends them — the marker walk's
  // candidate slices.
  it('copies a bounded share of the page, and the share does not grow with the page', () => {
    const full = bigBody(2000, 1024 * 1024);
    const half = bigBody(1000, 512 * 1024);

    let bl: Backlinks = {};
    const fullChars = sliceCharsDuring(() => void (bl = deriveBacklinks([linkPage('src', full)])));
    const halfChars = sliceCharsDuring(() => void deriveBacklinks([linkPage('src', half)]));

    expect(Object.keys(bl)).toHaveLength(2000); // not vacuous: it derived the whole page
    expect(fullChars).toBeGreaterThan(0);
    // Under a page-worth of copying for a page-worth of links (measured ~0.30×).
    expect(fullChars).toBeLessThanOrEqual(full.length);
    // Twice the page at the same link density costs about twice the copying (measured
    // 2.014x). The ceiling has to sit below 2^1.5 = 2.83x or it cannot tell linear from
    // the Theta(bytes^1.5) slicing that is `firstMarkerIndexes`'s documented caveat.
    expect(fullChars).toBeLessThan(halfChars * 2.4);
  });
});

// --- buildWikiGraph -------------------------------------------------------

describe('buildWikiGraph', () => {
  const now = '2026-06-21T12:00:00.000Z';

  const indexOf = (
    cats: { type: string; articles: { slug: string; title: string; updated: string }[] }[],
  ): WikiIndex => ({
    generatedAt: now,
    totalArticles: cats.reduce((n, c) => n + c.articles.length, 0),
    changesToday: 0,
    categories: cats.map((c) => ({
      type: c.type,
      label: c.type,
      count: c.articles.length,
      newCount: 0,
      articles: c.articles,
    })),
    pinned: [],
  });

  it('returns an empty graph for an empty index', () => {
    const empty = indexOf([]);
    const g = buildWikiGraph(empty, {}, now);
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
    expect(g.lint).toEqual({ dangling: [], orphans: [], stale: [] });
  });

  it('builds nodes from index categories with type + degrees from edges', () => {
    const index = indexOf([
      {
        type: 'person',
        articles: [
          { slug: 'sahil', title: 'Sahil', updated: now },
          { slug: 'priya', title: 'Priya', updated: now },
        ],
      },
      { type: 'project', articles: [{ slug: 'atlas', title: 'Atlas', updated: now }] },
    ]);
    // sahil and priya both link to atlas → atlas is a hub (inDegree 2)
    const backlinks: Backlinks = {
      atlas: [
        { from: 'sahil', title: 'Sahil', excerpt: 'x' },
        { from: 'priya', title: 'Priya', excerpt: 'x' },
      ],
    };
    const g = buildWikiGraph(index, backlinks, now);

    const atlas = g.nodes.find((n) => n.slug === 'atlas')!;
    expect(atlas.type).toBe('project');
    expect(atlas.inDegree).toBe(2);
    expect(atlas.outDegree).toBe(0);
    expect(atlas.missing).toBe(false);

    const sahil = g.nodes.find((n) => n.slug === 'sahil')!;
    expect(sahil.outDegree).toBe(1);
    expect(sahil.inDegree).toBe(0);

    expect(g.edges).toContainEqual({ from: 'sahil', to: 'atlas' });
    expect(g.edges).toContainEqual({ from: 'priya', to: 'atlas' });
  });

  it('slugifies Title-case backlink keys and from-slugs (back-compat with old writes)', () => {
    const index = indexOf([
      {
        type: 'concept',
        articles: [
          { slug: 'cached-tokens', title: 'Cached Tokens', updated: now },
          { slug: 'sahil', title: 'Sahil', updated: now },
        ],
      },
    ]);
    const backlinks: Backlinks = {
      // raw Title-case key, raw Title-case from — both must normalize
      'Cached-tokens': [{ from: 'Sahil', title: 'Sahil', excerpt: 'x' }],
    };
    const g = buildWikiGraph(index, backlinks, now);
    expect(g.edges).toContainEqual({ from: 'sahil', to: 'cached-tokens' });
    expect(g.nodes.find((n) => n.slug === 'cached-tokens')!.inDegree).toBe(1);
  });

  it('dedupes duplicate edges and drops self-edges', () => {
    const index = indexOf([
      {
        type: 'concept',
        articles: [
          { slug: 'a', title: 'A', updated: now },
          { slug: 'b', title: 'B', updated: now },
        ],
      },
    ]);
    const backlinks: Backlinks = {
      b: [
        { from: 'a', title: 'A', excerpt: 'x' },
        { from: 'a', title: 'A', excerpt: 'y' }, // duplicate (a,b)
      ],
      a: [{ from: 'a', title: 'A', excerpt: 'z' }], // self-edge a->a, dropped
    };
    const g = buildWikiGraph(index, backlinks, now);
    expect(g.edges).toEqual([{ from: 'a', to: 'b' }]);
  });

  it('marks a missing node and reports it as dangling lint', () => {
    const index = indexOf([
      { type: 'person', articles: [{ slug: 'sahil', title: 'Sahil', updated: now }] },
    ]);
    // sahil links to ghost, which has no article
    const backlinks: Backlinks = { ghost: [{ from: 'sahil', title: 'Sahil', excerpt: 'x' }] };
    const g = buildWikiGraph(index, backlinks, now);

    const ghost = g.nodes.find((n) => n.slug === 'ghost')!;
    expect(ghost.missing).toBe(true);
    expect(ghost.type).toBe('missing');
    expect(ghost.title).toBe('ghost');
    expect(g.lint.dangling).toContainEqual({ from: 'sahil', to: 'ghost' });
  });

  it('reports orphans (inDegree 0 and outDegree 0)', () => {
    const index = indexOf([
      {
        type: 'person',
        articles: [
          { slug: 'lonely', title: 'Lonely', updated: now },
          { slug: 'a', title: 'A', updated: now },
          { slug: 'b', title: 'B', updated: now },
        ],
      },
    ]);
    const backlinks: Backlinks = { b: [{ from: 'a', title: 'A', excerpt: 'x' }] };
    const g = buildWikiGraph(index, backlinks, now);
    expect(g.lint.orphans).toEqual(['lonely']);
  });

  it('reports stale known slugs older than staleDays and guards unparseable dates', () => {
    const index = indexOf([
      {
        type: 'person',
        articles: [
          { slug: 'old', title: 'Old', updated: '2026-04-01T00:00:00.000Z' }, // ~81 days
          { slug: 'fresh', title: 'Fresh', updated: now },
          { slug: 'broken', title: 'Broken', updated: 'not-a-date' },
        ],
      },
    ]);
    const g = buildWikiGraph(index, {}, now, 30);
    expect(g.lint.stale).toContain('old');
    expect(g.lint.stale).not.toContain('fresh');
    expect(g.lint.stale).not.toContain('broken');
  });

  it('is deterministic and pure (same inputs → equal output)', () => {
    const index = indexOf([
      { type: 'person', articles: [{ slug: 'sahil', title: 'Sahil', updated: now }] },
    ]);
    const backlinks: Backlinks = { ghost: [{ from: 'sahil', title: 'Sahil', excerpt: 'x' }] };
    const a = buildWikiGraph(index, backlinks, now);
    const b = buildWikiGraph(index, backlinks, now);
    expect(a).toEqual(b);
  });

  // --- a FILED brain (typed folders) ---------------------------------------
  //
  // The two sides of an edge are spelled differently on a migrated brain: the index
  // names a page by TYPED PATH, while `deriveBacklinks` keys each target through
  // `slugify` (and records `from` as the writer's typed path). Flattening both on
  // read made every edge miss every node — every link dangling, every page an orphan.

  const filedIndex = () =>
    indexOf([
      {
        type: 'person',
        articles: [
          { slug: 'entities/people/keshav-musunuri', title: 'Keshav Musunuri', updated: now },
          {
            slug: 'entities/people/keshav-musunuri-2',
            title: 'Keshav Musunuri (continued 2)',
            updated: now,
          },
          { slug: 'entities/people/zaf', title: 'Zaf', updated: now },
        ],
      },
      { type: 'project', articles: [{ slug: 'projects/atlas', title: 'Atlas', updated: now }] },
    ]);

  it('resolves a filed brain: a flattened backlink key is an edge to the typed page', () => {
    // `[[entities/people/zaf]]` written on Keshav's page: the key arrives flattened,
    // the `from` arrives as the typed path the index files the writer under.
    const backlinks: Backlinks = {
      'entities-people-zaf': [
        { from: 'entities/people/keshav-musunuri', title: 'Keshav Musunuri', excerpt: 'x' },
      ],
    };
    const g = buildWikiGraph(filedIndex(), backlinks, now);

    expect(g.edges).toEqual([
      { from: 'entities/people/keshav-musunuri', to: 'entities/people/zaf' },
    ]);
    expect(g.lint.dangling).toEqual([]);
    expect(g.nodes.filter((n) => n.missing)).toEqual([]);
    expect(g.nodes.find((n) => n.slug === 'entities/people/zaf')!.inDegree).toBe(1);
    expect(g.nodes.find((n) => n.slug === 'entities/people/keshav-musunuri')!.outDegree).toBe(1);
  });

  it('resolves a filed brain: a bare-stem link target finds the page in its folder', () => {
    // `[[atlas]]` and the continuation trailer `[[keshav-musunuri-2]]` — the two bare
    // spellings a filed brain actually writes.
    const backlinks: Backlinks = {
      atlas: [{ from: 'entities/people/zaf', title: 'Zaf', excerpt: 'x' }],
      'keshav-musunuri-2': [
        { from: 'entities/people/keshav-musunuri', title: 'Keshav Musunuri', excerpt: 'x' },
      ],
    };
    const g = buildWikiGraph(filedIndex(), backlinks, now);

    expect(g.edges).toContainEqual({ from: 'entities/people/zaf', to: 'projects/atlas' });
    expect(g.edges).toContainEqual({
      from: 'entities/people/keshav-musunuri',
      to: 'entities/people/keshav-musunuri-2',
    });
    expect(g.lint.dangling).toEqual([]);
    expect(g.nodes.filter((n) => n.missing)).toEqual([]);
  });

  it('a filed brain still reports a genuinely dangling link, and unlinked pages as orphans', () => {
    const backlinks: Backlinks = {
      ghost: [{ from: 'entities/people/zaf', title: 'Zaf', excerpt: 'x' }],
    };
    const g = buildWikiGraph(filedIndex(), backlinks, now);

    expect(g.edges).toEqual([{ from: 'entities/people/zaf', to: 'ghost' }]);
    expect(g.lint.dangling).toEqual([{ from: 'entities/people/zaf', to: 'ghost' }]);
    expect(g.nodes.find((n) => n.slug === 'ghost')).toMatchObject({
      missing: true,
      type: 'missing',
    });
    // Resolution does not invent edges: a page nothing links is still an orphan.
    expect(g.lint.orphans).toEqual([
      'entities/people/keshav-musunuri',
      'entities/people/keshav-musunuri-2',
      'projects/atlas',
    ]);
  });

  it('an unresolvable endpoint keeps the FLATTENED spelling on BOTH ends, never the raw one', () => {
    // The one line of the resolution nothing pinned: the `?? slugify(raw)` fallback.
    // Every unresolvable target the other tests use is already slug-stable, so the
    // slugification could be deleted and they would all stay green. These two are
    // not: a stale sidecar naming a retired page by typed path, and a Title-case
    // key an older writer left behind. `missing` nodes become URL slugs or the web
    // renders a node it can never navigate to.
    const backlinks: Backlinks = {
      'Ghost Town': [{ from: 'entities/people/retired/sahil', title: 'Sahil', excerpt: 'x' }],
    };
    const g = buildWikiGraph(filedIndex(), backlinks, now);

    expect(g.edges).toEqual([{ from: 'entities-people-retired-sahil', to: 'ghost-town' }]);
    expect(g.nodes.find((n) => n.slug === 'ghost-town')).toMatchObject({ missing: true });
    expect(g.nodes.map((n) => n.slug)).not.toContain('Ghost Town');
  });

  it('does not resolve through aliases — an alias target is still a missing node', () => {
    // `aliases` live in a page's frontmatter, never in the derived index, so the graph
    // has never resolved them. The control that keeps this a fix, not a widening.
    const backlinks: Backlinks = {
      zafar: [{ from: 'entities/people/keshav-musunuri', title: 'Keshav Musunuri', excerpt: 'x' }],
    };
    const g = buildWikiGraph(filedIndex(), backlinks, now);

    expect(g.edges).toEqual([{ from: 'entities/people/keshav-musunuri', to: 'zafar' }]);
    expect(g.lint.dangling).toEqual([
      { from: 'entities/people/keshav-musunuri', to: 'zafar' },
    ]);
  });

  it('leaves an unmigrated flat brain untouched: every endpoint is still the flattened slug', () => {
    // The byte-identity pin. Every index slug here is slug-stable, so resolution can
    // only ever answer with `slugify(target)` — exactly what the old read did.
    const index = indexOf([
      {
        type: 'concept',
        articles: [
          { slug: 'cached-tokens', title: 'Cached Tokens', updated: now },
          { slug: 'sahil', title: 'Sahil', updated: now },
          { slug: 'lonely', title: 'Lonely', updated: now },
        ],
      },
    ]);
    const backlinks: Backlinks = {
      'Cached-tokens': [{ from: 'Sahil', title: 'Sahil', excerpt: 'x' }],
      ghost: [{ from: 'sahil', title: 'Sahil', excerpt: 'x' }],
    };
    const g = buildWikiGraph(index, backlinks, now);

    expect(g.edges).toEqual([
      { from: 'sahil', to: 'cached-tokens' },
      { from: 'sahil', to: 'ghost' },
    ]);
    expect(g.lint).toEqual({
      dangling: [{ from: 'sahil', to: 'ghost' }],
      orphans: ['lonely'],
      stale: [],
    });
    expect(g.nodes.map((n) => n.slug)).toEqual(['cached-tokens', 'sahil', 'lonely', 'ghost']);
  });
});

// --- wikiSlugResolver -----------------------------------------------------

describe('wikiSlugResolver', () => {
  const pages = ['entities/people/zaf', 'entities/companies/vestra', 'legacy-note'];

  it('answers the typed path as filed', () => {
    expect(wikiSlugResolver(pages)('entities/people/zaf')).toEqual(['entities/people/zaf']);
    expect(wikiSlugResolver(pages)('legacy-note')).toEqual(['legacy-note']);
  });

  it('answers a bare basename, raw or flattened', () => {
    expect(wikiSlugResolver(pages)('zaf')).toEqual(['entities/people/zaf']);
    expect(wikiSlugResolver(pages)('Vestra')).toEqual(['entities/companies/vestra']);
  });

  it('answers the flattened spelling an older web build sends', () => {
    expect(wikiSlugResolver(pages)('entities-people-zaf')).toEqual(['entities/people/zaf']);
  });

  it('answers nothing at all for a target the index does not list', () => {
    expect(wikiSlugResolver(pages)('ghost')).toEqual([]);
  });

  it('breaks a flattening collision by index order, deterministically', () => {
    // `entities/people-zaf` and `entities/people/zaf` flatten identically. The page the
    // index lists FIRST wins — the same one a single index-order scan would find.
    const collide = ['entities/people-zaf', 'entities/people/zaf'];
    expect(wikiSlugResolver(collide)('entities-people-zaf')[0]).toBe('entities/people-zaf');
    // …and the earlier pass still separates them when the target is a bare basename.
    expect(wikiSlugResolver(collide)('zaf')).toEqual(['entities/people/zaf']);
  });

  it('names EVERY page a target answers, in index order — an ambiguity is not a pick', () => {
    // The shape the reader has to be able to see: two type folders, one stem. Both
    // pages share one user-edit overlay row, so "which one" is not a question the
    // resolver may answer alone.
    const collide = ['entities/people/vestra', 'entities/companies/vestra'];
    expect(wikiSlugResolver(collide)('vestra')).toEqual(['entities/people/vestra', 'entities/companies/vestra']);
    // The raw and the flattened spelling of a basename are ONE index-order scan, not
    // two lists appended: a Title-case page ahead of a lowercase one keeps its place.
    const cased = ['a/zaf', 'b/Zaf', 'c/zaf'];
    expect(wikiSlugResolver(cased)('Zaf')).toEqual(['a/zaf', 'b/Zaf', 'c/zaf']);
  });

  it('stops at the first pass that answers — a basename hit never collects flattenings too', () => {
    const pagesWithBoth = ['entities/people/zaf', 'entities-people-zaf'];
    // The bare basename answers in pass 2; the page whose whole slug IS the flattening
    // belongs to pass 3, which is never reached.
    expect(wikiSlugResolver(pagesWithBoth)('zaf')).toEqual(['entities/people/zaf']);
    // …and an exact hit is exactly one page, never an ambiguity.
    expect(wikiSlugResolver(pagesWithBoth)('entities-people-zaf')).toEqual(['entities-people-zaf']);
  });
});

// --- slugBasename ---------------------------------------------------------

describe('slugBasename', () => {
  it('is the last path segment — the name a page keeps as it moves between folders', () => {
    expect(slugBasename('entities/people/zaf')).toBe('zaf');
    expect(slugBasename('legacy-note')).toBe('legacy-note');
    expect(slugBasename('')).toBe('');
  });
});

// --- salience -------------------------------------------------------------

describe('selectSalientSubjects', () => {
  it('groups active claims by normalized subject and scores by sources + distinct predicates', () => {
    const claims = [
      claim('Sahil Verma', 'works at', 'Acme'),
      claim('sahil verma', 'leads', 'Project Atlas'),
      claim('Priya', 'prefers', 'TS'),
    ];
    const out = selectSalientSubjects(claims, 10);
    expect(out[0].subject).toBe('Sahil Verma');
    expect(out[0].claims).toHaveLength(2);
    expect(out[0].score).toBeGreaterThan(out[1].score);
  });

  it('ignores superseded / expired claims', () => {
    const claims = [
      claim('Gone', 'x', 'y', { supersededBy: 'z' }),
      claim('Stale', 'x', 'y', { validTo: '2026-06-02' }),
      claim('Live', 'x', 'y'),
    ];
    const subjects = selectSalientSubjects(claims, 10).map((s) => s.subject);
    expect(subjects).toEqual(['Live']);
  });

  it('bounds to max', () => {
    const claims = [claim('A', 'p', 'o'), claim('B', 'p', 'o'), claim('C', 'p', 'o')];
    expect(selectSalientSubjects(claims, 2)).toHaveLength(2);
  });
});

// --- index ----------------------------------------------------------------

describe('buildIndex', () => {
  it('groups pages by type and counts newCount within 24h', () => {
    const now = '2026-06-10T12:00:00.000Z';
    const pages: WikiArticle[] = [
      { slug: 'sahil', frontmatter: fm({ title: 'Sahil', type: 'person', updated: '2026-06-10T10:00:00.000Z' }), body: '' },
      { slug: 'priya', frontmatter: fm({ title: 'Priya', type: 'person', updated: '2026-06-01T00:00:00.000Z' }), body: '' },
      { slug: 'atlas', frontmatter: fm({ title: 'Atlas', type: 'project', updated: '2026-06-10T11:00:00.000Z' }), body: '' },
    ];
    const index = buildIndex(pages, now);
    expect(index.totalArticles).toBe(3);
    const person = index.categories.find((c) => c.type === 'person')!;
    expect(person.count).toBe(2);
    expect(person.newCount).toBe(1);
    const project = index.categories.find((c) => c.type === 'project')!;
    expect(project.newCount).toBe(1);
    expect(index.changesToday).toBe(2);
    expect(index.generatedAt).toBe(now);
  });

  it('pins userEdited pages', () => {
    const now = '2026-06-10T12:00:00.000Z';
    const pages: WikiArticle[] = [
      { slug: 'pinned', frontmatter: fm({ title: 'Pinned', userEdited: true }), body: '' },
      { slug: 'auto', frontmatter: fm({ title: 'Auto' }), body: '' },
    ];
    expect(buildIndex(pages, now).pinned).toEqual(['pinned']);
  });
});

// --- synthesizeWiki -------------------------------------------------------

const stubSynth = (over?: Partial<{ frontmatter: WikiFrontmatter; body: string }>): WikiSynthesizer => ({
  async synthesize({ subject, now }) {
    return {
      frontmatter: fm({ title: subject, updated: now, created: now }),
      body: `## Summary\n${subject} is a thing. [s1]\n\n## Sources\n- s1: x`,
      ...over,
    };
  },
});

describe('synthesizeWiki', () => {
  it('synthesizes salient subjects, builds index + backlinks, reports 0 deferred', async () => {
    const now = '2026-06-10T12:00:00.000Z';
    const claims = [claim('Sahil Verma', 'works at', 'Acme'), claim('Priya', 'prefers', 'TS')];
    const out = await synthesizeWiki([], claims, stubSynth(), now, 12);
    expect(out.pages).toHaveLength(2);
    expect(out.deferred).toBe(0);
    expect(out.index.totalArticles).toBe(2);
    expect(out.backlinks).toBeDefined();
    expect(out.pages.map((p) => p.slug).sort()).toEqual(['priya', 'sahil-verma']);
  });

  it('bounds to max and reports the deferred count', async () => {
    const now = '2026-06-10T12:00:00.000Z';
    const claims = [claim('A', 'p', 'o'), claim('B', 'p', 'o'), claim('C', 'p', 'o')];
    const out = await synthesizeWiki([], claims, stubSynth(), now, 2);
    expect(out.pages).toHaveLength(2);
    expect(out.deferred).toBe(1);
  });

  it('skips userEdited existing pages (pin rule) and keeps them verbatim', async () => {
    const now = '2026-06-10T12:00:00.000Z';
    const existing: WikiArticle[] = [
      { slug: 'sahil-verma', frontmatter: fm({ title: 'Sahil Verma', userEdited: true }), body: 'HAND EDITED' },
    ];
    const claims = [claim('Sahil Verma', 'works at', 'Acme')];
    const out = await synthesizeWiki(existing, claims, stubSynth(), now, 12);
    const page = out.pages.find((p) => p.slug === 'sahil-verma')!;
    expect(page.body).toBe('HAND EDITED');
    expect(page.frontmatter.userEdited).toBe(true);
  });

  it('drops just the subject whose synth throws, keeps the rest', async () => {
    const now = '2026-06-10T12:00:00.000Z';
    const claims = [claim('Good', 'p', 'o'), claim('Bad', 'p', 'o')];
    const flaky: WikiSynthesizer = {
      async synthesize({ subject, now: n }) {
        if (subject === 'Bad') throw new Error('haiku timeout');
        return { frontmatter: fm({ title: subject, updated: n }), body: '## Summary\nok' };
      },
    };
    const out = await synthesizeWiki([], claims, flaky, now, 12);
    expect(out.pages.map((p) => p.slug)).toEqual(['good']);
  });

  it('merges a re-synthesized page over an existing non-userEdited one', async () => {
    const now = '2026-06-10T12:00:00.000Z';
    const existing: WikiArticle[] = [
      { slug: 'sahil-verma', frontmatter: fm({ title: 'Sahil Verma', created: '2026-05-01' }), body: 'OLD' },
    ];
    const claims = [claim('Sahil Verma', 'works at', 'Acme')];
    const out = await synthesizeWiki(existing, claims, stubSynth(), now, 12);
    const page = out.pages.find((p) => p.slug === 'sahil-verma')!;
    expect(page.body).not.toBe('OLD');
    // created is preserved from the existing page
    expect(page.frontmatter.created).toBe('2026-05-01');
  });

  it('only synths resynch subjects but passes full candidateSlugs for links', async () => {
    const now = '2026-06-10T12:00:00.000Z';
    // Two subjects with existing (clean) pages; only "Bravo" is dirty.
    const existing: WikiArticle[] = [
      { slug: 'alpha', frontmatter: fm({ title: 'Alpha', type: 'concept', created: '2026-05-01' }), body: 'ALPHA-OLD' },
      { slug: 'bravo', frontmatter: fm({ title: 'Bravo', type: 'concept', created: '2026-05-01' }), body: 'BRAVO-OLD' },
    ];
    const claims = [claim('Alpha', 'p', 'o'), claim('Bravo', 'p', 'o2')];

    const seenRelated: Record<string, string[]> = {};
    const trackingSynth: WikiSynthesizer = {
      async synthesize({ subject, related, now: n }) {
        seenRelated[subject] = related;
        return { frontmatter: fm({ title: subject, updated: n }), body: `## Summary\n${subject} re-synthed. [s1]` };
      },
    };

    const out = await synthesizeWiki(existing, claims, trackingSynth, now, 12, {
      dirtyFilter: { resynth: new Set(['bravo']) },
      candidateSlugs: ['alpha', 'bravo'],
    });

    // Alpha (clean) kept verbatim; Bravo (dirty) re-synthed.
    expect(out.pages.find((p) => p.slug === 'alpha')!.body).toBe('ALPHA-OLD');
    expect(out.pages.find((p) => p.slug === 'bravo')!.body).not.toBe('BRAVO-OLD');
    // Only Bravo was passed to the synthesizer.
    expect(Object.keys(seenRelated)).toEqual(['Bravo']);
    // Bravo's wikilink candidates include the UNCHANGED neighbor alpha (from candidateSlugs).
    expect(seenRelated['Bravo']).toContain('alpha');
  });

  it('recencyFirst: synthesizes a brand-new low-salience subject ahead of an established high-salience one', async () => {
    const now = '2026-06-10T12:00:00.000Z';
    // "Established" is HIGH salience (many sources + predicates) but OLD (its newest
    // claim is from 2026-06-01). "Fresh" is LOW salience (one claim) but its claim is
    // the most RECENT (2026-06-09). With max=1, recency-first must pick "Fresh".
    const established = [
      claim('Established', 'p1', 'o1', { observedAt: '2026-06-01' }),
      claim('Established', 'p2', 'o2', { observedAt: '2026-06-01' }),
      claim('Established', 'p3', 'o3', { observedAt: '2026-06-01' }),
    ];
    const fresh = [claim('Fresh', 'just-learned', 'today', { observedAt: '2026-06-09' })];
    const claims = [...established, fresh[0]];

    const synthed: string[] = [];
    const trackingSynth: WikiSynthesizer = {
      async synthesize({ subject, now: n }) {
        synthed.push(subject);
        return { frontmatter: fm({ title: subject, updated: n }), body: `## Summary\n${subject}. [s1]` };
      },
    };

    const out = await synthesizeWiki([], claims, trackingSynth, now, 1, { recencyFirst: true });

    // Only ONE synth (the cap), and it must be the FRESH subject (most-recent claim),
    // NOT the higher-salience established one.
    expect(synthed).toEqual(['Fresh']);
    expect(out.deferred).toBe(1);
  });

  it('recencyFirst: fills remaining budget by salience after the most-recent subjects', async () => {
    const now = '2026-06-10T12:00:00.000Z';
    // Three subjects: Fresh (most recent), then two older ones of differing salience.
    const fresh = claim('Fresh', 'p', 'o', { observedAt: '2026-06-09' });
    const bigOld = [
      claim('BigOld', 'p1', 'o1', { observedAt: '2026-06-01' }),
      claim('BigOld', 'p2', 'o2', { observedAt: '2026-06-01' }),
    ];
    const smallOld = claim('SmallOld', 'p', 'o', { observedAt: '2026-06-01' });
    const claims = [fresh, ...bigOld, smallOld];

    const synthed: string[] = [];
    const trackingSynth: WikiSynthesizer = {
      async synthesize({ subject, now: n }) {
        synthed.push(subject);
        return { frontmatter: fm({ title: subject, updated: n }), body: `## Summary\n${subject}. [s1]` };
      },
    };

    // cap=2: Fresh (most recent) first, then the remaining budget filled by salience
    // (BigOld beats SmallOld). SmallOld is deferred.
    const out = await synthesizeWiki([], claims, trackingSynth, now, 2, { recencyFirst: true });
    expect(synthed).toEqual(['Fresh', 'BigOld']);
    expect(out.deferred).toBe(1);
  });
});

// --- selectDirtySubjects --------------------------------------------------

describe('selectDirtySubjects', () => {
  const now = '2026-06-10T12:00:00.000Z';

  // Provenance entry encodes {id, confidence} so a reweight is detectable from
  // recorded state alone (matches the kernel's set-hash encoding `id:confidence`).
  const prov = (id: string, confidence = 0.8): string => `${id}:${confidence}`;

  // an article whose recorded provenance matches the given entries exactly
  const articleFor = (slug: string, sourceClaimIds: string[], over: Partial<WikiFrontmatter> = {}): WikiArticle => ({
    slug,
    frontmatter: fm({ title: slug, type: 'concept', sourceClaimIds, ...over }),
    body: `## Summary\n${slug}. [s1]`,
  });

  it('dirty on a new claim', () => {
    const c1 = claim('Sahil', 'works at', 'Acme', { id: 'c1' });
    const c2 = claim('Sahil', 'leads', 'Atlas', { id: 'c2' });
    // article recorded only c1; c2 is new → set-hash differs
    const articles = [articleFor('sahil', [prov('c1')])];
    const out = selectDirtySubjects([c1, c2], articles, now);
    expect(out.resynth).toContain('sahil');
  });

  it('dirty on retract-only (subject loses its last-but-one claim, set-hash changes)', () => {
    const c1 = claim('Sahil', 'works at', 'Acme', { id: 'c1' });
    const c2 = claim('Sahil', 'leads', 'Atlas', { id: 'c2', supersededBy: 'cX' }); // retired
    // article recorded both; c2 now inactive → active set is {c1}, hash differs from recorded {c1,c2}
    const articles = [articleFor('sahil', [prov('c1'), prov('c2')])];
    const out = selectDirtySubjects([c1, c2], articles, now);
    expect(out.resynth).toContain('sahil');
    // subject still has c1 active, so NOT removed
    expect(out.remove).not.toContain('sahil');
  });

  it('dirty on reweight-only (confidence changes, observedAt unchanged)', () => {
    // article recorded c1 at confidence 0.8; the claim is now 0.9 → set-hash differs
    const c1 = claim('Sahil', 'works at', 'Acme', { id: 'c1', confidence: 0.9 });
    const articles = [articleFor('sahil', [prov('c1', 0.8)])];
    const out = selectDirtySubjects([c1], articles, now);
    expect(out.resynth).toContain('sahil');
  });

  it('dirty when a cited claim is retired (cross-subject staleness is subsumed by the set-hash)', () => {
    // The page was synthesized from c1 + c2 (both for subject Sahil). c2 is later retired
    // by a contradiction (superseded elsewhere). A retired cited id is, by definition, absent
    // from the subject's current active set — so the active set {c1} hashes differently from
    // the recorded set {c1, c2}, and the set-hash (branch 2) already flags resynth. There is
    // no separate "still-matches-its-subject yet cites a globally-dead id" case to catch given
    // unique claim ids, so we deliberately do NOT carry a dedicated provenance-scan branch.
    const c1 = claim('Sahil', 'works at', 'Acme', { id: 'c1', confidence: 0.8 });
    const c2 = claim('Sahil', 'leads', 'Atlas', { id: 'c2', confidence: 0.8, supersededBy: 'cY' });
    const articles = [articleFor('sahil', [prov('c1', 0.8), prov('c2', 0.8)])];
    const out = selectDirtySubjects([c1, c2], articles, now);
    expect(out.resynth).toContain('sahil');
  });

  it('dirty when an existing article has NO recorded provenance (legacy / pre-provenance page)', () => {
    // A legacy page on disk has no `sourceClaimIds` key → parses to undefined. With active
    // claims for its subject, it has no recorded provenance yet, so it MUST be re-synthed
    // (to gain provenance). Absence must be treated as dirty, never throw or pass as clean.
    const c1 = claim('Sahil', 'works at', 'Acme', { id: 'c1', confidence: 0.8 });
    const article: WikiArticle = {
      slug: 'sahil',
      frontmatter: fmNoProvenance({ title: 'sahil', type: 'concept' }),
      body: '## Summary\nsahil. [s1]',
    };
    // sanity: provenance is genuinely absent, not an empty set
    expect(article.frontmatter.sourceClaimIds).toBeUndefined();
    const out = selectDirtySubjects([c1], [article], now);
    expect(out.resynth).toContain('sahil');
    expect(out.remove).not.toContain('sahil');
  });

  it('not dirty when active-claim set unchanged', () => {
    const c1 = claim('Sahil', 'works at', 'Acme', { id: 'c1', confidence: 0.8 });
    const c2 = claim('Sahil', 'leads', 'Atlas', { id: 'c2', confidence: 0.8 });
    const articles = [articleFor('sahil', [prov('c1', 0.8), prov('c2', 0.8)])];
    const out = selectDirtySubjects([c1, c2], articles, now);
    expect(out.resynth).not.toContain('sahil');
    expect(out.remove).not.toContain('sahil');
  });

  it('selectDirtySubjects returns orphan removals; pruneOrphanArticles deletes them, skips userEdited', () => {
    // ghost has an article but ZERO active claims for its subject → removable
    const ghost = articleFor('ghost', [prov('cOld')]);
    // pinned-ghost is also orphaned but userEdited → skipped
    const pinnedGhost = articleFor('pinned-ghost', [prov('cOld2')], { userEdited: true });
    // live subject keeps its article
    const c1 = claim('Live', 'p', 'o', { id: 'c1' });
    const live = articleFor('live', [prov('c1')]);
    const articles = [ghost, pinnedGhost, live];

    const out = selectDirtySubjects([c1], articles, now);
    expect(out.remove).toContain('ghost');
    expect(out.remove).not.toContain('pinned-ghost');
    expect(out.remove).not.toContain('live');

    const pruned = pruneOrphanArticles(articles, [c1]);
    expect(pruned.removedSlugs).toContain('ghost');
    expect(pruned.removedSlugs).not.toContain('pinned-ghost');
    expect(pruned.keep.map((a) => a.slug).sort()).toEqual(['live', 'pinned-ghost']);
  });
});

// --- validateGrounding ----------------------------------------------------

describe('validateGrounding', () => {
  it('true when a citation resolves to an active claim in sourceClaimIds', () => {
    const c1 = claim('Sahil', 'works at', 'Acme', { id: 'c1' });
    const article: WikiArticle = {
      slug: 'sahil',
      frontmatter: fm({ title: 'Sahil', sourceClaimIds: ['c1'] }),
      body: '## Summary\nSahil works at Acme. [s1]\n\n## Sources\n- s1: x',
    };
    expect(validateGrounding(article, [c1])).toBe(true);
  });

  it('validateGrounding false when no citation resolves to an active claim', () => {
    // article cites [s1] but its only sourceClaimId is now superseded (inactive)
    const c1 = claim('Sahil', 'works at', 'Acme', { id: 'c1', supersededBy: 'cZ' });
    const article: WikiArticle = {
      slug: 'sahil',
      frontmatter: fm({ title: 'Sahil', sourceClaimIds: ['c1'] }),
      body: '## Summary\nSahil works at Acme. [s1]\n\n## Sources\n- s1: x',
    };
    expect(validateGrounding(article, [c1])).toBe(false);
  });

  it('false when the body has no citation marker at all', () => {
    const c1 = claim('Sahil', 'works at', 'Acme', { id: 'c1' });
    const article: WikiArticle = {
      slug: 'sahil',
      frontmatter: fm({ title: 'Sahil', sourceClaimIds: ['c1'] }),
      body: '## Summary\nSahil works at Acme.',
    };
    expect(validateGrounding(article, [c1])).toBe(false);
  });
});

// --- sourceClaimIds frontmatter round-trip --------------------------------

describe('sourceClaimIds frontmatter codec', () => {
  it('round-trips sourceClaimIds through serialize/parse', () => {
    const article: WikiArticle = {
      slug: 'sahil',
      frontmatter: fm({ title: 'Sahil', sourceClaimIds: ['c1', 'c2'] }),
      body: '## Summary\nx [s1]',
    };
    const back = parseArticle(serializeArticle(article), 'sahil');
    expect(back.frontmatter.sourceClaimIds).toEqual(['c1', 'c2']);
  });

  it('parses a missing sourceClaimIds key as undefined (no recorded provenance)', () => {
    const a = parseArticle('---\ntitle: T\n---\nbody', 't');
    expect(a.frontmatter.sourceClaimIds).toBeUndefined();
  });

  it('omits the sourceClaimIds key when serializing an article with no provenance, and round-trips the absence', () => {
    const article: WikiArticle = {
      slug: 't',
      // provenance genuinely absent (legacy / pre-provenance page)
      frontmatter: fmNoProvenance({ title: 'T' }),
      body: '## Summary\nx [s1]',
    };
    expect(article.frontmatter.sourceClaimIds).toBeUndefined();
    const md = serializeArticle(article);
    expect(md).not.toContain('sourceClaimIds');
    expect(parseArticle(md, 't').frontmatter.sourceClaimIds).toBeUndefined();
  });
});

// --- scanWikilinkMarkers: the grammar, now shared with the server ----------
//
// `extractWikilinks` is one caller's rule over this scan; the filing
// (nami-brain-migrate) and the gate (nami-brain-validator) are two more, and each
// carried its own byte-identical copy of the old regex until T6c. They need what
// `extractWikilinks` throws away — positions, the whole match, and the RAW inner
// bytes — so the pins below are on the exec triple `(m.index, m[0].length, m[1])`
// rather than on extracted targets.

/** The old regex's own `exec` triples — the thing `scanWikilinkMarkers` must reproduce. */
const referenceWikilinkMarkers = (body: string): { index: number; length: number; inner: string }[] => {
  const out: { index: number; length: number; inner: string }[] = [];
  const re = /\[\[([^\]]+?)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push({ index: m.index, length: m[0].length, inner: m[1] });
  return out;
};

describe('scanWikilinkMarkers — the exec triple, without the exec', () => {
  it('reports index, length and RAW inner exactly as the old regex did', () => {
    // The raw inner is the load-bearing difference from extractWikilinks: it is
    // neither trimmed nor cut at the `|`, because the gate keeps an empty target
    // and the filing needs the label half.
    expect(scanWikilinkMarkers('a [[ x | y ]] b')).toEqual([{ index: 2, length: 11, inner: ' x | y ' }]);
    expect(scanWikilinkMarkers('[[ ]]')).toEqual([{ index: 0, length: 5, inner: ' ' }]);
    expect(scanWikilinkMarkers('[[|]]')).toEqual([{ index: 0, length: 5, inner: '|' }]);
    expect(scanWikilinkMarkers('[[]]')).toEqual([]);
    // Leftmost-then-consuming, and the first `]` decides.
    expect(scanWikilinkMarkers('[[note [[acme]] tail]]')).toEqual([{ index: 0, length: 15, inner: 'note [[acme' }]);
    expect(scanWikilinkMarkers('[[a]b]]')).toEqual([]);
  });

  it('agrees with the old regex on every shape MARKER_SHAPES pins', () => {
    for (const [, body] of MARKER_SHAPES) {
      expect({ body, out: scanWikilinkMarkers(body) }).toEqual({ body, out: referenceWikilinkMarkers(body) });
    }
  });

  it('agrees with the old regex on 4,000 generated bodies, soup and prose alike', () => {
    const rand = seeded(0x7c6f2a11);
    let matched = 0;
    for (let i = 0; i < 2000; i++) {
      for (const body of [generatedBody(rand), generatedSoup(rand)]) {
        const mine = scanWikilinkMarkers(body);
        matched += mine.length;
        expect({ body, out: mine }).toEqual({ body, out: referenceWikilinkMarkers(body) });
      }
    }
    // ANTI-VACUITY: this must not pass by comparing empty arrays.
    expect(matched).toBeGreaterThan(2000);
  });

  it('never splits a UTF-16 surrogate pair, and carries a LONE surrogate through', () => {
    // The two filesystem-backed callers can never see a lone surrogate (UTF-8
    // cannot encode one, so writeFile turns it into U+FFFD). Here it is
    // reachable, so here is where it is pinned.
    for (const body of ['[[🙂]]', '[[a🙂b|x]]', '[[\uD83D]] then [[🙂]]', 'a [[\uD83Db\uDE42]] and [[x\uD83D]] end']) {
      expect({ body, out: scanWikilinkMarkers(body) }).toEqual({ body, out: referenceWikilinkMarkers(body) });
    }
    expect(scanWikilinkMarkers('[[\uD83D]]')).toEqual([{ index: 0, length: 5, inner: '\uD83D' }]);
  });

  it('is the pass extractWikilinks runs on — one scan, one grammar, no second copy', () => {
    // If extractWikilinks ever grows its own loop again, this drifts silently;
    // the raw markers and the extracted targets must stay one derivation apart.
    const body = 'See [[ Acme-Inc ]] and [[acme-inc|Acme]] and [[]] and [[ ]] and [[dangling';
    const derived = [
      ...new Set(scanWikilinkMarkers(body).map((m) => m.inner.split('|')[0]!.trim()).filter(Boolean)),
    ];
    expect(extractWikilinks(body)).toEqual(derived);
    expect(derived).toEqual(['Acme-Inc', 'acme-inc']);
  });
});
