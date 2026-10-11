import type * as C from '@go/contract';

/**
 * A trip of one never gets a vote (Keshav, 12 Oct: "a trip of one never gets a vote; their word is the decision"): its
 * shared things' cards have Choose this on each option instead (cards.ts CHOOSE_ACTION), and a tool that would open a
 * vote tells the model this.
 */
export const tripOfOne = (trip: { people?: readonly unknown[] } | null | undefined): boolean => trip?.people?.length === 1;
export const NO_VOTE_FOR_ONE =
  'This trip has one person: their word is the decision, so there is no vote or poll. If they chose, apply it now (update_trip, ' +
  'their message as the proof; a card of options has Choose this on each, and their tap applies it); if they have not, ask one ' +
  'plain question with offer_replies buttons. Never say vote, poll or everyone.';

/**
 * 1.1: how many said "I'm flexible" on a vote: counted in voted, never in the tally (A5), and named in no pick. The
 * Server's flexible_count, or the votes it counts that name no pick, whichever is more.
 */
export function flexibleOf(d: Pick<C.Decision, 'voted' | 'votes' | 'flexible_count' | 'anonymous'>): number {
  const unnamed = d.anonymous || !d.votes ? 0 : d.voted - d.votes.length;
  return Math.max(d.flexible_count ?? 0, unnamed, 0);
}
