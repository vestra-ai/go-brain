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
    await hooks.run(msg(5, 'p_priya', "I'm veg btw"), UNSURE_READ, { trip: goaSnapshot(), messages: [], seq: 5 });
    expect(seen).toEqual(['m_5:false']);
  });
});
