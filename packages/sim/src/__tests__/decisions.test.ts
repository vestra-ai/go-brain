import { describe, expect, it } from 'vitest';
import { Event } from '@go/contract';
import { goaFreshTrip } from '../goa.js';
import { SocketCallError } from '../server-socket.js';
import { closeVote, closeVoteByTime, confirmMandate, declineMandate, openVote, setMandate, vote, winner } from '../state/decisions.js';
import { TripState } from '../state/trip-state.js';

const everyone = ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir'];
const villas = [
  { label: 'Villa Sol', price_minor: 5420000, currency: 'INR' },
  { label: 'Casa Azul', price_minor: 6180000, currency: 'INR' },
  { label: 'The Palms', price_minor: 5850000, currency: 'INR' },
];

function setUp() {
  let t = Date.parse('2026-10-05T07:30:00Z');
  let n = 0;
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const s = new TripState(goaFreshTrip(), { mint: (p) => `${p}${String(++n).padStart(4, '0')}`, now: clock.now });
  s.created();
  return { s, clock };
}

function open(s: TripState, extra: Record<string, unknown> = {}) {
  return openVote(s, { request_id: 'rq_open', trip_id: 't_goa', question: 'Where do we stay?', kind: 'choice', anonymous: false, options: villas, ...extra } as never);
}

function err(fn: () => unknown): SocketCallError {
  try {
    fn();
  } catch (e) {
    if (e instanceof SocketCallError) return e;
    throw e;
  }
  throw new Error('it did not throw');
}

const types = (events: Event[]) => events.map((e) => e.type);

describe('open_vote', () => {
  it('opens a vote by Go, for everyone in the trip, with a tally of zeros', () => {
    const { s } = setUp();
    const done = open(s);
    expect(done.result).toEqual({ decision_id: expect.any(String), seq: 2 });
    const ev = done.events[0]!;
    expect(ev).toMatchObject({ type: 'decision.opened', seq: 2, data: { by: { kind: 'go' }, decision: { status: 'open', voted: 0, of: 5, tally: [0, 0, 0], votes: [] } } });
    if (ev.type === 'decision.opened') expect(ev.data.decision.opened_by_person_id).toBeUndefined();
    expect(s.needsYou('p_rahul')).toEqual([{ kind: 'vote', ref: done.result.decision_id, text: 'Where do we stay?' }]);
  });

  it('refuses a closing time in the past and an option in another currency', () => {
    const { s } = setUp();
    expect(err(() => open(s, { closes_at: '2026-10-05T07:00:00Z' })).code).toBe(422);
    expect(err(() => open(s, { options: [{ label: 'A', price_minor: 100, currency: 'USD' }, { label: 'B' }] })).code).toBe(422);
  });
});

describe('voting and closing', () => {
  it('counts votes, and closes the vote with its decided line once everyone has voted', () => {
    const { s } = setUp();
    const id = open(s).result.decision_id;
    const events: Event[] = [];
    for (const [i, person] of everyone.entries()) events.push(...vote(s, id, person, i === 2 ? 1 : 0).events);
    expect(types(events)).toEqual(['decision.voted', 'decision.voted', 'decision.voted', 'decision.voted', 'decision.voted', 'decision.closed', 'record.changed']);
    expect(events.map((e) => e.seq)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(events[0]).toMatchObject({ data: { person_id: 'p_rahul', option_index: 0, voted: 1, of: 5, tally: [1, 0, 0] } });
    expect(events[5]).toMatchObject({ data: { reason: 'everyone_voted', decision: { status: 'closed', result_index: 0, tally: [4, 1, 0] } } });
    expect(events[6]).toMatchObject({ data: { change: 'added', by: { kind: 'system' }, line: { kind: 'decided', text: 'Villa Sol', decision_id: id, source: 'vote' } } });
    expect(s.needsYou('p_rahul')).toEqual([]);
  });

  it('changes a vote, and does nothing for the same vote twice', () => {
    const { s } = setUp();
    const id = open(s).result.decision_id;
    vote(s, id, 'p_priya', 0);
    expect(vote(s, id, 'p_priya', 0).events).toEqual([]);
    const changed = vote(s, id, 'p_priya', 2).events[0]!;
    expect(changed).toMatchObject({ data: { voted: 1, tally: [0, 0, 1] } });
    expect(err(() => vote(s, id, 'p_priya', 7)).code).toBe(422);
    expect(err(() => vote(s, id, 'p_stranger', 0)).code).toBe(422);
  });

  it('close_vote closes now, answers the vote and the first change number, and refuses a second close', () => {
    const { s } = setUp();
    const id = open(s).result.decision_id;
    vote(s, id, 'p_rahul', 1);
    const done = closeVote(s, { request_id: 'rq_close', trip_id: 't_goa', decision_id: id });
    expect(types(done.events)).toEqual(['decision.closed', 'record.changed']);
    expect(done.result.seq).toBe(done.events[0]!.seq);
    expect(done.result.decision).toMatchObject({ status: 'closed', result_index: 1 });
    expect(done.events[0]).toMatchObject({ data: { reason: 'closed_by_go' } });
    expect(err(() => closeVote(s, { request_id: 'rq_again', trip_id: 't_goa', decision_id: id })).code).toBe(409);
    expect(err(() => closeVote(s, { request_id: 'rq_nope', trip_id: 't_goa', decision_id: 'd_nope' })).code).toBe(404);
  });

  it('a tie or no votes closes with no winner and no decided line', () => {
    const { s } = setUp();
    const id = open(s).result.decision_id;
    vote(s, id, 'p_rahul', 0);
    vote(s, id, 'p_priya', 1);
    const closed = closeVoteByTime(s, id);
    expect(types(closed.events)).toEqual(['decision.closed']);
    expect(closed.events[0]).toMatchObject({ data: { reason: 'time' } });
    expect(s.decision(id)!.result_index).toBeUndefined();
    expect(winner([4, 1, 0])).toBe(0);
    expect(winner([1, 1, 0])).toBeUndefined();
    expect(winner([0, 0])).toBeUndefined();
  });

  it('an anonymous vote never says who voted for what, and still knows who has voted', () => {
    const { s } = setUp();
    const opened = open(s, { anonymous: true });
    const id = opened.result.decision_id;
    expect((opened.events[0] as any).data.decision.votes).toBeUndefined();
    const voted = vote(s, id, 'p_meher', 2).events[0] as any;
    expect(voted.data.person_id).toBeUndefined();
    expect(voted.data.option_index).toBeUndefined();
    expect(voted.data.tally).toEqual([0, 0, 1]);
    expect(s.readTrip().decisions[0]!.votes).toBeUndefined();
    expect(s.needsYou('p_meher')).toEqual([]);
    expect(s.needsYou('p_kabir')).toHaveLength(1);
  });
});

describe('set_mandate and the payer', () => {
  function closedVillaVote(s: TripState): string {
    const id = open(s).result.decision_id;
    for (const person of everyone) vote(s, id, person, 0);
    return id;
  }
  const mandate = (decision_id: string, extra: Record<string, unknown> = {}) => ({
    request_id: 'rq_m', trip_id: 't_goa', decision_id, choice_index: 0, cap_minor: 5500000, currency: 'INR', refundable_only: true, payer_person_id: 'p_rahul', ...extra,
  }) as never;

  it("refuses an open vote, a yes or no vote, a missing option, a payer outside the trip and another currency", () => {
    const { s } = setUp();
    const openId = open(s).result.decision_id;
    expect(err(() => setMandate(s, mandate(openId))).code).toBe(409);
    const yesno = openVote(s, { request_id: 'rq_yn', trip_id: 't_goa', question: 'Scuba?', kind: 'yesno', anonymous: false, options: [{ label: 'Yes' }, { label: 'No' }] } as never).result.decision_id;
    closeVoteByTime(s, yesno);
    expect(err(() => setMandate(s, mandate(yesno))).code).toBe(409);
    const { s: t } = setUp();
    const villa = closedVillaVote(t);
    expect(err(() => setMandate(t, mandate(villa, { choice_index: 3 }))).code).toBe(422);
    expect(err(() => setMandate(t, mandate(villa, { payer_person_id: 'p_stranger' }))).code).toBe(422);
    expect(err(() => setMandate(t, mandate(villa, { currency: 'USD' }))).code).toBe(422);
    expect(err(() => setMandate(t, mandate('d_nope'))).code).toBe(404);
  });

  it('sets the mandate, pins it for the payer, and the payer says yes or no', () => {
    const { s, clock } = setUp();
    const id = closedVillaVote(s);
    const set = setMandate(s, mandate(id));
    expect(set.events[0]).toMatchObject({ type: 'mandate.set', data: { decision_id: id, mandate: { cap_minor: 5500000, payer_person_id: 'p_rahul' } } });
    expect(s.needsYou('p_rahul')).toEqual([{ kind: 'mandate', ref: id, text: 'Book Villa Sol?' }]);
    clock.advance(60_000);
    expect(confirmMandate(s, id).events[0]).toMatchObject({ type: 'mandate.confirmed', data: { decision_id: id, person_id: 'p_rahul' } });
    expect(s.needsYou('p_rahul')).toEqual([]);
    clock.advance(60_000);
    expect(declineMandate(s, id).events[0]).toMatchObject({ type: 'mandate.declined', data: { person_id: 'p_rahul' } });
    setMandate(s, mandate(id, { cap_minor: 6000000 }));
    expect(s.decision(id)!.mandate).toMatchObject({ cap_minor: 6000000 });
    expect(s.decision(id)!.mandate!.confirmed_at).toBeUndefined();
    expect(s.decision(id)!.mandate!.declined_at).toBeUndefined();
    const { s: other } = setUp();
    expect(err(() => confirmMandate(other, closedVillaVote(other))).code).toBe(409);
  });
});
