/**
 * A vote is decided once one option has more than half of the trip's people (2 of 2, 2 of 3, 3 of 4, 3 of 5), and Go closes
 * it then, so its winner applies at once: the closed vote's wake saves the dates or the place, and a stay's booking follows.
 * Keshav and Saket, 12 Oct: "Go understands in chat but doesn't update the When? until the poll completes"; the Server
 * closes a vote only once everyone has voted (everyone_voted, which stays). Decided here in code, never by the model.
 * Only a vote Go opened, still open, in a trip of more than one: a person's own poll is theirs to run, and a trip of one's
 * card already closes on its one tap.
 */
import type * as C from '@go/contract';
import type { ServerLink } from '../door/server-link.js';
import { stableId } from '../travel/ids.js';
import type { Packs } from './pack.js';
import { tripOfOne } from './votes.js';

/** The option with more than half of the trip's people, or null while none has. */
export function majorityOf(tally: readonly number[], people: number): number | null {
  if (people < 2 || tally.length === 0) return null;
  const top = Math.max(...tally);
  return top * 2 > people ? tally.indexOf(top) : null;
}

export function createMajorityClose(d: {
  link: Pick<ServerLink, 'request'>;
  packs: Pick<Packs, 'get'>;
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}): { onEvent(ev: C.Event): Promise<void> } {
  return {
    async onEvent(ev) {
      if (ev.type !== 'decision.voted') return;
      const { trip } = await d.packs.get(ev.trip_id);
      if (tripOfOne(trip)) return;
      const vote = trip.decisions.find((x) => x.decision_id === ev.data.decision_id);
      if (!vote || vote.status !== 'open' || vote.opened_by_person_id != null) return;
      const won = majorityOf(ev.data.tally, trip.people.length);
      if (won === null) return;
      try {
        await d.link.request('close_vote', { request_id: stableId('go_close_majority', vote.decision_id), trip_id: ev.trip_id, decision_id: vote.decision_id });
        d.log.info({ tripId: ev.trip_id, decisionId: vote.decision_id, won, people: trip.people.length }, 'trips: a vote had its majority, and Go closed it');
      } catch (err) {
        // Closed already (everyone voted at the same moment, or a person closed it): nothing to do.
        d.log.warn({ err, tripId: ev.trip_id, decisionId: vote.decision_id }, "trips: a vote's majority close did not go through");
      }
    },
  };
}
