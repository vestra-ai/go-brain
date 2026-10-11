import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SIGNATURE_HEADER, verifyRequest } from '@go/contract';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { liveTarget, openLiveFeed } from '../try-room/live-feed.js';

const secret = 'sim-test-secret-0123456789abcdef';
let server: Server | undefined;
let wss: WebSocketServer | undefined;
const closers: Array<{ close(): void }> = [];

afterEach(async () => {
  for (const c of closers.splice(0)) c.close();
  wss?.close();
  if (server) await new Promise((r) => server!.close(() => r(undefined)));
  server = undefined;
  wss = undefined;
});

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A stand-in for Go's /v1/live: checks the signature as Go does, refuses with `status` when set, greets each feed. */
async function fakeGo(o: { status?: number } = {}) {
  const opened: Array<{ target: string; ws: WebSocket }> = [];
  wss = new WebSocketServer({ noServer: true });
  server = createServer();
  server.on('upgrade', (req, socket, head) => {
    const target = req.url ?? '';
    const header = req.headers[SIGNATURE_HEADER];
    const ok = verifyRequest({ method: 'GET', target, body: '' }, Array.isArray(header) ? header[0] : header, secret, Math.floor(Date.now() / 1000)).ok;
    if (o.status || !ok) {
      socket.end(`HTTP/1.1 ${o.status ?? 401} Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      return;
    }
    wss!.handleUpgrade(req, socket, head, (ws) => {
      opened.push({ target, ws });
      ws.send(JSON.stringify({ type: 'hello', trip_id: new URL(target, 'http://go').searchParams.get('trip_id'), events: [] }));
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, opened };
}

describe("the try room's feed of Go Live", () => {
  it('signs each open fresh, with a random n, so two tabs in one second are two signatures', () => {
    const a = liveTarget('t_try_1');
    const b = liveTarget('t_try_1');
    expect(a).toMatch(/^\/v1\/live\?trip_id=t_try_1&n=[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });

  it("opens Go's live view of the trip, signed, hands on what Go says, and dials again when it drops", async () => {
    const go = await fakeGo();
    const got: any[] = [];
    closers.push(openLiveFeed({ goUrl: go.url, secret, tripId: 't_try_1', onMessage: (m) => got.push(m), waitsMs: [20] }));
    await until(() => got.length === 1);
    expect(got[0]).toEqual({ type: 'hello', trip_id: 't_try_1', events: [] });
    go.opened[0]!.ws.terminate();
    await until(() => go.opened.length === 2 && got.filter((m) => m.type === 'hello').length === 2);
    expect(got.some((m) => m.type === 'off')).toBe(true);
    expect(go.opened[1]!.target).not.toBe(go.opened[0]!.target);
  });

  it('tells the page the view is off while Go refuses it, and stops dialling once closed', async () => {
    const go = await fakeGo({ status: 404 });
    const got: any[] = [];
    const feed = openLiveFeed({ goUrl: go.url, secret, tripId: 't_try_2', onMessage: (m) => got.push(m), waitsMs: [20] });
    closers.push(feed);
    await until(() => got.filter((m) => m.type === 'off').length >= 2);
    expect(got[0]).toEqual({ type: 'off', why: "Go's live view is not answering." });
    feed.close();
    const after = got.length;
    await new Promise((r) => setTimeout(r, 120));
    expect(got.length).toBe(after);
  });
});
