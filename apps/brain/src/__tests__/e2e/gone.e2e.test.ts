// A trip the Server forgets (the hosted try room drops old trips): the next read of it is answered 404 not_found, so Go
// marks it gone and drops its pack, and the minute's refresh never asks for it again. The read that finds it is usually
// the refresh's read_trip, but a refresh that read the trip just before it was forgotten finds it with its read_messages.
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
const midway = { ...goaFreshTrip(), trip_id: 't_midway', title: 'Hampi' };

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
  await helloIn(trip.trip_id);
  await helloIn(alive.trip_id);
}, 30_000);

afterAll(async () => {
  server.stop();
  await built.stop();
  await db.drop();
});

/**
 * Go's hello is in the trip and Go has taken its event: the plain hello (this model never writes one, #496). A trip
 * forgotten while its hello was still on its way would get the hello's message.created after the forget, and an event
 * for a trip says the Server has it (intake clears gone), so each test forgets a trip only once its hello is in.
 */
const helloIn = (tripId: string) =>
  server.waitFor(() => server.events.find((e) => e.event.trip_id === tripId && e.event.type === 'message.created' && e.answer
    && (e.event.data as { message?: { author?: { kind?: string } } }).message?.author?.kind === 'go'), 10_000);

const goneAt = async (tripId = trip.trip_id): Promise<Date | null | undefined> =>
  (await db.pool.query<{ gone_at: Date | null }>('select gone_at from trips where trip_id = $1', [tripId])).rows[0]?.gone_at;

/** Every request the Server got for a trip since it was forgotten (forgetTrip drops the ones before), by any method. */
const asked = (tripId: string) => server.requests.filter((r) => r.params.trip_id === tripId);
const liveReads = () => server.requests.filter((r) => r.params.trip_id === alive.trip_id && r.method === 'read_trip').length;

describe('a trip the Server forgot', () => {
  it('is marked gone at its next read, its pack goes, and the refresh stops asking for it', async () => {
    const packs = built.brain.packs as PacksImpl;
    await vi.waitFor(() => expect(packs.active()).toContain(trip.trip_id), { timeout: 5_000 });
    expect(await goneAt()).toBeNull();
    server.forgetTrip(trip.trip_id);
    await vi.waitFor(async () => expect(await goneAt()).toBeInstanceOf(Date), { timeout: 5_000, interval: 50 });
    expect(packs.active()).not.toContain(trip.trip_id);
    // Two more refreshes go by (the live trip is read twice more), and the forgotten trip is never asked for again.
    const gone = asked(trip.trip_id).length;
    expect(gone).toBeGreaterThanOrEqual(1);
    const live = liveReads();
    await vi.waitFor(() => expect(liveReads()).toBeGreaterThanOrEqual(live + 2), { timeout: 5_000, interval: 50 });
    expect(asked(trip.trip_id)).toHaveLength(gone);
    expect(packs.active()).toContain(alive.trip_id);
  });

  it("forgotten between a refresh's read_trip and its read_messages: the read_messages finds it, and nothing asks again", async () => {
    const packs = built.brain.packs as PacksImpl;
    await server.createTrip(midway);
    await vi.waitFor(() => expect(packs.active()).toContain(midway.trip_id), { timeout: 5_000 });
    await helloIn(midway.trip_id);
    // The Server forgets the trip the moment it answers the refresh's read_trip, before Go reads the messages.
    const from = server.requests.length;
    const off = server.onChange(() => {
      if (!server.requests.slice(from).some((r) => r.params.trip_id === midway.trip_id && r.method === 'read_trip')) return;
      off();
      server.forgetTrip(midway.trip_id);
    });
    await vi.waitFor(async () => expect(await goneAt(midway.trip_id)).toBeInstanceOf(Date), { timeout: 5_000, interval: 50 });
    expect(packs.active()).not.toContain(midway.trip_id);
    expect(asked(midway.trip_id).map((r) => r.method)).toEqual(['read_messages']);
    const live = liveReads();
    await vi.waitFor(() => expect(liveReads()).toBeGreaterThanOrEqual(live + 2), { timeout: 5_000, interval: 50 });
    expect(asked(midway.trip_id)).toHaveLength(1);
  });
});
