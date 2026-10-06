// Votes and mandates, with the Server's rules from docs/guide/04-gos-requests.md (open_vote, close_vote,
// set_mandate), and what people do with them in the App: vote, and the payer's "Yes, book it" and "Not now".
import type * as C from '@go/contract';
import type { Event } from '@go/contract';
import { fail, type Change, type Decision, type Params, type RecordLine, type TripState } from './trip-state.js';

type CloseReason = 'time' | 'everyone_voted' | 'closed_by_person' | 'closed_by_go';

/** The vote as Go may see it: an anonymous vote never says who voted for what. */
export function publicDecision(d: Decision): Decision {
  const copy = structuredClone(d);
  if (copy.anonymous) delete copy.votes;
  return copy;
}

/** The winning option: the most votes. None when nobody voted or the top options tied (Go then asks the group). */
export function winner(tally: readonly number[]): number | undefined {
  const top = Math.max(0, ...tally);
  if (top === 0) return undefined;
  return tally.filter((v) => v === top).length === 1 ? tally.indexOf(top) : undefined;
}

export function openVote(s: TripState, p: Params<typeof C.OpenDecision>): Change<{ decision_id: string; seq: number }> {
  if (p.closes_at != null && Date.parse(p.closes_at) <= s.now().getTime()) throw fail('invalid', 'closes_at: must be in the future');
  p.options.forEach((o, i) => s.currency(o.currency, `options[${i}].currency`));
  const decision: Decision = {
    decision_id: s.mint('d_'),
    question: p.question,
    kind: p.kind,
    anonymous: p.anonymous,
    status: 'open',
    options: p.options,
    ...(p.closes_at != null ? { closes_at: p.closes_at } : {}),
    voted: 0,
    of: s.trip.people.length,
    tally: p.options.map(() => 0),
    ...(p.anonymous ? {} : { votes: [] }),
    opened_at: s.now().toISOString(),
  };
  s.trip.decisions.push(decision);
  s.ballots.set(decision.decision_id, new Map());
  const ev = s.bump('decision.opened', { decision: publicDecision(decision), by: { kind: 'go' } });
  return { result: { decision_id: decision.decision_id, seq: ev.seq }, events: [ev] };
}

export function closeVote(s: TripState, p: Params<typeof C.CloseDecision>): Change<{ decision: Decision; seq: number }> {
  const d = s.decision(p.decision_id);
  if (!d) throw fail('not_found', `decision ${p.decision_id} is not in this trip`);
  if (d.status !== 'open') throw fail('conflict', `decision ${d.decision_id} is already ${d.status}`);
  const events = close(s, d, 'closed_by_go');
  return { result: { decision: publicDecision(d), seq: events[0]!.seq }, events };
}

export function setMandate(s: TripState, p: Params<typeof C.SetMandate>): Change<{ seq: number }> {
  const d = s.decision(p.decision_id);
  if (!d) throw fail('not_found', `decision ${p.decision_id} is not in this trip`);
  if (d.kind !== 'choice') throw fail('conflict', `decision ${d.decision_id} is a yes or no vote, which never has a mandate`);
  if (d.status !== 'closed') throw fail('conflict', `decision ${d.decision_id} is not closed`);
  if (p.choice_index >= d.options.length) throw fail('invalid', `choice_index: ${p.choice_index} is not one of the ${d.options.length} options`);
  s.person(p.payer_person_id, 'payer_person_id');
  s.currency(p.currency, 'currency');
  // A new mandate replaces the old one and clears the payer's earlier yes or no.
  d.mandate = {
    choice_index: p.choice_index,
    cap_minor: p.cap_minor,
    currency: p.currency,
    refundable_only: p.refundable_only,
    payer_person_id: p.payer_person_id,
    set_at: s.now().toISOString(),
  };
  const ev = s.bump('mandate.set', { decision_id: d.decision_id, mandate: structuredClone(d.mandate) });
  return { result: { seq: ev.seq }, events: [ev] };
}

// ── what people do in the App (the sim's helpers) ──

export function vote(s: TripState, decisionId: string, personId: string, optionIndex: number): Change<void> {
  const d = openDecision(s, decisionId);
  s.person(personId, 'personId');
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= d.options.length) {
    throw fail('invalid', `optionIndex: ${optionIndex} is not one of the ${d.options.length} options`);
  }
  const ballots = s.ballots.get(d.decision_id) ?? new Map<string, number>();
  s.ballots.set(d.decision_id, ballots);
  if (ballots.get(personId) === optionIndex) return { result: undefined, events: [] };
  ballots.set(personId, optionIndex);
  d.tally = d.options.map((_, i) => [...ballots.values()].filter((v) => v === i).length);
  d.voted = ballots.size;
  if (!d.anonymous) d.votes = [...ballots].map(([person_id, option_index]) => ({ person_id, option_index }));
  const events: Event[] = [
    s.bump('decision.voted', {
      decision_id: d.decision_id,
      ...(d.anonymous ? {} : { person_id: personId, option_index: optionIndex }),
      voted: d.voted,
      of: d.of,
      tally: [...d.tally],
    }),
  ];
  if (d.voted >= d.of) events.push(...close(s, d, 'everyone_voted'));
  return { result: undefined, events };
}

export function closeVoteByTime(s: TripState, decisionId: string): Change<void> {
  return { result: undefined, events: close(s, openDecision(s, decisionId), 'time') };
}

/** The payer taps "Yes, book it" on the mandate card. */
export function confirmMandate(s: TripState, decisionId: string): Change<void> {
  const d = s.decision(decisionId);
  if (!d?.mandate) throw fail('conflict', `decision ${decisionId} has no mandate`);
  d.mandate.confirmed_at = s.now().toISOString();
  const ev = s.bump('mandate.confirmed', { decision_id: d.decision_id, person_id: d.mandate.payer_person_id });
  return { result: undefined, events: [ev] };
}

/** The payer taps "Not now". */
export function declineMandate(s: TripState, decisionId: string): Change<void> {
  const d = s.decision(decisionId);
  if (!d?.mandate) throw fail('conflict', `decision ${decisionId} has no mandate`);
  d.mandate.declined_at = s.now().toISOString();
  const ev = s.bump('mandate.declined', { decision_id: d.decision_id, person_id: d.mandate.payer_person_id });
  return { result: undefined, events: [ev] };
}

function openDecision(s: TripState, decisionId: string): Decision {
  const d = s.decision(decisionId);
  if (!d) throw fail('not_found', `decision ${decisionId} is not in this trip`);
  if (d.status !== 'open') throw fail('conflict', `decision ${decisionId} is already ${d.status}`);
  return d;
}

/** Closes a vote: decision.closed, then the decided line in the record (a second change, by system) when there is a winner. */
function close(s: TripState, d: Decision, reason: CloseReason): Event[] {
  const at = s.now().toISOString();
  d.status = 'closed';
  d.closed_at = at;
  const win = winner(d.tally);
  if (win === undefined) delete d.result_index;
  else d.result_index = win;
  const events: Event[] = [s.bump('decision.closed', { decision: publicDecision(d), reason })];
  const label = win === undefined ? undefined : d.options[win]?.label;
  if (label !== undefined) {
    const line: RecordLine = {
      line_id: s.mint('r_'),
      kind: 'decided',
      text: label,
      status: 'active',
      proof: [],
      person_ids: [],
      decision_id: d.decision_id,
      source: 'vote',
      created_at: at,
      updated_at: at,
    };
    s.trip.record.push(line);
    events.push(s.bump('record.changed', { line: structuredClone(line), change: 'added', by: { kind: 'system' } }));
  }
  return events;
}
