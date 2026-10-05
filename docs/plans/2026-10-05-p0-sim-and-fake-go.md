# P0: the simulator and the fake Go Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Server team a deployed fake Go tonight, and give our own lanes a simulator that plays the Server (and the App, through a dev room in the browser) by Tuesday morning.
**Architecture:** `packages/sim` (`@go/sim`) holds the Server's end of the socket (`server-socket.ts`, a faithful and fixed copy of the guide's reference client, also handed to the Server team), the Goa trip fixture, an in-memory trip store that answers all 18 of Go's methods with the contract's rules, the `FakeServer` that dials Go and sends events, and a one-page dev room. `apps/fake-go` (`@go/fake-go`) is a small Fastify 5 + `ws` service that speaks Go's side of the socket exactly as `docs/guide/10-build-and-test.md` promises, with a frames page for debugging, a Dockerfile and a smoke script for the handover. Neither depends on `apps/brain`.
**Tech Stack:** Node 22, TypeScript 5.9 strict (`exactOptionalPropertyTypes`), `@go/contract` 1.0.0 (workspace), zod 4.3.6, `ws` ^8.18.3 (+ `@types/ws` ^8.18.1), Fastify ^5.6.1, vitest 4, tsx 4, Docker (`node:22-slim`), Railway.
**Spec:** `docs/spec/2026-10-05-go-design.md` §3 (the door rules the fake Go mirrors), §17 (the fake Go for the other teams), §18 (Monday) and `docs/plans/2026-10-05-go-the-week.md` (master plan; sections 6 and 7 are binding). Wire: `packages/contract`, `docs/guide/02-the-socket.md`, `04-gos-requests.md`, `05-your-requests.md`, `06-cards.md`, `10-build-and-test.md`.
**Lane / gate:** Lane A. **G0 the fake Go** (master §2, Mon 23:00): Tasks 1 to 5. **The simulator ready for P1's end-to-end tests** (Tue 10:00): Tasks 6 to 10.
**Depends on:** `@go/contract` only (`signRequest`, `verifyRequest`, `parseParams`, `SOCKET_PATH`, `PING_INTERVAL_SECONDS`, `IDLE_CLOSE_SECONDS`, `RECONNECT_BACKOFF_SECONDS`, `MAX_FRAME_BYTES`, `SIGNATURE_HEADER`, `MAX_SKEW_SECONDS`, `CONTRACT_VERSION`, `TO_GO`, `Event`, `EventAccepted`, `CardActionResult`, `TripSnapshot`, `Card`, `Message`, `signSpendApproval`, `MAX_APPROVAL_TTL_SECONDS`, and the params schemas named in each task). Nothing from other sub-plans.

**Who builds what tonight.** Builder A takes Tasks 1 to 5 in order (G0). Builder B starts Task 6 as soon as Tasks 1 and 2 are merged into `build` (Task 6 needs the `packages/sim` package from Task 1 and the Goa fixture from Task 2, about an hour in) and takes Tasks 6 to 10 in order. If only one builder is free, run Tasks 1 to 10 in order: G0 still comes first. File ownership has no overlap: Builder A owns `packages/sim/{package.json,tsconfig.json,vitest.config.ts,src/index.ts,src/server-socket.ts,src/goa.ts,src/test-spend-key.ts}` and everything under `apps/fake-go/` plus the root `.dockerignore`; Builder B owns `packages/sim/src/state/`, `src/fake-server.ts`, `src/dev-room/`, `src/cli.ts`, and edits `packages/sim/src/index.ts` and `packages/sim/package.json` only after Builder A's Task 2 is merged (Builder B rebases first).

## Global Constraints

Master §7 applies to every task. Specific to this plan:

- P0 is self-contained: it never imports `apps/brain` (so the `door/methods.ts` table of master §6.3 is not used here; the contract's `parseParams` and schemas are).
- Every frame both sides send must pass the contract: results are always JSON objects, errors carry `data.code` except `-32700` and `-32601`, `-32700` answers have `id: null`.
- Socket numbers come from `@go/contract`: ping every `PING_INTERVAL_SECONDS` (20), close after `IDLE_CLOSE_SECONDS` (40) of silence, reconnect after `RECONNECT_BACKOFF_SECONDS` (1, 2, 5, 10, 30), frames at most `MAX_FRAME_BYTES` (1,048,576). Tests may shorten them through options; defaults never change.
- Go's JSON-RPC ids start `go_`; the Server's (the sim's) start `gs_`. The fake Go's `request_id`s start `rq_fake_`.
- The spend approvals the sim signs use the TEST key from `packages/contract/test-vectors/spend-approval.json`. Dev and tests only; the Server signs real ones with its own key.
- The fake Go keeps used signatures, seen `event_id`s and seen `tap_id`s in memory. A restart forgets them. That is fine for the fake and is said in its README; the real Go (P1) keeps them in Postgres.
- The fake Go's pay cards carry `approval_id`s that start `ap_fake_` and say "Nothing is charged" in their text. They are never real approvals.
- No em dashes in anything a person sees: Go's text, card text, the dev room page, the fake Go's pages, the handover message. Tests assert it where the text lives in code.
- No secrets in the repo, in a log line, in a frame log or in a commit. `GO_SIGNING_SECRET` and `FAKE_GO_ADMIN_TOKEN` live only in Railway variables and are handed to Nishanth by Keshav through a one-time link.
- Tests run only in CI. Builders may run `pnpm install` locally to update `pnpm-lock.yaml` (not a test run); CI uses `--frozen-lockfile`.

## Review Focus

1. **The socket drops while a request waits** (master §10 line 1): the Server's client resends with the same JSON-RPC id after a reconnect (Task 1), the fake Go resends its own unanswered requests on the next socket with the same id (Task 3), the `FakeServer` answers a repeated `request_id` with its first answer while `countWrites()` shows both arrivals and `applied` shows one change (Tasks 6 and 9), and its `reconnect()` gives tests a real drop and a fresh, signed socket with the trip kept (Task 9).
2. **A signature used twice, or signed without the query string**: refused with `401` and the contract's `ErrorBody` before the upgrade completes; the client signs fresh on every connect (Tasks 1 and 3).
3. **An event type Go does not know, a known event that is broken, and an `event_id` seen before**: accepted before validation, `422 invalid`, and `duplicate: true` with no second piece of work, even under a new JSON-RPC id (Task 3; the mention script runs once in Task 4).
4. **Card taps that arrive twice or from the wrong person**: a repeated `tap_id` gets its first answer back; `approve` from anyone but the pay card's payer is `refused` with a toast (Task 4).
5. **Answers the other side would reject**: a handler that returns nothing still answers `{}` (Task 1); every fake Go card and fixed answer passes the contract (Task 4); `read_messages` shrinks the page and sets `has_more` to stay under the frame limit (Task 6); the spend check denies in the guide's order (Task 8).

## File Structure

```
.dockerignore                                  Keeps node_modules and dist out of Docker builds (Task 5).
packages/sim/package.json                      @go/sim: build, test, room scripts (Tasks 1, 10).
packages/sim/tsconfig.json                     Extends the base config; tests excluded from the build (Task 1).
packages/sim/vitest.config.ts                  Runs src/**/*.test.ts (Task 1).
packages/sim/src/index.ts                      Public exports of @go/sim (Tasks 1, 2, 9, 10).
packages/sim/src/server-socket.ts              The Server's end of the socket: GoSocket, SocketCallError, SocketTimeoutError (Task 1).
packages/sim/src/goa.ts                        The Goa trip: the guide's snapshot, a fresh start, the seed chat (Task 2).
packages/sim/src/test-spend-key.ts             The contract's TEST Ed25519 key pair for spend approvals (Task 2).
packages/sim/src/state/trip-state.ts           One trip in memory: change numbers, events, once per request_id, reads, room writes, people's actions (Task 6).
packages/sim/src/state/decisions.ts            Votes and mandates: open, vote, close, set, confirm, decline (Task 7).
packages/sim/src/state/records.ts              Trip record lines Go writes (Task 8).
packages/sim/src/state/money.ts                Bookings, expenses, the money maths, the spend check and approvals (Task 8).
packages/sim/src/fake-server.ts                FakeServer: dials Go, answers its 18 methods, sends events in order, test helpers (Task 9).
packages/sim/src/dev-room/page.ts              The dev room: one self-contained HTML page as a string (Task 10).
packages/sim/src/dev-room/serve.ts             serveDevRoom: HTTP page + live WebSocket for the browser (Task 10).
packages/sim/src/cli.ts                        `pnpm --filter @go/sim room`: FakeServer + Goa trip + dev room (Task 10).
packages/sim/src/__tests__/*.test.ts           One test file per source file above; helpers/test-go.ts is a tiny Go for tests (Tasks 1, 2, 6 to 10).
apps/fake-go/package.json                      @go/fake-go: build, start, test, smoke scripts (Task 3).
apps/fake-go/tsconfig.json                     Extends the base config (Task 3).
apps/fake-go/vitest.config.ts                  Runs src/**/*.test.ts (Task 3).
apps/fake-go/src/signature-guard.ts            Checks the upgrade signature and accepts each (t, v1) once (Task 3).
apps/fake-go/src/frames.ts                     The last 200 frames both ways, and the page that lists them (Task 3).
apps/fake-go/src/link.ts                       Go's requests to the Server over whichever socket is open, resent after a drop (Task 3).
apps/fake-go/src/server.ts                     buildFakeGo: upgrade, keepalive, JSON-RPC answers, send_event, health, pages (Task 3).
apps/fake-go/src/env.ts                        The fake Go's environment variables (Task 4).
apps/fake-go/src/cards.ts                      The five Go cards the fake Go posts, in turn (Task 4).
apps/fake-go/src/behaviour.ts                  The mention script and the fixed answers (Task 4).
apps/fake-go/src/main.ts                       Boots the fake Go from the environment (Task 4).
apps/fake-go/src/smoke.ts                      runSmoke: connects to a deployed fake Go and checks the whole promise (Task 5).
apps/fake-go/scripts/smoke.ts                  The smoke command line (Task 5).
apps/fake-go/Dockerfile                        Builds the fake Go from the repo root (Task 5).
apps/fake-go/railway.json                      Railway build and health check settings (Task 5).
apps/fake-go/README.md                         For Nishanth's team: what it does, GO_URL, connecting by hand, what it does not do (Task 5).
apps/fake-go/src/__tests__/*.test.ts           Tests that run the fake Go in-process and connect with @go/sim's GoSocket (Tasks 3, 4, 5).
pnpm-lock.yaml                                 Updated by `pnpm install` (Tasks 1, 3).
```

---
### Task 1: The Server's end of the socket (`@go/sim` package and `server-socket.ts`)

This file is also handed to the Server team as their reference client, so it is written to be read: plain comments, one job per method. It is the guide's `go-socket.ts` (docs/guide/02-the-socket.md, "A complete client for the server") with these fixes the research found:

- A handler that returns nothing answers `{ "result": {} }`, never a frame without `result`.
- A frame that is valid JSON but not an object (`null`, `5`, `[1]`) is answered `-32700` instead of crashing.
- It also resets its silence timer on pongs, can be stopped for good with `close()`, and has hooks (`onOpen`, `onClose`, `onError`, `onFrame`) for logs. Tests can shorten the waits and fix the signing clock.

**Files:**
- Create: `packages/sim/package.json`
- Create: `packages/sim/tsconfig.json`
- Create: `packages/sim/vitest.config.ts`
- Create: `packages/sim/src/index.ts`
- Create: `packages/sim/src/server-socket.ts`
- Test: `packages/sim/src/__tests__/server-socket.test.ts`
- Modify: `pnpm-lock.yaml` (written by `pnpm install`)

**Interfaces:**
- Consumes: `@go/contract`: `signRequest`, `parseParams`, `SIGNATURE_HEADER`, `MAX_FRAME_BYTES`, `IDLE_CLOSE_SECONDS`, `RECONNECT_BACKOFF_SECONDS`.
- Produces:
  - `class SocketCallError extends Error { readonly code: number; readonly dataCode: string | undefined; readonly retryAfterSeconds: number | undefined; constructor(code: number, message: string, dataCode?: string, retryAfterSeconds?: number) }`
  - `class SocketTimeoutError extends Error`
  - `type Handler = (params: any, raw: Record<string, unknown>) => Promise<object | void> | object | void`
  - `interface GoSocketOptions { url; secret; handlers: Record<string, Handler>; onOpen?; onClose?; onError?(err: Error); onFrame?(direction: 'in' | 'out', text: string); backoffSeconds?: readonly number[]; idleCloseSeconds?: number; nowSeconds?: () => number }`
  - `class GoSocket { constructor(opts: GoSocketOptions); start(): void; close(): void; isOpen(): boolean; request(method: string, params: object, opts?: { timeoutMs?: number }): Promise<Record<string, unknown>>; notify(method: string, params: object): void }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/sim/src/__tests__/server-socket.test.ts
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyRequest } from '@go/contract';
import { GoSocket, SocketCallError, SocketTimeoutError, type Handler } from '../server-socket.js';

const secret = 'test-secret-for-the-sim-0001';

/** A bare WebSocket server standing in for Go: it records connects and frames, and lets the test answer. */
async function startGo() {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const conns: Array<{ ws: WebSocket; signature: string; target: string }> = [];
  const inbox: any[] = [];
  const waiters: Array<(f: any) => void> = [];
  wss.on('connection', (ws, req) => {
    conns.push({ ws, signature: String(req.headers['x-go-signature']), target: req.url ?? '' });
    ws.on('message', (d) => {
      const f = JSON.parse(d.toString());
      const w = waiters.shift();
      if (w) w(f);
      else inbox.push(f);
    });
  });
  const next = (ms = 2000): Promise<any> => {
    if (inbox.length > 0) return Promise.resolve(inbox.shift());
    return new Promise((resolve, reject) => {
      const w = (f: any): void => { clearTimeout(t); resolve(f); };
      const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error('no frame')); }, ms);
      waiters.push(w);
    });
  };
  const connected = async (n: number) => {
    for (let i = 0; i < 300 && conns.length < n; i++) await new Promise((r) => setTimeout(r, 10));
    if (conns.length < n) throw new Error(`only ${conns.length} connects`);
    return conns[n - 1]!;
  };
  const port = (wss.address() as AddressInfo).port;
  const close = async () => {
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
  };
  return { wss, conns, inbox, next, connected, port, close };
}

let go: Awaited<ReturnType<typeof startGo>>;
let sock: GoSocket | undefined;
afterEach(async () => {
  sock?.close();
  sock = undefined;
  await go?.close();
});

function client(handlers: Record<string, Handler> = {}, extra: Partial<ConstructorParameters<typeof GoSocket>[0]> = {}) {
  sock = new GoSocket({ url: `ws://127.0.0.1:${go.port}/v1/socket?instance=sim-test`, secret, handlers, backoffSeconds: [0.05], ...extra });
  sock.start();
  return sock;
}

describe('GoSocket: connecting', () => {
  it('signs every connect fresh, with the query string in the target', async () => {
    go = await startGo();
    let clock = 1_791_190_800;
    client({}, { nowSeconds: () => clock++ });
    const first = await go.connected(1);
    expect(first.target).toBe('/v1/socket?instance=sim-test');
    expect(verifyRequest({ method: 'GET', target: first.target, body: '' }, first.signature, secret, 1_791_190_800)).toEqual({ ok: true });
    first.ws.terminate();
    const second = await go.connected(2);
    expect(second.signature).not.toBe(first.signature);
    expect(verifyRequest({ method: 'GET', target: second.target, body: '' }, second.signature, secret, 1_791_190_801)).toEqual({ ok: true });
  });

  it('close() stops reconnecting and fails the requests still waiting', async () => {
    go = await startGo();
    const s = client();
    const conn = await go.connected(1);
    const waiting = s.request('read_trip', { trip_id: 't_goa' }, { timeoutMs: 5000 });
    await go.next();
    s.close();
    await expect(waiting).rejects.toBeInstanceOf(SocketTimeoutError);
    conn.ws.terminate();
    await new Promise((r) => setTimeout(r, 200));
    expect(go.conns.length).toBe(1);
  });
});

describe('GoSocket: requests', () => {
  it('resolves with the result, fails with SocketCallError on an error frame, and times out', async () => {
    go = await startGo();
    const s = client();
    const conn = await go.connected(1);

    const ok = s.request('send_event', { event_id: 'ev_1' });
    const f1 = await go.next();
    expect(f1).toMatchObject({ jsonrpc: '2.0', method: 'send_event', params: { event_id: 'ev_1' } });
    expect(f1.id).toMatch(/^gs_/);
    conn.ws.send(JSON.stringify({ jsonrpc: '2.0', id: f1.id, result: { accepted: true, duplicate: false } }));
    await expect(ok).resolves.toEqual({ accepted: true, duplicate: false });

    const busy = s.request('catch_up', { trip_id: 't_goa', person_id: 'p_meher', since: '2026-10-05T03:30:00Z' });
    const f2 = await go.next();
    conn.ws.send(JSON.stringify({ jsonrpc: '2.0', id: f2.id, error: { code: 429, message: 'slow down', data: { code: 'rate_limited', retry_after_seconds: 5 } } }));
    const err = await busy.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocketCallError);
    expect(err).toMatchObject({ code: 429, dataCode: 'rate_limited', retryAfterSeconds: 5 });

    await expect(s.request('get_person', { person_id: 'p_kabir' }, { timeoutMs: 50 })).rejects.toBeInstanceOf(SocketTimeoutError);
  });

  it('sends an unanswered request again after a reconnect, with the same id', async () => {
    go = await startGo();
    const s = client();
    const first = await go.connected(1);
    const answer = s.request('card_tap', { tap_id: 'tap_1' }, { timeoutMs: 5000 });
    const sent = await go.next();
    first.ws.terminate();
    const second = await go.connected(2);
    const again = await go.next();
    expect(again.id).toBe(sent.id);
    expect(again.params).toEqual({ tap_id: 'tap_1' });
    second.ws.send(JSON.stringify({ jsonrpc: '2.0', id: again.id, result: { result: 'done' } }));
    await expect(answer).resolves.toEqual({ result: 'done' });
  });

  it('notify sends a frame without an id, and drops it while the socket is down', async () => {
    go = await startGo();
    const s = client();
    await go.connected(1);
    for (let i = 0; i < 100 && !s.isOpen(); i++) await new Promise((r) => setTimeout(r, 10)); // the client's side opens a moment later
    s.notify('typing', { trip_id: 't_goa', on: true });
    const f = await go.next();
    expect(f).toEqual({ jsonrpc: '2.0', method: 'typing', params: { trip_id: 't_goa', on: true } });
    const offline = new GoSocket({ url: 'ws://127.0.0.1:1/v1/socket', secret, handlers: {}, backoffSeconds: [10] });
    expect(() => offline.notify('typing', { trip_id: 't_goa', on: false })).not.toThrow();
    offline.close();
  });
});

describe('GoSocket: answering Go', () => {
  async function ask(conn: { ws: WebSocket }, frame: unknown): Promise<any> {
    conn.ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
    return go.next();
  }

  it('answers through the handlers, with every error the contract names', async () => {
    go = await startGo();
    const seenRaw: unknown[] = [];
    client({
      read_trip: async (p, raw) => { seenRaw.push(raw); return { trip_id: p.trip_id }; },
      add_reaction: async () => {},
      post_message: async () => { throw new Error('database down'); },
      close_vote: async () => { throw new SocketCallError(409, 'decision d_when is already closed', 'conflict'); },
    });
    const conn = await go.connected(1);

    expect(await ask(conn, { jsonrpc: '2.0', id: 'go_1', method: 'read_trip', params: { trip_id: 't_goa', extra: 1 } }))
      .toEqual({ jsonrpc: '2.0', id: 'go_1', result: { trip_id: 't_goa' } });
    expect(seenRaw).toEqual([{ trip_id: 't_goa', extra: 1 }]);

    const reaction = { request_id: 'rq_1', trip_id: 't_goa', message_id: 'm_0122', emoji: '✅' };
    expect(await ask(conn, { jsonrpc: '2.0', id: 'go_2', method: 'add_reaction', params: reaction }))
      .toEqual({ jsonrpc: '2.0', id: 'go_2', result: {} });

    expect(await ask(conn, { jsonrpc: '2.0', id: 'go_3', method: 'launch_rockets', params: {} }))
      .toEqual({ jsonrpc: '2.0', id: 'go_3', error: { code: -32601, message: 'unknown method launch_rockets' } });
    expect(await ask(conn, { jsonrpc: '2.0', id: 'go_4', method: 'open_vote', params: { trip_id: 't_goa' } }))
      .toEqual({ jsonrpc: '2.0', id: 'go_4', error: { code: -32601, message: 'unknown method open_vote' } });

    const bad = await ask(conn, { jsonrpc: '2.0', id: 'go_5', method: 'read_trip', params: {} });
    expect(bad.error).toMatchObject({ code: 422, data: { code: 'invalid' } });
    expect(bad.error.message).toContain('trip_id');

    const crash = await ask(conn, { jsonrpc: '2.0', id: 'go_6', method: 'post_message', params: { request_id: 'rq_2', trip_id: 't_goa', text: 'hi' } });
    expect(crash).toEqual({ jsonrpc: '2.0', id: 'go_6', error: { code: 500, message: 'internal error', data: { code: 'internal' } } });

    const clash = await ask(conn, { jsonrpc: '2.0', id: 'go_7', method: 'close_vote', params: { request_id: 'rq_3', trip_id: 't_goa', decision_id: 'd_when' } });
    expect(clash).toEqual({ jsonrpc: '2.0', id: 'go_7', error: { code: 409, message: 'decision d_when is already closed', data: { code: 'conflict' } } });
  });

  it('answers -32700 with id null for a frame it cannot read', async () => {
    go = await startGo();
    client();
    const conn = await go.connected(1);
    for (const junk of ['not json', 'null', '5', '[1]']) {
      expect(await ask(conn, junk)).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'cannot read the frame' } });
    }
  });

  it('never answers a notification, even a broken one', async () => {
    go = await startGo();
    const typing: unknown[] = [];
    client({ typing: async (p) => { typing.push(p); }, read_trip: async () => ({ ok: 1 }) });
    const conn = await go.connected(1);
    conn.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'typing', params: { trip_id: 't_goa', on: true } }));
    conn.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'typing', params: { on: 'yes' } }));
    // The next frame back is the answer to this request: nothing was sent for the two notifications.
    expect(await ask(conn, { jsonrpc: '2.0', id: 'go_9', method: 'read_trip', params: { trip_id: 't_goa' } })).toMatchObject({ id: 'go_9' });
    expect(typing).toEqual([{ trip_id: 't_goa', on: true }]);
  });
});

describe('GoSocket: keeping it alive', () => {
  it('stays open while Go pings, and closes after the silence limit', async () => {
    go = await startGo();
    client({}, { idleCloseSeconds: 0.3, backoffSeconds: [60] });
    const conn = await go.connected(1);
    const pinger = setInterval(() => conn.ws.ping(), 100);
    await new Promise((r) => setTimeout(r, 600));
    expect(conn.ws.readyState).toBe(conn.ws.OPEN);
    clearInterval(pinger);
    const closed = once(conn.ws, 'close');
    await expect(Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error('still open')), 1500))])).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Push the test and see it fail.** Red is certain: the module does not exist yet. Skip to Step 3.

- [ ] **Step 3: Write the implementation**

```json
// packages/sim/package.json
{
  "name": "@go/sim",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@go/contract": "workspace:*",
    "ws": "^8.18.3",
    "zod": "4.3.6"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@types/ws": "^8.18.1",
    "tsx": "^4.21.0",
    "typescript": "^5.5.0",
    "vitest": "^4.0.17"
  }
}
```

(JSON has no comments: the first line above only names the file; do not paste it.)

```json
// packages/sim/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "src/**/__tests__/**"]
}
```

```ts
// packages/sim/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
  },
});
```

```ts
// packages/sim/src/index.ts
export { GoSocket, SocketCallError, SocketTimeoutError, type GoSocketOptions, type Handler } from './server-socket.js';
```

```ts
// packages/sim/src/server-socket.ts
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
```

Then update the lockfile (not a test run):

```bash
cd ~/workspace/agents/go-brain-worktrees/<your-worktree> && pnpm install
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add packages/sim/package.json packages/sim/tsconfig.json packages/sim/vitest.config.ts packages/sim/src/index.ts packages/sim/src/server-socket.ts packages/sim/src/__tests__/server-socket.test.ts pnpm-lock.yaml
git commit -m "feat(sim): the Server's end of the socket, as a reference client for the Server team

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `server-socket.test.ts` passes (9 tests); the contract's tests still pass; `pnpm build` builds `@go/sim`.

---
### Task 2: The Goa trip fixture and the test spend key

The Goa trip from the guide is the trip every test, the smoke script and the dev room use. `GOA_SNAPSHOT` is the `read_trip` example in `docs/guide/04-gos-requests.md` (change 113, mid-planning), checked against the guide byte for byte in a test so the two can never drift. `goaFreshTrip()` is the same five people at change 1, the way `trip.created` carries a brand new trip. The test key is the contract's published TEST key, copied so the sim can sign spend approvals without reading files at run time; a test proves the copy matches the vector.

**Files:**
- Create: `packages/sim/src/goa.ts`
- Create: `packages/sim/src/test-spend-key.ts`
- Modify: `packages/sim/src/index.ts` (export the fixture and the key)
- Test: `packages/sim/src/__tests__/goa.test.ts`

**Interfaces:**
- Consumes: `@go/contract`: `type TripSnapshot`; in the test, `TripSnapshot`, `signSpendApproval`, `verifySpendApproval`.
- Produces:
  - `const GOA_TRIP_ID = 't_goa'`
  - `const GOA_PEOPLE: { rahul: 'p_rahul'; priya: 'p_priya'; arjun: 'p_arjun'; meher: 'p_meher'; kabir: 'p_kabir' }`
  - `const GOA_SNAPSHOT: TripSnapshot`
  - `function goaFreshTrip(): TripSnapshot` (a new copy each call, `seq: 1`)
  - `const GOA_SEED_CHAT: ReadonlyArray<{ personId: string; text: string }>` (six lines; only the last is for Go)
  - `const TEST_SPEND_PRIVATE_KEY_PEM: string`, `const TEST_SPEND_PUBLIC_KEY_PEM: string`

- [ ] **Step 1: Write the failing test**

```ts
// packages/sim/src/__tests__/goa.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TripSnapshot, signSpendApproval, verifySpendApproval } from '@go/contract';
import { GOA_PEOPLE, GOA_SEED_CHAT, GOA_SNAPSHOT, GOA_TRIP_ID, goaFreshTrip } from '../goa.js';
import { TEST_SPEND_PRIVATE_KEY_PEM, TEST_SPEND_PUBLIC_KEY_PEM } from '../test-spend-key.js';

function guideSnapshot(): unknown {
  const md = readFileSync(new URL('../../../../docs/guide/04-gos-requests.md', import.meta.url), 'utf8');
  const block = md.match(/<!-- schema: TripSnapshot -->\s*```json\n([\s\S]*?)\n```/);
  if (!block?.[1]) throw new Error('the TripSnapshot example is missing from the guide');
  return JSON.parse(block[1]);
}

describe('the Goa trip', () => {
  it('is exactly the read_trip example in the guide', () => {
    expect(GOA_SNAPSHOT).toEqual(guideSnapshot());
  });

  it('passes the contract, as it is and fresh', () => {
    expect(TripSnapshot.parse(GOA_SNAPSHOT)).toEqual(GOA_SNAPSHOT);
    const fresh = goaFreshTrip();
    expect(TripSnapshot.parse(fresh)).toEqual(fresh);
  });

  it('starts fresh at change 1 with the same five people and nothing decided', () => {
    const fresh = goaFreshTrip();
    expect(fresh.trip_id).toBe(GOA_TRIP_ID);
    expect(fresh.seq).toBe(1);
    expect(fresh.people.map((p) => p.person_id)).toEqual(Object.values(GOA_PEOPLE));
    expect(fresh.decisions).toEqual([]);
    expect(fresh.bookings).toEqual([]);
    expect(fresh.expenses).toEqual([]);
    expect(fresh.record).toEqual([]);
    expect(fresh.money).toEqual({ currency: 'INR', plan_minor: null, spent_minor: 0, by_category: [], transfers: [] });
    expect(fresh.budget).toEqual({ lowest: null, answered: 0, of: 5 });
  });

  it('hands out a new copy each time', () => {
    const a = goaFreshTrip();
    a.title = 'Changed';
    expect(goaFreshTrip().title).toBe('Goa 🌴');
    expect(GOA_SNAPSHOT.title).toBe('Goa 🌴');
  });

  it('has a seed chat from people in the trip, with only the last line for Go', () => {
    const ids = new Set<string>(Object.values(GOA_PEOPLE));
    for (const line of GOA_SEED_CHAT) expect(ids.has(line.personId)).toBe(true);
    expect(GOA_SEED_CHAT.filter((l) => /@go\b/i.test(l.text))).toEqual([GOA_SEED_CHAT[GOA_SEED_CHAT.length - 1]]);
    for (const line of GOA_SEED_CHAT) expect(line.text).not.toContain('\u2014');
  });
});

describe('the test spend key', () => {
  const vectors = JSON.parse(readFileSync(new URL('../../../contract/test-vectors/spend-approval.json', import.meta.url), 'utf8')) as {
    private_key_pem: string; public_key_pem: string; claims: Parameters<typeof signSpendApproval>[0]; token: string; verify_at: number;
  };

  it('is the contract test vector key, and reproduces its token', () => {
    expect(TEST_SPEND_PRIVATE_KEY_PEM).toBe(vectors.private_key_pem);
    expect(TEST_SPEND_PUBLIC_KEY_PEM).toBe(vectors.public_key_pem);
    expect(signSpendApproval(vectors.claims, TEST_SPEND_PRIVATE_KEY_PEM)).toBe(vectors.token);
    expect(verifySpendApproval(vectors.token, TEST_SPEND_PUBLIC_KEY_PEM, vectors.verify_at)).toMatchObject({ ok: true });
  });
});
```

- [ ] **Step 2: Push the test and see it fail.** Red is certain: the modules do not exist yet. Skip to Step 3.

- [ ] **Step 3: Write the implementation**

```ts
// packages/sim/src/test-spend-key.ts
// The contract's TEST Ed25519 key pair, from packages/contract/test-vectors/spend-approval.json.
// TEST KEY ONLY. The simulator signs spend approvals with it in development and tests. The real Server
// signs with its own GO_SPEND_PRIVATE_KEY, which never appears in any repo.
export const TEST_SPEND_PRIVATE_KEY_PEM =
  '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH\n-----END PRIVATE KEY-----\n';
export const TEST_SPEND_PUBLIC_KEY_PEM =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=\n-----END PUBLIC KEY-----\n';
```

```ts
// packages/sim/src/goa.ts
// The Goa trip from the guide: Rahul, Priya, Arjun, Meher and Kabir plan a long weekend in North Goa.
import type { TripSnapshot } from '@go/contract';

export const GOA_TRIP_ID = 't_goa';

export const GOA_PEOPLE = {
  rahul: 'p_rahul',
  priya: 'p_priya',
  arjun: 'p_arjun',
  meher: 'p_meher',
  kabir: 'p_kabir',
} as const;

/** The trip in the middle of planning, at change 113: the read_trip example in docs/guide/04-gos-requests.md. */
export const GOA_SNAPSHOT: TripSnapshot = {
  "trip_id": "t_goa",
  "seq": 113,
  "title": "Goa 🌴",
  "status": "planning",
  "created_at": "2026-10-05T02:30:00Z",
  "organizer_person_id": "p_rahul",
  "invite_url": "https://go.example/j/8fK2xQ",
  "destination": {
    "name": "North Goa",
    "lat": 15.6,
    "lng": 73.75,
    "photo_url": "https://brain.go.example/img/north-goa.jpg"
  },
  "dates": {
    "start": "2026-11-06",
    "end": "2026-11-09"
  },
  "vibe": [
    "beaches",
    "food",
    "sunsets"
  ],
  "stay": "villa with a pool",
  "budget": {
    "lowest": {
      "min_minor": 1000000,
      "max_minor": 1500000,
      "currency": "INR"
    },
    "answered": 4,
    "of": 5
  },
  "people": [
    {
      "person_id": "p_rahul",
      "name": "Rahul",
      "photo_url": "https://cdn.go.example/people/p_rahul.jpg",
      "role": "organizer",
      "joined_at": "2026-10-05T02:30:00Z",
      "from_city": "Delhi",
      "earliest_leave": "Fri after 6 pm",
      "know": [],
      "has_upi": true,
      "go_paused": false
    },
    {
      "person_id": "p_priya",
      "name": "Priya",
      "photo_url": "https://cdn.go.example/people/p_priya.jpg",
      "role": "member",
      "joined_at": "2026-10-05T02:48:00Z",
      "from_city": "Delhi",
      "know": [
        "Vegetarian",
        "Window seat"
      ],
      "has_upi": false,
      "go_paused": false
    },
    {
      "person_id": "p_arjun",
      "name": "Arjun",
      "photo_url": "https://cdn.go.example/people/p_arjun.jpg",
      "role": "member",
      "joined_at": "2026-10-05T03:02:00Z",
      "from_city": "Bangalore",
      "know": [
        "No early flights",
        "Lands late on Friday"
      ],
      "has_upi": false,
      "go_paused": false
    },
    {
      "person_id": "p_meher",
      "name": "Meher",
      "photo_url": "https://cdn.go.example/people/p_meher.jpg",
      "role": "member",
      "joined_at": "2026-10-05T03:15:00Z",
      "from_city": "Mumbai",
      "know": [
        "Birthday on 7 Nov"
      ],
      "has_upi": false,
      "go_paused": false
    },
    {
      "person_id": "p_kabir",
      "name": "Kabir",
      "photo_url": "https://cdn.go.example/people/p_kabir.jpg",
      "role": "member",
      "joined_at": "2026-10-05T03:40:00Z",
      "from_city": "Delhi",
      "earliest_leave": "Fri evening",
      "know": [
        "I don't drink"
      ],
      "has_upi": true,
      "go_paused": false
    }
  ],
  "decisions": [
    {
      "decision_id": "d_when",
      "question": "When do we go?",
      "kind": "choice",
      "anonymous": false,
      "status": "closed",
      "options": [
        {
          "label": "30 Oct to 2 Nov"
        },
        {
          "label": "6 to 9 Nov",
          "note": "Diwali long weekend"
        },
        {
          "label": "13 to 16 Nov"
        }
      ],
      "voted": 4,
      "of": 5,
      "tally": [
        0,
        4,
        0
      ],
      "votes": [
        {
          "person_id": "p_rahul",
          "option_index": 1
        },
        {
          "person_id": "p_priya",
          "option_index": 1
        },
        {
          "person_id": "p_arjun",
          "option_index": 1
        },
        {
          "person_id": "p_meher",
          "option_index": 1
        }
      ],
      "result_index": 1,
      "opened_at": "2026-10-05T02:30:30Z",
      "closed_at": "2026-10-05T03:45:00Z"
    },
    {
      "decision_id": "d_villa",
      "question": "Where do we stay?",
      "kind": "choice",
      "anonymous": false,
      "status": "closed",
      "options": [
        {
          "label": "Villa Sol",
          "image_url": "https://brain.go.example/img/villa-sol.jpg",
          "price_minor": 5420000,
          "currency": "INR",
          "option_ref": "ixigo:stay:villa-sol-anjuna",
          "note": "3 nights, private pool, Anjuna"
        },
        {
          "label": "Casa Azul",
          "image_url": "https://brain.go.example/img/casa-azul.jpg",
          "price_minor": 6180000,
          "currency": "INR",
          "option_ref": "ixigo:stay:casa-azul-assagao",
          "note": "3 nights, pool, Assagao"
        },
        {
          "label": "The Palms",
          "image_url": "https://brain.go.example/img/the-palms.jpg",
          "price_minor": 5850000,
          "currency": "INR",
          "option_ref": "ixigo:stay:the-palms-vagator",
          "note": "3 nights, pool, near Vagator beach"
        }
      ],
      "closes_at": "2026-10-05T12:30:00Z",
      "voted": 5,
      "of": 5,
      "tally": [
        4,
        1,
        0
      ],
      "votes": [
        {
          "person_id": "p_rahul",
          "option_index": 0
        },
        {
          "person_id": "p_arjun",
          "option_index": 1
        },
        {
          "person_id": "p_priya",
          "option_index": 0
        },
        {
          "person_id": "p_meher",
          "option_index": 0
        },
        {
          "person_id": "p_kabir",
          "option_index": 0
        }
      ],
      "result_index": 0,
      "mandate": {
        "choice_index": 0,
        "cap_minor": 5500000,
        "currency": "INR",
        "refundable_only": true,
        "payer_person_id": "p_rahul",
        "set_at": "2026-10-05T08:46:00Z",
        "confirmed_at": "2026-10-05T08:58:00Z"
      },
      "opened_at": "2026-10-05T07:30:00Z",
      "closed_at": "2026-10-05T08:45:00Z"
    },
    {
      "decision_id": "d_beach",
      "question": "Which beach on Sunday?",
      "kind": "choice",
      "anonymous": false,
      "status": "cancelled",
      "opened_by_person_id": "p_rahul",
      "options": [
        {
          "label": "Ashwem"
        },
        {
          "label": "Morjim"
        }
      ],
      "voted": 2,
      "of": 5,
      "tally": [
        1,
        1
      ],
      "votes": [
        {
          "person_id": "p_rahul",
          "option_index": 0
        },
        {
          "person_id": "p_meher",
          "option_index": 1
        }
      ],
      "opened_at": "2026-10-06T09:40:00Z"
    }
  ],
  "bookings": [
    {
      "booking_id": "b_villa",
      "kind": "stay",
      "status": "confirmed",
      "title": "Villa Sol, 3 nights",
      "vendor": "ixigo",
      "ref": "IXG-7Q2K9",
      "amount_minor": 5420000,
      "currency": "INR",
      "payer_person_id": "p_rahul",
      "for_person_ids": [
        "p_rahul",
        "p_priya",
        "p_arjun",
        "p_meher",
        "p_kabir"
      ],
      "refundable_until": "2026-11-01T18:29:59Z",
      "starts_at": "2026-11-06T14:00:00+05:30",
      "ends_at": "2026-11-09T11:00:00+05:30",
      "place": {
        "name": "Villa Sol",
        "address": "Anjuna, North Goa",
        "photo_url": "https://brain.go.example/img/villa-sol.jpg"
      },
      "image_url": "https://brain.go.example/img/villa-sol.jpg",
      "decision_id": "d_villa",
      "approval_id": "ap_01JA7Q3V8Z",
      "created_at": "2026-10-05T09:03:00Z"
    }
  ],
  "expenses": [
    {
      "expense_id": "e_villa",
      "paid_by_person_id": "p_rahul",
      "amount_minor": 5420000,
      "currency": "INR",
      "note": "Villa Sol, 3 nights",
      "category": "stay",
      "split_person_ids": [
        "p_rahul",
        "p_priya",
        "p_arjun",
        "p_meher",
        "p_kabir"
      ],
      "booking_id": "b_villa",
      "created_at": "2026-10-05T09:03:20Z"
    },
    {
      "expense_id": "e_cab",
      "paid_by_person_id": "p_kabir",
      "amount_minor": 340000,
      "currency": "INR",
      "note": "Airport cab",
      "category": "getting_around",
      "split_person_ids": [
        "p_rahul",
        "p_priya",
        "p_arjun",
        "p_meher",
        "p_kabir"
      ],
      "added_by_person_id": "p_kabir",
      "created_at": "2026-10-09T13:20:00Z"
    }
  ],
  "money": {
    "currency": "INR",
    "plan_minor": 7500000,
    "spent_minor": 5760000,
    "by_category": [
      {
        "category": "stay",
        "amount_minor": 5420000
      },
      {
        "category": "getting_around",
        "amount_minor": 340000
      }
    ],
    "transfers": [
      {
        "from_person_id": "p_priya",
        "to_person_id": "p_rahul",
        "amount_minor": 1152000,
        "currency": "INR"
      },
      {
        "from_person_id": "p_arjun",
        "to_person_id": "p_rahul",
        "amount_minor": 1152000,
        "currency": "INR"
      },
      {
        "from_person_id": "p_meher",
        "to_person_id": "p_rahul",
        "amount_minor": 1152000,
        "currency": "INR"
      },
      {
        "from_person_id": "p_kabir",
        "to_person_id": "p_rahul",
        "amount_minor": 812000,
        "currency": "INR"
      }
    ]
  },
  "itinerary": [
    {
      "date": "2026-11-06",
      "title": "Arrive",
      "items": [
        {
          "item_id": "i_land",
          "time": "20:45",
          "title": "Land in Goa on IndiGo 6E 2134",
          "category": "getting_around",
          "status": "planned",
          "note": "Rahul, Priya and Kabir from Delhi. Flights not booked yet."
        },
        {
          "item_id": "i_cab",
          "time": "21:15",
          "title": "Airport cab to Villa Sol",
          "category": "getting_around",
          "status": "booked",
          "note": "Kabir booked it"
        },
        {
          "item_id": "i_checkin",
          "time": "22:30",
          "title": "Check in at Villa Sol",
          "category": "stay",
          "place": {
            "name": "Villa Sol",
            "address": "Anjuna, North Goa"
          },
          "booking_id": "b_villa",
          "status": "booked",
          "note": "Arjun checks in at 11 pm. Mohan, the caretaker, meets him."
        }
      ]
    },
    {
      "date": "2026-11-07",
      "title": "Meher's birthday",
      "items": [
        {
          "item_id": "i_brunch",
          "time": "11:00",
          "title": "Brunch at Artjuna",
          "category": "food",
          "place": {
            "name": "Artjuna",
            "address": "Anjuna, North Goa"
          },
          "status": "idea"
        },
        {
          "item_id": "i_sunset",
          "time": "17:30",
          "title": "Sunset at Chapora Fort",
          "category": "activities",
          "place": {
            "name": "Chapora Fort",
            "address": "Chapora, North Goa"
          },
          "status": "planned"
        },
        {
          "item_id": "i_dinner",
          "time": "20:30",
          "title": "Birthday dinner at Thalassa",
          "category": "food",
          "place": {
            "name": "Thalassa",
            "address": "Siolim, North Goa"
          },
          "status": "idea",
          "note": "Plenty for Priya (vegetarian)"
        }
      ]
    }
  ],
  "record": [
    {
      "line_id": "r_dates",
      "kind": "decided",
      "text": "6 to 9 Nov",
      "status": "active",
      "proof": [],
      "person_ids": [],
      "decision_id": "d_when",
      "source": "vote",
      "created_at": "2026-10-05T03:45:00Z",
      "updated_at": "2026-10-05T03:45:00Z"
    },
    {
      "line_id": "r_north",
      "kind": "agreed",
      "text": "North Goa, not South",
      "status": "active",
      "proof": [
        {
          "message_id": "m_0122",
          "person_id": "p_priya"
        },
        {
          "message_id": "m_0124",
          "person_id": "p_arjun"
        }
      ],
      "person_ids": [
        "p_priya",
        "p_arjun",
        "p_rahul"
      ],
      "source": "go",
      "created_at": "2026-10-05T04:14:00Z",
      "updated_at": "2026-10-05T04:14:00Z"
    },
    {
      "line_id": "r_scuba",
      "kind": "open",
      "text": "Scuba on Saturday?",
      "status": "active",
      "proof": [
        {
          "message_id": "m_0149",
          "person_id": "p_arjun"
        }
      ],
      "person_ids": [
        "p_meher",
        "p_kabir"
      ],
      "source": "go",
      "created_at": "2026-10-05T07:20:00Z",
      "updated_at": "2026-10-05T07:20:00Z"
    },
    {
      "line_id": "r_villa",
      "kind": "booked",
      "text": "Villa Sol, 3 nights",
      "status": "active",
      "proof": [],
      "person_ids": [],
      "decision_id": "d_villa",
      "booking_id": "b_villa",
      "source": "booking",
      "created_at": "2026-10-05T08:45:00Z",
      "updated_at": "2026-10-05T09:03:00Z"
    },
    {
      "line_id": "r_cab",
      "kind": "doing",
      "text": "Kabir books the airport cab",
      "status": "done",
      "proof": [
        {
          "message_id": "m_0192",
          "person_id": "p_kabir"
        }
      ],
      "person_ids": [
        "p_kabir"
      ],
      "source": "go",
      "created_at": "2026-10-05T11:05:00Z",
      "updated_at": "2026-10-09T13:20:30Z"
    },
    {
      "line_id": "r_deposit",
      "kind": "open",
      "text": "₹2,000 off at Villa Sol if we pay the deposit this week?",
      "status": "active",
      "proof": [
        {
          "message_id": "m_0174"
        }
      ],
      "person_ids": [
        "p_rahul"
      ],
      "due_at": "2026-10-11T18:29:59Z",
      "source": "go",
      "created_at": "2026-10-06T10:36:00Z",
      "updated_at": "2026-10-06T10:36:00Z"
    }
  ]
};

/** The same five people at the very start of the trip, as trip.created (change 1) carries it. A new copy each call. */
export function goaFreshTrip(): TripSnapshot {
  const s = structuredClone(GOA_SNAPSHOT);
  return {
    ...s,
    seq: 1,
    destination: { name: 'Goa' },
    dates: null,
    budget: { lowest: null, answered: 0, of: s.people.length },
    decisions: [],
    bookings: [],
    expenses: [],
    money: { currency: 'INR', plan_minor: null, spent_minor: 0, by_category: [], transfers: [] },
    itinerary: [],
    record: [],
  };
}

/** A few lines of chat to start a room with. Only the last one is for Go. */
export const GOA_SEED_CHAT: ReadonlyArray<{ personId: string; text: string }> = [
  { personId: GOA_PEOPLE.rahul, text: 'Goa for the Diwali long weekend? 6 to 9 Nov' },
  { personId: GOA_PEOPLE.priya, text: "Let's do North Goa, not South. Better beaches for us." },
  { personId: GOA_PEOPLE.arjun, text: "Yes, North. It's closer to the airport for my late flight too." },
  { personId: GOA_PEOPLE.priya, text: "I'm veg btw" },
  { personId: GOA_PEOPLE.kabir, text: 'haha Arjun always lands late 😂' },
  { personId: GOA_PEOPLE.priya, text: '@Go flights on Friday from Delhi, under 6k?' },
];
```

```ts
// packages/sim/src/index.ts
export { GoSocket, SocketCallError, SocketTimeoutError, type GoSocketOptions, type Handler } from './server-socket.js';
export { GOA_PEOPLE, GOA_SEED_CHAT, GOA_SNAPSHOT, GOA_TRIP_ID, goaFreshTrip } from './goa.js';
export { TEST_SPEND_PRIVATE_KEY_PEM, TEST_SPEND_PUBLIC_KEY_PEM } from './test-spend-key.js';
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add packages/sim/src/goa.ts packages/sim/src/test-spend-key.ts packages/sim/src/index.ts packages/sim/src/__tests__/goa.test.ts
git commit -m "feat(sim): the Goa trip from the guide, fresh and mid-planning, and the test spend key

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `goa.test.ts` passes (6 tests), including the byte-for-byte match with the guide's example.

---
### Task 3: The fake Go's socket (`apps/fake-go`: upgrade, keepalive, answers, `send_event`, health, frames page)

This task builds Go's side of the socket with no behaviour yet: the signature check before the upgrade (each `(t, v1)` once, in memory), pings and the silence limit, JSON-RPC answers with every error the contract names, `send_event` with unknown types accepted before validation and repeats answered `duplicate: true`, Go's own requests sent on the newest open socket and resent with the same id on the next one, `GET /v1/health`, the frames page, and the two pages the fake Go's links open. Task 4 plugs the behaviour in through `behaviour(link)`.

Decision (ambiguity 3 in the research): an unknown event type's `event_id` is remembered too, so its repeat answers `duplicate: true`. It is harmless and keeps one rule for every event.

**Files:**
- Create: `apps/fake-go/package.json`
- Create: `apps/fake-go/tsconfig.json`
- Create: `apps/fake-go/vitest.config.ts`
- Create: `apps/fake-go/src/signature-guard.ts`
- Create: `apps/fake-go/src/frames.ts`
- Create: `apps/fake-go/src/link.ts`
- Create: `apps/fake-go/src/server.ts`
- Test: `apps/fake-go/src/__tests__/server.test.ts`
- Modify: `pnpm-lock.yaml` (written by `pnpm install`)

**Interfaces:**
- Consumes: `@go/contract`: `verifyRequest`, `MAX_SKEW_SECONDS`, `parseParams`, `Event`, `TO_GO`, `CONTRACT_VERSION`, `SOCKET_PATH`, `SIGNATURE_HEADER`, `PING_INTERVAL_SECONDS`, `IDLE_CLOSE_SECONDS`, `MAX_FRAME_BYTES`. `@go/sim` (Task 1): `SocketCallError`, `SocketTimeoutError`; in tests `GoSocket`.
- Produces:
  - `class SignatureGuard { constructor(secret: string); check(header: string | string[] | undefined, target: string, nowSeconds: number): GuardResult }`, `type GuardResult = { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'stale' | 'mismatch' | 'replayed'; message: string }`
  - `class FrameLog { constructor(max?: number, now?: () => Date); add(direction: 'in' | 'out', instance: string, text: string): void; list(): FrameRecord[] }`, `function renderFrames(items: FrameRecord[]): string`
  - `class Link { attach(ws, instance): void; detach(ws): void; isOpen(): boolean; instances(): string[]; request(method: string, params: object, timeoutMs?: number): Promise<Record<string, unknown>>; notify(method: string, params: object): void; settle(frame): void; send(ws, body: object): void }`
  - `type ToGoHandler = (params: any, meta: { instance: string }) => Promise<object>`
  - `interface Behaviour { handlers: Partial<Record<string, ToGoHandler>>; onEvent?: (event: Event) => void | Promise<void> }`
  - `interface FakeGoOptions { secret; adminToken; behaviour?: (link: Link) => Behaviour; now?; pingIntervalMs?; idleCloseMs?; log? }`
  - `function buildFakeGo(opts: FakeGoOptions): FakeGo` with `FakeGo = { app: FastifyInstance; link: Link; frames: FrameLog; close(): Promise<void> }`
  - `const KNOWN_EVENT_TYPES: ReadonlySet<string>`

- [ ] **Step 1: Write the failing test**

```ts
// apps/fake-go/src/__tests__/server.test.ts
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ErrorBody, Health, signRequest } from '@go/contract';
import { GoSocket, SocketCallError, type Handler } from '@go/sim';
import { KNOWN_EVENT_TYPES, buildFakeGo, type FakeGo, type FakeGoOptions } from '../server.js';

const secret = 'fake-go-test-secret-0123456789abcdef';
const adminToken = 'admin-token-for-tests-0001';
const at = '2026-10-05T06:49:00Z';

let fake: FakeGo | undefined;
const sockets: GoSocket[] = [];
const raws: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const r of raws.splice(0)) r.terminate();
  await fake?.close();
  fake = undefined;
});

async function start(extra: Partial<FakeGoOptions> = {}): Promise<number> {
  fake = buildFakeGo({ secret, adminToken, ...extra });
  await fake.app.listen({ port: 0, host: '127.0.0.1' });
  return (fake.app.server.address() as AddressInfo).port;
}

const sign = (target: string, t?: number): string => signRequest({ method: 'GET', target, body: '' }, secret, t);

/** Opens a raw socket. Resolves with the open socket and the frames it gets, or with the refusal's status and body. */
function tryConnect(port: number, target: string, headers: Record<string, string>, extra: WebSocket.ClientOptions = {}) {
  return new Promise<{ ws: WebSocket; frames: any[] } | { status: number; body: string }>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${target}`, { headers, ...extra });
    const frames: any[] = [];
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
    ws.on('open', () => { raws.push(ws); resolve({ ws, frames }); });
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    ws.on('error', () => {});
  });
}

async function openRaw(port: number, instance: string, extra: WebSocket.ClientOptions = {}) {
  const target = `/v1/socket?instance=${instance}`;
  const r = await tryConnect(port, target, { 'x-go-signature': sign(target) }, extra);
  if (!('ws' in r)) throw new Error(`refused: ${r.status} ${r.body}`);
  return r;
}

async function until<T>(check: () => T | undefined | false, ms = 2000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() - started > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The Server's end, as the Server team will run it: @go/sim's GoSocket. */
async function serverSide(port: number, instance: string, handlers: Record<string, Handler> = {}): Promise<GoSocket> {
  let opened!: () => void;
  const ready = new Promise<void>((r) => (opened = r));
  const sock = new GoSocket({ url: `ws://127.0.0.1:${port}/v1/socket?instance=${instance}`, secret, handlers, onOpen: () => opened() });
  sockets.push(sock);
  sock.start();
  await ready;
  return sock;
}

function priyaAsks(eventId: string) {
  return {
    event_id: eventId, trip_id: 't_goa', seq: 57, occurred_at: at, type: 'message.created',
    data: {
      message: {
        message_id: 'm_0132', seq: 57, updated_seq: 57, author: { kind: 'person', person_id: 'p_priya' },
        text: '@Go flights on Friday from Delhi, under 6k?', attachments: [], mentions_go: true, mentions: [], reactions: [],
        withheld: false, deleted: false, sent_at: at,
      },
    },
  };
}

describe('the upgrade', () => {
  it('refuses a missing, malformed, stale or wrong signature with 401 and an ErrorBody', async () => {
    const port = await start();
    const t = '/v1/socket';
    const cases: Array<Record<string, string>> = [
      {},
      { 'x-go-signature': 'nonsense' },
      { 'x-go-signature': sign(t, Math.floor(Date.now() / 1000) - 1000) },
      { 'x-go-signature': signRequest({ method: 'GET', target: t, body: '' }, 'another-secret-another-secret-00') },
    ];
    for (const headers of cases) {
      const r = await tryConnect(port, t, headers);
      expect(r).toMatchObject({ status: 401 });
      if ('status' in r) expect(ErrorBody.parse(JSON.parse(r.body)).error.code).toBe('bad_signature');
    }
  });

  it('accepts a signature once; the same signature again is refused, in any field order', async () => {
    const port = await start();
    const target = '/v1/socket?instance=once';
    const header = sign(target);
    expect('ws' in (await tryConnect(port, target, { 'x-go-signature': header }))).toBe(true);
    const again = await tryConnect(port, target, { 'x-go-signature': header });
    expect(again).toMatchObject({ status: 401 });
    if ('status' in again) expect(JSON.parse(again.body)).toEqual({ error: { code: 'bad_signature', message: 'signature already used' } });
    const [tPart, vPart] = header.split(',');
    expect(await tryConnect(port, target, { 'x-go-signature': `${vPart},${tPart}` })).toMatchObject({ status: 401 });
  });

  it('needs the query string signed, and opens nothing on other paths', async () => {
    const port = await start();
    expect(await tryConnect(port, '/v1/socket?instance=x', { 'x-go-signature': sign('/v1/socket') })).toMatchObject({ status: 401 });
    expect(await tryConnect(port, '/v2/socket', { 'x-go-signature': sign('/v2/socket') })).toMatchObject({ status: 404 });
  });
});

describe('health and pages', () => {
  it('answers health without a signature', async () => {
    await start();
    const res = await fake!.app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(Health.parse(res.json())).toEqual({ ok: true, contract: '1.0.0' });
  });

  it('shows the last frames only with the admin token', async () => {
    const port = await start();
    const sock = await serverSide(port, 'frames');
    await sock.request('send_event', priyaAsks('ev_frames'));
    expect((await fake!.app.inject({ method: 'GET', url: '/frames' })).statusCode).toBe(401);
    expect((await fake!.app.inject({ method: 'GET', url: '/frames?token=wrong' })).statusCode).toBe(401);
    const page = await fake!.app.inject({ method: 'GET', url: `/frames?token=${adminToken}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('send_event');
    expect(page.body).toContain('Server to Go');
    expect(page.body).toContain('Go to Server');
    expect(page.body).not.toContain('\u2014');
  });

  it('serves the pages its watch and vault links open', async () => {
    await start();
    for (const kind of ['watch', 'vault']) {
      const res = await fake!.app.inject({ method: 'GET', url: `/fake/page/${kind}?card=c_1` });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('This is the fake Go');
      expect(res.body).not.toContain('\u2014');
    }
  });
});

describe('send_event', () => {
  it('accepts an event type it does not know before checking anything else, and remembers its event_id', async () => {
    const seen: unknown[] = [];
    const port = await start({ behaviour: () => ({ handlers: {}, onEvent: (e) => { seen.push(e); } }) });
    const sock = await serverSide(port, 'unknown');
    const odd = { event_id: 'ev_odd', trip_id: 't_goa', seq: 9, occurred_at: at, type: 'trip.exploded', data: { boom: true } };
    expect(await sock.request('send_event', odd)).toEqual({ accepted: true, duplicate: false });
    expect(await sock.request('send_event', odd)).toEqual({ accepted: true, duplicate: true });
    expect(await sock.request('send_event', { type: 'trip.renamed_later' })).toEqual({ accepted: true, duplicate: false });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([]);
  });

  it('refuses a broken event of a known type with 422 invalid', async () => {
    const port = await start();
    const sock = await serverSide(port, 'broken');
    const err = await sock.request('send_event', { ...priyaAsks('ev_broken'), seq: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocketCallError);
    expect(err).toMatchObject({ code: 422, dataCode: 'invalid' });
  });

  it('does each event once: a repeat in a new frame answers duplicate and does nothing', async () => {
    const seen: string[] = [];
    const port = await start({ behaviour: () => ({ handlers: {}, onEvent: (e) => { seen.push(e.event_id); } }) });
    const sock = await serverSide(port, 'dupes');
    expect(await sock.request('send_event', priyaAsks('ev_0057'))).toEqual({ accepted: true, duplicate: false });
    expect(await sock.request('send_event', priyaAsks('ev_0057'))).toEqual({ accepted: true, duplicate: true });
    await until(() => seen.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(['ev_0057']);
  });

  it('knows all 20 event types of the contract', () => {
    expect(KNOWN_EVENT_TYPES.size).toBe(20);
    expect(KNOWN_EVENT_TYPES.has('message.created')).toBe(true);
    expect(KNOWN_EVENT_TYPES.has('expense.changed')).toBe(true);
  });
});

describe("the Server's other requests", () => {
  it("answers -32601 for a method it does not handle, including Go's own method names", async () => {
    const port = await start({ behaviour: () => ({ handlers: { get_person: async (p) => ({ person_id: p.person_id, carry_over: false, facts: [] }) } }) });
    const sock = await serverSide(port, 'unknown-methods');
    const calls: Array<[string, object]> = [['launch_rockets', {}], ['read_trip', { trip_id: 't_goa' }], ['catch_up', { trip_id: 't_goa', person_id: 'p_meher', since: at }]];
    for (const [method, params] of calls) {
      const err = await sock.request(method, params).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SocketCallError);
      expect(err).toMatchObject({ code: -32601, dataCode: undefined });
    }
  });

  it('checks params, then answers with the handler, or 500 when the handler fails', async () => {
    const port = await start({
      behaviour: () => ({
        handlers: {
          get_person: async (p) => ({ person_id: p.person_id, carry_over: false, facts: [] }),
          update_person: async () => { throw new Error('boom'); },
        },
      }),
    });
    const sock = await serverSide(port, 'handlers');
    expect(await sock.request('get_person', { person_id: 'p_kabir' })).toEqual({ person_id: 'p_kabir', carry_over: false, facts: [] });
    expect(await sock.request('get_person', {}).catch((e: unknown) => e)).toMatchObject({ code: 422, dataCode: 'invalid' });
    expect(await sock.request('update_person', { person_id: 'p_kabir', carry_over: true }).catch((e: unknown) => e))
      .toMatchObject({ code: 500, dataCode: 'internal' });
  });

  it('answers -32700 with id null for a frame it cannot read', async () => {
    const port = await start();
    const { ws, frames } = await openRaw(port, 'junk');
    ws.send('not json');
    ws.send('[1,2]');
    await until(() => frames.length === 2);
    for (const f of frames) expect(f).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'cannot read the frame' } });
  });
});

describe("Go's requests to the Server", () => {
  it('go out with go_ ids and resolve with the answer; both frames land in the frames log', async () => {
    const port = await start();
    await serverSide(port, 'reads', { read_trip: async (p) => ({ trip_id: p.trip_id, seen: true }) });
    expect(await fake!.link.request('read_trip', { trip_id: 't_goa' })).toEqual({ trip_id: 't_goa', seen: true });
    const out = fake!.frames.list().find((f) => f.direction === 'out' && f.text.includes('read_trip'));
    expect(JSON.parse(out!.text).id).toMatch(/^go_/);
    expect(fake!.frames.list().some((f) => f.direction === 'in' && f.text.includes('"seen":true'))).toBe(true);
  });

  it('go again on the next socket, with the same id, when their socket drops before the answer', async () => {
    const port = await start();
    const first = await openRaw(port, 'one');
    const answer = fake!.link.request('read_trip', { trip_id: 't_goa' }, 5000);
    await until(() => first.frames.length === 1);
    const sent = first.frames[0];
    first.ws.terminate();
    const second = await openRaw(port, 'two');
    await until(() => second.frames.length === 1);
    expect(second.frames[0]).toEqual(sent);
    second.ws.send(JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { trip_id: 't_goa' } }));
    await expect(answer).resolves.toEqual({ trip_id: 't_goa' });
  });
});

describe('keeping the socket alive', () => {
  // Short intervals instead of fake timers: real sockets and faked timers do not mix well.
  it('pings on the interval and keeps a socket that answers open', async () => {
    const port = await start({ pingIntervalMs: 50, idleCloseMs: 200 });
    const { ws } = await openRaw(port, 'pinged');
    let pings = 0;
    ws.on('ping', () => (pings += 1));
    await new Promise((r) => setTimeout(r, 400));
    expect(pings).toBeGreaterThanOrEqual(4);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('closes a socket that has been silent for the limit', async () => {
    const port = await start({ pingIntervalMs: 50, idleCloseMs: 200 });
    const { ws } = await openRaw(port, 'silent', { autoPong: false });
    const closed = once(ws, 'close').then(() => 'closed');
    await expect(Promise.race([closed, new Promise((r) => setTimeout(() => r('open'), 1000))])).resolves.toBe('closed');
  });
});
```

- [ ] **Step 2: Push the test and see it fail.** Red is certain: the app does not exist yet. Skip to Step 3.

- [ ] **Step 3: Write the implementation**

```json
// apps/fake-go/package.json
{
  "name": "@go/fake-go",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "start": "node dist/main.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@go/contract": "workspace:*",
    "@go/sim": "workspace:*",
    "fastify": "^5.6.1",
    "ws": "^8.18.3",
    "zod": "4.3.6"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@types/ws": "^8.18.1",
    "tsx": "^4.21.0",
    "typescript": "^5.5.0",
    "vitest": "^4.0.17"
  }
}
```

(Do not paste the first line of a JSON block: it only names the file.)

```json
// apps/fake-go/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "src/**/__tests__/**"]
}
```

```ts
// apps/fake-go/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
  },
});
```

```ts
// apps/fake-go/src/signature-guard.ts
// Checks the signature on the socket upgrade, and accepts each (t, v1) once.
// The used signatures are kept in memory, so a restart forgets them. That is fine for the fake Go (a replay
// would have to come within 300 seconds of a restart); the real Go keeps them in Postgres.
import { MAX_SKEW_SECONDS, verifyRequest } from '@go/contract';

export type GuardResult =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'malformed' | 'stale' | 'mismatch' | 'replayed'; message: string };

const MESSAGES = {
  missing: 'the x-go-signature header is missing',
  malformed: 'the x-go-signature header is malformed',
  stale: 'the signature is more than 300 seconds old or ahead: check the clock',
  mismatch: 'the signature does not match: check GO_SIGNING_SECRET, and sign the full target with its query string',
  replayed: 'signature already used',
} as const;

const refuse = (reason: keyof typeof MESSAGES): GuardResult => ({ ok: false, reason, message: MESSAGES[reason] });

export class SignatureGuard {
  /** "t:v1" of every signature accepted, with its t. */
  private readonly used = new Map<string, number>();

  constructor(private readonly secret: string) {}

  check(header: string | string[] | undefined, target: string, nowSeconds: number): GuardResult {
    if (Array.isArray(header)) return refuse('malformed');
    const verdict = verifyRequest({ method: 'GET', target, body: '' }, header, this.secret, nowSeconds);
    if (!verdict.ok) return refuse(verdict.reason);
    for (const [key, t] of this.used) if (t + MAX_SKEW_SECONDS < nowSeconds) this.used.delete(key);
    // Keyed on the values, not the header text, so the same signature with its fields swapped is still a repeat.
    const t = Number(/(?:^|,)\s*t=(\d+)/.exec(header ?? '')?.[1]);
    const v1 = /(?:^|,)\s*v1=([0-9a-f]{64})/.exec(header ?? '')?.[1] ?? '';
    const key = `${t}:${v1}`;
    if (this.used.has(key)) return refuse('replayed');
    this.used.set(key, t);
    return { ok: true };
  }
}
```

```ts
// apps/fake-go/src/frames.ts
// The last frames both ways, for the Server team to read on the /frames page.
export interface FrameRecord {
  at: string;
  direction: 'in' | 'out';
  instance: string;
  text: string;
}

const MAX_TEXT = 8192;

export class FrameLog {
  private readonly items: FrameRecord[] = [];

  constructor(private readonly max = 200, private readonly now: () => Date = () => new Date()) {}

  add(direction: 'in' | 'out', instance: string, text: string): void {
    const cut = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)} [cut at ${MAX_TEXT} characters]` : text;
    this.items.push({ at: this.now().toISOString(), direction, instance, text: cut });
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
  }

  /** Newest first. */
  list(): FrameRecord[] {
    return [...this.items].reverse();
  }
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderFrames(items: FrameRecord[]): string {
  const rows = items
    .map((f) => `<tr class="${f.direction}"><td>${esc(f.at.slice(11, 23))}</td><td>${f.direction === 'in' ? 'Server to Go' : 'Go to Server'}</td><td>${esc(f.instance)}</td><td><code>${esc(f.text)}</code></td></tr>`)
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="3">
<title>The fake Go: frames</title>
<style>
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f8fafc; color: #0f172a; margin: 0; padding: 24px; }
h1 { font-size: 20px; margin: 0 0 4px; }
p { color: #475569; margin: 0 0 16px; }
table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08); }
td { padding: 8px 12px; border-top: 1px solid #e2e8f0; vertical-align: top; font-size: 13px; }
td:nth-child(1), td:nth-child(2), td:nth-child(3) { white-space: nowrap; color: #475569; }
tr.in td:nth-child(2) { color: #0369a1; }
tr.out td:nth-child(2) { color: #15803d; }
code { font-family: ui-monospace, Menlo, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
</style>
</head>
<body>
<h1>The fake Go: the last ${items.length} frames</h1>
<p>Newest first, both ways, times in UTC. The page refreshes every 3 seconds.</p>
<table>
${rows || '<tr><td colspan="4">No frames yet.</td></tr>'}
</table>
</body>
</html>`;
}
```

```ts
// apps/fake-go/src/link.ts
// Go's requests to the Server. Each one goes out on the newest open socket. If that socket closes before the
// answer, the request goes out again on the next open socket with the same JSON-RPC id (and so the same
// request_id inside), and the Server answers a repeat with its first answer.
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { SocketCallError, SocketTimeoutError } from '@go/sim';
import type { FrameLog } from './frames.js';

interface Conn {
  ws: WebSocket;
  instance: string;
}

interface Pending {
  frame: string;
  /** The socket it went out on, or null while no socket is open. */
  on: Conn | null;
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

interface ErrorField {
  code?: unknown;
  message?: unknown;
  data?: { code?: string; retry_after_seconds?: number | null } | null;
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

  request(method: string, params: object, timeoutMs = 2000): Promise<Record<string, unknown>> {
    const id = `go_${randomUUID()}`;
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
      const conn = this.newest();
      this.pending.set(id, {
        frame,
        on: conn,
        resolve: (r) => { settle(); resolve(r); },
        reject: (e) => { settle(); reject(e); },
      });
      if (conn) this.write(conn, frame); // with no socket open, it waits for the next one
    });
  }

  /** A notification (Go's typing): dropped when no socket is open, never sent again. */
  notify(method: string, params: object): void {
    const conn = this.newest();
    if (conn) this.write(conn, JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  /** Matches an answer frame to the request it answers. An answer nobody waits for is dropped. */
  settle(frame: { id?: unknown; result?: unknown; error?: unknown }): void {
    const p = typeof frame.id === 'string' ? this.pending.get(frame.id) : undefined;
    if (!p) return;
    const error = frame.error as ErrorField | undefined;
    if (error) {
      p.reject(new SocketCallError(Number(error.code), String(error.message ?? ''), error.data?.code ?? undefined, error.data?.retry_after_seconds ?? undefined));
      return;
    }
    p.resolve((frame.result ?? {}) as Record<string, unknown>);
  }

  /** Sends one frame (an answer) on the socket it belongs to. */
  send(ws: WebSocket, body: object): void {
    const conn = this.conns.find((c) => c.ws === ws) ?? { ws, instance: 'closed' };
    this.write(conn, JSON.stringify(body));
  }

  private newest(): Conn | null {
    return this.conns[this.conns.length - 1] ?? null;
  }

  private write(conn: Conn, text: string): void {
    this.frames.add('out', conn.instance, text);
    conn.ws.send(text);
  }
}
```

```ts
// apps/fake-go/src/server.ts
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
  /** Runs after Go has answered a new event of a known type. Never for a repeat. */
  onEvent?: (event: Event) => void | Promise<void>;
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

  const sendEvent = (params: unknown): { accepted: true; duplicate: boolean } => {
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
        .then(() => behaviour.onEvent?.(event))
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
    if (typeof f.method !== 'string') return link.settle(f); // the answer to one of Go's requests
    if (f.id === undefined) return; // the Server sends no notifications; a stray one gets no answer
    const id = f.id;
    try {
      const result = f.method === 'send_event' ? sendEvent(f.params) : await callHandler(f.method, f.params, instance);
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
```

Then update the lockfile (not a test run): `pnpm install`.

- [ ] **Step 4: Commit, push, read CI**

```bash
git add apps/fake-go/package.json apps/fake-go/tsconfig.json apps/fake-go/vitest.config.ts apps/fake-go/src/signature-guard.ts apps/fake-go/src/frames.ts apps/fake-go/src/link.ts apps/fake-go/src/server.ts apps/fake-go/src/__tests__/server.test.ts pnpm-lock.yaml
git commit -m "feat(fake-go): Go's side of the socket for the Server team: signed once, pinged, answered

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `server.test.ts` passes (17 tests); `pnpm build` builds `@go/fake-go` after `@go/sim`.

---
### Task 4: What the fake Go does (the mention script, the five cards, the fixed answers, booting)

This is the behaviour `docs/guide/10-build-and-test.md` promises, quoted:

> - It checks the signature on the upgrade and pings every 20 seconds.
> - It answers every `send_event` with `{ "accepted": true, "duplicate": false }`, and with `"duplicate": true` for an `event_id` it has seen.
> - When a `message.created` event mentions Go, it sends a `typing` notification, sends `read_trip`, adds a ✅ to the message with `add_reaction`, and then sends `post_message` with a reply and one of Go's own cards (`options`, `working`, `call`, `pay` or `notice`), a different kind each time.
> - It answers `card_tap`, `catch_up`, the people requests and `vault_link` with fixed answers.

The first two are Task 3. This task does the last two. Decisions where the guide is silent (research ambiguities 4, 5 and 6):

- **A repeated `tap_id`** gets the first answer back, whatever the second tap says. Go acts on each `tap_id` once, and answering the same way twice is the only answer that cannot mislead the App.
- **"Mentions Go"** means the event's `mentions_go` is true. The fake Go does not read the text itself, so the Server team sees at once if their `mentions_go` is wrong. It never answers Go's own messages, withheld or deleted ones.
- **The fake pay card** carries `approval_id: "ap_fake_<n>"`, `merchant: "Fake Go test merchant"` and text that says nothing is charged. It pins the trip's organizer (from `read_trip`) as the payer, or the author when `read_trip` fails. The Server does not check `approval_id` on `post_message`, so this is valid on the wire and can never pay.
- **Fixed answers** are the guide's checked examples (`CatchUp`, `PersonPage`, `ForgetResult`), with the asked `person_id` put back. `card_tap`: `watch` and the payer's `approve` answer `open` with a link to the fake Go's own page (5 minutes); `pick`, `vote`, `stop` and `decline` answer `done` with a toast; `approve` from anyone else, on a card the fake Go did not post, or any other button answers `refused` with a toast.
- **Failures don't stop the script**: if `read_trip` or `add_reaction` fails, the fake Go still posts, so the Server team sees every request kind.

**Files:**
- Create: `apps/fake-go/src/env.ts`
- Create: `apps/fake-go/src/cards.ts`
- Create: `apps/fake-go/src/behaviour.ts`
- Create: `apps/fake-go/src/main.ts`
- Test: `apps/fake-go/src/__tests__/behaviour.test.ts`

**Interfaces:**
- Consumes: Task 3: `buildFakeGo`, `Behaviour`, `Link` (`request`, `notify`). `@go/contract`: `TripSnapshot`, `type Card`, `type CardActionResult`, `type CardTap`, `type Event`. `@go/sim` in tests: `GoSocket`, `goaFreshTrip`, `GOA_PEOPLE`.
- Produces:
  - `const FAKE_CARD_KINDS: readonly ['options', 'working', 'call', 'pay', 'notice']`, `type FakeCardKind`
  - `function fakeCard(kind: FakeCardKind, c: { n: number; payerId: string; publicUrl: string; now: Date }): Card`
  - `function fakeGoBehaviour(link: Link, o: { publicUrl: string; now?: () => Date; log?: (line: string) => void }): Behaviour`
  - `const FIXED_CATCH_UP`, `const FIXED_FACTS`
  - `const Env` (zod: `PORT`, `GO_SIGNING_SECRET`, `FAKE_GO_ADMIN_TOKEN`, `FAKE_GO_PUBLIC_URL?`, `RAILWAY_PUBLIC_DOMAIN?`), `function publicUrl(env: Env): string`
  - `apps/fake-go/dist/main.js`: the process Railway runs.

- [ ] **Step 1: Write the failing test**

```ts
// apps/fake-go/src/__tests__/behaviour.test.ts
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Card, CardActionResult, CatchUp, ForgetResult, Link as LinkResult, Ok, PersonPage, PostMessage } from '@go/contract';
import { GOA_PEOPLE, GoSocket, goaFreshTrip, type Handler } from '@go/sim';
import { FAKE_CARD_KINDS, fakeCard } from '../cards.js';
import { fakeGoBehaviour } from '../behaviour.js';
import { Env, publicUrl } from '../env.js';
import { buildFakeGo, type FakeGo } from '../server.js';

const secret = 'fake-go-test-secret-0123456789abcdef';
const at = '2026-10-05T06:49:00Z';
const publicBase = 'https://fake-go.test';

let fake: FakeGo | undefined;
let sock: GoSocket | undefined;
afterEach(async () => {
  sock?.close();
  sock = undefined;
  await fake?.close();
  fake = undefined;
});

interface Seen { method: string; params: any }

/** Starts the fake Go with its behaviour, and the Server's end with handlers that record each request Go sends. */
async function setUp(overrides: Record<string, Handler> = {}) {
  fake = buildFakeGo({ secret, adminToken: 'admin-token-for-tests-0001', behaviour: (link) => fakeGoBehaviour(link, { publicUrl: publicBase }) });
  await fake.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (fake.app.server.address() as AddressInfo).port;
  const seen: Seen[] = [];
  let seq = 100;
  const handlers: Record<string, Handler> = {
    read_trip: async (p) => { seen.push({ method: 'read_trip', params: p }); return goaFreshTrip(); },
    add_reaction: async (p) => { seen.push({ method: 'add_reaction', params: p }); return { seq: ++seq }; },
    post_message: async (_p, raw) => { seen.push({ method: 'post_message', params: raw }); return { message_id: `m_go_${seq}`, seq: ++seq }; },
    typing: async (p) => { seen.push({ method: 'typing', params: p }); },
    ...overrides,
  };
  let opened!: () => void;
  const ready = new Promise<void>((r) => (opened = r));
  sock = new GoSocket({ url: `ws://127.0.0.1:${port}/v1/socket?instance=behaviour`, secret, handlers, onOpen: () => opened() });
  sock.start();
  await ready;
  return { seen, sock };
}

let n = 0;
function message(over: Record<string, unknown> = {}, author: object = { kind: 'person', person_id: GOA_PEOPLE.priya }) {
  n += 1;
  return {
    event_id: `ev_test_${n}`, trip_id: 't_goa', seq: 200 + n, occurred_at: at, type: 'message.created',
    data: {
      message: {
        message_id: `m_test_${n}`, seq: 200 + n, updated_seq: 200 + n, author, text: '@Go hello', attachments: [],
        mentions_go: true, mentions: [], reactions: [], withheld: false, deleted: false, sent_at: at, ...over,
      },
    },
  };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const posts = (seen: Seen[]) => seen.filter((s) => s.method === 'post_message');
const label = (s: Seen) => (s.method === 'typing' ? `typing ${s.params.on ? 'on' : 'off'}` : s.method);

/** Sends one event and waits for the whole answer: a post and typing off. Returns the post's params as sent. */
async function mention(s: GoSocket, seen: Seen[], ev = message()) {
  const before = posts(seen).length;
  expect(await s.request('send_event', ev)).toEqual({ accepted: true, duplicate: false });
  await until(() => posts(seen).length === before + 1 && label(seen[seen.length - 1]!) === 'typing off');
  return posts(seen)[before]!.params;
}

describe('a message that mentions Go', () => {
  it('gets typing, read_trip, a ✅, a reply with a card, then typing off', async () => {
    const { seen, sock: s } = await setUp();
    const ev = message();
    const post = await mention(s, seen, ev);
    expect(seen.map(label)).toEqual(['typing on', 'read_trip', 'add_reaction', 'post_message', 'typing off']);
    const reaction = seen.find((x) => x.method === 'add_reaction')!.params;
    expect(reaction).toMatchObject({ trip_id: 't_goa', message_id: ev.data.message.message_id, emoji: '✅' });
    expect(reaction.request_id).toMatch(/^rq_fake_/);
    expect(PostMessage.safeParse(post).success).toBe(true);
    expect(post.request_id).not.toBe(reaction.request_id);
    expect(post).toMatchObject({ trip_id: 't_goa', reply_to: ev.data.message.message_id, mentions: ['p_priya'] });
    expect(post.text).toBe('Hi Priya, this is the fake Go. Here is an options card to test with.');
    expect(Card.parse(post.card).kind).toBe('options');
    for (const x of seen) expect(JSON.stringify(x.params)).not.toContain('\u2014');
  });

  it('posts a different Go card kind each time, each one valid with a fresh card_id', async () => {
    const { seen, sock: s } = await setUp();
    const kinds: string[] = [];
    const ids = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const card = Card.parse((await mention(s, seen)).card);
      kinds.push(card.kind);
      ids.add(card.card_id);
    }
    expect(kinds).toEqual(['options', 'working', 'call', 'pay', 'notice', 'options']);
    expect(ids.size).toBe(6);
    const pay = posts(seen)[3]!.params.card;
    expect(pay).toMatchObject({ kind: 'pay', payer_person_id: 'p_rahul', for_person_ids: ['p_rahul'], state: 'waiting', merchant: 'Fake Go test merchant' });
    expect(pay.approval_id).toMatch(/^ap_fake_/);
    expect(pay.purpose).toContain('Nothing is charged');
    expect(pay.actions.map((a: { only_for_person_ids: string[] }) => a.only_for_person_ids)).toEqual([['p_rahul'], ['p_rahul']]);
  });

  it("stays quiet for repeats, Go's own messages, withheld messages and messages not for Go", async () => {
    const { seen, sock: s } = await setUp();
    const ev = message();
    await mention(s, seen, ev);
    const count = posts(seen).length;
    expect(await s.request('send_event', ev)).toEqual({ accepted: true, duplicate: true });
    const quiet = [message({}, { kind: 'go' }), message({ withheld: true, text: null }), message({ mentions_go: false, text: 'lets go to the beach' })];
    for (const q of quiet) expect(await s.request('send_event', q)).toEqual({ accepted: true, duplicate: false });
    await new Promise((r) => setTimeout(r, 300));
    expect(posts(seen).length).toBe(count);
  });

  it('still reacts and posts when read_trip fails', async () => {
    const { seen, sock: s } = await setUp({ read_trip: async () => { throw new Error('database down'); } });
    const post = await mention(s, seen);
    expect(seen.map(label)).toEqual(['typing on', 'add_reaction', 'post_message', 'typing off']);
    expect(post.text).toBe('This is the fake Go. Here is an options card to test with.');
    expect(post.mentions).toEqual(['p_priya']);
  });
});

describe('fixed answers', () => {
  it('answers each tap_id once, and lets only the payer approve', async () => {
    const { seen, sock: s } = await setUp();
    const byKind: Record<string, any> = {};
    for (let i = 0; i < 5; i++) {
      const card = (await mention(s, seen)).card;
      byKind[card.kind] = card;
    }
    const tap = (tap_id: string, card_id: string, action_id: string, person_id: string, option_id?: string) =>
      s.request('card_tap', { tap_id, trip_id: 't_goa', card_id, action_id, person_id, ...(option_id ? { option_id } : {}) }, { timeoutMs: 3500 })
        .then((r) => CardActionResult.parse(r));
    const pay = byKind.pay.card_id as string;
    const refusedPriya = { result: 'refused', toast: 'Only the payer can approve this payment.' };

    expect(await tap('tap_1', pay, 'approve', 'p_priya')).toEqual(refusedPriya);
    const ok = await tap('tap_2', pay, 'approve', 'p_rahul');
    expect(ok.result).toBe('open');
    if (ok.result === 'open') {
      expect(ok.url.startsWith(`${publicBase}/fake/page/vault?`)).toBe(true);
      expect(Date.parse(ok.expires_at)).toBeGreaterThan(Date.now());
    }
    expect(await tap('tap_1', pay, 'approve', 'p_rahul')).toEqual(refusedPriya); // the first answer, again
    expect(await tap('tap_3', byKind.working.card_id, 'watch', 'p_arjun')).toMatchObject({ result: 'open' });
    expect(await tap('tap_4', byKind.working.card_id, 'stop', 'p_arjun')).toEqual({ result: 'done', toast: 'Stopped.' });
    expect(await tap('tap_5', byKind.options.card_id, 'pick', 'p_priya', byKind.options.options[0].option_id))
      .toEqual({ result: 'done', toast: 'Noted. Go will reply in the room.' });
    expect(await tap('tap_6', byKind.options.card_id, 'vote', 'p_priya')).toEqual({ result: 'done', toast: 'Go will put it to a vote.' });
    expect(await tap('tap_7', pay, 'decline', 'p_rahul')).toEqual({ result: 'done', toast: 'Declined. Nothing was paid.' });
    expect(await tap('tap_8', 'c_unknown', 'approve', 'p_rahul')).toEqual({ result: 'refused', toast: 'This payment is no longer waiting.' });
    expect(await tap('tap_9', pay, 'dance', 'p_rahul')).toEqual({ result: 'refused', toast: 'The fake Go does not know this button.' });
  });

  it('answers catch_up, the people requests and vault_link with answers that pass the contract', async () => {
    const { sock: s } = await setUp();
    expect(CatchUp.safeParse(await s.request('catch_up', { trip_id: 't_goa', person_id: 'p_meher', since: at }, { timeoutMs: 3500 })).success).toBe(true);
    const page = PersonPage.parse(await s.request('get_person', { person_id: 'p_kabir' }));
    expect(page.person_id).toBe('p_kabir');
    expect(page.facts).toHaveLength(3);
    expect(Ok.parse(await s.request('update_person', { person_id: 'p_kabir', carry_over: true }))).toEqual({ ok: true });
    expect(Ok.parse(await s.request('delete_fact', { person_id: 'p_kabir', fact_id: 'f_kb_02' }))).toEqual({ ok: true });
    expect(ForgetResult.parse(await s.request('forget_person', { person_id: 'p_kabir', trip_id: 't_goa' }))).toEqual({ deleted_facts: 3, remaining_facts: 0 });
    const link = LinkResult.parse(await s.request('vault_link', { kind: 'vault', person_id: 'p_rahul', start: 'add_card' }));
    expect(link.url).toBe(`${publicBase}/fake/page/vault?person=p_rahul&start=add_card`);
  });
});

describe('the cards and the environment', () => {
  it('makes every card kind valid, with no em dash anywhere', () => {
    const now = new Date('2026-10-05T07:00:00Z');
    for (const kind of FAKE_CARD_KINDS) {
      const card = fakeCard(kind, { n: 7, payerId: 'p_rahul', publicUrl: publicBase, now });
      expect(Card.parse(card).kind).toBe(kind);
      expect(JSON.stringify(card)).not.toContain('\u2014');
    }
  });

  it('needs a real secret and token, and finds its public URL', () => {
    expect(() => Env.parse({ GO_SIGNING_SECRET: 'short', FAKE_GO_ADMIN_TOKEN: 'x'.repeat(16) })).toThrow();
    const base = { GO_SIGNING_SECRET: 'a'.repeat(64), FAKE_GO_ADMIN_TOKEN: 'b'.repeat(32) };
    expect(publicUrl(Env.parse(base))).toBe('http://localhost:8080');
    expect(publicUrl(Env.parse({ ...base, RAILWAY_PUBLIC_DOMAIN: 'fake-go-production.up.railway.app' }))).toBe('https://fake-go-production.up.railway.app');
    expect(publicUrl(Env.parse({ ...base, PORT: '9000', FAKE_GO_PUBLIC_URL: 'https://fake-go.example/' }))).toBe('https://fake-go.example');
  });
});
```

- [ ] **Step 2: Push the test and see it fail.** Red is certain: the modules do not exist yet. Skip to Step 3.

- [ ] **Step 3: Write the implementation**

```ts
// apps/fake-go/src/env.ts
// The fake Go's settings. Secrets come only from Railway's variables, never from the repo.
import { z } from 'zod';

export const Env = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  GO_SIGNING_SECRET: z.string().min(32, 'GO_SIGNING_SECRET must be at least 32 characters: make it with openssl rand -hex 32'),
  FAKE_GO_ADMIN_TOKEN: z.string().min(16, 'FAKE_GO_ADMIN_TOKEN must be at least 16 characters'),
  /** The fake Go's own base URL, for the links it hands out. Railway's domain is used when this is not set. */
  FAKE_GO_PUBLIC_URL: z.url({ protocol: /^https?$/ }).optional(),
  /** Set by Railway, e.g. fake-go-production.up.railway.app. */
  RAILWAY_PUBLIC_DOMAIN: z.string().min(1).optional(),
});
export type Env = z.infer<typeof Env>;

export function publicUrl(env: Env): string {
  if (env.FAKE_GO_PUBLIC_URL) return env.FAKE_GO_PUBLIC_URL.replace(/\/+$/, '');
  if (env.RAILWAY_PUBLIC_DOMAIN) return `https://${env.RAILWAY_PUBLIC_DOMAIN}`;
  return `http://localhost:${env.PORT}`;
}
```

```ts
// apps/fake-go/src/cards.ts
// The five Go cards the fake Go posts, one kind after another, so the App can draw each one and the Server can
// store and forward each one. Every card passes the contract's Card schema. The pay card is a test card: its
// approval_id is fake (ap_fake_...) and nothing is ever charged.
import type { Card } from '@go/contract';

export const FAKE_CARD_KINDS = ['options', 'working', 'call', 'pay', 'notice'] as const;
export type FakeCardKind = (typeof FAKE_CARD_KINDS)[number];

export interface CardContext {
  /** A running number, so every card_id is new. */
  n: number;
  payerId: string;
  publicUrl: string;
  now: Date;
}

export function fakeCard(kind: FakeCardKind, c: CardContext): Card {
  const n = String(c.n).padStart(4, '0');
  const at = c.now.toISOString();
  const card_id = `c_fake_${n}_${kind}`;
  switch (kind) {
    case 'options':
      return {
        kind,
        card_id,
        fallback_text: 'Two test flights from the fake Go, Delhi to Goa, from ₹5,640 per person.',
        title: 'Test flights, Delhi to Goa',
        option_kind: 'flight',
        checked_at: at,
        options: [
          {
            option_id: `opt_fake_${n}_1`,
            title: 'IndiGo 6E 2134',
            subtitle: '6:10 pm to 8:45 pm, non-stop',
            price_minor: 592000,
            currency: 'INR',
            price_note: 'per person',
            highlights: ['Non-stop', 'Test data'],
            journey: {
              mode: 'flight',
              origin: { name: 'Delhi', code: 'DEL' },
              destination: { name: 'Goa', code: 'GOI' },
              depart_at: '2026-11-06T18:10:00+05:30',
              arrive_at: '2026-11-06T20:45:00+05:30',
              carrier_name: 'IndiGo',
              carrier_code: '6E',
              number: '6E 2134',
              stops: 0,
            },
          },
          {
            option_id: `opt_fake_${n}_2`,
            title: 'IndiGo, 9:20 pm',
            subtitle: '9:20 pm to 11:55 pm, non-stop',
            price_minor: 564000,
            currency: 'INR',
            price_note: 'per person',
            highlights: ['Cheapest', 'Test data'],
          },
        ],
        actions: [
          { action_id: 'pick', label: "I'll take this", style: 'primary', per_option: true },
          { action_id: 'vote', label: 'Put it to a vote', style: 'secondary' },
        ],
      };
    case 'working':
      return {
        kind,
        card_id,
        fallback_text: 'The fake Go is working on a test job.',
        task_id: `task_fake_${n}`,
        title: 'A test job from the fake Go',
        state: 'running',
        steps: [
          { text: 'Open the test website', state: 'done' },
          { text: 'Look through the test results', state: 'doing' },
          { text: 'Pick the best three', state: 'todo' },
        ],
        updated_at: at,
        actions: [
          { action_id: 'watch', label: 'Watch', style: 'primary' },
          { action_id: 'stop', label: 'Stop', style: 'secondary' },
        ],
      };
    case 'call':
      return {
        kind,
        card_id,
        fallback_text: 'The fake Go is on a test call to Test Villa.',
        call_id: `call_fake_${n}`,
        business: 'Test Villa',
        goal: 'A test call from the fake Go',
        state: 'talking',
        started_at: at,
        last_line: { who: 'them', text: 'This is a test line from the fake Go.' },
        actions: [{ action_id: 'stop', label: 'Stop the call', style: 'secondary' }],
      };
    case 'pay':
      return {
        kind,
        card_id,
        fallback_text: 'A test payment from the fake Go: ₹1,000. Nothing is charged.',
        for_person_ids: [c.payerId],
        approval_id: `ap_fake_${n}`, // fake: not a spend approval, and nothing can be paid with it
        payer_person_id: c.payerId,
        amount_minor: 100000,
        currency: 'INR',
        merchant: 'Fake Go test merchant',
        purpose: 'A test payment. Nothing is charged.',
        expires_at: new Date(c.now.getTime() + 10 * 60_000).toISOString(),
        state: 'waiting',
        actions: [
          { action_id: 'approve', label: 'Approve', style: 'primary', only_for_person_ids: [c.payerId] },
          { action_id: 'decline', label: 'Decline', style: 'secondary', only_for_person_ids: [c.payerId] },
        ],
      };
    case 'notice':
      return {
        kind,
        card_id,
        fallback_text: 'Good to know: this notice comes from the fake Go.',
        tone: 'info',
        title: 'Good to know (a test)',
        body: 'This notice comes from the fake Go, so the App can draw it. The real Go puts news and deadlines here, with where it got them.',
        source: { name: 'the fake Go' },
        checked_at: at,
      };
  }
}
```

```ts
// apps/fake-go/src/behaviour.ts
// What the fake Go does on top of the socket (docs/guide/10-build-and-test.md, "The fake Go"):
//  - when a message.created event mentions Go, it sends typing, read_trip, a ✅ with add_reaction, then
//    post_message with a reply and one of Go's own cards, a different kind each time, then typing off;
//  - it answers card_tap, catch_up, the people requests and vault_link with fixed answers.
// A repeated tap_id gets its first answer back. Only a pay card's payer can approve it.
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { TripSnapshot, type CardActionResult, type CardTap, type Event } from '@go/contract';
import { FAKE_CARD_KINDS, fakeCard, type FakeCardKind } from './cards.js';
import type { Link } from './link.js';
import type { Behaviour } from './server.js';

type TapAnswer = z.infer<typeof CardActionResult>;
type Tap = z.infer<typeof CardTap>;
type MessageCreated = Extract<Event, { type: 'message.created' }>;

export interface BehaviourOptions {
  /** The fake Go's own base URL; its watch and vault links point at its /fake/page/... pages. */
  publicUrl: string;
  now?: () => Date;
  log?: (line: string) => void;
}

/** The guide's catch-up example (docs/guide/05-your-requests.md). */
export const FIXED_CATCH_UP = {
  summary: 'While you were away, the group picked Villa Sol and Go booked it.',
  items: [
    { kind: 'decided', text: 'Villa Sol won the vote, 4 to 1', message_id: 'm_0158' },
    { kind: 'booked', text: 'Villa Sol, 3 nights, ₹54,200, paid by Rahul', image_url: 'https://brain.go.example/img/villa-sol.jpg', message_id: 'm_0166' },
    { kind: 'needs_you', text: 'Scuba on Saturday? Go is asking you and Kabir', message_id: 'm_0149' },
  ],
};

/** The guide's facts example for Kabir, used for whoever is asked about. */
export const FIXED_FACTS = [
  { fact_id: 'f_kb_01', topic: 'drinks', text: "Doesn't drink", trip_id: 't_goa', message_id: null, said_at: '2026-10-05T03:40:00Z' },
  { fact_id: 'f_kb_02', topic: 'flights', text: 'Wants an aisle seat', trip_id: 't_goa', message_id: 'm_0141', said_at: '2026-10-05T07:05:00Z' },
  { fact_id: 'f_kb_03', topic: 'boats', text: 'Gets seasick on boats', trip_id: 't_goa', message_id: 'm_0188', said_at: '2026-10-05T10:20:00Z' },
];

const newRequestId = (): string => `rq_fake_${randomUUID()}`;

export function fakeGoBehaviour(link: Link, o: BehaviourOptions): Behaviour {
  const now = o.now ?? (() => new Date());
  const log = o.log ?? (() => {});
  const cards = new Map<string, { kind: FakeCardKind; payerId: string }>();
  const taps = new Map<string, TapAnswer>();
  let posted = 0;

  const inFiveMinutes = (): string => new Date(now().getTime() + 5 * 60_000).toISOString();
  const page = (kind: 'watch' | 'vault', query: Record<string, string>): string =>
    `${o.publicUrl}/fake/page/${kind}?${new URLSearchParams(query).toString()}`;

  /** Sends one request; a failure is logged and the script goes on, so the Server team sees every request kind. */
  const ask = async (method: string, params: object): Promise<Record<string, unknown> | null> => {
    try {
      return await link.request(method, params);
    } catch (err) {
      log(`${method} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  const answerMention = async (ev: MessageCreated): Promise<void> => {
    const msg = ev.data.message;
    const authorId = msg.author.kind === 'person' ? msg.author.person_id : undefined;
    link.notify('typing', { trip_id: ev.trip_id, on: true });
    try {
      const read = TripSnapshot.safeParse(await ask('read_trip', { trip_id: ev.trip_id }));
      const trip = read.success ? read.data : undefined;
      const name = trip?.people.find((p) => p.person_id === authorId)?.name;
      const payerId = trip?.organizer_person_id ?? authorId ?? 'p_unknown';
      await ask('add_reaction', { request_id: newRequestId(), trip_id: ev.trip_id, message_id: msg.message_id, emoji: '✅' });
      const kind = FAKE_CARD_KINDS[posted % FAKE_CARD_KINDS.length] ?? 'notice';
      posted += 1;
      const card = fakeCard(kind, { n: posted, payerId, publicUrl: o.publicUrl, now: now() });
      cards.set(card.card_id, { kind, payerId });
      const greeting = name ? `Hi ${name}, this` : 'This';
      await ask('post_message', {
        request_id: newRequestId(),
        trip_id: ev.trip_id,
        text: `${greeting} is the fake Go. Here is ${kind === 'options' ? 'an' : 'a'} ${kind} card to test with.`,
        reply_to: msg.message_id,
        ...(authorId ? { mentions: [authorId] } : {}),
        card,
      });
    } finally {
      link.notify('typing', { trip_id: ev.trip_id, on: false });
    }
  };

  const answerTap = (tap: Tap): TapAnswer => {
    const card = cards.get(tap.card_id);
    switch (tap.action_id) {
      case 'watch':
        return { result: 'open', url: page('watch', { card: tap.card_id }), expires_at: inFiveMinutes() };
      case 'approve':
        if (!card || card.kind !== 'pay') return { result: 'refused', toast: 'This payment is no longer waiting.' };
        if (tap.person_id !== card.payerId) return { result: 'refused', toast: 'Only the payer can approve this payment.' };
        return { result: 'open', url: page('vault', { card: tap.card_id, person: tap.person_id }), expires_at: inFiveMinutes() };
      case 'pick':
        return { result: 'done', toast: 'Noted. Go will reply in the room.' };
      case 'vote':
        return { result: 'done', toast: 'Go will put it to a vote.' };
      case 'stop':
        return { result: 'done', toast: 'Stopped.' };
      case 'decline':
        return { result: 'done', toast: 'Declined. Nothing was paid.' };
      default:
        return { result: 'refused', toast: 'The fake Go does not know this button.' };
    }
  };

  return {
    onEvent: async (ev) => {
      if (ev.type !== 'message.created') return;
      const m = ev.data.message;
      if (!m.mentions_go || m.author.kind === 'go' || m.withheld || m.deleted) return;
      await answerMention(ev);
    },
    handlers: {
      card_tap: async (tap: Tap) => {
        const first = taps.get(tap.tap_id);
        if (first) return first; // once per tap_id: a repeat gets the first answer back
        const answer = answerTap(tap);
        taps.set(tap.tap_id, answer);
        return answer;
      },
      catch_up: async () => FIXED_CATCH_UP,
      get_person: async (p: { person_id: string }) => ({ person_id: p.person_id, carry_over: false, facts: FIXED_FACTS }),
      update_person: async () => ({ ok: true }),
      delete_fact: async () => ({ ok: true }),
      forget_person: async () => ({ deleted_facts: 3, remaining_facts: 0 }),
      vault_link: async (p: { person_id: string; start?: string | null }) => ({
        url: page('vault', { person: p.person_id, start: p.start ?? 'home' }),
        expires_at: inFiveMinutes(),
      }),
    },
  };
}
```

```ts
// apps/fake-go/src/main.ts
// Boots the fake Go: `node dist/main.js` with GO_SIGNING_SECRET and FAKE_GO_ADMIN_TOKEN set (PORT is optional).
import { fakeGoBehaviour } from './behaviour.js';
import { Env, publicUrl } from './env.js';
import { buildFakeGo } from './server.js';

const env = Env.parse(process.env);
const base = publicUrl(env);
const log = (line: string): void => console.log(`${new Date().toISOString()} ${line}`);

const fake = buildFakeGo({
  secret: env.GO_SIGNING_SECRET,
  adminToken: env.FAKE_GO_ADMIN_TOKEN,
  log,
  behaviour: (link) => fakeGoBehaviour(link, { publicUrl: base, log }),
});
await fake.app.listen({ port: env.PORT, host: '0.0.0.0' });
log(`the fake Go is listening on port ${env.PORT}; its links start ${base}`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void fake.close().finally(() => process.exit(0));
  });
}
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add apps/fake-go/src/env.ts apps/fake-go/src/cards.ts apps/fake-go/src/behaviour.ts apps/fake-go/src/main.ts apps/fake-go/src/__tests__/behaviour.test.ts
git commit -m "feat(fake-go): answer a mention like the guide promises, with a different Go card each time

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `behaviour.test.ts` passes (8 tests) and `server.test.ts` still passes.

---
### Task 5: The handover (smoke check, Dockerfile, Railway, README, the message to Nishanth)

G0 passes when the Server team can connect to a deployed fake Go with their own signed socket, send every `to_go` method, and receive every request kind the fake Go sends, from a canned trip. This task ships the smoke check that proves it from our side, the Docker build, the Railway settings, the README Nishanth's team reads, and the exact message Keshav sends.

**Files:**
- Create: `apps/fake-go/src/smoke.ts`
- Create: `apps/fake-go/scripts/smoke.ts`
- Create: `apps/fake-go/Dockerfile`
- Create: `apps/fake-go/railway.json`
- Create: `apps/fake-go/README.md`
- Create: `.dockerignore`
- Modify: `apps/fake-go/package.json` (add the `smoke` script)
- Test: `apps/fake-go/src/__tests__/smoke.test.ts`

**Interfaces:**
- Consumes: `@go/sim`: `GoSocket`, `goaFreshTrip`, `type Handler`. `@go/contract`: `Health`, `PostMessage`, `SOCKET_PATH`. Tasks 3 and 4 in the test: `buildFakeGo`, `fakeGoBehaviour`.
- Produces:
  - `function runSmoke(o: { goUrl: string; secret: string; instance?: string; print?: (line: string) => void; timeoutMs?: number }): Promise<{ ok: boolean; goRequests: string[]; problems: string[] }>`
  - `pnpm --filter @go/fake-go smoke` (reads `GO_URL`, `GO_SIGNING_SECRET`; exit 0 on success, 1 on failure, 2 when unset)
  - A deployed service `fake-go` in the Railway project `go`, and its URL handed to Nishanth.

- [ ] **Step 1: Write the failing test**

```ts
// apps/fake-go/src/__tests__/smoke.test.ts
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeGoBehaviour } from '../behaviour.js';
import { buildFakeGo, type FakeGo } from '../server.js';
import { runSmoke } from '../smoke.js';

const secret = 'fake-go-test-secret-0123456789abcdef';
let fake: FakeGo | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function start(): Promise<string> {
  fake = buildFakeGo({ secret, adminToken: 'admin-token-for-tests-0001', behaviour: (link) => fakeGoBehaviour(link, { publicUrl: 'https://fake-go.test' }) });
  await fake.app.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(fake.app.server.address() as AddressInfo).port}`;
}

describe('the smoke check', () => {
  it('passes against a running fake Go, and prints every frame both ways', async () => {
    const goUrl = await start();
    const lines: string[] = [];
    const report = await runSmoke({ goUrl, secret, print: (l) => lines.push(l), timeoutMs: 5000 });
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.goRequests).toEqual(['typing on', 'read_trip', 'add_reaction', 'post_message', 'typing off']);
    expect(lines.some((l) => l.startsWith('health: 200'))).toBe(true);
    expect(lines.some((l) => l.startsWith('Server -> Go') && l.includes('trip.created'))).toBe(true);
    expect(lines.some((l) => l.startsWith('Go -> Server') && l.includes('post_message'))).toBe(true);
  });

  it('fails with a plain reason when the secret is wrong', async () => {
    const goUrl = await start();
    const report = await runSmoke({ goUrl, secret: 'not-the-secret-not-the-secret-000', print: () => {}, timeoutMs: 1500 });
    expect(report.ok).toBe(false);
    expect(report.problems).toContain('the socket did not open: check GO_URL and GO_SIGNING_SECRET');
  });
});
```

- [ ] **Step 2: Push the test and see it fail.** Red is certain: the module does not exist yet. Skip to Step 3.

- [ ] **Step 3: Write the implementation**

```ts
// apps/fake-go/src/smoke.ts
// The end-to-end check of a deployed fake Go, from the Server's side of the socket. It checks health, opens the
// socket with a fresh signature, creates a Goa trip (with a new trip_id each run), says "@Go hello" as Rahul,
// prints every frame both ways, and checks that Go sent typing, read_trip, add_reaction and post_message.
import { randomUUID } from 'node:crypto';
import { Health, PostMessage, SOCKET_PATH } from '@go/contract';
import { GoSocket, goaFreshTrip, type Handler } from '@go/sim';

export interface SmokeOptions {
  /** Go's https base URL, with no path. */
  goUrl: string;
  secret: string;
  instance?: string;
  print?: (line: string) => void;
  timeoutMs?: number;
}

export interface SmokeReport {
  ok: boolean;
  /** Go's requests in the order they arrived, with typing as "typing on" and "typing off". */
  goRequests: string[];
  problems: string[];
}

const EXPECTED = ['typing on', 'read_trip', 'add_reaction', 'post_message', 'typing off'];

function waitUntil(check: () => boolean, ms: number, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (check()) return resolve();
      if (Date.now() - started > ms) return reject(new Error(message));
      setTimeout(tick, 50);
    };
    tick();
  });
}

export async function runSmoke(o: SmokeOptions): Promise<SmokeReport> {
  const print = o.print ?? ((line: string) => console.log(line));
  const timeoutMs = o.timeoutMs ?? 15_000;
  const base = o.goUrl.replace(/\/+$/, '');
  const problems: string[] = [];
  const goRequests: string[] = [];

  try {
    const res = await fetch(`${base}/v1/health`);
    const body: unknown = await res.json();
    print(`health: ${res.status} ${JSON.stringify(body)}`);
    const health = Health.safeParse(body);
    if (!health.success || !health.data.contract.startsWith('1.')) problems.push(`health answered ${JSON.stringify(body)}`);
  } catch (err) {
    problems.push(`health failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const run = randomUUID().slice(0, 8);
  const trip = { ...goaFreshTrip(), trip_id: `t_smoke_${run}` };
  let seq = 1;
  const handlers: Record<string, Handler> = {
    read_trip: async () => {
      goRequests.push('read_trip');
      return { ...trip, seq };
    },
    read_messages: async () => {
      goRequests.push('read_messages');
      return { messages: [], has_more: false };
    },
    add_reaction: async () => {
      goRequests.push('add_reaction');
      seq += 1;
      return { seq };
    },
    post_message: async (_p, raw) => {
      goRequests.push('post_message');
      if (!PostMessage.safeParse(raw).success) problems.push('post_message did not pass the contract');
      seq += 1;
      return { message_id: `m_smoke_${run}_${seq}`, seq };
    },
    typing: async (p: { on: boolean }) => {
      goRequests.push(p.on ? 'typing on' : 'typing off');
    },
  };

  let open = false;
  const sock = new GoSocket({
    url: `${base.replace(/^http/, 'ws')}${SOCKET_PATH}?instance=${encodeURIComponent(o.instance ?? 'smoke')}`,
    secret: o.secret,
    handlers,
    backoffSeconds: [2],
    onOpen: () => {
      open = true;
      print('socket open');
    },
    onError: (err) => print(`socket error: ${err.message}`),
    onFrame: (direction, text) => print(`${direction === 'out' ? 'Server -> Go' : 'Go -> Server'} ${text}`),
  });
  sock.start();
  try {
    await waitUntil(() => open, timeoutMs, 'the socket did not open: check GO_URL and GO_SIGNING_SECRET');
    const at = new Date().toISOString();
    const created = await sock.request('send_event', {
      event_id: `ev_smoke_${run}_1`, trip_id: trip.trip_id, seq: 1, occurred_at: at, type: 'trip.created', data: { trip },
    });
    if (created.accepted !== true) problems.push(`trip.created answered ${JSON.stringify(created)}`);
    seq = 2;
    const hello = {
      message_id: `m_smoke_${run}`, seq: 2, updated_seq: 2, author: { kind: 'person', person_id: 'p_rahul' }, text: '@Go hello',
      attachments: [], mentions_go: true, mentions: [], reactions: [], withheld: false, deleted: false, sent_at: at,
    };
    const said = await sock.request('send_event', {
      event_id: `ev_smoke_${run}_2`, trip_id: trip.trip_id, seq: 2, occurred_at: at, type: 'message.created', data: { message: hello },
    });
    if (said.accepted !== true) problems.push(`message.created answered ${JSON.stringify(said)}`);
    await waitUntil(() => goRequests.includes('post_message') && goRequests.includes('typing off'), timeoutMs, 'Go did not answer "@Go hello" in time');
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  } finally {
    sock.close();
  }
  for (const want of EXPECTED) if (!goRequests.includes(want)) problems.push(`Go never sent ${want}`);
  return { ok: problems.length === 0, goRequests, problems };
}
```

```ts
// apps/fake-go/scripts/smoke.ts
// pnpm --filter @go/fake-go smoke: checks a deployed fake Go end to end. Needs GO_URL and GO_SIGNING_SECRET.
import { runSmoke } from '../src/smoke.js';

const goUrl = process.env.GO_URL;
const secret = process.env.GO_SIGNING_SECRET;
if (!goUrl || !secret) {
  console.error('Set GO_URL (the https base, no path) and GO_SIGNING_SECRET first.');
  process.exit(2);
}
const report = await runSmoke({ goUrl, secret });
console.log(report.ok ? `SMOKE OK: ${report.goRequests.join(', ')}` : `SMOKE FAILED:\n- ${report.problems.join('\n- ')}`);
process.exit(report.ok ? 0 : 1);
```

In `apps/fake-go/package.json`, add one script line after `"test": "vitest run"`:

```json
    "smoke": "tsx scripts/smoke.ts"
```

```dockerfile
# apps/fake-go/Dockerfile
# The fake Go, built from the repo root so the workspace packages it uses (@go/contract, @go/sim) build with it.
FROM node:22-slim
WORKDIR /repo
RUN npm install -g pnpm@10.29.1
COPY . .
RUN pnpm install --frozen-lockfile --filter "@go/fake-go..."
RUN pnpm --filter "@go/fake-go..." run build
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "apps/fake-go/dist/main.js"]
```

```
# .dockerignore (repo root)
node_modules
**/node_modules
**/dist
.git
**/.env
**/.env.*
```

```json
// apps/fake-go/railway.json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": { "builder": "DOCKERFILE", "dockerfilePath": "apps/fake-go/Dockerfile" },
  "deploy": { "healthcheckPath": "/v1/health", "healthcheckTimeout": 60, "restartPolicyType": "ON_FAILURE", "restartPolicyMaxRetries": 10 }
}
```

(Do not paste the first line of the JSON block: it only names the file.)

````markdown
<!-- apps/fake-go/README.md -->
# The fake Go

The fake Go is a small stand-in for Go that speaks the real socket. The Server team uses it to build and test the Server's side of the socket before the real Go is ready. It follows the contract in `packages/contract` and the guide at https://vestrago.vercel.app/docs.

## What it does

- Opens the socket at `GET /v1/socket` only with a valid `x-go-signature`, and accepts each signature once. A refused upgrade gets `401` with `{"error":{"code":"bad_signature","message":"..."}}`, and the message says what was wrong.
- Pings every 20 seconds, and closes a socket that has been silent for 40 seconds.
- Answers every `send_event` straight away: `{"accepted":true,"duplicate":false}`, or `"duplicate":true` for an `event_id` it has seen. An event type it does not know is accepted too. A broken event of a known type gets `422`.
- When a `message.created` event has `mentions_go: true`, and is not Go's own, withheld or deleted, it sends `typing` (on), `read_trip`, `add_reaction` with ✅ on that message, `post_message` with a reply and one of Go's cards, and `typing` (off). The card changes each time: `options`, `working`, `call`, `pay`, `notice`, then round again.
- Answers `card_tap`, `catch_up`, `get_person`, `update_person`, `delete_fact`, `forget_person` and `vault_link` with fixed answers taken from the guide's examples. A repeated `tap_id` gets its first answer back. `approve` on a pay card works only for that card's payer; anyone else gets `refused` with a toast.
- Answers `-32601` for any other method, and `-32700` with `id: null` for a frame it cannot read.
- Answers `GET /v1/health` with `{"ok":true,"contract":"1.0.0"}`.

## Connecting

Set these in the Server's environment:

| Variable | Value |
|---|---|
| `GO_URL` | `https://<the fake Go's domain>`. Keshav sends it. |
| `GO_SIGNING_SECRET` | Keshav sends it through a one-time link. Keep it only in your environment variables. |

The socket is `wss://<the fake Go's domain>/v1/socket`. Give each Server instance its own name in the query string, such as `/v1/socket?instance=server-1`, and sign the full target with the query string.

To connect by hand, use `connect.py` or `wscat` from the "Connect by hand" section of [Build and test](https://vestrago.vercel.app/docs), with `GO_URL` set to the fake Go. Make a new signature for every connect.

To run the whole check from this repo:

```bash
GO_URL=https://<the fake Go's domain> GO_SIGNING_SECRET=<the secret> pnpm --filter @go/fake-go smoke
```

It creates a test trip, says "@Go hello", prints every frame both ways, and ends with `SMOKE OK` when the fake Go answered as described above.

## Reading the frames

`https://<the fake Go's domain>/frames?token=<FAKE_GO_ADMIN_TOKEN>` lists the last 200 frames both ways, newest first, and refreshes every 3 seconds. Keshav sends the token with the secret. Frames carry the trip's messages, so keep the link within the team.

## What it does not do

- It has no memory and no model. It does not read the words of a message, keep trips, answer questions or speak first.
- It does not retry its own requests, and it does not catch up after a gap in change numbers.
- Its pay cards are test cards. Their `approval_id` starts with `ap_fake_`, and nothing can be paid with them. It never sends `request_spend_approval`.
- The watch and vault links open a plain page that says what the real Go shows there.
- It keeps used signatures, seen events and seen taps in memory, so a restart forgets them.
- It sends only `read_trip`, `add_reaction`, `post_message` and `typing`. To test the Server's answers to Go's other requests, use the examples in "Go's requests" in the guide.

## Running it on your machine

```bash
pnpm install && pnpm --filter "@go/fake-go..." build
export GO_SIGNING_SECRET=$(openssl rand -hex 32)
export FAKE_GO_ADMIN_TOKEN=$(openssl rand -hex 16)
node apps/fake-go/dist/main.js
```

It listens on `PORT` (8080 when not set). Point your Server's `GO_URL` at `http://localhost:8080`.
````

(Write the README without the first comment line: it only names the file.)

- [ ] **Step 4: Commit, push, read CI**

```bash
git add apps/fake-go/src/smoke.ts apps/fake-go/scripts/smoke.ts apps/fake-go/src/__tests__/smoke.test.ts apps/fake-go/package.json apps/fake-go/Dockerfile apps/fake-go/railway.json apps/fake-go/README.md .dockerignore
git commit -m "feat(fake-go): the smoke check, Docker build, Railway settings and README for the Server team

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `smoke.test.ts` passes (2 tests); every earlier test still passes. Merge the PR into `build` once its review passes.

- [ ] **Step 5: Deploy to Railway (needs Keshav's OK for the project `go`, master §4).** Ask the conductor to confirm Keshav created or approved the Railway project `go` and its region (proposed `us-west2`, agreed with Nishanth). Then, from the repo root on branch `build`:

```bash
railway link                       # choose the project "go" and its environment
railway add --service fake-go
# Make the two secrets in this shell and send them straight to Railway. They are never printed or written to a file.
GO_SIGNING_SECRET="$(openssl rand -hex 32)" FAKE_GO_ADMIN_TOKEN="$(openssl rand -hex 16)" sh -c \
  'railway variables --service fake-go --set "GO_SIGNING_SECRET=$GO_SIGNING_SECRET" --set "FAKE_GO_ADMIN_TOKEN=$FAKE_GO_ADMIN_TOKEN" --skip-deploys'
railway domain --service fake-go   # prints the public domain, e.g. fake-go-production.up.railway.app
```

In the Railway dashboard for `fake-go`: Settings, Source: connect `vestra-ai/go-brain`, branch `build`, root directory `/`; Settings, Config as code: `apps/fake-go/railway.json`. Railway then builds `apps/fake-go/Dockerfile` and deploys on every push to `build`. Wait for the deploy to turn healthy (`/v1/health`). If a CLI flag differs in your Railway CLI version, do the same in the dashboard: the values and names above are what matter.

- [ ] **Step 6: Run the smoke check against the deployed fake Go**

```bash
GO_URL="https://<the domain from railway domain>" \
GO_SIGNING_SECRET="$(railway variables --service fake-go --kv | sed -n 's/^GO_SIGNING_SECRET=//p')" \
pnpm --filter @go/fake-go smoke
```
Expected: frames printed both ways, then `SMOKE OK: typing on, read_trip, add_reaction, post_message, typing off`. Open `https://<domain>/frames?token=...` in a browser (Keshav reads the token from the dashboard) and check the same frames are listed. Never paste the secret or the token into a chat, a PR or a log.

- [ ] **Step 7: Hand over.** Report the URL to the conductor. Keshav sends Nishanth this message, and sends the secret and the frames token separately through a one-time link:

```text
Hi Nishanth, the fake Go is up, so your team can build the Server's socket against it tonight.

GO_URL: https://<the fake Go's domain>
The socket: wss://<the fake Go's domain>/v1/socket (give each instance its own ?instance= name and sign the full target)
GO_SIGNING_SECRET and the frames token: I'm sending them in a one-time link, separately. Please keep them in your environment variables only.
Health: https://<the fake Go's domain>/v1/health answers {"ok":true,"contract":"1.0.0"}
Frames: https://<the fake Go's domain>/frames?token=<token> shows the last 200 frames both ways.
The guide: https://vestrago.vercel.app/docs (start with The socket, then Go's requests and Your requests).

What it does: it checks your signature on the upgrade (each signature works once), pings every 20 seconds, and accepts every send_event. When a message.created has mentions_go true, it sends typing, read_trip, a ✅ with add_reaction, and post_message with a reply and one of Go's cards (options, working, call, pay, notice, a different one each time), then typing off. card_tap, catch_up, the people requests and vault_link get fixed answers from the guide's examples. Its pay cards are test cards: nothing is ever charged.

If something looks wrong, send me the time and your instance name, and we'll read the frames page together.
```

G0 passes when Nishanth's team confirms their client connected and saw the five requests.

---
### Task 6: One trip in memory (`state/trip-state.ts`): change numbers, events, once per request_id, reads, the room

The simulated Server keeps each trip in a `TripState`. It follows the Server's rules in `docs/guide/04-gos-requests.md`: every change takes the next change number and makes one event (checked against the contract's `Event` before it leaves); a write is done once per `request_id`, with the stored answer checked before any rule; only answers that worked are stored; every rule is checked before anything changes, so a refused write leaves the trip exactly as it was. This task covers the reads, the room writes (`post_message`, `replace_card`, `typing`, reactions, `update_trip`) and what people do in the room (say, react, edit, delete). Tasks 7 and 8 add votes, the record and money as functions over the same class.

Decision (the sim's own rule, not the contract's): a person's message is for Go (`mentions_go`) when it has `@Go` in any case, the word `Go` with a capital G, or replies to one of Go's messages. "let's go" is not for Go. The real Server decides this its own way; P1 only relies on `@Go`.

**Files:**
- Create: `packages/sim/src/state/trip-state.ts`
- Test: `packages/sim/src/__tests__/trip-state.test.ts`

**Interfaces:**
- Consumes: `@go/contract`: `Event`, `MAX_FRAME_BYTES`, types `Card`, `Message`, `TripSnapshot`, and the params schemas `PostMessage`, `ReplaceCard`, `ReadMessages`, `AddReaction`, `RemoveReaction`, `UpdateTrip` (as `typeof` types). Task 1: `SocketCallError`. Task 2 (tests): `goaFreshTrip`.
- Produces:
  - `type Code = 'not_found' | 'invalid' | 'conflict'`; `function fail(code: Code, message: string): SocketCallError`
  - `type Decision`, `type RecordLine`, `type Booking`, `type Expense` (the snapshot's element types); `type Params<S extends z.ZodType> = z.infer<S>`
  - `interface Change<R> { result: R; events: Event[] }`
  - `interface Approval { approval_id; decision_id; payer_person_id; amount_minor; currency; expires_at: Date; used: boolean; cancelled: boolean }`
  - `interface SayOptions { replyTo?: string; aboutMessageId?: string; attachments?: Message['attachments']; withheld?: boolean }`
  - `interface NeedsItem { kind: 'vote' | 'mandate' | 'card' | 'line'; ref: string; text: string }`
  - `interface TripDeps { mint: (prefix: string) => string; now: () => Date; maxPageBytes?: number }`
  - `function mentionsGo(text: string, replyToGo: boolean): boolean`
  - `class TripState` with: `trip: TripSnapshot`, `messages: Message[]`, `answers: Map<string, unknown>`, `approvals: Map<string, Approval>`, `ballots: Map<string, Map<string, number>>`; `get id(): string`; `now(): Date`; `mint(prefix): string`; `created(): Event`; `bump(type, data): Event`; `once<R>(requestId, work: () => Change<R>): Change<R> & { repeat: boolean }`; `person(id, field)`; `people(ids, field)`; `message(id)`; `messageIn(id, field)`; `decision(id)`; `booking(id)`; `currency(c, field)`; `cardMessage(cardId)`; `snapshot()`; `readTrip()`; `readMessages(p)`; `postMessage(p, raw)`; `replaceCard(p, raw)`; `typing(on)`; `typingOn()`; `addReaction(p)`; `removeReaction(p)`; `updateTrip(p)`; `say(personId, text, o?)`; `react(personId, messageId, emoji)`; `edit(personId, messageId, text)`; `delete(personId, messageId)`; `needsYou(personId)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/sim/src/__tests__/trip-state.test.ts
import { describe, expect, it } from 'vitest';
import { Event, Message } from '@go/contract';
import { goaFreshTrip } from '../goa.js';
import { SocketCallError } from '../server-socket.js';
import { TripState, mentionsGo } from '../state/trip-state.js';

function setUp(over: { maxPageBytes?: number } = {}) {
  let t = Date.parse('2026-10-05T07:00:00Z');
  let n = 0;
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const s = new TripState(goaFreshTrip(), { mint: (p) => `${p}${String(++n).padStart(4, '0')}`, now: clock.now, ...over });
  s.created();
  return { s, clock };
}

function err(fn: () => unknown): SocketCallError {
  try {
    fn();
  } catch (e) {
    if (e instanceof SocketCallError) return e;
    throw e;
  }
  throw new Error('it did not throw');
}

/** Go's post_message as the FakeServer runs it: once per request_id, params and raw the same here. */
function post(s: TripState, requestId: string, extra: Record<string, unknown>) {
  const p = { request_id: requestId, trip_id: 't_goa', ...extra };
  return s.once(requestId, () => s.postMessage(p as never, p));
}

const notice = { card_id: 'c_n1', kind: 'notice', fallback_text: 'Note', tone: 'info', title: 'Title', body: 'Body' };

describe('change numbers and events', () => {
  it('starts with trip.created as change 1, and every change takes the next number', () => {
    let n = 0;
    const s = new TripState(goaFreshTrip(), { mint: (p) => `${p}${++n}`, now: () => new Date('2026-10-05T07:00:00Z') });
    const created = s.created();
    expect(created).toMatchObject({ type: 'trip.created', seq: 1, trip_id: 't_goa' });
    expect(Event.safeParse(created).success).toBe(true);
    const said = s.say('p_rahul', 'hello all');
    expect(said.events[0]).toMatchObject({ type: 'message.created', seq: 2 });
    expect(s.readTrip().seq).toBe(2);
  });

  it('decides a message is for Go by @Go, a capital Go, or a reply to Go', () => {
    expect(mentionsGo('@Go flights?', false)).toBe(true);
    expect(mentionsGo('@go flights?', false)).toBe(true);
    expect(mentionsGo('Go, find a villa', false)).toBe(true);
    expect(mentionsGo('Go bhai abhi book kar de', false)).toBe(true);
    expect(mentionsGo("let's go to the beach", false)).toBe(false);
    expect(mentionsGo('Goa it is', false)).toBe(false);
    expect(mentionsGo('sounds good', true)).toBe(true);
  });
});

describe('people in the room', () => {
  it('names people, counts a reply to Go as for Go, and withholds a paused person', () => {
    const { s } = setUp();
    const asked = s.say('p_priya', '@Go flights? @Rahul are you in?').result;
    expect(asked).toMatchObject({ mentions_go: true, mentions: ['p_rahul'], withheld: false });
    const goMessage = post(s, 'rq_1', { text: 'Here are three' }).result;
    expect(s.say('p_arjun', 'sounds good', { replyTo: goMessage.message_id }).result.mentions_go).toBe(true);
    s.trip.people.find((p) => p.person_id === 'p_kabir')!.go_paused = true;
    const hidden = s.say('p_kabir', '@Go secret plans').result;
    expect(hidden).toMatchObject({ withheld: true, mentions_go: false, mentions: [], attachments: [] });
    expect(hidden.text).toBeUndefined();
    expect(err(() => s.say('p_stranger', 'hi')).code).toBe(422);
  });

  it('edits and deletes only the author\'s own message', () => {
    const { s } = setUp();
    const m = s.say('p_arjun', 'I land at 9').result;
    const edited = s.edit('p_arjun', m.message_id, 'I land at 11 pm, @Go');
    expect(edited.events[0]).toMatchObject({ type: 'message.edited' });
    expect(edited.result).toMatchObject({ text: 'I land at 11 pm, @Go', mentions_go: true });
    expect(edited.result.edited_at).toBeTruthy();
    expect(err(() => s.edit('p_priya', m.message_id, 'not mine')).code).toBe(409);
    const gone = s.delete('p_arjun', m.message_id);
    expect(gone.events[0]).toMatchObject({ type: 'message.deleted', data: { message_id: m.message_id } });
    const row = s.readMessages({ trip_id: 't_goa', after_seq: 0 }).messages.find((x) => x.message_id === m.message_id)!;
    expect(row.deleted).toBe(true);
    expect(row.text).toBeUndefined();
  });
});

describe('post_message and replace_card', () => {
  it('posts as Go, with the next change number, and its event carries the message', () => {
    const { s } = setUp();
    const asked = s.say('p_priya', '@Go hi').result;
    const done = post(s, 'rq_1', { text: 'Hi Priya', reply_to: asked.message_id, mentions: ['p_priya'] });
    expect(done.repeat).toBe(false);
    expect(done.result).toEqual({ message_id: expect.any(String), seq: 3 });
    const ev = done.events[0]!;
    expect(ev.type).toBe('message.created');
    if (ev.type === 'message.created') {
      expect(ev.data.message).toMatchObject({ author: { kind: 'go' }, mentions_go: false, text: 'Hi Priya', reply_to: asked.message_id, seq: 3 });
    }
  });

  it('does a write once per request_id, and a refused write leaves nothing behind', () => {
    const { s } = setUp();
    const first = post(s, 'rq_1', { text: 'once' });
    const again = post(s, 'rq_1', { text: 'once' });
    expect(again.repeat).toBe(true);
    expect(again.result).toEqual(first.result);
    expect(again.events).toEqual([]);
    expect(s.messages.filter((m) => m.text === 'once')).toHaveLength(1);
    const seqBefore = s.trip.seq;
    expect(err(() => post(s, 'rq_2', { text: 'hi', mentions: ['p_nobody'] }))).toMatchObject({ code: 422, dataCode: 'invalid' });
    expect(s.trip.seq).toBe(seqBefore);
    expect(s.answers.has('rq_2')).toBe(false);
  });

  it('checks reply_to and record card ids, uses each card_id once, and needs a mandate for a mandate card', () => {
    const { s } = setUp();
    expect(err(() => post(s, 'rq_a', { text: 'x', reply_to: 'm_nope' })).code).toBe(422);
    expect(err(() => post(s, 'rq_b', { card: { card_id: 'c_v', kind: 'vote', decision_id: 'd_nope', fallback_text: 'Vote' } })).code).toBe(422);
    post(s, 'rq_c', { card: notice });
    expect(err(() => post(s, 'rq_d', { card: notice })).code).toBe(409);
    s.trip.decisions.push({
      decision_id: 'd_x', question: 'Where?', kind: 'choice', anonymous: false, status: 'closed',
      options: [{ label: 'A' }, { label: 'B' }], voted: 0, of: 5, tally: [0, 0], opened_at: '2026-10-05T07:00:00Z',
    });
    expect(err(() => post(s, 'rq_e', { card: { card_id: 'c_m', kind: 'mandate', decision_id: 'd_x', fallback_text: 'Book?' } })).code).toBe(409);
  });

  it('stores the card exactly as Go sent it, with fields this copy of the contract does not know', () => {
    const { s } = setUp();
    const raw = { request_id: 'rq_raw', trip_id: 't_goa', card: { ...notice, card_id: 'c_new', sparkle: 'a later field' } };
    const parsed = { request_id: 'rq_raw', trip_id: 't_goa', card: { ...notice, card_id: 'c_new' } };
    const done = s.once('rq_raw', () => s.postMessage(parsed as never, raw));
    expect((s.message(done.result.message_id)!.card as Record<string, unknown>).sparkle).toBe('a later field');
    expect((done.events[0] as any).data.message.card.sparkle).toBe('a later field');
  });

  it('replaces a card in place without a change number, and 404s a card that is not there', () => {
    const { s } = setUp();
    post(s, 'rq_1', { card: notice });
    const seq = s.trip.seq;
    const newer = { ...notice, title: 'Updated' };
    expect(s.replaceCard({ trip_id: 't_goa', card: newer } as never, { trip_id: 't_goa', card: newer })).toEqual({ message_id: expect.any(String) });
    expect(s.trip.seq).toBe(seq);
    expect((s.cardMessage('c_n1')!.card as Record<string, unknown>).title).toBe('Updated');
    const missing = { ...notice, card_id: 'c_missing' };
    expect(err(() => s.replaceCard({ trip_id: 't_goa', card: missing } as never, { trip_id: 't_goa', card: missing })).code).toBe(404);
  });
});

describe('typing, reactions and trip details', () => {
  it('shows typing for 10 seconds, or until off, or until Go posts', () => {
    const { s, clock } = setUp();
    s.typing(true);
    expect(s.typingOn()).toBe(true);
    clock.advance(9_000);
    expect(s.typingOn()).toBe(true);
    clock.advance(2_000);
    expect(s.typingOn()).toBe(false);
    s.typing(true);
    s.typing(false);
    expect(s.typingOn()).toBe(false);
    s.typing(true);
    post(s, 'rq_t', { text: 'landed' });
    expect(s.typingOn()).toBe(false);
  });

  it("adds and removes Go's reactions with the contract's rules", () => {
    const { s } = setUp();
    const m = s.say('p_priya', "Let's do North Goa").result;
    const r = (emoji: string, id: string, messageId = m.message_id) => ({ request_id: id, trip_id: 't_goa', message_id: messageId, emoji });
    const added = s.once('rq_r1', () => s.addReaction(r('✅', 'rq_r1')));
    expect(added.events[0]).toMatchObject({ type: 'reaction.added', data: { message_id: m.message_id, reaction: { emoji: '✅', person_id: null } } });
    expect(s.message(m.message_id)!.updated_seq).toBe(added.events[0]!.seq);
    expect(err(() => s.addReaction(r('✅', 'rq_r2'))).code).toBe(409);
    expect(err(() => s.addReaction(r('✅', 'rq_r3', 'm_nope'))).code).toBe(404);
    expect(err(() => s.removeReaction(r('👍', 'rq_r4'))).code).toBe(409);
    expect(s.removeReaction(r('✅', 'rq_r5')).events[0]).toMatchObject({ type: 'reaction.removed', data: { reaction: { emoji: '✅', person_id: null } } });
    s.delete('p_priya', m.message_id);
    expect(err(() => s.addReaction(r('👍', 'rq_r6'))).code).toBe(409);
  });

  it('updates trip details with the contract\'s rules', () => {
    const { s } = setUp();
    expect(err(() => s.updateTrip({ request_id: 'rq_u0', trip_id: 't_goa' })).code).toBe(422);
    expect(err(() => s.updateTrip({ request_id: 'rq_u1', trip_id: 't_goa', dates: { start: '2026-11-09', end: '2026-11-06' } })).code).toBe(422);
    const badItinerary = [{ date: '2026-11-06', items: [{ title: 'Check in', category: 'stay' as const, status: 'booked' as const, booking_id: 'b_nope' }] }];
    expect(err(() => s.updateTrip({ request_id: 'rq_u2', trip_id: 't_goa', itinerary: badItinerary })).code).toBe(422);
    const done = s.updateTrip({ request_id: 'rq_u3', trip_id: 't_goa', title: 'Goa!', dates: { start: '2026-11-06', end: '2026-11-09' } });
    expect(done.events[0]).toMatchObject({ type: 'trip.updated', data: { by: { kind: 'go' }, changed: ['title', 'dates'] } });
    expect(s.readTrip()).toMatchObject({ title: 'Goa!', dates: { start: '2026-11-06', end: '2026-11-09' } });
  });
});

describe('read_messages', () => {
  it('pages in change order, shrinks a page to stay under the frame limit, and loses nothing', () => {
    const { s } = setUp({ maxPageBytes: 3000 });
    const ids = Array.from({ length: 10 }, (_, i) => s.say('p_rahul', `message ${i} ${'x'.repeat(300)}`).result.message_id);
    s.react('p_meher', ids[0]!, '👍'); // a reaction moves message 0 to the end of the change order
    const first = s.readMessages({ trip_id: 't_goa', after_seq: 0, limit: 200 });
    expect(first.has_more).toBe(true);
    expect(first.messages.length).toBeLessThan(10);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(3000);
    const all = [...first.messages];
    let after = first.messages[first.messages.length - 1]!.updated_seq;
    for (let more = first.has_more; more; ) {
      const page = s.readMessages({ trip_id: 't_goa', after_seq: after });
      all.push(...page.messages);
      more = page.has_more;
      after = page.messages[page.messages.length - 1]?.updated_seq ?? after;
    }
    expect(all.map((m) => m.message_id)).toEqual([...ids.slice(1), ids[0]]);
    for (const m of all) expect(Message.safeParse(m).success).toBe(true);
    const limited = s.readMessages({ trip_id: 't_goa', after_seq: 0, limit: 2 });
    expect(limited.messages).toHaveLength(2);
    expect(limited.has_more).toBe(true);
  });
});

describe('needs you', () => {
  it("lists Go cards that name the person and open lines that ask them", () => {
    const { s } = setUp();
    post(s, 'rq_pin', { card: { ...notice, card_id: 'c_pin', fallback_text: 'Rahul, have a look', for_person_ids: ['p_rahul'] } });
    s.trip.record.push({
      line_id: 'r_q', kind: 'open', text: 'Scuba on Saturday?', status: 'active', proof: [], person_ids: ['p_meher'],
      source: 'go', created_at: '2026-10-05T07:00:00Z', updated_at: '2026-10-05T07:00:00Z',
    });
    expect(s.needsYou('p_rahul')).toEqual([{ kind: 'card', ref: 'c_pin', text: 'Rahul, have a look' }]);
    expect(s.needsYou('p_meher')).toEqual([{ kind: 'line', ref: 'r_q', text: 'Scuba on Saturday?' }]);
    expect(s.needsYou('p_kabir')).toEqual([]);
  });
});
```

- [ ] **Step 2: Push the test and see it fail.** Red is certain: the module does not exist yet. Skip to Step 3.

- [ ] **Step 3: Write the implementation**

```ts
// packages/sim/src/state/trip-state.ts
// One trip as the simulated Server holds it, in memory: the snapshot, the room's messages, the stored answers to
// Go's writes, spend approvals, and every ballot (even in an anonymous vote). It follows the Server's rules in
// docs/guide/04-gos-requests.md: every change takes the next change number and makes one event; a write is done
// once per request_id, with the stored answer checked before any rule; every rule is checked before anything
// changes, so a refused write leaves the trip as it was.
import { Event, MAX_FRAME_BYTES, type Card, type Message, type TripSnapshot } from '@go/contract';
import type * as C from '@go/contract';
import type { z } from 'zod';
import { SocketCallError } from '../server-socket.js';

export type Code = 'not_found' | 'invalid' | 'conflict';
const NUMBER: Record<Code, number> = { not_found: 404, invalid: 422, conflict: 409 };

/** The error Go gets: the number in error.code and the name in error.data.code. */
export const fail = (code: Code, message: string): SocketCallError => new SocketCallError(NUMBER[code], message.slice(0, 500), code);

export type Decision = TripSnapshot['decisions'][number];
export type RecordLine = TripSnapshot['record'][number];
export type Booking = TripSnapshot['bookings'][number];
export type Expense = TripSnapshot['expenses'][number];
export type Params<S extends z.ZodType> = z.infer<S>;

export interface Approval {
  approval_id: string;
  decision_id: string;
  payer_person_id: string;
  amount_minor: number;
  currency: string;
  expires_at: Date;
  used: boolean;
  cancelled: boolean;
}

export interface Change<R> {
  result: R;
  events: Event[];
}

export interface SayOptions {
  replyTo?: string;
  aboutMessageId?: string;
  attachments?: Message['attachments'];
  /** Defaults to the person's go_paused. */
  withheld?: boolean;
}

export interface NeedsItem {
  kind: 'vote' | 'mandate' | 'card' | 'line';
  ref: string;
  text: string;
}

export interface TripDeps {
  mint: (prefix: string) => string;
  now: () => Date;
  /** The largest read_messages answer. Defaults to the frame limit, less room for the frame around it. */
  maxPageBytes?: number;
}

/** How the sim decides a message is for Go: "@Go" in any case, the word "Go" with a capital G, or a reply to Go. */
export function mentionsGo(text: string, replyToGo: boolean): boolean {
  return replyToGo || /@go\b/i.test(text) || /\bGo\b/.test(text);
}

const GO_TYPING_MS = 10_000;

export class TripState {
  readonly trip: TripSnapshot;
  readonly messages: Message[] = [];
  /** request_id to the answer Go got. Only writes that worked are here. */
  readonly answers = new Map<string, unknown>();
  readonly approvals = new Map<string, Approval>();
  /** decision_id to person_id to option index, for every vote, anonymous ones included. */
  readonly ballots = new Map<string, Map<string, number>>();
  private typingUntil = 0;

  constructor(snapshot: TripSnapshot, private readonly deps: TripDeps) {
    this.trip = structuredClone(snapshot);
    for (const d of this.trip.decisions) {
      this.ballots.set(d.decision_id, new Map((d.votes ?? []).map((v) => [v.person_id, v.option_index])));
    }
  }

  get id(): string {
    return this.trip.trip_id;
  }

  now(): Date {
    return this.deps.now();
  }

  mint(prefix: string): string {
    return this.deps.mint(prefix);
  }

  /** trip.created: change number 1, carrying the whole trip. */
  created(): Event {
    this.trip.seq = 0;
    return this.bump('trip.created', { trip: { ...this.snapshot(), seq: 1 } });
  }

  /** Takes the next change number and makes its event. Never sends an event that breaks the contract. */
  bump<T extends Event['type']>(type: T, data: Extract<Event, { type: T }>['data']): Event {
    this.trip.seq += 1;
    const event = { event_id: this.mint('ev_'), trip_id: this.id, seq: this.trip.seq, occurred_at: this.now().toISOString(), type, data };
    Event.parse(event); // checks it; the event sent keeps every field, cards included, exactly as stored
    return event as unknown as Event;
  }

  /** Does a write once per request_id: a repeat gets the first answer back, before any rule runs. */
  once<R>(requestId: string, work: () => Change<R>): Change<R> & { repeat: boolean } {
    if (this.answers.has(requestId)) return { result: this.answers.get(requestId) as R, events: [], repeat: true };
    const change = work();
    this.answers.set(requestId, change.result);
    return { ...change, repeat: false };
  }

  // ── lookups and the shared rules ──

  person(id: string, field: string): void {
    if (!this.trip.people.some((p) => p.person_id === id)) throw fail('invalid', `${field}: ${id} is not in this trip`);
  }

  people(ids: readonly string[], field: string): void {
    for (const id of ids) this.person(id, field);
  }

  message(id: string): Message | undefined {
    return this.messages.find((m) => m.message_id === id);
  }

  messageIn(id: string, field: string): Message {
    const m = this.message(id);
    if (!m) throw fail('invalid', `${field}: ${id} is not a message in this trip`);
    return m;
  }

  decision(id: string): Decision | undefined {
    return this.trip.decisions.find((d) => d.decision_id === id);
  }

  booking(id: string): Booking | undefined {
    return this.trip.bookings.find((b) => b.booking_id === id);
  }

  /** Every amount in a trip uses the trip's one currency. */
  currency(c: string | null | undefined, field: string): void {
    if (c != null && c !== this.trip.money.currency) throw fail('invalid', `${field}: ${c} is not the trip's currency, ${this.trip.money.currency}`);
  }

  cardMessage(cardId: string): Message | undefined {
    return this.messages.find((m) => m.card?.card_id === cardId);
  }

  // ── reads ──

  /** The trip as Go may see it: an anonymous vote never says who voted for what. */
  snapshot(): TripSnapshot {
    const s = structuredClone(this.trip);
    for (const d of s.decisions) if (d.anonymous) delete d.votes;
    return s;
  }

  readTrip(): TripSnapshot {
    return this.snapshot();
  }

  /** Messages changed after a change number, oldest change first, with fewer than `limit` when the page would be too big. */
  readMessages(p: Params<typeof C.ReadMessages>): { messages: Message[]; has_more: boolean } {
    const limit = p.limit ?? 200;
    const changed = this.messages.filter((m) => m.updated_seq > p.after_seq).sort((a, b) => a.updated_seq - b.updated_seq);
    const page = changed.slice(0, limit).map((m) => structuredClone(m));
    let hasMore = changed.length > page.length;
    const max = this.deps.maxPageBytes ?? MAX_FRAME_BYTES - 4096;
    while (page.length > 1 && Buffer.byteLength(JSON.stringify({ messages: page, has_more: false })) > max) {
      page.pop();
      hasMore = true;
    }
    return { messages: page, has_more: hasMore };
  }

  // ── Go in the room ──

  postMessage(p: Params<typeof C.PostMessage>, raw: Record<string, unknown>): Change<{ message_id: string; seq: number }> {
    this.people(p.mentions ?? [], 'mentions');
    if (p.reply_to != null) this.messageIn(p.reply_to, 'reply_to');
    const card = p.card ?? undefined;
    if (card) {
      this.checkRecordCard(card);
      if (card.kind === 'mandate' && !this.decision(card.decision_id)?.mandate) {
        throw fail('conflict', `decision ${card.decision_id} has no mandate yet: set_mandate first`);
      }
      if (this.cardMessage(card.card_id)) throw fail('conflict', `card ${card.card_id} is already in the room: use replace_card`);
    }
    const seq = this.trip.seq + 1;
    const message: Message = {
      message_id: this.mint('m_'),
      seq,
      updated_seq: seq,
      author: { kind: 'go' },
      ...(p.text != null ? { text: p.text } : {}),
      attachments: [],
      ...(p.reply_to != null ? { reply_to: p.reply_to } : {}),
      mentions_go: false,
      mentions: p.mentions ?? [],
      reactions: [],
      // The card exactly as Go sent it, so a field this copy of the contract does not know still reaches the room.
      ...(raw.card != null ? { card: raw.card as Card } : {}),
      withheld: false,
      deleted: false,
      sent_at: this.now().toISOString(),
    };
    this.messages.push(message);
    this.typingUntil = 0; // Go's message landed, so "Go is typing..." goes away
    const ev = this.bump('message.created', { message: structuredClone(message) });
    return { result: { message_id: message.message_id, seq: ev.seq }, events: [ev] };
  }

  /** Not a change to the trip: no change number, no event. */
  replaceCard(p: Params<typeof C.ReplaceCard>, raw: Record<string, unknown>): { message_id: string } {
    const m = this.cardMessage(p.card.card_id);
    if (!m || m.author.kind !== 'go') throw fail('not_found', `card ${p.card.card_id} is not on one of Go's messages in this trip`);
    m.card = raw.card as Card;
    return { message_id: m.message_id };
  }

  typing(on: boolean): void {
    this.typingUntil = on ? this.now().getTime() + GO_TYPING_MS : 0;
  }

  typingOn(): boolean {
    return this.typingUntil > this.now().getTime();
  }

  addReaction(p: Params<typeof C.AddReaction>): Change<{ seq: number }> {
    const m = this.message(p.message_id);
    if (!m) throw fail('not_found', `message ${p.message_id} is not in this trip`);
    if (m.deleted) throw fail('conflict', `message ${p.message_id} is deleted`);
    if (m.reactions.some((r) => r.person_id == null && r.emoji === p.emoji)) throw fail('conflict', `Go already reacted ${p.emoji} to ${p.message_id}`);
    m.reactions.push({ emoji: p.emoji });
    m.updated_seq = this.trip.seq + 1;
    const ev = this.bump('reaction.added', { message_id: m.message_id, reaction: { emoji: p.emoji, person_id: null } });
    return { result: { seq: ev.seq }, events: [ev] };
  }

  removeReaction(p: Params<typeof C.RemoveReaction>): Change<{ seq: number }> {
    const m = this.message(p.message_id);
    if (!m) throw fail('not_found', `message ${p.message_id} is not in this trip`);
    const i = m.reactions.findIndex((r) => r.person_id == null && r.emoji === p.emoji);
    if (i < 0) throw fail('conflict', `Go has no ${p.emoji} on ${p.message_id}`);
    m.reactions.splice(i, 1);
    m.updated_seq = this.trip.seq + 1;
    const ev = this.bump('reaction.removed', { message_id: m.message_id, reaction: { emoji: p.emoji, person_id: null } });
    return { result: { seq: ev.seq }, events: [ev] };
  }

  updateTrip(p: Params<typeof C.UpdateTrip>): Change<{ seq: number }> {
    const changed: Array<'title' | 'destination' | 'dates' | 'vibe' | 'stay' | 'itinerary'> = [];
    if (p.title != null) changed.push('title');
    if (p.destination != null) changed.push('destination');
    if (p.dates != null) changed.push('dates');
    if (p.vibe != null) changed.push('vibe');
    if (p.stay != null) changed.push('stay');
    if (p.itinerary != null) changed.push('itinerary');
    if (changed.length === 0) throw fail('invalid', 'send at least one field to change besides request_id and trip_id');
    if (p.dates != null && p.dates.start > p.dates.end) throw fail('invalid', 'dates: start is after end');
    for (const day of p.itinerary ?? []) {
      for (const item of day.items) {
        if (item.booking_id != null && !this.booking(item.booking_id)) throw fail('invalid', `itinerary: booking ${item.booking_id} is not in this trip`);
      }
    }
    if (p.title != null) this.trip.title = p.title;
    if (p.destination != null) this.trip.destination = p.destination;
    if (p.dates != null) this.trip.dates = p.dates;
    if (p.vibe != null) this.trip.vibe = p.vibe;
    if (p.stay != null) this.trip.stay = p.stay;
    if (p.itinerary != null) this.trip.itinerary = p.itinerary;
    const ev = this.bump('trip.updated', { by: { kind: 'go' }, changed });
    return { result: { seq: ev.seq }, events: [ev] };
  }

  // ── people in the room (the sim's helpers; the real Server gets these from the App) ──

  say(personId: string, text: string, o: SayOptions = {}): Change<Message> {
    const person = this.trip.people.find((p) => p.person_id === personId);
    if (!person) throw fail('invalid', `personId: ${personId} is not in this trip`);
    const replyTo = o.replyTo != null ? this.messageIn(o.replyTo, 'replyTo') : undefined;
    const withheld = o.withheld ?? person.go_paused;
    const seq = this.trip.seq + 1;
    const message: Message = {
      message_id: this.mint('m_'),
      seq,
      updated_seq: seq,
      author: { kind: 'person', person_id: personId },
      ...(withheld ? {} : { text }),
      attachments: withheld ? [] : (o.attachments ?? []),
      ...(replyTo ? { reply_to: replyTo.message_id } : {}),
      ...(!withheld && o.aboutMessageId != null ? { about_message_id: o.aboutMessageId } : {}),
      mentions_go: !withheld && mentionsGo(text, replyTo?.author.kind === 'go'),
      mentions: withheld ? [] : this.mentioned(text),
      reactions: [],
      withheld,
      deleted: false,
      sent_at: this.now().toISOString(),
    };
    this.messages.push(message);
    const ev = this.bump('message.created', { message: structuredClone(message) });
    return { result: structuredClone(message), events: [ev] };
  }

  react(personId: string, messageId: string, emoji: string): Change<void> {
    this.person(personId, 'personId');
    const m = this.message(messageId);
    if (!m || m.deleted) throw fail('not_found', `message ${messageId} is not in this trip`);
    if (m.reactions.some((r) => r.person_id === personId && r.emoji === emoji)) return { result: undefined, events: [] };
    m.reactions.push({ emoji, person_id: personId });
    m.updated_seq = this.trip.seq + 1;
    const ev = this.bump('reaction.added', { message_id: messageId, reaction: { emoji, person_id: personId } });
    return { result: undefined, events: [ev] };
  }

  edit(personId: string, messageId: string, text: string): Change<Message> {
    const m = this.ownMessage(personId, messageId);
    const replyToGo = m.reply_to != null && this.message(m.reply_to)?.author.kind === 'go';
    m.text = text;
    m.mentions_go = !m.withheld && mentionsGo(text, replyToGo);
    m.mentions = m.withheld ? [] : this.mentioned(text);
    m.edited_at = this.now().toISOString();
    m.updated_seq = this.trip.seq + 1;
    const ev = this.bump('message.edited', { message: structuredClone(m) });
    return { result: structuredClone(m), events: [ev] };
  }

  delete(personId: string, messageId: string): Change<void> {
    const m = this.ownMessage(personId, messageId);
    m.deleted = true;
    delete m.text;
    m.attachments = [];
    m.updated_seq = this.trip.seq + 1;
    const ev = this.bump('message.deleted', { message_id: messageId });
    return { result: undefined, events: [ev] };
  }

  /** What the App's "needs you" strip shows this person, worked out from the trip like the Server does. */
  needsYou(personId: string): NeedsItem[] {
    const out: NeedsItem[] = [];
    for (const d of this.trip.decisions) {
      if (d.status === 'open' && !this.ballots.get(d.decision_id)?.has(personId)) out.push({ kind: 'vote', ref: d.decision_id, text: d.question });
      const m = d.mandate;
      if (m && m.payer_person_id === personId && m.confirmed_at == null && m.declined_at == null) {
        out.push({ kind: 'mandate', ref: d.decision_id, text: `Book ${d.options[m.choice_index]?.label ?? 'the winner'}?` });
      }
    }
    for (const msg of this.messages) {
      if (msg.card?.for_person_ids?.includes(personId)) out.push({ kind: 'card', ref: msg.card.card_id, text: msg.card.fallback_text });
    }
    for (const l of this.trip.record) {
      if (l.kind === 'open' && l.status === 'active' && l.person_ids.includes(personId)) out.push({ kind: 'line', ref: l.line_id, text: l.text });
    }
    return out;
  }

  private ownMessage(personId: string, messageId: string): Message {
    const m = this.message(messageId);
    if (!m || m.deleted) throw fail('not_found', `message ${messageId} is not in this trip`);
    if (m.author.kind !== 'person' || m.author.person_id !== personId) throw fail('conflict', `${personId} did not write ${messageId}`);
    return m;
  }

  private mentioned(text: string): string[] {
    const lower = text.toLowerCase();
    return this.trip.people.filter((p) => lower.includes(`@${p.name.toLowerCase()}`)).map((p) => p.person_id);
  }

  /** A record card's id must be a row of this trip. */
  private checkRecordCard(card: Card): void {
    if ((card.kind === 'vote' || card.kind === 'mandate') && !this.decision(card.decision_id)) {
      throw fail('invalid', `card.decision_id: ${card.decision_id} is not a vote in this trip`);
    }
    if (card.kind === 'ticket' && !this.booking(card.booking_id)) throw fail('invalid', `card.booking_id: ${card.booking_id} is not a booking in this trip`);
    if (card.kind === 'expense' && !this.trip.expenses.some((e) => e.expense_id === card.expense_id)) {
      throw fail('invalid', `card.expense_id: ${card.expense_id} is not an expense in this trip`);
    }
  }
}
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add packages/sim/src/state/trip-state.ts packages/sim/src/__tests__/trip-state.test.ts
git commit -m "feat(sim): one trip in memory, with change numbers, events, once per request_id and the room's rules

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `trip-state.test.ts` passes (14 tests).

---
### Task 7: Votes and mandates (`state/decisions.ts`)

Go's `open_vote`, `close_vote` and `set_mandate`, with every rule in `docs/guide/04-gos-requests.md`, and what people do in the App: vote (a vote that makes everyone voted closes it), a vote closing on time, and the payer's "Yes, book it" and "Not now". A close writes `decision.closed` and then, when there is a winner, the decided line in the record as a second change by `system`; the answer carries the first change's number. An anonymous vote never says who voted for what, to anyone, Go included; the sim still keeps every ballot for the "needs you" strip.

**Files:**
- Create: `packages/sim/src/state/decisions.ts`
- Test: `packages/sim/src/__tests__/decisions.test.ts`

**Interfaces:**
- Consumes: Task 6: `TripState`, `fail`, `Change`, `Decision`, `RecordLine`, `Params`. `@go/contract`: `OpenDecision`, `CloseDecision`, `SetMandate` (as types), `type Event`.
- Produces:
  - `function openVote(s: TripState, p: Params<typeof C.OpenDecision>): Change<{ decision_id: string; seq: number }>`
  - `function closeVote(s: TripState, p: Params<typeof C.CloseDecision>): Change<{ decision: Decision; seq: number }>`
  - `function setMandate(s: TripState, p: Params<typeof C.SetMandate>): Change<{ seq: number }>`
  - `function vote(s: TripState, decisionId: string, personId: string, optionIndex: number): Change<void>`
  - `function closeVoteByTime(s: TripState, decisionId: string): Change<void>`
  - `function confirmMandate(s: TripState, decisionId: string): Change<void>`, `function declineMandate(s: TripState, decisionId: string): Change<void>`
  - `function publicDecision(d: Decision): Decision`, `function winner(tally: readonly number[]): number | undefined`

- [ ] **Step 1: Write the failing test**

```ts
// packages/sim/src/__tests__/decisions.test.ts
import { describe, expect, it } from 'vitest';
import { Event } from '@go/contract';
import { goaFreshTrip } from '../goa.js';
import { SocketCallError } from '../server-socket.js';
import { closeVote, closeVoteByTime, confirmMandate, declineMandate, openVote, setMandate, vote, winner } from '../state/decisions.js';
import { TripState } from '../state/trip-state.js';

const everyone = ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir'];
const villas = [
  { label: 'Villa Sol', price_minor: 5420000, currency: 'INR' },
  { label: 'Casa Azul', price_minor: 6180000, currency: 'INR' },
  { label: 'The Palms', price_minor: 5850000, currency: 'INR' },
];

function setUp() {
  let t = Date.parse('2026-10-05T07:30:00Z');
  let n = 0;
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const s = new TripState(goaFreshTrip(), { mint: (p) => `${p}${String(++n).padStart(4, '0')}`, now: clock.now });
  s.created();
  return { s, clock };
}

function open(s: TripState, extra: Record<string, unknown> = {}) {
  return openVote(s, { request_id: 'rq_open', trip_id: 't_goa', question: 'Where do we stay?', kind: 'choice', anonymous: false, options: villas, ...extra } as never);
}

function err(fn: () => unknown): SocketCallError {
  try {
    fn();
  } catch (e) {
    if (e instanceof SocketCallError) return e;
    throw e;
  }
  throw new Error('it did not throw');
}

const types = (events: Event[]) => events.map((e) => e.type);

describe('open_vote', () => {
  it('opens a vote by Go, for everyone in the trip, with a tally of zeros', () => {
    const { s } = setUp();
    const done = open(s);
    expect(done.result).toEqual({ decision_id: expect.any(String), seq: 2 });
    const ev = done.events[0]!;
    expect(ev).toMatchObject({ type: 'decision.opened', seq: 2, data: { by: { kind: 'go' }, decision: { status: 'open', voted: 0, of: 5, tally: [0, 0, 0], votes: [] } } });
    if (ev.type === 'decision.opened') expect(ev.data.decision.opened_by_person_id).toBeUndefined();
    expect(s.needsYou('p_rahul')).toEqual([{ kind: 'vote', ref: done.result.decision_id, text: 'Where do we stay?' }]);
  });

  it('refuses a closing time in the past and an option in another currency', () => {
    const { s } = setUp();
    expect(err(() => open(s, { closes_at: '2026-10-05T07:00:00Z' })).code).toBe(422);
    expect(err(() => open(s, { options: [{ label: 'A', price_minor: 100, currency: 'USD' }, { label: 'B' }] })).code).toBe(422);
  });
});

describe('voting and closing', () => {
  it('counts votes, and closes the vote with its decided line once everyone has voted', () => {
    const { s } = setUp();
    const id = open(s).result.decision_id;
    const events: Event[] = [];
    for (const [i, person] of everyone.entries()) events.push(...vote(s, id, person, i === 2 ? 1 : 0).events);
    expect(types(events)).toEqual(['decision.voted', 'decision.voted', 'decision.voted', 'decision.voted', 'decision.voted', 'decision.closed', 'record.changed']);
    expect(events.map((e) => e.seq)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(events[0]).toMatchObject({ data: { person_id: 'p_rahul', option_index: 0, voted: 1, of: 5, tally: [1, 0, 0] } });
    expect(events[5]).toMatchObject({ data: { reason: 'everyone_voted', decision: { status: 'closed', result_index: 0, tally: [4, 1, 0] } } });
    expect(events[6]).toMatchObject({ data: { change: 'added', by: { kind: 'system' }, line: { kind: 'decided', text: 'Villa Sol', decision_id: id, source: 'vote' } } });
    expect(s.needsYou('p_rahul')).toEqual([]);
  });

  it('changes a vote, and does nothing for the same vote twice', () => {
    const { s } = setUp();
    const id = open(s).result.decision_id;
    vote(s, id, 'p_priya', 0);
    expect(vote(s, id, 'p_priya', 0).events).toEqual([]);
    const changed = vote(s, id, 'p_priya', 2).events[0]!;
    expect(changed).toMatchObject({ data: { voted: 1, tally: [0, 0, 1] } });
    expect(err(() => vote(s, id, 'p_priya', 7)).code).toBe(422);
    expect(err(() => vote(s, id, 'p_stranger', 0)).code).toBe(422);
  });

  it('close_vote closes now, answers the vote and the first change number, and refuses a second close', () => {
    const { s } = setUp();
    const id = open(s).result.decision_id;
    vote(s, id, 'p_rahul', 1);
    const done = closeVote(s, { request_id: 'rq_close', trip_id: 't_goa', decision_id: id });
    expect(types(done.events)).toEqual(['decision.closed', 'record.changed']);
    expect(done.result.seq).toBe(done.events[0]!.seq);
    expect(done.result.decision).toMatchObject({ status: 'closed', result_index: 1 });
    expect(done.events[0]).toMatchObject({ data: { reason: 'closed_by_go' } });
    expect(err(() => closeVote(s, { request_id: 'rq_again', trip_id: 't_goa', decision_id: id })).code).toBe(409);
    expect(err(() => closeVote(s, { request_id: 'rq_nope', trip_id: 't_goa', decision_id: 'd_nope' })).code).toBe(404);
  });

  it('a tie or no votes closes with no winner and no decided line', () => {
    const { s } = setUp();
    const id = open(s).result.decision_id;
    vote(s, id, 'p_rahul', 0);
    vote(s, id, 'p_priya', 1);
    const closed = closeVoteByTime(s, id);
    expect(types(closed.events)).toEqual(['decision.closed']);
    expect(closed.events[0]).toMatchObject({ data: { reason: 'time' } });
    expect(s.decision(id)!.result_index).toBeUndefined();
    expect(winner([4, 1, 0])).toBe(0);
    expect(winner([1, 1, 0])).toBeUndefined();
    expect(winner([0, 0])).toBeUndefined();
  });

  it('an anonymous vote never says who voted for what, and still knows who has voted', () => {
    const { s } = setUp();
    const opened = open(s, { anonymous: true });
    const id = opened.result.decision_id;
    expect((opened.events[0] as any).data.decision.votes).toBeUndefined();
    const voted = vote(s, id, 'p_meher', 2).events[0] as any;
    expect(voted.data.person_id).toBeUndefined();
    expect(voted.data.option_index).toBeUndefined();
    expect(voted.data.tally).toEqual([0, 0, 1]);
    expect(s.readTrip().decisions[0]!.votes).toBeUndefined();
    expect(s.needsYou('p_meher')).toEqual([]);
    expect(s.needsYou('p_kabir')).toHaveLength(1);
  });
});

describe('set_mandate and the payer', () => {
  function closedVillaVote(s: TripState): string {
    const id = open(s).result.decision_id;
    for (const person of everyone) vote(s, id, person, 0);
    return id;
  }
  const mandate = (decision_id: string, extra: Record<string, unknown> = {}) => ({
    request_id: 'rq_m', trip_id: 't_goa', decision_id, choice_index: 0, cap_minor: 5500000, currency: 'INR', refundable_only: true, payer_person_id: 'p_rahul', ...extra,
  }) as never;

  it("refuses an open vote, a yes or no vote, a missing option, a payer outside the trip and another currency", () => {
    const { s } = setUp();
    const openId = open(s).result.decision_id;
    expect(err(() => setMandate(s, mandate(openId))).code).toBe(409);
    const yesno = openVote(s, { request_id: 'rq_yn', trip_id: 't_goa', question: 'Scuba?', kind: 'yesno', anonymous: false, options: [{ label: 'Yes' }, { label: 'No' }] } as never).result.decision_id;
    closeVoteByTime(s, yesno);
    expect(err(() => setMandate(s, mandate(yesno))).code).toBe(409);
    const { s: t } = setUp();
    const villa = closedVillaVote(t);
    expect(err(() => setMandate(t, mandate(villa, { choice_index: 3 }))).code).toBe(422);
    expect(err(() => setMandate(t, mandate(villa, { payer_person_id: 'p_stranger' }))).code).toBe(422);
    expect(err(() => setMandate(t, mandate(villa, { currency: 'USD' }))).code).toBe(422);
    expect(err(() => setMandate(t, mandate('d_nope'))).code).toBe(404);
  });

  it('sets the mandate, pins it for the payer, and the payer says yes or no', () => {
    const { s, clock } = setUp();
    const id = closedVillaVote(s);
    const set = setMandate(s, mandate(id));
    expect(set.events[0]).toMatchObject({ type: 'mandate.set', data: { decision_id: id, mandate: { cap_minor: 5500000, payer_person_id: 'p_rahul' } } });
    expect(s.needsYou('p_rahul')).toEqual([{ kind: 'mandate', ref: id, text: 'Book Villa Sol?' }]);
    clock.advance(60_000);
    expect(confirmMandate(s, id).events[0]).toMatchObject({ type: 'mandate.confirmed', data: { decision_id: id, person_id: 'p_rahul' } });
    expect(s.needsYou('p_rahul')).toEqual([]);
    clock.advance(60_000);
    expect(declineMandate(s, id).events[0]).toMatchObject({ type: 'mandate.declined', data: { person_id: 'p_rahul' } });
    setMandate(s, mandate(id, { cap_minor: 6000000 }));
    expect(s.decision(id)!.mandate).toMatchObject({ cap_minor: 6000000 });
    expect(s.decision(id)!.mandate!.confirmed_at).toBeUndefined();
    expect(s.decision(id)!.mandate!.declined_at).toBeUndefined();
    const { s: other } = setUp();
    expect(err(() => confirmMandate(other, closedVillaVote(other))).code).toBe(409);
  });
});
```

- [ ] **Step 2: Push the test and see it fail.** Red is certain: the module does not exist yet. Skip to Step 3.

- [ ] **Step 3: Write the implementation**

```ts
// packages/sim/src/state/decisions.ts
// Votes and mandates, with the Server's rules from docs/guide/04-gos-requests.md (open_vote, close_vote,
// set_mandate), and what people do with them in the App: vote, and the payer's "Yes, book it" and "Not now".
import type * as C from '@go/contract';
import type { Event } from '@go/contract';
import { fail, type Change, type Decision, type Params, type RecordLine, type TripState } from './trip-state.js';

type CloseReason = 'time' | 'everyone_voted' | 'closed_by_person' | 'closed_by_go';

/** The vote as Go may see it: an anonymous vote never says who voted for what. */
export function publicDecision(d: Decision): Decision {
  const copy = structuredClone(d);
  if (copy.anonymous) delete copy.votes;
  return copy;
}

/** The winning option: the most votes. None when nobody voted or the top options tied (Go then asks the group). */
export function winner(tally: readonly number[]): number | undefined {
  const top = Math.max(0, ...tally);
  if (top === 0) return undefined;
  return tally.filter((v) => v === top).length === 1 ? tally.indexOf(top) : undefined;
}

export function openVote(s: TripState, p: Params<typeof C.OpenDecision>): Change<{ decision_id: string; seq: number }> {
  if (p.closes_at != null && Date.parse(p.closes_at) <= s.now().getTime()) throw fail('invalid', 'closes_at: must be in the future');
  p.options.forEach((o, i) => s.currency(o.currency, `options[${i}].currency`));
  const decision: Decision = {
    decision_id: s.mint('d_'),
    question: p.question,
    kind: p.kind,
    anonymous: p.anonymous,
    status: 'open',
    options: p.options,
    ...(p.closes_at != null ? { closes_at: p.closes_at } : {}),
    voted: 0,
    of: s.trip.people.length,
    tally: p.options.map(() => 0),
    ...(p.anonymous ? {} : { votes: [] }),
    opened_at: s.now().toISOString(),
  };
  s.trip.decisions.push(decision);
  s.ballots.set(decision.decision_id, new Map());
  const ev = s.bump('decision.opened', { decision: publicDecision(decision), by: { kind: 'go' } });
  return { result: { decision_id: decision.decision_id, seq: ev.seq }, events: [ev] };
}

export function closeVote(s: TripState, p: Params<typeof C.CloseDecision>): Change<{ decision: Decision; seq: number }> {
  const d = s.decision(p.decision_id);
  if (!d) throw fail('not_found', `decision ${p.decision_id} is not in this trip`);
  if (d.status !== 'open') throw fail('conflict', `decision ${d.decision_id} is already ${d.status}`);
  const events = close(s, d, 'closed_by_go');
  return { result: { decision: publicDecision(d), seq: events[0]!.seq }, events };
}

export function setMandate(s: TripState, p: Params<typeof C.SetMandate>): Change<{ seq: number }> {
  const d = s.decision(p.decision_id);
  if (!d) throw fail('not_found', `decision ${p.decision_id} is not in this trip`);
  if (d.kind !== 'choice') throw fail('conflict', `decision ${d.decision_id} is a yes or no vote, which never has a mandate`);
  if (d.status !== 'closed') throw fail('conflict', `decision ${d.decision_id} is not closed`);
  if (p.choice_index >= d.options.length) throw fail('invalid', `choice_index: ${p.choice_index} is not one of the ${d.options.length} options`);
  s.person(p.payer_person_id, 'payer_person_id');
  s.currency(p.currency, 'currency');
  // A new mandate replaces the old one and clears the payer's earlier yes or no.
  d.mandate = {
    choice_index: p.choice_index,
    cap_minor: p.cap_minor,
    currency: p.currency,
    refundable_only: p.refundable_only,
    payer_person_id: p.payer_person_id,
    set_at: s.now().toISOString(),
  };
  const ev = s.bump('mandate.set', { decision_id: d.decision_id, mandate: structuredClone(d.mandate) });
  return { result: { seq: ev.seq }, events: [ev] };
}

// ── what people do in the App (the sim's helpers) ──

export function vote(s: TripState, decisionId: string, personId: string, optionIndex: number): Change<void> {
  const d = openDecision(s, decisionId);
  s.person(personId, 'personId');
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= d.options.length) {
    throw fail('invalid', `optionIndex: ${optionIndex} is not one of the ${d.options.length} options`);
  }
  const ballots = s.ballots.get(d.decision_id) ?? new Map<string, number>();
  s.ballots.set(d.decision_id, ballots);
  if (ballots.get(personId) === optionIndex) return { result: undefined, events: [] };
  ballots.set(personId, optionIndex);
  d.tally = d.options.map((_, i) => [...ballots.values()].filter((v) => v === i).length);
  d.voted = ballots.size;
  if (!d.anonymous) d.votes = [...ballots].map(([person_id, option_index]) => ({ person_id, option_index }));
  const events: Event[] = [
    s.bump('decision.voted', {
      decision_id: d.decision_id,
      ...(d.anonymous ? {} : { person_id: personId, option_index: optionIndex }),
      voted: d.voted,
      of: d.of,
      tally: [...d.tally],
    }),
  ];
  if (d.voted >= d.of) events.push(...close(s, d, 'everyone_voted'));
  return { result: undefined, events };
}

export function closeVoteByTime(s: TripState, decisionId: string): Change<void> {
  return { result: undefined, events: close(s, openDecision(s, decisionId), 'time') };
}

/** The payer taps "Yes, book it" on the mandate card. */
export function confirmMandate(s: TripState, decisionId: string): Change<void> {
  const d = s.decision(decisionId);
  if (!d?.mandate) throw fail('conflict', `decision ${decisionId} has no mandate`);
  d.mandate.confirmed_at = s.now().toISOString();
  const ev = s.bump('mandate.confirmed', { decision_id: d.decision_id, person_id: d.mandate.payer_person_id });
  return { result: undefined, events: [ev] };
}

/** The payer taps "Not now". */
export function declineMandate(s: TripState, decisionId: string): Change<void> {
  const d = s.decision(decisionId);
  if (!d?.mandate) throw fail('conflict', `decision ${decisionId} has no mandate`);
  d.mandate.declined_at = s.now().toISOString();
  const ev = s.bump('mandate.declined', { decision_id: d.decision_id, person_id: d.mandate.payer_person_id });
  return { result: undefined, events: [ev] };
}

function openDecision(s: TripState, decisionId: string): Decision {
  const d = s.decision(decisionId);
  if (!d) throw fail('not_found', `decision ${decisionId} is not in this trip`);
  if (d.status !== 'open') throw fail('conflict', `decision ${decisionId} is already ${d.status}`);
  return d;
}

/** Closes a vote: decision.closed, then the decided line in the record (a second change, by system) when there is a winner. */
function close(s: TripState, d: Decision, reason: CloseReason): Event[] {
  const at = s.now().toISOString();
  d.status = 'closed';
  d.closed_at = at;
  const win = winner(d.tally);
  if (win === undefined) delete d.result_index;
  else d.result_index = win;
  const events: Event[] = [s.bump('decision.closed', { decision: publicDecision(d), reason })];
  const label = win === undefined ? undefined : d.options[win]?.label;
  if (label !== undefined) {
    const line: RecordLine = {
      line_id: s.mint('r_'),
      kind: 'decided',
      text: label,
      status: 'active',
      proof: [],
      person_ids: [],
      decision_id: d.decision_id,
      source: 'vote',
      created_at: at,
      updated_at: at,
    };
    s.trip.record.push(line);
    events.push(s.bump('record.changed', { line: structuredClone(line), change: 'added', by: { kind: 'system' } }));
  }
  return events;
}
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add packages/sim/src/state/decisions.ts packages/sim/src/__tests__/decisions.test.ts
git commit -m "feat(sim): votes and mandates with the Server's rules, and the payer's yes or no

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `decisions.test.ts` passes (9 tests).

---
### Task 8: The trip record, bookings, expenses and spend approvals (`state/records.ts`, `state/money.ts`)

The rest of Go's writes, with the Server's rules from `docs/guide/04-gos-requests.md` and `docs/guide/08-money-and-the-vault.md`: record lines Go writes (agreed, open, doing) and their updates; `add_booking` with the approval checks (`409` for another trip's approval, another vote, used or cancelled, or more than approved) that marks the approval used and turns the vote's decided line into the booked line as a second change; `update_booking`; `add_expense` with the money maths (equal split, the payer keeps any leftover paise, fewest transfers), which reproduces the guide's Goa money exactly; the spend check in the guide's order (not the enum's order); approvals signed with the TEST key; and `cancel_spend_approval`, safe to repeat.

**Files:**
- Create: `packages/sim/src/state/records.ts`
- Create: `packages/sim/src/state/money.ts`
- Test: `packages/sim/src/__tests__/records.test.ts`
- Test: `packages/sim/src/__tests__/money.test.ts`

**Interfaces:**
- Consumes: Task 6: `TripState`, `fail`, `Change`, `Params`, `RecordLine`, `Booking`, `Expense`. Task 7 (tests): `openVote`, `vote`, `setMandate`, `confirmMandate`, `declineMandate`. Task 2 (tests): `GOA_SNAPSHOT`, `TEST_SPEND_PRIVATE_KEY_PEM`, `TEST_SPEND_PUBLIC_KEY_PEM`. `@go/contract`: `signSpendApproval`, `MAX_APPROVAL_TTL_SECONDS`, `verifySpendApproval` (tests), and the params schemas `AddRecordLine`, `UpdateRecordLine`, `AddBooking`, `UpdateBooking`, `AddExpense`, `RequestSpendApproval`, `CancelSpendApproval`, `SpendApprovalResult`, `SpendDenialReason` (as types).
- Produces:
  - `function addRecordLine(s, p): Change<{ line_id: string; seq: number }>`, `function updateRecordLine(s, p): Change<{ seq: number }>`
  - `function addBooking(s, p): Change<{ booking_id: string; seq: number }>`, `function updateBooking(s, p): Change<{ seq: number }>`
  - `function addExpense(s, p): Change<{ expense_id: string; seq: number }>`, `function recomputeMoney(s: TripState): void`
  - `function spendCheck(s, p): DenialReason | null`
  - `function requestSpendApproval(s, p, privateKeyPem: string): Change<z.infer<typeof SpendApprovalResult>>`
  - `function cancelSpendApproval(s, p): Change<{ ok: true }>`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/sim/src/__tests__/records.test.ts
import { describe, expect, it } from 'vitest';
import { goaFreshTrip } from '../goa.js';
import { SocketCallError } from '../server-socket.js';
import { addRecordLine, updateRecordLine } from '../state/records.js';
import { TripState } from '../state/trip-state.js';

function setUp() {
  let n = 0;
  const s = new TripState(goaFreshTrip(), { mint: (p) => `${p}${String(++n).padStart(4, '0')}`, now: () => new Date('2026-10-05T04:14:00Z') });
  s.created();
  const priya = s.say('p_priya', "Let's do North Goa, not South.").result;
  const arjun = s.say('p_arjun', 'Yes, North.').result;
  return { s, priya, arjun };
}

function err(fn: () => unknown): SocketCallError {
  try {
    fn();
  } catch (e) {
    if (e instanceof SocketCallError) return e;
    throw e;
  }
  throw new Error('it did not throw');
}

describe('record lines Go writes', () => {
  it('adds an agreed line by Go, with its proof', () => {
    const { s, priya, arjun } = setUp();
    const done = addRecordLine(s, {
      request_id: 'rq_l1', trip_id: 't_goa', kind: 'agreed', text: 'North Goa, not South',
      proof: [{ message_id: priya.message_id, person_id: 'p_priya' }, { message_id: arjun.message_id, person_id: 'p_arjun' }],
      person_ids: ['p_priya', 'p_arjun', 'p_rahul'],
    });
    expect(done.result).toEqual({ line_id: expect.any(String), seq: done.events[0]!.seq });
    expect(done.events[0]).toMatchObject({
      type: 'record.changed',
      data: { change: 'added', by: { kind: 'go' }, line: { kind: 'agreed', status: 'active', source: 'go', text: 'North Goa, not South' } },
    });
  });

  it('refuses an agreed line without proof, proof from outside the trip, and people outside the trip', () => {
    const { s, priya } = setUp();
    const base = { request_id: 'rq_l2', trip_id: 't_goa', text: 'Scuba on Saturday?', person_ids: ['p_meher'] };
    expect(err(() => addRecordLine(s, { ...base, kind: 'agreed', proof: [] })).code).toBe(422);
    expect(err(() => addRecordLine(s, { ...base, kind: 'open', proof: [{ message_id: 'm_nope' }] })).code).toBe(422);
    expect(err(() => addRecordLine(s, { ...base, kind: 'open', proof: [{ message_id: priya.message_id, person_id: 'p_stranger' }] })).code).toBe(422);
    expect(err(() => addRecordLine(s, { ...base, kind: 'open', proof: [], person_ids: ['p_stranger'] })).code).toBe(422);
    expect(addRecordLine(s, { ...base, kind: 'open', proof: [] }).events).toHaveLength(1);
  });

  it("updates only Go's lines that were not undone, and says done when the status becomes done", () => {
    const { s, priya } = setUp();
    const lineId = addRecordLine(s, { request_id: 'rq_l3', trip_id: 't_goa', kind: 'doing', text: 'Kabir books the airport cab', proof: [], person_ids: ['p_kabir'] }).result.line_id;
    const u = (extra: Record<string, unknown>) => ({ request_id: 'rq_u', trip_id: 't_goa', line_id: lineId, ...extra }) as never;
    expect(updateRecordLine(s, u({ text: 'Kabir books the cab for 9 pm' })).events[0]).toMatchObject({ data: { change: 'updated', line: { text: 'Kabir books the cab for 9 pm' } } });
    expect(err(() => updateRecordLine(s, u({}))).code).toBe(422);
    expect(err(() => updateRecordLine(s, u({ kind: 'agreed' }))).code).toBe(422);
    expect(updateRecordLine(s, u({ kind: 'agreed', proof: [{ message_id: priya.message_id }] })).events[0]).toMatchObject({ data: { line: { kind: 'agreed' } } });
    expect(updateRecordLine(s, u({ status: 'done' })).events[0]).toMatchObject({ data: { change: 'done', by: { kind: 'go' }, line: { status: 'done' } } });
    expect(err(() => updateRecordLine(s, u({ line_id: 'r_nope', text: 'x' }))).code).toBe(404);
    s.trip.record.push({
      line_id: 'r_dates', kind: 'decided', text: '6 to 9 Nov', status: 'active', proof: [], person_ids: [], source: 'vote',
      created_at: '2026-10-05T03:45:00Z', updated_at: '2026-10-05T03:45:00Z',
    });
    expect(err(() => updateRecordLine(s, u({ line_id: 'r_dates', text: 'x' }))).code).toBe(409);
    s.trip.record.find((l) => l.line_id === lineId)!.status = 'undone';
    expect(err(() => updateRecordLine(s, u({ text: 'again' }))).code).toBe(409);
  });
});
```

```ts
// packages/sim/src/__tests__/money.test.ts
import { describe, expect, it } from 'vitest';
import { verifySpendApproval, type Event } from '@go/contract';
import { GOA_SNAPSHOT, goaFreshTrip } from '../goa.js';
import { SocketCallError } from '../server-socket.js';
import { TEST_SPEND_PRIVATE_KEY_PEM, TEST_SPEND_PUBLIC_KEY_PEM } from '../test-spend-key.js';
import { confirmMandate, declineMandate, openVote, setMandate, vote } from '../state/decisions.js';
import { addBooking, addExpense, cancelSpendApproval, recomputeMoney, requestSpendApproval, spendCheck, updateBooking } from '../state/money.js';
import { TripState } from '../state/trip-state.js';

const everyone = ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir'];
const start = Date.parse('2026-10-05T08:45:00Z');

function setUp() {
  let t = start;
  let n = 0;
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const s = new TripState(goaFreshTrip(), { mint: (p) => `${p}${String(++n).padStart(4, '0')}`, now: clock.now });
  s.created();
  return { s, clock };
}

function closedVote(s: TripState, winnerIndex = 0): string {
  const id = openVote(s, {
    request_id: `rq_open_${s.trip.seq}`, trip_id: 't_goa', question: 'Where do we stay?', kind: 'choice', anonymous: false,
    options: [{ label: 'Villa Sol', price_minor: 5420000, currency: 'INR' }, { label: 'Casa Azul', price_minor: 6180000, currency: 'INR' }],
  }).result.decision_id;
  for (const p of everyone) vote(s, id, p, winnerIndex);
  return id;
}

function mandate(s: TripState, decision_id: string): void {
  setMandate(s, { request_id: 'rq_m', trip_id: 't_goa', decision_id, choice_index: 0, cap_minor: 5500000, currency: 'INR', refundable_only: true, payer_person_id: 'p_rahul' });
}

/** A closed vote with a mandate the payer said yes to. */
function readyToPay() {
  const { s, clock } = setUp();
  const id = closedVote(s);
  mandate(s, id);
  clock.advance(60_000);
  confirmMandate(s, id);
  return { s, clock, id };
}

const ask = (decision_id: string, extra: Record<string, unknown> = {}) => ({
  request_id: 'rq_s', trip_id: 't_goa', decision_id, amount_minor: 5420000, currency: 'INR', merchant: 'ixigo: Villa Sol, Anjuna',
  purpose: 'Villa Sol, 3 nights, 6 to 9 Nov', refundable_until: '2026-11-01T18:29:59Z', ...extra,
}) as never;

const booking = (decision_id: string, approval_id: string | undefined, extra: Record<string, unknown> = {}) => ({
  request_id: 'rq_b', trip_id: 't_goa', kind: 'stay', title: 'Villa Sol, 3 nights', vendor: 'ixigo', ref: 'IXG-7Q2K9', amount_minor: 5420000,
  currency: 'INR', payer_person_id: 'p_rahul', for_person_ids: everyone, refundable_until: '2026-11-01T18:29:59Z', decision_id,
  ...(approval_id ? { approval_id } : {}), ...extra,
}) as never;

function approve(s: TripState, id: string): string {
  const r = requestSpendApproval(s, ask(id), TEST_SPEND_PRIVATE_KEY_PEM).result;
  if (r.status !== 'approved') throw new Error(`denied: ${r.reason}`);
  return r.approval_id;
}

function err(fn: () => unknown): SocketCallError {
  try {
    fn();
  } catch (e) {
    if (e instanceof SocketCallError) return e;
    throw e;
  }
  throw new Error('it did not throw');
}

const types = (events: Event[]) => events.map((e) => e.type);

describe('the spend check', () => {
  it("denies in the guide's order, the first rule that fails", () => {
    const { s, clock } = setUp();
    expect(spendCheck(s, ask('d_nope'))).toBe('decision_not_found');
    const id = openVote(s, { request_id: 'rq_o', trip_id: 't_goa', question: 'Where?', kind: 'choice', anonymous: false, options: [{ label: 'A' }, { label: 'B' }] }).result.decision_id;
    expect(spendCheck(s, ask(id))).toBe('decision_not_closed');
    for (const p of everyone) vote(s, id, p, 0);
    expect(spendCheck(s, ask(id))).toBe('no_mandate');
    mandate(s, id);
    expect(spendCheck(s, ask(id))).toBe('payer_has_not_confirmed');
    clock.advance(1000);
    declineMandate(s, id);
    expect(spendCheck(s, ask(id))).toBe('payer_declined');
    clock.advance(1000);
    confirmMandate(s, id);
    expect(spendCheck(s, ask(id, { currency: 'USD' }))).toBe('currency_mismatch');
    expect(spendCheck(s, ask(id, { amount_minor: 5640000 }))).toBe('over_cap');
    expect(spendCheck(s, ask(id, { refundable_until: null }))).toBe('not_refundable');
    expect(spendCheck(s, ask(id, { refundable_until: '2026-10-01T00:00:00Z' }))).toBe('not_refundable');
    expect(spendCheck(s, ask(id))).toBeNull();
    approve(s, id);
    expect(spendCheck(s, ask(id))).toBe('approval_outstanding');
  });

  it("approves with a token signed by the test key, for the mandate's payer, for at most 10 minutes", () => {
    const { s, clock, id } = readyToPay();
    const done = s.once('rq_s1', () => requestSpendApproval(s, ask(id), TEST_SPEND_PRIVATE_KEY_PEM));
    const r = done.result;
    expect(r.status).toBe('approved');
    if (r.status !== 'approved') return;
    const check = verifySpendApproval(r.approval, TEST_SPEND_PUBLIC_KEY_PEM, Math.floor(clock.now().getTime() / 1000) + 60);
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.claims).toMatchObject({
        iss: 'server', aud: 'go-vault', jti: r.approval_id, trip_id: 't_goa', decision_id: id, payer_person_id: 'p_rahul', amount_minor: 5420000, currency: 'INR',
      });
    }
    expect(Date.parse(r.expires_at) - clock.now().getTime()).toBe(600_000);
    expect(done.events).toEqual([]);
    const again = s.once('rq_s1', () => requestSpendApproval(s, ask(id), TEST_SPEND_PRIVATE_KEY_PEM));
    expect(again.repeat).toBe(true);
    expect(again.result).toEqual(r);
    const second = s.once('rq_s2', () => requestSpendApproval(s, ask(id), TEST_SPEND_PRIVATE_KEY_PEM)).result;
    expect(second).toMatchObject({ status: 'denied', reason: 'approval_outstanding' });
  });

  it('cancel releases an approval, is safe to repeat, and a cancelled approval cannot book', () => {
    const { s, id } = readyToPay();
    const approvalId = approve(s, id);
    const cancel = (approval_id: string) => cancelSpendApproval(s, { request_id: 'rq_c', trip_id: 't_goa', approval_id, reason: 'payer_declined' });
    expect(cancel(approvalId)).toEqual({ result: { ok: true }, events: [] });
    expect(cancel(approvalId).result).toEqual({ ok: true });
    expect(err(() => cancel('ap_nope')).code).toBe(404);
    expect(spendCheck(s, ask(id))).toBeNull();
    expect(err(() => addBooking(s, booking(id, approvalId))).code).toBe(409);
  });
});

describe('bookings', () => {
  it('records a paid booking, marks the approval used, and turns the decided line into the booked line', () => {
    const { s, id } = readyToPay();
    const approvalId = approve(s, id);
    const decided = s.trip.record.find((l) => l.kind === 'decided' && l.decision_id === id)!;
    const done = s.once('rq_b1', () => addBooking(s, booking(id, approvalId)));
    expect(types(done.events)).toEqual(['booking.changed', 'record.changed']);
    expect(done.result.seq).toBe(done.events[0]!.seq);
    expect(done.events[0]).toMatchObject({ data: { change: 'added', by: { kind: 'go' }, booking: { status: 'confirmed', approval_id: approvalId, decision_id: id } } });
    expect(done.events[1]).toMatchObject({
      data: { change: 'updated', by: { kind: 'system' }, line: { line_id: decided.line_id, kind: 'booked', text: 'Villa Sol, 3 nights', source: 'booking' } },
    });
    expect(s.approvals.get(approvalId)!.used).toBe(true);
    // The same request_id again gets its first answer, even though the approval is now used.
    expect(s.once('rq_b1', () => addBooking(s, booking(id, approvalId))).result).toEqual(done.result);
    expect(err(() => addBooking(s, booking(id, approvalId))).code).toBe(409);
  });

  it('refuses an approval for another vote, more than approved, an unknown approval, and people or votes outside the trip', () => {
    const { s, id } = readyToPay();
    const approvalId = approve(s, id);
    const other = closedVote(s, 1);
    expect(err(() => addBooking(s, booking(other, approvalId))).code).toBe(409);
    expect(err(() => addBooking(s, booking(id, approvalId, { amount_minor: 5420001 }))).code).toBe(409);
    expect(err(() => addBooking(s, booking(id, 'ap_other_trip'))).code).toBe(409);
    expect(err(() => addBooking(s, booking(id, undefined, { payer_person_id: 'p_stranger' }))).code).toBe(422);
    expect(err(() => addBooking(s, booking('d_nope', undefined))).code).toBe(422);
    expect(s.approvals.get(approvalId)!.used).toBe(false);
  });

  it('a booking someone made themselves is recorded without an approval, with a new booked line', () => {
    const { s } = setUp();
    const done = addBooking(s, { request_id: 'rq_cab', trip_id: 't_goa', kind: 'cab', title: 'Airport cab', vendor: 'GoaMiles', ref: 'GM-1', amount_minor: 340000, currency: 'INR', payer_person_id: 'p_kabir', for_person_ids: everyone });
    expect(done.events[1]).toMatchObject({ data: { change: 'added', line: { kind: 'booked', text: 'Airport cab', source: 'booking' } } });
  });

  it('cancels a booking, and nothing changes a cancelled one', () => {
    const { s } = setUp();
    const bookingId = addBooking(s, booking(closedVote(s), undefined)).result.booking_id;
    const u = (extra: Record<string, unknown>) => ({ request_id: 'rq_ub', trip_id: 't_goa', booking_id: bookingId, ...extra }) as never;
    expect(err(() => updateBooking(s, u({}))).code).toBe(422);
    expect(updateBooking(s, u({ ends_at: '2026-11-09T13:00:00+05:30' })).events[0]).toMatchObject({ data: { change: 'updated' } });
    expect(updateBooking(s, u({ status: 'cancelled' })).events[0]).toMatchObject({ data: { change: 'cancelled', booking: { status: 'cancelled' } } });
    expect(err(() => updateBooking(s, u({ ref: 'X' }))).code).toBe(409);
    expect(err(() => updateBooking(s, u({ booking_id: 'b_nope', ref: 'X' }))).code).toBe(404);
  });
});

describe('expenses and the money maths', () => {
  it('records an expense by Go and works out who pays whom', () => {
    const { s } = setUp();
    const cab = { request_id: 'rq_e', trip_id: 't_goa', paid_by_person_id: 'p_kabir', amount_minor: 340000, currency: 'INR', note: 'Airport cab', category: 'getting_around', split_person_ids: everyone } as const;
    const done = addExpense(s, { ...cab, split_person_ids: [...cab.split_person_ids] });
    expect(done.events[0]).toMatchObject({ type: 'expense.changed', data: { change: 'added', by: { kind: 'go' }, expense: { note: 'Airport cab' } } });
    expect(s.trip.money).toMatchObject({ spent_minor: 340000, by_category: [{ category: 'getting_around', amount_minor: 340000 }] });
    expect(s.trip.money.transfers).toEqual(
      ['p_rahul', 'p_priya', 'p_arjun', 'p_meher'].map((from) => ({ from_person_id: from, to_person_id: 'p_kabir', amount_minor: 68000, currency: 'INR' })),
    );
    expect(err(() => addExpense(s, { ...cab, split_person_ids: ['p_stranger'] })).code).toBe(422);
    expect(err(() => addExpense(s, { ...cab, split_person_ids: [...cab.split_person_ids], booking_id: 'b_nope' })).code).toBe(422);
    expect(err(() => addExpense(s, { ...cab, split_person_ids: [...cab.split_person_ids], currency: 'USD' })).code).toBe(422);
  });

  it("reproduces the money in the guide's Goa trip exactly", () => {
    const s = new TripState(GOA_SNAPSHOT, { mint: (p) => `${p}1`, now: () => new Date(start) });
    const expected = structuredClone(GOA_SNAPSHOT.money);
    s.trip.money.spent_minor = 0;
    s.trip.money.by_category = [];
    s.trip.money.transfers = [];
    recomputeMoney(s);
    expect(s.trip.money).toEqual(expected);
  });
});
```

- [ ] **Step 2: Push the tests and see them fail.** Red is certain: the modules do not exist yet. Skip to Step 3.

- [ ] **Step 3: Write the implementation**

```ts
// packages/sim/src/state/records.ts
// Trip record lines Go writes (agreed, open, doing), with the rules in docs/guide/04-gos-requests.md.
// Decided and booked lines come only from votes and bookings; Go never undoes a line.
import type * as C from '@go/contract';
import { fail, type Change, type Params, type RecordLine, type TripState } from './trip-state.js';

type Proof = RecordLine['proof'][number];

function checkProof(s: TripState, proof: readonly Proof[]): void {
  proof.forEach((p, i) => {
    s.messageIn(p.message_id, `proof[${i}].message_id`);
    if (p.person_id != null) s.person(p.person_id, `proof[${i}].person_id`);
  });
}

export function addRecordLine(s: TripState, p: Params<typeof C.AddRecordLine>): Change<{ line_id: string; seq: number }> {
  if (p.kind === 'agreed' && p.proof.length === 0) throw fail('invalid', 'proof: an agreed line needs at least one message');
  checkProof(s, p.proof);
  s.people(p.person_ids, 'person_ids');
  const at = s.now().toISOString();
  const line: RecordLine = {
    line_id: s.mint('r_'),
    kind: p.kind,
    text: p.text,
    status: 'active',
    proof: p.proof,
    person_ids: p.person_ids,
    ...(p.due_at != null ? { due_at: p.due_at } : {}),
    source: 'go',
    created_at: at,
    updated_at: at,
  };
  s.trip.record.push(line);
  const ev = s.bump('record.changed', { line: structuredClone(line), change: 'added', by: { kind: 'go' } });
  return { result: { line_id: line.line_id, seq: ev.seq }, events: [ev] };
}

export function updateRecordLine(s: TripState, p: Params<typeof C.UpdateRecordLine>): Change<{ seq: number }> {
  const line = s.trip.record.find((l) => l.line_id === p.line_id);
  if (!line) throw fail('not_found', `line ${p.line_id} is not in this trip`);
  if (line.source !== 'go') throw fail('conflict', `line ${p.line_id} is not Go's to change`);
  if (line.status === 'undone') throw fail('conflict', `line ${p.line_id} was undone: add a new line instead`);
  if (p.kind == null && p.text == null && p.status == null && p.proof == null && p.person_ids == null && p.due_at == null) {
    throw fail('invalid', 'send at least one field to change besides request_id, trip_id and line_id');
  }
  if (p.proof != null) checkProof(s, p.proof);
  if (p.person_ids != null) s.people(p.person_ids, 'person_ids');
  const kind = p.kind ?? line.kind;
  const proof = p.proof ?? line.proof;
  if (kind === 'agreed' && proof.length === 0) throw fail('invalid', 'proof: an agreed line needs at least one message');
  if (p.kind != null) line.kind = p.kind;
  if (p.text != null) line.text = p.text;
  if (p.status != null) line.status = p.status;
  if (p.proof != null) line.proof = p.proof;
  if (p.person_ids != null) line.person_ids = p.person_ids;
  if (p.due_at != null) line.due_at = p.due_at;
  line.updated_at = s.now().toISOString();
  const ev = s.bump('record.changed', { line: structuredClone(line), change: p.status === 'done' ? 'done' : 'updated', by: { kind: 'go' } });
  return { result: { seq: ev.seq }, events: [ev] };
}
```

```ts
// packages/sim/src/state/money.ts
// Bookings, expenses, the money maths and spend approvals, with the Server's rules from
// docs/guide/04-gos-requests.md and docs/guide/08-money-and-the-vault.md. Approvals are signed with the key the
// FakeServer is given: the contract's TEST key by default. Dev and tests only; the real Server uses its own key.
import { MAX_APPROVAL_TTL_SECONDS, signSpendApproval } from '@go/contract';
import type * as C from '@go/contract';
import type { z } from 'zod';
import { fail, type Booking, type Change, type Expense, type Params, type RecordLine, type TripState } from './trip-state.js';

type SpendResult = z.infer<typeof C.SpendApprovalResult>;
type DenialReason = z.infer<typeof C.SpendDenialReason>;

const DETAIL: Record<DenialReason, string> = {
  decision_not_found: 'the vote is not in this trip',
  decision_not_closed: 'the vote is still open, or it was called off',
  no_mandate: 'the vote has no mandate',
  payer_declined: 'the payer tapped Not now',
  payer_has_not_confirmed: 'the payer has not tapped Yes, book it',
  currency_mismatch: "the currency is not the mandate's currency",
  over_cap: "the amount is above the mandate's cap",
  not_refundable: 'the mandate is refundable only, and refundable_until is missing or past',
  approval_outstanding: 'another approval for this vote is still waiting',
};

/** Copies the fields that are set, so a missing field stays missing (never undefined). */
function present<T extends object, K extends keyof T>(o: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const k of keys) if (o[k] != null) out[k] = o[k];
  return out;
}

export function addBooking(s: TripState, p: Params<typeof C.AddBooking>): Change<{ booking_id: string; seq: number }> {
  s.person(p.payer_person_id, 'payer_person_id');
  s.people(p.for_person_ids, 'for_person_ids');
  if (p.decision_id != null && !s.decision(p.decision_id)) throw fail('invalid', `decision_id: ${p.decision_id} is not a vote in this trip`);
  s.currency(p.currency, 'currency');
  const approval = p.approval_id != null ? s.approvals.get(p.approval_id) : undefined;
  if (p.approval_id != null) {
    if (!approval) throw fail('conflict', `approval ${p.approval_id} is not for this trip`);
    if (approval.decision_id !== p.decision_id) throw fail('conflict', `approval ${p.approval_id} is for another vote`);
    if (approval.used || approval.cancelled) throw fail('conflict', `approval ${p.approval_id} is already used or cancelled`);
    if (p.amount_minor > approval.amount_minor || p.currency !== approval.currency) {
      throw fail('conflict', `the booking is more than approval ${p.approval_id} allows`);
    }
  }
  // An expired approval is not refused: the vault checked the expiry before it paid.
  if (approval) approval.used = true;
  const at = s.now().toISOString();
  const booking: Booking = {
    booking_id: s.mint('b_'),
    kind: p.kind,
    status: 'confirmed',
    title: p.title,
    vendor: p.vendor,
    ref: p.ref,
    amount_minor: p.amount_minor,
    currency: p.currency,
    payer_person_id: p.payer_person_id,
    for_person_ids: p.for_person_ids,
    ...present(p, ['refundable_until', 'starts_at', 'ends_at', 'journey', 'place', 'image_url', 'decision_id', 'approval_id']),
    created_at: at,
  };
  s.trip.bookings.push(booking);
  const events = [s.bump('booking.changed', { booking: structuredClone(booking), change: 'added', by: { kind: 'go' } })];
  // The booked line: the vote's decided line becomes it (same line_id), or a new line is added. A second change, by system.
  const decided = p.decision_id != null
    ? s.trip.record.find((l) => l.kind === 'decided' && l.decision_id === p.decision_id && l.status !== 'undone')
    : undefined;
  if (decided) {
    decided.kind = 'booked';
    decided.text = booking.title;
    decided.booking_id = booking.booking_id;
    decided.source = 'booking';
    decided.updated_at = at;
    events.push(s.bump('record.changed', { line: structuredClone(decided), change: 'updated', by: { kind: 'system' } }));
  } else {
    const line: RecordLine = {
      line_id: s.mint('r_'),
      kind: 'booked',
      text: booking.title,
      status: 'active',
      proof: [],
      person_ids: [],
      ...(p.decision_id != null ? { decision_id: p.decision_id } : {}),
      booking_id: booking.booking_id,
      source: 'booking',
      created_at: at,
      updated_at: at,
    };
    s.trip.record.push(line);
    events.push(s.bump('record.changed', { line: structuredClone(line), change: 'added', by: { kind: 'system' } }));
  }
  return { result: { booking_id: booking.booking_id, seq: events[0]!.seq }, events };
}

export function updateBooking(s: TripState, p: Params<typeof C.UpdateBooking>): Change<{ seq: number }> {
  const b = s.booking(p.booking_id);
  if (!b) throw fail('not_found', `booking ${p.booking_id} is not in this trip`);
  if (b.status === 'cancelled') throw fail('conflict', `booking ${p.booking_id} is cancelled`);
  if (p.status == null && p.ref == null && p.refundable_until == null && p.starts_at == null && p.ends_at == null) {
    throw fail('invalid', 'send at least one field to change besides request_id, trip_id and booking_id');
  }
  if (p.status != null) b.status = p.status;
  if (p.ref != null) b.ref = p.ref;
  if (p.refundable_until != null) b.refundable_until = p.refundable_until;
  if (p.starts_at != null) b.starts_at = p.starts_at;
  if (p.ends_at != null) b.ends_at = p.ends_at;
  const ev = s.bump('booking.changed', { booking: structuredClone(b), change: p.status === 'cancelled' ? 'cancelled' : 'updated', by: { kind: 'go' } });
  return { result: { seq: ev.seq }, events: [ev] };
}

export function addExpense(s: TripState, p: Params<typeof C.AddExpense>): Change<{ expense_id: string; seq: number }> {
  s.person(p.paid_by_person_id, 'paid_by_person_id');
  s.people(p.split_person_ids, 'split_person_ids');
  if (p.booking_id != null && !s.booking(p.booking_id)) throw fail('invalid', `booking_id: ${p.booking_id} is not a booking in this trip`);
  s.currency(p.currency, 'currency');
  const expense: Expense = {
    expense_id: s.mint('e_'),
    paid_by_person_id: p.paid_by_person_id,
    amount_minor: p.amount_minor,
    currency: p.currency,
    note: p.note,
    category: p.category,
    split_person_ids: p.split_person_ids,
    ...(p.booking_id != null ? { booking_id: p.booking_id } : {}),
    created_at: s.now().toISOString(),
  };
  s.trip.expenses.push(expense);
  recomputeMoney(s);
  const ev = s.bump('expense.changed', { expense: structuredClone(expense), change: 'added', by: { kind: 'go' } });
  return { result: { expense_id: expense.expense_id, seq: ev.seq }, events: [ev] };
}

/** The Server's money maths: what was spent, by category, and the fewest transfers that square everyone up. */
export function recomputeMoney(s: TripState): void {
  const m = s.trip.money;
  const expenses = s.trip.expenses;
  m.spent_minor = expenses.reduce((sum, e) => sum + e.amount_minor, 0);
  const byCategory = new Map<Expense['category'], number>();
  for (const e of expenses) byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + e.amount_minor);
  m.by_category = [...byCategory].map(([category, amount_minor]) => ({ category, amount_minor }));
  // Each expense is split equally; the payer keeps any paise that do not split evenly.
  const balance = new Map<string, number>();
  const add = (id: string, amount: number): void => {
    balance.set(id, (balance.get(id) ?? 0) + amount);
  };
  for (const e of expenses) {
    const share = Math.floor(e.amount_minor / e.split_person_ids.length);
    for (const id of e.split_person_ids) add(id, -share);
    add(e.paid_by_person_id, share * e.split_person_ids.length);
  }
  const owes = [...balance].filter(([, v]) => v < 0).map(([id, v]) => ({ id, left: -v })).sort((a, b) => b.left - a.left);
  const owed = [...balance].filter(([, v]) => v > 0).map(([id, v]) => ({ id, left: v })).sort((a, b) => b.left - a.left);
  const transfers: typeof m.transfers = [];
  for (const debtor of owes) {
    for (const creditor of owed) {
      if (debtor.left === 0) break;
      if (creditor.left === 0) continue;
      const amount = Math.min(debtor.left, creditor.left);
      transfers.push({ from_person_id: debtor.id, to_person_id: creditor.id, amount_minor: amount, currency: m.currency });
      debtor.left -= amount;
      creditor.left -= amount;
    }
  }
  m.transfers = transfers.slice(0, 60);
}

/** The spend check in the guide's order (docs/guide/08-money-and-the-vault.md): the first rule that fails gives the reason. */
export function spendCheck(s: TripState, p: Params<typeof C.RequestSpendApproval>): DenialReason | null {
  const d = s.decision(p.decision_id);
  if (!d) return 'decision_not_found';
  if (d.status !== 'closed') return 'decision_not_closed';
  const m = d.mandate;
  if (d.kind !== 'choice' || !m) return 'no_mandate';
  if (m.declined_at != null && (m.confirmed_at == null || Date.parse(m.declined_at) > Date.parse(m.confirmed_at))) return 'payer_declined';
  if (m.confirmed_at == null) return 'payer_has_not_confirmed';
  if (p.currency !== m.currency) return 'currency_mismatch';
  if (p.amount_minor > m.cap_minor) return 'over_cap';
  const now = s.now().getTime();
  if (m.refundable_only && !(p.refundable_until != null && Date.parse(p.refundable_until) > now)) return 'not_refundable';
  for (const a of s.approvals.values()) {
    if (a.decision_id === d.decision_id && !a.used && !a.cancelled && a.expires_at.getTime() > now) return 'approval_outstanding';
  }
  return null;
}

export function requestSpendApproval(s: TripState, p: Params<typeof C.RequestSpendApproval>, privateKeyPem: string): Change<SpendResult> {
  const reason = spendCheck(s, p);
  if (reason) return { result: { status: 'denied', reason, detail: DETAIL[reason] }, events: [] };
  const d = s.decision(p.decision_id)!;
  const m = d.mandate!;
  const iat = Math.floor(s.now().getTime() / 1000);
  const exp = iat + MAX_APPROVAL_TTL_SECONDS;
  const approvalId = s.mint('ap_sim_');
  const approval = signSpendApproval(
    {
      iss: 'server',
      aud: 'go-vault',
      jti: approvalId,
      trip_id: s.id,
      decision_id: d.decision_id,
      payer_person_id: m.payer_person_id, // always the mandate's payer, never anything from the request
      amount_minor: p.amount_minor,
      currency: p.currency,
      merchant: p.merchant,
      purpose: p.purpose,
      ...(p.refundable_until != null ? { refundable_until: p.refundable_until } : {}),
      iat,
      exp,
    },
    privateKeyPem,
  );
  const expiresAt = new Date(exp * 1000);
  s.approvals.set(approvalId, {
    approval_id: approvalId,
    decision_id: d.decision_id,
    payer_person_id: m.payer_person_id,
    amount_minor: p.amount_minor,
    currency: p.currency,
    expires_at: expiresAt,
    used: false,
    cancelled: false,
  });
  return { result: { status: 'approved', approval_id: approvalId, approval, expires_at: expiresAt.toISOString() }, events: [] };
}

/** Releases an approval. Already used, cancelled or expired: still { ok: true }, and nothing changes. */
export function cancelSpendApproval(s: TripState, p: Params<typeof C.CancelSpendApproval>): Change<{ ok: true }> {
  const a = s.approvals.get(p.approval_id);
  if (!a) throw fail('not_found', `approval ${p.approval_id} is not in this trip`);
  if (!a.used && !a.cancelled && a.expires_at.getTime() > s.now().getTime()) a.cancelled = true;
  return { result: { ok: true }, events: [] };
}
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add packages/sim/src/state/records.ts packages/sim/src/state/money.ts packages/sim/src/__tests__/records.test.ts packages/sim/src/__tests__/money.test.ts
git commit -m "feat(sim): record lines, bookings, expenses, the money maths and spend approvals with the Server's rules

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `records.test.ts` (3 tests) and `money.test.ts` (9 tests) pass, including the Goa money reproduced exactly.

---
### Task 9: The FakeServer (`fake-server.ts`)

The simulated Server that P1's end-to-end tests and the dev room drive. It dials Go with `GoSocket` (signed, `?instance=sim`), keeps trips in `TripState`s, answers all 18 of Go's methods, and sends each trip's events one at a time in change-number order, waiting for Go's answer before the next one and sending an unanswered event again with the same `event_id` (a short retry: after 200 ms, 1 s and 5 s by default, never for `422`). A write's events go out after its answer, as a real outbox does after its commit. Every Go write is recorded with its `request_id`: `countWrites(id)` counts every arrival, and `applied` marks the one that changed the trip (master §10 line 1).

Test helpers play the people: `createTrip`, `say`, `react`, `edit`, `delete`, `tap`, `vote`, `closeVoteByTime`, `confirmMandate`, `declineMandate`, `askGo` (any of the Server's requests), `waitFor`. `createTrip` always sends `trip.created` as change 1, even for the mid-planning `GOA_SNAPSHOT` (whose snapshot says 113): the sim starts its count there. `reconnect` plays the Server dropping its socket and dialling again (P1 Task 18, master §10 line 1): a new socket signed fresh, every trip, write and event kept, and a request still waiting sent again on the new socket (an event keeps its `event_id`). `requests` holds every request and typing notification Go sent, with its arrival time, so tests can time "Go is typing".

**Files:**
- Create: `packages/sim/src/fake-server.ts`
- Create: `packages/sim/src/__tests__/helpers/test-go.ts`
- Modify: `packages/sim/src/index.ts` (export the FakeServer and the trip state)
- Test: `packages/sim/src/__tests__/fake-server.test.ts`

**Interfaces:**
- Consumes: Task 1 `GoSocket`, `SocketCallError`, `SocketTimeoutError`, `Handler`; Task 2 `TEST_SPEND_PRIVATE_KEY_PEM`; Tasks 6 to 8: `TripState`, `fail`, `Change`, `NeedsItem`, `SayOptions`, `openVote`, `closeVote`, `setMandate`, `vote`, `closeVoteByTime`, `confirmMandate`, `declineMandate`, `addRecordLine`, `updateRecordLine`, `addBooking`, `updateBooking`, `addExpense`, `requestSpendApproval`, `cancelSpendApproval`. `@go/contract`: `CardActionResult`, `EventAccepted`, `SOCKET_PATH`, types `Event`, `Message`, `TripSnapshot`.
- Produces (P1's end-to-end tests and P3's bench use these names):
  - `function socketUrl(goUrl: string, instance: string): string`
  - `interface FakeServerOptions { goUrl; secret; instance?; now?; spendPrivateKeyPem?; eventTimeoutMs?; eventRetryMs?; maxPageBytes?; backoffSeconds?; log? }`
  - `interface WriteRecord { method; request_id; trip_id; params; applied: boolean; error?: { code: number; message: string }; at }`, `interface GoRequest { method; params; at }`, `interface SentEvent { event: Event; answer?; error? }`, `type TapResult`
  - `class FakeServer { readonly writes: WriteRecord[]; readonly requests: GoRequest[]; readonly events: SentEvent[]; start(timeoutMs?: number): Promise<void>; stop(): void; isOpen(): boolean; reconnect(o?: { downMs?: number; timeoutMs?: number }): Promise<void>; createTrip(snapshot: TripSnapshot): Promise<SentEvent>; say(personId: string, text: string, opts?: SayOptions & { tripId?: string }): Promise<Message>; react(personId, messageId, emoji): Promise<void>; edit(personId, messageId, text): Promise<Message>; delete(personId, messageId): Promise<void>; tap(cardId, actionId, personId, optionId?): Promise<TapResult>; vote(decisionId, personId, optionIndex): Promise<void>; closeVoteByTime(decisionId): Promise<void>; confirmMandate(decisionId): Promise<void>; declineMandate(decisionId): Promise<void>; askGo(method: string, params: object, timeoutMs?: number): Promise<Record<string, unknown>>; waitFor<T>(check: () => T | null | undefined | false, timeoutMs?: number): Promise<T>; countWrites(requestId: string): number; tripIds(): string[]; trip(tripId?): TripSnapshot; messages(tripId?): Message[]; typingOn(tripId?): boolean; needsYou(personId, tripId?): NeedsItem[]; onChange(fn: () => void): () => void }`
  - `startTestGo(secret)` (tests only): a tiny Go that checks the signature, answers `send_event` and `card_tap`, records frames, and lets a test send Go's requests.

- [ ] **Step 1: Write the failing test**

```ts
// packages/sim/src/__tests__/helpers/test-go.ts
// A tiny Go for the sim's tests. It checks the signature on the upgrade, answers send_event (duplicates by
// event_id) and card_tap, records every frame the sim sends, and lets a test send Go's requests.
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

export async function startTestGo(secret: string): Promise<TestGo> {
  const seen = new Set<string>();
  const waiting = new Map<string, (frame: any) => void>();
  let sock: WebSocket | undefined;
  let n = 0;
  const wss = new WebSocketServer({
    port: 0,
    verifyClient: ({ req }, done) => {
      const header = req.headers['x-go-signature'];
      const ok = verifyRequest({ method: 'GET', target: req.url ?? '', body: '' }, typeof header === 'string' ? header : undefined, secret).ok;
      if (!ok) go.refused += 1;
      done(ok, 401);
    },
  });
  const go: TestGo = {
    url: '',
    frames: [],
    events: [],
    taps: [],
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
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: f.id, result: { result: 'done', toast: 'Noted.' } }));
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
```

```ts
// packages/sim/src/__tests__/fake-server.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { Card, TripSnapshot, verifyRequest, verifySpendApproval } from '@go/contract';
import { FakeServer, socketUrl, type FakeServerOptions } from '../fake-server.js';
import { goaFreshTrip } from '../goa.js';
import { TEST_SPEND_PUBLIC_KEY_PEM } from '../test-spend-key.js';
import { startTestGo, type TestGo } from './helpers/test-go.js';

const secret = 'sim-test-secret-0123456789abcdef';
const everyone = ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir'];
let go: TestGo | undefined;
let fake: FakeServer | undefined;
afterEach(async () => {
  fake?.stop();
  fake = undefined;
  await go?.close();
  go = undefined;
});

async function setUp(extra: Partial<FakeServerOptions> = {}) {
  go = await startTestGo(secret);
  fake = new FakeServer({ goUrl: go.url, secret, ...extra });
  await fake.start(3000);
  await fake.createTrip(goaFreshTrip());
  return { go, fake };
}

const villaVote = { trip_id: 't_goa', question: 'Where do we stay?', kind: 'choice', anonymous: false, options: [{ label: 'Villa Sol' }, { label: 'Casa Azul' }] };

describe('connecting and the trip', () => {
  it('dials Go with a signed upgrade for its instance, and sends trip.created as change 1', async () => {
    const { go: g } = await setUp();
    expect(g.targets[0]).toBe('/v1/socket?instance=sim');
    expect(verifyRequest({ method: 'GET', target: g.targets[0]!, body: '' }, g.signatures[0], secret).ok).toBe(true);
    expect(g.events[0]).toMatchObject({ type: 'trip.created', seq: 1, trip_id: 't_goa' });
    expect(TripSnapshot.safeParse(g.events[0].data.trip).success).toBe(true);
    expect(socketUrl('https://go.example', 'server-1')).toBe('wss://go.example/v1/socket?instance=server-1');
    expect(socketUrl('ws://localhost:8080/v1/socket', 'sim')).toBe('ws://localhost:8080/v1/socket?instance=sim');
  });

  it('says things as people, with the next change number, and tells listeners', async () => {
    const { go: g, fake: f } = await setUp();
    let changes = 0;
    f.onChange(() => (changes += 1));
    const msg = await f.say('p_priya', '@Go flights on Friday?');
    expect(msg.mentions_go).toBe(true);
    expect(g.events[1]).toMatchObject({ type: 'message.created', seq: 2, data: { message: { message_id: msg.message_id, mentions_go: true } } });
    expect(changes).toBeGreaterThan(0);
  });

  it('reacts, edits and deletes as people', async () => {
    const { go: g, fake: f } = await setUp();
    const m = await f.say('p_arjun', 'I land at 9');
    await f.react('p_meher', m.message_id, '👍');
    await f.edit('p_arjun', m.message_id, 'I land at 11');
    await f.delete('p_arjun', m.message_id);
    expect(g.events.slice(-3).map((e) => e.type)).toEqual(['reaction.added', 'message.edited', 'message.deleted']);
  });

  it('reconnects on a new socket signed fresh, keeps the trip and the write log, and sends a waiting event again with its event_id', async () => {
    const { go: g, fake: f } = await setUp();
    await g.call('post_message', { request_id: 'rq_before', trip_id: 't_goa', text: 'Before the drop' });
    await f.waitFor(() => f.events.length === 2 && f.events.every((e) => e.answer !== undefined));
    g.mode = 'silent-once';
    const said = f.say('p_rahul', 'are you still there?');
    await f.waitFor(() => g.events.length === 3);
    // Away for 1.1 s: a new second, so the new upgrade signature differs from the old one.
    await f.reconnect({ downMs: 1_100 });
    expect(f.isOpen()).toBe(true);
    expect(g.signatures).toHaveLength(2);
    expect(g.signatures[1]).not.toBe(g.signatures[0]);
    expect(g.targets[1]).toBe('/v1/socket?instance=sim');
    const msg = await said;
    expect(g.events.filter((e) => e.event_id === g.events[2].event_id)).toHaveLength(2);
    expect(f.events.at(-1)).toMatchObject({ event: { seq: msg.seq }, answer: { accepted: true, duplicate: false } });
    // The same write again on the new socket: answered, counted, not applied twice.
    await g.call('post_message', { request_id: 'rq_before', trip_id: 't_goa', text: 'Before the drop' });
    expect(f.countWrites('rq_before')).toBe(2);
    expect(f.writes.filter((w) => w.request_id === 'rq_before' && w.applied)).toHaveLength(1);
    expect(f.trip().seq).toBe(3);
  });
});

describe("answering Go's requests", () => {
  it('answers reads from the trip, 404 for a trip it does not have, and -32601 for a method it does not know', async () => {
    const { go: g, fake: f } = await setUp();
    await f.say('p_rahul', 'hi');
    expect(TripSnapshot.parse((await g.call('read_trip', { trip_id: 't_goa' })).result).seq).toBe(2);
    expect((await g.call('read_messages', { trip_id: 't_goa', after_seq: 0 })).result.messages).toHaveLength(1);
    expect((await g.call('read_trip', { trip_id: 't_nope' })).error).toMatchObject({ code: 404, data: { code: 'not_found' } });
    expect((await g.call('read_trip', {})).error).toMatchObject({ code: 422, data: { code: 'invalid' } });
    expect((await g.call('add_sticker', { trip_id: 't_goa' })).error).toEqual({ code: -32601, message: 'unknown method add_sticker' });
  });

  it('does each write once per request_id: both arrivals are counted, one is applied, one event goes out', async () => {
    const { go: g, fake: f } = await setUp();
    const params = { request_id: 'rq_hello', trip_id: 't_goa', text: 'Hi all, I am Go.' };
    const first = await g.call('post_message', params);
    const second = await g.call('post_message', params);
    expect(second.result).toEqual(first.result);
    expect(f.countWrites('rq_hello')).toBe(2);
    expect(f.writes.filter((w) => w.request_id === 'rq_hello').map((w) => w.applied)).toEqual([true, false]);
    const fromGo = () => g.events.filter((e) => e.type === 'message.created' && e.data.message.author.kind === 'go');
    await f.waitFor(() => fromGo().length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(fromGo()).toHaveLength(1);
    expect(f.messages().filter((m) => m.author.kind === 'go')).toHaveLength(1);
  });

  it("answers a write before it sends the write's event", async () => {
    const { go: g, fake: f } = await setUp();
    const answer = await g.call('post_message', { request_id: 'rq_order', trip_id: 't_goa', text: 'Order check' });
    await f.waitFor(() => g.events.some((e) => e.seq === answer.result.seq));
    const answerAt = g.frames.findIndex((x) => x.id === answer.id && 'result' in x);
    const eventAt = g.frames.findIndex((x) => x.method === 'send_event' && x.params.seq === answer.result.seq);
    expect(answerAt).toBeGreaterThanOrEqual(0);
    expect(answerAt).toBeLessThan(eventAt);
  });

  it('answers refused writes with the contract error, records them, and changes nothing', async () => {
    const { go: g, fake: f } = await setUp();
    const seq = f.trip().seq;
    expect((await g.call('post_message', { request_id: 'rq_x', trip_id: 't_goa', text: 'hi', mentions: ['p_nobody'] })).error)
      .toMatchObject({ code: 422, data: { code: 'invalid' } });
    expect((await g.call('add_reaction', { request_id: 'rq_y', trip_id: 't_goa', message_id: 'm_nope', emoji: '✅' })).error).toMatchObject({ code: 404 });
    const card = { card_id: 'c_once', kind: 'notice', fallback_text: 'Note', tone: 'info', title: 'Title', body: 'Body' };
    await g.call('post_message', { request_id: 'rq_c1', trip_id: 't_goa', card });
    expect((await g.call('post_message', { request_id: 'rq_c2', trip_id: 't_goa', card })).error).toMatchObject({ code: 409, data: { code: 'conflict' } });
    expect(f.writes.find((w) => w.request_id === 'rq_x')).toMatchObject({ applied: false, error: { code: 422 } });
    expect(f.trip().seq).toBe(seq + 1);
  });

  it('close_vote sends decision.closed and then record.changed, and answers the first change number', async () => {
    const { go: g, fake: f } = await setUp();
    const opened = (await g.call('open_vote', { request_id: 'rq_o', ...villaVote })).result;
    await f.vote(opened.decision_id, 'p_rahul', 0);
    const closed = (await g.call('close_vote', { request_id: 'rq_close', trip_id: 't_goa', decision_id: opened.decision_id })).result;
    await f.waitFor(() => g.events.some((e) => e.type === 'record.changed'));
    expect(g.events.slice(-2).map((e) => [e.type, e.seq])).toEqual([['decision.closed', closed.seq], ['record.changed', closed.seq + 1]]);
  });

  it("runs the pay path: the mandate, the payer's yes, an approval signed with the test key, the booking", async () => {
    const { go: g, fake: f } = await setUp();
    const opened = (await g.call('open_vote', { request_id: 'rq_o', ...villaVote })).result;
    for (const p of everyone) await f.vote(opened.decision_id, p, 0);
    expect(f.trip().decisions[0]!.status).toBe('closed');
    await g.call('set_mandate', {
      request_id: 'rq_m', trip_id: 't_goa', decision_id: opened.decision_id, choice_index: 0, cap_minor: 5500000, currency: 'INR', refundable_only: false, payer_person_id: 'p_rahul',
    });
    expect(f.needsYou('p_rahul')).toEqual([expect.objectContaining({ kind: 'mandate' })]);
    await f.confirmMandate(opened.decision_id);
    const approved = (await g.call('request_spend_approval', {
      request_id: 'rq_s', trip_id: 't_goa', decision_id: opened.decision_id, amount_minor: 5420000, currency: 'INR', merchant: 'ixigo: Villa Sol, Anjuna', purpose: 'Villa Sol, 3 nights',
    })).result;
    expect(approved.status).toBe('approved');
    expect(verifySpendApproval(approved.approval, TEST_SPEND_PUBLIC_KEY_PEM).ok).toBe(true);
    const booked = (await g.call('add_booking', {
      request_id: 'rq_b', trip_id: 't_goa', kind: 'stay', title: 'Villa Sol, 3 nights', vendor: 'ixigo', ref: 'IXG-7Q2K9', amount_minor: 5420000, currency: 'INR',
      payer_person_id: 'p_rahul', for_person_ids: ['p_rahul'], decision_id: opened.decision_id, approval_id: approved.approval_id,
    })).result;
    expect(booked.booking_id).toBeTruthy();
  });

  it("shows Go's typing for 10 seconds, and drops a typing for a trip it does not have", async () => {
    let t = Date.parse('2026-10-05T07:00:00Z');
    const { go: g, fake: f } = await setUp({ now: () => new Date(t) });
    g.notify('typing', { trip_id: 't_goa', on: true });
    await f.waitFor(() => f.typingOn());
    // Every typing notification is in requests with its arrival time, so a test can time "Go is typing".
    expect(f.requests.filter((r) => r.method === 'typing')).toEqual([
      { method: 'typing', params: { trip_id: 't_goa', on: true }, at: '2026-10-05T07:00:00.000Z' },
    ]);
    t += 11_000;
    expect(f.typingOn()).toBe(false);
    g.notify('typing', { trip_id: 't_nope', on: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(g.frames.filter((x) => 'error' in x)).toEqual([]);
  });
});

describe('taps and events', () => {
  it("taps a Go card with a fresh tap_id each time, and returns Go's answer", async () => {
    const { go: g, fake: f } = await setUp();
    const card = {
      card_id: 'c_flights', kind: 'options', fallback_text: 'Flights', title: 'Flights', option_kind: 'flight', checked_at: '2026-10-05T06:49:30Z',
      options: [{ option_id: 'opt_1', title: 'IndiGo', highlights: [] }],
      actions: [{ action_id: 'pick', label: "I'll take this", style: 'primary', per_option: true }],
    };
    expect(Card.safeParse(card).success).toBe(true);
    await g.call('post_message', { request_id: 'rq_card', trip_id: 't_goa', card });
    expect(await f.tap('c_flights', 'pick', 'p_priya', 'opt_1')).toEqual({ result: 'done', toast: 'Noted.' });
    await f.tap('c_flights', 'pick', 'p_kabir', 'opt_1');
    expect(new Set(g.taps.map((x) => x.tap_id)).size).toBe(2);
    expect(g.taps[0]).toMatchObject({ trip_id: 't_goa', card_id: 'c_flights', action_id: 'pick', person_id: 'p_priya', option_id: 'opt_1' });
    await expect(f.askGo('get_person', { person_id: 'p_kabir' })).rejects.toMatchObject({ code: -32601 });
  });

  it("sends a trip's events one at a time, and sends an unanswered one again with the same event_id", async () => {
    const { go: g, fake: f } = await setUp({ eventTimeoutMs: 150, eventRetryMs: [50] });
    g.mode = 'silent-once';
    await Promise.all([f.say('p_rahul', 'one'), f.say('p_priya', 'two')]);
    expect(g.events.slice(1).map((e) => e.seq)).toEqual([2, 2, 3]);
    expect(g.events[1].event_id).toBe(g.events[2].event_id);
    expect(f.events.find((e) => e.event.seq === 2)!.answer).toEqual({ accepted: true, duplicate: false });
  });
});
```

- [ ] **Step 2: Push the test and see it fail.** Red is certain: the module does not exist yet. Skip to Step 3.

- [ ] **Step 3: Write the implementation**

```ts
// packages/sim/src/fake-server.ts
// FakeServer: the simulated Server. It opens the socket to Go like the real Server (GoSocket, signed, with
// ?instance=), keeps trips in memory, answers all 18 of Go's methods with the contract's rules, and sends each
// trip's events to Go one at a time, in change-number order, waiting for each answer. Its helpers play the
// people in the room: say, react, edit, delete, tap, vote, a vote closing on time, and the payer's yes or no.
import { CardActionResult, EventAccepted, SOCKET_PATH, type Event, type Message, type TripSnapshot } from '@go/contract';
import type { z } from 'zod';
import { GoSocket, SocketCallError, SocketTimeoutError, type Handler } from './server-socket.js';
import { closeVote, closeVoteByTime, confirmMandate, declineMandate, openVote, setMandate, vote } from './state/decisions.js';
import { addBooking, addExpense, cancelSpendApproval, requestSpendApproval, updateBooking } from './state/money.js';
import { addRecordLine, updateRecordLine } from './state/records.js';
import { TripState, fail, type Change, type NeedsItem, type SayOptions } from './state/trip-state.js';
import { TEST_SPEND_PRIVATE_KEY_PEM } from './test-spend-key.js';

type Write = (s: TripState, p: any, raw: Record<string, unknown>, spendKey: string) => Change<unknown>;

/** Go's 14 writes. Each carries a request_id and is done once per request_id. */
const WRITES: Record<string, Write> = {
  post_message: (s, p, raw) => s.postMessage(p, raw),
  add_reaction: (s, p) => s.addReaction(p),
  remove_reaction: (s, p) => s.removeReaction(p),
  update_trip: (s, p) => s.updateTrip(p),
  open_vote: (s, p) => openVote(s, p),
  close_vote: (s, p) => closeVote(s, p),
  set_mandate: (s, p) => setMandate(s, p),
  add_record_line: (s, p) => addRecordLine(s, p),
  update_record_line: (s, p) => updateRecordLine(s, p),
  add_booking: (s, p) => addBooking(s, p),
  update_booking: (s, p) => updateBooking(s, p),
  add_expense: (s, p) => addExpense(s, p),
  request_spend_approval: (s, p, _raw, spendKey) => requestSpendApproval(s, p, spendKey),
  cancel_spend_approval: (s, p) => cancelSpendApproval(s, p),
};

export interface FakeServerOptions {
  /** Go's base URL (http(s):// or ws(s)://), with or without /v1/socket. */
  goUrl: string;
  /** GO_SIGNING_SECRET. */
  secret: string;
  /** This Server instance's name in the query string. Default "sim". */
  instance?: string;
  now?: () => Date;
  /** The key spend approvals are signed with. Default: the contract's TEST key (dev and tests only). */
  spendPrivateKeyPem?: string;
  /** How long to wait for Go's answer to an event (default 2000 ms), and the waits before each retry (default 200, 1000, 5000 ms). */
  eventTimeoutMs?: number;
  eventRetryMs?: readonly number[];
  /** The largest read_messages answer, for tests. */
  maxPageBytes?: number;
  /** The socket's reconnect waits, for tests. */
  backoffSeconds?: readonly number[];
  log?: (line: string) => void;
}

/** One of Go's writes as it arrived. `applied` is true for the arrival that changed the trip. */
export interface WriteRecord {
  method: string;
  request_id: string;
  trip_id: string;
  params: Record<string, unknown>;
  applied: boolean;
  error?: { code: number; message: string };
  at: string;
}

/** Every request and notification Go sent, in arrival order. */
export interface GoRequest {
  method: string;
  params: Record<string, unknown>;
  at: string;
}

/** An event the sim sent, with Go's answer or the last error. */
export interface SentEvent {
  event: Event;
  answer?: z.infer<typeof EventAccepted>;
  error?: string;
}

export type TapResult = z.infer<typeof CardActionResult>;

/** Go's socket URL for this instance: ws(s)://host/v1/socket?instance=<name>. */
export function socketUrl(goUrl: string, instance: string): string {
  const u = new URL(goUrl.replace(/^http/, 'ws'));
  if (u.pathname === '/' || u.pathname === '') u.pathname = SOCKET_PATH;
  u.searchParams.set('instance', instance);
  return u.toString();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set([429, 500, 503]);

export class FakeServer {
  readonly writes: WriteRecord[] = [];
  readonly requests: GoRequest[] = [];
  readonly events: SentEvent[] = [];
  private readonly trips = new Map<string, TripState>();
  private readonly order: string[] = [];
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private readonly handlers: Record<string, Handler>;
  private socket: GoSocket;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private n = 0;
  private open = false;
  private stopped = false;

  constructor(private readonly o: FakeServerOptions) {
    this.now = o.now ?? (() => new Date());
    this.log = o.log ?? (() => {});
    this.handlers = {
      read_trip: (p, raw) => this.answer('read_trip', raw, p.trip_id, (s) => s.readTrip()),
      read_messages: (p, raw) => this.answer('read_messages', raw, p.trip_id, (s) => s.readMessages(p)),
      replace_card: (p, raw) => this.answer('replace_card', raw, p.trip_id, (s) => s.replaceCard(p, raw)),
      // A notification: GoSocket never answers it, even when the trip is unknown.
      typing: (p, raw) => this.answer('typing', raw, p.trip_id, (s) => s.typing(p.on)),
    };
    for (const method of Object.keys(WRITES)) this.handlers[method] = (p, raw) => this.write(method, p, raw);
    this.socket = this.newSocket();
  }

  /** A socket to Go, signed fresh on every connect. Only the current socket's open and close change isOpen(). */
  private newSocket(): GoSocket {
    const sock: GoSocket = new GoSocket({
      url: socketUrl(this.o.goUrl, this.o.instance ?? 'sim'),
      secret: this.o.secret,
      handlers: this.handlers,
      ...(this.o.backoffSeconds ? { backoffSeconds: this.o.backoffSeconds } : {}),
      onOpen: () => {
        if (sock !== this.socket) return;
        this.open = true;
        this.log('socket to Go open');
        this.changed();
      },
      onClose: () => {
        if (sock !== this.socket) return;
        this.open = false;
        this.log('socket to Go closed');
        this.changed();
      },
      onError: (err) => this.log(`socket to Go: ${err.message}`),
    });
    return sock;
  }

  /** Opens the socket to Go and resolves once it is open (and, with a time limit, fails after it). */
  async start(timeoutMs?: number): Promise<void> {
    this.socket.start();
    await this.waitFor(() => this.open, timeoutMs ?? Number.POSITIVE_INFINITY);
  }

  stop(): void {
    this.stopped = true;
    this.socket.close();
  }

  isOpen(): boolean {
    return this.open;
  }

  /**
   * The Server drops its socket and dials Go again on a new one, signed fresh. Trips, writes, requests and events are
   * kept; a request still waiting goes again on the new socket (an event keeps its event_id). `downMs` is how long the
   * Server stays away: Go accepts each signature once and a signature names its second, so tests wait at least 1,100 ms.
   */
  async reconnect(o: { downMs?: number; timeoutMs?: number } = {}): Promise<void> {
    if (this.stopped) throw new Error('this FakeServer was stopped');
    const old = this.socket;
    this.socket = this.newSocket();
    this.open = false;
    old.close(); // its waiting requests fail at once; sendOne sends a waiting event again on the new socket
    this.changed();
    if (o.downMs) await sleep(o.downMs);
    this.socket.start();
    await this.waitFor(() => this.open, o.timeoutMs ?? 5000);
  }

  // ── trips and people ──

  /** Adds a trip and sends trip.created (change 1) to Go. Resolves once Go answered it. */
  async createTrip(snapshot: TripSnapshot): Promise<SentEvent> {
    const s = new TripState(snapshot, {
      mint: (prefix) => this.mint(prefix),
      now: this.now,
      ...(this.o.maxPageBytes !== undefined ? { maxPageBytes: this.o.maxPageBytes } : {}),
    });
    if (this.trips.has(s.id)) throw new Error(`trip ${s.id} is already in this FakeServer`);
    this.trips.set(s.id, s);
    this.order.push(s.id);
    const created = s.created();
    this.changed();
    const [sent] = await this.send(s.id, [created]);
    return sent!;
  }

  /** A person says something in the room. Resolves with the message once Go answered its event. */
  say(personId: string, text: string, opts: SayOptions & { tripId?: string } = {}): Promise<Message> {
    return this.act(opts.tripId ?? this.lastTripId(), (s) => s.say(personId, text, opts));
  }

  react(personId: string, messageId: string, emoji: string): Promise<void> {
    return this.act(this.tripWith((s) => s.message(messageId) !== undefined, `message ${messageId}`), (s) => s.react(personId, messageId, emoji));
  }

  edit(personId: string, messageId: string, text: string): Promise<Message> {
    return this.act(this.tripWith((s) => s.message(messageId) !== undefined, `message ${messageId}`), (s) => s.edit(personId, messageId, text));
  }

  delete(personId: string, messageId: string): Promise<void> {
    return this.act(this.tripWith((s) => s.message(messageId) !== undefined, `message ${messageId}`), (s) => s.delete(personId, messageId));
  }

  vote(decisionId: string, personId: string, optionIndex: number): Promise<void> {
    return this.act(this.tripWithDecision(decisionId), (s) => vote(s, decisionId, personId, optionIndex));
  }

  closeVoteByTime(decisionId: string): Promise<void> {
    return this.act(this.tripWithDecision(decisionId), (s) => closeVoteByTime(s, decisionId));
  }

  /** The payer taps "Yes, book it" on the mandate card. */
  confirmMandate(decisionId: string): Promise<void> {
    return this.act(this.tripWithDecision(decisionId), (s) => confirmMandate(s, decisionId));
  }

  /** The payer taps "Not now". */
  declineMandate(decisionId: string): Promise<void> {
    return this.act(this.tripWithDecision(decisionId), (s) => declineMandate(s, decisionId));
  }

  /** Someone taps a button on one of Go's cards: card_tap with a new tap_id, waiting 3.5 s like the Server. */
  async tap(cardId: string, actionId: string, personId: string, optionId?: string): Promise<TapResult> {
    const s = this.state(this.tripWith((t) => t.cardMessage(cardId) !== undefined, `card ${cardId}`));
    const tap = { tap_id: this.mint('tap_'), trip_id: s.id, card_id: cardId, action_id: actionId, person_id: personId, ...(optionId ? { option_id: optionId } : {}) };
    return CardActionResult.parse(await this.socket.request('card_tap', tap, { timeoutMs: 3500 }));
  }

  /** Sends any of the Server's requests to Go (catch_up, get_person, forget_person, vault_link...). */
  askGo(method: string, params: object, timeoutMs = 2500): Promise<Record<string, unknown>> {
    return this.socket.request(method, params, { timeoutMs });
  }

  /** Resolves with the first value of `check` that is not null, undefined or false; checks every 10 ms of real time. */
  waitFor<T>(check: () => T | null | undefined | false, timeoutMs = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = (): void => {
        let value: T | null | undefined | false;
        try {
          value = check();
        } catch (err) {
          reject(err);
          return;
        }
        if (value !== null && value !== undefined && value !== false) {
          resolve(value);
          return;
        }
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`waitFor: nothing after ${timeoutMs} ms`));
          return;
        }
        setTimeout(tick, 10);
      };
      tick();
    });
  }

  // ── what tests read ──

  /** How many times a write with this request_id arrived, repeats included. */
  countWrites(requestId: string): number {
    return this.writes.filter((w) => w.request_id === requestId).length;
  }

  tripIds(): string[] {
    return [...this.order];
  }

  trip(tripId: string = this.lastTripId()): TripSnapshot {
    return this.state(tripId).snapshot();
  }

  messages(tripId: string = this.lastTripId()): Message[] {
    return structuredClone(this.state(tripId).messages);
  }

  typingOn(tripId: string = this.lastTripId()): boolean {
    return this.state(tripId).typingOn();
  }

  needsYou(personId: string, tripId: string = this.lastTripId()): NeedsItem[] {
    return this.state(tripId).needsYou(personId);
  }

  /** Called after every change: a write, a person's action, an event answered, the socket opening or closing. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  // ── inside ──

  private mint(prefix: string): string {
    this.n += 1;
    return `${prefix}${String(this.n).padStart(4, '0')}`;
  }

  private state(tripId: string): TripState {
    const s = this.trips.get(tripId);
    if (!s) throw fail('not_found', `trip ${tripId} does not exist`);
    return s;
  }

  private lastTripId(): string {
    const id = this.order[this.order.length - 1];
    if (!id) throw new Error('create a trip first: createTrip(goaFreshTrip())');
    return id;
  }

  private tripWith(test: (s: TripState) => boolean, what: string): string {
    for (const id of [...this.order].reverse()) if (test(this.state(id))) return id;
    throw new Error(`${what} is not in any trip`);
  }

  private tripWithDecision(decisionId: string): string {
    return this.tripWith((s) => s.decision(decisionId) !== undefined, `decision ${decisionId}`);
  }

  private changed(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        this.log(`a change listener failed: ${String(err)}`);
      }
    }
  }

  private async act<R>(tripId: string, work: (s: TripState) => Change<R>): Promise<R> {
    const change = work(this.state(tripId));
    this.changed();
    await this.send(tripId, change.events);
    return change.result;
  }

  private async answer<R>(method: string, raw: Record<string, unknown>, tripId: string, work: (s: TripState) => R): Promise<R> {
    this.requests.push({ method, params: raw, at: this.now().toISOString() });
    const result = work(this.state(tripId));
    this.changed();
    return result;
  }

  private async write(method: string, p: { request_id: string; trip_id: string }, raw: Record<string, unknown>): Promise<object> {
    const at = this.now().toISOString();
    this.requests.push({ method, params: raw, at });
    const record: WriteRecord = { method, request_id: p.request_id, trip_id: p.trip_id, params: raw, applied: false, at };
    this.writes.push(record);
    try {
      const s = this.state(p.trip_id);
      const work = WRITES[method]!;
      const done = s.once(p.request_id, () => work(s, p, raw, this.o.spendPrivateKeyPem ?? TEST_SPEND_PRIVATE_KEY_PEM));
      record.applied = !done.repeat;
      // Answer first, then send the events, as the real Server's outbox does after its commit.
      setImmediate(() => void this.send(p.trip_id, done.events));
      this.changed();
      return done.result as object;
    } catch (err) {
      if (err instanceof SocketCallError) record.error = { code: err.code, message: err.message };
      this.changed();
      throw err;
    }
  }

  /** Queues events behind the trip's earlier ones; each is sent only after Go answered the one before. */
  private send(tripId: string, events: Event[]): Promise<SentEvent[]> {
    const before = this.queues.get(tripId) ?? Promise.resolve();
    const next = before.then(async () => {
      const sent: SentEvent[] = [];
      for (const event of events) sent.push(await this.sendOne(event));
      return sent;
    });
    this.queues.set(tripId, next.catch(() => undefined));
    return next;
  }

  private async sendOne(event: Event): Promise<SentEvent> {
    const record: SentEvent = { event };
    this.events.push(record);
    const waits = this.o.eventRetryMs ?? [200, 1000, 5000];
    for (let attempt = 0; ; attempt += 1) {
      if (this.stopped) return record;
      try {
        const answer = await this.socket.request('send_event', event, { timeoutMs: this.o.eventTimeoutMs ?? 2000 });
        record.answer = EventAccepted.parse(answer);
        delete record.error;
        this.changed();
        return record;
      } catch (err) {
        record.error = err instanceof Error ? err.message : String(err);
        const again = err instanceof SocketTimeoutError || (err instanceof SocketCallError && RETRYABLE.has(err.code));
        if (!again || attempt >= waits.length || this.stopped) {
          this.log(`event ${event.type} (change ${event.seq}) was not taken: ${record.error}`);
          this.changed();
          return record;
        }
        const wait = err instanceof SocketCallError && err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : (waits[attempt] ?? 5000);
        await sleep(wait);
      }
    }
  }
}
```

```ts
// packages/sim/src/index.ts
export { GoSocket, SocketCallError, SocketTimeoutError, type GoSocketOptions, type Handler } from './server-socket.js';
export { GOA_PEOPLE, GOA_SEED_CHAT, GOA_SNAPSHOT, GOA_TRIP_ID, goaFreshTrip } from './goa.js';
export { TEST_SPEND_PRIVATE_KEY_PEM, TEST_SPEND_PUBLIC_KEY_PEM } from './test-spend-key.js';
export { FakeServer, socketUrl, type FakeServerOptions, type GoRequest, type SentEvent, type TapResult, type WriteRecord } from './fake-server.js';
export { TripState, mentionsGo, type NeedsItem, type SayOptions } from './state/trip-state.js';
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add packages/sim/src/fake-server.ts packages/sim/src/index.ts packages/sim/src/__tests__/helpers/test-go.ts packages/sim/src/__tests__/fake-server.test.ts
git commit -m "feat(sim): the FakeServer, which dials Go, answers its 18 methods and sends events in order

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `fake-server.test.ts` passes (13 tests); every earlier sim test still passes. This is the point P1's end-to-end tests can start using `@go/sim` (Tue 10:00).

---
### Task 10: The dev room and the `room` command (`dev-room/`, `cli.ts`)

The dev room is a one-page App for the simulator, and the emergency demo surface (`DEMO_ROOM=sim`, master §9). One self-contained HTML page (no build step, no outside scripts, system fonts) talks to `serveDevRoom` over a small WebSocket: the server pushes the room's state after every change (a burst is one update, plus a redraw every second so "Go is typing..." runs out), and the page sends what people do. It shows the room with Go's messages as Go (a sky-blue circle with "Go"), reactions (Go's included), "Go is typing...", a person switcher for the five Goa people, a text box, the "needs you" list for the chosen person, and all 13 card kinds drawn simply with their buttons: taps go to Go as `card_tap`, an `open` answer opens the URL in a new tab, vote buttons vote, and the payer sees "Yes, book it" and "Not now". People's text is escaped everywhere, and only http(s) links are ever used.

The page's script is plain ES5 with string concatenation: it lives inside a TypeScript template literal, so it has no backticks, no `${` and no backslashes. A test checks that it parses.

**Files:**
- Create: `packages/sim/src/dev-room/page.ts`
- Create: `packages/sim/src/dev-room/serve.ts`
- Create: `packages/sim/src/cli.ts`
- Modify: `packages/sim/package.json` (add the `room` script)
- Modify: `packages/sim/src/index.ts` (export the dev room)
- Test: `packages/sim/src/__tests__/dev-room.test.ts`

**Interfaces:**
- Consumes: Task 9: `FakeServer` (`trip`, `messages`, `typingOn`, `needsYou`, `isOpen`, `tripIds`, `onChange`, `say`, `tap`, `vote`, `react`, `confirmMandate`, `declineMandate`, `start`, `createTrip`); Task 2: `GOA_SNAPSHOT`, `GOA_SEED_CHAT`, `goaFreshTrip`; tests: `startTestGo`.
- Produces:
  - `const PAGE_HTML: string`
  - `function roomState(fake: FakeServer, tripId: string): { type: 'state'; connected: boolean; trip: TripSnapshot; messages: Message[]; typing: boolean; needs: Record<string, NeedsItem[]> }`
  - `function serveDevRoom(o: { fake: FakeServer; port: number; host?: string; tripId?: string }): Promise<{ url: string; close(): Promise<void> }>`
  - The live socket at `/live`: the server sends `{ type: 'state', ... }`, `{ type: 'tap_result', result }` and `{ type: 'error', message }`; the page sends `say`, `tap`, `vote`, `react`, `confirm`, `decline`.
  - `pnpm --filter @go/sim room -- --go ws://localhost:8080 --secret $GO_SIGNING_SECRET --port 5174 [--host 0.0.0.0] [--instance sim] [--fixture fresh|planning] [--seed]`

- [ ] **Step 1: Write the failing test**

```ts
// packages/sim/src/__tests__/dev-room.test.ts
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PAGE_HTML } from '../dev-room/page.js';
import { serveDevRoom, type DevRoom } from '../dev-room/serve.js';
import { FakeServer } from '../fake-server.js';
import { goaFreshTrip } from '../goa.js';
import { startTestGo, type TestGo } from './helpers/test-go.js';

const secret = 'sim-test-secret-0123456789abcdef';
const KINDS = ['vote', 'mandate', 'ticket', 'expense', 'settle_up', 'day', 'plan', 'budget', 'options', 'working', 'call', 'pay', 'notice'];
let go: TestGo | undefined;
let fake: FakeServer | undefined;
let room: DevRoom | undefined;
const clients: WebSocket[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  await room?.close();
  fake?.stop();
  await go?.close();
  room = undefined;
  fake = undefined;
  go = undefined;
});

async function setUp() {
  go = await startTestGo(secret);
  fake = new FakeServer({ goUrl: go.url, secret });
  await fake.start(3000);
  await fake.createTrip(goaFreshTrip());
  room = await serveDevRoom({ fake, port: 0 });
  return { go, fake, room };
}

/** Opens the page's live socket and collects what it receives. */
async function live(url: string) {
  const ws = new WebSocket(`${url.replace('http', 'ws')}live`);
  clients.push(ws);
  const got: any[] = [];
  ws.on('message', (d) => got.push(JSON.parse(d.toString())));
  await once(ws, 'open');
  return { ws, got };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('the dev room page', () => {
  it('is one self-contained page with no em dashes, a script that parses, and every card kind', async () => {
    const { room: r } = await setUp();
    const res = await fetch(r.url);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toBe(PAGE_HTML);
    expect(html).toContain('<title>Go dev room</title>');
    expect(html).not.toContain('\u2014');
    expect(html).not.toMatch(/<script[^>]+src=/);
    const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>'));
    expect(() => new Function(script)).not.toThrow();
    for (const kind of KINDS) expect(script).toContain(`${kind}: function`);
    expect((await fetch(`${r.url}nope`)).status).toBe(404);
  });
});

describe('the live socket', () => {
  it("sends the room's state on connect: the trip, the people and each person's needs", async () => {
    const { room: r } = await setUp();
    const { got } = await live(r.url);
    await until(() => got.length > 0);
    expect(got[0]).toMatchObject({ type: 'state', connected: true, trip: { trip_id: 't_goa' }, typing: false, messages: [] });
    expect(Object.keys(got[0].needs).sort()).toEqual(['p_arjun', 'p_kabir', 'p_meher', 'p_priya', 'p_rahul']);
  });

  it('turns what people do on the page into the room, and pushes the new state', async () => {
    const { go: g, fake: f, room: r } = await setUp();
    const { ws, got } = await live(r.url);
    ws.send(JSON.stringify({ type: 'say', personId: 'p_priya', text: '@Go flights?' }));
    await until(() => g.events.some((e) => e.type === 'message.created'));
    expect(g.events.at(-1)).toMatchObject({ type: 'message.created', data: { message: { mentions_go: true } } });
    expect(f.messages()).toHaveLength(1);
    await until(() => got.some((s) => s.type === 'state' && s.messages.length === 1));
    const opened = (await g.call('open_vote', { request_id: 'rq_o', trip_id: 't_goa', question: 'Where?', kind: 'choice', anonymous: false, options: [{ label: 'A' }, { label: 'B' }] })).result;
    ws.send(JSON.stringify({ type: 'vote', decisionId: opened.decision_id, personId: 'p_arjun', optionIndex: 1 }));
    await until(() => f.trip().decisions[0]?.voted === 1);
    ws.send(JSON.stringify({ type: 'react', personId: 'p_meher', messageId: f.messages()[0]!.message_id, emoji: '👍' }));
    await until(() => f.messages()[0]!.reactions.length === 1);
  });

  it("sends a tap to Go and hands Go's answer back to the page", async () => {
    const { go: g, room: r } = await setUp();
    const { ws, got } = await live(r.url);
    await g.call('post_message', {
      request_id: 'rq_card', trip_id: 't_goa',
      card: { card_id: 'c_w', kind: 'working', fallback_text: 'Working', task_id: 'task_1', title: 'Finding villas', state: 'running', steps: [], updated_at: '2026-10-05T07:00:00Z', actions: [{ action_id: 'watch', label: 'Watch', style: 'primary' }] },
    });
    ws.send(JSON.stringify({ type: 'tap', cardId: 'c_w', actionId: 'watch', personId: 'p_arjun' }));
    await until(() => got.some((m) => m.type === 'tap_result'));
    expect(got.find((m) => m.type === 'tap_result').result).toEqual({ result: 'done', toast: 'Noted.' });
    expect(g.taps[0]).toMatchObject({ card_id: 'c_w', action_id: 'watch', person_id: 'p_arjun' });
  });

  it('shrugs off junk, and tells the page when an action is refused', async () => {
    const { fake: f, room: r } = await setUp();
    const { ws, got } = await live(r.url);
    ws.send('not json');
    ws.send(JSON.stringify({ type: 'dance' }));
    ws.send(JSON.stringify({ type: 'say', personId: 'p_stranger', text: 'hi' }));
    await until(() => got.some((m) => m.type === 'error'));
    expect(got.find((m) => m.type === 'error').message).toContain('p_stranger');
    ws.send(JSON.stringify({ type: 'say', personId: 'p_rahul', text: 'still here' }));
    await until(() => f.messages().some((m) => m.text === 'still here'));
  });
});
```

- [ ] **Step 2: Push the test and see it fail.** Red is certain: the modules do not exist yet. Skip to Step 3.

- [ ] **Step 3: Write the implementation**

```ts
// packages/sim/src/dev-room/page.ts
// The dev room: one self-contained page. Its script is plain ES5 built with string concatenation, because it
// lives inside this template literal: no backticks, no dollar-brace and no backslashes in it.
export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Go dev room</title>
<style>
:root { --bg: #f6f7f9; --panel: #ffffff; --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; --go: #38bdf8; --go-ink: #0369a1; --accent: #0f172a; --warn: #b45309; }
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--ink); font-size: 15px; line-height: 1.45; }
header { position: sticky; top: 0; z-index: 2; background: var(--panel); border-bottom: 1px solid var(--line); padding: 12px 16px; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; }
.title { font-weight: 650; font-size: 17px; }
.title small { display: block; font-weight: 400; color: var(--muted); font-size: 12px; }
.people { display: flex; gap: 6px; flex-wrap: wrap; }
.person { border: 1px solid var(--line); background: var(--panel); border-radius: 999px; padding: 4px 10px 4px 4px; display: flex; gap: 6px; align-items: center; cursor: pointer; font: inherit; color: inherit; }
.person.me { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.avatar { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; color: #fff; font-weight: 650; font-size: 12px; flex: none; }
.avatar.go { background: var(--go); }
main { max-width: 760px; margin: 0 auto; padding: 16px 16px 140px; }
.needs { background: #fff7ed; border: 1px solid #fed7aa; border-radius: 14px; padding: 10px 14px; margin-bottom: 16px; }
.needs h2 { font-size: 12px; margin: 0 0 6px; color: var(--warn); text-transform: uppercase; letter-spacing: .04em; }
.needs div { padding: 3px 0; }
.msg { display: flex; gap: 10px; margin: 14px 0; }
.bubble { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 10px 14px; min-width: 0; flex: 1; }
.msg.go .bubble { border-color: #bae6fd; background: #f0f9ff; }
.who { font-weight: 650; font-size: 13px; margin-bottom: 2px; }
.who span { font-weight: 400; color: var(--muted); margin-left: 6px; }
.quote { border-left: 3px solid var(--line); padding-left: 8px; color: var(--muted); font-size: 13px; margin: 4px 0; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; }
.muted { color: var(--muted); font-style: italic; }
.reactions { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; align-items: center; }
.chip { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; font-size: 13px; background: var(--panel); margin: 2px 2px 0 0; }
.react { border: 0; background: none; cursor: pointer; opacity: .45; font-size: 14px; padding: 0 4px; }
.react:hover { opacity: 1; }
.card { margin-top: 10px; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); padding: 12px 14px; }
.card h3 { margin: 0 0 4px; font-size: 15px; }
.meta { color: var(--muted); font-size: 12px; }
.tag { display: inline-block; font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin-bottom: 4px; }
.tag.warn { color: var(--warn); }
.row { border-top: 1px solid var(--line); padding: 8px 0; display: flex; gap: 10px; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; }
.price { font-weight: 650; white-space: nowrap; }
.big { font-size: 26px; font-weight: 700; }
.bar { height: 6px; background: var(--line); border-radius: 999px; overflow: hidden; margin-top: 4px; }
.bar i { display: block; height: 100%; background: var(--go); }
.steps div { padding: 2px 0; }
.actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
button.act { font: inherit; font-size: 14px; border-radius: 10px; padding: 7px 14px; cursor: pointer; border: 1px solid var(--accent); margin-top: 4px; }
button.primary { background: var(--accent); color: #fff; }
button.secondary { background: var(--panel); color: var(--accent); }
.typing { color: var(--go-ink); font-size: 13px; min-height: 20px; margin: 4px 0 0 38px; }
footer { position: fixed; left: 0; right: 0; bottom: 0; background: var(--panel); border-top: 1px solid var(--line); padding: 12px 16px; }
form { max-width: 760px; margin: 0 auto; display: flex; gap: 8px; }
input[type=text] { flex: 1; font: inherit; border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; min-width: 0; }
.toast { position: fixed; left: 50%; bottom: 84px; transform: translateX(-50%); background: var(--accent); color: #fff; border-radius: 10px; padding: 8px 14px; font-size: 14px; opacity: 0; transition: opacity .2s; pointer-events: none; max-width: 90vw; }
.toast.show { opacity: 1; }
</style>
</head>
<body>
<header>
  <div class="title" id="title">Go dev room<small>connecting</small></div>
  <div class="people" id="people"></div>
</header>
<main>
  <div id="needs"></div>
  <div id="room"></div>
  <div class="typing" id="typing"></div>
</main>
<footer>
  <form id="composer"><input type="text" id="text" autocomplete="off" placeholder="Message the group. Start with @Go to ask Go."><button class="act primary" type="submit">Send</button></form>
</footer>
<div class="toast" id="toast"></div>
<script>
(function () {
  var COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#8b5cf6', '#ef4444', '#14b8a6'];
  var state = null;
  var me = 'p_rahul';
  var ws = null;
  var toastTimer = null;
  try { me = localStorage.getItem('go-dev-room-me') || me; } catch (e) {}

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function safeUrl(u) { return /^https?:/i.test(String(u || '')) ? String(u) : ''; }
  function money(minor, cur) {
    if (minor == null) return '';
    var text = Math.round(minor / 100).toLocaleString('en-IN');
    return !cur || cur === 'INR' ? '₹' + text : cur + ' ' + text;
  }
  function ago(iso) {
    if (!iso) return '';
    var s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }
  function when(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  }
  function find(list, key, id) { for (var i = 0; i < list.length; i++) if (list[i][key] === id) return list[i]; return null; }
  function person(id) { return state ? find(state.trip.people, 'person_id', id) : null; }
  function nameOf(id) { var p = person(id); return p ? p.name : String(id); }
  function color(id) {
    var ps = state ? state.trip.people : [];
    for (var i = 0; i < ps.length; i++) if (ps[i].person_id === id) return COLORS[i % COLORS.length];
    return '#94a3b8';
  }
  function avatar(author) {
    if (author.kind === 'go') return '<div class="avatar go">Go</div>';
    if (author.kind === 'system') return '<div class="avatar" style="background:#94a3b8">i</div>';
    return '<div class="avatar" style="background:' + color(author.person_id) + '">' + esc(nameOf(author.person_id).slice(0, 1)) + '</div>';
  }
  function decision(id) { return find(state.trip.decisions, 'decision_id', id); }
  function send(action) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(action)); }
  function toast(text) {
    var t = $('toast');
    t.textContent = text;
    t.className = 'toast show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 2500);
  }

  function visible(action) { return !action.only_for_person_ids || action.only_for_person_ids.indexOf(me) >= 0; }
  function goButton(card, action, optionId) {
    return '<button class="act ' + (action.style === 'primary' ? 'primary' : 'secondary') + '" data-tap="' + esc(card.card_id) + '" data-action="' + esc(action.action_id) + '"' +
      (optionId ? ' data-option="' + esc(optionId) + '"' : '') + '>' + esc(action.label) + '</button>';
  }
  function goActions(card) {
    var acts = (card.actions || []).filter(function (a) { return !a.per_option && visible(a); });
    return acts.length ? '<div class="actions">' + acts.map(function (a) { return goButton(card, a, ''); }).join('') + '</div>' : '';
  }
  function items(list) {
    return list.map(function (i) {
      return '<div class="row"><div>' + esc(i.time || '') + ' ' + esc(i.title) + (i.status === 'idea' ? ' <span class="chip">idea</span>' : '') +
        (i.status === 'booked' ? ' <span class="chip">booked</span>' : '') + '</div></div>';
    }).join('');
  }
  function fallback(c) { return '<div>' + esc(c.fallback_text) + '</div>'; }

  var RENDER = {
    vote: function (c) {
      var d = decision(c.decision_id);
      if (!d) return fallback(c);
      var total = Math.max(1, d.voted);
      var mine = null;
      (d.votes || []).forEach(function (v) { if (v.person_id === me) mine = v.option_index; });
      var rows = d.options.map(function (o, i) {
        var n = d.tally[i] || 0;
        var won = d.status === 'closed' && d.result_index === i;
        var btn = d.status === 'open' ? '<button class="act ' + (mine === i ? 'primary' : 'secondary') + '" data-vote="' + esc(d.decision_id) + '" data-index="' + i + '">' + (mine === i ? 'Your vote' : 'Vote') + '</button>' : '';
        return '<div class="row"><div style="flex:1;min-width:160px"><b>' + esc(o.label) + (won ? ' (won)' : '') + '</b>' + (o.note ? '<div class="meta">' + esc(o.note) + '</div>' : '') +
          '<div class="bar"><i style="width:' + Math.round(100 * n / total) + '%"></i></div></div><div class="price">' + money(o.price_minor, o.currency) + '</div>' + btn + '</div>';
      }).join('');
      var status = d.status === 'open' ? d.voted + ' of ' + d.of + ' voted' + (d.closes_at ? ', closes ' + when(d.closes_at) : '')
        : d.status === 'closed' ? (d.result_index != null ? d.options[d.result_index].label + ' won, ' + d.voted + ' of ' + d.of + ' voted' : 'No winner, Go will ask the group') : 'Called off';
      return '<span class="tag">Vote</span><h3>' + esc(d.question) + '</h3><div class="meta">' + esc(status) + (d.anonymous ? ', anonymous' : '') + '</div>' + rows;
    },
    mandate: function (c) {
      var d = decision(c.decision_id);
      if (!d || !d.mandate) return fallback(c);
      var m = d.mandate;
      var opt = d.options[m.choice_index] || { label: 'the winner' };
      var answer = m.confirmed_at && !(m.declined_at && Date.parse(m.declined_at) > Date.parse(m.confirmed_at)) ? nameOf(m.payer_person_id) + ' said yes'
        : m.declined_at ? nameOf(m.payer_person_id) + ' said not now' : '';
      var bottom = answer ? '<div class="meta">' + esc(answer) + '</div>'
        : me === m.payer_person_id ? '<div class="actions"><button class="act primary" data-confirm="' + esc(d.decision_id) + '">Yes, book it</button><button class="act secondary" data-decline="' + esc(d.decision_id) + '">Not now</button></div>'
        : '<div class="meta">Waiting for ' + esc(nameOf(m.payer_person_id)) + '</div>';
      return '<span class="tag">Ready to book</span><h3>' + esc(opt.label) + '</h3><div>Up to ' + money(m.cap_minor, m.currency) + (m.refundable_only ? ', refundable only' : '') + '</div>' +
        '<div class="meta">' + esc(nameOf(m.payer_person_id)) + ' pays</div>' + bottom;
    },
    ticket: function (c) {
      var b = find(state.trip.bookings, 'booking_id', c.booking_id);
      if (!b) return fallback(c);
      var j = b.journey;
      var route = j ? esc((j.origin.code || j.origin.name) + ' to ' + (j.destination.code || j.destination.name) + ', ' + when(j.depart_at))
        : esc(b.starts_at ? when(b.starts_at) + (b.ends_at ? ' to ' + when(b.ends_at) : '') : '');
      return '<span class="tag">' + (b.status === 'cancelled' ? 'Cancelled' : 'Booked') + '</span><h3>' + esc(b.title) + '</h3><div>' + route + '</div>' +
        '<div class="meta">' + esc(b.vendor) + ', ref ' + esc(b.ref) + '. ' + esc(nameOf(b.payer_person_id)) + ' paid ' + money(b.amount_minor, b.currency) +
        (b.refundable_until ? '. Free cancellation until ' + esc(when(b.refundable_until)) : '') + '</div>';
    },
    expense: function (c) {
      var e = find(state.trip.expenses, 'expense_id', c.expense_id);
      if (!e) return fallback(c);
      return '<span class="tag">Expense</span><h3>' + esc(e.note) + '</h3><div>' + esc(nameOf(e.paid_by_person_id)) + ' paid ' + money(e.amount_minor, e.currency) + '</div>' +
        '<div class="meta">Split between ' + e.split_person_ids.length + ', ' + money(Math.floor(e.amount_minor / e.split_person_ids.length), e.currency) + ' each</div>';
    },
    settle_up: function () {
      var t = state.trip.money.transfers;
      return '<span class="tag">Settle up</span>' + (t.length ? t.map(function (x) {
        return '<div class="row"><div>' + esc(nameOf(x.from_person_id)) + ' pays ' + esc(nameOf(x.to_person_id)) + '</div><div class="price">' + money(x.amount_minor, x.currency) + '</div></div>';
      }).join('') : '<div>Everyone is square</div>');
    },
    day: function (c) {
      var d = find(state.trip.itinerary, 'date', c.date);
      if (!d) return '<span class="tag">Day</span><h3>' + esc(c.date) + '</h3><div class="meta">Nothing planned for this day yet</div>';
      return '<span class="tag">Day</span><h3>' + esc(c.date) + (d.title ? ', ' + esc(d.title) : '') + '</h3>' + items(d.items);
    },
    plan: function () {
      var days = state.trip.itinerary;
      if (!days.length) return '<span class="tag">Plan</span><div class="meta">No plan yet</div>';
      return '<span class="tag">Plan</span>' + days.map(function (d) { return '<h3 style="margin-top:8px">' + esc(d.date) + (d.title ? ', ' + esc(d.title) : '') + '</h3>' + items(d.items); }).join('');
    },
    budget: function () {
      var m = state.trip.money;
      var pct = m.plan_minor ? Math.min(100, Math.round(100 * m.spent_minor / m.plan_minor)) : 0;
      return '<span class="tag">Budget</span><h3>' + money(m.spent_minor, m.currency) + (m.plan_minor ? ' of ' + money(m.plan_minor, m.currency) : ' spent') + '</h3>' +
        (m.plan_minor ? '<div class="bar"><i style="width:' + pct + '%"></i></div>' : '') +
        m.by_category.map(function (x) { return '<div class="row"><div>' + esc(x.category.replace('_', ' ')) + '</div><div class="price">' + money(x.amount_minor, m.currency) + '</div></div>'; }).join('');
    },
    options: function (c) {
      var per = (c.actions || []).filter(function (a) { return a.per_option && visible(a); });
      return '<span class="tag">' + esc(c.option_kind) + '</span><h3>' + esc(c.title) + '</h3><div class="meta">Checked ' + esc(ago(c.checked_at)) + '</div>' + c.options.map(function (o) {
        var j = o.journey;
        var line = j ? esc((j.origin.code || j.origin.name) + ' to ' + (j.destination.code || j.destination.name) + (j.stops === 0 ? ', non-stop' : '')) : '';
        return '<div class="row"><div style="flex:1;min-width:160px"><b>' + esc(o.title) + '</b>' + (o.subtitle ? '<div class="meta">' + esc(o.subtitle) + '</div>' : '') +
          (line ? '<div class="meta">' + line + '</div>' : '') + '<div>' + (o.highlights || []).map(function (h) { return '<span class="chip">' + esc(h) + '</span>'; }).join('') +
          (o.rating != null ? '<span class="chip">' + esc(o.rating) + ' stars</span>' : '') + (o.refundable_until ? '<span class="chip">Free cancellation</span>' : '') + '</div></div>' +
          '<div><div class="price">' + money(o.price_minor, o.currency) + (o.price_note ? ' <span class="meta">' + esc(o.price_note) + '</span>' : '') + '</div>' +
          per.map(function (a) { return goButton(c, a, o.option_id); }).join('') + '</div></div>';
      }).join('') + goActions(c);
    },
    working: function (c) {
      var label = { running: 'Working on it', needs_you: 'Needs you', done: 'Done', failed: "Didn't work" }[c.state] || c.state;
      var mark = { todo: '○', doing: '◐', done: '●', failed: '×' };
      var shot = safeUrl(c.screenshot_url);
      return '<span class="tag' + (c.state === 'needs_you' ? ' warn' : '') + '">' + esc(label) + '</span><h3>' + esc(c.title) + '</h3><div class="steps">' +
        c.steps.map(function (s) { return '<div>' + (mark[s.state] || '') + ' ' + esc(s.text) + '</div>'; }).join('') + '</div>' +
        (shot ? '<img alt="" src="' + esc(shot) + '" style="max-width:100%;border-radius:10px;margin-top:8px">' : '') +
        '<div class="meta">Updated ' + esc(ago(c.updated_at)) + '</div>' + goActions(c);
    },
    call: function (c) {
      var label = { dialing: 'Calling ' + c.business + '...', talking: 'On the call', ended: 'Call ended', failed: "Couldn't get through" }[c.state] || c.state;
      var who = function (l) { return l.who === 'go' ? 'Go' : esc(c.business); };
      return '<span class="tag">' + esc(label) + '</span><h3>' + esc(c.business) + ': ' + esc(c.goal) + '</h3>' +
        (c.last_line ? '<div class="quote">' + who(c.last_line) + ': ' + esc(c.last_line.text) + '</div>' : '') + (c.outcome ? '<div>' + esc(c.outcome) + '</div>' : '') +
        (c.transcript && c.transcript.length ? '<details><summary>Show transcript</summary>' + c.transcript.map(function (l) { return '<div>' + who(l) + ': ' + esc(l.text) + '</div>'; }).join('') + '</details>' : '') +
        goActions(c);
    },
    pay: function (c) {
      var waiting = c.state === 'waiting' && Date.parse(c.expires_at) > Date.now();
      var label = waiting ? 'Waiting for ' + nameOf(c.payer_person_id) : ({ paid: 'Paid', declined: 'Declined', expired: 'Expired', failed: 'Failed', waiting: 'Expired' }[c.state] || c.state);
      return '<span class="tag">Payment</span><div class="big">' + money(c.amount_minor, c.currency) + '</div><div>' + esc(c.merchant) + '</div>' +
        '<div class="meta">' + esc(c.purpose) + (c.refundable_until ? '. Free cancellation until ' + esc(when(c.refundable_until)) : '') + '</div>' +
        '<div class="meta">' + esc(nameOf(c.payer_person_id)) + ' pays. ' + esc(label) + '</div>' + (waiting ? goActions(c) : '');
    },
    notice: function (c) {
      var link = c.source ? safeUrl(c.source.url) : '';
      var src = c.source ? (link ? '<a href="' + esc(link) + '" target="_blank" rel="noopener">' + esc(c.source.name) + '</a>' : esc(c.source.name)) : '';
      return '<span class="tag' + (c.tone === 'heads_up' ? ' warn' : '') + '">' + (c.tone === 'heads_up' ? 'Heads up' : 'Good to know') + '</span><h3>' + esc(c.title) + '</h3>' +
        '<div>' + esc(c.body) + '</div><div class="meta">' + src + (c.checked_at ? (src ? ', checked ' : 'Checked ') + esc(ago(c.checked_at)) : '') +
        (c.deadline_at ? '. By ' + esc(when(c.deadline_at)) : '') + '</div>' + goActions(c);
    }
  };

  function card(c) {
    var known = Object.prototype.hasOwnProperty.call(RENDER, c.kind);
    return '<div class="card">' + (known ? RENDER[c.kind](c) : fallback(c)) + '</div>';
  }

  function message(m) {
    var go = m.author.kind === 'go';
    var name = go ? 'Go' : m.author.kind === 'system' ? 'Trip' : nameOf(m.author.person_id);
    var reply = m.reply_to ? find(state.messages, 'message_id', m.reply_to) : null;
    var body = m.deleted ? '<div class="muted">Message deleted</div>'
      : m.withheld ? '<div class="muted">Hidden from Go: this person paused Go</div>'
      : (m.text ? '<div class="text">' + esc(m.text) + '</div>' : '');
    var counts = Object.create(null);
    (m.reactions || []).forEach(function (r) {
      counts[r.emoji] = counts[r.emoji] || [];
      counts[r.emoji].push(r.person_id == null ? 'Go' : nameOf(r.person_id));
    });
    var chips = Object.keys(counts).map(function (k) { return '<span class="chip" title="' + esc(counts[k].join(', ')) + '">' + esc(k) + ' ' + counts[k].length + '</span>'; }).join('');
    var react = m.deleted ? '' : '<button class="react" data-react="' + esc(m.message_id) + '" title="React with a thumbs up">👍</button>';
    var quote = reply ? '<div class="quote">' + esc(reply.author.kind === 'go' ? 'Go' : nameOf(reply.author.person_id)) + ': ' + esc((reply.text || '').slice(0, 120)) + '</div>' : '';
    return '<div class="msg' + (go ? ' go' : '') + '">' + avatar(m.author) + '<div class="bubble"><div class="who">' + esc(name) + '<span>' + esc(when(m.sent_at)) + (m.edited_at ? ', edited' : '') + '</span></div>' +
      quote + body + (m.card && !m.deleted ? card(m.card) : '') + '<div class="reactions">' + chips + react + '</div></div></div>';
  }

  function render() {
    if (!state) return;
    var t = state.trip;
    $('title').innerHTML = esc(t.title) + '<small>' + esc(t.people.length + ' people, change ' + t.seq + (state.connected ? '' : ', Go is not connected')) + '</small>';
    $('people').innerHTML = t.people.map(function (p) {
      return '<button class="person' + (p.person_id === me ? ' me' : '') + '" data-me="' + esc(p.person_id) + '">' + avatar({ kind: 'person', person_id: p.person_id }) + esc(p.name) + '</button>';
    }).join('');
    var needs = state.needs[me] || [];
    $('needs').innerHTML = needs.length ? '<div class="needs"><h2>Needs you, ' + esc(nameOf(me)) + '</h2>' + needs.map(function (n) { return '<div>' + esc(n.text) + '</div>'; }).join('') + '</div>' : '';
    var atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
    $('room').innerHTML = state.messages.map(message).join('') || '<div class="muted">No messages yet. Say hello, or start with @Go to ask Go.</div>';
    $('typing').textContent = state.typing ? 'Go is typing...' : '';
    if (atBottom) window.scrollTo(0, document.body.scrollHeight);
  }

  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!el) return;
    var d = el.dataset;
    if (d.me) {
      me = d.me;
      try { localStorage.setItem('go-dev-room-me', me); } catch (x) {}
      render();
    } else if (d.tap) {
      send({ type: 'tap', cardId: d.tap, actionId: d.action, personId: me, optionId: d.option || undefined });
    } else if (d.vote) {
      send({ type: 'vote', decisionId: d.vote, personId: me, optionIndex: Number(d.index) });
    } else if (d.confirm) {
      send({ type: 'confirm', decisionId: d.confirm });
    } else if (d.decline) {
      send({ type: 'decline', decisionId: d.decline });
    } else if (d.react) {
      send({ type: 'react', personId: me, messageId: d.react, emoji: '👍' });
    }
  });

  $('composer').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('text');
    var text = input.value.trim();
    if (!text) return;
    send({ type: 'say', personId: me, text: text });
    input.value = '';
  });

  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/live');
    ws.onmessage = function (ev) {
      var data = JSON.parse(ev.data);
      if (data.type === 'state') {
        state = data;
        if (!person(me) && state.trip.people.length) me = state.trip.people[0].person_id;
        render();
      } else if (data.type === 'tap_result') {
        var r = data.result;
        if (r.result === 'open' && safeUrl(r.url)) {
          window.open(r.url, '_blank', 'noopener');
          toast('Opening the page');
        } else {
          toast(r.toast || (r.result === 'done' ? 'Done' : 'Not allowed'));
        }
      } else if (data.type === 'error') {
        toast(data.message);
      }
    };
    ws.onclose = function () { setTimeout(connect, 1000); };
  }

  connect();
  setInterval(render, 15000); // keeps "checked 3 min ago" honest
})();
</script>
</body>
</html>
`;
```

```ts
// packages/sim/src/dev-room/serve.ts
// serveDevRoom: the dev room, a one-page App for the simulator and the emergency demo surface. It serves the
// page and a live WebSocket at /live: the page gets the room's state after every change and sends what people
// do (say, tap, vote, react, the payer's yes or no), which the FakeServer turns into events for Go.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { FakeServer } from '../fake-server.js';
import { PAGE_HTML } from './page.js';

export interface DevRoomOptions {
  fake: FakeServer;
  /** 0 picks a free port. */
  port: number;
  /** Default 127.0.0.1. Use 0.0.0.0 to open it from a phone on the same network. */
  host?: string;
  /** Default: the trip created last. */
  tripId?: string;
}

export interface DevRoom {
  url: string;
  close(): Promise<void>;
}

/** What the page may send. Anything else is ignored. */
type Action =
  | { type: 'say'; personId: string; text: string }
  | { type: 'tap'; cardId: string; actionId: string; personId: string; optionId?: string }
  | { type: 'vote'; decisionId: string; personId: string; optionIndex: number }
  | { type: 'react'; personId: string; messageId: string; emoji: string }
  | { type: 'confirm'; decisionId: string }
  | { type: 'decline'; decisionId: string };

/** What the page draws: the trip, the room, Go's typing, and each person's "needs you" list. */
export function roomState(fake: FakeServer, tripId: string) {
  const trip = fake.trip(tripId);
  return {
    type: 'state' as const,
    connected: fake.isOpen(),
    trip,
    messages: fake.messages(tripId),
    typing: fake.typingOn(tripId),
    needs: Object.fromEntries(trip.people.map((p) => [p.person_id, fake.needsYou(p.person_id, tripId)])),
  };
}

export async function serveDevRoom(o: DevRoomOptions): Promise<DevRoom> {
  const tripId = o.tripId ?? o.fake.tripIds().at(-1);
  if (!tripId) throw new Error('create a trip first: fake.createTrip(goaFreshTrip())');
  const host = o.host ?? '127.0.0.1';

  const http = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE_HTML);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });
  const wss = new WebSocketServer({ noServer: true });

  const push = (ws: WebSocket): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(roomState(o.fake, tripId)));
  };
  const pushAll = (): void => {
    for (const c of wss.clients) push(c);
  };

  const act = async (ws: WebSocket, text: string): Promise<void> => {
    let a: Action;
    try {
      a = JSON.parse(text) as Action;
    } catch {
      return;
    }
    try {
      switch (a.type) {
        case 'say': {
          const words = typeof a.text === 'string' ? a.text.trim() : '';
          if (words) await o.fake.say(a.personId, words, { tripId });
          break;
        }
        case 'tap':
          ws.send(JSON.stringify({ type: 'tap_result', result: await o.fake.tap(a.cardId, a.actionId, a.personId, a.optionId) }));
          break;
        case 'vote':
          await o.fake.vote(a.decisionId, a.personId, a.optionIndex);
          break;
        case 'react':
          await o.fake.react(a.personId, a.messageId, a.emoji);
          break;
        case 'confirm':
          await o.fake.confirmMandate(a.decisionId);
          break;
        case 'decline':
          await o.fake.declineMandate(a.decisionId);
          break;
        default:
          break;
      }
    } catch (err) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
    }
  };

  http.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== '/live') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      push(ws);
      ws.on('message', (data) => void act(ws, data.toString()));
      ws.on('error', () => {});
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
  const tick = setInterval(pushAll, 1000);

  await new Promise<void>((resolve) => http.listen(o.port, host, resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    url: `http://${host}:${port}/`,
    close: async () => {
      off();
      clearInterval(tick);
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
```

```ts
// packages/sim/src/cli.ts
// pnpm --filter @go/sim room -- --go ws://localhost:8080 --secret $GO_SIGNING_SECRET --port 5174
// Starts the FakeServer against a running Go, creates the Goa trip, and serves the dev room.
// Options: --host 0.0.0.0 (open it from a phone), --instance <name>, --fixture fresh|planning, --seed (say the seed chat).
import { parseArgs } from 'node:util';
import { serveDevRoom } from './dev-room/serve.js';
import { FakeServer } from './fake-server.js';
import { GOA_SEED_CHAT, GOA_SNAPSHOT, goaFreshTrip } from './goa.js';

const argv = process.argv.slice(2);
if (argv[0] === '--') argv.shift(); // pnpm may pass its separator through
const { values } = parseArgs({
  args: argv,
  options: {
    go: { type: 'string' },
    secret: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
    instance: { type: 'string' },
    fixture: { type: 'string' },
    seed: { type: 'boolean' },
  },
});

const goUrl = values.go ?? 'ws://localhost:8080';
const secret = values.secret ?? process.env.GO_SIGNING_SECRET;
if (!secret) {
  console.error('Pass --secret or set GO_SIGNING_SECRET.');
  process.exit(2);
}

const fake = new FakeServer({ goUrl, secret, instance: values.instance ?? 'sim', log: (line) => console.log(line) });
console.log(`connecting to Go at ${goUrl}`);
await fake.start();
await fake.createTrip(values.fixture === 'planning' ? GOA_SNAPSHOT : goaFreshTrip());
if (values.seed) for (const line of GOA_SEED_CHAT) await fake.say(line.personId, line.text);
const room = await serveDevRoom({ fake, port: Number(values.port ?? '5174'), host: values.host ?? '127.0.0.1' });
console.log(`the dev room is open at ${room.url}`);
```

In `packages/sim/package.json`, add one script line after `"test": "vitest run"`:

```json
    "room": "tsx src/cli.ts"
```

```ts
// packages/sim/src/index.ts
export { GoSocket, SocketCallError, SocketTimeoutError, type GoSocketOptions, type Handler } from './server-socket.js';
export { GOA_PEOPLE, GOA_SEED_CHAT, GOA_SNAPSHOT, GOA_TRIP_ID, goaFreshTrip } from './goa.js';
export { TEST_SPEND_PRIVATE_KEY_PEM, TEST_SPEND_PUBLIC_KEY_PEM } from './test-spend-key.js';
export { FakeServer, socketUrl, type FakeServerOptions, type GoRequest, type SentEvent, type TapResult, type WriteRecord } from './fake-server.js';
export { TripState, mentionsGo, type NeedsItem, type SayOptions } from './state/trip-state.js';
export { roomState, serveDevRoom, type DevRoom, type DevRoomOptions } from './dev-room/serve.js';
```

(`cli.ts` is not exported: importing it would start a FakeServer.)

- [ ] **Step 4: Commit, push, read CI**

```bash
git add packages/sim/src/dev-room/page.ts packages/sim/src/dev-room/serve.ts packages/sim/src/cli.ts packages/sim/package.json packages/sim/src/index.ts packages/sim/src/__tests__/dev-room.test.ts
git commit -m "feat(sim): the dev room, a one-page App for the simulator, and the room command

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `dev-room.test.ts` passes (5 tests); every sim and fake Go test still passes.

- [ ] **Step 5: Look at it once by hand (not a test run).** Once P1's Go runs locally, or against the deployed fake Go (`--go https://<fake-go domain>` with its secret), run `pnpm --filter @go/sim room -- --go <url> --secret "$GO_SIGNING_SECRET" --seed` and open the printed URL. Switch to Priya, send "@Go flights on Friday?", and check: "Go is typing..." shows, Go's ✅ lands, Go's reply shows as Go with its card, and its buttons answer with a toast or open a tab. Report a screenshot to the conductor.

---
## Interface notes for the conductor

P0 changes no shared name in master §6. These are the points other plans should know, and two small asks.

1. **P1's end-to-end tests use `@go/sim`.** Add `"@go/sim": "workspace:*"` to `apps/brain`'s devDependencies and drive Go with `new FakeServer({ goUrl, secret })`, `start()`, `createTrip(goaFreshTrip())`, `say()`, `tap()`, `vote()`, `confirmMandate()`, `askGo()`, `waitFor()`. For master §10 line 1 (a reconnect mid-turn), `reconnect({ downMs: 1_100 })` drops the socket and dials again signed fresh, keeping every trip, write and event; assert on `fake.writes` (`applied` marks the arrival that changed the trip: done once is one applied arrival per `request_id`) and `fake.countWrites(request_id)` (every arrival, repeats included). `fake.requests` lists every request and `typing` notification Go sent, in order, with its arrival time, which P1's typing checks and P3's bench use for "time to typing". `reconnect` and the typing-in-`requests` check were added for P1 Task 18 and Task 16.
2. **`trip.created` is always change 1 in the sim**, also for the mid-planning `GOA_SNAPSHOT` (whose own `seq` is 113): the sim restarts the count, so P1's gap logic sees no gap. Use `goaFreshTrip()` for a trip from scratch.
3. **The sim's `mentions_go` rule is its own** (`@Go` in any case, the word `Go` with a capital G, or a reply to Go). The real Server decides this its own way; P1 should rely only on the flag, and tests on `@Go`.
4. **Decisions on the guide's open points, which P1 should match:** a repeated `tap_id` gets its first answer back (master §6.3 `TapRouter` already says this); an unknown event type's `event_id` is remembered, so its repeat answers `duplicate: true`.
5. **Spend approvals in the sim are signed with the contract's TEST key.** P5's vault tests can set their public key to `TEST_SPEND_PUBLIC_KEY_PEM` from `@go/sim`.
6. **Root `.dockerignore`** is created by P0 (Task 5). P1's `apps/brain` Dockerfile can rely on it.
7. **Ask: fix the guide's reference client.** The TypeScript `GoSocket` in `docs/guide/02-the-socket.md` answers a handler that returns nothing with a frame that has no `result`, and crashes on a frame that is JSON but not an object. `packages/sim/src/server-socket.ts` fixes both. The code block has no `<!-- schema -->` marker, so updating it to the fixed version (or pointing to the file) does not touch the contract's checks. P0 does not edit the guide; Keshav decides.
8. **Ask: Keshav's OK for the Railway project `go`** (master §4) is needed before Task 5 Step 5, and Keshav sends the handover message and the one-time link himself.

## Assumptions

Where the research notes say something is unknown, this plan assumes the following. Each is checked by CI or by a named step.

- **The fake Go's URL** is the Railway domain made in Task 5 Step 5 (`railway domain`); no URL existed before.
- **Railway CLI flags** (`railway add --service`, `railway variables --set ... --skip-deploys`, `railway variables --kv`, `railway domain`) are the CLI's current ones; Task 5 Step 5 says to use the dashboard with the same names if a flag differs.
- **zod 4.3.6** exposes `Event.options` and each literal's `.value` (used for `KNOWN_EVENT_TYPES` in Task 3). If the build disagrees, CI shows it in Task 3.
- **`ws` 8.18** supports the client option `autoPong: false` (used only in Task 3's silent-socket test).
- **Node 22's global `fetch`** is used in the smoke check and two tests.
- **pnpm 10.29.1 from npm** is used in the Dockerfile instead of corepack, to avoid corepack's key checks in the build.

---

## Self-review

**1. Spec coverage**

| What this plan owns | Task |
|---|---|
| Spec §3, the door rules the fake Go mirrors: signature checked before the upgrade and accepted once, answers within the limits, `send_event` accepted before any thinking with unknown types first, each `event_id` once, Go's requests resent with the same id, ping 20 s, close after 40 s | 3, 4 |
| Spec §17 and §18: the fake Go for the other teams speaks the real socket from Monday | 3, 4, 5 |
| Master §2 G0: deployed, connected by the Server team, URL and secret handed over | 5 (Steps 5 to 7) |
| Master §2: the simulator ready for P1's end-to-end tests (Tue 10:00) | 6, 7, 8, 9 |
| Master §6.1: `packages/sim` and `apps/fake-go` | 1, 3 |
| Master §9: `DEMO_ROOM=sim`, the dev room draws every card | 10 |
| Master §10 line 1: a reconnect mid-request, done once, counted per `request_id` | 1, 3, 6, 9 |
| Guide 02: the reference client (`GoSocket`), fixed | 1 |
| Guide 04: the Server's rules for all 18 of Go's methods, the second change on `close_vote` and `add_booking`, `read_messages` paging under 1 MB | 6, 7, 8, 9 |
| Guide 05: fixed answers for `card_tap`, `catch_up`, the people requests, `vault_link` | 4 |
| Guide 06: Go cards valid; all 13 kinds drawn | 4, 10 |
| Guide 08: the spend check order, approvals signed with the test key, cancel safe to repeat | 8 |
| Guide 10: every promise of "The fake Go", quoted | 3, 4 |
| Brief item 3: CI through `pnpm -r test`, packages in the workspace, lockfile updated | 1, 3 |
| Brief item 4: the smoke script and the handover message | 5 |

**2. Placeholder scan.** No "TBD", "TODO", "similar to Task", "add error handling" or "write tests for the above". Every code step has complete code; every test step has complete tests with real assertions. The only angle-bracket values are things that exist only after deploy (`<the fake Go's domain>`, the token) in the deploy steps, README and handover message.

**3. Name consistency.** Names consumed from `@go/contract` match `packages/contract/src` exactly (`parseParams`, `signRequest`, `verifyRequest`, `SIGNATURE_HEADER`, `SOCKET_PATH`, `PING_INTERVAL_SECONDS`, `IDLE_CLOSE_SECONDS`, `RECONNECT_BACKOFF_SECONDS`, `MAX_FRAME_BYTES`, `MAX_SKEW_SECONDS`, `CONTRACT_VERSION`, `TO_GO`, `Event`, `EventAccepted`, `CardActionResult`, `TripSnapshot`, `Card`, `Message`, `signSpendApproval`, `verifySpendApproval`, `MAX_APPROVAL_TTL_SECONDS`, `Health`, `ErrorBody`, `PostMessage`). Names defined here are used the same way in every task: `GoSocket`, `SocketCallError`, `SocketTimeoutError`, `Handler`, `goaFreshTrip`, `GOA_SNAPSHOT`, `GOA_SEED_CHAT`, `GOA_PEOPLE`, `TEST_SPEND_PRIVATE_KEY_PEM`, `TEST_SPEND_PUBLIC_KEY_PEM`, `TripState`, `Change`, `fail`, `FakeServer`, `socketUrl`, `serveDevRoom`, `roomState`, `buildFakeGo`, `Behaviour`, `Link`, `fakeGoBehaviour`, `fakeCard`, `runSmoke`. P0 consumes nothing from master §6.3 (it never imports `apps/brain`).

**4. Review Focus, each with its test**

| Review Focus line | Test |
|---|---|
| 1. The socket drops while a request waits | Task 1 "sends an unanswered request again after a reconnect, with the same id"; Task 3 "go again on the next socket, with the same id"; Task 6 "does a write once per request_id"; Task 9 "does each write once per request_id: both arrivals are counted, one is applied" and "reconnects on a new socket signed fresh, keeps the trip and the write log, and sends a waiting event again with its event_id" |
| 2. A signature used twice, or signed without the query | Task 1 "signs every connect fresh, with the query string in the target"; Task 3 "accepts a signature once...", "needs the query string signed...", "refuses a missing, malformed, stale or wrong signature" |
| 3. Unknown event types, broken events, repeated event_ids | Task 3 "accepts an event type it does not know before checking anything else", "refuses a broken event of a known type with 422 invalid", "does each event once"; Task 4 "stays quiet for repeats..." |
| 4. Taps twice or from the wrong person | Task 4 "answers each tap_id once, and lets only the payer approve" |
| 5. Answers the other side would reject | Task 1 "answers through the handlers, with every error the contract names" (`{}` for a handler that returns nothing); Task 4 "makes every card kind valid" and "answers catch_up, the people requests and vault_link with answers that pass the contract"; Task 6 "pages in change order, shrinks a page to stay under the frame limit"; Task 8 "denies in the guide's order" |
