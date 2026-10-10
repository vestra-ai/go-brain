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
      value: { personId: 'p_meher', tripId: 't_goa', topic: 'food', text: 'Allergic to peanuts', messageId: 'm_0130', saidAt: new Date(messages[2]!.sent_at), audience: 'group', scope: 'person' },
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
  it("never saves a person's budget or a money figure as a fact: budgets stay private to the trip (staging 8 Oct)", () => {
    const said = [
      msg(200, 'p_meher', 'for me a pool stay under ₹3,000 per night max'),
      msg(201, 'p_meher', "my budget's tight this time"),
      msg(202, 'p_meher', "I can't leave before 6 pm on Friday"),
    ];
    const e = env({ pack: packOf([...messages, ...said], goaTrip()) });
    const refused = { ok: false, reason: "a person's budget or money stays private to the trip" };
    // The fact staging saved for Meher, and a budget with no amount.
    expect(checkFact({ person_id: 'p_meher', topic: 'budget', text: 'Pool stay under ₹3,000 per night', message_id: 'm_0200' }, e)).toEqual(refused);
    expect(checkFact({ person_id: 'p_meher', topic: 'stays', text: 'Pool stay under 3k a night', message_id: 'm_0200' }, e)).toEqual(refused);
    expect(checkFact({ person_id: 'p_meher', topic: 'Budget', text: 'Tight this time', message_id: 'm_0201' }, e)).toEqual(refused);
    // A time is not money: a lasting fact with a number still saves.
    expect(checkFact({ person_id: 'p_meher', topic: 'leaving', text: "Can't leave before 6 pm Friday", message_id: 'm_0202' }, e).ok).toBe(true);
  });

  it('a fact about this trip alone is kept as such: never carried into the next trip', () => {
    const said = msg(210, 'p_arjun', 'actually I can do Thursday now');
    const e = env({ pack: packOf([...messages, said], goaTrip()) });
    expect(checkFact({ person_id: 'p_arjun', topic: 'leaving', text: 'Can leave Thursday', message_id: 'm_0210', this_trip: true }, e)).toMatchObject({ ok: true, value: { scope: 'trip' } });
  });

  it("reads a reactor's lean off their reaction, never a rule, and never for someone who did not react (staging, 10 Oct)", () => {
    const villa = msg(220, 'p_rahul', 'Villa Sol, ₹12k a night, private pool', { reactions: [{ emoji: '👍', person_id: 'p_meher' }, { emoji: '👍', person_id: null }] });
    const photo = msg(221, 'p_priya', 'this vibe 😍', { reactions: [{ emoji: '😍', person_id: 'p_kabir' }] });
    const e = env({ pack: packOf([...messages, villa, photo], goaTrip()) });
    // Meher's 👍 on Rahul's line: her lean, with his line as the proof. The line's price is his words, not her fact.
    expect(checkFact({ person_id: 'p_meher', topic: 'stays', text: 'Likes villas with a private pool', message_id: 'm_0220', reaction: true }, e))
      .toMatchObject({ ok: true, value: { personId: 'p_meher', messageId: 'm_0220', text: 'Likes villas with a private pool' } });
    expect(checkFact({ person_id: 'p_kabir', topic: 'stays', text: 'Prefers beachy places', message_id: 'm_0221', reaction: true }, e)).toMatchObject({ ok: true });
    // Never for someone who did not react, never as a rule, never from Go's reaction.
    expect(checkFact({ person_id: 'p_arjun', topic: 'stays', text: 'Likes pool villas', message_id: 'm_0220', reaction: true }, e))
      .toEqual({ ok: false, reason: 'that person did not react to that line' });
    expect(checkFact({ person_id: 'p_meher', topic: 'stays', text: 'Only pool villas', message_id: 'm_0220', reaction: true }, e))
      .toEqual({ ok: false, reason: 'a reaction only shows a lean: Prefers, Likes, Dislikes or Wants' });
    // Someone Go was asked to forget: no lean from their reactions either.
    expect(checkFact({ person_id: 'p_meher', topic: 'stays', text: 'Likes pool villas', message_id: 'm_0220', reaction: true }, env({ pack: packOf([...messages, villa], goaTrip()), forgotten: new Map([['p_meher', 230]]) })))
      .toEqual({ ok: false, reason: 'that person asked Go to forget this' });
    // Without "reaction", Meher's fact on Rahul's line is still someone else's words.
    expect(checkFact({ person_id: 'p_meher', topic: 'stays', text: 'Likes pool villas', message_id: 'm_0220' }, e)).toEqual({ ok: false, reason: 'the proof is not a message by that person' });
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
  it('never makes a doing line from a message to Go: an ask is Go\'s job, not its author\'s', () => {
    const ask = msg(180, 'p_rahul', '@Go find flights Friday');
    const mixed = msg(181, 'p_kabir', "@Go I'll sort the cab, you do flights");
    const e = env({ pack: packOf([...messages, ask, mixed], goaTrip()) });
    const refused = { ok: false, reason: 'a doing line cannot rest on a message to Go: that is an ask, and Go does it' };
    expect(checkLine(lineP({ kind: 'doing', text: 'Rahul is finding flights', proof: ['m_0180'], person_ids: ['p_rahul'] }), e)).toEqual(refused);
    expect(checkLine(lineP({ kind: 'doing', text: 'Rahul is finding flights', proof: ['m_0180'], person_ids: [] }), e)).toEqual(refused);
    // A real promise still makes a doing line for its author.
    expect(checkLine(lineP({ kind: 'doing', text: 'Kabir books the airport cab', proof: ['m_0140'], person_ids: ['p_kabir'] }), e))
      .toMatchObject({ ok: true, value: { kind: 'doing', personIds: ['p_kabir'] } });
    // A promise said to Go in the same breath is refused too (see checker.ts): its words cannot be told from the ask.
    expect(checkLine(lineP({ kind: 'doing', text: 'Kabir sorts the cab', proof: ['m_0181'], person_ids: ['p_kabir'] }), e)).toEqual(refused);
  });

  it('never makes a doing line from a payment or a debt: that is an expense, a money record (staging 8 Oct)', () => {
    const paid = msg(190, 'p_kabir', 'I paid 2400 for the cab from the airport, split between all of us');
    const owes = msg(191, 'p_priya', 'Kabir owes me 500 for the dinner');
    const later = msg(192, 'p_rahul', 'I will pay for the villa and you all send me later');
    const e = env({ pack: packOf([...messages, paid, owes, later], goaTrip()) });
    const refused = { ok: false, reason: 'a payment or a debt is a money record, not a doing line' };
    expect(checkLine(lineP({ kind: 'doing', text: 'Paid for airport cab', proof: ['m_0190'], person_ids: ['p_kabir'] }), e)).toEqual(refused);
    expect(checkLine(lineP({ kind: 'doing', text: 'Paid for dinner', proof: ['m_0191'], person_ids: ['p_priya'] }), e)).toEqual(refused);
    // A promise to pay later is a job someone takes on: still a doing line.
    expect(checkLine(lineP({ kind: 'doing', text: 'Rahul pays for the villa', proof: ['m_0192'], person_ids: ['p_rahul'] }), e))
      .toMatchObject({ ok: true, value: { kind: 'doing', personIds: ['p_rahul'] } });
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

describe('checkLine: an ask to Go is answered, never an open line', () => {
  const at = (s: number) => new Date(Date.parse('2026-10-05T10:00:00Z') + s * 1_000).toISOString();
  const said = [
    msg(200, 'p_arjun', "@Go what's planned for Sunday?"),
    msg(201, 'p_priya', 'how about we stay in Candolim?'),
    msg(202, 'p_rahul', "@Go we're doing 6 to 9 Nov"),
    msg(203, 'p_meher', '@Go one thing', { sent_at: at(0) }),
    msg(204, 'p_meher', 'for my birthday on the 7th', { sent_at: at(1) }),
    msg(205, 'p_meher', 'is there a good bakery near Anjuna?', { sent_at: at(2) }),
  ];
  const askEnv = (): CheckEnv => ({ pack: packOf(said, goaTrip()), forgotten: new Map(), record: [] });

  it('refuses an open line resting on a question put to Go, or on a burst to Go', () => {
    const reason = { ok: false, reason: 'an open line cannot rest on a question put to Go: Go answers it' };
    expect(checkLine(lineP({ kind: 'open', text: 'What is planned for Sunday?', proof: ['m_0200'] }), askEnv())).toEqual(reason);
    expect(checkLine(lineP({ kind: 'open', text: 'A bakery near Anjuna', proof: ['m_0205'] }), askEnv())).toEqual(reason);
  });

  it('keeps a question the group asks itself as open, and a plan stated to Go as agreed', () => {
    expect(checkLine(lineP({ kind: 'open', text: 'Stay in Candolim?', proof: ['m_0201'] }), askEnv())).toMatchObject({ ok: true, value: { kind: 'open' } });
    expect(checkLine(lineP({ kind: 'agreed', text: '6 to 9 Nov', proof: ['m_0202'] }), askEnv())).toMatchObject({ ok: true, value: { kind: 'agreed' } });
    // One line from the group is enough for an open line, even beside an ask to Go.
    expect(checkLine(lineP({ kind: 'open', text: 'Sunday plans', proof: ['m_0200', 'm_0201'] }), askEnv()).ok).toBe(true);
  });
});
