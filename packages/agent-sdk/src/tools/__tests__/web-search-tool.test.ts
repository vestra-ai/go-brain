import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeWebSearchTool } from '../web-search-tool.js';

const CFG = () => ({ serverUrl: 'https://srv.test', apiToken: 'tok', providerOrder: 'exa' });
afterEach(() => vi.restoreAllMocks());

describe('makeWebSearchTool (provider chain)', () => {
  it('returns canonical JSON from the primary provider (exa)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [{ url: 'https://a.com', title: 'A', highlights: ['snip'] }] }), { status: 200 })));
    const t = makeWebSearchTool('task-1', CFG);
    const parsed = JSON.parse(await t.execute({ query: 'q' }, { toolCallId: 'c' }) as string);
    expect(parsed.results[0].content[0]).toEqual({ title: 'A', url: 'https://a.com' });
    expect(parsed.results[0].excerpts).toEqual(['snip']);
  });

  it("an Exa hard failure returns 'WebSearch error: Exa 500…' (no fallback provider)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('err', { status: 500 })); // exa /search fails (hard)
    vi.stubGlobal('fetch', fetchMock);
    const out = String(await makeWebSearchTool('task-1', CFG).execute({ query: 'q' }, { toolCallId: 'c' }));
    expect(out).toMatch(/^WebSearch error: Exa 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns temporarily-unavailable when nothing is configured', async () => {
    const t = makeWebSearchTool('task-1', () => ({}));
    expect(String(await t.execute({ query: 'q' }, { toolCallId: 'c' }))).toMatch(/temporarily unavailable/i);
  });

  it('returns "no query" guard for empty query', async () => {
    const t = makeWebSearchTool('task-1', CFG);
    expect(String(await t.execute({ query: '  ' }, { toolCallId: 'c' }))).toMatch(/no query/i);
  });
});
