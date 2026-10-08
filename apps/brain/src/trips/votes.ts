import type * as C from '@go/contract';

/**
 * 1.1: how many said "I'm flexible" on a vote: counted in voted, never in the tally (A5), and named in no pick. The
 * Server's flexible_count, or the votes it counts that name no pick, whichever is more.
 */
export function flexibleOf(d: Pick<C.Decision, 'voted' | 'votes' | 'flexible_count' | 'anonymous'>): number {
  const unnamed = d.anonymous || !d.votes ? 0 : d.voted - d.votes.length;
  return Math.max(d.flexible_count ?? 0, unnamed, 0);
}
