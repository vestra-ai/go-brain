// Go's requests to the Server. A request about an event goes out on the socket that event came on, so the Server
// instance that sent the event hears about it; with no such socket it goes out on the newest open one. If its
// socket closes before the answer, the request goes out again on the newest open socket with the same JSON-RPC id
// (and so the same request_id inside), and the Server answers a repeat with its first answer.
// Every answer is checked against the contract. An answer that breaks it, or one that never comes, fails the
// request and leaves a problem row on the frames page, so the Server team sees what to fix.
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { SocketError, SocketResult, methodByName } from '@go/contract';
import { SocketCallError, SocketTimeoutError } from '@go/sim';
import type { FrameLog } from './frames.js';

interface Conn {
  ws: WebSocket;
  instance: string;
}

interface Pending {
  method: string;
  frame: string;
  /** The socket it went out on, or null while no socket is open. */
  on: Conn | null;
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

/** The Server's answer broke the contract. The frames page shows the same words in a problem row. */
export class AnswerProblemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnswerProblemError';
  }
}

/** JSON-RPC's own two errors carry no data.code. Every other error needs one. */
const NO_DATA_CODE: ReadonlySet<number> = new Set([-32700, -32601]);

const oneLine = (err: z.ZodError): string => z.prettifyError(err).replace(/\s*\n\s*/g, ' ');

export interface RequestOptions {
  /** The socket the event came on. When it has closed, the newest open socket is used instead. */
  via?: WebSocket | undefined;
  timeoutMs?: number | undefined;
}

export class Link {
  private readonly conns: Conn[] = [];
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly frames: FrameLog) {}

  attach(ws: WebSocket, instance: string): void {
    const conn = { ws, instance };
    this.conns.push(conn);
    for (const p of this.pending.values()) {
      if (p.on !== null) continue;
      p.on = conn;
      this.write(conn, p.frame);
    }
  }

  detach(ws: WebSocket): void {
    const i = this.conns.findIndex((c) => c.ws === ws);
    if (i < 0) return;
    const [gone] = this.conns.splice(i, 1);
    const next = this.newest();
    for (const p of this.pending.values()) {
      if (p.on !== gone) continue;
      p.on = next;
      if (next) this.write(next, p.frame);
    }
  }

  isOpen(): boolean {
    return this.conns.length > 0;
  }

  instances(): string[] {
    return this.conns.map((c) => c.instance);
  }

  request(method: string, params: object, { via, timeoutMs = 2000 }: RequestOptions = {}): Promise<Record<string, unknown>> {
    const id = `go_${randomUUID()}`;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiting = this.pending.get(id);
        this.pending.delete(id);
        this.problem(waiting?.on?.instance ?? 'no socket', `${method}: no answer within ${timeoutMs} ms`);
        reject(new SocketTimeoutError(`${method}: no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      const settle = (): void => {
        clearTimeout(timer);
        this.pending.delete(id);
      };
      const conn = this.pick(via);
      this.pending.set(id, {
        method,
        frame,
        on: conn,
        resolve: (r) => { settle(); resolve(r); },
        reject: (e) => { settle(); reject(e); },
      });
      if (conn) this.write(conn, frame); // with no socket open, it waits for the next one
    });
  }

  /** A notification (Go's typing), on `via` while it is open: dropped when no socket is open, never sent again. */
  notify(method: string, params: object, via?: WebSocket): void {
    const conn = this.pick(via);
    if (conn) this.write(conn, JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  /**
   * Matches an answer frame to the request it answers, and checks it: the frame's shape, data.code on every error
   * but -32700 and -32601, and the result against the method's result in the contract. A frame with no `result`
   * is a problem, never an empty result. An answer nobody waits for is dropped.
   */
  settle(frame: { id?: unknown; result?: unknown; error?: unknown }, instance: string): void {
    const p = typeof frame.id === 'string' ? this.pending.get(frame.id) : undefined;
    if (!p) return;
    if (frame.error !== undefined) {
      const answer = SocketError.safeParse(frame);
      if (!answer.success) return this.fail(p, instance, `${p.method}: the error answer does not pass the contract: ${oneLine(answer.error)}`);
      const { code, message, data } = answer.data.error;
      if (!data?.code && !NO_DATA_CODE.has(code)) {
        this.problem(instance, `${p.method}: error ${code} has no data.code. Every error but -32700 and -32601 needs one.`);
      }
      return p.reject(new SocketCallError(code, message, data?.code ?? undefined, data?.retry_after_seconds ?? undefined));
    }
    const answer = SocketResult.safeParse(frame);
    if (!answer.success) return this.fail(p, instance, `${p.method}: the answer does not pass the contract: ${oneLine(answer.error)}`);
    const result = methodByName(p.method)?.result?.safeParse(answer.data.result);
    if (result && !result.success) return this.fail(p, instance, `${p.method}: the result does not pass the contract: ${oneLine(result.error)}`);
    p.resolve(answer.data.result);
  }

  /** Sends one frame (an answer) on the socket it belongs to. */
  send(ws: WebSocket, body: object): void {
    const conn = this.conns.find((c) => c.ws === ws) ?? { ws, instance: 'closed' };
    this.write(conn, JSON.stringify(body));
  }

  private fail(p: Pending, instance: string, problem: string): void {
    this.problem(instance, problem);
    p.reject(new AnswerProblemError(problem));
  }

  private problem(instance: string, text: string): void {
    this.frames.add('problem', instance, text);
  }

  /** `via` while it is still open, otherwise the newest open socket. */
  private pick(via: WebSocket | undefined): Conn | null {
    return this.conns.find((c) => c.ws === via) ?? this.newest();
  }

  private newest(): Conn | null {
    return this.conns[this.conns.length - 1] ?? null;
  }

  private write(conn: Conn, text: string): void {
    this.frames.add('out', conn.instance, text);
    conn.ws.send(text);
  }
}
