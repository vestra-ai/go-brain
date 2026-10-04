/**
 * Deterministic-first entity resolution for wiki page identity (the Zep cascade,
 * scaled to our corpus): normalized exact match → trigram-Jaccard fuzzy with an
 * entropy gate → unmatched (caller mints a fresh page). No LLM anywhere: the
 * editor never gets the chance to create `user` and `the-user` side by side.
 */

const FUZZY_JACCARD_THRESHOLD = 0.55;
const MIN_ENTROPY_LEN = 6; // names shorter than this never fuzzy-match

export function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) grams.add(padded.slice(i, i + 3));
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function resolveWikiSlug(
  candidate: string,
  existingSlugs: string[],
): { slug: string; matched: boolean } {
  const norm = normalize(candidate);
  const asSlug = slugifyName(candidate);

  // Tier 1: normalized exact — candidate normalizes to an existing slug's name form.
  for (const slug of existingSlugs) {
    if (normalize(slug.replace(/-/g, ' ')) === norm || slug === asSlug) {
      return { slug, matched: true };
    }
  }

  // Entropy gate: short names are too ambiguous to fuzzy-match.
  if (norm.replace(/\s/g, '').length < MIN_ENTROPY_LEN) return { slug: asSlug, matched: false };

  // Tier 2: trigram Jaccard against each existing slug's name form. Containment
  // counts too: "keshav musunuri user s role" ⊃ "keshav musunuri".
  const candGrams = trigrams(norm);
  let best: { slug: string; score: number } | null = null;
  for (const slug of existingSlugs) {
    const name = normalize(slug.replace(/-/g, ' '));
    if (name.replace(/\s/g, '').length < MIN_ENTROPY_LEN) continue;
    const score = norm.includes(name) || name.includes(norm)
      ? 1
      : jaccard(candGrams, trigrams(name));
    if (score >= FUZZY_JACCARD_THRESHOLD && (best === null || score > best.score)) {
      best = { slug, score };
    }
  }
  if (best) return { slug: best.slug, matched: true };
  return { slug: asSlug, matched: false };
}
