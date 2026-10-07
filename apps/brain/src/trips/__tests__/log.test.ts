import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ev, goaSnapshot, msg } from '../../__tests__/fixtures/goa.js';
import { withSchema } from '../../db/test-db.js';
import { silentLog } from '../../log.js';
import { UNSURE_READ } from '../../reflex/reflex.js';
import { createMessageHooks } from '../hooks.js';
import { createTripLog } from '../log.js';

let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
});
afterAll(() => db.drop());

describe('TripLog', () => {
  it('writes each event once by event_id', async () => {
    const log = createTripLog({ pool: db.pool, log: silentLog, now: () => new Date() });
    const e = ev(1, 'trip.created', { trip: goaSnapshot() });
    expect(await log.append(e)).toBe('new');
    expect(await log.append(e)).toBe('duplicate');
    const { rows } = await db.pool.query<{ n: number }>('select count(*)::int as n from trip_events where event_id = $1', [e.event_id]);
    expect(rows[0]?.n).toBe(1);
  });

  it('ignores an event id that comes again for another trip, and warns naming both trips', async () => {
    const warned: Array<Record<string, unknown>> = [];
    const log = createTripLog({ pool: db.pool, log: { ...silentLog, warn: (obj) => warned.push(obj as Record<string, unknown>) }, now: () => new Date() });
    const first = ev(5, 'message.created', { message: msg(5, 'p_priya', 'scuba on Sunday?') }, 't_one');
    expect(await log.append(first)).toBe('new');
    const again = { ...ev(5, 'message.created', { message: msg(5, 'p_rahul', 'pay for it') }, 't_two'), event_id: first.event_id };
    expect(await log.append(again)).toBe('duplicate');
    expect(warned).toEqual([{ eventId: first.event_id, tripId: 't_two', firstTripId: 't_one' }]);
    // Never applied to the other trip: the row stays the first trip's, and the other trip gets nothing from it.
    const { rows } = await db.pool.query<{ trip_id: string }>('select trip_id from trip_events where event_id = $1', [first.event_id]);
    expect(rows.map((r) => r.trip_id)).toEqual(['t_one']);
    expect(await log.lastSeq('t_two')).toBe(0);
    // A plain repeat in the same trip is a duplicate with no warning.
    expect(await log.append(first)).toBe('duplicate');
    expect(warned).toHaveLength(1);
  });

  it('knows the highest change number per trip', async () => {
    const log = createTripLog({ pool: db.pool, log: silentLog, now: () => new Date() });
    await log.append(ev(3, 'message.created', { message: msg(3, 'p_priya', 'scuba?') }));
    await log.append(ev(2, 'message.created', { message: msg(2, 'p_rahul', 'hi') }));
    expect(await log.lastSeq('t_goa')).toBe(3);
    expect(await log.lastSeq('t_nowhere')).toBe(0);
  });

  it('lanes see each event; one failing listener does not stop the others', async () => {
    const log = createTripLog({ pool: db.pool, log: silentLog, now: () => new Date() });
    const seen: string[] = [];
    log.onEvent(() => {
      throw new Error('a lane bug');
    });
    log.onEvent((e) => {
      seen.push(e.event_id);
    });
    const e = ev(4, 'person.left', { person_id: 'p_kabir' });
    await log.emit(e);
    expect(seen).toEqual([e.event_id]);
  });
});

describe('MessageHooks', () => {
  it('runs every hook in order; one failing hook does not stop the next', async () => {
    const hooks = createMessageHooks(silentLog);
    const seen: string[] = [];
    hooks.onRead(async () => {
      throw new Error('a lane bug');
    });
    hooks.onRead(async (m, read) => {
      seen.push(`${m.message_id}:${String(read.forGo.sure)}`);
    });
    expect(await hooks.run(msg(5, 'p_priya', "I'm veg btw"), UNSURE_READ, { trip: goaSnapshot(), messages: [], seq: 5 })).toEqual({ dueNow: false });
    expect(seen).toEqual(['m_5:false']);
  });

  it('says the message is due now when any hook says so', async () => {
    const hooks = createMessageHooks(silentLog);
    hooks.onRead(async () => undefined);
    hooks.onRead(async () => ({ dueNow: true }));
    hooks.onRead(async () => ({}));
    expect(await hooks.run(msg(6, 'p_rahul', '@Go flights Delhi to Goa Friday'), UNSURE_READ, { trip: goaSnapshot(), messages: [], seq: 6 })).toEqual({ dueNow: true });
  });
});
