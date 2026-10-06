import { once } from 'node:events';
import * as C from '@go/contract';
import { WebSocket } from 'ws';

/** A frame as the raw Server saw it, with the time it arrived. */
export type RawFrame = Record<string, any> & { at: number };

export interface RawServer {
  ws: WebSocket;
  frames: RawFrame[];
  /** A request to Go; resolves with the whole answer frame. */
  call(method: string, params: unknown, id?: string): Promise<RawFrame>;
  sendRaw(text: string): void;
  waitFor(pred: (f: RawFrame) => boolean, timeoutMs?: number): Promise<RawFrame>;
  close(): Promise<void>;
}

/** The upgrade header, signed the way the Server signs it. */
export function signedHeaders(target: string, secret: string, now?: number): Record<string, string> {
  return { [C.SIGNATURE_HEADER]: C.signRequest({ method: 'GET', target, body: '' }, secret, now) };
}

/** Opens a socket to Go; resolves with the HTTP status and body when Go refuses the upgrade. */
export function tryOpen(
  url: string,
  headers: Record<string, string>,
  opts: { autoPong?: boolean } = {},
): Promise<{ ws: WebSocket } | { status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers, autoPong: opts.autoPong ?? true });
    ws.once('open', () => resolve({ ws }));
    ws.once('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c: Buffer) => { body += c.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    ws.on('error', (e) => reject(e));
  });
}

/**
 * A tiny Server for the door and boot tests: signs the upgrade, answers Go's requests with `answer`
 * (throw `{ code, message }` to answer with an error), and records every frame Go sends.
 */
export async function rawServer(
  url: string,
  secret: string,
  answer: (method: string, params: any) => unknown = () => ({}),
): Promise<RawServer> {
  const u = new URL(url);
  const r = await tryOpen(url, signedHeaders(u.pathname + u.search, secret));
  if (!('ws' in r)) throw new Error(`Go refused the socket: ${r.status} ${r.body}`);
  const ws = r.ws;
  const frames: RawFrame[] = [];
  const waiting = new Map<string, (f: RawFrame) => void>();
  ws.on('message', (d) => {
    const f = { ...(JSON.parse(String(d)) as Record<string, any>), at: Date.now() } as RawFrame;
    frames.push(f);
    if (typeof f.method === 'string' && typeof f.id === 'string') {
      const id = f.id;
      Promise.resolve()
        .then(() => answer(f.method, f.params))
        .then(
          (result) => ws.send(JSON.stringify({ jsonrpc: '2.0', id, result })),
          (e: { code?: number; message?: string }) =>
            ws.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: e.code ?? 500, message: e.message ?? 'failed' } })),
        );
    } else if (f.method === undefined && typeof f.id === 'string') {
      waiting.get(f.id)?.(f);
      waiting.delete(f.id);
    }
  });
  let n = 0;
  return {
    ws,
    frames,
    call: (method, params, id = `gs_${++n}_${Date.now()}`) =>
      new Promise<RawFrame>((resolve) => {
        waiting.set(id, resolve);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      }),
    sendRaw: (t) => ws.send(t),
    waitFor: async (pred, timeoutMs = 5_000) => {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const f = frames.find(pred);
        if (f) return f;
        if (Date.now() > end) throw new Error('timed out waiting for a frame from Go');
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    close: async () => {
      if (ws.readyState === ws.CLOSED) return;
      ws.close();
      await once(ws, 'close');
    },
  };
}
