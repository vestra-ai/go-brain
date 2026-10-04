// nami Wiki (Vestrapedia) — pure synthesis kernel.
//
// The open claim ledger (./claims.js) is the substrate. This module distills the
// ACTIVE claims into pre-rendered markdown articles (`pages/<slug>.md`) plus the
// derived index + backlinks. Everything here is PURE and unit-tested — the only
// LLM step is the injected `WikiSynthesizer` seam (mirrors Extractor /
// ContradictionDetector in ./curator.js). No I/O, no node:fs: root-safe so both
// the server (write pass) and the read endpoints can build on it.
//
// Degrade-safe: synthesizeWiki drops just the subject whose synth throws and
// never re-writes a userEdited page (the pin rule, same as memory cards).

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { isActive, type Claim } from './claims.js';

// --- types ----------------------------------------------------------------

/**
 * The OPEN frontmatter of a brain page: four spine keys every page carries, an optional
 * citation map, and — deliberately — whatever else the author wrote. Unknown keys SURVIVE
 * parse → serialize instead of being dropped, so a page can carry vocabulary the kernel
 * has never heard of (`relation: co-founder`, `org: "[[entities/companies/vestra]]"`).
 * Shape rules beyond the spine are the validator's business, not the codec's.
 */
export interface PageFrontmatter {
  title: string;
  /** free-form: person / project / customer / decision / concept / ... (open taxonomy) */
  type: string;
  aliases: string[];
  updated: string;
  /**
   * Citation map: `[s_n]` marker → the cite ids behind it (`ev:<door>[:app]:<id>`).
   * Normalized on parse when the key holds a mapping; any other shape rides through
   * verbatim rather than being dropped.
   */
  cites?: Record<string, string[]>;
  [key: string]: unknown;
}

export interface WikiFrontmatter extends PageFrontmatter {
  created: string;
  related: string[];
  /** number of source claims behind the article */
  sources: number;
  confidence: 'high' | 'medium' | 'low';
  userEdited: boolean;
  /**
   * Provenance: the source-claim set this article was synthesized from. Each entry
   * is a claim id, optionally `:<confidence>`-suffixed (the set-hash encoding), so a
   * pure reweight is detectable from recorded state. Drives derived dirtiness +
   * grounding.
   *
   * OPTIONAL: legacy / pre-provenance articles have none yet — the dream populates it
   * on the next synth. Absent (`undefined`) means "no recorded provenance", which the
   * kernel treats as DIRTY (needs re-synth to gain provenance) and as ungrounded.
   */
  sourceClaimIds?: string[];
}

export interface WikiArticle {
  slug: string;
  frontmatter: WikiFrontmatter;
  body: string;
}

export interface WikiCategoryArticle {
  slug: string;
  title: string;
  updated: string;
}

export interface WikiCategory {
  type: string;
  label: string;
  count: number;
  newCount: number;
  articles: WikiCategoryArticle[];
}

export interface WikiIndex {
  generatedAt: string;
  totalArticles: number;
  changesToday: number;
  categories: WikiCategory[];
  pinned: string[];
}

export interface Backlink {
  from: string;
  title: string;
  excerpt: string;
}

export type Backlinks = Record<string, Backlink[]>;

export interface SalientSubject {
  subject: string;
  claims: Claim[];
  score: number;
}

/** The LLM (Haiku) write step — swappable. Returns frontmatter + body for one subject. */
export interface WikiSynthesizer {
  synthesize(a: {
    subject: string;
    claims: Claim[];
    related: string[];
    now: string;
  }): Promise<{ frontmatter: WikiFrontmatter; body: string }>;
}

export interface SynthesizeWikiResult {
  pages: WikiArticle[];
  index: WikiIndex;
  backlinks: Backlinks;
  /** salient subjects beyond `max` that were NOT synthesized this pass (no silent caps) */
  deferred: number;
}

// --- helpers --------------------------------------------------------------

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

const CONFIDENCES = new Set(['high', 'medium', 'low']);

/** Lowercase, ascii-safe, dash-joined slug. Idempotent. Never empty. */
export function slugify(s: string): string {
  const base = s
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'untitled';
}

// --- frontmatter parse / serialize ---------------------------------------

function parseScalar(raw: string): string {
  let v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
}

function parseList(raw: string): string[] {
  const v = raw.trim();
  if (v === '' || v === '[]') return [];
  if (v.startsWith('[') && v.endsWith(']')) {
    return v
      .slice(1, -1)
      .split(',')
      .map((x) => parseScalar(x))
      .filter((x) => x.length > 0);
  }
  // single inline scalar fallback
  return [parseScalar(v)];
}

/**
 * Canonical key order on write: the spine first (stable across every page), then every
 * other key in insertion order. Deterministic — the same frontmatter always produces the
 * same bytes — and it keeps a page's git diff readable when an unknown key is added.
 */
const SPINE_KEYS = [
  'title',
  'type',
  'created',
  'updated',
  'aliases',
  'related',
  'sources',
  'confidence',
  'userEdited',
  'sourceClaimIds',
  'cites',
] as const;

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Spine scalars are strings on disk and in the type — a bare `title: 2026` is not a number. */
function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return fallback;
}

function asStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => asString(x)).filter((x) => x.length > 0);
  if (v === null || v === undefined) return [];
  const one = asString(v);
  return one ? [one] : [];
}

function asNumber(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : parseInt(asString(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

function asConfidence(v: unknown): WikiFrontmatter['confidence'] {
  const c = asString(v);
  return (CONFIDENCES.has(c) ? c : 'low') as WikiFrontmatter['confidence'];
}

/**
 * The vocabulary the pre-YAML parser knew, and the shape it read each key as. The legacy
 * path contributes THESE KEYS AND NOTHING ELSE: it reads line-by-line, so a nested block
 * (`cites:` with indented children) looks to it like flat junk keys (`s1`, `- ev`) — and
 * unknown keys persist now, so that junk would be written straight back to disk. Saving
 * the spine of a page YAML cannot read is the fallback's entire justification; carrying
 * invented keys is not part of it.
 */
const LEGACY_SCALAR_KEYS = new Set(['title', 'type', 'created', 'updated', 'sources', 'confidence', 'userEdited']);
const LEGACY_LIST_KEYS = new Set(['aliases', 'related', 'sourceClaimIds']);

/**
 * The pre-YAML line parser, kept as the fallback for pages already on disk. The old
 * serializer wrote scalars raw, so `title: Vestra: the company` is a real on-disk shape
 * and invalid YAML. Dropping that block would lose the `userEdited` pin and let the dream
 * overwrite a user-authored page — degrading means "read it the old way", not "forget it".
 * Per-key treatment, exactly as the old parser had it: the list keys read as lists, the
 * rest as raw scalars.
 */
function parseLegacyBlock(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of block.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1);
    if (LEGACY_LIST_KEYS.has(key)) out[key] = parseList(raw);
    else if (LEGACY_SCALAR_KEYS.has(key)) out[key] = parseScalar(raw);
  }
  return out;
}

/** Scalars are the only thing the spine can hold; a list or a map in their place is a reshape. */
function isScalar(v: unknown): boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/**
 * Some legacy raw-scalar lines are VALID YAML that means something else: `title: [Bash]`
 * parses to a list, `aliases: [Vestra: Bash, Sahil]` to a list holding a single-pair map.
 * Both coerce away to nothing on the way to the spine, so the value vanishes silently
 * rather than loudly — the whole-block fallback never fires because nothing threw.
 *
 * So where YAML handed back a SHAPE the key cannot hold, re-read that one key the legacy
 * way. Only shape is judged. A key YAML read as a plain scalar is left alone even where
 * the old parser would have kept more of the line (`title: Acme # 1 in sales` reads as
 * `Acme`, because `#` opens a YAML comment): that block is valid YAML, reading it as YAML
 * is the point of this codec, and "the strings differ" is not a signal — legitimate YAML
 * quoting and escaping differ from a raw line read all the time.
 */
function repairReshapedLegacyKeys(parsed: Record<string, unknown>, block: string): Record<string, unknown> {
  const reshaped = (key: string, v: unknown): boolean =>
    LEGACY_SCALAR_KEYS.has(key) ? !isScalar(v) : LEGACY_LIST_KEYS.has(key) && Array.isArray(v) && v.some((x) => !isScalar(x));

  const suspect = Object.keys(parsed).filter((k) => reshaped(k, parsed[k]));
  if (suspect.length === 0) return parsed;

  const legacy = parseLegacyBlock(block);
  const out = { ...parsed };
  for (const key of suspect) {
    const v = legacy[key];
    // Only take the legacy read when it actually recovered something.
    if (typeof v === 'string' ? v !== '' : Array.isArray(v) && v.length > 0) out[key] = v;
  }
  return out;
}

/** A frontmatter block → its key map. YAML first, legacy line parser on failure. Never throws. */
function parseFrontmatterBlock(block: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(block);
  } catch {
    return parseLegacyBlock(block);
  }
  if (isPlainObject(parsed)) return repairReshapedLegacyKeys(parsed, block);
  // Empty block => no keys. Anything else (a bare scalar, a list) is not frontmatter YAML,
  // so give the legacy parser its shot before giving up.
  return parsed === null || parsed === undefined ? {} : parseLegacyBlock(block);
}

/**
 * Split a page into its frontmatter map + markdown body. OPEN: every key the author wrote
 * survives, the spine keys coerced to their declared types and everything else carried
 * verbatim. Degrade-safe: no fences, a malformed block, or a non-mapping block all yield
 * the minimal spine with the body intact. Never throws.
 */
export function parsePage(raw: string): { frontmatter: PageFrontmatter; body: string } {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return { frontmatter: { title: '', type: 'concept', aliases: [], updated: '' }, body: raw };

  const [, block, rest] = match;
  const keys = parseFrontmatterBlock(block);

  const frontmatter: PageFrontmatter = {
    ...keys,
    title: asString(keys.title),
    type: asString(keys.type) || 'concept',
    aliases: asStringList(keys.aliases),
    updated: asString(keys.updated),
  };
  // Normalize the citation map's leaves so the declared type is true; a `cites` key of any
  // other shape stays exactly as written (the validator rules on it, the codec does not).
  if (isPlainObject(keys.cites)) {
    frontmatter.cites = Object.fromEntries(
      Object.entries(keys.cites).map(([marker, ids]) => [marker, asStringList(ids)]),
    );
  }

  return { frontmatter, body: rest.replace(/^\r?\n/, '') };
}

/**
 * Frontmatter + body back to page bytes. Spine keys first, then every other key in
 * insertion order; a key whose value is `undefined` is omitted entirely, so an absent
 * optional key round-trips back to absent. Real YAML quoting is the point: a wikilink
 * value (`[[x]]`) or a colon-bearing title comes back as the string it went in as.
 */
export function serializePage(page: { frontmatter: PageFrontmatter; body: string }): string {
  const fm = page.frontmatter;
  const ordered: Record<string, unknown> = {};
  for (const key of SPINE_KEYS) {
    if (fm[key] !== undefined) ordered[key] = fm[key];
  }
  for (const [key, value] of Object.entries(fm)) {
    if (!(key in ordered) && value !== undefined) ordered[key] = value;
  }
  // lineWidth 0 disables folding: a long value must stay on one line so the legacy
  // fallback parser can still read a page this serializer wrote.
  return `---\n${stringifyYaml(ordered, { lineWidth: 0 })}---\n${page.body}`;
}

/**
 * Parse a `pages/<slug>.md` file into a WikiArticle. A thin coercion layer over
 * `parsePage`: the wiki's own spine keys get their declared types, every other key
 * (including a page's open vocabulary) rides along untouched. Degrade-safe, never throws.
 */
export function parseArticle(md: string, slug: string): WikiArticle {
  const { frontmatter: base, body } = parsePage(md);
  const frontmatter: WikiFrontmatter = {
    ...base,
    created: asString(base.created),
    related: asStringList(base.related),
    sources: asNumber(base.sources),
    confidence: asConfidence(base.confidence),
    userEdited: base.userEdited === true || base.userEdited === 'true',
    // Provenance stays genuinely absent when the key is absent: a page with no
    // `sourceClaimIds` on disk means "no recorded provenance", which the kernel treats as
    // DIRTY (re-synth to gain provenance) and as ungrounded — never as an empty set.
    ...(base.sourceClaimIds === undefined ? {} : { sourceClaimIds: asStringList(base.sourceClaimIds) }),
  };
  return { slug, frontmatter, body };
}

/** Serialize a WikiArticle back to a `pages/<slug>.md` string. Round-trips with parseArticle. */
export function serializeArticle(a: WikiArticle): string {
  return serializePage(a);
}

// --- wikilinks + backlinks -----------------------------------------------

const CH_OPEN = 0x5b; // [
const CH_CLOSE = 0x5d; // ]
const CH_PIPE = 0x7c; // |

/**
 * One `[[…]]` marker, reported exactly as `/\[\[([^\]]+?)\]\]/g` reported it:
 * `index` is `m.index`, `length` is `m[0].length`, and `inner` is `m[1]` — RAW, neither
 * trimmed nor cut at a `|`. What a caller does with `inner` is the caller's own rule, and
 * the three callers differ: the kernel splits and trims, the gate splits and trims but
 * KEEPS an empty target, the filing splits into target AND label.
 */
export interface WikilinkMarker {
  index: number;
  length: number;
  inner: string;
}

/**
 * Every `[[…]]` marker in `body`, left to right, from ONE forward scan.
 *
 * This was `/\[\[([^\]]+?)\]\]/g`, which is O(bytes²) on a body carrying many `[[` that
 * never close: the engine retries from every `[[`, and at each one the lazy class expands
 * a character at a time to the end of the body. 1 MiB of `[` measured at 503 SECONDS for
 * a single page — the reconciler's whole 10-minute deadline, where an abort discards the
 * pass. Page bodies can be outsider-influenced (charter Law 9), so that was a reachable
 * shape, not a theoretical one.
 *
 * The scan reproduces the regex exactly, on three rules taken from the pattern:
 *  - a match is LEFTMOST and then CONSUMING. The engine tries each start offset in turn,
 *    so a `[[` that fails retries at the next one, and a `[[` that succeeds swallows
 *    everything through its closer — including any marker nested inside it.
 *  - the content class admits no `]`, so the closer is always the FIRST `]` at or after
 *    `open + 2`. A `]` not followed by another kills the match instead of being skipped.
 *  - the content needs at least one character, so `[[]]` is not a marker.
 *
 * Both cursors only move forward: `open` never rewinds, and the `]` lookup is cached
 * because the positions it is asked about are non-decreasing. A marker is materialized
 * only where a match is confirmed, and confirmed matches consume disjoint regions of the
 * body, so the copying is bounded by the page — never one candidate per opener.
 *
 * THE grammar, for every consumer of it. It is exported because three sites outside this
 * package carried their own byte-identical copy of the old pattern (the filing, the gate,
 * and — through `extractWikilinks` — this kernel), and a grammar kept in four places
 * drifts. The `[^\]|]` variant the wiki service and the web reader speak is a DIFFERENT
 * function (`[[a|]]` is a marker here and literal text there), so it is not served from
 * here and must not be folded in.
 */
export function scanWikilinkMarkers(body: string): WikilinkMarker[] {
  const out: WikilinkMarker[] = [];
  let closeIdx = -1; // first `]` at or after the last position asked about
  let i = 0;
  while (i < body.length) {
    const open = body.indexOf('[[', i);
    if (open === -1) break;
    const from = open + 2;
    if (closeIdx < from) closeIdx = body.indexOf(']', from);
    if (closeIdx === -1) break; // no `]` left in the body: no later `[[` can close either
    if (closeIdx > from && body.charCodeAt(closeIdx + 1) === CH_CLOSE) {
      out.push({ index: open, length: closeIdx + 2 - open, inner: body.slice(from, closeIdx) });
      i = closeIdx + 2; // the match is consumed, exactly as `lastIndex` did
    } else {
      i = open + 1; // no match here; the engine retries one offset along
    }
  }
  return out;
}

/**
 * Extract unique target slugs from `[[slug]]` / `[[slug|label]]` markers, in first-seen order.
 *
 * One left-to-right pass, linear in page bytes — the copying included; the pass itself is
 * `scanWikilinkMarkers`, and this adds only THIS caller's rule for a marker's bytes: cut at
 * the first `|`, trim, drop what trims to nothing, keep the first of each.
 */
export function extractWikilinks(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const marker of scanWikilinkMarkers(body)) {
    const target = marker.inner.split('|')[0].trim();
    if (target && !seen.has(target)) {
      seen.add(target);
      out.push(target);
    }
  }
  return out;
}

/**
 * Where each wanted target's first literal `[[target]]` / `[[target|label]]` marker
 * sits, from ONE left-to-right pass over the body.
 *
 * This replaces a fresh whole-body regex search per link — O(bytes × links) per page,
 * ~500M char-ops on a 1 MiB page, which burns the reconciler's fixed deadline and takes
 * the whole pass down with it.
 *
 * The indexes are the ones that search returned, exactly. For a `[[` at `open`, the
 * closing `]]` can only be the FIRST `]` at or after `open + 2` (neither the target nor
 * a label may contain `]`), and the target runs from there to the first `|` before that
 * closer, or to the closer itself. So each `[[` offers exactly one candidate target, and
 * the earliest offer wins. `[[` runs are kept as a list rather than one pending position
 * because a marker nested inside an unclosed one (`[[note [[acme]]`) is a match a
 * consuming scan would miss and search does not.
 *
 * Cutting the candidate at the first `|` is safe only because every member of `wanted`
 * comes from `extractWikilinks`, whose targets can contain neither `]` (the content class
 * excludes it) nor `|` (it splits there). A wanted target holding a `|` would silently
 * miss here, where the escaped literal regex used to match it.
 */
function firstMarkerIndexes(body: string, wanted: ReadonlySet<string>): Map<string, number> {
  const found = new Map<string, number>();
  if (wanted.size === 0) return found;
  // A candidate whose length no target has cannot match, and skipping it early keeps the
  // ordinary unclosed-`[[` page from re-introducing a quadratic in the slicing. It bounds
  // that case, not every case: a body of `[`-runs sharing one closer, plus many wanted
  // targets of DISTINCT lengths, still pays a slice per (opener x matching length), which
  // is Theta(bytes^1.5) at the worst. That needs crafted bracket soup — see the cost note
  // on deriveBacklinks below.
  const wantedLengths = new Set<number>();
  for (const t of wanted) wantedLengths.add(t.length);

  const opens: number[] = []; // `[[` starts since the last `]`, ascending
  const pipes: number[] = []; // `|` positions since the last `]`, ascending
  for (let i = 0; i < body.length; i++) {
    const ch = body.charCodeAt(i);
    if (ch === CH_OPEN) {
      if (body.charCodeAt(i + 1) === CH_OPEN) opens.push(i);
    } else if (ch === CH_PIPE) {
      pipes.push(i);
    } else if (ch === CH_CLOSE) {
      if (opens.length > 0 && body.charCodeAt(i + 1) === CH_CLOSE) {
        let p = 0;
        for (const open of opens) {
          const from = open + 2;
          while (p < pipes.length && pipes[p] < from) p++;
          const end = p < pipes.length ? pipes[p] : i;
          if (!wantedLengths.has(end - from)) continue;
          const target = body.slice(from, end);
          if (wanted.has(target) && !found.has(target)) found.set(target, open);
        }
      }
      // Any `]` ends every pending marker: a `[[` whose first `]` is not a closer can
      // never match, and one whose closer this is has just been offered.
      opens.length = 0;
      pipes.length = 0;
    }
  }
  return found;
}

function excerptAt(body: string, idx: number | undefined): string {
  if (idx === undefined) return body.slice(0, 120).trim();
  const start = Math.max(0, idx - 60);
  const end = Math.min(body.length, idx + 80);
  return `${start > 0 ? '…' : ''}${body.slice(start, end).replace(/\s+/g, ' ').trim()}${end < body.length ? '…' : ''}`;
}

/**
 * Map each linked slug to the pages that link it (with title + excerpt). Skips self-links.
 *
 * Keys are normalized via `slugify` so a Title-case wikilink target (e.g. Haiku
 * writing `[[Cached-tokens]]`) lands under the same key the article endpoint looks
 * up by (the lowercase URL slug). The excerpt still locates the RAW target so it
 * matches the literal `[[…]]` text in the body.
 *
 * WHAT COUNTS AS A SELF-LINK is decided by RESOLUTION, not by the key. The guard used
 * to compare `slugify(target)` — a flattening — against `page.slug`; on a filed brain
 * those are two alphabets that never meet (`zaf` vs `entities/people/zaf`), so every
 * page naming itself recorded itself among the pages pointing AT it. `buildWikiGraph`
 * hid its half of that (both ends resolve, so the self-edge is dropped), which left a
 * wrong row on disk for every other reader of this sidecar. Resolving the target is
 * the same rule the graph and the article endpoint already use.
 *
 * Cost per page is a fixed number of walks of the body, never one per link. Those walks
 * are linear on any body without runs of `[`: extraction is linear unconditionally, and
 * the marker walk's scanning is too. The one part that is not is the marker walk's
 * candidate slicing, which crafted bracket soup can push to Theta(bytes^1.5) — see the
 * length-prefilter note in `firstMarkerIndexes`. Ordinary prose and markdown never build
 * `[[` runs (`[text](url)` and single brackets do not), so on real pages this is linear.
 */
export function deriveBacklinks(pages: WikiArticle[]): Backlinks {
  const out: Backlinks = {};
  const resolve = wikiSlugResolver(pages.map((p) => p.slug));
  for (const page of pages) {
    const targets = extractWikilinks(page.body);
    if (targets.length === 0) continue;
    const markers = firstMarkerIndexes(page.body, new Set(targets));
    for (const target of targets) {
      const key = slugify(target);
      if (resolve(target)[0] === page.slug) continue;
      (out[key] ??= []).push({
        from: page.slug,
        title: page.frontmatter.title,
        excerpt: excerptAt(page.body, markers.get(target)),
      });
    }
  }
  return out;
}

// --- salience -------------------------------------------------------------

/**
 * Group ACTIVE claims by normalized subject; score = sources + distinct predicates;
 * return the top `max`, score-desc (stable by first-seen for ties). Pure.
 */
export function selectSalientSubjects(claims: Claim[], max: number): SalientSubject[] {
  const groups = new Map<string, { subject: string; claims: Claim[]; order: number }>();
  let order = 0;
  for (const c of claims) {
    if (!isActive(c)) continue;
    const key = norm(c.subject);
    let g = groups.get(key);
    if (!g) {
      g = { subject: c.subject.trim(), claims: [], order: order++ };
      groups.set(key, g);
    }
    g.claims.push(c);
  }

  const scored: (SalientSubject & { order: number })[] = [...groups.values()].map((g) => {
    const sourceCount = g.claims.reduce((n, c) => n + c.sources.length, 0);
    const distinctPredicates = new Set(g.claims.map((c) => norm(c.predicate))).size;
    return { subject: g.subject, claims: g.claims, score: sourceCount + distinctPredicates, order: g.order };
  });

  scored.sort((a, b) => (b.score - a.score) || (a.order - b.order));
  return scored.slice(0, Math.max(0, max)).map(({ subject, claims: cs, score }) => ({ subject, claims: cs, score }));
}

// --- derived dirtiness + provenance + prune + grounding -------------------

/**
 * Stable, dependency-free 32-bit string hash (FNV-1a). Deterministic across runs
 * and processes — same input string always yields the same hex digest. Used only
 * to compare two claim-sets for equality, never for cryptographic purposes.
 */
function stableHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // >>> 0 → unsigned; pad so the digest length is stable.
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** A provenance entry is `<claimId>` or `<claimId>:<confidence>`. Strip to the bare id. */
function provId(entry: string): string {
  const idx = entry.indexOf(':');
  return idx === -1 ? entry : entry.slice(0, idx);
}

/** Encode one claim as a provenance entry `<id>:<confidence>` (the set-hash atom). */
function provEntry(c: Claim): string {
  return `${c.id}:${c.confidence}`;
}

/**
 * Stable hash of the SORTED `<id>:<confidence>` atoms of a claim set. Order-independent
 * (we sort before hashing) so the same active set always hashes the same. Encodes
 * confidence so a pure reweight (same ids, new weight) changes the hash.
 */
export function claimSetHash(claims: Claim[]): string {
  const atoms = claims.map(provEntry).sort();
  return stableHash(atoms.join('\n'));
}

/** Build a slug → its ACTIVE claims map (subject grouped via slugify). */
function activeClaimsBySlug(claims: Claim[]): Map<string, Claim[]> {
  const out = new Map<string, Claim[]>();
  for (const c of claims) {
    if (!isActive(c)) continue;
    const slug = slugify(c.subject);
    let arr = out.get(slug);
    if (!arr) {
      arr = [];
      out.set(slug, arr);
    }
    arr.push(c);
  }
  return out;
}

export interface DirtySubjects {
  /** slugs to re-synthesize (changed active-claim set or missing article). */
  resynth: string[];
  /** slugs whose subject now has ZERO active claims and is not userEdited → delete. */
  remove: string[];
}

/**
 * DERIVED dirtiness — no stored dirty-bit. A subject (keyed by its slug) is `resynth` when:
 *   1. it has active claims but NO article exists yet; OR
 *   2. the hash of its active-claim `{id, confidence}` set differs from the article's
 *      recorded set (the `sourceClaimIds` provenance, which encodes confidence).
 *
 * Cross-subject citation staleness (an article that cites a `sourceClaimId` retired by a
 * contradiction elsewhere) is fully SUBSUMED by branch 2: a retired cited id is, by
 * definition, absent from its subject's current active set, so the active set-hash already
 * differs from the recorded set-hash. There is no input — given unique claim ids — where a
 * page's recorded set still hash-equals its subject's active set yet cites a globally-dead
 * id, so no separate provenance-scan branch is needed (and one would be unreachable).
 *
 * A slug is `remove` when its subject has zero active claims and the page is not `userEdited`.
 * Pure + domain-agnostic: no entity-type / keyword logic anywhere.
 */
export function selectDirtySubjects(
  claims: Claim[],
  articles: WikiArticle[],
  _now: string,
): DirtySubjects {
  const activeBySlug = activeClaimsBySlug(claims);

  const bySlug = new Map<string, WikiArticle>();
  for (const a of articles) bySlug.set(a.slug, a);

  const resynth: string[] = [];
  const seenResynth = new Set<string>();
  const markResynth = (slug: string): void => {
    if (seenResynth.has(slug)) return;
    seenResynth.add(slug);
    resynth.push(slug);
  };

  // 1 + 2: walk every subject that currently has active claims.
  for (const [slug, subjectClaims] of activeBySlug) {
    const article = bySlug.get(slug);
    if (!article) {
      markResynth(slug); // no article yet
      continue;
    }
    if (article.frontmatter.userEdited) continue; // pinned — never auto-touch

    // Absent/undefined provenance (legacy or pre-provenance pages) → recorded is the
    // empty set, which can never hash-equal a subject that still has active claims, so
    // the page is correctly flagged DIRTY (re-synth to gain provenance). Never throws.
    const recorded = article.frontmatter.sourceClaimIds ?? [];
    const recordedHash = stableHash([...recorded].sort().join('\n'));
    const activeHash = claimSetHash(subjectClaims);
    if (recordedHash !== activeHash) {
      markResynth(slug); // set-hash mismatch (subsumes cross-subject citation staleness)
    }
  }

  // remove pass: articles whose subject has zero active claims.
  const remove: string[] = [];
  for (const a of articles) {
    if (a.frontmatter.userEdited) continue;
    if ((activeBySlug.get(a.slug)?.length ?? 0) === 0) {
      remove.push(a.slug);
    }
  }

  return { resynth, remove };
}

export interface PrunedArticles {
  keep: WikiArticle[];
  removedSlugs: string[];
}

/**
 * Drop articles whose subject now has ZERO active claims (orphans), preserving `userEdited`
 * pins. Pure. Mirrors `selectDirtySubjects(...).remove` but returns the surviving page set.
 */
export function pruneOrphanArticles(articles: WikiArticle[], claims: Claim[]): PrunedArticles {
  const activeBySlug = activeClaimsBySlug(claims);
  const keep: WikiArticle[] = [];
  const removedSlugs: string[] = [];
  for (const a of articles) {
    const hasActive = (activeBySlug.get(a.slug)?.length ?? 0) > 0;
    if (hasActive || a.frontmatter.userEdited) {
      keep.push(a);
    } else {
      removedSlugs.push(a.slug);
    }
  }
  return { keep, removedSlugs };
}

const CITATION_RE = /\[s[_]?\d+\]/;

/**
 * Grounding (R4): true iff the body carries at least one `[s_n]` citation marker AND at
 * least one of the article's recorded `sourceClaimIds` resolves to a claim that is active
 * now. The single-call projection cannot attribute each marker to a specific claim id, so
 * the contract is "cited AND ≥1 source still live" — not per-bullet attribution.
 */
export function validateGrounding(article: WikiArticle, claims: Claim[]): boolean {
  if (!CITATION_RE.test(article.body)) return false;
  const activeIds = new Set<string>();
  for (const c of claims) if (isActive(c)) activeIds.add(c.id);
  // Absent/undefined provenance → empty recorded set → no source can be live → ungrounded.
  const recorded = article.frontmatter.sourceClaimIds ?? [];
  return recorded.some((entry) => activeIds.has(provId(entry)));
}

// --- index ----------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Did this article change in the day before `now`? The rule `newCount` and
 * `changesToday` are BOTH counted with, exported because a reading surface that folds
 * the index (continuations are plumbing, not pages) has to recount over what survives
 * the fold — and a second definition of "new today" is a second answer. Unparseable
 * either side ⇒ not new.
 */
export function isNewArticle(updated: string, now: string): boolean {
  const u = Date.parse(updated);
  const n = Date.parse(now);
  if (!Number.isFinite(u) || !Number.isFinite(n)) return false;
  return n - u <= DAY_MS && n - u >= 0;
}

function categoryLabel(type: string): string {
  if (!type) return 'Other';
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/** Group pages by `type` into categories; newCount = updated within 24h of `now`. Pure. */
export function buildIndex(pages: WikiArticle[], now: string): WikiIndex {
  const byType = new Map<string, WikiCategory>();
  let changesToday = 0;
  const pinned: string[] = [];

  for (const page of pages) {
    const type = page.frontmatter.type || 'concept';
    let cat = byType.get(type);
    if (!cat) {
      cat = { type, label: categoryLabel(type), count: 0, newCount: 0, articles: [] };
      byType.set(type, cat);
    }
    cat.count += 1;
    cat.articles.push({ slug: page.slug, title: page.frontmatter.title, updated: page.frontmatter.updated });
    const fresh = isNewArticle(page.frontmatter.updated, now);
    if (fresh) {
      cat.newCount += 1;
      changesToday += 1;
    }
    if (page.frontmatter.userEdited) pinned.push(page.slug);
  }

  const categories = [...byType.values()].sort((a, b) => (b.count - a.count) || (a.type < b.type ? -1 : 1));
  for (const cat of categories) {
    cat.articles.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  }

  return {
    generatedAt: now,
    totalArticles: pages.length,
    changesToday,
    categories,
    pinned,
  };
}

// --- slug resolution ------------------------------------------------------

/**
 * The last path segment — the name a filed page keeps as it moves between folders.
 *
 * EXPORTED because it is the same rule on both sides of the wire: the resolver below
 * compares basenames with it, and the server's reader spells the user-edit overlay key
 * with it. Two copies of "the name a page keeps" is how the graph and the article
 * endpoint came to disagree about one link in the first place.
 */
export function slugBasename(slug: string): string {
  return slug.slice(slug.lastIndexOf('/') + 1);
}

/** Push `at` onto the list `key` names, creating it on first sight. */
function pushAt(index: Map<string, number[]>, key: string, at: number): void {
  const list = index.get(key);
  if (list) list.push(at);
  else index.set(key, [at]);
}

/** Two ascending position lists, merged into one ascending list. */
function mergeAscending(a: number[] | undefined, b: number[] | undefined): number[] | undefined {
  if (!a) return b;
  if (!b) return a;
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) out.push(a[i]! <= b[j]! ? a[i++]! : b[j++]!);
  while (i < a.length) out.push(a[i++]!);
  while (j < b.length) out.push(b[j++]!);
  return out;
}

/**
 * The wiki's slug resolution, stated ONCE: given every page slug the index lists, say
 * which pages a link target names.
 *
 * THREE PASSES, in index order — the path as filed, the bare basename (raw or
 * flattened), then the flattened form an older writer produces. The FIRST pass that
 * answers wins outright; a later pass is never consulted for a target an earlier one
 * matched. This is the read endpoints' resolution: `resolveWikiPage`
 * (apps/server/.../nami-wiki-reader.ts) calls this function rather than restating it,
 * because two copies of this semantic is exactly how the graph and the article endpoint
 * came to disagree about the same link.
 *
 * EVERY page the target names, in index order, not just the first — because "more than
 * one" is a fact the caller must be able to see. The graph takes `[0]` (the answer a
 * single index-order scan would have given); the reader reports the whole list as an
 * ambiguity, since those pages share one user-edit overlay row. A target the index does
 * not list answers `[]` — the caller decides what an unknown target is called.
 *
 * PREBUILT maps, not a scan per target: P pages answer E targets in O(P + E) plus the
 * hits, which is what a whole-brain graph needs.
 */
export function wikiSlugResolver(pageSlugs: Iterable<string>): (target: string) => string[] {
  const all: string[] = [];
  const exact = new Set<string>();
  const byBasename = new Map<string, number[]>();
  const byFlat = new Map<string, number[]>();
  for (const slug of pageSlugs) {
    const at = all.length;
    all.push(slug);
    exact.add(slug);
    pushAt(byBasename, slugBasename(slug), at);
    pushAt(byFlat, slugify(slug), at);
  }

  const slugsAt = (positions: number[] | undefined): string[] => (positions ?? []).map((i) => all[i]!);

  return (target: string): string[] => {
    if (exact.has(target)) return [target];
    const flat = slugify(target);
    // One page has one basename, so `target` and `flat` name disjoint lists — merging
    // them by position is the index-order scan `p.basename === target || === flat` is.
    const named = target === flat ? byBasename.get(flat) : mergeAscending(byBasename.get(target), byBasename.get(flat));
    if (named && named.length > 0) return slugsAt(named);
    return slugsAt(byFlat.get(flat));
  };
}

// --- synthesizeWiki orchestration ----------------------------------------

/**
 * The pure synthesis orchestration: select the top-`max` salient subjects, run the
 * injected synthesizer per subject, merge over existing pages, and build the index
 * + backlinks. Degrade-safe:
 *   - existing `userEdited` pages are kept verbatim (the pin rule) and never re-synthesized;
 *   - a synth that throws drops ONLY that subject (the rest still ship);
 *   - re-synthesized pages preserve the existing page's `created` date;
 *   - subjects beyond `max` are reported as `deferred` (no silent caps).
 */
export interface SynthesizeWikiOptions {
  /**
   * Incremental dirty filter (C2): when present, only subjects whose slug is in `resynth`
   * are re-synthesized; every other existing page is kept verbatim. Absent → full pass
   * (back-compat: synth all salient candidates up to `max`).
   */
  dirtyFilter?: { resynth: Set<string> };
  /**
   * Full existing+salient slug set offered to the synthesizer as wikilink candidates, so a
   * re-synthed article keeps links to UNCHANGED neighbors it would otherwise drop (M5).
   * Absent → derived from the salient set only (legacy behavior).
   */
  candidateSlugs?: string[];
  /**
   * RECENCY-FIRST ordering (R3): when set, the synthesis candidates are ordered by each
   * subject's NEWEST active-claim `observedAt` (descending) so the user sees what they
   * just learned first; ties (and subjects sharing a recency timestamp) fall back to
   * salience order. Absent → pure salience order (legacy). The `max` cap is applied to
   * this reordered set, so when more subjects are dirty than the cap, the FRESHEST ones
   * are synthesized and the stalest are deferred. Domain-agnostic: keyed only on
   * observedAt, never on entity type.
   */
  recencyFirst?: boolean;
}

/** Newest active-claim `observedAt` for a salient subject (its recency key). */
function subjectRecency(s: SalientSubject): string {
  let newest = '';
  for (const c of s.claims) {
    if (isActive(c) && c.observedAt > newest) newest = c.observedAt;
  }
  return newest;
}

export async function synthesizeWiki(
  existingPages: WikiArticle[],
  claims: Claim[],
  synth: WikiSynthesizer,
  now: string,
  max: number,
  options: SynthesizeWikiOptions = {},
): Promise<SynthesizeWikiResult> {
  const { dirtyFilter, candidateSlugs, recencyFirst } = options;

  const bySlug = new Map<string, WikiArticle>();
  for (const page of existingPages) bySlug.set(page.slug, page);

  // `selectSalientSubjects` returns salience-desc order (stable by first-seen for ties).
  const salient = selectSalientSubjects(claims, Number.MAX_SAFE_INTEGER);
  const filtered = salient.filter((s) => {
    const slug = slugify(s.subject);
    const existing = bySlug.get(slug);
    if (existing && existing.frontmatter.userEdited) return false; // pin rule
    // incremental: only re-synth subjects the caller marked dirty.
    if (dirtyFilter && !dirtyFilter.resynth.has(slug)) return false;
    return true;
  });

  // RECENCY-FIRST (R3): stable-sort the salience-ordered set by newest active-claim
  // observedAt (descending) so the freshest subjects win the `max` budget; salience
  // remains the tiebreak (the array was salience-ordered before this stable sort).
  const candidates = recencyFirst
    ? filtered
        .map((s, i) => ({ s, i, recency: subjectRecency(s) }))
        .sort((a, b) => (a.recency < b.recency ? 1 : a.recency > b.recency ? -1 : a.i - b.i))
        .map((x) => x.s)
    : filtered;

  const toSynth = candidates.slice(0, Math.max(0, max));
  const deferred = candidates.length - toSynth.length;

  // Wikilink candidates: prefer the caller's FULL existing+salient set so re-synthed pages
  // keep links to unchanged neighbors; fall back to the salient set (legacy).
  const relatedSlugs =
    candidateSlugs && candidateSlugs.length > 0
      ? [...new Set(candidateSlugs.map((s) => slugify(s)))]
      : salient.map((s) => slugify(s.subject));

  for (const subject of toSynth) {
    const slug = slugify(subject.subject);
    const existing = bySlug.get(slug);
    try {
      const result = await synth.synthesize({
        subject: subject.subject,
        claims: subject.claims,
        related: relatedSlugs.filter((r) => r !== slug),
        now,
      });
      const created = existing?.frontmatter.created || result.frontmatter.created || now;
      // Stamp provenance: the active-claim {id, confidence} set this page was synthesized
      // from — drives derived dirtiness + grounding on the next pass.
      const sourceClaimIds = subject.claims.map((c) => `${c.id}:${c.confidence}`).sort();
      bySlug.set(slug, {
        slug,
        frontmatter: { ...result.frontmatter, created, updated: now, sourceClaimIds },
        body: result.body,
      });
    } catch {
      // Drop just this subject — keep any existing page for it untouched.
    }
  }

  const pages = [...bySlug.values()].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const index = buildIndex(pages, now);
  const backlinks = deriveBacklinks(pages);

  return { pages, index, backlinks, deferred };
}
