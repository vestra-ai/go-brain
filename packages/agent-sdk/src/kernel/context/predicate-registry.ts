// nami brain v2 — controlled predicate vocabulary (§G semantic-key foundation).
//
// DEDUP-CANONICALIZATION LAYER ONLY. This module does NOT restrict what the brain
// may emit or store: the claim ledger stays OPEN vocabulary (founder directive — no
// fixed categories). All this does is map known surface forms of a predicate/entity
// to a canonical key, used SOLELY to detect "same relation, reworded" so the claim
// merge can dedup on `semanticKey(subject, predicate)`.
//
// An UNKNOWN predicate is never dropped or rejected — it falls back to its own
// normalized form (lowercase + collapsed whitespace + stripped trailing
// punctuation). It just doesn't alias-merge with anything. Same openness for
// entities. Keep PREDICATE_ALIASES small and curated: the obvious clusters only.
//
// The embeddings-based canonicalizer is Slice 4.5; this cheap, no-embeddings
// artifact is born here and consumed there (and by Task 3's mergeClaim).

export const PREDICATE_VOCAB_VERSION = 1;

/**
 * Curated surface-form -> canonical-key map. Keys are already in normalized form
 * (lowercase, single-spaced, no trailing punctuation) so a normalized lookup hits.
 * Deliberately tiny: only the obvious reworded clusters. Anything not here falls
 * back to its normalized self (open vocab preserved).
 */
export const PREDICATE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // employment
  'works at': 'employed_by',
  'employed by': 'employed_by',
  'employer is': 'employed_by',
  // NOTE: no 'is a'/'is an'/'is' cluster — folding type predicates collapses two
  // coexisting TYPE facts about one subject (e.g. 'is a cardiologist' + 'is an
  // oncologist') onto one semanticKey, so the second wrongly SUPERSEDES the first.
  // Type-facts legitimately coexist, so each falls back to its normalized self.
  // deadlines
  'deadline is': 'has_deadline',
  'has deadline': 'has_deadline',
  due: 'has_deadline',
  // preferences
  prefers: 'prefers',
  likes: 'prefers',
});

/** lowercase + collapse whitespace + trim + strip trailing punctuation. */
function normalizePredicate(p: string): string {
  return p
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:!?]+$/, '')
    .trim();
}

/**
 * Map a surface predicate to its canonical key. Known surface forms alias-merge
 * (e.g. 'works at' / 'employed by' -> 'employed_by'); ANY unknown predicate falls
 * back to its normalized self (never dropped — open vocab stays open).
 */
export function canonicalPredicate(p: string): string {
  const norm = normalizePredicate(p);
  return Object.hasOwn(PREDICATE_ALIASES, norm) ? PREDICATE_ALIASES[norm] : norm;
}

/**
 * Canonicalize an entity surface form: lowercase, collapse whitespace, strip a
 * leading article/project marker ('the '/'project '/'a '), strip a trailing
 * possessive ("'s" or "'"), trim. NO embeddings — purely lexical, dedup-only.
 */
export function canonicalEntity(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:the|project|a) /, '')
    .replace(/'s?$/, '')
    .trim();
}

/**
 * The semantic key used to detect "same (subject, predicate)" across rewordings.
 * Consumed by claim merge to dedup on relation identity rather than exact strings.
 */
export function semanticKey(subject: string, predicate: string): string {
  return `${canonicalEntity(subject)}|${canonicalPredicate(predicate)}`;
}
