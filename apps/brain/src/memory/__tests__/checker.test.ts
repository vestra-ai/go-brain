import type * as C from '@go/contract';
import { describe, expect, it } from 'vitest';
import { goaTrip, msg, packOf } from '../../reflex/goa.fixture.js';
import { checkFact, checkLine, cleanText, type CheckEnv, type LineProposal } from '../checker.js';

const messages = [
  msg(122, 'p_priya', 'North Goa this time, not South?'),
  msg(124, 'p_arjun', 'yes North'),
  msg(130, 'p_meher', "I'm allergic to peanuts btw"),
  msg(131, 'p_priya', 'Meher is allergic to peanuts'),
  msg(140, 'p_kabir', "I'll book the airport cab"),
  msg(141, 'p_rahul', 'Kabir will book the airport cab'),
  msg(142, 'p_kabir', 'card 4111 1111 1111 1111 for the cab'),
  msg(143, 'go', 'Scuba on Saturday, who is in?'),
  msg(150, 'p_rahul', 'Dinner at Thalassa on Saturday'),
  msg(151, 'p_arjun', 'nah too far'),
  msg(160, 'p_meher', null, { withheld: true }),
  msg(170, 'p_priya', 'Thalassa it is then, booking a table?'),
];
const line = (over: Partial<C.RecordLine>): C.RecordLine => ({
  line_id: 'r_x', kind: 'agreed', text: 'x', status: 'active', proof: [], person_ids: [], source: 'go',
  created_at: '2026-10-05T04:00:00Z', updated_at: '2026-10-05T04:00:00Z', ...over,
});
const env = (over: Partial<CheckEnv> = {}): CheckEnv => ({ pack: packOf(messages, goaTrip()), forgotten: new Map(), record: [], ...over });
const withThumb = () => {
  const m = messages.map((x) => (x.message_id === 'm_0122' ? { ...x, reactions: [{ emoji: '👍', person_id: 'p_rahul' }] } : x));
  return env({ pack: packOf(m, goaTrip()) });
};
const lineP = (over: Partial<LineProposal>): LineProposal => ({ kind: 'agreed', text: 'North Goa, not South', person_ids: [], proof: [], ...over });

describe('checkFact', () => {
  it('saves a fact from the person\'s own message', () => {
    const r = checkFact({ person_id: 'p_meher', topic: 'Food', text: 'Allergic to peanuts', message_id: 'm_0130' }, env());
    expect(r).toEqual({
      ok: true,
      value: { personId: 'p_meher', tripId: 't_goa', topic: 'food', text: 'Allergic to peanuts', messageId: 'm_0130', saidAt: new Date(messages[2]!.sent_at), audience: 'group' },
    });
  });
  it('refuses proof written by someone else', () => {
    expect(checkFact({ person_id: 'p_meher', topic: 'food', text: 'Allergic to peanuts', message_id: 'm_0131' }, env()))
      .toEqual({ ok: false, reason: 'the proof is not a message by that person' });
  });
  it('refuses a message holding a secret, and a fact text holding one', () => {
    expect(checkFact({ person_id: 'p_kabir', topic: 'cards', text: 'Pays by card', message_id: 'm_0142' }, env()).ok).toBe(false);
    expect(checkFact({ person_id: 'p_kabir', topic: 'cab', text: 'Card 4111 1111 1111 1111', message_id: 'm_0140' }, env()).ok).toBe(false);
  });
  it('refuses withheld, unknown and forgotten messages', () => {
    expect(checkFact({ person_id: 'p_meher', topic: 'food', text: 'x', message_id: 'm_0160' }, env()).ok).toBe(false);
    expect(checkFact({ person_id: 'p_meher', topic: 'food', text: 'x', message_id: 'm_9999' }, env()).ok).toBe(false);
    expect(checkFact({ person_id: 'p_meher', topic: 'food', text: 'Allergic to peanuts', message_id: 'm_0130' }, env({ forgotten: new Map([['p_meher', 135]]) })))
      .toEqual({ ok: false, reason: 'that person asked Go to forget this' });
  });
  it('takes em dashes out of what it saves', () => {
    expect(cleanText('Allergic to peanuts — strictly', 200)).toBe('Allergic to peanuts, strictly');
    expect(cleanText('x'.repeat(201), 200)).toBeNull();
  });
});

describe('checkLine', () => {
  it('writes "agreed" when two people said yes', () => {
    const r = checkLine(lineP({ proof: ['m_0122', 'm_0124'] }), env());
    expect(r).toMatchObject({ ok: true, value: { kind: 'agreed', personIds: ['p_priya', 'p_arjun'] } });
    if (r.ok) expect(r.value.proof).toEqual([{ message_id: 'm_0122', person_id: 'p_priya' }, { message_id: 'm_0124', person_id: 'p_arjun' }]);
  });
  it('writes "open" instead when only one person said yes', () => {
    expect(checkLine(lineP({ proof: ['m_0124'] }), env())).toMatchObject({ ok: true, value: { kind: 'open', downgraded: true } });
  });
  it('counts a 👍 on a proof message as a yes, and the organizer alone as enough', () => {
    expect(checkLine(lineP({ proof: ['m_0122'] }), withThumb())).toMatchObject({ ok: true, value: { kind: 'agreed', personIds: ['p_priya', 'p_rahul'] } });
    expect(checkLine(lineP({ text: 'Dinner at Thalassa on Saturday', proof: ['m_0150'] }), env())).toMatchObject({ ok: true, value: { kind: 'agreed' } });
  });
  it('writes "open" when someone objected', () => {
    expect(checkLine(lineP({ text: 'Dinner at Thalassa on Saturday', proof: ['m_0150'], objections: ['m_0151'] }), env()))
      .toMatchObject({ ok: true, value: { kind: 'open' } });
  });
  it('lets only the person who said it be on a doing line', () => {
    expect(checkLine(lineP({ kind: 'doing', text: 'Kabir books the airport cab', proof: ['m_0140'], person_ids: ['p_kabir'] }), env()).ok).toBe(true);
    expect(checkLine(lineP({ kind: 'doing', text: 'Kabir books the airport cab', proof: ['m_0141'], person_ids: ['p_kabir'] }), env()))
      .toEqual({ ok: false, reason: 'a doing line names someone who did not say they would do it' });
  });
  it('lets an open question cite Go, and nothing else', () => {
    expect(checkLine(lineP({ kind: 'open', text: 'Scuba on Saturday?', proof: ['m_0143'], person_ids: ['p_meher', 'p_kabir'] }), env()))
      .toMatchObject({ ok: true, value: { kind: 'open', proof: [{ message_id: 'm_0143', person_id: null }] } });
    expect(checkLine(lineP({ text: 'Scuba on Saturday', proof: ['m_0143'] }), env()).ok).toBe(false);
  });
  it('refuses a stranger, no proof, a deleted or secret proof, and a forgotten person\'s proof', () => {
    expect(checkLine(lineP({ proof: ['m_0122', 'm_0124'], person_ids: ['p_nobody'] }), env()).ok).toBe(false);
    expect(checkLine(lineP({ proof: [] }), env()).ok).toBe(false);
    expect(checkLine(lineP({ kind: 'doing', text: 'Kabir books the cab', proof: ['m_0142'], person_ids: ['p_kabir'] }), env()).ok).toBe(false);
    expect(checkLine(lineP({ proof: ['m_0122', 'm_0124'] }), env({ forgotten: new Map([['p_arjun', 200]]) })).ok).toBe(false);
  });
  it('never repeats an active line, and brings back an undone one only on new messages', () => {
    const active = env({ record: [line({ text: 'North Goa, not South!' })] });
    expect(checkLine(lineP({ proof: ['m_0122', 'm_0124'] }), active)).toEqual({ ok: false, reason: 'already in the record' });
    const undone = (at: string) => env({ record: [line({ text: 'Thalassa it is', status: 'undone', updated_at: at })] });
    const p = lineP({ kind: 'open', text: 'Thalassa it is', proof: ['m_0170'] });
    expect(checkLine(p, undone('2026-10-05T08:00:00Z')).ok).toBe(false);
    expect(checkLine(p, undone('2026-10-05T06:00:00Z')).ok).toBe(true);
  });
  it('updates only Go\'s own lines that nobody undid', () => {
    const rec = env({ record: [line({ line_id: 'r_dates', source: 'vote' }), line({ line_id: 'r_scuba', source: 'go', kind: 'open' }), line({ line_id: 'r_old', status: 'undone' })] });
    expect(checkLine(lineP({ line_id: 'r_dates', proof: ['m_0122', 'm_0124'] }), rec).ok).toBe(false);
    expect(checkLine(lineP({ line_id: 'r_old', proof: ['m_0122', 'm_0124'] }), rec).ok).toBe(false);
    expect(checkLine(lineP({ line_id: 'r_scuba', proof: ['m_0122', 'm_0124'] }), rec)).toMatchObject({ ok: true, value: { lineId: 'r_scuba' } });
  });
  it('drops a due date that is not a date', () => {
    const r = checkLine(lineP({ kind: 'open', text: 'Deposit this week?', proof: ['m_0150'], due_at: 'Friday' }), env());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.dueAt).toBeUndefined();
  });
});
