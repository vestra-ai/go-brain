import { MAX_FRAME_BYTES } from '@go/contract';
import type pg from 'pg';
import { z } from 'zod';
import type { Log } from '../log.js';
import { withoutLinks } from './links.js';
import { TO_SERVER_SCHEMAS, type ToServerMethod, type ToServerParams, type ToServerResult } from './methods.js';
import { notificationFrame, requestFrame, SocketCallError, type AnswerFrame, type ErrorCodeName, type ErrorFrame } from './rpc.js';
import { newUlid } from './ulid.js';

export interface ServerLink {
  /** Sends one request on a socket of the trip's own Server; resends after a reconnect with the same id; rejects with SocketCallError. */
  request<M extends ToServerMethod>(
    method: M,
    params: ToServerParams<M>,
    opts?: { timeoutMs?: number; turnId?: string },
  ): Promise<ToServerResult<M>>;
  /** `typing` is the only notification Go sends. */
  notify(method: 'typing', params: ToServerParams<'typing'>): void;
  isOpen(): boolean;
  /**
   * The trip's own Server (its instance, or another replica of the same Server) has had no socket open for longer than
   * INSTANCE_AWAY_MS: a closed drill, a Server gone for good. Background work for the trip (the minute refresh, the
   * proactive sweep) sends nothing then: it would only wait for a socket that is not coming. False for a trip with no
   * instance, or one whose Server has a socket open.
   */
  away?(tripId: string): Promise<boolean>;
}

/** How long a Server instance has no socket open before its trips' background work stops (ServerLink.away). */
export const INSTANCE_AWAY_MS = 10 * 60_000;
// Trip affinity: a request for a trip goes on a socket of the trip's own Server instance (trips.server_instance, the
// instance that first brought its events), and when that instance has none open, on another replica of the same
// Server (trips.server_name, the socket's ?server=), which answers any of its trips from their shared database. Never
// on another Server's socket: several Servers share one Go (the try room, Keshav's room, drills, rehearsals), and one
// never has another's trips (10 Oct: while a drill's Server was frozen, Keshav's trip went to the drill's socket and
// the drill's trips to his room, 404s both ways). A trip whose Server gives no name has only its instance: its
// requests wait for that instance to dial back. A trip with no instance yet takes any open socket.

/** "go_" + ULID. Mint one per new write; a retry reuses it. */
export function newRequestId(): string {
  return `go_${newUlid()}`;
}

/** One open socket to the Server, as the link sees it. The door makes these. */
export interface SocketHandle {
  id: string;
  instance: string;
  /** The Server's own name (?server=), the same on every replica of it; absent when the Server gives none. */
  server?: string;
  send(frame: string): void;
}

/** Where a trip's requests go: its Server instance, and the Server's own name when it gives one. */
interface Home {
  instance: string;
  server: string | null;
}

export interface LinkOptions {
  pool: pg.Pool;
  log: Log;
  now?: () => Date;
  /** The wait for one answer; the Server answers within 2 s. */
  timeoutMs?: number;
  /** The waits before the three retries after a timeout, a 500 or a 503. */
  retryDelaysMs?: readonly number[];
  /** How long one attempt waits for an open socket of the trip's own Server. Go cannot dial the Server, so it can only wait. */
  waitForSocketMs?: number;
  /** How long an instance has no socket before it is away (INSTANCE_AWAY_MS). */
  awayAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Runs after each successful answer; the card store keeps every card Go posts or replaces. `stored` is true for the
   * answer a rerun gets back from go_requests without sending: the card may have changed since, so only mark it landed.
   */
  onResult?: (method: ToServerMethod, params: Record<string, unknown>, result: unknown, stored: boolean) => void | Promise<void>;
  /** Runs before a request first goes out: the card store keeps a card Go posts from that moment, pending. */
  onSend?: (method: ToServerMethod, params: Record<string, unknown>) => void | Promise<void>;
  /**
   * Runs when a request failed for sure: the frame never left Go (no socket, Go shutting down before it was sent) or the
   * Server refused it. Never when it was sent and no answer came (out of retries, Go shutting down mid-flight): the
   * Server may have done it. The card store drops a pending card here; a read of a trip its own instance refused 404 marks
   * the trip gone. `instance` is the Server instance the frame last went to, null when it never left Go.
   */
  onFail?: (method: ToServerMethod, params: Record<string, unknown>, err: unknown, instance: string | null) => void | Promise<void>;
}

export type ServerLinkImpl = ServerLink & {
  away(tripId: string): Promise<boolean>;
  attach(s: SocketHandle): void;
  detach(socketId: string): void;
  onAnswer(f: AnswerFrame): void;
  /** After a restart: sends again every write from the last 10 minutes that never got an answer, with its old id. */
  resumePending(): Promise<number>;
  /** On shutdown: requests waiting for a socket give up at once. */
  close(): void;
};

// Go's own codes for an attempt that ended without an answer. Never sent on the wire.
const TIMEOUT = -1;
const LOST = -2;
const MAX_LOSSES = 5;

interface Pending {
  id: string;
  frame: string;
  /** Where the trip the request names is at home; null for a trip with no instance yet, or a request that names no trip. */
  home: Home | null;
  socketId: string | null;
  /** The instance of the socket the frame last went on. */
  sentTo: string | null;
  settle: ((f: AnswerFrame) => void) | null;
  /** The frame was handed to a socket at least once, in this run or an earlier one, so the Server may have it. */
  sent: boolean;
}

export function createServerLink(o: LinkOptions): ServerLinkImpl {
  const now = o.now ?? (() => new Date());
  const delays = o.retryDelaysMs ?? [500, 2_000, 5_000];
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitForSocketMs = o.waitForSocketMs ?? 15_000;
  const awayAfterMs = o.awayAfterMs ?? INSTANCE_AWAY_MS;
  const sockets = new Map<string, SocketHandle>();
  // Server instance → when a socket of it last closed. Go starting counts as every instance closing.
  const lostAt = new Map<string, number>();
  const startedAt = Date.now();
  // trip_id → its home, as trips.server_instance and trips.server_name say. Both are set once, together, so this copy is
  // never wrong; typing, which goes out at once and in order, reads it here and not from the database.
  const homes = new Map<string, Home>();
  const pending = new Map<string, Pending>();
  const byRequestId = new Map<string, Promise<unknown>>();
  const waiters = new Set<() => void>();
  let rr = 0;
  let closed = false;

  /**
   * The sockets a trip's requests may take: its own instance's (of its own Server, when the Server gives a name: two
   * Servers can both call an instance "default"), else that Server's other replicas'; any for a trip with no home.
   */
  function socketsFor(home: Home | null): SocketHandle[] {
    const all = [...sockets.values()];
    if (home === null) return all;
    const ours = home.server === null ? all : all.filter((s) => s.server === home.server);
    const own = ours.filter((s) => s.instance === home.instance);
    return own.length > 0 || home.server === null ? own : ours;
  }

  /** One of them, taken in turn; null while none is open (the trip's own Server is dialling back). */
  function pick(home: Home | null): SocketHandle | null {
    const from = socketsFor(home);
    if (from.length === 0) return null;
    rr = (rr + 1) % from.length;
    return from[rr] ?? null;
  }

  /** The trip's home as Go recorded it at intake; null for a request that names no trip, or a trip with no instance yet. */
  async function homeOf(tripId: string | null): Promise<Home | null> {
    if (!tripId) return null;
    const known = homes.get(tripId);
    if (known) return known;
    const { rows } = await o.pool.query<{ server_instance: string | null; server_name: string | null }>(
      'select server_instance, server_name from trips where trip_id = $1',
      [tripId],
    );
    const instance = rows[0]?.server_instance ?? null;
    if (!instance) return null;
    const home = { instance, server: rows[0]?.server_name ?? null };
    homes.set(tripId, home);
    return home;
  }

  function waitForSocket(home: Home | null): Promise<SocketHandle> {
    const s = pick(home);
    if (s) return Promise.resolve(s);
    if (closed) return Promise.reject(new SocketCallError(503, 'Go is shutting down', 'unavailable'));
    return new Promise<SocketHandle>((resolve, reject) => {
      const wake = (): void => {
        const next = closed ? null : pick(home);
        if (!next && !closed) return;
        clearTimeout(timer);
        waiters.delete(wake);
        if (next) resolve(next);
        else reject(new SocketCallError(503, 'Go is shutting down', 'unavailable'));
      };
      const timer = setTimeout(() => {
        waiters.delete(wake);
        reject(new SocketCallError(503, 'no socket from the Server is open', 'unavailable'));
      }, waitForSocketMs);
      waiters.add(wake);
    });
  }

  async function attempt(p: Pending, timeoutMs: number): Promise<AnswerFrame> {
    let s: SocketHandle;
    try {
      s = await waitForSocket(p.home);
    } catch (e) {
      return { kind: 'error', id: p.id, error: { code: 503, message: e instanceof Error ? e.message : String(e), dataCode: 'unavailable' } };
    }
    return new Promise<AnswerFrame>((resolve) => {
      const done = (f: AnswerFrame): void => {
        clearTimeout(timer);
        p.settle = null;
        resolve(f);
      };
      const timer = setTimeout(
        () => done({ kind: 'error', id: p.id, error: { code: TIMEOUT, message: `no answer in ${timeoutMs} ms` } }),
        timeoutMs,
      );
      p.settle = done;
      p.socketId = s.id;
      p.sentTo = s.instance;
      p.sent = true;
      s.send(p.frame);
    });
  }

  function parseResult(method: ToServerMethod, raw: unknown): unknown {
    const schema = TO_SERVER_SCHEMAS[method][1] as z.ZodType | null;
    if (!schema) return undefined;
    const r = schema.safeParse(raw);
    if (r.success) return r.data;
    o.log.warn({ method, issues: z.prettifyError(r.error) }, 'the Server answered outside the contract');
    return raw;
  }

  function toCallError(e: ErrorFrame['error']): SocketCallError {
    if (e.code === TIMEOUT) return new SocketCallError(503, e.message, 'unavailable');
    if (e.code === LOST) return new SocketCallError(503, 'the socket kept closing', 'unavailable');
    return new SocketCallError(e.code, e.message, e.dataCode as ErrorCodeName | undefined, e.retryAfterSeconds);
  }

  async function run(
    method: ToServerMethod,
    body: Record<string, unknown>,
    rpcId: string,
    requestId: string | null,
    timeoutMs: number,
    /** An earlier run (before a crash or a restart) already sent this frame, so the Server may have it. */
    sentBefore = false,
  ): Promise<unknown> {
    const frame = requestFrame(rpcId, method, body);
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new SocketCallError(422, `${method} is over the 1 MB frame limit`, 'invalid');
    const tripId = typeof body.trip_id === 'string' && body.trip_id !== '' ? body.trip_id : null;
    const p: Pending = { id: rpcId, frame, home: null, socketId: null, sentTo: null, settle: null, sent: sentBefore };
    pending.set(rpcId, p);
    // Before the frame can reach the Server: a card in it is kept from now, so a tap that beats the answer finds it.
    await listen(() => o.onSend?.(method, body), method, 'a send listener failed');
    let answered = false;
    // The Server answered with an error no retry can change. Go's own errors (no answer in time, the socket lost, no
    // socket) are all retryable, so a final one that is not retryable came from the Server.
    let refused = false;
    try {
      p.home = await homeOf(tripId);
      let retries = 0;
      let losses = 0;
      for (;;) {
        if (requestId) {
          await o.pool.query('update go_requests set sent_at = coalesce(sent_at, $2), attempts = attempts + 1 where request_id = $1', [
            requestId,
            now(),
          ]);
        }
        const f = await attempt(p, timeoutMs);
        if (f.kind === 'result') {
          answered = true;
          if (requestId) {
            await o.pool.query('update go_requests set result = $2::jsonb, error = null, answered_at = $3 where request_id = $1', [
              requestId,
              JSON.stringify(f.result),
              now(),
            ]);
          }
          const result = parseResult(method, f.result);
          await listen(() => o.onResult?.(method, body, result, false), method, 'an answer listener failed');
          return result;
        }
        const code = f.error.code;
        if (code === LOST && losses < MAX_LOSSES) {
          losses += 1;
          continue; // the socket closed under it: send again, same id, once the trip's Server is back (another replica of it, or the same)
        }
        const retryable = code === TIMEOUT || code === LOST || code === 500 || code === 503 || code === 429;
        if (!retryable || retries >= delays.length) {
          refused = !retryable;
          const err = toCallError(f.error);
          if (requestId) {
            await o.pool.query('update go_requests set error = $2::jsonb, answered_at = $3 where request_id = $1', [
              requestId,
              JSON.stringify({ code: err.code, message: err.message }),
              now(),
            ]);
          }
          throw err;
        }
        const wait = code === 429 ? Math.min(60, Math.max(1, f.error.retryAfterSeconds ?? 1)) * 1_000 : (delays[retries] ?? 5_000);
        retries += 1;
        await sleep(wait);
      }
    } catch (e) {
      // Failed for sure: the frame never left Go, or the Server refused it. Sent and then no answer is unknown, never
      // failed: the Server may have done it.
      if (!answered && (refused || !p.sent)) await listen(() => o.onFail?.(method, body, e, p.sentTo), method, 'a failure listener failed');
      throw e;
    } finally {
      pending.delete(rpcId);
    }
  }

  /** What go_requests says about an earlier run: it tried to send, so the frame may have reached the Server. */
  function wasSent(row: { sent_at: Date | null; attempts: number }): boolean {
    return row.sent_at !== null || row.attempts > 0;
  }

  /** A listener never fails the request it listens to. */
  async function listen(fn: () => void | Promise<void>, method: ToServerMethod, what: string): Promise<void> {
    try {
      await fn();
    } catch (e) {
      o.log.warn({ err: e, method }, what);
    }
  }

  /** A post's text with its links taken out (door/links.ts): a line that was only a link has no text left. */
  function chatLine(params: Record<string, unknown>): Record<string, unknown> {
    if (typeof params.text !== 'string') return params;
    const text = withoutLinks(params.text);
    if (text === params.text) return params;
    o.log.warn({ tripId: params.trip_id }, 'door: a link was taken out of a chat line; links go in card actions');
    return { ...params, text: text || null };
  }

  async function request<M extends ToServerMethod>(
    method: M,
    params: ToServerParams<M>,
    opts: { timeoutMs?: number; turnId?: string } = {},
  ): Promise<ToServerResult<M>> {
    if (method === 'typing') throw new SocketCallError(422, 'typing is a notification: use notify', 'invalid');
    const parsed = (TO_SERVER_SCHEMAS[method][0] as z.ZodType).safeParse(method === 'post_message' ? chatLine(params as Record<string, unknown>) : params);
    if (!parsed.success) throw new SocketCallError(422, `bad ${method}: ${z.prettifyError(parsed.error)}`, 'invalid');
    const body = parsed.data as Record<string, unknown>;
    const timeoutMs = opts.timeoutMs ?? o.timeoutMs ?? 2_500;
    const requestId = typeof body.request_id === 'string' ? body.request_id : null;
    if (!requestId) return (await run(method, body, `go_${newUlid(now().getTime())}`, null, timeoutMs)) as ToServerResult<M>;
    const running = byRequestId.get(requestId);
    if (running) return (await running) as ToServerResult<M>;
    const job = (async () => {
      const { rows } = await o.pool.query<{ rpc_id: string; result: unknown; answered_at: Date | null; sent_at: Date | null; attempts: number }>(
        'select rpc_id, result, answered_at, sent_at, attempts from go_requests where request_id = $1',
        [requestId],
      );
      const row = rows[0];
      // Already done, e.g. by a turn that crashed after this write: the stored answer, nothing sent. Its listeners run
      // again, so a card whose answer was stored just before the crash is kept live.
      if (row?.answered_at && row.result !== null) {
        const result = parseResult(method, row.result);
        await listen(() => o.onResult?.(method, body, result, true), method, 'an answer listener failed');
        return result;
      }
      const rpcId = row?.rpc_id ?? `go_${newUlid(now().getTime())}`;
      if (!row) {
        await o.pool.query(
          `insert into go_requests (request_id, rpc_id, trip_id, turn_id, method, params, created_at)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7) on conflict (request_id) do nothing`,
          [requestId, rpcId, typeof body.trip_id === 'string' ? body.trip_id : '', opts.turnId ?? null, method, JSON.stringify(body), now()],
        );
      }
      return run(method, body, rpcId, requestId, timeoutMs, row !== undefined && wasSent(row));
    })().finally(() => byRequestId.delete(requestId));
    byRequestId.set(requestId, job);
    return (await job) as ToServerResult<M>;
  }

  function notify(method: 'typing', params: ToServerParams<'typing'>): void {
    const r = TO_SERVER_SCHEMAS[method][0].safeParse(params);
    if (!r.success) {
      o.log.warn({ method }, 'dropped a notification outside the contract');
      return;
    }
    // Sent at once, so typing on and off reach the Server in the order Go said them. A trip none of Go's requests named
    // yet in this run has no known home: any open socket, as for a trip with none.
    pick(homes.get(r.data.trip_id) ?? null)?.send(notificationFrame(method, r.data));
  }

  return {
    request,
    notify,
    isOpen: () => sockets.size > 0,
    async away(tripId) {
      const home = await homeOf(tripId);
      if (home === null || socketsFor(home).length > 0) return false;
      return Date.now() - (lostAt.get(home.instance) ?? startedAt) > awayAfterMs;
    },
    attach(s) {
      sockets.set(s.id, s);
      for (const w of [...waiters]) w();
    },
    detach(socketId) {
      const s = sockets.get(socketId);
      sockets.delete(socketId);
      // When its instance went away (ServerLink.away).
      if (s) lostAt.set(s.instance, Date.now());
      for (const p of pending.values()) {
        if (p.socketId === socketId && p.settle) p.settle({ kind: 'error', id: p.id, error: { code: LOST, message: 'the socket closed' } });
      }
    },
    onAnswer(f) {
      if (f.id === null) return;
      pending.get(f.id)?.settle?.(f);
    },
    async resumePending() {
      const { rows } = await o.pool.query<{
        request_id: string; rpc_id: string; method: ToServerMethod; params: Record<string, unknown>; sent_at: Date | null; attempts: number;
      }>(
        'select request_id, rpc_id, method, params, sent_at, attempts from go_requests where answered_at is null and created_at > $1 order by created_at',
        [new Date(now().getTime() - 10 * 60_000)],
      );
      for (const r of rows) {
        if (pending.has(r.rpc_id) || byRequestId.has(r.request_id)) continue;
        const job = run(r.method, r.params, r.rpc_id, r.request_id, o.timeoutMs ?? 2_500, wasSent(r)).finally(() => byRequestId.delete(r.request_id));
        byRequestId.set(r.request_id, job);
        job.catch((e: unknown) => o.log.warn({ err: e, request: r.request_id }, 'a resent request failed'));
      }
      return rows.length;
    },
    close() {
      closed = true;
      for (const w of [...waiters]) w();
    },
  };
}
