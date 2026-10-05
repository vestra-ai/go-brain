// The fake Go: Go's side of the socket, so the Server team can build against it before the real Go is ready.
// It checks the signature before the upgrade completes, pings every 20 seconds, closes a socket silent for 40,
// answers send_event (unknown types before any check, repeats as duplicates), and hands everything else to
// the behaviour (Task 4). GET /v1/health is open; GET /frames needs FAKE_GO_ADMIN_TOKEN.
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  CONTRACT_VERSION, Event, IDLE_CLOSE_SECONDS, MAX_FRAME_BYTES, PING_INTERVAL_SECONDS, SIGNATURE_HEADER, SOCKET_PATH, TO_GO, parseParams,
} from '@go/contract';
import { SocketCallError } from '@go/sim';
import { FrameLog, renderFrames } from './frames.js';
import { Link } from './link.js';
import { SignatureGuard } from './signature-guard.js';

/** Answers one of the Server's requests other than send_event. Throw SocketCallError to answer with an error. */
export type ToGoHandler = (params: any, meta: { instance: string }) => Promise<object>;

/** What the fake Go does on top of the socket: its answers, and its work after an event. */
export interface Behaviour {
  handlers: Partial<Record<string, ToGoHandler>>;
  /**
   * Runs after Go has answered a new event of a known type. Never for a repeat. `from` is the socket the event
   * came on: Go sends its requests about the event back on that socket.
   */
  onEvent?: (event: Event, from: WebSocket) => void | Promise<void>;
}

export interface FakeGoOptions {
  secret: string;
  adminToken: string;
  behaviour?: (link: Link) => Behaviour;
  now?: () => Date;
  /** For tests. The defaults are the contract's 20 second ping and 40 second silence limit. */
  pingIntervalMs?: number;
  idleCloseMs?: number;
  log?: (line: string) => void;
}

export interface FakeGo {
  app: FastifyInstance;
  link: Link;
  frames: FrameLog;
  close(): Promise<void>;
}

export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(Event.options.map((o) => o.shape.type.value));
const TO_GO_METHODS: ReadonlySet<string> = new Set(TO_GO.map((m) => m.name));
const SEEN_EVENTS_KEPT = 100_000;

export function buildFakeGo(opts: FakeGoOptions): FakeGo {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const frames = new FrameLog(200, now);
  const guard = new SignatureGuard(opts.secret);
  const link = new Link(frames);
  const behaviour: Behaviour = opts.behaviour ? opts.behaviour(link) : { handlers: {} };
  const seenEvents = new Set<string>();
  const app = Fastify({ logger: false });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  app.get('/v1/health', async () => ({ ok: true as const, contract: CONTRACT_VERSION }));

  // People's messages travel in the frames, so the page needs the admin token.
  app.get<{ Querystring: { token?: string } }>('/frames', async (req, reply) => {
    if (!sameToken(req.query.token ?? '', opts.adminToken)) {
      return reply.code(401).send({ error: { code: 'bad_signature', message: 'wrong or missing token' } });
    }
    return reply.type('text/html; charset=utf-8').send(renderFrames(frames.list()));
  });

  // Where the fake Go's watch and vault links land.
  app.get<{ Params: { kind: string } }>('/fake/page/:kind', async (req, reply) => {
    const what = req.params.kind === 'vault' ? 'the vault page, where the payer confirms with Face ID' : "the trip's computer at work, live";
    return reply.type('text/html; charset=utf-8').send(fakePage(what));
  });

  const remember = (eventId: string): void => {
    seenEvents.add(eventId);
    if (seenEvents.size > SEEN_EVENTS_KEPT) seenEvents.delete(seenEvents.values().next().value as string);
  };

  const sendEvent = (params: unknown, from: WebSocket): { accepted: true; duplicate: boolean } => {
    const p = (typeof params === 'object' && params !== null ? params : {}) as { type?: unknown; event_id?: unknown };
    const eventId = typeof p.event_id === 'string' ? p.event_id : undefined;
    // A type Go does not know is accepted before anything else is checked: the Server may add types within version 1.
    if (typeof p.type === 'string' && !KNOWN_EVENT_TYPES.has(p.type)) {
      const duplicate = eventId !== undefined && seenEvents.has(eventId);
      if (eventId !== undefined) remember(eventId);
      return { accepted: true, duplicate };
    }
    const check = parseParams('send_event', params);
    if (!check.ok) throw new SocketCallError(422, check.message, 'invalid');
    const event = check.params as Event;
    if (seenEvents.has(event.event_id)) return { accepted: true, duplicate: true };
    remember(event.event_id);
    // Answer first; the work happens after.
    setImmediate(() => {
      Promise.resolve()
        .then(() => behaviour.onEvent?.(event, from))
        .catch((err: unknown) => log(`work after ${event.type} failed: ${String(err)}`));
    });
    return { accepted: true, duplicate: false };
  };

  const callHandler = async (method: string, params: unknown, instance: string): Promise<object> => {
    const handler = TO_GO_METHODS.has(method) ? behaviour.handlers[method] : undefined;
    if (!handler) throw new SocketCallError(-32601, `unknown method ${method}`);
    const check = parseParams(method, params);
    if (!check.ok) throw new SocketCallError(check.code, check.message, check.code === 422 ? 'invalid' : undefined);
    return handler(check.params, { instance });
  };

  const onText = async (ws: WebSocket, instance: string, text: string): Promise<void> => {
    frames.add('in', instance, text);
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      frame = undefined;
    }
    if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
      link.send(ws, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'cannot read the frame' } });
      return;
    }
    const f = frame as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
    if (typeof f.method !== 'string') return link.settle(f, instance); // the answer to one of Go's requests
    if (f.id === undefined) return; // the Server sends no notifications; a stray one gets no answer
    const id = f.id;
    try {
      const result = f.method === 'send_event' ? sendEvent(f.params, ws) : await callHandler(f.method, f.params, instance);
      link.send(ws, { jsonrpc: '2.0', id, result });
    } catch (err) {
      link.send(ws, { jsonrpc: '2.0', id, error: errorOf(err) });
    }
  };

  const onSocket = (ws: WebSocket, instance: string): void => {
    log(`socket open: ${instance}`);
    link.attach(ws, instance);
    const idleMs = opts.idleCloseMs ?? IDLE_CLOSE_SECONDS * 1000;
    let idle: NodeJS.Timeout | undefined;
    const heard = (): void => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        log(`closing a silent socket: ${instance}`);
        ws.terminate();
      }, idleMs);
    };
    heard();
    const ping = setInterval(() => ws.ping(), opts.pingIntervalMs ?? PING_INTERVAL_SECONDS * 1000);
    ws.on('pong', heard);
    ws.on('ping', heard);
    ws.on('message', (data) => {
      heard();
      void onText(ws, instance, data.toString());
    });
    ws.on('error', () => {}); // 'close' follows
    ws.on('close', () => {
      clearTimeout(idle);
      clearInterval(ping);
      link.detach(ws);
      log(`socket closed: ${instance}`);
    });
  };

  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const target = req.url ?? '';
    const url = new URL(target, 'http://fake-go.local');
    if (url.pathname !== SOCKET_PATH) return refuse(socket, 404, 'not_found', 'no socket here: use /v1/socket');
    // Checked before the upgrade completes: a refused socket never opens.
    const check = guard.check(req.headers[SIGNATURE_HEADER], target, Math.floor(now().getTime() / 1000));
    if (!check.ok) {
      log(`refused a socket (${check.reason})`);
      return refuse(socket, 401, 'bad_signature', check.message);
    }
    wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, url.searchParams.get('instance') ?? 'default'));
  });

  return {
    app,
    link,
    frames,
    close: async () => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      await app.close();
    },
  };
}

/** Refuses an upgrade with a plain HTTP answer and the contract's ErrorBody. */
function refuse(socket: Duplex, status: 401 | 404, code: 'bad_signature' | 'not_found', message: string): void {
  const body = JSON.stringify({ error: { code, message } });
  socket.end(
    `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Not Found'}\r\n` +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n\r\n' +
      body,
  );
}

function errorOf(err: unknown): object {
  const e = err instanceof SocketCallError ? err : new SocketCallError(500, 'internal error', 'internal');
  const data = e.dataCode
    ? { data: { code: e.dataCode, ...(e.retryAfterSeconds !== undefined ? { retry_after_seconds: e.retryAfterSeconds } : {}) } }
    : {};
  return { code: e.code, message: e.message.slice(0, 500), ...data };
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function fakePage(what: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The fake Go</title>
<style>
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f8fafc; color: #0f172a; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 24px; box-sizing: border-box; }
main { max-width: 420px; text-align: center; line-height: 1.5; }
.go { width: 56px; height: 56px; border-radius: 50%; background: #38bdf8; color: #fff; display: grid; place-items: center; font-weight: 700; margin: 0 auto 16px; }
</style>
</head>
<body>
<main>
<div class="go">Go</div>
<h1>This is the fake Go</h1>
<p>The real Go shows ${what} here. This link opened, so the App opens Go's links the right way.</p>
</main>
</body>
</html>`;
}
