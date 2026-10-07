import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeLink, type FakeAnswers } from '../../__tests__/fixtures/fake-link.js';
import { ev, goaSnapshot, msg, vote } from '../../__tests__/fixtures/goa.js';
import { withSchema } from '../../db/test-db.js';
import { silentLog } from '../../log.js';
import { TripGoneError } from '../gone.js';
import { createPacks } from '../pack.js';

let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
});
afterAll(() => db.drop());

function make(answers: FakeAnswers = {}) {
  const f = fakeLink(answers);
  return { packs: createPacks({ pool: db.pool, link: f.link, log: silentLog, now: () => new Date() }), ...f };
}

describe('Packs', () => {
  it('loads a trip cold: read_trip, then every message page by page, oldest first', async () => {
    const T = 't_cold';
    const { packs, calls } = make({
      read_trip: () => goaSnapshot({ trip_id: T, seq: 4 }),
      read_messages: (p) =>
        p.after_seq === 0
          ? { messages: [msg(2, 'p_priya', 'hi'), msg(3, 'p_rahul', 'hello')], has_more: true }
          : { messages: [msg(4, 'p_arjun', 'yo')], has_more: false },
    });
    const pack = await packs.get(T);
    expect(pack.messages.map((m) => m.seq)).toEqual([2, 3, 4]);
    expect(pack.seq).toBe(4);
    expect(calls.filter((c) => c.method === 'read_messages').map((c) => c.params.after_seq)).toEqual([0, 3]);
    const { rows } = await db.pool.query<{ n: number }>('select count(*)::int as n from messages where trip_id = $1', [T]);
    expect(rows[0]?.n).toBe(3);
    await packs.get(T);
    expect(calls.filter((c) => c.method === 'read_trip')).toHaveLength(1);
    expect(packs.active()).toContain(T);
  });

  it('makes the pack from trip.created with no read at all', async () => {
    const { packs, calls } = make();
    await packs.apply(ev(1, 'trip.created', { trip: goaSnapshot({ trip_id: 't_new' }) }, 't_new'));
    expect((await packs.get('t_new')).trip.title).toBe('Goa 🌴');
    expect(calls).toEqual([]);
  });

  it('keeps the pack current from events, and reads the trip again when an event says only that it changed', async () => {
    const T = 't_live';
    const { packs, calls } = make({ read_trip: () => goaSnapshot({ trip_id: T, seq: 20, title: 'Goa trip' }) });
    const by = { kind: 'go' } as const;
    await packs.apply(ev(1, 'trip.created', { trip: goaSnapshot({ trip_id: T }) }, T));
    await packs.apply(ev(2, 'message.created', { message: msg(2, 'p_priya', 'scuba sunday?') }, T));
    await packs.apply(ev(3, 'reaction.added', { message_id: 'm_2', reaction: { emoji: '👍', person_id: 'p_rahul' } }, T));
    await packs.apply(ev(4, 'reaction.added', { message_id: 'm_2', reaction: { emoji: '👍', person_id: 'p_rahul' } }, T));
    await packs.apply(
      ev(5, 'person.joined', {
        person: { person_id: 'p_zoya', name: 'Zoya', role: 'member', joined_at: '2026-10-05T11:00:00Z', know: [], has_upi: false, go_paused: false },
      }, T),
    );
    await packs.apply(ev(6, 'decision.opened', { decision: vote({ decision_id: 'd_stay' }), by }, T));
    await packs.apply(ev(7, 'decision.voted', { decision_id: 'd_stay', person_id: 'p_priya', option_index: 0, voted: 1, of: 6, tally: [1, 0] }, T));
    let pack = await packs.get(T);
    expect(pack.messages[0]?.reactions).toEqual([{ emoji: '👍', person_id: 'p_rahul' }]);
    expect(pack.trip.people.map((p) => p.person_id)).toContain('p_zoya');
    expect(pack.trip.decisions[0]).toMatchObject({ voted: 1, tally: [1, 0], votes: [{ person_id: 'p_priya', option_index: 0 }] });

    await packs.apply(
      ev(8, 'decision.closed', {
        decision: vote({ decision_id: 'd_stay', status: 'closed', voted: 4, tally: [3, 1], result_index: 0, closed_at: '2026-10-05T12:00:00Z' }),
        reason: 'time',
      }, T),
    );
    await packs.apply(
      ev(9, 'mandate.set', {
        decision_id: 'd_stay',
        mandate: { choice_index: 0, cap_minor: 5_500_000, currency: 'INR', refundable_only: true, payer_person_id: 'p_rahul', set_at: '2026-10-05T12:01:00Z' },
      }, T),
    );
    await packs.apply(ev(10, 'mandate.confirmed', { decision_id: 'd_stay', person_id: 'p_rahul' }, T));
    await packs.apply(
      ev(11, 'record.changed', {
        line: {
          line_id: 'l_1', kind: 'agreed', text: 'North Goa it is', status: 'active', proof: [{ message_id: 'm_2' }],
          person_ids: ['p_priya'], source: 'go', created_at: '2026-10-05T12:02:00Z', updated_at: '2026-10-05T12:02:00Z',
        },
        change: 'added',
        by,
      }, T),
    );
    await packs.apply(ev(12, 'reaction.removed', { message_id: 'm_2', reaction: { emoji: '👍', person_id: 'p_rahul' } }, T));
    await packs.apply(ev(13, 'message.edited', { message: msg(2, 'p_priya', 'scuba on sunday?', { updated_seq: 13, edited_at: '2026-10-05T12:03:00Z' }) }, T));
    await packs.apply(ev(14, 'person.left', { person_id: 'p_zoya' }, T));
    pack = await packs.get(T);
    expect(pack.trip.decisions[0]).toMatchObject({ status: 'closed', result_index: 0 });
    expect(pack.trip.decisions[0]?.mandate?.confirmed_at).toBeTruthy();
    expect(pack.trip.record.map((l) => l.line_id)).toEqual(['l_1']);
    expect(pack.messages[0]).toMatchObject({ text: 'scuba on sunday?', reactions: [] });
    expect(pack.trip.people.map((p) => p.person_id)).not.toContain('p_zoya');
    expect(pack.seq).toBe(14);

    await packs.apply(ev(15, 'message.deleted', { message_id: 'm_2' }, T));
    pack = await packs.get(T);
    expect(pack.messages).toEqual([]);
    const { rows } = await db.pool.query('select text, deleted_at, payload from messages where trip_id = $1 and message_id = $2', [T, 'm_2']);
    expect(rows[0].text).toBeNull();
    expect(rows[0].deleted_at).toBeInstanceOf(Date);
    expect(rows[0].payload.text).toBeUndefined();

    await packs.apply(ev(16, 'trip.updated', { by: { kind: 'person', person_id: 'p_rahul' }, changed: ['title'] }, T));
    expect((await packs.get(T)).trip.title).toBe('Goa trip');
    expect(calls.filter((c) => c.method === 'read_trip')).toHaveLength(1);
  });

  it('refill reads the trip again and returns only the messages Go never stored, page by page', async () => {
    const T = 't_gap';
    const { packs, calls } = make({
      read_trip: () => goaSnapshot({ trip_id: T, seq: 43 }),
      read_messages: (p) =>
        p.after_seq === 41
          ? { messages: [msg(42, 'p_arjun', '@Go are you there?')], has_more: true }
          : { messages: [msg(10, 'p_priya', 'old one', { updated_seq: 43 })], has_more: false },
    });
    await packs.apply(ev(1, 'trip.created', { trip: goaSnapshot({ trip_id: T }) }, T));
    await packs.apply(ev(10, 'message.created', { message: msg(10, 'p_priya', 'old one') }, T));
    await packs.apply(ev(41, 'message.created', { message: msg(41, 'p_rahul', 'hmm') }, T));
    const fresh = await packs.refill(T, 41);
    expect(fresh.map((m) => m.seq)).toEqual([42]);
    expect(calls.filter((c) => c.method === 'read_messages').map((c) => c.params.after_seq)).toEqual([41, 42]);
    const pack = await packs.get(T);
    expect(pack.trip.seq).toBe(43);
    expect(pack.messages.map((m) => m.seq)).toEqual([10, 41, 42]);
  });

  it('never reads a trip marked gone: loading or refilling it stops before any request', async () => {
    const T = 't_pack_gone';
    const { packs, calls } = make({ read_trip: () => goaSnapshot({ trip_id: T, seq: 1 }), read_messages: () => ({ messages: [], has_more: false }) });
    await packs.get(T);
    const asked = calls.length;
    await db.pool.query('insert into trips (trip_id, gone_at) values ($1, now()) on conflict (trip_id) do update set gone_at = now()', [T]);
    // The pack still in hand: the refill doesn't read either.
    await expect(packs.refill(T)).rejects.toBeInstanceOf(TripGoneError);
    packs.invalidate(T);
    await expect(packs.get(T)).rejects.toBeInstanceOf(TripGoneError);
    expect(calls).toHaveLength(asked);
    // Once the mark is cleared (the Server sent an event for it), it loads again.
    await db.pool.query('update trips set gone_at = null where trip_id = $1', [T]);
    await packs.get(T);
    expect(calls.filter((c) => c.method === 'read_trip')).toHaveLength(2);
  });

  it('invalidate drops a pack so the next get reads it fresh', async () => {
    const T = 't_drop';
    const { packs, calls } = make({ read_trip: () => goaSnapshot({ trip_id: T }), read_messages: () => ({ messages: [], has_more: false }) });
    await packs.get(T);
    packs.invalidate(T);
    await packs.get(T);
    expect(calls.filter((c) => c.method === 'read_trip')).toHaveLength(2);
  });
});
