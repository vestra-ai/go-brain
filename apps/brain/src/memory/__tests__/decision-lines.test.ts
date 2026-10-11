import type * as C from '@go/contract';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vote } from '../../__tests__/fixtures/goa.js';
import { withSchema } from '../../db/test-db.js';
import type { DeskItem } from '../../desk/desk.js';
import { goaTrip, msg, packOf } from '../../reflex/goa.fixture.js';
import type { TripPack } from '../../trips/pack.js';
import type { CheckedLine } from '../checker.js';
import { answers, decisionOf, linkLine, settleDecisionLines, settledBy } from '../decision-lines.js';
import { mirrorLine } from '../record.js';
import { fakeLink } from './test-kit.js';

let db: { pool: Pool; drop: () => Promise<void> };
beforeAll(async () => { db = await withSchema(); });
afterAll(async () => { await db.drop(); });

const card = (kind: 'vote' | 'mandate' | 'options', decisionId?: string) => ({ card: { kind, ...(decisionId ? { decision_id: decisionId } : {}) } as unknown as C.Card });
const voteMsg = msg(40, 'go', 'Which villa? Vote below.', card('vote', 'd_villa'));
const ask = msg(41, 'p_priya', 'Casa Mareia looks nice');
const open = (proof: string[], over: Partial<CheckedLine> = {}): CheckedLine => ({
  kind: 'open', text: 'Which villa: Casa Mareia, Villa Sol or The Palms?', personIds: ['p_rahul', 'p_priya'],
  proof: proof.map((id) => ({ message_id: id, person_id: id === 'm_0040' ? null : 'p_priya' })), ...over,
});
const wake = (decisionId: string): DeskItem =>
  ({ id: 'w1', tripId: 't', kind: 'trip_change', ref: `decision:${decisionId}`, dueAt: new Date(), payload: { decisionId } }) as DeskItem;

describe('decisionOf: the one vote an open line is about, by id', () => {
  const pack = packOf([voteMsg, ask], goaTrip({ decisions: [vote({ decision_id: 'd_villa' })] }));

  it('reads it from a proof message that carries the vote card', () => {
    expect(decisionOf(open(['m_0040', 'm_0041']), pack)).toBe('d_villa');
  });

  it('reads it from the turn: a card the turn put up, or the vote that woke it', () => {
    expect(decisionOf(open(['m_0041']), pack, { cards: [card('vote', 'd_new').card], wake: [] })).toBe('d_new');
    // Since rev 5 (R5) a shared thing's options card is its vote; one without a vote names none.
    expect(decisionOf(open(['m_0041']), pack, { cards: [card('options', 'd_stays').card], wake: [] })).toBe('d_stays');
    expect(decisionOf(open(['m_0041']), pack, { cards: [card('options').card], wake: [] })).toBeNull();
    expect(decisionOf(open(['m_0041']), pack, { cards: [], wake: [wake('d_villa')] })).toBe('d_villa');
  });

  it('is null for no vote, two votes, a line that is not open, or a change to a line already written', () => {
    expect(decisionOf(open(['m_0041']), pack)).toBeNull();
    expect(decisionOf(open(['m_0040']), pack, { cards: [card('vote', 'd_other').card], wake: [] })).toBeNull();
    expect(decisionOf(open(['m_0040'], { kind: 'agreed' }), pack)).toBeNull();
    expect(decisionOf(open(['m_0040'], { lineId: 'r_1' }), pack)).toBeNull();
  });
});

describe('settleDecisionLines: an open line about a vote is marked done once the vote settles it', () => {
  const at = '2026-10-06T10:00:00Z';
  const line = (lineId: string, status: 'active' | 'done' = 'active'): C.RecordLine => ({
    line_id: lineId, kind: 'open', text: `Question ${lineId}`, status, proof: [{ message_id: 'm_0041', person_id: 'p_priya' }],
    person_ids: ['p_rahul', 'p_priya'], source: 'go', created_at: at, updated_at: at,
  });
  const packWith = (tripId: string, d: C.Decision): TripPack => packOf([voteMsg, ask], goaTrip({ trip_id: tripId, decisions: [d] }));
  const done = (link: ReturnType<typeof fakeLink>) =>
    link.calls.filter((c) => c.method === 'update_record_line' && c.params['status'] === 'done').map((c) => c.params['line_id']);

  it('a line written while the vote was open is done when the vote closes, and not before', async () => {
    const T = 't_dl1';
    await mirrorLine(db.pool, T, line('r_vote'), 5);
    await linkLine(db.pool, T, 'r_vote', 'd_villa', packWith(T, vote({ decision_id: 'd_villa' })));
    const link = fakeLink();
    expect(await settleDecisionLines(db.pool, link, T, packWith(T, vote({ decision_id: 'd_villa' })))).toBe(0);
    expect(await settleDecisionLines(db.pool, link, T, packWith(T, vote({ decision_id: 'd_villa', status: 'closed', result_index: 1 })))).toBe(1);
    expect(done(link)).toEqual(['r_vote']);
    expect(link.calls[0]!.params).toMatchObject({ kind: 'open', text: 'Question r_vote', person_ids: ['p_rahul', 'p_priya'] });
  });

  it('a who-pays line, written after the vote closed, is done once a mandate is set, not when the vote closed', async () => {
    const T = 't_dl2';
    const closed = vote({ decision_id: 'd_villa', status: 'closed', result_index: 1 });
    await mirrorLine(db.pool, T, line('r_payer'), 6);
    await linkLine(db.pool, T, 'r_payer', 'd_villa', packWith(T, closed));
    const link = fakeLink();
    expect(await settleDecisionLines(db.pool, link, T, packWith(T, closed))).toBe(0);
    const mandate = { choice_index: 1, cap_minor: 4_000_000, currency: 'INR', refundable_only: false, payer_person_id: 'p_rahul', set_at: at };
    expect(await settleDecisionLines(db.pool, link, T, packWith(T, { ...closed, mandate }))).toBe(1);
    expect(done(link)).toEqual(['r_payer']);
  });

  it('a cancelled vote settles both kinds; a line already done is left alone; a second pass sends nothing more', async () => {
    const T = 't_dl3';
    const openVote = vote({ decision_id: 'd_villa' });
    await mirrorLine(db.pool, T, line('r_a'), 7);
    await mirrorLine(db.pool, T, line('r_b', 'done'), 8);
    await linkLine(db.pool, T, 'r_a', 'd_villa', packWith(T, openVote));
    await linkLine(db.pool, T, 'r_b', 'd_villa', packWith(T, openVote));
    const cancelled = packWith(T, { ...openVote, status: 'cancelled' });
    const link = fakeLink();
    expect(await settleDecisionLines(db.pool, link, T, cancelled)).toBe(1);
    expect(await settleDecisionLines(db.pool, link, T, cancelled)).toBe(1);
    expect(done(link)).toEqual(['r_a']);
  });
});

describe('an open line people raised before the vote: the vote that answers it settles it too (8 Oct regression pass)', () => {
  const stayVote = { question: 'Where should we stay in Goa: Candolim or Anjuna?', kind: 'choice' as const, options: [{ label: 'Candolim' }, { label: 'Anjuna' }] };

  it('answers: two options named, or one and a word of the question; never the trip\'s own place alone; a yes-or-no by two shared words', () => {
    expect(answers('Stay location: Candolim or Anjuna?', stayVote, 'Goa')).toBe(true);
    expect(answers('Stay location: Candolim?', stayVote, 'Goa')).toBe(true);
    expect(answers('Stay in Candolim?', stayVote, 'Goa')).toBe(true);
    expect(answers('Dinner at Candolim beach shack?', stayVote, 'Goa')).toBe(false);
    expect(answers('Dinner in Goa at Candolim?', stayVote, 'Goa')).toBe(false);
    const beach = { question: 'Beach day: Saturday or Sunday?', kind: 'choice' as const, options: [{ label: 'Saturday 7 Nov' }, { label: 'Sunday 8 Nov' }] };
    expect(answers('Beach day on Saturday or Sunday?', beach)).toBe(true);
    expect(answers('Which villa: Casa Mareia or Villa Sol?', beach)).toBe(false);
    const scooters = { question: 'Should we rent scooters?', kind: 'yesno' as const, options: [{ label: 'Yes' }, { label: 'No' }] };
    expect(answers('Are we renting scooters or not?', scooters)).toBe(true);
    expect(answers('Scooters or a cab from the airport?', scooters)).toBe(false);
  });

  it('settles the lines a vote with a winner answers, written before it closed; not another question, not a tie', async () => {
    const T = 't_dl9';
    const line = (id: string, text: string, at: string): C.RecordLine => ({
      line_id: id, kind: 'open', text, status: 'active', proof: [{ message_id: 'm_0041', person_id: 'p_priya' }],
      person_ids: ['p_priya'], source: 'go', created_at: at, updated_at: at,
    });
    await mirrorLine(db.pool, T, line('r_one', 'Stay location: Candolim?', '2026-10-08T08:45:00Z'), 8);
    await mirrorLine(db.pool, T, line('r_two', 'Stay location: Candolim or Anjuna?', '2026-10-08T08:46:00Z'), 27);
    await mirrorLine(db.pool, T, line('r_dinner', 'Dinner at Candolim beach shack?', '2026-10-08T08:46:30Z'), 28);
    await mirrorLine(db.pool, T, line('r_after', 'Stay in Candolim or Anjuna again?', '2026-10-08T09:30:00Z'), 60);
    const pack = (d: C.Decision) => packOf([voteMsg, ask], goaTrip({ trip_id: T, destination: { name: 'Goa' }, decisions: [d] }));
    const asVote = (over: Partial<C.Decision>) => vote({ decision_id: 'd_where', ...stayVote, ...over });
    const link = fakeLink();
    const done = () => link.calls.filter((c) => c.method === 'update_record_line' && c.params['status'] === 'done').map((c) => c.params['line_id']);
    // Still open, or closed in a tie: nothing is settled.
    expect(await settleDecisionLines(db.pool, link, T, pack(asVote({})))).toBe(0);
    expect(await settleDecisionLines(db.pool, link, T, pack(asVote({ status: 'closed', result_index: null, closed_at: '2026-10-08T08:47:00Z' })))).toBe(0);
    // Candolim won at 08:47: the two stay questions are done; the dinner one, and one asked after the vote, are not.
    const closed = pack(asVote({ status: 'closed', result_index: 0, closed_at: '2026-10-08T08:47:00Z', tally: [3, 1], voted: 4 }));
    expect(await settleDecisionLines(db.pool, link, T, closed)).toBe(2);
    expect(done().sort()).toEqual(['r_one', 'r_two']);
    // The sweep again: the same writes, nothing sent twice.
    await settleDecisionLines(db.pool, link, T, closed);
    expect(done().sort()).toEqual(['r_one', 'r_two']);
  });
});

describe('settledBy: the open questions a new line settles (Server, 6 Oct: open lines were never closed)', () => {
  const rec = (line_id: string, over: Partial<C.RecordLine> = {}): C.RecordLine => ({
    line_id, kind: 'open', text: 'Candolim or Anjuna for the stay?', status: 'active', proof: [{ message_id: 'm_0240', person_id: 'p_priya' }],
    person_ids: [], source: 'go', created_at: '2026-10-06T09:00:00Z', updated_at: '2026-10-06T09:00:00Z', ...over,
  });
  const line = (over: Partial<CheckedLine>): CheckedLine => ({
    kind: 'agreed', text: 'Stay in Candolim', personIds: [], proof: [{ message_id: 'm_0241', person_id: 'p_rahul' }], ...over,
  });
  const record = [
    rec('r_stay'),
    rec('r_cab', { text: 'Who sorts the airport cab?', proof: [{ message_id: 'm_0243', person_id: 'p_kabir' }] }),
    rec('r_done', { status: 'done' }),
    rec('r_people', { source: 'person' }),
    rec('r_agreed', { kind: 'agreed' }),
  ];
  const ids = (l: CheckedLine, named: string[] = []) => settledBy(l, named, record).map((r) => r.line_id);

  it('closes the open question an agreed line cites as its proposal, and the ones the model names', () => {
    expect(ids(line({ proof: [{ message_id: 'm_0240', person_id: 'p_priya' }, { message_id: 'm_0241', person_id: 'p_rahul' }] }))).toEqual(['r_stay']);
    expect(ids(line({}), ['r_stay'])).toEqual(['r_stay']);
    expect(ids(line({ kind: 'doing', text: 'Meher sorts the airport cab' }), ['r_cab'])).toEqual(['r_cab']);
  });

  it("never closes on nothing: no named line and no shared proof, a doing line's proof alone, or Go's own other lines", () => {
    expect(ids(line({}))).toEqual([]);
    expect(ids(line({ kind: 'doing', proof: [{ message_id: 'm_0240', person_id: 'p_priya' }] }))).toEqual([]);
    // Only Go's own active open lines: never one already done, someone else's, or an agreed line.
    expect(ids(line({}), ['r_done', 'r_people', 'r_agreed'])).toEqual([]);
    // An open line settles nothing, and a line never closes itself.
    expect(ids(line({ kind: 'open' }), ['r_stay'])).toEqual([]);
    expect(ids(line({ lineId: 'r_stay' }), ['r_stay'])).toEqual([]);
  });
});
