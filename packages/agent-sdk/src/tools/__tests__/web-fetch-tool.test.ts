import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as dns from 'node:dns';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { makeWebFetchTool, rawWebFetch } from '../web-fetch-tool.js';

const CFG = () => ({ serverUrl: 'https://srv.test', apiToken: 'tok', providerOrder: 'exa' });
// These tests exercise the provider-chain → classic-fetch raw fallback. The
// SSRF guard (default-ON) reroutes the raw fallback through safeFetchText
// (node:https), which is covered directly in web-fetch-guard.test.ts — disable
// it here so the raw fallback keeps using the stubbed global `fetch`. No
// assertion below is weakened; this only preserves the mechanism they target.
beforeEach(() => { vi.stubEnv('VESTRA_WEBFETCH_GUARD', '0'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('makeWebFetchTool (provider chain → raw fallback)', () => {
  it('uses exa /contents (primary) when available', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [{ url: 'https://a.com', text: 'EXA BODY' }], statuses: [{ id: 'https://a.com', status: 'success' }] }), { status: 200 })));
    const out = await makeWebFetchTool('t', CFG).execute({ url: 'https://a.com' }, { toolCallId: 'c' });
    expect(String(out)).toContain('EXA BODY');
  });

  it('falls back to raw fetch when exa hard-fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('err', { status: 500 }))  // exa /contents fails
      .mockResolvedValueOnce(new Response('<html><body><p>RAW</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } })); // raw fetch
    vi.stubGlobal('fetch', fetchMock);
    const out = await makeWebFetchTool('t', CFG).execute({ url: 'https://a.com' }, { toolCallId: 'c' });
    expect(String(out)).toContain('RAW');
    expect(fetchMock).toHaveBeenCalledTimes(2); // exa /contents + raw fetch, no second provider
  });

  it('on Exa 2xx-empty content, drops to raw fetch', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [], statuses: [{ id: 'https://a.com', status: 'error', error: { tag: 'CRAWL_NOT_FOUND' } }] }), { status: 200 })) // exa /contents: 2xx, empty
      .mockResolvedValueOnce(new Response('<html><body><p>RAW ONLY</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } })); // raw fetch
    vi.stubGlobal('fetch', fetchMock);
    const out = await makeWebFetchTool('t', CFG).execute({ url: 'https://a.com' }, { toolCallId: 'c' });
    expect(String(out)).toContain('RAW ONLY');
    expect(fetchMock).toHaveBeenCalledTimes(2); // exa /contents + raw fetch
  });
});

// Guard-ON (production default) wiring: rawWebFetch drives safeFetchText through
// node:https, which we mock via vi.spyOn(https, 'request') — the default requestFn
// param resolves https.request per call, so the spy is picked up. DNS is stubbed
// public so assertPublicHost admits the host.
describe('rawWebFetch (guard-ON default production path)', () => {
  beforeEach(() => vi.stubEnv('VESTRA_WEBFETCH_GUARD', '1'));

  it('fetches HTML, emits the "Fetched <url>" header + clipped readable text', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    vi.spyOn(https, 'request').mockImplementation(((_url: string, _options: unknown, cb: (res: unknown) => void) => {
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
      req.destroy = () => {};
      req.end = () => {
        const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; destroy: () => void };
        res.statusCode = 200;
        res.headers = { 'content-type': 'text/html' };
        res.destroy = () => {};
        cb(res);
        queueMicrotask(() => {
          res.emit('data', Buffer.from('<html><body><p>ON PATH BODY</p></body></html>', 'utf8'));
          res.emit('end');
        });
      };
      return req;
    }) as never);
    const out = await rawWebFetch('https://a.com', '');
    expect(out.startsWith('Fetched https://a.com')).toBe(true);
    expect(out).toContain('ON PATH BODY');
    expect(out).not.toContain('<p>'); // HTML was stripped to readable text
  });

  it('surfaces a transport error as "WebFetch error: <msg> for <url>" (no unhandled throw)', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    vi.spyOn(https, 'request').mockImplementation(((_url: string, _options: unknown, _cb: (res: unknown) => void) => {
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
      req.destroy = () => {};
      req.end = () => { queueMicrotask(() => req.emit('error', new Error('socket hang up'))); };
      return req;
    }) as never);
    const out = await rawWebFetch('https://a.com', '');
    expect(out).toBe('WebFetch error: socket hang up for https://a.com');
  });
});
