import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import * as C from '@go/contract';
import type { FastifyInstance } from 'fastify';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { z } from 'zod';
import type { Log } from '../log.js';
import type { Door, SocketFrom, ToGoHandler, UpgradeHandler } from './handlers.js';
import { KNOWN_EVENT_TYPES, TO_GO_SCHEMAS, type ToGoMethod } from './methods.js';
import type { ReplayGuard } from './replay-guard.js';
import { errorFrame, readFrame, resultFrame, SocketCallError, type RequestFrame } from './rpc.js';
import type { ServerLinkImpl, SocketHandle } from './server-link.js';

export interface DoorOptions {
  http: FastifyInstance;
  secret: string;
  guard: ReplayGuard;
  link: ServerLinkImpl;
  log: Log;
  now: () => Date;
  pingMs?: number;
  idleMs?: number;
}

export type DoorImpl = Door & { close(): void; openSockets(): number };

class TooSlow extends Error {}

const STATUS_TEXT: Record<number, string> = { 401: 'Unauthorized', 404: 'Not Found', 503: 'Service Unavailable' };

/** Refuses an upgrade with the contract's ErrorBody; the socket never opens. */
export function refuse(socket: Duplex, status: number, code: z.infer<typeof C.ErrorCode>, message: string): void {
  const body = JSON.stringify({ error: { code, message } } satisfies C.ErrorBody);
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

export function signatureParts(header: string): { t: number; v1: string } | null {
  const fields = new Map<string, string>();
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i > 0) fields.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  const t = Number(fields.get('t'));
  const v1 = fields.get('v1') ?? '';
  return Number.isInteger(t) && v1 ? { t, v1 } : null;
}

function withLimit<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const slow = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TooSlow()), ms);
  });
  return Promise.race([p, slow]).finally(() => clearTimeout(timer));
}

function textOf(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function send(ws: WebSocket, frame: string): void {
  if (ws.readyState === ws.OPEN) ws.send(frame);
}

export function createDoor(o: DoorOptions): DoorImpl {
  const pingMs = o.pingMs ?? C.PING_INTERVAL_SECONDS * 1_000;
  const idleMs = o.idleMs ?? C.IDLE_CLOSE_SECONDS * 1_000;
  const handlers = new Map<string, ToGoHandler<ToGoMethod>>();
  const laneUpgrades: Array<{ path: RegExp; handle: UpgradeHandler }> = [];
  const open = new Map<string, WebSocket>();
  const recent = new Map<string, Promise<string>>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: C.MAX_FRAME_BYTES });

  o.http.get('/v1/health', async () => ({ ok: true as const, contract: C.CONTRACT_VERSION }));
  o.http.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void onUpgrade(req, socket, head);
  });

  async function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on('error', () => socket.destroy());
    try {
      const target = req.url ?? '';
      // A lane's own path (P6's media stream) goes to its handler, which checks its own auth. The Server's socket
      // can never be one of these (onUpgrade refuses such a path), so the signature rule below always holds for it.
      const lanePath = target.split('?')[0] ?? '';
      const lane = laneUpgrades.find((u) => u.path.test(lanePath));
      if (lane) {
        lane.handle(req, socket, head);
        return;
      }
      if (target.split('?')[0] !== C.SOCKET_PATH) {
        refuse(socket, 404, 'not_found', 'no such socket');
        return;
      }
      const raw = req.headers[C.SIGNATURE_HEADER];
      const header = Array.isArray(raw) ? raw[0] : raw;
      // The signature covers the path and query exactly as sent.
      const checked = C.verifyRequest({ method: 'GET', target, body: '' }, header, o.secret, Math.floor(o.now().getTime() / 1_000));
      if (!checked.ok) {
        refuse(socket, 401, 'bad_signature', `signature ${checked.reason}`);
        return;
      }
      const parts = signatureParts(header ?? '');
      if (!parts || !(await o.guard.claim(parts.t, parts.v1))) {
        refuse(socket, 401, 'bad_signature', 'signature already used');
        return;
      }
      const query = new URL(target, 'http://go.local').searchParams;
      // instance names this replica; server, the same on every replica of one Server, keys a person's browser
      // (tasks/browsers.ts) and lets another replica take a trip's requests (server-link.ts).
      const instance = query.get('instance') ?? 'default';
      const server = query.get('server');
      const from: SocketFrom = server ? { instance, server } : { instance };
      wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, from));
    } catch (e) {
      o.log.error({ err: e }, 'the socket upgrade failed');
      refuse(socket, 503, 'unavailable', 'try again in a moment');
    }
  }

  function onSocket(ws: WebSocket, from: SocketFrom): void {
    const { instance, server } = from;
    const id = `sock_${randomUUID()}`;
    let heardAt = Date.now();
    const heard = (): void => {
      heardAt = Date.now();
    };
    const handle: SocketHandle = { id, instance, ...(server ? { server } : {}), send: (frame) => send(ws, frame) };
    open.set(id, ws);
    o.link.attach(handle);
    o.log.info({ instance, server, socket: id }, 'the Server connected');
    // Go pings every 20 s and closes a socket that has been silent for 40 s.
    const ping = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.ping();
    }, pingMs);
    const idle = setInterval(() => {
      if (Date.now() - heardAt > idleMs) ws.terminate();
    }, Math.max(10, Math.min(5_000, Math.floor(idleMs / 4))));
    ws.on('ping', heard);
    ws.on('pong', heard);
    ws.on('message', (data: RawData, isBinary: boolean) => {
      heard();
      if (isBinary) {
        send(ws, errorFrame(null, C.SOCKET_ERROR_CODES.parse_error, 'frames are JSON text'));
        return;
      }
      void onText(ws, from, textOf(data)).catch((e: unknown) => o.log.error({ err: e }, 'a frame failed'));
    });
    ws.on('close', () => {
      clearInterval(ping);
      clearInterval(idle);
      open.delete(id);
      o.link.detach(id);
      o.log.info({ instance, socket: id }, 'the Server disconnected');
    });
    ws.on('error', (e) => o.log.warn({ err: e, socket: id }, 'socket error'));
  }

  async function onText(ws: WebSocket, from: SocketFrom, text: string): Promise<void> {
    const f = readFrame(text);
    if (f.kind === 'unreadable') {
      send(ws, errorFrame(null, C.SOCKET_ERROR_CODES.parse_error, `unreadable frame: ${f.reason}`));
      return;
    }
    if (f.kind === 'notification') return; // the Server sends no notifications in version 1
    if (f.kind === 'result' || f.kind === 'error') {
      o.link.onAnswer(f);
      return;
    }
    send(ws, await answerOnce(f, from));
  }

  /** One answer per request. The same id with the same content again gets the same answer; the handler runs once. */
  function answerOnce(f: RequestFrame, from: SocketFrom): Promise<string> {
    const key = createHash('sha1').update(`${f.id}\n${f.method}\n${JSON.stringify(f.params ?? null)}`).digest('hex');
    const hit = recent.get(key);
    if (hit) return hit;
    const answer = compute(f, from);
    recent.set(key, answer);
    setTimeout(() => recent.delete(key), 5 * 60_000).unref();
    return answer;
  }

  async function compute(f: RequestFrame, from: SocketFrom): Promise<string> {
    const def = C.methodByName(f.method);
    if (!def || def.direction !== 'to_go') return errorFrame(f.id, C.SOCKET_ERROR_CODES.unknown_method, `unknown method ${f.method}`);
    const handler = handlers.get(f.method);
    if (!handler) return errorFrame(f.id, C.SOCKET_ERROR_CODES.unknown_method, `Go does not handle ${f.method} yet`);
    // An event type Go does not know yet is accepted before any check, so the Server can add types within version 1.
    if (f.method === 'send_event') {
      const type = typeof f.params === 'object' && f.params !== null ? (f.params as { type?: unknown }).type : undefined;
      if (typeof type === 'string' && !KNOWN_EVENT_TYPES.has(type)) return resultFrame(f.id, { accepted: true, duplicate: false });
    }
    const parsed = C.parseParams(f.method, f.params);
    if (!parsed.ok) return errorFrame(f.id, parsed.code, parsed.message);
    try {
      const result = await withLimit(handler(parsed.params as never, { ...from, frameId: f.id }), (def.answer_within ?? 2) * 1_000 - 200);
      const checked = (TO_GO_SCHEMAS[f.method as ToGoMethod][1] as z.ZodType).safeParse(result);
      if (!checked.success) {
        o.log.error({ method: f.method }, 'Go built an answer outside the contract');
        return errorFrame(f.id, C.SOCKET_ERROR_CODES.internal, `Go built a bad ${f.method} answer`);
      }
      return resultFrame(f.id, checked.data);
    } catch (e) {
      if (e instanceof SocketCallError) return errorFrame(f.id, e.code, e.message, e.retryAfterSeconds);
      if (e instanceof TooSlow) return errorFrame(f.id, C.SOCKET_ERROR_CODES.unavailable, `Go took too long on ${f.method}`);
      o.log.error({ err: e, method: f.method }, 'a request handler failed');
      return errorFrame(f.id, C.SOCKET_ERROR_CODES.internal, 'Go failed on this request');
    }
  }

  return {
    link: o.link,
    handle<M extends ToGoMethod>(method: M, handler: ToGoHandler<M>): void {
      if (handlers.has(method)) throw new Error(`${method} already has a handler`);
      handlers.set(method, handler as unknown as ToGoHandler<ToGoMethod>);
    },
    onUpgrade(path: RegExp, handle: UpgradeHandler): void {
      // A global or sticky pattern keeps state between test() calls; a path is matched fresh every time.
      const fresh = new RegExp(path.source, path.flags.replace(/[gy]/g, ''));
      if (fresh.test(C.SOCKET_PATH)) throw new Error(`${path} would take ${C.SOCKET_PATH}, which is the Server's socket`);
      laneUpgrades.push({ path: fresh, handle });
    },
    close() {
      for (const ws of open.values()) ws.terminate();
      wss.close();
    },
    openSockets: () => open.size,
  };
}
