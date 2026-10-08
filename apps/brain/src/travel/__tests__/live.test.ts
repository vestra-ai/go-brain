import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { signedHeaders, tryOpen } from '../../__tests__/fixtures/raw-server.js';
import { withSchema } from '../../db/test-db.js';
import { createDoor, type DoorImpl } from '../../door/door.js';
import { createReplayGuard } from '../../door/replay-guard.js';
import { createServerLink } from '../../door/server-link.js';
import { silentLog } from '../../log.js';
import { registerLive, type LiveMessage } from '../live.js';
import { createRunLog, type RunLog } from '../runs.js';

const SECRET = 's'.repeat(64);
let db: Awaited<ReturnType<typeof withSchema>>;
let http: FastifyInstance;
let door: DoorImpl;
let runs: RunLog;
let base: string;
const stops: Array<() => void | Promise<void>> = [];

beforeAll(async () => {
  db = await withSchema();
  http = Fastify({ logger: false });
  const now = () => new Date();
  door = createDoor({
    http,
    secret: SECRET,
    guard: createReplayGuard({ pool: db.pool, now }),
    link: createServerLink({ pool: db.pool, log: silentLog, timeoutMs: 1_000 }),
    log: silentLog,
    now,
  });
  runs = createRunLog({ now });
  registerLive({ door, env: { GO_SIGNING_SECRET: SECRET } as never, pool: db.pool, now, log: silentLog as never, onStop: (fn) => stops.push(fn) }, runs);
  await http.listen({ port: 0, host: '127.0.0.1' });
  base = `ws://127.0.0.1:${(http.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const stop of stops) await stop();
  door.close();
  await http.close();
  await db.drop();
});

/** Opens the live view of a trip, signed as the Server signs; collects what Go sends. */
async function watch(tripId: string): Promise<{ ws: WebSocket; got: LiveMessage[]; next: (pred: (m: LiveMessage) => boolean) => Promise<LiveMessage> }> {
  const target = `/v1/live?trip_id=${tripId}`;
  const r = await tryOpen(`${base}${target}`, signedHeaders(target, SECRET));
  if (!('ws' in r)) throw new Error(`refused: ${r.status} ${r.body}`);
  const got: LiveMessage[] = [];
  const waiters: Array<{ pred: (m: LiveMessage) => boolean; resolve: (m: LiveMessage) => void }> = [];
  r.ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as LiveMessage;
    got.push(m);
    for (const w of waiters.splice(0)) {
      if (w.pred(m)) w.resolve(m);
      else waiters.push(w);
    }
  });
  const next = (pred: (m: LiveMessage) => boolean): Promise<LiveMessage> => {
    const have = got.find(pred);
    return have ? Promise.resolve(have) : new Promise((resolve) => waiters.push({ pred, resolve }));
  };
  return { ws: r.ws, got, next };
}

describe('the live view socket', () => {
  it("refuses a missing or wrong signature, a used one, and a trip id that can't be one", async () => {
    const target = '/v1/live?trip_id=t_goa';
    expect(await tryOpen(`${base}${target}`, {})).toMatchObject({ status: 401 });
    expect(await tryOpen(`${base}${target}`, signedHeaders(target, 'x'.repeat(64)))).toMatchObject({ status: 401 });
    const headers = signedHeaders(target, SECRET);
    const first = await tryOpen(`${base}${target}`, headers);
    expect('ws' in first).toBe(true);
    if ('ws' in first) first.ws.close();
    expect(await tryOpen(`${base}${target}`, headers)).toMatchObject({ status: 401 });
    const bad = '/v1/live?trip_id=..%2Fx';
    expect(await tryOpen(`${base}${bad}`, signedHeaders(bad, SECRET))).toMatchObject({ status: 404 });
  });

  it("opens with the trip's recent runs, then tells each event as it comes, and nothing of another trip", async () => {
    const before = runs.start('t_live1', 'hotels.search', 'Stays');
    before.end(true, { speed: 'page', rows: 4 });
    const v = await watch('t_live1');
    const hello = await v.next((m) => m.type === 'hello');
    expect(hello).toMatchObject({ type: 'hello', trip_id: 't_live1' });
    expect(hello.type === 'hello' && hello.events.map((e) => e.type)).toEqual(['run_start', 'run_end', 'group_end']);

    runs.start('t_other', 'buses.between', 'Buses');
    const run = runs.start('t_live1', 'trains.between', 'Trains');
    run.attempt('fast');
    const attempt = await v.next((m) => m.type === 'run' && m.event.type === 'attempt');
    expect(attempt).toEqual({ type: 'run', event: { type: 'attempt', run_id: run.id, speed: 'fast', at_ms: expect.any(Number) } });
    expect(v.got.some((m) => m.type === 'run' && m.event.type === 'run_start' && m.event.recipe_id === 'buses.between')).toBe(false);
    v.ws.close();
  });

  it('a viewer that left is let go: its runs keep going and nothing is sent to it', async () => {
    const v = await watch('t_live2');
    await v.next((m) => m.type === 'hello');
    await new Promise<void>((resolve) => {
      v.ws.once('close', () => resolve());
      v.ws.close();
    });
    const run = runs.start('t_live2', 'hotels.search', 'Stays');
    run.end(true);
    expect(v.got).toHaveLength(1);
  });
});
