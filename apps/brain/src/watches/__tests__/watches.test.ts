import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { goaTrip } from '../../proactive/fakes.js';
import type { StatusResult } from '../status.js';
import { diffReading, type WatchInfo } from '../diff.js';
import { noteWatchNotice, planWatches, syncWatches } from '../plan.js';

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

describe('planWatches and syncWatches', () => {
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
});
