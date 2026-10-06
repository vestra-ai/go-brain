import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { goaTrip, seedTrip } from '../../proactive/fakes.js';
import { ProactiveStore } from '../../proactive/store.js';
import type { StatusQuery, StatusResult } from '../../travel/travel.js';
import { syncWatches } from '../plan.js';
import { backoffMs, createWatchRunner, nextCheckIn } from '../runner.js';

const START = new Date('2026-11-06T07:00:00Z'); // 5 h 45 min before the flight leaves
const SCHEDULED = '2026-11-06T18:15:00+05:30';
const flight = (delayMinutes: number): StatusResult => ({
  kind: 'flight',
  state: delayMinutes > 0 ? 'delayed' : 'scheduled',
  scheduledDepartAt: SCHEDULED,
  expectedDepartAt: new Date(Date.parse(SCHEDULED) + delayMinutes * 60_000).toISOString(),
  delayMinutes,
  checkedAt: START.toISOString(),
});

let db: Awaited<ReturnType<typeof withSchema>>;
let store: ProactiveStore;
beforeAll(async () => {
  db = await withSchema();
  store = new ProactiveStore(db.pool);
  await seedTrip(db.pool, 't_goa');
  await syncWatches(db.pool, goaTrip(), START); // the Goa trip books one flight and no train: one watch
});
afterAll(async () => {
  await db.drop();
});

describe('timing', () => {
  it('checks a flight more often as it gets close, and a train ticket by how soon the train leaves', () => {
    const lands = new Date('2026-11-06T16:15:00Z');
    expect(nextCheckIn(flight(0), lands, START)).toBe(20 * 60_000);
    expect(nextCheckIn(flight(0), lands, new Date('2026-11-06T10:00:00Z'))).toBe(5 * 60_000);
    const ticket: StatusResult = { kind: 'pnr', state: 'waitlisted', detail: 'WL 4', checkedAt: START.toISOString() };
    const leaves = new Date('2026-11-05T01:40:00Z');
    expect(nextCheckIn(ticket, leaves, new Date('2026-11-01T00:00:00Z'))).toBe(360 * 60_000);
    expect(nextCheckIn(ticket, leaves, new Date('2026-11-04T10:00:00Z'))).toBe(120 * 60_000);
    expect(nextCheckIn(ticket, leaves, new Date('2026-11-04T22:00:00Z'))).toBe(30 * 60_000);
    expect(backoffMs(1)).toBe(2 * 60_000);
    expect(backoffMs(10)).toBe(60 * 60_000);
  });
});

describe('createWatchRunner', () => {
  it('sends the stored P4 query as it is, turns a new delay into one candidate, never twice, and backs off on errors', async () => {
    let now = START;
    const asked: StatusQuery[] = [];
    const readings: Array<StatusResult | Error> = [flight(0), flight(120), flight(120), new Error('ixigo is down')];
    const travel = {
      status: async (q: StatusQuery): Promise<StatusResult> => {
        asked.push(q);
        const next = readings.shift();
        if (!next || next instanceof Error) throw next ?? new Error('no reading');
        return next;
      },
    };
    const runner = createWatchRunner({ pool: db.pool, travel, store, now: () => now, log: { warn: () => {} } });

    expect(await runner.tick()).toBe(0); // on time: nothing
    expect(asked[0]).toEqual({ kind: 'flight', carrierCode: '6E', number: '2134', date: '2026-11-06' });
    now = new Date(START.getTime() + 20 * 60_000);
    expect(await runner.tick()).toBe(1); // 2 h late
    const c = await store.status('t_goa', 'flight:t_goa:b_flight:delay:120');
    expect(c?.status).toBe('pending');
    const facts = await db.pool.query<{ topic: string; facts: Record<string, unknown>; person_ids: string[]; useful: string[] }>(
      `select topic, facts, person_ids, useful from proactive_candidates where dedupe_key = 'flight:t_goa:b_flight:delay:120'`,
    );
    expect(facts.rows[0]).toMatchObject({
      topic: 'flight_status',
      person_ids: ['p_rahul', 'p_priya', 'p_kabir'],
      useful: ['pin', 'message'],
      facts: { watchId: 'flight:t_goa:b_flight', label: 'IndiGo 6E 2134', state: 'delayed', delayMinutes: 120, checkedAt: START.toISOString() },
    });

    now = new Date(now.getTime() + 20 * 60_000);
    expect(await runner.tick()).toBe(0); // the same delay again: nothing new

    now = new Date(now.getTime() + 20 * 60_000);
    expect(await runner.tick()).toBe(0); // an error
    const w = await db.pool.query<{ errors: number; last_error: string; next_check_at: Date }>(`select errors, last_error, next_check_at from watches where watch_id = 'flight:t_goa:b_flight'`);
    expect(w.rows[0]).toMatchObject({ errors: 1, last_error: 'ixigo is down' });
    expect(w.rows[0]?.next_check_at.toISOString()).toBe(new Date(now.getTime() + 2 * 60_000).toISOString());
  });

  it('stops a watch whose time is over, and does nothing without a travel layer', async () => {
    const late = new Date('2026-11-07T00:00:00Z');
    await db.pool.query(`update watches set next_check_at = $1 where watch_id = 'flight:t_goa:b_flight'`, [late]);
    const runner = createWatchRunner({ pool: db.pool, travel: { status: async () => flight(0) }, store, now: () => late, log: { warn: () => {} } });
    await runner.tick();
    const w = await db.pool.query<{ active: boolean }>(`select active from watches where watch_id = 'flight:t_goa:b_flight'`);
    expect(w.rows[0]?.active).toBe(false);
    expect(await createWatchRunner({ pool: db.pool, travel: null, store, now: () => late, log: { warn: () => {} } }).tick()).toBe(0);
  });
});
