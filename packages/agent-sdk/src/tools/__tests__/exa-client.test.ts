import { describe, it, expect, vi, afterEach } from 'vitest';
import { exaSearch, exaExtract, ExaUnconfigured, ExaHttpError } from '../exa-client.js';

const CFG = { serverUrl: 'https://srv.test', apiToken: 'tok' };
afterEach(() => vi.restoreAllMocks());

describe('exaSearch', () => {
  it('posts to the exa proxy and maps highlights→excerpts into canonical shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      requestId: 'r1',
      results: [{ id: 'i', url: 'https://a.com', title: 'A', publishedDate: '2025-01-01T00:00:00Z', highlights: ['snippet one'] }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await exaSearch({ query: 'q' }, 'task-1', CFG);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://srv.test/api/proxy/exa/search');
    expect((init.headers as Record<string,string>).Authorization).toBe('Bearer tok');
    expect((init.headers as Record<string,string>)['x-vestra-task-id']).toBe('task-1');
    const body = JSON.parse(init.body);
    expect(body.query).toBe('q');
    expect(body.contents.highlights).toBeTruthy();
    expect(out.results[0].content[0]).toEqual({ title: 'A', url: 'https://a.com' });
    expect(out.results[0].excerpts).toEqual(['snippet one']);
    expect(out.results[0].publish_date).toBe('2025-01-01T00:00:00Z');
    expect(out.durationSeconds).toBeNull();
  });
  it('maps allowed/blocked domains to includeDomains/excludeDomains', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await exaSearch({ query: 'q', allowed_domains: ['x.com'], blocked_domains: ['y.com'] }, 't', CFG);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.includeDomains).toEqual(['x.com']);
    expect(body.excludeDomains).toEqual(['y.com']);
  });
  it('sends type from cfg.searchType, default auto', async () => {
    // fresh Response per call — a Response body is single-use, and this test invokes exaSearch twice
    const fetchMock = vi.fn().mockImplementation(() => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await exaSearch({ query: 'q' }, 't', CFG);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).type).toBe('auto');
    await exaSearch({ query: 'q' }, 't', { ...CFG, searchType: 'fast' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).type).toBe('fast');
  });
  it('throws ExaUnconfigured when serverUrl/apiToken missing', async () => {
    await expect(exaSearch({ query: 'q' }, 't', {})).rejects.toBeInstanceOf(ExaUnconfigured);
  });
  it('throws ExaHttpError on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 429 })));
    await expect(exaSearch({ query: 'q' }, 't', CFG)).rejects.toThrow(/429/);
  });
  it('throws ExaHttpError on a 2xx non-JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })));
    await expect(exaSearch({ query: 'q' }, 't', CFG)).rejects.toBeInstanceOf(ExaHttpError);
  });
});

describe('exaExtract', () => {
  it('posts urls to /contents and returns text content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      results: [{ url: 'https://a.com', title: 'A', text: 'CLEAN BODY' }], statuses: [{ id: 'https://a.com', status: 'success' }],
    }), { status: 200 })));
    const out = await exaExtract({ url: 'https://a.com' }, 't', CFG);
    expect(out.content).toContain('CLEAN BODY');
    expect(out.url).toBe('https://a.com');
  });
  it('returns empty content when there is no usable result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [], statuses: [{ id: 'u', status: 'error', error: { tag: 'CRAWL_NOT_FOUND' } }] }), { status: 200 })));
    const out = await exaExtract({ url: 'https://a.com' }, 't', CFG);
    expect(out.content).toBe('');
  });
});
