/**
 * The questions whose test set passed on recorded Jev answers. The scorer test (Task 5) re-checks
 * every number here in CI. A question acts live only when REFLEX_LIVE names it and it is listed here.
 */
// Recorded 2026-10-06 (jev-1.13.0). Questions 2, 3 and 9 stay in shadow: Jev was too rarely sure on them to reach their gate.
export const PASSED_SETS: readonly number[] = [1, 4, 5, 6, 7, 8];
