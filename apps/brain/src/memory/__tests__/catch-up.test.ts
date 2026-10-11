import * as C from '@go/contract';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { fakePacks, goaTrip, msg, packOf } from '../../reflex/goa.fixture.js';
import type { JevAskRequest, JevResult } from '../../reflex/jev.js';
import { silentLog } from '../../log.js';
import { catchUpHandler, rankQuestions } from '../catch-up.js';

let db: { pool: Pool; drop: () => Promise<void> };
beforeAll(async () => { db = await withSchema(); });
afterAll(async () => { await db.drop(); });
const meta = { instance: 'server-1', frameId: 'gs_2' };

const rl = (over: Partial<C.RecordLine>): C.RecordLine => ({
  line_id: 'r_x', kind: 'agreed', text: 'x', status: 'active', proof: [], person_ids: [], source: 'go',
  created_at: '2026-10-05T04:00:00Z', updated_at: '2026-10-05T04:00:00Z', ...over,
});
function trip(tripId: string, extra: C.RecordLine[] = []) {
  return goaTrip({
    trip_id: tripId,
    seq: 180,
    record: [
      rl({ line_id: 'r_dates', kind: 'decided', text: '6 to 9 Nov', source: 'vote', decision_id: 'd_when', updated_at: '2026-10-05T03:45:00Z' }),
      rl({ line_id: 'r_villa', kind: 'booked', text: 'Villa Sol, 3 nights', source: 'booking', booking_id: 'b_villa', updated_at: '2026-10-05T09:03:00Z' }),
      rl({ line_id: 'r_scuba', kind: 'open', text: 'Scuba on Saturday?', person_ids: ['p_meher', 'p_kabir'], proof: [{ message_id: 'm_0149', person_id: 'p_arjun' }], updated_at: '2026-10-05T07:20:00Z' }),
      rl({ line_id: 'r_cab', kind: 'doing', text: 'Kabir books the airport cab', status: 'done', person_ids: ['p_kabir'], updated_at: '2026-10-05T13:20:00Z' }),
      ...extra,
    ],
    bookings: [{
      booking_id: 'b_villa', kind: 'stay', status: 'confirmed', title: 'Villa Sol', vendor: 'ixigo', ref: 'IX12345', amount_minor: 5_420_000,
      currency: 'INR', payer_person_id: 'p_rahul', for_person_ids: ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir'],
      image_url: 'https://brain.go.example/img/villa-sol.jpg', created_at: '2026-10-05T09:03:00Z',
    }],
    decisions: [{
      decision_id: 'd_beach', question: 'Beach day on Sunday?', kind: 'yesno', anonymous: false, status: 'open',
      options: [{ label: 'Yes' }, { label: 'No' }], voted: 1, of: 5, tally: [1, 0], votes: [{ person_id: 'p_rahul', option_index: 0 }],
      opened_at: '2026-10-05T10:00:00Z',
    }],
  });
}
const messages = [
  msg(149, 'p_arjun', 'Scuba on Saturday?'),
  msg(166, 'go', null, { card: { card_id: 'c_ticket', kind: 'ticket', booking_id: 'b_villa', fallback_text: 'Villa Sol is booked' } }),
  msg(170, 'go', null, { card: { card_id: 'c_vote', kind: 'vote', decision_id: 'd_beach', fallback_text: 'Vote: beach day on Sunday?' } }),
  msg(171, 'p_priya', 'Meher are you okay with a 6 am start?', { mentions: ['p_meher'] }),
];
function jevAnswering(p: Record<string, number> | null) {
  const asked: JevAskRequest[] = [];
  return {
    asked,
    ask: async (req: JevAskRequest): Promise<JevResult> => {
      asked.push(req);
      if (!p) return { ok: false, fault: 'timeout', totalMs: 1_000 };
      return { ok: true, answers: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { type: 'noul' as const, noul: v }])), inputTokens: 300, serverMs: 90, totalMs: 140 };
    },
  };
}

describe('catch_up', () => {
  it('puts what needs the person first, then what changed, with links, and the answer validates', async () => {
    const jev = jevAnswering({});
    const handler = catchUpHandler({ pool: db.pool, packs: fakePacks({ t_c1: packOf(messages, trip('t_c1')) }), jev, log: silentLog });
    const res = await handler({ trip_id: 't_c1', person_id: 'p_meher', since: '2026-10-05T05:00:00Z' }, meta);
    expect(C.CatchUp.safeParse(res).success).toBe(true);
    expect(res.items).toEqual([
      { kind: 'needs_you', text: 'Vote: Beach day on Sunday?', message_id: 'm_0170' },
      { kind: 'needs_you', text: 'Go is asking you: Scuba on Saturday?', message_id: 'm_0149' },
      { kind: 'needs_you', text: 'Priya mentioned you: Meher are you okay with a 6 am start?', message_id: 'm_0171' },
      { kind: 'booked', text: 'Booked: Villa Sol, 3 nights', image_url: 'https://brain.go.example/img/villa-sol.jpg', message_id: 'm_0166' },
      { kind: 'news', text: 'Done: Kabir books the airport cab' },
    ]);
    expect(res.summary).toBe('While you were away, 1 booking went through. 3 things need you.');
    expect(jev.asked).toHaveLength(0);
  });

  // Rev 5 R5: a shared thing's options card is its vote, with no vote card beside it.
  it('links a vote to the options card that is the vote', async () => {
    const onCard = messages.map((m) => (m.message_id === 'm_0170'
      ? { ...m, card: { card_id: 'c_opts', kind: 'options', option_kind: 'activity', title: 'Beach day', fallback_text: 'Beach day', checked_at: '2026-10-05T10:00:00Z', options: [], decision_id: 'd_beach' } as unknown as C.Card }
      : m));
    const handler = catchUpHandler({ pool: db.pool, packs: fakePacks({ t_c7: packOf(onCard, trip('t_c7')) }), jev: jevAnswering({}), log: silentLog });
    const res = await handler({ trip_id: 't_c7', person_id: 'p_meher', since: '2026-10-05T05:00:00Z' }, meta);
    expect(res.items[0]).toEqual({ kind: 'needs_you', text: 'Vote: Beach day on Sunday?', message_id: 'm_0170' });
  });

  it("never lists a person's own question as Go asking them: it is \"You asked\", whoever the line names (Server team, 10 Oct)", async () => {
    // The line names its asker as the one asked, and its proof says who wrote it only through the message.
    const own = [rl({ line_id: 'r_bakery', kind: 'open', text: 'A good bakery near Anjuna?', person_ids: ['p_arjun'], proof: [{ message_id: 'm_0172', person_id: null }], updated_at: '2026-10-05T12:30:00Z' })];
    const pack = packOf([...messages, msg(172, 'p_arjun', 'is there a good bakery near Anjuna?')], trip('t_c6', own));
    const handler = catchUpHandler({ pool: db.pool, packs: fakePacks({ t_c6: pack }), jev: jevAnswering({}), log: silentLog });
    const arjun = await handler({ trip_id: 't_c6', person_id: 'p_arjun', since: '2026-10-05T05:00:00Z' }, meta);
    expect(arjun.items.filter((i) => i.kind === 'needs_you').map((i) => i.text)).toEqual(['Vote: Beach day on Sunday?']);
    expect(arjun.items).toContainEqual({ kind: 'open', text: 'You asked: Scuba on Saturday?', message_id: 'm_0149' });
    expect(arjun.items).toContainEqual({ kind: 'open', text: 'You asked: A good bakery near Anjuna?', message_id: 'm_0172' });
    expect(arjun.summary).toBe('While you were away, 1 booking went through. 1 thing needs you.');
    // Asked of someone else, it still needs them: Meher sees Arjun's scuba question as hers to answer.
    const meher = await handler({ trip_id: 't_c6', person_id: 'p_meher', since: '2026-10-05T05:00:00Z' }, meta);
    expect(meher.items).toContainEqual({ kind: 'needs_you', text: 'Go is asking you: Scuba on Saturday?', message_id: 'm_0149' });
  });

  it('asks Jev to rank the rest when there is more than fits, and keeps people\'s words out of the questions', async () => {
    const extra = [
      rl({ line_id: 'r_dinner', kind: 'agreed', text: 'Dinner at Thalassa on Saturday', updated_at: '2026-10-05T11:00:00Z' }),
      rl({ line_id: 'r_shack', kind: 'agreed', text: 'Breakfast at the beach shack', updated_at: '2026-10-05T12:00:00Z' }),
    ];
    const built = rankQuestions('Meher', [
      { kind: 'news', text: 'Agreed: Dinner at Thalassa on Saturday', at: 1, must: false },
      { kind: 'news', text: 'Agreed: Breakfast at the beach shack', at: 2, must: false },
    ]);
    expect(JSON.stringify(built.questions)).not.toContain('Thalassa');
    expect(JSON.stringify(built.state)).toContain('Thalassa');

    const jev = jevAnswering({ rank_u0: 0.2, rank_u1: 0.9, rank_u2: 0.1, rank_u3: 0.05 });
    const handler = catchUpHandler({ pool: db.pool, packs: fakePacks({ t_c2: packOf(messages, trip('t_c2', extra)) }), jev, log: silentLog });
    const res = await handler({ trip_id: 't_c2', person_id: 'p_meher', since: '2026-10-05T05:00:00Z' }, meta);
    expect(jev.asked).toHaveLength(1);
    expect(res.items).toHaveLength(5);
    expect(res.items.slice(0, 3).every((i) => i.kind === 'needs_you')).toBe(true);
    const updates = (jev.asked[0]!.state as { updates: Record<string, string> }).updates;
    expect(res.items[3]!.text).toBe(updates.u1);
  });

  it('still answers in order when Jev is down', async () => {
    const extra = [rl({ line_id: 'r_dinner', kind: 'agreed', text: 'Dinner at Thalassa on Saturday', updated_at: '2026-10-05T11:00:00Z' })];
    const handler = catchUpHandler({ pool: db.pool, packs: fakePacks({ t_c3: packOf(messages, trip('t_c3', extra)) }), jev: jevAnswering(null), log: silentLog });
    const res = await handler({ trip_id: 't_c3', person_id: 'p_meher', since: '2026-10-05T05:00:00Z' }, meta);
    expect(res.items.map((i) => i.kind)).toEqual(['needs_you', 'needs_you', 'needs_you', 'booked', 'news']);
  });

  it('keeps the 3 s limit when Jev never answers, and makes no Jev call while the reflex switch is off', async () => {
    const extra = [rl({ line_id: 'r_dinner', kind: 'agreed', text: 'Dinner at Thalassa on Saturday', updated_at: '2026-10-05T11:00:00Z' })];
    const packs = fakePacks({ t_c5: packOf(messages, trip('t_c5', extra)) });
    const silent = { asked: 0, ask: (): Promise<JevResult> => { silent.asked += 1; return new Promise<JevResult>(() => {}); } };
    const started = Date.now();
    const res = await catchUpHandler({ pool: db.pool, packs, jev: silent, log: silentLog })({ trip_id: 't_c5', person_id: 'p_meher', since: '2026-10-05T05:00:00Z' }, meta);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(silent.asked).toBe(1);
    expect(res.items.map((i) => i.kind)).toEqual(['needs_you', 'needs_you', 'needs_you', 'booked', 'news']);
    const jev = jevAnswering({ rank_u0: 0.1, rank_u1: 0.9, rank_u2: 0.2 });
    const off = await catchUpHandler({ pool: db.pool, packs, jev, log: silentLog, jevOn: () => false })({ trip_id: 't_c5', person_id: 'p_meher', since: '2026-10-05T05:00:00Z' }, meta);
    expect(jev.asked).toHaveLength(0);
    expect(off.items.map((i) => i.text).slice(3)).toEqual(['Booked: Villa Sol, 3 nights', 'Done: Kabir books the airport cab']);
  });

  it('shows nothing when nothing happened', async () => {
    const handler = catchUpHandler({ pool: db.pool, packs: fakePacks({ t_c4: packOf([], goaTrip({ trip_id: 't_c4' })) }), jev: jevAnswering({}), log: silentLog });
    expect(await handler({ trip_id: 't_c4', person_id: 'p_meher', since: '2026-10-05T05:00:00Z' }, meta)).toEqual({ summary: null, items: [] });
  });
});
