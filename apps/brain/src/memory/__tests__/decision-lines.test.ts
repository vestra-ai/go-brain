import type * as C from '@go/contract';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vote } from '../../__tests__/fixtures/goa.js';
import { withSchema } from '../../db/test-db.js';
import type { DeskItem } from '../../desk/desk.js';
import { goaTrip, msg, packOf } from '../../reflex/goa.fixture.js';
import type { TripPack } from '../../trips/pack.js';
import type { CheckedLine } from '../checker.js';
import { decisionOf, linkLine, settleDecisionLines } from '../decision-lines.js';
import { mirrorLine } from '../record.js';
import { fakeLink } from './test-kit.js';

let db: { pool: Pool; drop: () => Promise<void> };
beforeAll(async () => { db = await withSchema(); });
afterAll(async () => { await db.drop(); });

const card = (kind: 'vote' | 'mandate', decisionId: string) => ({ card: { kind, decision_id: decisionId } as unknown as C.Card });
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
