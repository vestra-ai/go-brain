// A trip the Server forgets (the hosted try room drops old trips): the next read of it is answered 404 not_found, so Go
// marks it gone and drops its pack, and the minute's refresh never asks for it again.
import { FakeServer, goaFreshTrip } from '@go/sim';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
const trip = goaFreshTrip();
const alive = { ...goaFreshTrip(), trip_id: 't_alive', title: 'Coorg' };

beforeAll(async () => {
  db = await withSchema();
  const env = loadEnv({
    PORT: '0', DATABASE_URL: process.env.DATABASE_URL, GO_SIGNING_SECRET: SECRET, GO_PUBLIC_URL: 'http://127.0.0.1',
    ANTHROPIC_API_KEY: 'test-key', LOG_LEVEL: 'silent',
  });
  const model = fakeAnthropic(() => ({ tools: [{ name: 'stay_silent', input: { reason: 'nothing for Go' } }] }));
  // The refresh of active trips runs every 100 ms here instead of every minute.
  built = await buildBrain(env, { pool: db.pool, anthropic: model.client, logger: false, timings: { ...TEST_TIMINGS, refreshMs: 100 } });
  await registerRoom(built.brain);
  const { port } = await built.start();
  server = new FakeServer({ goUrl: `http://127.0.0.1:${port}`, secret: SECRET, instance: 'sim-gone' });
  await server.start();
  await server.createTrip(trip);
  await server.createTrip(alive);
}, 30_000);

afterAll(async () => {
  server.stop();
  await built.stop();
  await db.drop();
});

const goneAt = async (): Promise<Date | null | undefined> =>
  (await db.pool.query<{ gone_at: Date | null }>('select gone_at from trips where trip_id = $1', [trip.trip_id])).rows[0]?.gone_at;

describe('a trip the Server forgot', () => {
  it('is marked gone at its next read, its pack goes, and the refresh stops asking for it', async () => {
    const packs = built.brain.packs as PacksImpl;
    await vi.waitFor(() => expect(packs.active()).toContain(trip.trip_id), { timeout: 5_000 });
    expect(await goneAt()).toBeNull();
    server.forgetTrip(trip.trip_id);
    await vi.waitFor(async () => expect(await goneAt()).toBeInstanceOf(Date), { timeout: 5_000, interval: 50 });
    expect(packs.active()).not.toContain(trip.trip_id);
    // Two more refreshes go by (the live trip is read twice more), and the forgotten trip is never asked for again.
    const reads = (tripId: string) => server.requests.filter((r) => r.params.trip_id === tripId && r.method === 'read_trip').length;
    const gone = reads(trip.trip_id);
    expect(gone).toBeGreaterThanOrEqual(1);
    const live = reads(alive.trip_id);
    await vi.waitFor(() => expect(reads(alive.trip_id)).toBeGreaterThanOrEqual(live + 2), { timeout: 5_000, interval: 50 });
    expect(reads(trip.trip_id)).toBe(gone);
    expect(packs.active()).toContain(alive.trip_id);
  });
});
