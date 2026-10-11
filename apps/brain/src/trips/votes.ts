import type * as C from '@go/contract';

/**
 * A trip of one (Keshav, 12 Oct: "a trip of one never gets a vote; their word is the decision"): its options cards keep
 * their vote under the hood, so their one tap picks it at once (1 of 1) and a stay's booking follows; a poll of its own
 * is never opened for them, and Go's words never say vote, poll, everyone or the group.
 */
export const tripOfOne = (trip: { people: readonly unknown[] } | null | undefined): boolean => trip?.people.length === 1;
/** What a tool that would open a poll tells the model in a trip of one. */
export const NO_VOTE_FOR_ONE =
  'This trip has one person: their word is the decision, so there is no vote or poll. Apply what they chose now (update_trip, ' +
  'their message as the proof; on a card of options, their one tap picks it at once); if they have not chosen, ask one plain ' +
  'question with offer_replies buttons. Never say vote, poll, everyone or the group.';

/**
 * 1.1: how many said "I'm flexible" on a vote: counted in voted, never in the tally (A5), and named in no pick. The
 * Server's flexible_count, or the votes it counts that name no pick, whichever is more.
 */
export function flexibleOf(d: Pick<C.Decision, 'voted' | 'votes' | 'flexible_count' | 'anonymous'>): number {
  const unnamed = d.anonymous || !d.votes ? 0 : d.voted - d.votes.length;
  return Math.max(d.flexible_count ?? 0, unnamed, 0);
}
