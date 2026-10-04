import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeWebSearchTool } from '../web-search-tool.js';
import { makeWebFetchTool } from '../web-fetch-tool.js';

/**
 * Per-task billing-dead circuit breaker (2026-08-20 incident: both search
 * vendors ran out of account credits and returned 402; the tool kept returning
 * "WebSearch error: ..." strings the model treated as transient, re-calling
 * WebSearch ~5x/sec for 45+ minutes). These tests pin the fix: an all-402
 * chain (Exa alone since Parallel was retired, so one Exa 402 is all-402)
 * trips a PER-TOOL-INSTANCE breaker (no module state — multi-session
 * process); post-trip WebSearch returns a terminal directive with zero provider
 * HTTP, WebFetch skips the paid chain and rides its raw-fetch tier. Non-402
 * failures keep today's behavior exactly.
 */

const CFG = () => ({ serverUrl: 'https://srv.test', apiToken: 'tok', providerOrder: 'exa' });
// Mint a FRESH Response per call — a Response body can only be consumed once.
const resp402 = () => new Response('{"error":"payment required"}', { status: 402 });
const rawHtml = () => new Response('<html><body><p>RAW BODY</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });

// Raw-fallback path must use the stubbed global fetch (SSRF guard covered in
// web-fetch-guard.test.ts) — same setup as web-fetch-tool.test.ts.
beforeEach(() => { vi.stubEnv('VESTRA_WEBFETCH_GUARD', '0'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('WebSearch billing-dead breaker', () => {
  it('an Exa 402 returns the terminal directive, not the raw error string', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => resp402()));
    const out = String(await makeWebSearchTool('t1', CFG).execute({ query: 'q' }, { toolCallId: 'c' }));
    expect(out).not.toContain('WebSearch error');
    expect(out).toMatch(/do not retry/i);
    expect(out).toMatch(/out of credits/i);
    expect(out).toMatch(/tell the user/i);
    // The livelock happened INSIDE a Researcher subagent: a subagent has no
    // user-visible surface of its own, so the directive must route the news
    // upward through its report instead of letting it grind on.
    expect(out).toMatch(/if you are a subagent/i);
    expect(out).toMatch(/finish|end your run/i);
  });

  it('after a trip, the next call short-circuits with the directive and zero provider HTTP', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => resp402());
    vi.stubGlobal('fetch', fetchMock);
    const t = makeWebSearchTool('t1', CFG);
    await t.execute({ query: 'q' }, { toolCallId: 'c1' }); // trips
    fetchMock.mockClear();
    const out = String(await t.execute({ query: 'q2' }, { toolCallId: 'c2' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out).toMatch(/do not retry/i);
  });

  it('a single Exa 402 trips at once: Exa is the only provider, so there is no fallback to wait for', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(resp402()); // exa /search: 402, once
    vi.stubGlobal('fetch', fetchMock);
    const t = makeWebSearchTool('t1', CFG);
    expect(String(await t.execute({ query: 'q' }, { toolCallId: 'c1' }))).toMatch(/do not retry/i);
    expect(String(await t.execute({ query: 'q2' }, { toolCallId: 'c2' }))).toMatch(/do not retry/i);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the second call never reached a provider
  });

  it('non-402 hard failures keep the legacy "WebSearch error:" string and never trip (pin)', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('err', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const t = makeWebSearchTool('t1', CFG);
    const out = String(await t.execute({ query: 'q' }, { toolCallId: 'c1' }));
    expect(out).toMatch(/^WebSearch error: /);
    fetchMock.mockClear();
    await t.execute({ query: 'q2' }, { toolCallId: 'c2' });
    expect(fetchMock).toHaveBeenCalled(); // still trying providers on the next call
  });

  it('two tool instances do not share breaker state', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => resp402());
    vi.stubGlobal('fetch', fetchMock);
    const a = makeWebSearchTool('task-a', CFG);
    const b = makeWebSearchTool('task-b', CFG);
    await a.execute({ query: 'q' }, { toolCallId: 'c1' }); // trips a
    expect(String(await a.execute({ query: 'q' }, { toolCallId: 'c2' }))).toMatch(/do not retry/i);
    fetchMock.mockClear();
    await b.execute({ query: 'q' }, { toolCallId: 'c3' }); // b's breaker is its own
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('WebFetch billing-dead breaker (provider chain only; raw tier stays live)', () => {
  it('an Exa 402 trips; later calls skip provider HTTP and go straight to raw fetch', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(resp402())   // exa /contents: 402
      .mockResolvedValueOnce(rawHtml())   // raw fetch still serves the first call
      .mockResolvedValueOnce(rawHtml());  // second call: raw ONLY
    vi.stubGlobal('fetch', fetchMock);
    const t = makeWebFetchTool('t1', CFG);
    expect(String(await t.execute({ url: 'https://a.com' }, { toolCallId: 'c1' }))).toContain('RAW BODY');
    expect(String(await t.execute({ url: 'https://b.com' }, { toolCallId: 'c2' }))).toContain('RAW BODY');
    expect(fetchMock).toHaveBeenCalledTimes(3); // NOT 4 — no proxy call after the trip
    expect(fetchMock.mock.calls[2][0]).toBe('https://b.com'); // direct raw, no proxy
  });

  it('non-402 chain failures do not trip: the next call consults providers again (pin)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('err', { status: 500 }))  // exa /contents
      .mockResolvedValueOnce(rawHtml())                             // raw fallback
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ url: 'https://a.com', text: 'EXA BODY' }], statuses: [{ id: 'https://a.com', status: 'success' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const t = makeWebFetchTool('t1', CFG);
    expect(String(await t.execute({ url: 'https://a.com' }, { toolCallId: 'c1' }))).toContain('RAW BODY');
    expect(String(await t.execute({ url: 'https://a.com' }, { toolCallId: 'c2' }))).toContain('EXA BODY');
  });
});
