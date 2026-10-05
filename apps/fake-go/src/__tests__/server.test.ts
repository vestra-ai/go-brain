import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ErrorBody, Health, signRequest } from '@go/contract';
import { GoSocket, SocketCallError, type Handler } from '@go/sim';
import { KNOWN_EVENT_TYPES, buildFakeGo, type FakeGo, type FakeGoOptions } from '../server.js';

const secret = 'fake-go-test-secret-0123456789abcdef';
const adminToken = 'admin-token-for-tests-0001';
const at = '2026-10-05T06:49:00Z';

let fake: FakeGo | undefined;
const sockets: GoSocket[] = [];
const raws: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const r of raws.splice(0)) r.terminate();
  await fake?.close();
  fake = undefined;
});

async function start(extra: Partial<FakeGoOptions> = {}): Promise<number> {
  fake = buildFakeGo({ secret, adminToken, ...extra });
  await fake.app.listen({ port: 0, host: '127.0.0.1' });
  return (fake.app.server.address() as AddressInfo).port;
}

const sign = (target: string, t?: number): string => signRequest({ method: 'GET', target, body: '' }, secret, t);

/** Opens a raw socket. Resolves with the open socket and the frames it gets, or with the refusal's status and body. */
function tryConnect(port: number, target: string, headers: Record<string, string>, extra: WebSocket.ClientOptions = {}) {
  return new Promise<{ ws: WebSocket; frames: any[] } | { status: number; body: string }>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${target}`, { headers, ...extra });
    const frames: any[] = [];
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
    ws.on('open', () => { raws.push(ws); resolve({ ws, frames }); });
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    ws.on('error', () => {});
  });
}

async function openRaw(port: number, instance: string, extra: WebSocket.ClientOptions = {}) {
  const target = `/v1/socket?instance=${instance}`;
  const r = await tryConnect(port, target, { 'x-go-signature': sign(target) }, extra);
  if (!('ws' in r)) throw new Error(`refused: ${r.status} ${r.body}`);
  return r;
}

async function until<T>(check: () => T | undefined | false, ms = 2000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() - started > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The Server's end, as the Server team will run it: @go/sim's GoSocket. */
async function serverSide(port: number, instance: string, handlers: Record<string, Handler> = {}): Promise<GoSocket> {
  let opened!: () => void;
  const ready = new Promise<void>((r) => (opened = r));
  const sock = new GoSocket({ url: `ws://127.0.0.1:${port}/v1/socket?instance=${instance}`, secret, handlers, onOpen: () => opened() });
  sockets.push(sock);
  sock.start();
  await ready;
  return sock;
}

function priyaAsks(eventId: string) {
  return {
    event_id: eventId, trip_id: 't_goa', seq: 57, occurred_at: at, type: 'message.created',
    data: {
      message: {
        message_id: 'm_0132', seq: 57, updated_seq: 57, author: { kind: 'person', person_id: 'p_priya' },
        text: '@Go flights on Friday from Delhi, under 6k?', attachments: [], mentions_go: true, mentions: [], reactions: [],
        withheld: false, deleted: false, sent_at: at,
      },
    },
  };
}

describe('the upgrade', () => {
  it('refuses a missing, malformed, stale or wrong signature with 401 and an ErrorBody', async () => {
    const port = await start();
    const t = '/v1/socket';
    const cases: Array<Record<string, string>> = [
      {},
      { 'x-go-signature': 'nonsense' },
      { 'x-go-signature': sign(t, Math.floor(Date.now() / 1000) - 1000) },
      { 'x-go-signature': signRequest({ method: 'GET', target: t, body: '' }, 'another-secret-another-secret-00') },
    ];
    for (const headers of cases) {
      const r = await tryConnect(port, t, headers);
      expect(r).toMatchObject({ status: 401 });
      if ('status' in r) expect(ErrorBody.parse(JSON.parse(r.body)).error.code).toBe('bad_signature');
    }
  });

  it('accepts a signature once; the same signature again is refused, in any field order', async () => {
    const port = await start();
    const target = '/v1/socket?instance=once';
    const header = sign(target);
    expect('ws' in (await tryConnect(port, target, { 'x-go-signature': header }))).toBe(true);
    const again = await tryConnect(port, target, { 'x-go-signature': header });
    expect(again).toMatchObject({ status: 401 });
    if ('status' in again) expect(JSON.parse(again.body)).toEqual({ error: { code: 'bad_signature', message: 'signature already used' } });
    const [tPart, vPart] = header.split(',');
    expect(await tryConnect(port, target, { 'x-go-signature': `${vPart},${tPart}` })).toMatchObject({ status: 401 });
  });

  it('needs the query string signed, and opens nothing on other paths', async () => {
    const port = await start();
    expect(await tryConnect(port, '/v1/socket?instance=x', { 'x-go-signature': sign('/v1/socket') })).toMatchObject({ status: 401 });
    expect(await tryConnect(port, '/v2/socket', { 'x-go-signature': sign('/v2/socket') })).toMatchObject({ status: 404 });
  });
});

describe('health and pages', () => {
  it('answers health without a signature', async () => {
    await start();
    const res = await fake!.app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(Health.parse(res.json())).toEqual({ ok: true, contract: '1.0.0' });
  });

  it('shows the last frames only with the admin token', async () => {
    const port = await start();
    const sock = await serverSide(port, 'frames');
    await sock.request('send_event', priyaAsks('ev_frames'));
    expect((await fake!.app.inject({ method: 'GET', url: '/frames' })).statusCode).toBe(401);
    expect((await fake!.app.inject({ method: 'GET', url: '/frames?token=wrong' })).statusCode).toBe(401);
    const page = await fake!.app.inject({ method: 'GET', url: `/frames?token=${adminToken}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('send_event');
    expect(page.body).toContain('Server to Go');
    expect(page.body).toContain('Go to Server');
    expect(page.body).not.toContain('\u2014');
  });

  it('serves the pages its watch and vault links open', async () => {
    await start();
    for (const kind of ['watch', 'vault']) {
      const res = await fake!.app.inject({ method: 'GET', url: `/fake/page/${kind}?card=c_1` });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('This is the fake Go');
      expect(res.body).not.toContain('\u2014');
    }
  });
});

describe('send_event', () => {
  it('accepts an event type it does not know before checking anything else, and remembers its event_id', async () => {
    const seen: unknown[] = [];
    const port = await start({ behaviour: () => ({ handlers: {}, onEvent: (e) => { seen.push(e); } }) });
    const sock = await serverSide(port, 'unknown');
    const odd = { event_id: 'ev_odd', trip_id: 't_goa', seq: 9, occurred_at: at, type: 'trip.exploded', data: { boom: true } };
    expect(await sock.request('send_event', odd)).toEqual({ accepted: true, duplicate: false });
    expect(await sock.request('send_event', odd)).toEqual({ accepted: true, duplicate: true });
    expect(await sock.request('send_event', { type: 'trip.renamed_later' })).toEqual({ accepted: true, duplicate: false });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([]);
  });

  it('refuses a broken event of a known type with 422 invalid', async () => {
    const port = await start();
    const sock = await serverSide(port, 'broken');
    const err = await sock.request('send_event', { ...priyaAsks('ev_broken'), seq: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocketCallError);
    expect(err).toMatchObject({ code: 422, dataCode: 'invalid' });
  });

  it('does each event once: a repeat in a new frame answers duplicate and does nothing', async () => {
    const seen: string[] = [];
    const port = await start({ behaviour: () => ({ handlers: {}, onEvent: (e) => { seen.push(e.event_id); } }) });
    const sock = await serverSide(port, 'dupes');
    expect(await sock.request('send_event', priyaAsks('ev_0057'))).toEqual({ accepted: true, duplicate: false });
    expect(await sock.request('send_event', priyaAsks('ev_0057'))).toEqual({ accepted: true, duplicate: true });
    await until(() => seen.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(['ev_0057']);
  });

  it('knows all 20 event types of the contract', () => {
    expect(KNOWN_EVENT_TYPES.size).toBe(20);
    expect(KNOWN_EVENT_TYPES.has('message.created')).toBe(true);
    expect(KNOWN_EVENT_TYPES.has('expense.changed')).toBe(true);
  });
});

describe("the Server's other requests", () => {
  it("answers -32601 for a method it does not handle, including Go's own method names", async () => {
    const port = await start({ behaviour: () => ({ handlers: { get_person: async (p) => ({ person_id: p.person_id, carry_over: false, facts: [] }) } }) });
    const sock = await serverSide(port, 'unknown-methods');
    const calls: Array<[string, object]> = [['launch_rockets', {}], ['read_trip', { trip_id: 't_goa' }], ['catch_up', { trip_id: 't_goa', person_id: 'p_meher', since: at }]];
    for (const [method, params] of calls) {
      const err = await sock.request(method, params).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SocketCallError);
      expect(err).toMatchObject({ code: -32601, dataCode: undefined });
    }
  });

  it('checks params, then answers with the handler, or 500 when the handler fails', async () => {
    const port = await start({
      behaviour: () => ({
        handlers: {
          get_person: async (p) => ({ person_id: p.person_id, carry_over: false, facts: [] }),
          update_person: async () => { throw new Error('boom'); },
        },
      }),
    });
    const sock = await serverSide(port, 'handlers');
    expect(await sock.request('get_person', { person_id: 'p_kabir' })).toEqual({ person_id: 'p_kabir', carry_over: false, facts: [] });
    expect(await sock.request('get_person', {}).catch((e: unknown) => e)).toMatchObject({ code: 422, dataCode: 'invalid' });
    expect(await sock.request('update_person', { person_id: 'p_kabir', carry_over: true }).catch((e: unknown) => e))
      .toMatchObject({ code: 500, dataCode: 'internal' });
  });

  it('answers -32700 with id null for a frame it cannot read', async () => {
    const port = await start();
    const { ws, frames } = await openRaw(port, 'junk');
    ws.send('not json');
    ws.send('[1,2]');
    await until(() => frames.length === 2);
    for (const f of frames) expect(f).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'cannot read the frame' } });
  });
});

describe("Go's requests to the Server", () => {
  it('go out with go_ ids and resolve with the answer; both frames land in the frames log', async () => {
    const port = await start();
    await serverSide(port, 'reads', { read_trip: async (p) => ({ trip_id: p.trip_id, seen: true }) });
    expect(await fake!.link.request('read_trip', { trip_id: 't_goa' })).toEqual({ trip_id: 't_goa', seen: true });
    const out = fake!.frames.list().find((f) => f.direction === 'out' && f.text.includes('read_trip'));
    expect(JSON.parse(out!.text).id).toMatch(/^go_/);
    expect(fake!.frames.list().some((f) => f.direction === 'in' && f.text.includes('"seen":true'))).toBe(true);
  });

  it('go again on the next socket, with the same id, when their socket drops before the answer', async () => {
    const port = await start();
    const first = await openRaw(port, 'one');
    const answer = fake!.link.request('read_trip', { trip_id: 't_goa' }, { timeoutMs: 5000 });
    await until(() => first.frames.length === 1);
    const sent = first.frames[0];
    first.ws.terminate();
    const second = await openRaw(port, 'two');
    await until(() => second.frames.length === 1);
    expect(second.frames[0]).toEqual(sent);
    second.ws.send(JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { trip_id: 't_goa' } }));
    await expect(answer).resolves.toEqual({ trip_id: 't_goa' });
  });
});

describe('keeping the socket alive', () => {
  // Short intervals instead of fake timers: real sockets and faked timers do not mix well.
  it('pings on the interval and keeps a socket that answers open', async () => {
    const port = await start({ pingIntervalMs: 50, idleCloseMs: 200 });
    const { ws } = await openRaw(port, 'pinged');
    let pings = 0;
    ws.on('ping', () => (pings += 1));
    await new Promise((r) => setTimeout(r, 400));
    expect(pings).toBeGreaterThanOrEqual(4);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('closes a socket that has been silent for the limit', async () => {
    const port = await start({ pingIntervalMs: 50, idleCloseMs: 200 });
    const { ws } = await openRaw(port, 'silent', { autoPong: false });
    const closed = once(ws, 'close').then(() => 'closed');
    await expect(Promise.race([closed, new Promise((r) => setTimeout(() => r('open'), 1000))])).resolves.toBe('closed');
  });
});
