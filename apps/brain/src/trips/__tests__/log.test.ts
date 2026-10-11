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

  it("appends on connections of its own: a main pool with none free never holds send_event's answer", async () => {
    const busy = { query: () => new Promise(() => {}), connect: () => new Promise(() => {}) } as never;
    const log = createTripLog({ pool: busy, appendPool: db.pool, log: silentLog, now: () => new Date() });
    const e = ev(1, 'trip.created', { trip: goaSnapshot({ trip_id: 't_own_pool' }) }, 't_own_pool');
    expect(await log.append(e, { instance: 'server-1', server: 'vestra-staging' })).toBe('new');
    const { rows } = await db.pool.query('select last_seq, server_instance, server_name from trips where trip_id = $1', ['t_own_pool']);
    expect(rows[0]).toEqual({ last_seq: 1, server_instance: 'server-1', server_name: 'vestra-staging' });
  });

  // Prod, 11 Oct 07:24Z: the Server redeployed and its socket's instance (its container) changed. Every older trip kept
  // waiting for the old instance: "no socket from the Server is open", then "a turn failed".
  it("moves the trip's home to the socket each event comes on, a repeat too; an event with no socket keeps it", async () => {
    const log = createTripLog({ pool: db.pool, log: silentLog, now: () => new Date() });
    const T = 't_rehome_log';
    const home = async () => (await db.pool.query('select server_instance, server_name from trips where trip_id = $1', [T])).rows[0];
    const first = ev(1, 'trip.created', { trip: goaSnapshot({ trip_id: T }) }, T);
    expect(await log.append(first, { instance: 'ca6989a06930-80' })).toBe('new');
    expect(await home()).toEqual({ server_instance: 'ca6989a06930-80', server_name: null });
    // The Server redeployed: its next event comes on the new instance's socket.
    const next = ev(2, 'message.created', { message: msg(2, 'p_rahul', 'hi') }, T);
    expect(await log.append(next, { instance: 'fb0da31b49f7-80' })).toBe('new');
    expect(await home()).toEqual({ server_instance: 'fb0da31b49f7-80', server_name: null });
    // A repeat the Server resends from yet another socket moves it too; one with no socket leaves it.
    expect(await log.append(next, { instance: 'c0ffee000000-80', server: 'prod' })).toBe('duplicate');
    expect(await home()).toEqual({ server_instance: 'c0ffee000000-80', server_name: 'prod' });
    expect(await log.append(ev(3, 'message.created', { message: msg(3, 'p_rahul', 'ok') }, T))).toBe('new');
    expect(await home()).toEqual({ server_instance: 'c0ffee000000-80', server_name: 'prod' });
  });

  // Prod, 11 Oct 08:13Z: a trip that only got taps after its Server's redeploy kept its old instance, and a login tap's
  // card never went out. A request that names the trip moves its home as an event does.
  it("moves the trip's home to the socket a request naming it came on, its name too; no trip, no move", async () => {
    const log = createTripLog({ pool: db.pool, log: silentLog, now: () => new Date() });
    const T = 't_rehome_tap';
    const home = async () => (await db.pool.query('select server_instance, server_name from trips where trip_id = $1', [T])).rows[0];
    await log.append(ev(1, 'trip.created', { trip: goaSnapshot({ trip_id: T }) }, T), { instance: 'ca6989a06930-80' });
    await log.rehome(T, { instance: 'fb0da31b49f7-80' });
    expect(await home()).toEqual({ server_instance: 'fb0da31b49f7-80', server_name: null });
    await log.rehome(T, { instance: 'fb0da31b49f7-80', server: 'prod' });
    expect(await home()).toEqual({ server_instance: 'fb0da31b49f7-80', server_name: 'prod' });
    await log.rehome('t_rehome_none', { instance: 'fb0da31b49f7-80' });
    expect((await db.pool.query('select 1 from trips where trip_id = $1', ['t_rehome_none'])).rowCount).toBe(0);
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
