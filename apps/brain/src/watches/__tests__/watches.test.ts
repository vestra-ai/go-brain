import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { goaTrip } from '../../proactive/fakes.js';
import { recordPick, wayOf, type PersonPick } from '../../travel/picks.js';
import type { StatusResult } from '../../travel/travel.js';
import { diffReading, type WatchInfo } from '../diff.js';
import { flightNumber, noteWatchNotice, planWatches, syncWatches } from '../plan.js';

const NOW = new Date('2026-11-06T07:00:00Z'); // travel day, under 6 hours before the 12:45Z departure
const SCHEDULED = '2026-11-06T18:15:00+05:30';
const flight = (delayMinutes: number, state: 'scheduled' | 'delayed' | 'cancelled' = delayMinutes > 0 ? 'delayed' : 'scheduled'): StatusResult => ({
  kind: 'flight',
  state,
  scheduledDepartAt: SCHEDULED,
  expectedDepartAt: new Date(Date.parse(SCHEDULED) + delayMinutes * 60_000).toISOString(),
  delayMinutes,
  checkedAt: NOW.toISOString(),
});
const pnr = (state: 'confirmed' | 'waitlisted' | 'cancelled' | 'not_found', detail = ''): StatusResult => ({ kind: 'pnr', state, detail, checkedAt: NOW.toISOString() });
const info = (over: Partial<WatchInfo> = {}): WatchInfo => ({
  watchId: 'flight:t_goa:b_flight', kind: 'flight', label: 'IndiGo 6E 2134', hasNotice: false, hasPeople: true, endsAt: new Date('2026-11-06T16:15:00Z'), ...over,
});

/** The Goa trip with a train booked for Meher and Arjun, so its PNR is watched too. */
function withTrain(status: 'confirmed' | 'cancelled' = 'confirmed') {
  const base = goaTrip();
  return goaTrip({
    bookings: [
      ...base.bookings,
      {
        booking_id: 'b_train', kind: 'train', status, title: 'Mandovi Express, Mumbai to Madgaon', vendor: 'ixigo', ref: '8524117390',
        amount_minor: 210000, currency: 'INR', payer_person_id: 'p_meher', for_person_ids: ['p_meher', 'p_arjun'],
        starts_at: '2026-11-05T07:10:00+05:30', ends_at: '2026-11-05T19:00:00+05:30', created_at: '2026-10-05T11:00:00Z',
      },
    ],
  });
}

describe('diffReading: flights', () => {
  it('says nothing about a flight on time', () => {
    expect(diffReading(info(), null, flight(0), NOW)).toBeNull();
    expect(diffReading(info(), flight(0), flight(10), NOW)).toBeNull();
  });

  it('flags a delay of 30 minutes or more, once per 15-minute step, in P4 status words', () => {
    const c = diffReading(info(), flight(0), flight(120), NOW);
    expect(c).toMatchObject({
      changeKey: 'flight:t_goa:b_flight:delay:120',
      importance: 0.9,
      urgency: 0.9,
      useful: ['pin', 'message'],
      facts: { state: 'delayed', delayMinutes: 120, scheduledDepartAt: SCHEDULED, expectedDepartAt: '2026-11-06T14:45:00.000Z', beforeDelayMinutes: 0 },
    });
    expect(diffReading(info(), flight(120), flight(125), NOW)).toBeNull();
    expect(diffReading(info(), flight(120), flight(135), NOW)?.changeKey).toBe('flight:t_goa:b_flight:delay:135');
  });

  it('updates the earlier notice first when there is one, and only updates it when back on time', () => {
    expect(diffReading(info({ hasNotice: true }), flight(60), flight(120), NOW)?.useful).toEqual(['update_card', 'pin', 'message']);
    expect(diffReading(info({ hasNotice: true }), flight(120), flight(0), NOW)?.useful).toEqual(['update_card']);
    expect(diffReading(info({ hasNotice: false }), flight(120), flight(0), NOW)).toBeNull();
  });

  it('flags a cancellation once', () => {
    expect(diffReading(info(), flight(0), flight(0, 'cancelled'), NOW)).toMatchObject({ changeKey: 'flight:t_goa:b_flight:cancelled', importance: 1 });
    expect(diffReading(info(), flight(0, 'cancelled'), flight(0, 'cancelled'), NOW)).toBeNull();
  });
});

describe('diffReading: train tickets by PNR', () => {
  const BEFORE_TRAIN = new Date('2026-11-04T10:00:00Z');
  const ticket = info({ watchId: 'pnr:t_goa:b_train', kind: 'pnr', label: 'Mandovi Express, Mumbai to Madgaon', endsAt: new Date('2026-11-05T01:40:00Z') });

  it('flags a waitlisted ticket that is confirmed, and a cancellation, once each', () => {
    expect(diffReading(ticket, null, pnr('confirmed', 'CNF B2 34'), BEFORE_TRAIN)).toBeNull();
    expect(diffReading(ticket, null, pnr('waitlisted', 'WL 12'), BEFORE_TRAIN)).toBeNull();
    expect(diffReading(ticket, pnr('waitlisted', 'WL 12'), pnr('waitlisted', 'WL 4'), BEFORE_TRAIN)).toBeNull();
    expect(diffReading(ticket, pnr('waitlisted', 'WL 4'), pnr('confirmed', 'CNF B2 34'), BEFORE_TRAIN)).toMatchObject({
      changeKey: 'pnr:t_goa:b_train:confirmed',
      importance: 0.6,
      urgency: 0.7,
      useful: ['pin', 'message'],
      facts: { state: 'confirmed', detail: 'CNF B2 34', beforeState: 'waitlisted' },
    });
    expect(diffReading(ticket, pnr('confirmed'), pnr('cancelled'), BEFORE_TRAIN)).toMatchObject({ changeKey: 'pnr:t_goa:b_train:cancelled', importance: 1 });
    expect(diffReading(ticket, pnr('cancelled'), pnr('cancelled'), BEFORE_TRAIN)).toBeNull();
    expect(diffReading(ticket, pnr('waitlisted'), pnr('not_found'), BEFORE_TRAIN)).toBeNull();
  });
});

/** Arjun's own flight, picked from his card (Mumbai to Goa, on the trip's day): no booking of the group's covers him. */
const ARJUN_FLIGHT = {
  mode: 'flight' as const, origin: { name: 'Mumbai', code: 'BOM' }, destination: { name: 'Goa', code: 'GOX' },
  depart_at: '2026-11-06T17:05:00+05:30', arrive_at: '2026-11-06T18:20:00+05:30', carrier_name: 'Air India Express', carrier_code: 'IX', number: 'IX 1196',
};
const pick = (over: Partial<PersonPick> = {}): PersonPick => ({
  tripId: 't_goa', personId: 'p_arjun', kind: 'flight', way: wayOf(ARJUN_FLIGHT), optionId: 'opt_ix1196', title: 'Air India Express IX1196',
  journey: ARJUN_FLIGHT, pickedAt: new Date('2026-10-10T08:00:00Z'), ...over,
});

describe("a person's own flight pick is watched for them", () => {
  const now = new Date('2026-10-06T06:30:00Z');

  it('watches a picked flight for its picker alone, by its number, as a booked one is', () => {
    expect(wayOf(ARJUN_FLIGHT)).toBe('BOM-GOX');
    const plans = planWatches(goaTrip(), now, [pick()]);
    expect(plans.map((p) => p.watchId)).toEqual(['flight:t_goa:b_flight', 'flight:t_goa:pick:p_arjun:BOM-GOX']);
    const w = plans[1]!;
    expect(w).toMatchObject({ personIds: ['p_arjun'], label: 'Air India Express IX 1196', query: { kind: 'flight', carrierCode: 'IX', number: '1196', date: '2026-11-06' } });
    expect(w.startAt.toISOString()).toBe('2026-11-05T11:35:00.000Z');
    expect(w.endsAt.toISOString()).toBe('2026-11-06T13:50:00.000Z');
  });

  it("adds none for a flight a booking of theirs already watches, a train, a ticket with no number, someone gone, or one that landed", () => {
    const booked = { ...ARJUN_FLIGHT, origin: { name: 'Delhi', code: 'DEL' }, depart_at: '2026-11-06T18:15:00+05:30', arrive_at: '2026-11-06T20:45:00+05:30', carrier_name: 'IndiGo', carrier_code: '6E', number: '6E2134' };
    const none = [
      pick({ personId: 'p_kabir', journey: booked, way: wayOf(booked) }),
      pick({ kind: 'train', journey: { ...ARJUN_FLIGHT, mode: 'train', carrier_code: null, number: '12051' } }),
      pick({ journey: { ...ARJUN_FLIGHT, number: null } }),
      pick({ personId: 'p_left' }),
    ];
    expect(planWatches(goaTrip(), now, none).map((p) => p.watchId)).toEqual(['flight:t_goa:b_flight']);
    // Someone else on the group's flight who picked the same one for themselves is watched on their own.
    expect(planWatches(goaTrip(), now, [pick({ personId: 'p_meher', journey: booked, way: wayOf(booked) })]).map((p) => p.personIds)).toEqual([['p_rahul', 'p_priya', 'p_kabir'], ['p_meher']]);
    expect(planWatches(goaTrip(), new Date('2026-11-06T14:00:00Z'), [pick()]).map((p) => p.watchId)).not.toContain('flight:t_goa:pick:p_arjun:BOM-GOX');
  });
});

describe('planWatches and syncWatches', () => {
  it("asks for the flight by its number alone: the contract's \"6E 2134\" loses its carrier code", () => {
    for (const n of ['6E 2134', '6E-2134', '6e2134', ' 6E  2134 ', '2134']) expect(flightNumber(n, '6E'), n).toBe('2134');
    expect(flightNumber('AI 101', 'AI')).toBe('101');
    expect(flightNumber('EK501', '6E')).toBe('EK501');
    const [f] = planWatches(goaTrip(), new Date('2026-10-06T06:30:00Z'));
    expect(goaTrip().bookings.find((b) => b.booking_id === 'b_flight')?.journey?.number).toBe('6E 2134');
    expect(f).toMatchObject({ label: 'IndiGo 6E 2134', query: { kind: 'flight', carrierCode: '6E', number: '2134' } });
  });

  it('watches the booked flight by its number and the booked train by its PNR, as P4 status queries', () => {
    const plans = planWatches(withTrain(), new Date('2026-10-06T06:30:00Z'));
    expect(plans.map((p) => p.watchId)).toEqual(['flight:t_goa:b_flight', 'pnr:t_goa:b_train']);
    const [f, t] = plans;
    expect(f).toMatchObject({ personIds: ['p_rahul', 'p_priya', 'p_kabir'], label: 'IndiGo 6E 2134', query: { kind: 'flight', carrierCode: '6E', number: '2134', date: '2026-11-06' } });
    expect(f?.startAt.toISOString()).toBe('2026-11-05T12:45:00.000Z');
    expect(f?.endsAt.toISOString()).toBe('2026-11-06T16:15:00.000Z');
    expect(t).toMatchObject({ personIds: ['p_meher', 'p_arjun'], label: 'Mandovi Express, Mumbai to Madgaon', query: { kind: 'pnr', pnr: '8524117390' } });
    expect(t?.startAt.toISOString()).toBe('2026-10-06T06:30:00.000Z');
    expect(t?.endsAt.toISOString()).toBe('2026-11-05T01:40:00.000Z');
    // Once the train has left, only the flight is watched.
    expect(planWatches(withTrain(), new Date('2026-11-05T02:00:00Z')).map((p) => p.watchId)).toEqual(['flight:t_goa:b_flight']);
  });

  let db: Awaited<ReturnType<typeof withSchema>>;
  beforeAll(async () => {
    db = await withSchema();
  });
  afterAll(async () => {
    await db.drop();
  });

  it('keeps the table in step with the trip, safe to repeat', async () => {
    const now = new Date('2026-10-06T06:30:00Z');
    await syncWatches(db.pool, withTrain(), now);
    await syncWatches(db.pool, withTrain(), now);
    const active = await db.pool.query<{ watch_id: string; kind: string; query: unknown }>(`select watch_id, kind, query from watches where active order by watch_id`);
    expect(active.rows).toEqual([
      { watch_id: 'flight:t_goa:b_flight', kind: 'flight', query: { kind: 'flight', carrierCode: '6E', number: '2134', date: '2026-11-06' } },
      { watch_id: 'pnr:t_goa:b_train', kind: 'pnr', query: { kind: 'pnr', pnr: '8524117390' } },
    ]);

    await syncWatches(db.pool, withTrain('cancelled'), now);
    const left = await db.pool.query<{ watch_id: string }>(`select watch_id from watches where active`);
    expect(left.rows.map((r) => r.watch_id)).toEqual(['flight:t_goa:b_flight']);

    await noteWatchNotice(db.pool, 'flight:t_goa:b_flight', 'c_notice_1');
    const n = await db.pool.query<{ notice_card_id: string }>(`select notice_card_id from watches where watch_id = 'flight:t_goa:b_flight'`);
    expect(n.rows[0]?.notice_card_id).toBe('c_notice_1');
  });

  it('starts a watch afresh when its query changes, and keeps its state while the query stays the same', async () => {
    const now = new Date('2026-10-06T06:30:00Z');
    const state = async () =>
      (await db.pool.query<{ last_reading: unknown; last_change_key: string | null; notice_card_id: string | null; errors: number }>(
        `select last_reading, last_change_key, notice_card_id, errors from watches where watch_id = 'flight:t_goa:b_flight'`,
      )).rows[0];
    await syncWatches(db.pool, goaTrip(), now);
    await db.pool.query(
      `update watches set last_reading = $2, last_change_key = 'flight:t_goa:b_flight:delay:120', notice_card_id = 'c_notice_9', errors = 2 where watch_id = $1`,
      ['flight:t_goa:b_flight', JSON.stringify(flight(120))],
    );
    await syncWatches(db.pool, goaTrip(), now);
    expect(await state()).toMatchObject({ last_change_key: 'flight:t_goa:b_flight:delay:120', notice_card_id: 'c_notice_9', errors: 2 });
    // Rebooked on another flight: the same booking, a new number to watch.
    const base = goaTrip();
    const rebooked = goaTrip({
      bookings: base.bookings.map((b) => (b.booking_id === 'b_flight' && b.journey ? { ...b, journey: { ...b.journey, number: '6E 5310' } } : b)),
    });
    await syncWatches(db.pool, rebooked, now);
    expect(await state()).toEqual({ last_reading: null, last_change_key: null, notice_card_id: null, errors: 0 });
  });

  it("watches each person's kept flight pick, and a new pick of the same way (Change) starts its watch afresh", async () => {
    const now = new Date('2026-10-06T06:30:00Z');
    const trip = goaTrip({ trip_id: 't_goa_picks' });
    const watched = async () =>
      (await db.pool.query<{ watch_id: string; person_ids: string[]; query: unknown; last_change_key: string | null }>(
        `select watch_id, person_ids, query, last_change_key from watches where trip_id = 't_goa_picks' and active order by watch_id`,
      )).rows;
    await recordPick(db.pool, pick({ tripId: 't_goa_picks' }));
    await syncWatches(db.pool, trip, now);
    expect((await watched()).map((w) => w.watch_id)).toEqual(['flight:t_goa_picks:b_flight', 'flight:t_goa_picks:pick:p_arjun:BOM-GOX']);
    await db.pool.query(`update watches set last_change_key = 'k_delay' where watch_id = 'flight:t_goa_picks:pick:p_arjun:BOM-GOX'`);
    // Change: another flight the same way replaces the pick, and its watch asks for the new number with nothing carried over.
    await recordPick(db.pool, pick({ tripId: 't_goa_picks', optionId: 'opt_6e5310', title: 'IndiGo 6E5310', journey: { ...ARJUN_FLIGHT, carrier_name: 'IndiGo', carrier_code: '6E', number: '6E 5310' } }));
    await syncWatches(db.pool, trip, now);
    const after = (await watched()).find((w) => w.watch_id === 'flight:t_goa_picks:pick:p_arjun:BOM-GOX');
    expect(after).toMatchObject({ person_ids: ['p_arjun'], query: { kind: 'flight', carrierCode: '6E', number: '5310', date: '2026-11-06' }, last_change_key: null });
  });
});
