import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { SocketCallError } from '../../door/rpc.js';
import { silentLog } from '../../log.js';
import { createGoneTrips } from '../gone.js';

let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
});
afterAll(() => db.drop());

function gone() {
  const dropped: string[] = [];
  const warned: string[] = [];
  const g = createGoneTrips({
    pool: db.pool,
    log: { ...silentLog, warn: (_o: object, m?: string) => { warned.push(m ?? ''); } },
    now: () => new Date('2026-10-07T10:00:00Z'),
    dropped: (tripId) => dropped.push(tripId),
  });
  return { g, dropped, warned };
}
const goneAt = async (tripId: string): Promise<Date | null | undefined> =>
  (await db.pool.query<{ gone_at: Date | null }>('select gone_at from trips where trip_id = $1', [tripId])).rows[0]?.gone_at;
const notFound = new SocketCallError(404, 'trip t_x does not exist', 'not_found');

describe('a trip the Server no longer has', () => {
  it('is marked gone on a 404 not_found to a read of it, once, and its pack is dropped', async () => {
    await db.pool.query(`insert into trips (trip_id) values ('t_old')`);
    const { g, dropped, warned } = gone();
    await g.failed('read_trip', { trip_id: 't_old' }, notFound, 'server-1');
    expect(await goneAt('t_old')).toEqual(new Date('2026-10-07T10:00:00Z'));
    expect(dropped).toEqual(['t_old']);
    // Said once: the next refusal finds it gone already.
    await g.failed('read_messages', { trip_id: 't_old', after_seq: 0, limit: 200 }, notFound, 'server-1');
    expect(warned).toHaveLength(1);
  });

  it('is marked even when Go never stored the trip (a candidate or a sweep that outlived it)', async () => {
    const { g } = gone();
    await g.failed('read_trip', { trip_id: 't_never' }, notFound, 'server-1');
    expect(await goneAt('t_never')).toBeInstanceOf(Date);
  });

  it('keeps retrying on 5xx and timeouts, and a 404 on a write is not the trip', async () => {
    await db.pool.query(`insert into trips (trip_id) values ('t_live')`);
    const { g, dropped } = gone();
    await g.failed('read_trip', { trip_id: 't_live' }, new SocketCallError(503, 'busy', 'unavailable'), 'server-1');
    await g.failed('read_trip', { trip_id: 't_live' }, new SocketCallError(500, 'oops', 'internal'), 'server-1');
    await g.failed('close_vote', { trip_id: 't_live', decision_id: 'd_x', request_id: 'r1' }, new SocketCallError(404, 'no such vote', 'not_found'), 'server-1');
    await g.failed('read_trip', { trip_id: 't_live' }, new SocketCallError(404, 'no route', undefined), 'server-1');
    expect(await goneAt('t_live')).toBeNull();
    expect(dropped).toEqual([]);
  });

  it("only the trip's own Server instance can say it is gone: another one's 404 leaves it alone", async () => {
    await db.pool.query(`insert into trips (trip_id, server_instance) values ('t_room', 'go-live-room')`);
    const { g, dropped, warned } = gone();
    // A drill's Server shares this Go and never had the trip.
    await g.failed('read_trip', { trip_id: 't_room' }, notFound, 'drill-7');
    await g.failed('read_messages', { trip_id: 't_room', after_seq: 0, limit: 200 }, notFound, 'drill-7');
    await g.failed('read_trip', { trip_id: 't_room' }, notFound, null);
    expect(await goneAt('t_room')).toBeNull();
    expect(dropped).toEqual([]);
    expect(warned).toEqual([]);
    await g.failed('read_trip', { trip_id: 't_room' }, notFound, 'go-live-room');
    expect(await goneAt('t_room')).toBeInstanceOf(Date);
    expect(dropped).toEqual(['t_room']);
  });

  it('a later successful read clears the mark', async () => {
    await db.pool.query(`insert into trips (trip_id, gone_at) values ('t_back', now())`);
    const { g } = gone();
    await g.answered('read_trip', { trip_id: 't_back' });
    expect(await goneAt('t_back')).toBeNull();
  });
});
