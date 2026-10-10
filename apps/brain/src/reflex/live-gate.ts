import type { RecipeChoice } from './questions.js';

/**
 * The questions whose test set passed on recorded Jev answers. The scorer test (Task 5) re-checks
 * every number here in CI. A question acts live only when REFLEX_LIVE names it and it is listed here.
 */
// Recorded 2026-10-07 (jev-1.13.0), questions 1 and 10 again on 2026-10-10 and question 11 new that day. Questions 3
// and 9 stay in shadow: Jev was too rarely sure on them to reach their gate.
export const PASSED_SETS: readonly number[] = [1, 2, 4, 5, 6, 7, 8, 10, 11];

/**
 * Question 10's choices that act live. The rest are read in shadow: a sure pick of one acts as "none" (not one of these),
 * which is what Jev said for those lines before they had a choice of their own. A choice joins this list only when its own
 * gate passes on the recorded set (testset.ts choicePasses), checked in CI, and its recipe is in the book.
 *
 * Live from 2026-10-10 (recorded that day, no wrong pick and no miss): a train's running status (4 of 6 sure and
 * right), its timetable (4/4), a waitlist's chance (4/4), a place's guide (5/5), the offers (5/5), and a shown stay's
 * rooms (4/4) and reviews (3/4). Still in shadow: pnr, coach_position, boarding_stations, flight_status and fare_review,
 * until their recipes are in the book (flight_status also misses its gate: 2 of 5).
 */
export const LIVE_RECIPES: readonly RecipeChoice[] = [
  'flights', 'stays', 'trains', 'buses', 'train_status', 'schedule', 'confirm_chance', 'guide', 'offers', 'hotel_rooms', 'hotel_reviews',
];
