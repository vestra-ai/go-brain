/**
 * Go's door to Vestra /v1. Requests spread round a pool of API keys; a live event stream goes to the key with the
 * fewest open, at most 20 each. The admin key is used only where /v1 asks for it (creating and changing users).
 * A 429 rests that key for its Retry-After and the request moves to another key; a write is sent again only when it
 * carries an idempotency key. Errors arrive as V1Error with /v1's own code: callers branch on the code.
 */
import { parseSseFrames, type SseFrame } from './sse.js';

export class V1Error extends Error {
  /** detail: the rest of /v1's error object, such as a browser fetch's partial result on a 504; null when there is none. */
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfterMs: number | null = null, readonly detail: Record<string, unknown> | null = null) {
    super(message);
    this.name = 'V1Error';
  }
}

export type V1Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface V1CallOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  idempotencyKey?: string;
  admin?: boolean;
  signal?: AbortSignal;
}
export interface V1Stream { keyIndex: number; frames: AsyncGenerator<SseFrame>; close(): void }
export interface V1Client {
  call<T>(method: V1Method, path: string, opts?: V1CallOptions): Promise<T>;
  bytes(path: string, opts?: { signal?: AbortSignal }): Promise<{ bytes: Uint8Array; contentType: string }>;
  /** lastEventId null starts from the stream's beginning (after=0); a number resumes after it (Last-Event-ID). */
  stream(path: string, opts: { lastEventId: number | null; signal?: AbortSignal; quietMs?: number }): Promise<V1Stream>;
  openStreams(): number[];
}
export interface V1ClientOptions {
  baseUrl: string;
  keys: string[];
  adminKey?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  maxStreamsPerKey?: number;
  /** The longest Go waits out a 429 before giving up. 5 s: quick tools answer in seconds. */
  maxWaitMs?: number;
}

export const MAX_STREAMS_PER_KEY = 20;
/** /v1 pings every 15 s; a stream with nothing for this long is dead. */
export const STREAM_QUIET_MS = 45_000;
const READ_AGAIN = new Set([502, 503, 504]);
const MAX_TRIES = 4;

function retryAfterMs(res: Response): number | null {
  const s = Number(res.headers.get('retry-after'));
  return Number.isFinite(s) && s > 0 ? Math.min(s, 60) * 1000 : null;
}

async function errorOf(res: Response, retry: number | null = null): Promise<V1Error> {
  let code = `http_${res.status}`;
  let message = `Vestra answered HTTP ${res.status}.`;
  let detail: Record<string, unknown> | null = null;
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
    if (typeof body.error?.code === 'string') code = body.error.code;
    if (typeof body.error?.message === 'string') message = body.error.message;
    if (body.error && typeof body.error === 'object') detail = body.error as Record<string, unknown>;
  } catch {
    // not a /v1 error body
  }
  return new V1Error(res.status, code, message, retry, detail);
}

interface ChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
  cancel(): Promise<void>;
}

async function readWithin(reader: ChunkReader, ms: number): Promise<{ done: boolean; value?: Uint8Array | undefined }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const quiet = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new V1Error(0, 'stream_quiet', `Nothing came on the stream for ${ms / 1000} s.`)), ms);
    // Never keeps Go's process alive; the follower's stopper aborts the stream itself.
    timer.unref();
  });
  try {
    return await Promise.race([reader.read(), quiet]);
  } finally {
    clearTimeout(timer);
  }
}

async function* readFrames(body: NonNullable<Response['body']>, quietMs: number, release: () => void): AsyncGenerator<SseFrame> {
  const reader: ChunkReader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await readWithin(reader, quietMs);
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = parseSseFrames(buffer);
      buffer = rest;
      for (const f of frames) yield f;
    }
  } finally {
    release();
    await reader.cancel().catch(() => undefined);
  }
}

export function createV1Client(o: V1ClientOptions): V1Client {
  if (o.keys.length === 0) throw new Error('VESTRA_API_KEYS is empty');
  const doFetch = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref()));
  const nowMs = o.nowMs ?? Date.now;
  const maxStreams = o.maxStreamsPerKey ?? MAX_STREAMS_PER_KEY;
  const maxWait = o.maxWaitMs ?? 5_000;
  const base = o.baseUrl.replace(/\/+$/, '');
  const restUntil = o.keys.map(() => 0);
  const streamsFullUntil = o.keys.map(() => 0);
  const open = o.keys.map(() => 0);
  let next = 0;

  const urlOf = (path: string, query?: V1CallOptions['query']): string => {
    const u = new URL(base + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  };

  /** The next key round the pool that is not resting. */
  const pickKey = (): number | null => {
    for (let i = 0; i < o.keys.length; i += 1) {
      const k = (next + i) % o.keys.length;
      if (restUntil[k]! <= nowMs()) {
        next = (k + 1) % o.keys.length;
        return k;
      }
    }
    return null;
  };

  const mayResend = (method: V1Method, opts: V1CallOptions): boolean => method === 'GET' || opts.idempotencyKey !== undefined;

  async function send(method: V1Method, path: string, opts: V1CallOptions, accept: string, attempt = 0): Promise<Response> {
    const admin = opts.admin === true;
    if (admin && !o.adminKey) throw new V1Error(0, 'admin_key_missing', 'VESTRA_ADMIN_KEY is not set.');
    const k = admin ? -1 : pickKey();
    if (k === null) {
      const wait = Math.max(0, Math.min(...restUntil) - nowMs());
      if (wait > maxWait || attempt >= MAX_TRIES) throw new V1Error(429, 'rate_limited', 'Every /v1 key is resting.', wait);
      await sleep(wait);
      return send(method, path, opts, accept, attempt + 1);
    }
    const headers: Record<string, string> = { authorization: `Bearer ${admin ? o.adminKey! : o.keys[k]!}`, accept };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
    let res: Response;
    try {
      res = await doFetch(urlOf(path, opts.query), {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      if (mayResend(method, opts) && attempt < 2) {
        await sleep(500 * (attempt + 1));
        return send(method, path, opts, accept, attempt + 1);
      }
      throw new V1Error(0, 'unreachable', `Vestra did not answer: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.ok) return res;
    if (res.status === 429) {
      const wait = retryAfterMs(res) ?? 1_000;
      const err = await errorOf(res, wait);
      if (attempt >= MAX_TRIES) throw err;
      if (admin) {
        if (wait > maxWait) throw err;
        await sleep(wait);
      } else {
        restUntil[k] = nowMs() + wait;
      }
      return send(method, path, opts, accept, attempt + 1);
    }
    const err = await errorOf(res);
    if (res.status === 409 && (err.code === 'idempotency_in_progress' || err.code === 'conversation_busy') && attempt < MAX_TRIES - 1) {
      await sleep(1_000 * (attempt + 1));
      return send(method, path, opts, accept, attempt + 1);
    }
    if (READ_AGAIN.has(res.status) && mayResend(method, opts) && attempt < 2) {
      await sleep(500 * (attempt + 1));
      return send(method, path, opts, accept, attempt + 1);
    }
    throw err;
  }

  return {
    async call<T>(method: V1Method, path: string, opts: V1CallOptions = {}): Promise<T> {
      const res = await send(method, path, opts, 'application/json');
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    },

    async bytes(path, opts = {}) {
      const res = await send('GET', path, opts, '*/*');
      return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
    },

    async stream(path, so) {
      const order = o.keys
        .map((_, i) => i)
        .filter((i) => open[i]! < maxStreams && streamsFullUntil[i]! <= nowMs() && restUntil[i]! <= nowMs())
        .sort((a, b) => open[a]! - open[b]!);
      for (const k of order) {
        const controller = new AbortController();
        const stop = () => controller.abort();
        so.signal?.addEventListener('abort', stop, { once: true });
        const headers: Record<string, string> = { authorization: `Bearer ${o.keys[k]!}`, accept: 'text/event-stream' };
        if (so.lastEventId !== null) headers['last-event-id'] = String(so.lastEventId);
        let res: Response;
        try {
          res = await doFetch(so.lastEventId === null ? urlOf(path, { after: 0 }) : urlOf(path), { headers, signal: controller.signal });
        } catch (err) {
          so.signal?.removeEventListener('abort', stop);
          if (so.signal?.aborted) throw err;
          throw new V1Error(0, 'unreachable', `The event stream did not open: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (res.status === 429) {
          so.signal?.removeEventListener('abort', stop);
          const err = await errorOf(res);
          if (err.code === 'too_many_streams') streamsFullUntil[k] = nowMs() + 60_000;
          else restUntil[k] = nowMs() + (retryAfterMs(res) ?? 1_000);
          continue;
        }
        if (!res.ok || !res.body) {
          so.signal?.removeEventListener('abort', stop);
          throw await errorOf(res);
        }
        open[k] = open[k]! + 1;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          open[k] = open[k]! - 1;
          so.signal?.removeEventListener('abort', stop);
          controller.abort();
        };
        return { keyIndex: k, frames: readFrames(res.body, so.quietMs ?? STREAM_QUIET_MS, release), close: release };
      }
      throw new V1Error(429, 'too_many_streams', 'Every /v1 key has its streams open.');
    },

    openStreams: () => [...open],
  };
}
