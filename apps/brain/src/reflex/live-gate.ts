import type { RecipeChoice } from './questions.js';

/**
 * The questions whose test set passed on recorded Jev answers. The scorer test (Task 5) re-checks
 * every number here in CI. A question acts live only when REFLEX_LIVE names it and it is listed here.
 */
// Recorded 2026-10-07 (jev-1.13.0). Questions 3 and 9 stay in shadow: Jev was too rarely sure on them to reach their gate.
export const PASSED_SETS: readonly number[] = [1, 2, 4, 5, 6, 7, 8, 10];

/**
 * Question 10's choices that act live. The rest are read in shadow: a sure pick of one acts as "none" (not one of these),
 * which is what Jev said for those lines before they had a choice of their own. A choice joins this list only when its own
 * gate passes on the recorded set (testset.ts choicePasses), checked in CI.
 */
export const LIVE_RECIPES: readonly RecipeChoice[] = ['flights', 'stays', 'trains', 'buses'];
