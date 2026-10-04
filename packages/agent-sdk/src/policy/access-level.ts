/**
 * ACCESS LEVELS — the four human dials (permissions v2, spec §1).
 *
 *   Careful   — asks before anything that makes a change.
 *   Balanced  — works freely in the workspace, asks before acting on the outside world.
 *   Relaxed   — asks only for payments and deletions (the default; ≡ today's floor).
 *   Autopilot — runs everything on its own; payments still ask, and so does a
 *               rewrite or delete of shared git history (a force push, a remote
 *               branch delete: git-command-catalog).
 *
 * A tool call is classified into ONE side-effect family (side-effect-classifier),
 * then this module decides ask vs run. The ask decision is split in TWO, and the
 * SPLIT is load-bearing (spec §2.2):
 *
 *   - hardFloors  — payments and protected git actions (always) + dangerous deletes
 *     (below Autopilot). These
 *     sit ABOVE allow rules in the ladder: NO Always-allow can silence them.
 *   - levelAsks   — the SOFT floor (workspace_write at Careful; external send +
 *     mutation at Careful/Balanced). These sit BELOW allow rules, so an
 *     Always-allow grant decays the prompt.
 *
 * The two are DISJOINT by construction: `levelAsks` returns false for every
 * hard-floor family, so no family is ever gated twice. The COMPOSED verdict
 * (`hardFloors(f,l) || levelAsks(f,l)`) reproduces the §1.1 table exactly — the
 * access-level.test.ts matrix pins both halves and their composition.
 *
 * PURE / TOTAL. No I/O, no state.
 */

import type { SideEffectFamily } from './side-effect-classifier.js';

export type AccessLevel = 'careful' | 'balanced' | 'relaxed' | 'autopilot';

/**
 * The four levels in STRICTNESS order: careful (tightest) → autopilot (loosest).
 * The index is the "looseness rank" `clampLevel` compares on.
 */
export const ACCESS_LEVELS: readonly AccessLevel[] = [
  'careful', 'balanced', 'relaxed', 'autopilot',
] as const;

/**
 * The HARD floor — asks that no Always-allow can silence (they sit above allow
 * rules in the ladder). Payments ask at EVERY level (founder ruling #1), and so
 * does a rewrite or delete of shared git history (protected_remote): it cannot be
 * undone and other people's code depends on it. A dangerous delete asks at
 * every level BELOW Autopilot (Autopilot runs it).
 */
export function hardFloors(family: SideEffectFamily, level: AccessLevel): boolean {
  if (family === 'payment' || family === 'unknown') return true; // unreadable asks everywhere, like a payment
  if (family === 'protected_remote') return true;
  if (family === 'dangerous_delete') return level !== 'autopilot';
  return false;
}

/**
 * The SOFT floor — level asks that sit BELOW allow rules (an Always-allow grant
 * decays them). EXCLUDES the hard-floor families (payment, dangerous_delete) so
 * the two never double-gate; `hardFloors` owns those. Encodes the remaining
 * §1.1 cells:
 *   - workspace_write   → asks only at Careful.
 *   - external_send /
 *     external_mutation → asks at Careful + Balanced.
 *   - readonly          → never asks.
 */
export function levelAsks(family: SideEffectFamily, level: AccessLevel): boolean {
  switch (family) {
    case 'workspace_write':
      return level === 'careful';
    case 'external_send':
    case 'external_mutation':
      return level === 'careful' || level === 'balanced';
    case 'readonly':
    case 'payment':          // hardFloors owns it — never double-gate
    case 'unknown':          // hardFloors owns it too (asks at every level)
    case 'protected_remote': // hardFloors owns it too (asks at every level)
    case 'dangerous_delete': // hardFloors owns it (and Autopilot runs it)
      return false;
  }
}

/** Looseness rank (lower = stricter). Unknown input → Relaxed's rank (the default). */
function levelRank(level: AccessLevel): number {
  const i = ACCESS_LEVELS.indexOf(level);
  return i === -1 ? ACCESS_LEVELS.indexOf('relaxed') : i;
}

/**
 * Clamp a CHILD (subagent / weave node / teammate) level so it is never LOOSER
 * than its parent — a child may tighten but never gain autonomy. Mirrors
 * `clampMode`: returns the STRICTER (lower-ranked) of the two. An undefined
 * request inherits the parent verbatim. Pure + total.
 */
export function clampLevel(requested: AccessLevel | undefined, parent: AccessLevel): AccessLevel {
  if (requested === undefined) return parent;
  return levelRank(requested) <= levelRank(parent) ? requested : parent;
}
