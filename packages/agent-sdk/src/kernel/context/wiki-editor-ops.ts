/**
 * Vestrapedia v2 editor — the operation vocabulary the GLM editor emits and the
 * deterministic validator the apply layer runs BEFORE any filesystem write.
 * Validation is code, not model judgment: taxonomy is closed, slugs are jailed
 * to the pages dir, bodies must carry at least one citation, one op per slug.
 *
 * This is the LEGACY, slug-keyed vocabulary. It still runs the Phase 1 editor
 * pass and stays until that pass retires. The Phase 2 vocabulary is keyed by
 * path (the folder is the type) and lives in `@bash/shared`
 * (`src/nami/brain-page-ops.ts`), beside the path grammar it enforces — this
 * package deliberately does not depend on `@bash/shared`, so it could not
 * enforce that grammar from here. Both validate; neither knows about the other.
 */

export const WIKI_CATEGORIES = [
  'person', 'organization', 'project', 'preference', 'decision', 'topic', 'routine',
] as const;
// Named EditorCategory (not WikiCategory) — ./wiki.ts already exports an unrelated
// `WikiCategory` (a category-grouping struct for the read side); this is the closed
// taxonomy an editor op's `category` field is drawn from, so it shares the Editor*
// naming with EditorOp/EditorPassPlan instead of colliding at the barrel export.
export type EditorCategory = (typeof WIKI_CATEGORIES)[number];

export type EditorOp =
  | { kind: 'create'; slug: string; title: string; category: EditorCategory; body: string }
  | { kind: 'rewrite'; slug: string; title: string; category: EditorCategory; body: string }
  | { kind: 'merge'; into: string; from: string }
  | { kind: 'delete'; slug: string };

export interface EditorPassPlan {
  ops: EditorOp[];
}

// No '/' in the slug alphabet: pages are a FLAT directory (readExistingPages and the
// sidecars only see top-level files, so a nested slug would write an invisible page
// or ENOENT-abort the apply).
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;
const CITE_RE = /\[s\d+\]/;
/** The closed op vocabulary — anything else is rejected before any other check. */
const OP_KINDS = new Set<string>(['create', 'rewrite', 'merge', 'delete']);

export function validateEditorOps(
  plan: EditorPassPlan,
  existingSlugs: string[],
): { valid: EditorOp[]; rejected: { op: EditorOp; reason: string }[] } {
  const existing = new Set(existingSlugs);
  const touched = new Set<string>();
  // `mergedFrom` tracks slugs already retired by a merge (a slug can only be
  // retired once); `written` tracks slugs already created/rewritten in this
  // plan (a slug just written can't also be retired by a merge in the same
  // pass). The two sets cross-check each other regardless of which op comes
  // first. `delete` is exempt on both sides: deleting a merge-from slug is
  // the mandated cleanup step, not a competing write.
  const mergedFrom = new Set<string>();
  const written = new Set<string>();
  const valid: EditorOp[] = [];
  const rejected: { op: EditorOp; reason: string }[] = [];

  for (const op of plan.ops ?? []) {
    // Closed kind vocabulary FIRST: a malformed op ({}, or a bogus kind carrying
    // plausible fields) must be rejected before any other check so it can never
    // consume an op-cap slot downstream.
    if (!op || typeof op !== 'object' || !OP_KINDS.has((op as { kind?: unknown }).kind as string)) {
      rejected.push({ op, reason: 'unknown kind' });
      continue;
    }
    const slugs = op.kind === 'merge' ? [op.into, op.from] : [op.slug];
    const badSlug = slugs.find((s) => !SLUG_RE.test(s) || s.includes('..'));
    if (badSlug !== undefined) { rejected.push({ op, reason: `bad slug: ${badSlug}` }); continue; }

    if ((op.kind === 'create' || op.kind === 'rewrite') && !WIKI_CATEGORIES.includes(op.category)) {
      rejected.push({ op, reason: `unknown category: ${String(op.category)}` }); continue;
    }
    if ((op.kind === 'create' || op.kind === 'rewrite') && !CITE_RE.test(op.body)) {
      rejected.push({ op, reason: 'body carries no [sN] citation' }); continue;
    }
    if (op.kind === 'rewrite' && !existing.has(op.slug)) { rejected.push({ op, reason: 'rewrite of nonexistent slug' }); continue; }
    if (op.kind === 'delete' && !existing.has(op.slug)) { rejected.push({ op, reason: 'delete of nonexistent slug' }); continue; }
    if (op.kind === 'merge' && (!existing.has(op.into) || !existing.has(op.from))) {
      rejected.push({ op, reason: 'merge references nonexistent slug' }); continue;
    }

    // A merge doesn't write a page of its own: a preceding rewrite may already own
    // `into`'s content, and `from` is retired by the apply layer, not superseded by
    // a competing page write. So merges sit outside the one-write-per-slug `touched`
    // dedup that guards create/rewrite/delete against colliding on the same slug —
    // but a `from` slug can still only be retired once, and can't be retired in the
    // same pass it was just created/rewritten in, so merges get their own checks.
    if (op.kind === 'merge') {
      if (mergedFrom.has(op.from)) { rejected.push({ op, reason: `duplicate merge from ${op.from}` }); continue; }
      if (written.has(op.from)) { rejected.push({ op, reason: `slug ${op.from} is being retired by a merge` }); continue; }
      mergedFrom.add(op.from);
      valid.push(op);
      continue;
    }

    if ((op.kind === 'create' || op.kind === 'rewrite') && mergedFrom.has(op.slug)) {
      rejected.push({ op, reason: `slug ${op.slug} is being retired by a merge` }); continue;
    }

    if (touched.has(op.slug)) { rejected.push({ op, reason: `duplicate op for slug ${op.slug}` }); continue; }
    touched.add(op.slug);
    if (op.kind === 'create' || op.kind === 'rewrite') { written.add(op.slug); }
    valid.push(op);
  }
  return { valid, rejected };
}
