import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { silentLog } from '../../log.js';
import { createDesk, type DeskItem, type TurnInput, type TurnRunner } from '../desk.js';

let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
});
afterAll(() => db.drop());

function clock(start = Date.parse('2026-10-06T09:00:00Z')) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

let trips = 0;
const newTrip = () => `t_desk_${++trips}`;
const later = (c: ReturnType<typeof clock>, ms: number) => new Date(c.now().getTime() + ms);
const msgItem = (tripId: string, n: number, dueAt: Date): Omit<DeskItem, 'id'> & { id: string } => ({
  id: `msg:${tripId}:m_${n}`, tripId, kind: 'message', ref: `m_${n}`, dueAt, payload: { messageId: `m_${n}` },
});

function make(c: ReturnType<typeof clock>, opts: { holder?: string; run?: TurnRunner } = {}) {
  const runs: TurnInput[] = [];
  const gaveUp: TurnInput[] = [];
  const desk = createDesk({ pool: db.pool, log: silentLog, now: c.now, holder: opts.holder ?? 'copy-a', inProcessWake: false });
  desk.setRunner(
    async (t) => {
      runs.push(t);
      await opts.run?.(t);
    },
    async (t) => { gaveUp.push(t); },
  );
  const of = (tripId: string) => runs.filter((r) => r.tripId === tripId);
  return { desk, runs, gaveUp, of };
}

describe('the desk', () => {
  it('put is idempotent by id, and cancel drops a waiting item', async () => {
    const c = clock();
    const { desk, of } = make(c);
    const T = newTrip();
    await desk.put(msgItem(T, 1, c.now()));
    await desk.put(msgItem(T, 1, c.now()));
    await desk.put({ id: `timer:${T}`, tripId: T, kind: 'timer', ref: 'vote_reminder', dueAt: c.now(), payload: {} });
    await desk.cancel(T, 'vote_reminder');
    await desk.tick();
    expect(of(T)).toHaveLength(1);
    expect(of(T)[0]?.items.map((i) => i.id)).toEqual([`msg:${T}:m_1`]);
  });

  it('the wait: each new message pushes the waiting ones back, then one turn takes them all', async () => {
    const c = clock();
    const { desk, of } = make(c);
    const T = newTrip();
    await desk.put(msgItem(T, 1, later(c, 2_000)));
    c.advance(1_500);
    await desk.put(msgItem(T, 2, later(c, 2_000)));
    c.advance(1_000);
    await desk.tick();
    expect(of(T)).toHaveLength(0);
    c.advance(1_100);
    await desk.tick();
    expect(of(T)).toHaveLength(1);
    expect(of(T)[0]?.items.map((i) => i.ref)).toEqual(['m_1', 'm_2']);
  });

  it('a burst of five gets one turn, and the wait never passes 6 s after the first message', async () => {
    const c = clock();
    const { desk, of } = make(c);
    const T = newTrip();
    await desk.put(msgItem(T, 1, later(c, 2_000)));
    for (let k = 2; k <= 5; k++) {
      c.advance(1_500);
      await desk.put(msgItem(T, k, later(c, 2_000)));
    }
    await desk.tick();
    expect(of(T)).toHaveLength(1);
    expect(of(T)[0]?.items.map((i) => i.ref)).toEqual(['m_1', 'm_2', 'm_3', 'm_4', 'm_5']);
  });

  it('a message due at once takes the waiting ones with it', async () => {
    const c = clock();
    const { desk, of } = make(c);
    const T = newTrip();
    await desk.put(msgItem(T, 1, later(c, 2_000)));
    await desk.put(msgItem(T, 2, c.now()));
    await desk.tick();
    expect(of(T)).toHaveLength(1);
    expect(of(T)[0]?.items.map((i) => i.ref).sort()).toEqual(['m_1', 'm_2']);
  });

  it('a burst during a running turn: no second turn in parallel, here or in another copy, and nothing answered twice', async () => {
    const c = clock();
    const T = newTrip();
    const gate = deferred();
    let calls = 0;
    const { desk, of } = make(c, {
      run: async (t) => {
        if (t.tripId === T && ++calls === 1) await gate.promise;
      },
    });
    const other = make(c, { holder: 'copy-b' });
    await desk.put(msgItem(T, 1, c.now()));
    const first = desk.tick();
    await vi.waitFor(() => expect(of(T)).toHaveLength(1));
    await desk.put(msgItem(T, 2, c.now()));
    await desk.put(msgItem(T, 3, c.now()));
    void desk.tick();
    await other.desk.tick();
    expect(of(T)).toHaveLength(1);
    expect(other.of(T)).toHaveLength(0);
    gate.resolve();
    await first;
    await desk.tick();
    expect(of(T)).toHaveLength(2);
    expect(of(T)[0]?.items.map((i) => i.ref)).toEqual(['m_1']);
    expect(of(T)[1]?.items.map((i) => i.ref)).toEqual(['m_2', 'm_3']);
    expect(new Set(of(T).flatMap((r) => r.items.map((i) => i.id))).size).toBe(3);
  });

  it('a slow turn in one trip never holds up another trip', async () => {
    const c = clock();
    const slow = newTrip();
    const quick = newTrip();
    const gate = deferred();
    const { desk, of } = make(c, { run: async (t) => { if (t.tripId === slow) await gate.promise; } });
    await desk.put(msgItem(slow, 1, c.now()));
    await desk.put(msgItem(quick, 1, c.now()));
    const p = desk.tick();
    await vi.waitFor(() => expect(of(quick)).toHaveLength(1));
    expect(of(slow)).toHaveLength(1);
    gate.resolve();
    await p;
  });

  it('a crashed turn runs again under the same turn id; after 3 attempts Go gives up once', async () => {
    const c = clock();
    const T = newTrip();
    const { desk, of, gaveUp } = make(c, { run: async (t) => { if (t.tripId === T) throw new Error('the model fell over'); } });
    await desk.put(msgItem(T, 1, c.now()));
    await desk.tick();
    await desk.tick();
    expect(of(T)).toHaveLength(1);
    c.advance(1_100);
    await desk.tick();
    c.advance(4_100);
    await desk.tick();
    c.advance(10_000);
    await desk.tick();
    expect(of(T).map((r) => r.attempt)).toEqual([1, 2, 3]);
    expect(new Set(of(T).map((r) => r.turnId)).size).toBe(1);
    expect(gaveUp.filter((g) => g.tripId === T)).toHaveLength(1);
    const { rows } = await db.pool.query('select done_at, error from desk_items where id = $1', [`msg:${T}:m_1`]);
    expect(rows[0].done_at).toBeInstanceOf(Date);
    expect(rows[0].error).toMatch(/^gave up after 3 attempts/);
  });

  it('a copy that died mid-turn: its lease runs out and its items run again under the same turn id', async () => {
    const c = clock();
    const T = newTrip();
    const { desk, of } = make(c);
    await desk.put(msgItem(T, 1, c.now()));
    await db.pool.query(`update desk_items set turn_id = 'turn_dead', attempts = 1 where id = $1`, [`msg:${T}:m_1`]);
    await db.pool.query(`insert into trip_leases (trip_id, holder, until) values ($1, 'copy-dead', $2)`, [T, later(c, 60_000)]);
    await desk.tick();
    expect(of(T)).toHaveLength(0);
    c.advance(61_000);
    await desk.tick();
    expect(of(T)).toHaveLength(1);
    expect(of(T)[0]).toMatchObject({ turnId: 'turn_dead', attempt: 2 });
  });

  it('a timer waits for its time and is never taken early with messages', async () => {
    const c = clock();
    const T = newTrip();
    const { desk, of } = make(c);
    await desk.put({ id: `timer:${T}`, tripId: T, kind: 'timer', ref: 'vote_closes', dueAt: later(c, 2 * 60 * 60_000), payload: {} });
    await desk.put(msgItem(T, 1, c.now()));
    await desk.tick();
    expect(of(T).map((r) => r.items.map((i) => i.kind))).toEqual([['message']]);
    c.advance(2 * 60 * 60_000);
    await desk.tick();
    expect(of(T).map((r) => r.items.map((i) => i.kind))).toEqual([['message'], ['timer']]);
  });

  it('claimNew hands the pre-post check the messages that arrived during the turn, and they are done with it', async () => {
    const c = clock();
    const T = newTrip();
    const claimed: string[] = [];
    const { desk, of } = make(c, {
      run: async (t) => {
        if (t.tripId !== T || claimed.length) return;
        await desk.put(msgItem(T, 2, later(c, 2_000)));
        claimed.push(...(await desk.claimNew(T, t.turnId)).map((i) => i.ref));
      },
    });
    await desk.put(msgItem(T, 1, c.now()));
    await desk.tick();
    c.advance(5_000);
    await desk.tick();
    expect(claimed).toEqual(['m_2']);
    expect(of(T)).toHaveLength(1);
  });
});
