import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyRequest } from '@go/contract';
import { GoSocket, SocketCallError, SocketTimeoutError, type Handler } from '../server-socket.js';

const secret = 'test-secret-for-the-sim-0001';

/** A bare WebSocket server standing in for Go: it records connects and frames, and lets the test answer. */
async function startGo() {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const conns: Array<{ ws: WebSocket; signature: string; target: string }> = [];
  const inbox: any[] = [];
  const waiters: Array<(f: any) => void> = [];
  wss.on('connection', (ws, req) => {
    conns.push({ ws, signature: String(req.headers['x-go-signature']), target: req.url ?? '' });
    ws.on('message', (d) => {
      const f = JSON.parse(d.toString());
      const w = waiters.shift();
      if (w) w(f);
      else inbox.push(f);
    });
  });
  const next = (ms = 2000): Promise<any> => {
    if (inbox.length > 0) return Promise.resolve(inbox.shift());
    return new Promise((resolve, reject) => {
      const w = (f: any): void => { clearTimeout(t); resolve(f); };
      const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error('no frame')); }, ms);
      waiters.push(w);
    });
  };
  const connected = async (n: number) => {
    for (let i = 0; i < 300 && conns.length < n; i++) await new Promise((r) => setTimeout(r, 10));
    if (conns.length < n) throw new Error(`only ${conns.length} connects`);
    return conns[n - 1]!;
  };
  const port = (wss.address() as AddressInfo).port;
  const close = async () => {
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
  };
  return { wss, conns, inbox, next, connected, port, close };
}

let go: Awaited<ReturnType<typeof startGo>>;
let sock: GoSocket | undefined;
afterEach(async () => {
  sock?.close();
  sock = undefined;
  await go?.close();
});

function client(handlers: Record<string, Handler> = {}, extra: Partial<ConstructorParameters<typeof GoSocket>[0]> = {}) {
  sock = new GoSocket({ url: `ws://127.0.0.1:${go.port}/v1/socket?instance=sim-test`, secret, handlers, backoffSeconds: [0.05], ...extra });
  sock.start();
  return sock;
}

describe('GoSocket: connecting', () => {
  it('signs every connect fresh, with the query string in the target', async () => {
    go = await startGo();
    let clock = 1_791_190_800;
    client({}, { nowSeconds: () => clock++ });
    const first = await go.connected(1);
    expect(first.target).toBe('/v1/socket?instance=sim-test');
    expect(verifyRequest({ method: 'GET', target: first.target, body: '' }, first.signature, secret, 1_791_190_800)).toEqual({ ok: true });
    first.ws.terminate();
    const second = await go.connected(2);
    expect(second.signature).not.toBe(first.signature);
    expect(verifyRequest({ method: 'GET', target: second.target, body: '' }, second.signature, secret, 1_791_190_801)).toEqual({ ok: true });
  });

  it('close() stops reconnecting and fails the requests still waiting', async () => {
    go = await startGo();
    const s = client();
    const conn = await go.connected(1);
    const waiting = s.request('read_trip', { trip_id: 't_goa' }, { timeoutMs: 5000 });
    await go.next();
    s.close();
    await expect(waiting).rejects.toBeInstanceOf(SocketTimeoutError);
    conn.ws.terminate();
    await new Promise((r) => setTimeout(r, 200));
    expect(go.conns.length).toBe(1);
  });
});

describe('GoSocket: requests', () => {
  it('resolves with the result, fails with SocketCallError on an error frame, and times out', async () => {
    go = await startGo();
    const s = client();
    const conn = await go.connected(1);

    const ok = s.request('send_event', { event_id: 'ev_1' });
    const f1 = await go.next();
    expect(f1).toMatchObject({ jsonrpc: '2.0', method: 'send_event', params: { event_id: 'ev_1' } });
    expect(f1.id).toMatch(/^gs_/);
    conn.ws.send(JSON.stringify({ jsonrpc: '2.0', id: f1.id, result: { accepted: true, duplicate: false } }));
    await expect(ok).resolves.toEqual({ accepted: true, duplicate: false });

    const busy = s.request('catch_up', { trip_id: 't_goa', person_id: 'p_meher', since: '2026-10-05T03:30:00Z' });
    const f2 = await go.next();
    conn.ws.send(JSON.stringify({ jsonrpc: '2.0', id: f2.id, error: { code: 429, message: 'slow down', data: { code: 'rate_limited', retry_after_seconds: 5 } } }));
    const err = await busy.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocketCallError);
    expect(err).toMatchObject({ code: 429, dataCode: 'rate_limited', retryAfterSeconds: 5 });

    await expect(s.request('get_person', { person_id: 'p_kabir' }, { timeoutMs: 50 })).rejects.toBeInstanceOf(SocketTimeoutError);
  });

  it('sends an unanswered request again after a reconnect, with the same id', async () => {
    go = await startGo();
    const s = client();
    const first = await go.connected(1);
    const answer = s.request('card_tap', { tap_id: 'tap_1' }, { timeoutMs: 5000 });
    const sent = await go.next();
    first.ws.terminate();
    const second = await go.connected(2);
    const again = await go.next();
    expect(again.id).toBe(sent.id);
    expect(again.params).toEqual({ tap_id: 'tap_1' });
    second.ws.send(JSON.stringify({ jsonrpc: '2.0', id: again.id, result: { result: 'done' } }));
    await expect(answer).resolves.toEqual({ result: 'done' });
  });

  it('notify sends a frame without an id, and drops it while the socket is down', async () => {
    go = await startGo();
    const s = client();
    await go.connected(1);
    for (let i = 0; i < 100 && !s.isOpen(); i++) await new Promise((r) => setTimeout(r, 10)); // the client's side opens a moment later
    s.notify('typing', { trip_id: 't_goa', on: true });
    const f = await go.next();
    expect(f).toEqual({ jsonrpc: '2.0', method: 'typing', params: { trip_id: 't_goa', on: true } });
    const offline = new GoSocket({ url: 'ws://127.0.0.1:1/v1/socket', secret, handlers: {}, backoffSeconds: [10] });
    expect(() => offline.notify('typing', { trip_id: 't_goa', on: false })).not.toThrow();
    offline.close();
  });
});

describe('GoSocket: answering Go', () => {
  async function ask(conn: { ws: WebSocket }, frame: unknown): Promise<any> {
    conn.ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
    return go.next();
  }

  it('answers through the handlers, with every error the contract names', async () => {
    go = await startGo();
    const seenRaw: unknown[] = [];
    client({
      read_trip: async (p, raw) => { seenRaw.push(raw); return { trip_id: p.trip_id }; },
      add_reaction: async () => {},
      post_message: async () => { throw new Error('database down'); },
      close_vote: async () => { throw new SocketCallError(409, 'decision d_when is already closed', 'conflict'); },
    });
    const conn = await go.connected(1);

    expect(await ask(conn, { jsonrpc: '2.0', id: 'go_1', method: 'read_trip', params: { trip_id: 't_goa', extra: 1 } }))
      .toEqual({ jsonrpc: '2.0', id: 'go_1', result: { trip_id: 't_goa' } });
    expect(seenRaw).toEqual([{ trip_id: 't_goa', extra: 1 }]);

    const reaction = { request_id: 'rq_1', trip_id: 't_goa', message_id: 'm_0122', emoji: '✅' };
    expect(await ask(conn, { jsonrpc: '2.0', id: 'go_2', method: 'add_reaction', params: reaction }))
      .toEqual({ jsonrpc: '2.0', id: 'go_2', result: {} });

    expect(await ask(conn, { jsonrpc: '2.0', id: 'go_3', method: 'launch_rockets', params: {} }))
      .toEqual({ jsonrpc: '2.0', id: 'go_3', error: { code: -32601, message: 'unknown method launch_rockets' } });
    expect(await ask(conn, { jsonrpc: '2.0', id: 'go_4', method: 'open_vote', params: { trip_id: 't_goa' } }))
      .toEqual({ jsonrpc: '2.0', id: 'go_4', error: { code: -32601, message: 'unknown method open_vote' } });

    const bad = await ask(conn, { jsonrpc: '2.0', id: 'go_5', method: 'read_trip', params: {} });
    expect(bad.error).toMatchObject({ code: 422, data: { code: 'invalid' } });
    expect(bad.error.message).toContain('trip_id');

    const crash = await ask(conn, { jsonrpc: '2.0', id: 'go_6', method: 'post_message', params: { request_id: 'rq_2', trip_id: 't_goa', text: 'hi' } });
    expect(crash).toEqual({ jsonrpc: '2.0', id: 'go_6', error: { code: 500, message: 'internal error', data: { code: 'internal' } } });

    const clash = await ask(conn, { jsonrpc: '2.0', id: 'go_7', method: 'close_vote', params: { request_id: 'rq_3', trip_id: 't_goa', decision_id: 'd_when' } });
    expect(clash).toEqual({ jsonrpc: '2.0', id: 'go_7', error: { code: 409, message: 'decision d_when is already closed', data: { code: 'conflict' } } });
  });

  it('answers -32700 with id null for a frame it cannot read', async () => {
    go = await startGo();
    client();
    const conn = await go.connected(1);
    for (const junk of ['not json', 'null', '5', '[1]']) {
      expect(await ask(conn, junk)).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'cannot read the frame' } });
    }
  });

  it('never answers a notification, even a broken one', async () => {
    go = await startGo();
    const typing: unknown[] = [];
    client({ typing: async (p) => { typing.push(p); }, read_trip: async () => ({ ok: 1 }) });
    const conn = await go.connected(1);
    conn.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'typing', params: { trip_id: 't_goa', on: true } }));
    conn.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'typing', params: { on: 'yes' } }));
    // The next frame back is the answer to this request: nothing was sent for the two notifications.
    expect(await ask(conn, { jsonrpc: '2.0', id: 'go_9', method: 'read_trip', params: { trip_id: 't_goa' } })).toMatchObject({ id: 'go_9' });
    expect(typing).toEqual([{ trip_id: 't_goa', on: true }]);
  });
});

describe('GoSocket: keeping it alive', () => {
  it('stays open while Go pings, and closes after the silence limit', async () => {
    go = await startGo();
    client({}, { idleCloseSeconds: 0.3, backoffSeconds: [60] });
    const conn = await go.connected(1);
    const pinger = setInterval(() => conn.ws.ping(), 100);
    await new Promise((r) => setTimeout(r, 600));
    expect(conn.ws.readyState).toBe(conn.ws.OPEN);
    clearInterval(pinger);
    const closed = once(conn.ws, 'close');
    await expect(Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error('still open')), 1500))])).resolves.toBeDefined();
  });
});
