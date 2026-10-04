/**
 * L1 review fix 2 — a cancel reaches the web tools' I/O. An early-started call is cancelled
 * through its own signal (a failed or aborted stream, a different call under its id), and a
 * turn's Stop aborts every call's signal; WebSearch and WebFetch used to ignore it, so the
 * request ran out its own timeout. Now the call's signal reaches the Exa proxy request, the
 * SSRF-safe fetch (the default path) and the plain fetch.
 *
 * Revert proof: drop the signal from any of the three and its case hangs until the test's
 * own bound and fails (`settled` stays false), or its captured request signal never aborts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as dns from 'node:dns';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { makeWebSearchTool } from '../web-search-tool.js';
import { makeWebFetchTool, makeRawWebFetchTool } from '../web-fetch-tool.js';
import { safeFetchText } from '../web-fetch-guard.js';

const CFG = () => ({ serverUrl: 'https://srv.test', apiToken: 'tok', providerOrder: 'exa' });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.VESTRA_WEBFETCH_GUARD;
});

/** A fetch that never answers, except by rejecting when its request signal aborts. */
function hangingFetch(): { fetch: ReturnType<typeof vi.fn>; signals: AbortSignal[] } {
  const signals: AbortSignal[] = [];
  const fetch = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
    const signal = init?.signal;
    if (signal) signals.push(signal);
    return new Promise<Response>((_, reject) => {
      signal?.addEventListener('abort', () => {
        const err = new Error('This operation was aborted');
        err.name = 'AbortError';
        reject(err);
      }, { once: true });
    });
  });
  return { fetch, signals };
}

/** Resolve `p`, or report it still pending after `ms` real milliseconds. */
async function settlesWithin(p: unknown, ms = 2_000): Promise<{ settled: boolean; value?: unknown }> {
  return Promise.race([
    Promise.resolve(p).then((value) => ({ settled: true, value })),
    new Promise<{ settled: boolean }>((r) => setTimeout(() => r({ settled: false }), ms)),
  ]);
}

describe("cancel reaches the web tools' requests", () => {
  it("cancel: WebSearch's provider request ends with the call's signal", async () => {
    const { fetch, signals } = hangingFetch();
    vi.stubGlobal('fetch', fetch);
    const ac = new AbortController();
    const p = makeWebSearchTool('t', CFG, () => {}).execute({ query: 'q' }, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    const res = await settlesWithin(p);
    expect(res.settled).toBe(true);
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(true);
  });

  it('cancel: WebFetch: the provider request and the SSRF-safe fallback both end with the signal', async () => {
    const { fetch, signals } = hangingFetch();
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    const request = vi.spyOn(https, 'request');
    const ac = new AbortController();
    const p = makeWebFetchTool('t', CFG, () => {}).execute({ url: 'https://a.example' }, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    const res = await settlesWithin(p);
    expect(res.settled).toBe(true);
    expect(signals[0].aborted).toBe(true);
    // The raw fallback saw the aborted signal before it ever opened a socket.
    expect(request).not.toHaveBeenCalled();
    expect(String(res.value)).toMatch(/^WebFetch error: .* for https:\/\/a\.example$/);
  });

  it('cancel: the plain fetch (guard off) ends with the signal and says it was aborted', async () => {
    process.env.VESTRA_WEBFETCH_GUARD = '0';
    const { fetch, signals } = hangingFetch();
    vi.stubGlobal('fetch', fetch);
    const ac = new AbortController();
    const p = makeRawWebFetchTool().execute({ url: 'https://b.example' }, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    const res = await settlesWithin(p);
    expect(res.settled).toBe(true);
    expect(signals[0].aborted).toBe(true);
    expect(res.value).toBe('WebFetch error: aborted for https://b.example');
  });

  it('cancel: safeFetchText hands the signal to the request and refuses to start once aborted', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    let seen: AbortSignal | undefined;
    const requestFn = (_url: string, options: { signal?: AbortSignal }, cb: (res: unknown) => void) => {
      seen = options.signal;
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
      req.destroy = () => {};
      req.end = () => {
        const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; destroy: () => void };
        res.statusCode = 200; res.headers = { 'content-type': 'text/plain' }; res.destroy = () => {};
        cb(res);
        queueMicrotask(() => { res.emit('data', Buffer.from('OK')); res.emit('end'); });
      };
      return req;
    };
    const ac = new AbortController();
    await safeFetchText('https://c.example', { maxBytes: 100, timeoutMs: 1000, signal: ac.signal }, requestFn as never);
    expect(seen).toBe(ac.signal);
    ac.abort();
    await expect(safeFetchText('https://c.example', { maxBytes: 100, timeoutMs: 1000, signal: ac.signal }, requestFn as never))
      .rejects.toThrow();
  });
});
