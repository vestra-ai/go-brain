import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { bookingsWithoutApproval, StatsRegistry, statsRegistry } from '../sources.js';
import { computeBoard } from '../stats.js';
import { goMessage, minutesAgo, NOW, personMessage, seedTrip, seedTurn, truncateAll } from './seed.js';

let db: Awaited<ReturnType<typeof withSchema>>;
const registry = (): StatsRegistry => {
  const r = new StatsRegistry();
  r.add(bookingsWithoutApproval);
  return r;
};
const hasBadNumber = (v: unknown): boolean =>
  typeof v === 'number' ? !Number.isFinite(v) : Array.isArray(v) ? v.some(hasBadNumber) : v !== null && typeof v === 'object' ? Object.values(v).some(hasBadNumber) : false;
async function request(id: string, method: string, params: Record<string, unknown>, error: Record<string, unknown> | null = null): Promise<void> {
  await db.pool.query(
    'insert into go_requests (request_id, rpc_id, trip_id, method, params, result, error, sent_at, answered_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [id, `go_${id}`, 't_goa', method, JSON.stringify(params), error === null ? JSON.stringify({ booking_id: `b_${id}`, seq: 1 }) : null, error === null ? null : JSON.stringify(error), NOW, NOW],
  );
}

beforeAll(async () => {
  db = await withSchema();
  await seedTrip(db.pool, 't_goa');
  await seedTrip(db.pool, 't_two');
});
afterAll(async () => {
  await db.drop();
});
beforeEach(async () => {
  await truncateAll(db.pool);
});

describe('the board numbers', () => {
  it('reads "no turns yet" in an empty window, with no NaN anywhere', async () => {
    const n = await computeBoard(db.pool, registry(), { now: NOW, hours: 2 });
    expect(n).toMatchObject({
      empty: true, turns: 0, messages: 0,
      typing: { n: 0, p50Ms: null, p90Ms: null }, reply: { n: 0, p50Ms: null, p90Ms: null },
      cache: { status: 'no_turns', hit: null }, wake: { turns: 0, messages: 0, rate: null },
      cost: { totalUsd: 0, perTripUsd: null, trips: 0 }, bench: [],
    });
    expect(n.sources).toEqual([{ name: 'payments_without_both_keys', label: 'Payments without both keys', good: 'zero', value: 0, of: 0, note: "All time. Bookings Go recorded without the Server's signed approval." }]);
    expect(n.window).toEqual({ hours: 2, from: '2026-10-08T16:00:00.000Z', to: '2026-10-08T18:00:00.000Z' });
    expect(hasBadNumber(n)).toBe(false);
  });

  it('measures typing and the reply from the moment the message landed, not from the turn start', async () => {
    await seedTurn(db.pool, { id: 'tu_a', at: 30, waitMs: 2000, typingMs: 300, postedMs: 1900, input: 1_000, cached: 9_000, cost: 0.01 });
    await seedTurn(db.pool, { id: 'tu_b', at: 60, waitMs: 0, typingMs: 500, postedMs: 2400, input: 800, cached: 7_200, cost: 0.008 });
    await seedTurn(db.pool, { id: 'tu_c', tripId: 't_two', at: 90, model: 'claude-haiku-4-5', input: 2_000, cost: 0.001 });
    await seedTurn(db.pool, { id: 'tu_d', at: 180, typingMs: 100, postedMs: 900, input: 5_000, cost: 0.5 });
    await seedTurn(db.pool, { id: 'tu_e', at: 10, rounds: 0 });
    for (let k = 0; k < 8; k++) await personMessage(db.pool, { at: minutesAgo(5 + k) });
    await goMessage(db.pool, { at: minutesAgo(6) });
    await goMessage(db.pool, { at: minutesAgo(7) });
    await personMessage(db.pool, { at: minutesAgo(200) });
    const n = await computeBoard(db.pool, registry(), { now: NOW, hours: 2 });
    expect(n.empty).toBe(false);
    expect(n.turns).toBe(4);
    expect(n.messages).toBe(12);
    expect(n.typing).toEqual({ n: 2, p50Ms: 300, p90Ms: 500 });
    expect(n.reply).toEqual({ n: 2, p50Ms: 1900, p90Ms: 2400 });
    expect(n.cache).toEqual({ status: 'ok', hit: 16_200 / 20_000, turns: 3, eligibleTurns: 2 });
    expect(n.wake).toEqual({ turns: 3, messages: 12, rate: 0.25 });
    expect(n.cost.trips).toBe(2);
    expect(n.cost.totalUsd).toBeCloseTo(0.019, 6);
    expect(n.cost.perTripUsd).toBeCloseTo(0.0095, 6);
  });

  it('leaves a turn that answers no message out of typing and reply times', async () => {
    await seedTurn(db.pool, { id: 'tu_greet', at: 15, message: false, typingMs: 50, postedMs: 1200, input: 600, cached: 3_000 });
    const n = await computeBoard(db.pool, registry(), { now: NOW, hours: 2 });
    expect(n.turns).toBe(1);
    expect(n.typing.n).toBe(0);
    expect(n.reply).toEqual({ n: 0, p50Ms: null, p90Ms: null });
    expect(n.cache.status).toBe('ok');
  });

  it('times a turn from the message that named Go, not from chatter it took in, and leaves out turns no message named Go in', async () => {
    // One turn took in "lol" and then "@Go flights?" 4 s later: the clock starts at the @Go line.
    await seedTurn(db.pool, { id: 'tu_merge', at: 20, chatterBeforeMs: 4_000, typingMs: 300, postedMs: 2_200, input: 600, cached: 3_000 });
    // A turn whose only message is chatter (Go spoke up on its own) has no ask to time.
    await seedTurn(db.pool, { id: 'tu_chatter', at: 30, namesGo: false, typingMs: 150, postedMs: 1_800, input: 600, cached: 3_000 });
    const n = await computeBoard(db.pool, registry(), { now: NOW, hours: 2 });
    expect(n.turns).toBe(2);
    expect(n.typing).toEqual({ n: 1, p50Ms: 300, p90Ms: 300 });
    expect(n.reply).toEqual({ n: 1, p50Ms: 2_200, p90Ms: 2_200 });
  });

  it('says not cacheable yet when every turn is under its model\'s minimum', async () => {
    await seedTurn(db.pool, { id: 'tu_h1', at: 20, model: 'claude-haiku-4-5', input: 3_000 });
    await seedTurn(db.pool, { id: 'tu_h2', at: 25, model: 'claude-haiku-4-5', input: 3_000, written: 500 });
    const n = await computeBoard(db.pool, registry(), { now: NOW, hours: 2 });
    expect(n.cache).toEqual({ status: 'not_cacheable_yet', hit: null, turns: 2, eligibleTurns: 0 });
  });

  it("counts bookings Go recorded without the Server's approval, over all time", async () => {
    await request('rq_1', 'add_booking', { trip_id: 't_goa', amount_minor: 5_420_000, currency: 'INR', approval_id: 'ap_01JA7Q3V8Z' });
    await request('rq_2', 'add_booking', { trip_id: 't_goa', amount_minor: 100_000, currency: 'INR' });
    await request('rq_3', 'add_booking', { trip_id: 't_goa', amount_minor: 100_000, currency: 'INR' }, { code: 409, message: 'conflict' });
    await request('rq_4', 'add_booking', { trip_id: 't_goa', amount_minor: 0, currency: 'INR' });
    await request('rq_5', 'post_message', { trip_id: 't_goa', text: 'Booked!' });
    const n = await computeBoard(db.pool, registry(), { now: NOW, hours: 2 });
    expect(n.sources[0]).toMatchObject({ name: 'payments_without_both_keys', value: 1, of: 2 });
  });

  it('lets a lane replace a source by name, keeps them in order, and survives one that fails', async () => {
    const r = registry();
    r.add({ name: 'payments_without_both_keys', label: 'Payments without both keys', order: 100, good: 'zero', read: async () => ({ value: 0, of: 3, note: 'From the vault: approval and passkey on every payment.' }) });
    r.add({ name: 'broken', label: 'Broken', order: 50, good: 'low', read: async () => { throw new Error('boom'); } });
    const n = await computeBoard(db.pool, r, { now: NOW, hours: 2 });
    expect(n.sources.map((s) => s.name)).toEqual(['broken', 'payments_without_both_keys']);
    expect(n.sources[0]).toMatchObject({ value: null, note: 'Could not read this number.' });
    expect(n.sources[1]).toMatchObject({ value: 0, of: 3 });
  });

  it('gives each brain its own registry with the default source in it', () => {
    const a = {};
    const b = {};
    expect(statsRegistry(a)).toBe(statsRegistry(a));
    expect(statsRegistry(a)).not.toBe(statsRegistry(b));
    expect(statsRegistry(a).list().map((s) => s.name)).toEqual(['payments_without_both_keys']);
  });

  it('shows the latest bench report for each chat', async () => {
    await db.pool.query("insert into bench_reports (chat, mode, summary, received_at) values ('goa-300', 'live', $1, $2)", [JSON.stringify({ chat: 'goa-300', cacheHit: 0.91 }), minutesAgo(600)]);
    const n = await computeBoard(db.pool, registry(), { now: NOW, hours: 2 });
    expect(n.bench).toEqual([{ chat: 'goa-300', mode: 'live', receivedAt: minutesAgo(600).toISOString(), summary: { chat: 'goa-300', cacheHit: 0.91 } }]);
  });
});
