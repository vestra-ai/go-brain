// A tiny Go for the sim's tests. It checks the signature on the upgrade, answers send_event (duplicates by
// event_id), card_tap and forget_person, records every frame the sim sends, and lets a test send Go's requests.
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyRequest } from '@go/contract';

export interface TestGo {
  url: string;
  frames: any[];
  /** The params of every send_event, in arrival order, repeats included. */
  events: any[];
  taps: any[];
  forgets: any[];
  /** What forget_person answers: Go's ForgetResult, or 'fail' for an error. */
  forget: object | 'fail';
  /** What card_tap answers: Go's CardActionResult. */
  tapAnswer: object;
  targets: string[];
  signatures: string[];
  refused: number;
  /** 'silent-once' leaves the next event unanswered, once. */
  mode: 'accept' | 'silent-once';
  /** Sends one of Go's requests and resolves with the whole answer frame. */
  call(method: string, params: object): Promise<any>;
  notify(method: string, params: object): void;
  close(): Promise<void>;
}

/** `nowSeconds`: the clock Go checks signatures by, for a Server whose clock is moved; the real one by default. */
export async function startTestGo(secret: string, o: { nowSeconds?: () => number } = {}): Promise<TestGo> {
  const seen = new Set<string>();
  const waiting = new Map<string, (frame: any) => void>();
  let sock: WebSocket | undefined;
  let n = 0;
  const wss = new WebSocketServer({
    port: 0,
    verifyClient: ({ req }, done) => {
      const header = req.headers['x-go-signature'];
      const ok = verifyRequest({ method: 'GET', target: req.url ?? '', body: '' }, typeof header === 'string' ? header : undefined, secret, o.nowSeconds?.()).ok;
      if (!ok) go.refused += 1;
      done(ok, 401);
    },
  });
  const go: TestGo = {
    url: '',
    frames: [],
    events: [],
    taps: [],
    forgets: [],
    forget: { deleted_facts: 2, remaining_facts: 0 },
    tapAnswer: { result: 'done', toast: 'Noted.' },
    targets: [],
    signatures: [],
    refused: 0,
    mode: 'accept',
    call: (method, params) =>
      new Promise((resolve) => {
        const id = `go_t${++n}`;
        waiting.set(id, resolve);
        sock!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      }),
    notify: (method, params) => sock!.send(JSON.stringify({ jsonrpc: '2.0', method, params })),
    close: async () => {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
  wss.on('connection', (ws, req) => {
    sock = ws;
    go.targets.push(req.url ?? '');
    go.signatures.push(String(req.headers['x-go-signature']));
    ws.on('message', (data) => {
      const f = JSON.parse(data.toString());
      go.frames.push(f);
      if (f.method === 'send_event') {
        go.events.push(f.params);
        if (go.mode === 'silent-once') {
          go.mode = 'accept';
          return;
        }
        const duplicate = seen.has(f.params.event_id);
        seen.add(f.params.event_id);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: f.id, result: { accepted: true, duplicate } }));
        return;
      }
      if (f.method === 'card_tap') {
        go.taps.push(f.params);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: f.id, result: go.tapAnswer }));
        return;
      }
      if (f.method === 'forget_person') {
        go.forgets.push(f.params);
        const answer = go.forget === 'fail' ? { error: { code: -32603, message: 'Go could not forget everything. Try again.' } } : { result: go.forget };
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: f.id, ...answer }));
        return;
      }
      if (typeof f.method === 'string') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: f.id, error: { code: -32601, message: `unknown method ${f.method}` } }));
        return;
      }
      const w = waiting.get(f.id);
      if (w) {
        waiting.delete(f.id);
        w(f);
      }
    });
  });
  await once(wss, 'listening');
  go.url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  return go;
}
