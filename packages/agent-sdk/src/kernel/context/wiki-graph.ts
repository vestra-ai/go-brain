// nami Wiki — the derived LINK GRAPH + its lint pass.
//
// Split out of ./wiki.js, which is at its file-size ratchet: the graph is a pure
// consumer of that module's index, backlinks and slug resolution, so it moves as a
// whole and the kernel's barrel re-exports it. Nothing imports this module directly —
// `@vestra/agent-sdk` is the door, exactly as before the split.
//
// PURE + deterministic, no I/O. Both the server's read endpoint and the synthesis pass
// build on it.

import { slugify, wikiSlugResolver, type Backlinks, type WikiIndex } from './wiki.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A node in the wiki graph: a known article, or a `missing` link target. */
export interface WikiGraphNode {
  slug: string;
  title: string;
  type: string;
  inDegree: number;
  outDegree: number;
  /** true when this node is a wikilink target with no article yet. */
  missing: boolean;
}

/** A directed edge slug → slug (both endpoints spelled as the index names the page). */
export interface WikiGraphEdge {
  from: string;
  to: string;
}

/** Health signals over the link graph. */
export interface WikiLint {
  /** edges whose target has no article. */
  dangling: { from: string; to: string }[];
  /** known slugs with no inbound and no outbound edges. */
  orphans: string[];
  /** known slugs whose `updated` is more than `staleDays` older than `now`. */
  stale: string[];
}

export interface WikiGraph {
  nodes: WikiGraphNode[];
  edges: WikiGraphEdge[];
  lint: WikiLint;
}

interface KnownNode {
  slug: string;
  title: string;
  type: string;
  updated: string;
}

/**
 * Build the directed link graph + a lint pass from the derived index + backlinks.
 *
 * PURE + deterministic. Both ends of every edge are RESOLVED against the index through
 * `wikiSlugResolver` — the same three passes the reader resolves a slug with — then
 * deduped, with self-edges dropped. That resolution is the whole difference between a
 * graph and a pile: on a FILED brain the index names a page by typed path
 * (`entities/people/zaf`) while `deriveBacklinks` keys its targets through `slugify`
 * (`entities-people-zaf`) and records `from` as the writer's typed path, so flattening
 * both on read made every edge miss every node — every link dangling, every page an
 * orphan. On a flat brain, whose index slugs are slug-stable, resolution can only ever
 * answer `slugify(target)` — the graph is byte-identical to before.
 *
 * A target NO page answers keeps the flattened spelling and becomes a `missing` node
 * plus a `dangling` lint entry — a genuinely dangling link, as before. Aliases are not
 * consulted: they live in a page's frontmatter, never in the index. Orphans = known
 * slugs with zero in + zero out. Stale = known slugs whose `updated` is older than
 * `staleDays` (unparseable → not stale). Nothing here throws; degrade-safe on a sparse
 * or empty index.
 */
export function buildWikiGraph(
  index: WikiIndex,
  backlinks: Backlinks,
  now: string,
  staleDays = 30,
): WikiGraph {
  // 1. known slugs from the index categories
  const known = new Map<string, KnownNode>();
  for (const cat of index.categories) {
    for (const a of cat.articles) {
      if (!known.has(a.slug)) {
        known.set(a.slug, { slug: a.slug, title: a.title, type: cat.type, updated: a.updated });
      }
    }
  }

  // 2. edges from backlinks, deduped, no self-edges. Each endpoint is resolved to the
  //    page the index files it under; only a target no page answers keeps the flattened
  //    spelling, which is what a genuinely dangling link is called.
  const resolve = wikiSlugResolver(known.keys());
  // The FIRST page the target names — the answer an index-order scan gives. Where two
  // pages answer, the graph draws one edge and the reader is what reports the ambiguity.
  const nameOf = (raw: string): string => resolve(raw)[0] ?? slugify(raw);
  const edges: WikiGraphEdge[] = [];
  const seenEdge = new Set<string>();
  for (const [rawKey, sources] of Object.entries(backlinks)) {
    const to = nameOf(rawKey);
    for (const src of sources) {
      const from = nameOf(src.from);
      if (from === to) continue;
      // A separator no slug can contain, so two edges cannot share a key by
      // accident. Written as an ESCAPE: a literal NUL in the source makes the
      // whole file binary to git and to grep, which cost the last reader of this
      // module real time.
      const id = `${from}\u0000${to}`;
      if (seenEdge.has(id)) continue;
      seenEdge.add(id);
      edges.push({ from, to });
    }
  }

  // 3. degrees + missing-target discovery
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  const missing = new Map<string, true>();
  const dangling: { from: string; to: string }[] = [];
  for (const e of edges) {
    outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
    if (!known.has(e.to)) {
      missing.set(e.to, true);
      dangling.push({ from: e.from, to: e.to });
    }
  }

  // 4. nodes: known articles + missing targets
  const nodes: WikiGraphNode[] = [];
  for (const k of known.values()) {
    nodes.push({
      slug: k.slug,
      title: k.title,
      type: k.type,
      inDegree: inDeg.get(k.slug) ?? 0,
      outDegree: outDeg.get(k.slug) ?? 0,
      missing: false,
    });
  }
  for (const slug of missing.keys()) {
    nodes.push({
      slug,
      title: slug,
      type: 'missing',
      inDegree: inDeg.get(slug) ?? 0,
      outDegree: outDeg.get(slug) ?? 0,
      missing: true,
    });
  }

  // 5. orphans + stale (over known slugs only)
  const orphans: string[] = [];
  const stale: string[] = [];
  const nowMs = Date.parse(now);
  const staleMs = staleDays * DAY_MS;
  for (const k of known.values()) {
    if ((inDeg.get(k.slug) ?? 0) === 0 && (outDeg.get(k.slug) ?? 0) === 0) {
      orphans.push(k.slug);
    }
    const u = Date.parse(k.updated);
    if (Number.isFinite(u) && Number.isFinite(nowMs) && nowMs - u > staleMs) {
      stale.push(k.slug);
    }
  }

  return { nodes, edges, lint: { dangling, orphans, stale } };
}
