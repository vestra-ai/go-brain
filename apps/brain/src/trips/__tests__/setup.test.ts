import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { silentLog } from '../../log.js';
import { createSetup } from '../setup.js';

let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
});
afterAll(() => db.drop());

const steps = async (tripId: string) =>
  (await db.pool.query('select step, done_at, error from trip_setup where trip_id = $1 order by step', [tripId])).rows;

describe('setup', () => {
  it('runs the steps in order, after their prerequisites, and records when each was done', async () => {
    const s = createSetup({ pool: db.pool, log: silentLog, now: () => new Date() });
    const ran: string[] = [];
    s.addStep({ name: 'computer.warm', after: 'computer.user', run: async () => { ran.push('warm'); } });
    s.addStep({ name: 'brain.ready', run: async () => { ran.push('ready'); } });
    s.addStep({ name: 'computer.user', after: 'brain.ready', run: async () => { ran.push('user'); } });
    await s.ensureTrip('t_setup_1');
    expect(ran).toEqual(['ready', 'user', 'warm']);
    const rows = await steps('t_setup_1');
    expect(rows.map((r) => r.step)).toEqual(['brain.ready', 'computer.user', 'computer.warm']);
    expect(rows.every((r) => r.done_at instanceof Date)).toBe(true);
    expect(s.isReady('t_setup_1')).toBe(true);
  });

  it('is safe to repeat: a done step never runs again, even after a restart', async () => {
    let runs = 0;
    const make = () => {
      const s = createSetup({ pool: db.pool, log: silentLog, now: () => new Date() });
      s.addStep({ name: 'brain.ready', run: async () => { runs += 1; } });
      return s;
    };
    const s = make();
    await s.ensureTrip('t_setup_2');
    await s.ensureTrip('t_setup_2');
    await make().ensureTrip('t_setup_2');
    expect(runs).toBe(1);
  });

  it('a failed step keeps its error, the steps after it wait, and the sweep finishes the job', async () => {
    let fail = true;
    let warmed = false;
    const s = createSetup({ pool: db.pool, log: silentLog, now: () => new Date() });
    s.addStep({ name: 'brain.ready', run: async () => undefined });
    s.addStep({ name: 'computer.user', after: 'brain.ready', run: async () => { if (fail) throw new Error('/v1 is down'); } });
    s.addStep({ name: 'computer.warm', after: 'computer.user', run: async () => { warmed = true; } });
    await s.ensureTrip('t_setup_3');
    expect(await steps('t_setup_3')).toMatchObject([
      { step: 'brain.ready', error: null },
      { step: 'computer.user', done_at: null, error: '/v1 is down' },
      { step: 'computer.warm', done_at: null, error: 'waits for computer.user' },
    ]);
    expect(s.isReady('t_setup_3')).toBe(false);
    fail = false;
    expect(await s.sweep()).toBeGreaterThanOrEqual(1);
    expect((await steps('t_setup_3')).every((r) => r.done_at instanceof Date)).toBe(true);
    expect(warmed).toBe(true);
    expect(s.isReady('t_setup_3')).toBe(true);
  });

  it('two calls at once share one run', async () => {
    let runs = 0;
    const s = createSetup({ pool: db.pool, log: silentLog, now: () => new Date() });
    s.addStep({ name: 'brain.ready', run: async () => { runs += 1; await new Promise((r) => setTimeout(r, 50)); } });
    await Promise.all([s.ensureTrip('t_setup_4'), s.ensureTrip('t_setup_4')]);
    expect(runs).toBe(1);
  });

  it('ensureSoon tries a trip that is not ready at most once every 30 s', async () => {
    let t = Date.parse('2026-10-06T09:00:00Z');
    let runs = 0;
    const s = createSetup({ pool: db.pool, log: silentLog, now: () => new Date(t) });
    s.addStep({ name: 'brain.ready', run: async () => { runs += 1; throw new Error('not yet'); } });
    s.ensureSoon('t_setup_5');
    await vi.waitFor(() => expect(runs).toBe(1));
    s.ensureSoon('t_setup_5');
    await new Promise((r) => setTimeout(r, 30));
    expect(runs).toBe(1);
    // The first try has written its error (a busy CI database can take longer than 30 ms), so it is no longer running.
    await vi.waitFor(async () => expect((await steps('t_setup_5'))[0]?.error).toBe('not yet'));
    await new Promise((r) => setTimeout(r, 20));
    t += 31_000;
    s.ensureSoon('t_setup_5');
    await vi.waitFor(() => expect(runs).toBe(2));
  });
});
