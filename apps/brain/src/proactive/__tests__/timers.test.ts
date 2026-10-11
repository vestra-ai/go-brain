import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { goaPack, goaTrip, msg, seedTrip } from '../fakes.js';
import { ProactiveStore } from '../store.js';
import { dateClashes, nonVoters, planTimers, replanTimers, stillTrue } from '../timers.js';

const TZ = 'Asia/Kolkata';
const NOON = new Date('2026-10-06T06:30:00Z');
const byTopic = (cs: ReturnType<typeof planTimers>, topic: string) => cs.filter((c) => c.topic === topic);

describe('planTimers', () => {
  const plans = planTimers(goaTrip(), TZ, NOON);

  it('reminds the people who have not voted 2 hours before the vote closes', () => {
    const [v] = byTopic(plans, 'vote_closing');
    expect(v).toMatchObject({
      dedupeKey: 'vote_closing:d_villa:2026-10-06T12:30:00Z',
      source: 'timer',
      useful: ['pin'],
      personIds: ['p_arjun', 'p_meher'],
    });
    expect(v?.dueAt.toISOString()).toBe('2026-10-06T10:30:00.000Z');
    expect(v?.expiresAt?.toISOString()).toBe('2026-10-06T12:30:00.000Z');
  });

  it('warns the payer a day before free cancellation ends', () => {
    const [f] = byTopic(plans, 'free_cancel');
    expect(f).toMatchObject({ personIds: ['p_rahul'], useful: ['pin'] });
    expect(f?.dueAt.toISOString()).toBe('2026-10-31T18:29:59.000Z');
  });

  it('plans travel day at 7 pm local the evening before, and settle-up the day after', () => {
    expect(byTopic(plans, 'travel_day')[0]?.dueAt.toISOString()).toBe('2026-11-05T13:30:00.000Z');
    expect(byTopic(plans, 'settle_up')[0]?.dueAt.toISOString()).toBe('2026-11-10T05:30:00.000Z');
  });

  it('plans nothing for a payer until a mandate waits', () => {
    expect(byTopic(plans, 'payer_waiting')).toHaveLength(0);
    const base = goaTrip();
    const d = { ...base.decisions[0]!, status: 'closed' as const, mandate: { choice_index: 0, cap_minor: 5500000, currency: 'INR', refundable_only: true, payer_person_id: 'p_rahul', set_at: '2026-10-05T05:00:00Z' } };
    const [p] = byTopic(planTimers(goaTrip({ decisions: [d] }), TZ, NOON), 'payer_waiting');
    expect(p).toMatchObject({ personIds: ['p_rahul'], dedupeKey: 'payer_waiting:d_villa:2026-10-05T05:00:00Z' });
    expect(p?.dueAt.toISOString()).toBe(NOON.toISOString()); // already a day: due now
  });

  it('is due now when less than 2 hours are left, and uses a message for an anonymous vote', () => {
    const base = goaTrip();
    const d = { ...base.decisions[0]!, anonymous: true, votes: null, closes_at: '2026-10-06T07:30:00Z' };
    const [v] = byTopic(planTimers(goaTrip({ decisions: [d] }), TZ, NOON), 'vote_closing');
    expect(v).toMatchObject({ useful: ['message'], personIds: [] });
    expect(v?.dueAt.toISOString()).toBe(NOON.toISOString());
  });

  it('plans nothing that has already passed', () => {
    const after = new Date('2026-11-20T00:00:00Z');
    expect(planTimers(goaTrip(), TZ, after)).toEqual([]);
  });
});

describe('the trip helpers', () => {
  it('lists the people who have not voted', () => {
    expect(nonVoters(goaTrip(), 'd_villa')).toEqual(['p_arjun', 'p_meher']);
    expect(nonVoters(goaTrip(), 'd_missing')).toEqual([]);
  });

  it('finds bookings that fall outside new dates', () => {
    expect(dateClashes(goaTrip())).toEqual([]);
    const moved = goaTrip({ dates: { start: '2026-11-13', end: '2026-11-16' } });
    expect(dateClashes(moved).map((c) => c.booking_id)).toEqual(['b_villa', 'b_flight']);
  });
});

describe('stillTrue', () => {
  const plans = planTimers(goaTrip(), TZ, NOON);
  const vote = byTopic(plans, 'vote_closing')[0]!;

  it('refreshes who still has not voted', () => {
    const base = goaTrip();
    const d = { ...base.decisions[0]!, voted: 4, votes: [...(base.decisions[0]!.votes ?? []), { person_id: 'p_arjun', option_index: 0 }] };
    expect(stillTrue(vote, goaPack({ trip: goaTrip({ decisions: [d] }) }))).toEqual({ ok: true, personIds: ['p_meher'] });
  });

  it('pins nobody once someone said they are flexible: who has not voted is not known, so the reminder goes to the group (1.1 A5)', () => {
    const base = goaTrip();
    // Arjun said he is flexible: voted 4 with three picks named, flexible_count 1.
    const d = { ...base.decisions[0]!, voted: 4, flexible_count: 1 };
    const trip = goaTrip({ decisions: [d] });
    expect(nonVoters(trip, d.decision_id)).toEqual([]);
    const plan = byTopic(planTimers(trip, TZ, NOON), 'vote_closing')[0]!;
    expect(plan).toMatchObject({ useful: ['message'], personIds: [] });
    expect(stillTrue(vote, goaPack({ trip }))).toEqual({ ok: true, personIds: [] });
  });

  it('drops a vote reminder once the vote closed or moved', () => {
    const base = goaTrip();
    expect(stillTrue(vote, goaPack({ trip: goaTrip({ decisions: [{ ...base.decisions[0]!, status: 'closed' }] }) }))).toEqual({ ok: false });
    expect(stillTrue(vote, goaPack({ trip: goaTrip({ decisions: [{ ...base.decisions[0]!, closes_at: '2026-10-07T12:30:00Z' }] }) }))).toEqual({ ok: false });
  });

  it('needs open transfers for settle-up', () => {
    const settle = byTopic(plans, 'settle_up')[0]!;
    expect(stillTrue(settle, goaPack())).toEqual({ ok: false });
    const owed = goaTrip({ money: { currency: 'INR', spent_minor: 1, by_category: [], transfers: [{ from_person_id: 'p_priya', to_person_id: 'p_rahul', amount_minor: 100, currency: 'INR' }] } });
    expect(stillTrue(settle, goaPack({ trip: owed }))).toMatchObject({ ok: true });
  });

  it('drops a watch nudge once its booking is cancelled or a later reading replaced it', () => {
    const delay = { tripId: 't_goa', dedupeKey: 'flight:t_goa:b_flight:delay:120', source: 'watch' as const, topic: 'flight_status', dueAt: NOON, expiresAt: null,
      importance: 0.9, confidence: 1, urgency: 0.9, useful: ['pin' as const], personIds: ['p_rahul'], facts: { watchId: 'flight:t_goa:b_flight', delayMinutes: 120 }, simulated: false, small: false };
    const current = new Map([['flight:t_goa:b_flight', 'flight:t_goa:b_flight:delay:120']]);
    expect(stillTrue(delay, goaPack(), current)).toMatchObject({ ok: true });
    // The flight is back on time: the watch's newest change is another one.
    expect(stillTrue(delay, goaPack(), new Map([['flight:t_goa:b_flight', 'flight:t_goa:b_flight:on_time']]))).toEqual({ ok: false });
    // The booking was cancelled.
    const base = goaTrip();
    const cancelled = goaTrip({ bookings: base.bookings.map((b) => (b.booking_id === 'b_flight' ? { ...b, status: 'cancelled' as const } : b)) });
    expect(stillTrue(delay, goaPack({ trip: cancelled }), current)).toEqual({ ok: false });
    // The demo's simulated delay has no watch behind it.
    expect(stillTrue({ ...delay, simulated: true, facts: { delayMinutes: 120 } }, goaPack())).toMatchObject({ ok: true });
  });

  it('drops a chat opening whose message was deleted', () => {
    const c = { ...vote, topic: 'chat', source: 'opening' as const, facts: { message_id: 'm_7', seq: 7 } };
    expect(stillTrue(c, goaPack({ messages: [msg({ id: 'm_7', seq: 7 })] }))).toMatchObject({ ok: true });
    expect(stillTrue(c, goaPack({ messages: [msg({ id: 'm_7', seq: 7, deleted: true, text: null })] }))).toEqual({ ok: false });
  });
});

describe('replanTimers', () => {
  let db: Awaited<ReturnType<typeof withSchema>>;
  let store: ProactiveStore;
  beforeAll(async () => {
    db = await withSchema();
    store = new ProactiveStore(db.pool);
    await seedTrip(db.pool, 't_goa');
  });
  afterAll(async () => {
    await db.drop();
  });

  it('is safe to repeat, and moves a reminder when the vote closing time moves', async () => {
    expect(await replanTimers(store, goaTrip(), TZ, NOON)).toBe(4);
    await replanTimers(store, goaTrip(), TZ, NOON);
    const pending = await db.pool.query(`select dedupe_key from proactive_candidates where trip_id = 't_goa' and status = 'pending' order by dedupe_key`);
    expect(pending.rows).toHaveLength(4);

    const base = goaTrip();
    const later = goaTrip({ decisions: [{ ...base.decisions[0]!, closes_at: '2026-10-07T12:30:00Z' }] });
    await replanTimers(store, later, TZ, NOON);
    expect((await store.status('t_goa', 'vote_closing:d_villa:2026-10-06T12:30:00Z'))?.reason).toBe('replanned');
    expect((await store.status('t_goa', 'vote_closing:d_villa:2026-10-07T12:30:00Z'))?.status).toBe('pending');
  });
});
