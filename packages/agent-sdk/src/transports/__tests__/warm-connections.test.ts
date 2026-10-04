/**
 * WARM_CONNECTIONS_V1 (harness to nine, L4): one keep-alive pool per provider host,
 * and a prewarm at turn start that opens the connection (TCP + TLS, no request)
 * before the turn's first request is built.
 *
 * Measured against a LOCAL TLS server that counts handshakes ('secureConnection'),
 * so a reverted prewarm or a pool that stops reusing shows up as an extra handshake.
 * The certificate is minted per run with `openssl`, never committed (a private key in
 * the repo, even a localhost one, is a finding in any security scan of it). Where
 * `openssl` is absent the TLS block is skipped and says why; the HTTP-level twin in
 * warm-connections.transports.test.ts still pins the prewarm without it.
 *
 * The frozen box (staging 3 Oct, tasks 2e773676 and 97d0c6ce): a pooled socket the far end
 * forgot across a freeze is BLACK-HOLED here (the server takes the request and never answers,
 * no reset), which is what made the first post-thaw request hang until the 180 s stall guard.
 * Revert proof: drop the renew and the post-renew round rides the dead socket and hangs; drop
 * the headers timeout and the un-renewed round hangs for undici's default five minutes; close
 * the old Agent hard and the stream in flight dies.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:https';
import type { TLSSocket } from 'node:tls';
import type { AddressInfo, Socket } from 'node:net';
import {
  createWarmPool,
  renewWarmConnections,
  resetSharedWarmPoolForTests,
  sharedWarmPool,
  RENEW_DEBOUNCE_MS,
  WARM_HEADERS_TIMEOUT_MS,
  type WarmPool,
} from '../warm-connections.js';

/**
 * Read at load: the module above has been imported and nothing in this file has called
 * `fetch` yet (the first built-in fetch installs Node's own dispatcher under symbol 1).
 */
const globalDispatchersAtLoad = ['undici.globalDispatcher.1', 'undici.globalDispatcher.2'].map(
  (name) => (globalThis as Record<symbol, unknown>)[Symbol.for(name)],
);

describe('warm connections: loading the pool touches no global', () => {
  it('warm connections: importing the module installs no global undici dispatcher (flag on or off)', () => {
    // undici's package root runs setGlobalDispatcher(new Agent()) on load, which would put
    // every built-in fetch in the runner on our pool. Only agent.js and connect.js may load.
    expect(globalDispatchersAtLoad).toEqual([undefined, undefined]);
  });
});

const hasOpenssl = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;

let dir: string;
let cert: Buffer;
let server: Server;
let base: string;
/** Every TLS handshake the server completed, in order. */
let handshakes: TLSSocket[] = [];
/** The socket each request arrived on, in order. */
let requestSockets: Socket[] = [];
/** Connections whose requests go nowhere: no answer, no reset (a socket forgotten across a freeze). */
let blackholed = new Set<Socket>();

const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const pools: WarmPool[] = [];
const pool = (opts: Parameters<typeof createWarmPool>[0] = {}): WarmPool => {
  const p = createWarmPool({ tls: { ca: cert }, ...opts });
  pools.push(p);
  return p;
};

/** One model round: a streamed POST read to the end, like a transport's SSE read. */
async function round(p: WarmPool, url = `${base}/v1/messages`): Promise<string> {
  const res = await fetch(url, { method: 'POST', body: '{"model":"m"}', ...p.fetchInit });
  return res.text();
}

describe.skipIf(!hasOpenssl)('warm connections: prewarm and pool (WARM_CONNECTIONS_V1; skipped without openssl, which mints the TLS certificate)', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'warm-conn-'));
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ], { stdio: 'ignore' });
    cert = readFileSync(join(dir, 'cert.pem'));
    server = createServer({ cert, key: readFileSync(join(dir, 'key.pem')) }, (req, res) => {
      requestSockets.push(req.socket);
      req.resume();
      req.on('end', () => {
        if (blackholed.has(req.socket)) return;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"delta":"hel"}\n\n');
        setTimeout(() => res.end('data: {"delta":"lo"}\n\ndata: [DONE]\n\n'), req.url === '/slow' ? 300 : 5);
      });
    });
    // No `Keep-Alive: timeout=` hint and no server-side idle close, so the client's own
    // idle timeout is what decides reuse (a hint would override it, as it does in prod).
    server.keepAliveTimeout = 0;
    server.on('secureConnection', (s: TLSSocket) => handshakes.push(s));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((p) => p.close()));
    server.closeAllConnections();
    handshakes = [];
    requestSockets = [];
    blackholed = new Set<Socket>();
  });

  it('warm connections: the first request of a turn rides the prewarmed connection (no second handshake)', async () => {
    const p = pool();
    await p.prewarm(base);
    await until(() => handshakes.length === 1);
    expect(requestSockets).toHaveLength(0); // TLS only: the prewarm sent no request

    expect(await round(p)).toContain('[DONE]');
    expect(handshakes).toHaveLength(1);
    expect(requestSockets[0]).toBe(handshakes[0]);
  });

  it('warm connections: a second round reuses the pooled connection', async () => {
    const p = pool();
    await p.prewarm(base);
    await round(p);
    await new Promise((r) => setTimeout(r, 30)); // the gap a tool call leaves between rounds
    await round(p);
    expect(handshakes).toHaveLength(1);
    expect(requestSockets).toHaveLength(2);
    expect(requestSockets[1]).toBe(requestSockets[0]);
  });

  it('warm connections: an idle connection outlives the built-in 4 s keep-alive (a slow tool between rounds)', async () => {
    const p = pool();
    await round(p);
    await new Promise((r) => setTimeout(r, 4_500));
    await round(p);
    expect(handshakes).toHaveLength(1);
    expect(requestSockets[1]).toBe(requestSockets[0]);
  }, 15_000);

  it('warm connections: prewarm opens nothing when the pool already holds a free connection', async () => {
    const p = pool();
    await round(p);
    await new Promise((r) => setTimeout(r, 30));
    await p.prewarm(base);
    await p.prewarm(base);
    await new Promise((r) => setTimeout(r, 30));
    expect(handshakes).toHaveLength(1);
  });

  it('warm connections: two prewarms at once open one connection', async () => {
    const p = pool();
    await Promise.all([p.prewarm(base), p.prewarm(base), p.prewarm(`${base}/v1`)]);
    await new Promise((r) => setTimeout(r, 30));
    expect(handshakes).toHaveLength(1);
  });

  it('warm connections: a prewarmed connection the server closed is never handed to a request', async () => {
    const p = pool();
    await p.prewarm(base);
    await until(() => handshakes.length === 1);
    handshakes[0].destroy();
    await new Promise((r) => setTimeout(r, 50));

    expect(await round(p)).toContain('[DONE]');
    expect(handshakes).toHaveLength(2);
    expect(requestSockets[0]).toBe(handshakes[1]);
  });

  it('warm connections: an unclaimed prewarmed connection is closed after its time to live', async () => {
    const p = pool({ prewarmTtlMs: 40 });
    await p.prewarm(base);
    await until(() => handshakes.length === 1);
    await until(() => handshakes[0].destroyed, 1000);
    await round(p);
    expect(handshakes).toHaveLength(2);
  });

  it('warm connections: prewarm never rejects, whatever the host', async () => {
    const p = pool();
    await expect(p.prewarm('https://127.0.0.1:1')).resolves.toBeUndefined();
    await expect(p.prewarm('not a url')).resolves.toBeUndefined();
    await expect(p.prewarm('file:///etc/hosts')).resolves.toBeUndefined();
    expect(await round(p)).toContain('[DONE]');
  });

  it('warm connections: an aborted stream does not poison the pool', async () => {
    const p = pool();
    await p.prewarm(base);
    const ac = new AbortController();
    const res = await fetch(`${base}/v1/messages`, { method: 'POST', body: '{}', signal: ac.signal, ...p.fetchInit });
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    await expect(reader.read()).rejects.toThrow();
    expect(await round(p)).toContain('[DONE]');
  });
  /** Settle within `ms` or fail: a round that rides a dead socket would otherwise hang the suite. */
  const within = <T>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms))]);

  it('warm connections: after a renew (a thaw), a pooled socket the far end forgot is never reused; the round connects fresh', async () => {
    const p = pool();
    await round(p);
    await new Promise((r) => setTimeout(r, 30));
    blackholed.add(requestSockets[0]!);
    p.renew();
    expect(await within(round(p), 3_000)).toContain('[DONE]');
    expect(handshakes).toHaveLength(2);
    expect(requestSockets[1]).not.toBe(requestSockets[0]);
  });

  it('warm connections: without a renew, a dead pooled socket fails within the headers timeout, not after minutes', async () => {
    const p = pool({ headersTimeoutMs: 300 });
    await round(p);
    await new Promise((r) => setTimeout(r, 30));
    blackholed.add(requestSockets[0]!);
    const t0 = Date.now();
    await expect(within(round(p), 3_000)).rejects.toThrow(/fetch failed|Headers Timeout|timeout/i);
    expect(Date.now() - t0).toBeLessThan(3_000);
    // The next round, after a renew, is fine.
    p.renew();
    expect(await within(round(p), 3_000)).toContain('[DONE]');
  });

  it('warm connections: a stream in flight when the pool renews finishes on its own connection', async () => {
    const p = pool();
    const res = await fetch(`${base}/slow`, { method: 'POST', body: '{}', ...p.fetchInit });
    const reader = res.body!.getReader();
    await reader.read();
    p.renew();
    let text = '';
    for (let r = await reader.read(); !r.done; r = await reader.read()) text += Buffer.from(r.value).toString();
    expect(text).toContain('[DONE]');
  });

  it('warm connections: a renew retires a parked prewarm socket; the next prewarm opens a fresh one, and the round rides it', async () => {
    const p = pool();
    await p.prewarm(base);
    await until(() => handshakes.length === 1);
    p.renew();
    await until(() => handshakes[0]!.destroyed, 1_000);
    await p.prewarm(base);
    await until(() => handshakes.length === 2);
    expect(await round(p)).toContain('[DONE]');
    expect(handshakes).toHaveLength(2);
    expect(requestSockets[0]).toBe(handshakes[1]);
  });
});

describe('renewWarmConnections: the runner-wide pool', () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    await resetSharedWarmPoolForTests();
  });

  it('a no-op (false) with WARM_CONNECTIONS_V1 off: there is no pool to renew', () => {
    vi.stubEnv('WARM_CONNECTIONS_V1', '');
    expect(sharedWarmPool()).toBeUndefined();
    expect(renewWarmConnections()).toBe(false);
  });

  it('with the flag on, renews the pool every client holds, keeping the same dispatcher handle', () => {
    vi.stubEnv('WARM_CONNECTIONS_V1', 'true');
    const pool = sharedWarmPool()!;
    const handle = pool.fetchInit.dispatcher;
    expect(renewWarmConnections()).toBe(true);
    expect(sharedWarmPool()).toBe(pool);
    expect(sharedWarmPool()!.fetchInit.dispatcher).toBe(handle);
  });

  // Review of #4351, L1: one failure reaches classifyError from several sites (the round engine,
  // the severed-stream retry, the turn decisions, compaction recovery, history heal, the harness),
  // and each renewed, retiring 2 to 4 fresh Agents and other sessions' parked prewarm sockets.
  it('one failure classified at several sites renews once; a renew after the debounce goes through', () => {
    vi.stubEnv('WARM_CONNECTIONS_V1', 'true');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-04T02:00:00Z'));
      const pool = sharedWarmPool()!;
      const renew = vi.spyOn(pool, 'renew');
      expect([renewWarmConnections(), renewWarmConnections(), renewWarmConnections(), renewWarmConnections()]).toEqual([true, false, false, false]);
      expect(renew).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + RENEW_DEBOUNCE_MS - 1);
      expect(renewWarmConnections()).toBe(false);
      vi.setSystemTime(Date.now() + 1);
      expect(renewWarmConnections()).toBe(true);
      expect(renew).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Review of #4351, M1 and L3: every test passes headersTimeoutMs, so dropping the default left
// undici's five minutes and nothing failed; and 30 s cut legitimate slow first bytes (a Chat
// Completions lane holding headers through queueing and prefill, a Baseten cold start, Gemini long
// context) into network_error retries that paid the prefill again.
describe('the headers timeout default', () => {
  it('a pool built without headersTimeoutMs waits WARM_HEADERS_TIMEOUT_MS (90 s) for response headers, before and after a renew', async () => {
    expect(WARM_HEADERS_TIMEOUT_MS).toBe(90_000);
    const pool = createWarmPool();
    const headersTimeout = (): number | undefined => {
      const agent = (pool.fetchInit.dispatcher as unknown as { agent: object }).agent;
      const key = Object.getOwnPropertySymbols(agent).find((sym) => sym.description === 'options');
      return key === undefined ? undefined : (agent as Record<symbol, { headersTimeout?: number }>)[key]?.headersTimeout;
    };
    try {
      expect(headersTimeout()).toBe(WARM_HEADERS_TIMEOUT_MS);
      pool.renew();
      expect(headersTimeout()).toBe(WARM_HEADERS_TIMEOUT_MS);
    } finally {
      await pool.close();
    }
  });
});
