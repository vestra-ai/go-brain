/**
 * The live view's socket, /v1/live?trip_id=<trip>: one trip's recipe runs as they happen (runs.ts), for a screen the
 * Server shows (the try room's Go Live). Signed exactly as the Server's own socket is: x-go-signature over the path and
 * query, each signature good once. Read only: nothing a viewer sends is read.
 *
 * On open, a hello with the trip's recent events and pictures; then every event as it comes. A viewer that falls
 * behind (over MAX_BEHIND_BYTES waiting to go out) misses pictures, never a run's events.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import * as C from '@go/contract';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Brain } from '../app.js';
import { refuse, signatureParts } from '../door/door.js';
import { createReplayGuard } from '../door/replay-guard.js';
import type { RunEvent, RunLog } from './runs.js';

export const LIVE_PATH = /^\/v1\/live$/;
/** Pictures wait while this much is still going out to a viewer. */
export const MAX_BEHIND_BYTES = 1_000_000;
/** A ping keeps proxies from closing a quiet socket. */
const PING_MS = 20_000;
const TRIP_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** What a viewer reads: the hello first, then one message per event. */
export type LiveMessage = { type: 'hello'; trip_id: string; events: RunEvent[] } | { type: 'run'; event: RunEvent };

export function registerLive(brain: Pick<Brain, 'door' | 'env' | 'pool' | 'now' | 'log' | 'onStop'>, runs: RunLog): { viewers(): number } {
  const guard = createReplayGuard({ pool: brain.pool, now: brain.now });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4_096 });
  const open = new Set<WebSocket>();

  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on('error', () => socket.destroy());
    try {
      const target = req.url ?? '';
      const raw = req.headers[C.SIGNATURE_HEADER];
      const header = Array.isArray(raw) ? raw[0] : raw;
      const checked = C.verifyRequest({ method: 'GET', target, body: '' }, header, brain.env.GO_SIGNING_SECRET, Math.floor(brain.now().getTime() / 1_000));
      if (!checked.ok) return refuse(socket, 401, 'bad_signature', `signature ${checked.reason}`);
      const parts = signatureParts(header ?? '');
      if (!parts || !(await guard.claim(parts.t, parts.v1))) return refuse(socket, 401, 'bad_signature', 'signature already used');
      const tripId = new URL(target, 'http://go.local').searchParams.get('trip_id') ?? '';
      if (!TRIP_ID.test(tripId)) return refuse(socket, 404, 'not_found', 'no such trip');
      wss.handleUpgrade(req, socket, head, (ws) => watch(ws, tripId));
    } catch (err) {
      brain.log.error({ err }, 'travel: a live view upgrade failed');
      refuse(socket, 503, 'unavailable', 'try again in a moment');
    }
  }

  function watch(ws: WebSocket, tripId: string): void {
    open.add(ws);
    const send = (m: LiveMessage): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
    };
    send({ type: 'hello', trip_id: tripId, events: runs.recent(tripId) });
    const off = runs.subscribe(tripId, (event) => {
      if (event.type === 'frames' && ws.bufferedAmount > MAX_BEHIND_BYTES) return;
      send({ type: 'run', event });
    });
    const ping = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.ping();
    }, PING_MS);
    ping.unref();
    ws.on('error', () => undefined);
    ws.on('close', () => {
      off();
      clearInterval(ping);
      open.delete(ws);
    });
  }

  brain.door.onUpgrade(LIVE_PATH, (req, socket, head) => void upgrade(req, socket, head));
  brain.onStop(() => {
    for (const ws of open) ws.terminate();
    wss.close();
  });
  return { viewers: () => open.size };
}
