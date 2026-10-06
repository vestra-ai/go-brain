import type { DeskItem } from '../desk/desk.js';
import type { TripPack } from '../trips/pack.js';
import { inlineData, personName } from './fence.js';

export function renderMessageWake(item: DeskItem, pack: TripPack): string {
  const p = (item.payload ?? {}) as { messageId?: string; namesGo?: boolean };
  const m = pack.messages.find((x) => x.message_id === (p.messageId ?? item.ref));
  if (!m) return 'a message that was deleted since';
  const a = m.author;
  let who = 'Go';
  if (a.kind === 'person') {
    const id = a.person_id;
    who = personName(pack.trip.people.find((x) => x.person_id === id)?.name ?? 'Someone who left');
  }
  return `message #${m.seq} from ${who}${p.namesGo ? ', it names you' : ''}`;
}

export function renderTripChangeWake(item: DeskItem, pack: TripPack): string {
  const p = (item.payload ?? {}) as { type?: string; decisionId?: string };
  if (p.type === 'decision.closed' && p.decisionId) {
    const d = pack.trip.decisions.find((x) => x.decision_id === p.decisionId);
    if (!d) return 'a vote closed';
    const won = d.result_index != null ? d.options[d.result_index] : undefined;
    return won
      ? `the vote ${inlineData(d.question)} closed: ${inlineData(won.label)} won (${d.voted} of ${d.of} voted). Say the result in one line and the next step.`
      : `the vote ${inlineData(d.question)} closed with no clear winner (${d.voted} of ${d.of} voted). Ask the group how to settle it.`;
  }
  return `the trip changed (${p.type ?? item.ref})`;
}

export function renderSetupWake(item: DeskItem): string {
  if (item.ref === 'greet') {
    return (
      'you just joined this trip. Say hello to the group in one or two short lines and what you can do for them ' +
      '(find stays and flights, run votes, keep the plan, book when the group agrees). Then open the first vote with ' +
      'open_vote on what the trip most needs settled: where to stay if that is open, otherwise when to go or what to do first. ' +
      'Two to four options drawn from what the trip already says. No prices.'
    );
  }
  return `setup: ${item.ref}`;
}
