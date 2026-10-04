/// <reference path="./undici-internals.d.ts" />
/**
 * Warm connections (WARM_CONNECTIONS_V1, harness to nine L4).
 *
 * Two things, both in the HTTP layer under the transports:
 *
 * 1. ONE keep-alive pool per provider host, shared by the rounds of every session in
 *    the runner. The built-in fetch already pools, but it drops an idle connection
 *    after 4 s, and a tool call between two rounds routinely takes longer, so round two
 *    paid a fresh TCP + TLS handshake. Here an idle connection lives 30 s (a server's
 *    own `Keep-Alive: timeout=` hint still wins when shorter). The pool holds sockets,
 *    never request state, so sharing it across sessions is safe: this is the one piece
 *    of process state L4 adds, on purpose.
 * 2. A PREWARM at turn start: the turn head asks its transport to open a connection to
 *    the host the turn's requests will go to (TCP + TLS handshake, no request). The
 *    socket is parked until the pool asks for a new connection to that host, which is
 *    the turn's first request, so the handshake overlaps the prompt build instead of
 *    delaying the first token.
 *
 * Flag OFF: `sharedWarmPool()` is undefined, the provider clients get no `fetchOptions`
 * and the Gemini fetch init no `dispatcher`, so every request is byte-identical to today.
 *
 * A FROZEN BOX (staging 3 Oct, tasks 2e773676 and 97d0c6ce). Blaxel freezes the whole
 * container, timers included, so a pooled socket outlives its keep-alive across a freeze
 * while the far end and the network path forget it. The first request after the thaw rode
 * that dead socket: a black hole until the 180 s stream stall guard cut it (the turn sat on
 * "Working" for three minutes), or a reset and a retry. So the pool RENEWS: the dispatcher
 * every client holds is a stable handle over a replaceable Agent, and `renew()` (the
 * runner's thaw signal, and any connection-class failure: renewWarmConnections) hands new
 * requests and the prewarm a fresh Agent, retires parked sockets, and closes the old Agent
 * gracefully so a request in flight on it finishes. And a request that gets no response
 * headers within WARM_HEADERS_TIMEOUT_MS fails as a connection error instead of hanging, so a
 * dead socket the thaw renew missed costs a minute and a half, not undici's five minutes. The
 * renew is debounced (RENEW_DEBOUNCE_MS): one failure is classified at several sites, and each
 * used to retire a fresh Agent, including other sessions' parked prewarm sockets.
 */
import type { Socket } from 'node:net';
import type { ConnectionOptions } from 'node:tls';
import Agent from 'undici/lib/dispatcher/agent.js';
import Dispatcher from 'undici/lib/dispatcher/dispatcher.js';
import type { Dispatcher as UndiciDispatcher } from 'undici';
import buildConnector from 'undici/lib/core/connect.js';
import { warmConnectionsEnabled } from '../policy/feature-flags.js';

/** How long an idle pooled connection stays open between rounds. */
export const WARM_KEEP_ALIVE_MS = 30_000;
/** How long a prewarmed connection waits for its first request before it is closed. */
export const PREWARM_TTL_MS = 20_000;
/** undici's own connect deadline, kept as-is. */
const CONNECT_TIMEOUT_MS = 10_000;
/**
 * How long a sent request waits for its response headers before it fails as a connection error.
 * A backstop for a dead socket the thaw renew missed, so generous: Anthropic and OpenAI Responses
 * send headers as the stream opens, but a Chat Completions lane (Fireworks, Baseten, xAI, DeepSeek)
 * often holds them through queueing and prefill, a Baseten deployment scaled to zero through a cold
 * start, and Gemini through long-context prefill. At 30 s (review of #4351) such a first byte failed
 * as network_error and the retry paid the queue and the prefill again.
 */
export const WARM_HEADERS_TIMEOUT_MS = 90_000;
/** Renews closer together than this are one: a single failure is classified at several sites. */
export const RENEW_DEBOUNCE_MS = 2_000;

/** The one `fetch` init key the pool adds. */
type WarmInit = Pick<RequestInit, 'dispatcher'>;

export interface WarmPool {
  /** Spread into a `fetch` init (or an SDK client's `fetchOptions`) to ride the pool. */
  readonly fetchInit: Required<WarmInit>;
  /** Open one connection to `baseUrl`'s host unless one is already free or warming. Never rejects. */
  prewarm(baseUrl: string): Promise<void>;
  /** Retire every pooled and parked connection: new requests and the prewarm open fresh ones. */
  renew(): void;
  close(): Promise<void>;
}

export interface WarmPoolOptions {
  /** Extra trust for every TLS connection (tests pass the local server's CA). */
  tls?: Pick<ConnectionOptions, 'ca'>;
  prewarmTtlMs?: number;
  headersTimeoutMs?: number;
}

type PoolAgent = InstanceType<typeof Agent>;

/**
 * The dispatcher every client holds: a stable handle whose requests go to whichever Agent is
 * current, so a renew reaches clients that were built (and memoized) long before it.
 */
class RenewableDispatcher extends Dispatcher {
  constructor(public agent: PoolAgent) {
    super();
  }
  override dispatch(options: UndiciDispatcher.DispatchOptions, handler: UndiciDispatcher.DispatchHandler): boolean {
    return this.agent.dispatch(options, handler);
  }
}

/** A URL hostname as a socket wants it: an IPv6 literal without its brackets. */
function unbracket(hostname: string): string {
  return hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
}

/** `https://host:443`: the same key for the pool's connect calls and for a prewarm,
 *  whichever form (bracketed or not) the hostname arrives in. */
function hostKey(protocol: string, hostname: string, port: string): string {
  return `${protocol}//${unbracket(hostname)}:${port || (protocol === 'https:' ? '443' : '80')}`;
}

export function createWarmPool(opts: WarmPoolOptions = {}): WarmPool {
  const connect = buildConnector({ ...opts.tls, timeout: CONNECT_TIMEOUT_MS });
  const ttlMs = opts.prewarmTtlMs ?? PREWARM_TTL_MS;
  /** At most one prewarmed socket per host, parked until the pool claims it. */
  const parked = new Map<string, { socket: Socket; unpark: () => void }>();
  const warming = new Set<string>();
  let closed = false;

  const makeAgent = (): PoolAgent => new Agent({
    keepAliveTimeout: WARM_KEEP_ALIVE_MS,
    headersTimeout: opts.headersTimeoutMs ?? WARM_HEADERS_TIMEOUT_MS,
    connect: (o, callback) => {
      const key = hostKey(o.protocol, o.hostname, o.port);
      const warm = parked.get(key);
      if (warm) {
        parked.delete(key);
        warm.unpark();
        // Asynchronously, as the real connector does: undici re-enters its dispatch
        // loop from this callback, and a synchronous call leaves the request unwritten.
        if (!warm.socket.destroyed) return void process.nextTick(callback, null, warm.socket);
      }
      connect(o, callback);
    },
  });
  const dispatcher = new RenewableDispatcher(makeAgent());

  /** Park a fresh socket. Anything it reads before a request (data, EOF), an error,
   *  a close or the time to live retires it, so a stale socket is never handed over. */
  function park(key: string, socket: Socket): void {
    const timer = setTimeout(retire, ttlMs);
    timer.unref();
    function unpark(): void {
      clearTimeout(timer);
      socket.off('readable', retire).off('close', retire).off('error', retire);
    }
    function retire(): void {
      if (parked.get(key)?.socket === socket) parked.delete(key);
      unpark();
      socket.destroy();
    }
    socket.on('readable', retire).on('close', retire).on('error', retire);
    parked.set(key, { socket, unpark });
  }

  async function prewarm(baseUrl: string): Promise<void> {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      return;
    }
    if (closed || (url.protocol !== 'https:' && url.protocol !== 'http:')) return;
    const hostname = unbracket(url.hostname);
    const key = hostKey(url.protocol, url.hostname, url.port);
    const free = (dispatcher.agent.stats[url.origin] as { free?: number } | undefined)?.free ?? 0;
    if (parked.has(key) || warming.has(key) || free > 0) return;
    warming.add(key);
    try {
      const socket = await new Promise<Socket | null>((resolve) =>
        connect({ hostname, host: url.host, protocol: url.protocol, port: url.port }, (err, s) =>
          resolve(err ? null : s),
        ),
      );
      if (!socket) return;
      if (closed || parked.has(key)) socket.destroy();
      else park(key, socket);
    } finally {
      warming.delete(key);
    }
  }

  function retireParked(): void {
    for (const { socket, unpark } of parked.values()) {
      unpark();
      socket.destroy();
    }
    parked.clear();
  }

  return {
    fetchInit: { dispatcher: dispatcher as unknown as NonNullable<WarmInit['dispatcher']> },
    prewarm,
    renew() {
      if (closed) return;
      retireParked();
      const old = dispatcher.agent;
      dispatcher.agent = makeAgent();
      // Graceful: a request in flight on the old Agent finishes; its idle sockets close now.
      void old.close().catch(() => {});
    },
    async close() {
      closed = true;
      retireParked();
      await dispatcher.agent.close();
    },
  };
}

/** The runner's one pool, built on first use while the flag is on. */
let shared: WarmPool | undefined;
/** When the shared pool was last renewed. */
let lastRenewAt = Number.NEGATIVE_INFINITY;

/** The shared pool, or undefined when WARM_CONNECTIONS_V1 is off. */
export function sharedWarmPool(): WarmPool | undefined {
  if (!warmConnectionsEnabled()) return undefined;
  return (shared ??= createWarmPool());
}

/**
 * The box thawed, or a request failed the way a dead connection does: retire every pooled and
 * parked connection so the next request connects fresh. A no-op when WARM_CONNECTIONS_V1 is off
 * (there is no pool) or before the pool was ever used, and within RENEW_DEBOUNCE_MS of the last
 * renew (the pool is already fresh: one failure reaches classifyError from several sites). True
 * when it renewed.
 */
export function renewWarmConnections(): boolean {
  if (!shared) return false;
  const now = Date.now();
  if (now - lastRenewAt < RENEW_DEBOUNCE_MS) return false;
  lastRenewAt = now;
  shared.renew();
  return true;
}

/** Spread into a provider SDK client's options: `{}` when off (today's options, key for key). */
export function warmClientOptions(): { fetchOptions?: WarmInit } {
  const pool = sharedWarmPool();
  return pool ? { fetchOptions: pool.fetchInit } : {};
}

/** Spread into a hand-rolled `fetch` init: `{}` when off. */
export function warmFetchInit(): WarmInit {
  return sharedWarmPool()?.fetchInit ?? {};
}

/**
 * A transport's `prewarm`: resolve the base URL its next request will use and open the
 * connection. The resolver runs only when the flag is on, and nothing here throws: a
 * missing key or an unreachable host just means the first request connects as today.
 */
export function prewarmBaseUrl(resolveBaseUrl: () => string | undefined): void {
  const pool = sharedWarmPool();
  if (!pool) return;
  let baseUrl: string | undefined;
  try {
    baseUrl = resolveBaseUrl();
  } catch {
    return;
  }
  if (baseUrl) void pool.prewarm(baseUrl);
}

/** Test seam: close and forget the shared pool. */
export async function resetSharedWarmPoolForTests(): Promise<void> {
  const pool = shared;
  shared = undefined;
  lastRenewAt = Number.NEGATIVE_INFINITY;
  await pool?.close();
}
