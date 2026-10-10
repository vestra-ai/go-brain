import type { AddressInfo } from 'node:net';
import * as C from '@go/contract';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { rawServer, signedHeaders, tryOpen, type RawServer } from '../../__tests__/fixtures/raw-server.js';
import { withSchema } from '../../db/test-db.js';
import { silentLog } from '../../log.js';
import { createDoor, type DoorImpl } from '../door.js';
import { createReplayGuard } from '../replay-guard.js';
import { SocketCallError } from '../rpc.js';
import { createServerLink, type ServerLinkImpl } from '../server-link.js';

const SECRET = 's'.repeat(64);
let db: Awaited<ReturnType<typeof withSchema>>;
let http: FastifyInstance;
let door: DoorImpl;
let link: ServerLinkImpl;
let base: string;
const events: unknown[] = [];
// A lane's own socket (P6's media stream works the same way): it answers each frame and records the path it was opened on.
// It answers rather than greeting, because a greeting sent at once can arrive before the test's listener is attached.
const laneWss = new WebSocketServer({ noServer: true });
const lanePaths: string[] = [];

beforeAll(async () => {
  db = await withSchema();
  http = Fastify({ logger: false });
  link = createServerLink({ pool: db.pool, log: silentLog, timeoutMs: 1_000 });
  door = createDoor({
    http,
    secret: SECRET,
    guard: createReplayGuard({ pool: db.pool, now: () => new Date() }),
    link,
    log: silentLog,
    now: () => new Date(),
    pingMs: 50,
    idleMs: 300,
  });
  door.handle('send_event', async (ev) => {
    events.push(ev);
    return { accepted: true, duplicate: false };
  });
  door.handle('get_person', async (p) => {
    if (p.person_id === 'p_slow') await new Promise((r) => setTimeout(r, 2_500));
    return { person_id: p.person_id, carry_over: false, facts: [] };
  });
  door.handle('update_person', async () => {
    throw new SocketCallError(429, 'busy', 'rate_limited', 3);
  });
  door.handle('forget_person', async () => {
    throw new Error('boom');
  });
  door.handle('delete_fact', async () => ({ ok: false }) as never);
  door.onUpgrade(/^\/lane\/echo\/([a-z0-9_]+)$/, (req, socket, head) => {
    lanePaths.push(req.url ?? '');
    laneWss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (d) => ws.send(`lane ${String(d)}`)));
  });
  await http.listen({ port: 0, host: '127.0.0.1' });
  base = `ws://127.0.0.1:${(http.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  door.close();
  laneWss.close();
  await http.close();
  await db.drop();
});

let n = 0;
const target = () => `/v1/socket?instance=test-${++n}`;
const connect = () => rawServer(`${base}${target()}`, SECRET);

describe('the door', () => {
  it('GET /v1/health answers without a signature', async () => {
    const r = await http.inject({ method: 'GET', url: '/v1/health' });
    expect(r.json()).toEqual({ ok: true, contract: '1.1.0' });
  });

  it('a good signature opens the socket, and Go pings', async () => {
    const s = await connect();
    await new Promise((resolve) => s.ws.once('ping', resolve));
    expect(door.openSockets()).toBeGreaterThanOrEqual(1);
    await s.close();
  });

  it('refuses a missing, wrong or stale signature with 401 bad_signature', async () => {
    const t = target();
    const cases = [{}, signedHeaders(t, 'x'.repeat(64)), signedHeaders(t, SECRET, Math.floor(Date.now() / 1_000) - 400)];
    for (const headers of cases) {
      const r = await tryOpen(`${base}${t}`, headers);
      expect(r).toMatchObject({ status: 401 });
      if ('status' in r) expect(JSON.parse(r.body)).toMatchObject({ error: { code: 'bad_signature' } });
    }
  });

  it('accepts each signature once', async () => {
    const t = target();
    const headers = signedHeaders(t, SECRET);
    const first = await tryOpen(`${base}${t}`, headers);
    expect('ws' in first).toBe(true);
    const again = await tryOpen(`${base}${t}`, headers);
    expect(again).toMatchObject({ status: 401 });
    if ('status' in again) expect(JSON.parse(again.body)).toEqual({ error: { code: 'bad_signature', message: 'signature already used' } });
    // The same v1 inside a reworded header is still the same signature.
    const used = headers[C.SIGNATURE_HEADER] as string;
    for (const reworded of [`t=1,${used}`, `${used}, ${used}`, used.replace(',', ' , ')]) {
      const r = await tryOpen(`${base}${t}`, { [C.SIGNATURE_HEADER]: reworded });
      expect(r).toMatchObject({ status: 401 });
    }
    if ('ws' in first) first.ws.close();
  });

  it('checks the exact path and query that were signed', async () => {
    expect(await tryOpen(`${base}/v1/socket?instance=other`, signedHeaders('/v1/socket', SECRET))).toMatchObject({ status: 401 });
  });

  it('closes a socket that stays silent for the idle time', async () => {
    const t = target();
    const r = await tryOpen(`${base}${t}`, signedHeaders(t, SECRET), { autoPong: false });
    if (!('ws' in r)) throw new Error('refused');
    await new Promise((resolve) => r.ws.once('close', resolve));
  });

  it('answers an unreadable frame with -32700 and a null id', async () => {
    const s = await connect();
    s.sendRaw('not json');
    const f = await s.waitFor((x) => x.error?.code === -32700);
    expect(f.id).toBeNull();
    expect(f.error.data).toBeUndefined();
    await s.close();
  });

  it('answers -32601 for a method Go does not know, one meant for the Server, or one with no handler yet', async () => {
    const s = await connect();
    expect((await s.call('do_magic', {})).error).toEqual({ code: -32601, message: 'unknown method do_magic' });
    expect((await s.call('read_trip', { trip_id: 't_goa' })).error.code).toBe(-32601);
    expect((await s.call('catch_up', { trip_id: 't_goa', person_id: 'p_priya', since: '2026-10-05T10:00:00Z' })).error.code).toBe(-32601);
    await s.close();
  });

  it('accepts an unknown event type before checking anything else', async () => {
    const before = events.length;
    const s = await connect();
    const a = await s.call('send_event', { type: 'trip.renamed', whatever: true });
    expect(a.result).toEqual({ accepted: true, duplicate: false });
    expect(events.length).toBe(before);
    await s.close();
  });

  it('answers 422 invalid for a known event that breaks the contract', async () => {
    const s = await connect();
    const a = await s.call('send_event', {
      type: 'message.created', event_id: 'ev_bad', trip_id: 't_goa', seq: 1, occurred_at: '2026-10-05T10:00:00Z', data: {},
    });
    expect(a.error.code).toBe(422);
    expect(a.error.data).toEqual({ code: 'invalid' });
    await s.close();
  });

  // Contract 1.1 tolerance (3): an expense.changed with a change value newer than Go knows is refused 422 invalid,
  // naming the field, as the guide says (the Server marks it failed and moves on; Go reads the trip at the gap), and
  // the socket goes on: the next event is taken.
  it('answers 422 for an expense change value Go does not know, and takes the next event on the same socket', async () => {
    const s = await connect();
    const expense = {
      expense_id: 'x_1', paid_by_person_id: 'p_rahul', amount_minor: 240000, currency: 'INR', note: 'Cab', category: 'getting_around',
      split_person_ids: ['p_rahul'], created_at: '2026-10-08T10:00:00Z',
    };
    const base = { trip_id: 't_goa', occurred_at: '2026-10-08T10:00:00Z', type: 'expense.changed' };
    const newer = await s.call('send_event', { ...base, event_id: 'ev_x_new', seq: 7, data: { expense, change: 'reopened', by: { kind: 'system' } } });
    expect(newer.error.code).toBe(422);
    expect(newer.error.data).toEqual({ code: 'invalid' });
    expect(newer.error.message).toMatch(/change/);
    const before = events.length;
    const known = await s.call('send_event', { ...base, event_id: 'ev_x_ok', seq: 8, data: { expense, change: 'disputed', by: { kind: 'person', person_id: 'p_priya' }, by_person_id: 'p_priya' } });
    expect(known.result).toEqual({ accepted: true, duplicate: false });
    expect(events.length).toBe(before + 1);
    await s.close();
  });

  it('turns a handler failure into 500, keeps a handler\'s 429 with its wait, and refuses a bad answer', async () => {
    const s = await connect();
    expect((await s.call('forget_person', { person_id: 'p_priya' })).error).toMatchObject({ code: 500, data: { code: 'internal' } });
    expect((await s.call('update_person', { person_id: 'p_priya', carry_over: true })).error).toMatchObject({
      code: 429,
      data: { code: 'rate_limited', retry_after_seconds: 3 },
    });
    expect((await s.call('delete_fact', { person_id: 'p_priya', fact_id: 'f_1' })).error.code).toBe(500);
    await s.close();
  });

  it('answers the same id twice with one answer each, running the handler once', async () => {
    const s = await connect();
    const before = events.length;
    const ev = { event_id: 'ev_twice', trip_id: 't_goa', seq: 9, occurred_at: '2026-10-05T10:00:00Z', type: 'person.left', data: { person_id: 'p_kabir' } };
    const a = await s.call('send_event', ev, 'gs_same');
    const b = await s.call('send_event', ev, 'gs_same');
    expect(a.result).toEqual({ accepted: true, duplicate: false });
    expect(b.result).toEqual(a.result);
    expect(events.length).toBe(before + 1);
    await s.close();
  });

  it('answers 503 inside the limit when a handler is too slow', async () => {
    const s = await connect();
    const t0 = Date.now();
    const a = await s.call('get_person', { person_id: 'p_slow' });
    expect(a.error).toMatchObject({ code: 503, data: { code: 'unavailable' } });
    expect(Date.now() - t0).toBeLessThan(2_000);
    await s.close();
  });

  it('hands the Server\'s answers to Go\'s requests to the link', async () => {
    const s = await rawServer(`${base}${target()}`, SECRET, (method) => (method === 'read_messages' ? { messages: [], has_more: false } : {}));
    await expect(link.request('read_messages', { trip_id: 't_goa', after_seq: 0 })).resolves.toEqual({ messages: [], has_more: false });
    await s.close();
  });

  it("sends Go's requests for a trip on a socket of the trip's own Server instance, named by ?instance=", async () => {
    const page = { messages: [], has_more: false };
    const answer = (method: string) => (method === 'read_messages' ? page : {});
    const [ta, tb] = [target(), target()];
    const a = await rawServer(`${base}${ta}`, SECRET, answer);
    const b = await rawServer(`${base}${tb}`, SECRET, answer);
    // Each trip's instance, as intake records it from the trip's first event.
    const instanceOf = (t: string) => new URL(t, 'http://go.local').searchParams.get('instance');
    await db.pool.query('insert into trips (trip_id, server_instance) values ($1, $2), ($3, $4)', ['t_aff_a', instanceOf(ta), 't_aff_b', instanceOf(tb)]);
    for (let i = 0; i < 3; i++) {
      await expect(link.request('read_messages', { trip_id: 't_aff_a', after_seq: i })).resolves.toEqual(page);
      await expect(link.request('read_messages', { trip_id: 't_aff_b', after_seq: i })).resolves.toEqual(page);
    }
    const asked = (s: RawServer) => s.frames.filter((f) => f.method === 'read_messages').map((f) => f.params.trip_id);
    expect(asked(a)).toEqual(['t_aff_a', 't_aff_a', 't_aff_a']);
    expect(asked(b)).toEqual(['t_aff_b', 't_aff_b', 't_aff_b']);
    await a.close();
    await b.close();
  });
});

describe('other WebSocket paths (Door.onUpgrade)', () => {
  it('a path a lane registered reaches its handler, with no signature asked by the door', async () => {
    const before = door.openSockets();
    const r = await tryOpen(`${base}/lane/echo/call_1?token=abc`, {});
    if (!('ws' in r)) throw new Error(`refused: ${r.status} ${r.body}`);
    const answered = new Promise<string>((resolve) => r.ws.once('message', (d) => resolve(String(d))));
    r.ws.send('hello');
    expect(await answered).toBe('lane hello');
    expect(lanePaths.at(-1)).toBe('/lane/echo/call_1?token=abc');
    // The lane's socket is the lane's: the door never counts it as one of the Server's sockets.
    expect(door.openSockets()).toBeLessThanOrEqual(before);
    r.ws.close();
  });

  it('a path nobody registered is still 404 not_found', async () => {
    for (const path of ['/calls/media/call_1', '/lane/echo/', '/lane/echo/call_1/more']) {
      const r = await tryOpen(`${base}${path}`, {});
      expect(r, path).toMatchObject({ status: 404 });
      if ('status' in r) expect(JSON.parse(r.body)).toEqual({ error: { code: 'not_found', message: 'no such socket' } });
    }
  });

  it('the Server\'s socket stays the door\'s own: a lane cannot take it, and it still needs its signature', async () => {
    expect(() => door.onUpgrade(/^\/v1\/socket/, () => undefined)).toThrow(/\/v1\/socket/);
    expect(() => door.onUpgrade(/socket/, () => undefined)).toThrow(/\/v1\/socket/);
    expect(await tryOpen(`${base}${target()}`, {})).toMatchObject({ status: 401 });
    const s = await connect();
    expect(door.openSockets()).toBeGreaterThanOrEqual(1);
    await s.close();
  });
});
