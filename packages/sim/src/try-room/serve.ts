// serveTryRoom: the hosted "try Go" room, for a judge to chat with the real Go in two minutes. It plays the Server: the
// FakeServer signs its socket to Go with GO_SIGNING_SECRET, here on the server side, and never in the browser. It
// serves the dev room's page behind a passcode, gives each visit its own fresh Goa trip with the five friends (made by
// its first message, so opening the room costs nothing), lets "Start over" begin a new one, and holds everything to the
// caps in caps.ts so visitors cannot run up a bill. It also
// keeps itself small: a few sockets for each visit, a few frames a second on each, and idle trips dropped.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { TripSnapshot } from '@go/contract';
import { WebSocketServer, type WebSocket } from 'ws';
import { roomPage } from '../dev-room/page.js';
import { doAction, roomState, type Action } from '../dev-room/serve.js';
import type { FakeServer } from '../fake-server.js';
import { goaFreshTrip } from '../goa.js';
import { Caps, DEFAULT_CAPS, type CapLimits } from './caps.js';
import { Gate, PAGE_HEADERS, WrongTries, clientAddress, contentSecurityPolicy, passcodePage } from './gate.js';
import {
  GO_DOWN_LINE, HINTS, NOT_IN_YOUR_TRIP, PICK_A_PERSON, ROOM_FULL, SAY_FIRST, SIMULATED_LINE, SLOW_DOWN, TOO_LONG, TOO_MANY_TRIES,
  TYPE_SOMETHING, UNKNOWN_ACTION, WRONG_PASSCODE, goLiveLine, tooManyTabs,
} from './words.js';

/** The longest message a visitor can send. */
export const MAX_TEXT = 1000;
/** The page stops reconnecting on this close code: the room said why just before. */
export const CLOSE_TOO_MANY = 4429;
const HEALTH_EVERY_MS = 30_000;
const SWEEP_EVERY_MS = 10 * 60_000;
const PRUNE_TRIES_EVERY_MS = 60_000;
const RECORDS_KEPT_PER_TRIP = 200;

/** What can wake Go's model: anything said, a vote, a card tap, the payer's yes or no. A reaction or "Forget me" cannot. */
const WAKES_GO: ReadonlySet<string> = new Set(['say', 'vote', 'tap', 'confirm', 'decline']);

export interface GoHealth {
  ok: boolean;
  contract: string | null;
}

export interface TryRoomOptions {
  fake: FakeServer;
  passcode: string;
  /** TRY_COOKIE_SALT: random, kept secret. The visit cookie's key is made from it and the passcode. */
  cookieSalt: string;
  /** Go's base URL. The page says whether Go is live from its /v1/health. */
  goUrl: string;
  /** 0 picks a free port. */
  port: number;
  /** Default 127.0.0.1. Use 0.0.0.0 on Railway. */
  host?: string;
  caps?: Partial<CapLimits>;
  /** What is simulated in this demo. Default SIMULATED_LINE. */
  simulatedLine?: string;
  /** Behind Railway's proxy: the visitor's address comes from x-real-ip, or else the first x-forwarded-for address. */
  trustProxy?: boolean;
  /** Live sockets for one visit (default 3) and in all (default 300). */
  maxSocketsPerVisit?: number;
  maxSockets?: number;
  /** Frames a second a socket may send (default 5); faster ones are dropped. */
  framesPerSecond?: number;
  /** How long a wrong try waits once its address made 5 in a minute (default 2000 ms). */
  wrongTryDelayMs?: number;
  /** Wrong tries a second across every address before each is turned away at once (default 30). */
  wrongTriesPerSecond?: number;
  /** A trip nobody has used or watched for this long is dropped (default 6 hours). */
  idleTripMs?: number;
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
  /** Drops idle trips and old records now. It also runs every 10 minutes. */
  sweep(): void;
  close(): Promise<void>;
}

type PageAction = Action | { type: 'start_over' };

/**
 * A fresh Goa trip for one visit. Its five people keep their names but get ids of their own (p_rahul_<suffix>), so
 * nothing Go learns about a person in one visit's trip can carry over to another visit's.
 */
export function visitTrip(tripId: string, suffix: string): TripSnapshot {
  const fresh = goaFreshTrip();
  const ids = new Set(fresh.people.map((p) => p.person_id));
  const text = JSON.stringify({ ...fresh, trip_id: tripId }, (_key, value: unknown) =>
    typeof value === 'string' && ids.has(value) ? `${value}_${suffix}` : value,
  );
  return JSON.parse(text) as TripSnapshot;
}

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

/** About `perSecond` frames a second, with a burst of as many: true when one more may go through. */
function frameBudget(perSecond: number, now: () => Date): () => boolean {
  let tokens = perSecond;
  let at = now().getTime();
  return () => {
    const t = now().getTime();
    tokens = Math.min(perSecond, tokens + ((t - at) / 1000) * perSecond);
    at = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

/**
 * Why the room refuses an action before it is counted, or null. Everything it names must be in the visit's own trip.
 * The checks copy nothing, so a refused action costs little.
 */
export function refusal(fake: FakeServer, tripId: string, a: Action): string | null {
  const isPerson = (id: unknown): boolean => typeof id === 'string' && fake.has(tripId, { person: id });
  switch (a.type) {
    case 'say':
      return sayRefusal(isPerson, a);
    case 'tap':
      return isPerson(a.personId) && typeof a.cardId === 'string' && fake.has(tripId, { card: a.cardId }) ? null : NOT_IN_YOUR_TRIP;
    case 'react':
      return isPerson(a.personId) && typeof a.emoji === 'string' && a.emoji.length <= 16 && typeof a.messageId === 'string' &&
        fake.has(tripId, { message: a.messageId })
        ? null
        : NOT_IN_YOUR_TRIP;
    case 'vote':
      return isPerson(a.personId) && typeof a.decisionId === 'string' && fake.has(tripId, { decision: a.decisionId }) ? null : NOT_IN_YOUR_TRIP;
    case 'confirm':
    case 'decline':
      return typeof a.decisionId === 'string' && fake.has(tripId, { decision: a.decisionId }) ? null : NOT_IN_YOUR_TRIP;
    case 'forget':
      return isPerson(a.personId) ? null : NOT_IN_YOUR_TRIP;
    default:
      return UNKNOWN_ACTION;
  }
}

/** Why a message is refused before it is counted, or null. */
function sayRefusal(isPerson: (id: unknown) => boolean, a: Extract<Action, { type: 'say' }>): string | null {
  if (!isPerson(a.personId)) return PICK_A_PERSON;
  if (typeof a.text !== 'string' || !a.text.trim()) return TYPE_SOMETHING;
  return a.text.length > MAX_TEXT ? TOO_LONG(MAX_TEXT) : null;
}

export async function serveTryRoom(o: TryRoomOptions): Promise<TryRoom> {
  const now = o.now ?? (() => new Date());
  const log = o.log ?? (() => {});
  const gate = new Gate(o.passcode, o.cookieSalt, now);
  const wrongTries = new WrongTries(now, undefined, undefined, undefined, o.wrongTriesPerSecond ?? 30);
  const caps = new Caps({ ...DEFAULT_CAPS, ...o.caps }, now);
  const simulatedLine = o.simulatedLine ?? SIMULATED_LINE;
  const goHealth = o.goHealth ?? (() => fetchGoHealth(o.goUrl));
  const maxPerVisit = o.maxSocketsPerVisit ?? 3;
  const maxSockets = o.maxSockets ?? 300;
  const framesPerSecond = o.framesPerSecond ?? 5;
  const idleTripMs = o.idleTripMs ?? 6 * 60 * 60_000;
  /** Each visit's trip, once its first message made one. */
  const trips = new Map<string, string>();
  /**
   * The trip a visit will get, shown to it until its first message makes it real. Opening the room costs nothing:
   * no trip and no turn until someone says something. Only visits with an open socket have one.
   */
  const pending = new Map<string, TripSnapshot>();
  /** When each trip the room made was last used. */
  const activity = new Map<string, number>();
  /** Each open live socket's visit. */
  const sockets = new Map<WebSocket, string>();
  let health: GoHealth = { ok: false, contract: null };
  let sourceLogged = false;

  const refreshHealth = async (): Promise<void> => {
    health = await goHealth();
  };

  /** The trip the visit will get: the one it has been shown, or a fresh Goa trip with the five friends. */
  const pendingFor = (visit: string): TripSnapshot => {
    let trip = pending.get(visit);
    if (!trip) {
      const suffix = randomBytes(6).toString('hex');
      trip = visitTrip(`t_try_${suffix}`, suffix);
      pending.set(visit, trip);
    }
    return trip;
  };

  /** Makes the visit's trip real, if its turns allow: Go greets a new trip. Returns the refusal's line otherwise. */
  const startTrip = (visit: string): { tripId: string } | { line: string } => {
    const verdict = caps.newTrip(visit);
    if (!verdict.ok) return { line: verdict.line };
    const trip = pendingFor(visit);
    pending.delete(visit);
    // createTrip adds the trip at once and then tells Go (trip.created); the page can draw it straight away.
    void o.fake.createTrip(trip).catch((err: unknown) => log(`trip ${trip.trip_id} did not start: ${String(err)}`));
    trips.set(visit, trip.trip_id);
    activity.set(trip.trip_id, now().getTime());
    return { tripId: trip.trip_id };
  };

  const send = (ws: WebSocket, message: object): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  };

  const about = (): string[] => [health.ok ? goLiveLine(health.contract) : GO_DOWN_LINE, simulatedLine];

  /** What a visit sees before its first message: its trip-to-be, with nobody's needs and no messages. */
  const preview = (visit: string) => {
    const trip = pendingFor(visit);
    return {
      type: 'state' as const, connected: o.fake.isOpen(), trip, messages: [], typing: false,
      needs: Object.fromEntries(trip.people.map((p) => [p.person_id, []])), about: about(), limit: caps.line(visit),
    };
  };

  /**
   * The room's state to every socket of a visit (every visit when none is named). Worked out once for each trip, or
   * each trip-to-be: a trip belongs to one visit, so every socket on it sees the same thing.
   */
  const pushAll = (only?: string): void => {
    const frames = new Map<string, string>();
    for (const [ws, visit] of sockets) {
      if ((only !== undefined && visit !== only) || ws.readyState !== ws.OPEN) continue;
      const tripId = trips.get(visit);
      const key = tripId ?? `pending:${visit}`;
      let frame = frames.get(key);
      if (frame === undefined) {
        frame = JSON.stringify(
          tripId && o.fake.has(tripId, {}) ? { ...roomState(o.fake, tripId), about: about(), limit: caps.line(visit) } : preview(visit),
        );
        frames.set(key, frame);
      }
      ws.send(frame);
    }
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
        // A fresh trip-to-be: it costs nothing until someone says something in it.
        trips.delete(visit);
        pending.delete(visit);
        return pushAll(visit);
      }
      let tripId = trips.get(visit);
      if (!tripId) {
        // The first message makes the trip; nothing else can happen in a trip that does not exist yet.
        if (a.type !== 'say') return reply({ type: 'error', message: SAY_FIRST });
        const people = pendingFor(visit).people;
        const refusedFirst = sayRefusal((id) => people.some((p) => p.person_id === id), a);
        if (refusedFirst) return reply({ type: 'error', message: refusedFirst });
        // Over a cap now, no trip is made for a message that could not be sent.
        const capped = caps.line(visit);
        const started = capped ? { line: capped } : startTrip(visit);
        if ('line' in started) {
          reply({ type: 'limit', text: started.line });
          return pushAll(visit);
        }
        tripId = started.tripId;
      }
      const refused = refusal(o.fake, tripId, a);
      if (refused) return reply({ type: 'error', message: refused });
      // Counted before it reaches Go; over a cap nothing reaches Go.
      const verdict = caps.send(visit, WAKES_GO.has(a.type));
      if (!verdict.ok) {
        reply({ type: 'limit', text: verdict.line });
        return pushAll(visit);
      }
      activity.set(tripId, now().getTime());
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

  /**
   * POST /enter: the passcode, as the form sends it. The right one always gets the visit cookie, at once. A wrong one
   * from an address that made 5 wrong tries in the last minute waits a moment before it is turned away, and in a flood
   * of wrong tries from everywhere it is turned away at once.
   */
  const enter = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { address, source } = clientAddress(req, o.trustProxy ?? false);
    const body = await readBody(req, 2048);
    const given = new URLSearchParams(body ?? '').get('passcode') ?? '';
    if (gate.matches(given)) {
      if (!sourceLogged) {
        sourceLogged = true;
        log(`the first passcode that got in: its wrong-try key came from ${source === 'x-real-ip' ? 'x-real-ip' : "the socket's own address"}`);
      }
      res.writeHead(303, { ...PAGE_HEADERS, location: '/', 'set-cookie': gate.newVisit().setCookie });
      res.end();
      return;
    }
    const verdict = wrongTries.wrong(address);
    if (verdict === 'wrong') return html(req, res, 401, passcodePage(WRONG_PASSCODE), null);
    if (verdict === 'slow') await new Promise((resolve) => setTimeout(resolve, o.wrongTryDelayMs ?? 2000));
    return html(req, res, 429, passcodePage(TOO_MANY_TRIES), null, { 'retry-after': '60' });
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
      ws.on('error', () => {});
      const open = [...sockets.values()].filter((v) => v === visit).length;
      if (sockets.size >= maxSockets || open >= maxPerVisit) {
        send(ws, { type: 'limit', text: sockets.size >= maxSockets ? ROOM_FULL : tooManyTabs(maxPerVisit) });
        ws.close(CLOSE_TOO_MANY, 'too many sockets');
        return;
      }
      sockets.set(ws, visit);
      ws.on('close', () => {
        sockets.delete(ws);
        // A trip-to-be is only kept while its visit has a socket open.
        if (![...sockets.values()].includes(visit)) pending.delete(visit);
      });
      const allowed = frameBudget(framesPerSecond, now);
      let warnedAt = Number.NEGATIVE_INFINITY;
      ws.on('message', (data) => {
        if (allowed()) return void act(ws, visit, signedIn.endsAt, data.toString());
        // Dropped. Said once a second at most, so a flood gets no flood back.
        if (now().getTime() - warnedAt < 1000) return;
        warnedAt = now().getTime();
        send(ws, { type: 'error', message: SLOW_DOWN });
      });
      // Opening the room makes no trip and takes no turn: the visit's first message does.
      const tripId = trips.get(visit);
      if (tripId) activity.set(tripId, now().getTime());
      pushAll(visit);
    });
  });

  /** Drops trips nobody has used for idleTripMs and nobody is watching, and old records of the rest. */
  const sweep = (): void => {
    const cutoff = now().getTime() - idleTripMs;
    const watched = new Set([...sockets.values()].map((visit) => trips.get(visit)));
    for (const [tripId, last] of activity) {
      if (last > cutoff || watched.has(tripId)) continue;
      o.fake.forgetTrip(tripId);
      activity.delete(tripId);
      for (const [visit, t] of trips) if (t === tripId) trips.delete(visit);
    }
    const open = new Set(sockets.values());
    for (const visit of pending.keys()) if (!open.has(visit)) pending.delete(visit);
    o.fake.trimRecords(RECORDS_KEPT_PER_TRIP);
  };

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
  const sweepTimer = setInterval(sweep, SWEEP_EVERY_MS);
  const pruneTimer = setInterval(() => wrongTries.prune(), PRUNE_TRIES_EVERY_MS);
  await refreshHealth();

  await new Promise<void>((resolve) => http.listen(o.port, o.host ?? '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    url: `http://${o.host ?? '127.0.0.1'}:${port}/`,
    caps,
    tripOf: (visit) => trips.get(visit),
    sweep,
    close: async () => {
      off();
      clearInterval(tick);
      clearInterval(healthTimer);
      clearInterval(sweepTimer);
      clearInterval(pruneTimer);
      for (const ws of sockets.keys()) ws.terminate();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
