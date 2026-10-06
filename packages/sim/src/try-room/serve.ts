// serveTryRoom: the hosted "try Go" room, for a judge to chat with the real Go in two minutes. It plays the Server: the
// FakeServer signs its socket to Go with GO_SIGNING_SECRET, here on the server side, and never in the browser. It
// serves the dev room's page behind a passcode, gives each visit its own fresh Goa trip with the five friends, lets
// "Start over" make a new one, and holds everything to the caps in caps.ts so a visitor cannot run up a bill.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { roomPage } from '../dev-room/page.js';
import { doAction, roomState, type Action } from '../dev-room/serve.js';
import type { FakeServer } from '../fake-server.js';
import { goaFreshTrip } from '../goa.js';
import { Caps, DEFAULT_CAPS, asksGo, type CapLimits } from './caps.js';
import { Gate, PAGE_HEADERS, WrongTries, clientAddress, contentSecurityPolicy, passcodePage } from './gate.js';
import {
  DAILY_LIMIT_LINE, GO_DOWN_LINE, HINTS, NOT_IN_YOUR_TRIP, PICK_A_PERSON, SIMULATED_LINE, TOO_LONG, TOO_MANY_TRIES, TYPE_SOMETHING,
  UNKNOWN_ACTION, WRONG_PASSCODE, goLiveLine,
} from './words.js';

/** The longest message a visitor can send. */
export const MAX_TEXT = 1000;
const HEALTH_EVERY_MS = 30_000;

export interface GoHealth {
  ok: boolean;
  contract: string | null;
}

export interface TryRoomOptions {
  fake: FakeServer;
  passcode: string;
  /** Go's base URL. The page says whether Go is live from its /v1/health. */
  goUrl: string;
  /** 0 picks a free port. */
  port: number;
  /** Default 127.0.0.1. Use 0.0.0.0 on Railway. */
  host?: string;
  caps?: Partial<CapLimits>;
  /** What is simulated in this demo. Default SIMULATED_LINE. */
  simulatedLine?: string;
  /** Behind Railway's proxy: the visitor's address comes from x-forwarded-for. */
  trustProxy?: boolean;
  now?: () => Date;
  /** For tests: Go's health without a call over the network. */
  goHealth?: () => Promise<GoHealth>;
  log?: (line: string) => void;
}

export interface TryRoom {
  url: string;
  caps: Caps;
  /** The trip a visit is in now. */
  tripOf(visit: string): string | undefined;
  close(): Promise<void>;
}

type PageAction = Action | { type: 'start_over' };

async function fetchGoHealth(goUrl: string): Promise<GoHealth> {
  try {
    const base = new URL(goUrl.replace(/^ws/, 'http')).origin;
    const res = await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(3000) });
    const body = (await res.json()) as { ok?: unknown; contract?: unknown };
    return { ok: res.ok && body.ok === true, contract: typeof body.contract === 'string' ? body.contract.slice(0, 20) : null };
  } catch {
    return { ok: false, contract: null };
  }
}

/** The request body, up to `limit` bytes; null when it is longer. */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

/** The socket comes from this room's own page: a browser always sends Origin on a socket, and it must be this host. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function refuseUpgrade(socket: Duplex, status: 401 | 404): void {
  socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Not Found'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Why the room refuses an action before it is counted, or null. Everything it names must be in the visit's own trip. */
function refusal(fake: FakeServer, tripId: string, a: Action): string | null {
  const trip = fake.trip(tripId);
  const isPerson = (id: unknown): boolean => typeof id === 'string' && trip.people.some((p) => p.person_id === id);
  const isDecision = (id: unknown): boolean => trip.decisions.some((d) => d.decision_id === id);
  switch (a.type) {
    case 'say':
      if (!isPerson(a.personId)) return PICK_A_PERSON;
      if (typeof a.text !== 'string' || !a.text.trim()) return TYPE_SOMETHING;
      return a.text.length > MAX_TEXT ? TOO_LONG(MAX_TEXT) : null;
    case 'tap':
      return isPerson(a.personId) && fake.messages(tripId).some((m) => m.card?.card_id === a.cardId) ? null : NOT_IN_YOUR_TRIP;
    case 'react':
      return isPerson(a.personId) && typeof a.emoji === 'string' && a.emoji.length <= 16 && fake.messages(tripId).some((m) => m.message_id === a.messageId)
        ? null
        : NOT_IN_YOUR_TRIP;
    case 'vote':
      return isPerson(a.personId) && isDecision(a.decisionId) ? null : NOT_IN_YOUR_TRIP;
    case 'confirm':
    case 'decline':
      return isDecision(a.decisionId) ? null : NOT_IN_YOUR_TRIP;
    case 'forget':
      return isPerson(a.personId) ? null : NOT_IN_YOUR_TRIP;
    default:
      return UNKNOWN_ACTION;
  }
}

export async function serveTryRoom(o: TryRoomOptions): Promise<TryRoom> {
  const now = o.now ?? (() => new Date());
  const log = o.log ?? (() => {});
  const gate = new Gate(o.passcode, now);
  const wrongTries = new WrongTries(now);
  const caps = new Caps({ ...DEFAULT_CAPS, ...o.caps }, now);
  const simulatedLine = o.simulatedLine ?? SIMULATED_LINE;
  const goHealth = o.goHealth ?? (() => fetchGoHealth(o.goUrl));
  /** Each visit's trip. */
  const trips = new Map<string, string>();
  /** Each open live socket's visit. */
  const sockets = new Map<WebSocket, string>();
  let health: GoHealth = { ok: false, contract: null };

  const refreshHealth = async (): Promise<void> => {
    health = await goHealth();
  };

  /** A fresh Goa trip for the visit, with the five friends, if today's trip cap allows one. */
  const startTrip = (visit: string): string | null => {
    if (!caps.newTrip().ok) return null;
    const tripId = `t_try_${randomBytes(6).toString('hex')}`;
    // createTrip adds the trip at once and then tells Go (trip.created); the page can draw it straight away.
    void o.fake.createTrip({ ...goaFreshTrip(), trip_id: tripId }).catch((err: unknown) => log(`trip ${tripId} did not start: ${String(err)}`));
    trips.set(visit, tripId);
    return tripId;
  };

  const stateFor = (visit: string, tripId: string) => ({
    ...roomState(o.fake, tripId),
    about: [health.ok ? goLiveLine(health.contract) : GO_DOWN_LINE, simulatedLine],
    limit: caps.line(visit),
  });

  const send = (ws: WebSocket, message: object): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  };

  /** The room's state to one socket. A visit with no trip (today's trip cap) got the limit line when it connected. */
  const push = (ws: WebSocket): void => {
    const visit = sockets.get(ws);
    const tripId = visit ? trips.get(visit) : undefined;
    if (visit && tripId) send(ws, stateFor(visit, tripId));
  };
  const pushAll = (visit?: string): void => {
    for (const [ws, v] of sockets) if (!visit || v === visit) push(ws);
  };

  const act = async (ws: WebSocket, visit: string, endsAt: number, text: string): Promise<void> => {
    // A socket opened with a good cookie stops when the cookie runs out: the page then goes back to the passcode.
    if (now().getTime() > endsAt) return void ws.close(4401, 'signed out');
    let a: PageAction;
    try {
      a = JSON.parse(text) as PageAction;
    } catch {
      return;
    }
    if (typeof a !== 'object' || a === null) return;
    const reply = (message: object): void => send(ws, message);
    try {
      if (a.type === 'start_over') {
        if (!startTrip(visit)) return reply({ type: 'limit', text: DAILY_LIMIT_LINE });
        return pushAll(visit);
      }
      const tripId = trips.get(visit);
      if (!tripId) return reply({ type: 'limit', text: DAILY_LIMIT_LINE });
      const refused = refusal(o.fake, tripId, a);
      if (refused) return reply({ type: 'error', message: refused });
      // Counted before it reaches Go; over a cap nothing reaches Go.
      const verdict = caps.send(visit, a.type === 'say' && asksGo(a.text));
      if (!verdict.ok) {
        reply({ type: 'limit', text: verdict.line });
        return pushAll(visit);
      }
      await doAction(o.fake, tripId, a, reply);
    } catch (err) {
      reply({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const html = (req: IncomingMessage, res: ServerResponse, status: number, body: string, nonce: string | null, extra: Record<string, string> = {}): void => {
    res.writeHead(status, {
      ...PAGE_HEADERS,
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': contentSecurityPolicy(nonce, req.headers.host),
      ...extra,
    });
    res.end(body);
  };
  const plain = (res: ServerResponse, status: number, type: string, body: string): void => {
    res.writeHead(status, { ...PAGE_HEADERS, 'content-type': type, 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" });
    res.end(body);
  };

  /** POST /enter: the passcode, as the form sends it. The right one gets the visit cookie and goes to the room. */
  const enter = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const address = clientAddress(req, o.trustProxy ?? false);
    if (wrongTries.blocked(address)) return html(req, res, 429, passcodePage(TOO_MANY_TRIES), null, { 'retry-after': '60' });
    const body = await readBody(req, 2048);
    const given = new URLSearchParams(body ?? '').get('passcode') ?? '';
    if (!gate.matches(given)) {
      wrongTries.wrong(address);
      return html(req, res, 401, passcodePage(WRONG_PASSCODE), null);
    }
    res.writeHead(303, { ...PAGE_HEADERS, location: '/', 'set-cookie': gate.newVisit().setCookie });
    res.end();
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '/').split('?')[0];
    // Open, for Railway's health check: it says nothing about any visit.
    if (req.method === 'GET' && path === '/health') return plain(res, 200, 'application/json', JSON.stringify({ ok: true, go_connected: o.fake.isOpen() }));
    if (req.method === 'POST' && path === '/enter') return enter(req, res);
    if (req.method === 'GET' && path === '/') {
      if (!gate.visit(req)) return html(req, res, 200, passcodePage(), null);
      const nonce = randomBytes(16).toString('base64');
      return html(req, res, 200, roomPage({ title: 'Try Go', nonce, hints: HINTS, hosted: true }), nonce);
    }
    return plain(res, 404, 'text/plain; charset=utf-8', 'Not found');
  };

  const http = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log(`a request failed: ${String(err)}`);
      if (!res.headersSent) plain(res, 500, 'text/plain; charset=utf-8', 'Something went wrong.');
      else res.end();
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if ((req.url ?? '').split('?')[0] !== '/live') return refuseUpgrade(socket, 404);
    const signedIn = gate.visit(req);
    if (!signedIn || !sameOrigin(req)) return refuseUpgrade(socket, 401);
    const visit = signedIn.id;
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.set(ws, visit);
      ws.on('close', () => sockets.delete(ws));
      ws.on('error', () => {});
      ws.on('message', (data) => void act(ws, visit, signedIn.endsAt, data.toString()));
      if (!trips.has(visit) && !startTrip(visit)) send(ws, { type: 'limit', text: DAILY_LIMIT_LINE });
      else push(ws);
    });
  });

  let queued = false;
  const off = o.fake.onChange(() => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      pushAll();
    }, 30); // a burst of changes is one update
  });
  // A redraw every second as well, so "Go is typing..." goes away when it runs out.
  const tick = setInterval(() => pushAll(), 1000);
  const healthTimer = setInterval(() => void refreshHealth(), HEALTH_EVERY_MS);
  await refreshHealth();

  await new Promise<void>((resolve) => http.listen(o.port, o.host ?? '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    url: `http://${o.host ?? '127.0.0.1'}:${port}/`,
    caps,
    tripOf: (visit) => trips.get(visit),
    close: async () => {
      off();
      clearInterval(tick);
      clearInterval(healthTimer);
      for (const ws of sockets.keys()) ws.terminate();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
