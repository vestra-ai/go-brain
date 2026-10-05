// The Server's end of the socket to Go.
//
// The Server opens one WebSocket to Go and keeps it open. This client:
//  - signs every connect fresh, with the query string in the target (Go accepts each signature once);
//  - reconnects after 1, 2, 5 and 10 seconds, then every 30 seconds, and starts from 1 again after a good connect;
//  - closes the socket after 40 seconds of silence (Go pings every 20 seconds, so a live socket is never silent);
//  - sends your requests with request(), waits for the answer up to a time limit, and sends every unanswered
//    request again after a reconnect, with the same id;
//  - answers Go's requests through a table of handlers: -32601 for a method with no handler, 422 for params
//    that do not match the contract, 500 when a handler fails, -32700 for a frame it cannot read, and nothing at
//    all for a notification (Go's typing).
//
// It is the client in docs/guide/02-the-socket.md with three fixes: a handler that returns nothing still answers
// with a result object ({}), a frame that is JSON but not an object is answered -32700, and close() stops it.
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { IDLE_CLOSE_SECONDS, MAX_FRAME_BYTES, RECONNECT_BACKOFF_SECONDS, SIGNATURE_HEADER, parseParams, signRequest } from '@go/contract';

/** An error answer: Go's answer to one of your requests, or your handler's answer to one of Go's. */
export class SocketCallError extends Error {
  /** The error's name in error.data.code, such as "conflict". JSON-RPC's own -32700 and -32601 have none. */
  readonly dataCode: string | undefined;
  /** With a 429: how many seconds to wait before trying again. */
  readonly retryAfterSeconds: number | undefined;

  constructor(readonly code: number, message: string, dataCode?: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'SocketCallError';
    this.dataCode = dataCode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** No answer arrived within the time limit (or the client was closed while it waited). */
export class SocketTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocketTimeoutError';
  }
}

/**
 * Answers one of Go's methods. `params` is checked against the contract; `raw` is the frame's params exactly as
 * they arrived. Read everything from `params`; store a card from `raw.card`, so a card field Go adds later
 * still reaches the app. Return the result, or throw SocketCallError to answer with an error.
 */
export type Handler = (params: any, raw: Record<string, unknown>) => Promise<object | void> | object | void;

export interface GoSocketOptions {
  /** Go's socket: wss://<Go's host>/v1/socket, with ?instance=<name> when the Server runs more than one instance. */
  url: string;
  /** GO_SIGNING_SECRET. */
  secret: string;
  /** One handler for each of Go's methods the Server answers. */
  handlers: Record<string, Handler>;
  /** Called after every connect that works. */
  onOpen?: () => void;
  /** Called when an open socket closes. */
  onClose?: () => void;
  /** Called with connect and socket errors, such as "Unexpected server response: 401" (check the secret and the clock). */
  onError?: (err: Error) => void;
  /** Sees every frame in both directions, as text. For logs and debugging. */
  onFrame?: (direction: 'in' | 'out', text: string) => void;
  /** For tests: the waits before each reconnect, in seconds. Defaults to the contract's 1, 2, 5, 10, 30. */
  backoffSeconds?: readonly number[];
  /** For tests: the silence limit, in seconds. Defaults to the contract's 40. */
  idleCloseSeconds?: number;
  /** For tests: the clock used to sign, in Unix seconds. */
  nowSeconds?: () => number;
}

interface Pending {
  frame: string;
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

interface AnswerFrame {
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: { code?: string; retry_after_seconds?: number | null } | null };
}

export class GoSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;
  private retry: NodeJS.Timeout | undefined;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly opts: GoSocketOptions) {}

  /** Opens the socket, and keeps reopening it until close(). Call it once. */
  start(): void {
    if (this.stopped) return;
    const { pathname, search } = new URL(this.opts.url);
    const now = this.opts.nowSeconds ? this.opts.nowSeconds() : Math.floor(Date.now() / 1000);
    // A new signature for every connect: Go refuses a signature it has seen before.
    const signature = signRequest({ method: 'GET', target: pathname + search, body: '' }, this.opts.secret, now);
    const ws = new WebSocket(this.opts.url, { headers: { [SIGNATURE_HEADER]: signature }, maxPayload: MAX_FRAME_BYTES });
    const idleMs = (this.opts.idleCloseSeconds ?? IDLE_CLOSE_SECONDS) * 1000;
    let idle: NodeJS.Timeout | undefined;
    const heard = (): void => {
      clearTimeout(idle);
      idle = setTimeout(() => ws.terminate(), idleMs);
    };
    ws.on('open', () => {
      this.ws = ws;
      this.attempt = 0;
      heard();
      for (const p of this.pending.values()) this.send(ws, p.frame); // unanswered requests go again, same ids
      this.opts.onOpen?.();
    });
    ws.on('ping', heard);
    ws.on('pong', heard);
    ws.on('message', (data) => {
      heard();
      void this.onFrame(ws, data.toString());
    });
    ws.on('error', (err) => this.opts.onError?.(err)); // 'close' always follows
    ws.on('close', () => {
      clearTimeout(idle);
      if (this.ws === ws) {
        this.ws = null;
        this.opts.onClose?.();
      }
      if (this.stopped) return;
      const waits = this.opts.backoffSeconds ?? RECONNECT_BACKOFF_SECONDS;
      const wait = waits[Math.min(this.attempt, waits.length - 1)] ?? 30;
      this.attempt += 1;
      this.retry = setTimeout(() => this.start(), wait * 1000);
    });
  }

  /** Stops for good: closes the socket, stops reconnecting, and fails every request still waiting. */
  close(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.ws?.close();
    for (const p of [...this.pending.values()]) p.reject(new SocketTimeoutError('the socket was closed'));
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Sends a request and resolves with its result. Fails with SocketCallError on an error answer, and with
   * SocketTimeoutError when no answer comes in time. While the socket is down the request waits, and it goes
   * out (again) with the same id as soon as the socket is back.
   */
  request(method: string, params: object, { timeoutMs = 2000 }: { timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
    const id = `gs_${randomUUID()}`;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SocketTimeoutError(`${method}: no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      const settle = (): void => {
        clearTimeout(timer);
        this.pending.delete(id);
      };
      this.pending.set(id, {
        frame,
        resolve: (r) => { settle(); resolve(r); },
        reject: (e) => { settle(); reject(e); },
      });
      if (this.ws) this.send(this.ws, frame); // while disconnected, 'open' sends it
    });
  }

  /** Sends a notification. It is dropped while the socket is down: notifications are never sent again. */
  notify(method: string, params: object): void {
    if (this.ws) this.send(this.ws, JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  private send(ws: WebSocket, text: string): void {
    this.opts.onFrame?.('out', text);
    ws.send(text);
  }

  private async onFrame(ws: WebSocket, text: string): Promise<void> {
    this.opts.onFrame?.('in', text);
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      frame = undefined;
    }
    if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
      return this.send(ws, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'cannot read the frame' } }));
    }
    const f = frame as AnswerFrame & { method?: unknown; params?: unknown };

    if (typeof f.method !== 'string') {
      // The answer to one of your requests. An id you are no longer waiting for belongs to a request you gave up on.
      const p = typeof f.id === 'string' ? this.pending.get(f.id) : undefined;
      if (!p) return;
      if (!f.error) return p.resolve(f.result ?? {});
      const { code, message, data } = f.error;
      return p.reject(new SocketCallError(code, message, data?.code ?? undefined, data?.retry_after_seconds ?? undefined));
    }

    const raw = (typeof f.params === 'object' && f.params !== null ? f.params : {}) as Record<string, unknown>;
    const handler = this.opts.handlers[f.method];
    const check = parseParams(f.method, f.params);

    if (f.id === undefined) {
      // A notification: never answered, not even when its params are wrong.
      if (handler && check.ok) {
        try {
          await handler(check.params, raw);
        } catch {
          // A notification has nobody to tell.
        }
      }
      return;
    }

    const id = f.id;
    const answer = (body: object): void => this.send(ws, JSON.stringify({ jsonrpc: '2.0', id, ...body }));
    try {
      if (!handler) throw new SocketCallError(-32601, `unknown method ${f.method}`);
      if (!check.ok) throw new SocketCallError(check.code, check.message, check.code === 422 ? 'invalid' : undefined);
      const result = await handler(check.params, raw);
      answer({ result: result ?? {} }); // a result is always an object, even when the handler returns nothing
    } catch (err) {
      const e = err instanceof SocketCallError ? err : new SocketCallError(500, 'internal error', 'internal');
      const data = e.dataCode
        ? { data: { code: e.dataCode, ...(e.retryAfterSeconds !== undefined ? { retry_after_seconds: e.retryAfterSeconds } : {}) } }
        : {};
      answer({ error: { code: e.code, message: e.message.slice(0, 500), ...data } });
    }
  }
}
