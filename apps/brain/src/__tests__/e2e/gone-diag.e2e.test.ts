// DIAGNOSTIC, not for merge: does anything issue a read for a trip after Go marked it gone, and from where?
// Many trips are forgotten with the refresh every 20 ms, so a refresh's job can wait behind a slow one. Every read
// Go issues is recorded with its issue time and its call stack, and compared with the trip's gone_at.
import { FakeServer, goaFreshTrip } from '@go/sim';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { buildBrain, type Built } from '../../app.js';
import { withSchema } from '../../db/test-db.js';
import { loadEnv } from '../../env.js';
import { registerRoom } from '../../room.js';
import type { PacksImpl } from '../../trips/pack.js';
import { fakeAnthropic } from '../fixtures/fake-anthropic.js';
import { SECRET, TEST_TIMINGS } from './harness.js';

let db: Awaited<ReturnType<typeof withSchema>>;
let built: Built;
let server: FakeServer;
const alive = { ...goaFreshTrip(), trip_id: 't_diag_alive', title: 'Coorg' };
const issued: Array<{ tripId: string; method: string; at: number; stack: string }> = [];

beforeAll(async () => {
  db = await withSchema();
  const env = loadEnv({
    PORT: '0', DATABASE_URL: process.env.DATABASE_URL, GO_SIGNING_SECRET: SECRET, GO_PUBLIC_URL: 'http://127.0.0.1',
    ANTHROPIC_API_KEY: 'test-key', LOG_LEVEL: 'silent',
  });
  const model = fakeAnthropic(() => ({ tools: [{ name: 'stay_silent', input: { reason: 'nothing for Go' } }] }));
  built = await buildBrain(env, { pool: db.pool, anthropic: model.client, logger: false, timings: { ...TEST_TIMINGS, refreshMs: 20 } });
  await registerRoom(built.brain);
  const link = built.brain.door.link;
  const request = link.request.bind(link);
  link.request = ((method: string, params: { trip_id?: string }, opts?: object) => {
    if ((method === 'read_trip' || method === 'read_messages') && typeof params.trip_id === 'string' && params.trip_id.startsWith('t_diag_g')) {
      const stack = (new Error().stack ?? '').split('\n').filter((l) => l.includes('/src/') && !l.includes('gone-diag')).map((l) => l.trim().replace(/\(.*\/src\//, '(src/')).slice(0, 6).join(' | ');
      issued.push({ tripId: params.trip_id, method, at: Date.now(), stack });
    }
    return request(method as never, params as never, opts);
  }) as typeof link.request;
  const { port } = await built.start();
  server = new FakeServer({ goUrl: `http://127.0.0.1:${port}`, secret: SECRET, instance: 'sim-gone-diag' });
  await server.start();
  await server.createTrip(alive);
}, 30_000);

afterAll(async () => {
  server.stop();
  await built.stop();
  await db.drop();
});

const goneAtMs = async (tripId: string): Promise<number | null> =>
  (await db.pool.query<{ gone_at: Date | null }>('select gone_at from trips where trip_id = $1', [tripId])).rows[0]?.gone_at?.getTime() ?? null;
const liveReads = () => server.requests.filter((r) => r.params.trip_id === alive.trip_id && r.method === 'read_trip').length;

it('DIAGNOSTIC: reads issued for a trip after it was marked gone', async () => {
  const packs = built.brain.packs as PacksImpl;
  const N = 80;
  const after: Array<{ trip: string; method: string; msAfterMark: number; stack: string }> = [];
  let sameMs = 0;
  let before = 0;
  for (let i = 0; i < N; i++) {
    const t = { ...goaFreshTrip(), trip_id: `t_diag_g${i}`, title: `Gone ${i}` };
    await server.createTrip(t);
    await vi.waitFor(() => expect(packs.active()).toContain(t.trip_id), { timeout: 5_000, interval: 5 });
    const forgotAt = Date.now();
    server.forgetTrip(t.trip_id);
    await vi.waitFor(async () => expect(await goneAtMs(t.trip_id)).not.toBeNull(), { timeout: 5_000, interval: 10 });
    const mark = (await goneAtMs(t.trip_id))!;
    const live = liveReads();
    await vi.waitFor(() => expect(liveReads()).toBeGreaterThanOrEqual(live + 3), { timeout: 5_000, interval: 10 });
    for (const r of issued.filter((x) => x.tripId === t.trip_id && x.at >= forgotAt)) {
      if (r.at > mark) after.push({ trip: t.trip_id, method: r.method, msAfterMark: r.at - mark, stack: r.stack });
      else if (r.at === mark) sameMs += 1;
      else before += 1;
    }
  }
  const byPath: Record<string, number> = {};
  for (const a of after) byPath[`${a.method}: ${a.stack}`] = (byPath[`${a.method}: ${a.stack}`] ?? 0) + 1;
  const summary = { trips: N, readsBeforeMark: before, readsSameMs: sameMs, readsAfterMark: after.length, tripsWithAfter: new Set(after.map((a) => a.trip)).size, byPath, examples: after.slice(0, 5) };
  console.log(`GONE-DIAG ${JSON.stringify(summary, null, 1)}`);
  expect(after).toEqual([]);
}, 240_000);
