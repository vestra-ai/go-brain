import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import type { z } from 'zod';
import { makeWebFetchTool, makeRawWebFetchTool, batchBudget } from '../web-fetch-tool.js';
import { webStoreDir, reapTaskWebContent } from '../web-content-store.js';

// Store-failure injection: pass-through to the real store unless `fail` is set.
// (vi.mock is hoisted — the flag object must come from vi.hoisted.)
const storeMock = vi.hoisted(() => ({ fail: false }));
vi.mock('../web-content-store.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../web-content-store.js')>();
  return {
    ...mod,
    truncateAndStoreWeb: (...args: Parameters<typeof mod.truncateAndStoreWeb>) =>
      storeMock.fail ? Promise.reject(new Error('disk full')) : mod.truncateAndStoreWeb(...args),
  };
});

const CFG = () => ({ serverUrl: 'https://srv.test', apiToken: 'tok', providerOrder: 'exa' });
const BIG = Array.from({ length: 3000 }, (_, i) => `docline-${i} ${'x'.repeat(30)}`).join('\n'); // ~120k chars
const exaResponse = (text: string, url = 'https://a.com') =>
  new Response(
    JSON.stringify({ results: [{ url, text }], statuses: [{ id: url, status: 'success' }] }),
    { status: 200 },
  );
const shape = (tool: { parameters: unknown }) => Object.keys((tool.parameters as z.ZodObject<z.ZodRawShape>).shape);

beforeEach(() => {
  storeMock.fail = false;
  vi.stubEnv('VESTRA_WEBFETCH_GUARD', '0');
});
// The store dir is REAL and shared with other test files running in parallel —
// clean up only this file's task ids, never rm the whole dir.
const MY_TASKS = ['taskOFF', 'taskON', 'taskSmall', 'taskBomb', 'taskFail', 'taskCap', 'taskCapOff', 'tb', 'tbig', 't'];
const myFiles = async (id: string) =>
  (await readdir(webStoreDir()).catch(() => [] as string[])).filter((f) => f.startsWith(`webfetch-${id}-`));
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const id of MY_TASKS) await reapTaskWebContent(id);
});

describe('flag OFF — byte-identical legacy clip', () => {
  beforeEach(() => vi.stubEnv('VESTRA_WEBFETCH_STORE', '0'));

  it('oversized page gets the legacy head-only slice, no file written', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(exaResponse(BIG)));
    const out = String(await makeWebFetchTool('taskOFF', CFG).execute({ url: 'https://a.com' }, { toolCallId: 'c' }));
    expect(out).toContain('…[truncated]');
    expect(out).not.toContain('Full text stored at');
    expect(out).toContain(BIG.slice(0, 100)); // head present
    expect(out).not.toContain('docline-2999'); // tail LOST (legacy behavior)
    expect(await myFiles('taskOFF')).toEqual([]); // nothing stored
  });

  it('schema has no urls param when flag OFF', () => {
    expect(shape(makeWebFetchTool('t', CFG))).toEqual(['url', 'prompt']);
  });
});

describe('flag ON (default) — truncate-and-store', () => {
  it('oversized page returns head+tail + Read footer; stored file is the full clean text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(exaResponse(BIG)));
    const out = String(await makeWebFetchTool('taskON', CFG).execute({ url: 'https://a.com' }, { toolCallId: 'c' }));
    expect(out).toContain('docline-0'); // head
    expect(out).toContain('docline-2999'); // tail PRESERVED
    expect(out).toContain('lines omitted');
    const m = out.match(/Read\(file_path="([^"]+)", offset=\d+, limit=\d+\)/);
    expect(m).not.toBeNull();
    expect(await readFile(m![1], 'utf8')).toBe(BIG);
  });

  it('small page: inline, no footer, no file (ON-base axis)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(exaResponse('SMALL BODY')));
    const out = String(await makeWebFetchTool('taskSmall', CFG).execute({ url: 'https://a.com' }, { toolCallId: 'c' }));
    expect(out).toContain('SMALL BODY');
    expect(out).not.toContain('Full text stored at');
    expect(await myFiles('taskSmall')).toEqual([]);
  });

  it('collapses giant base64 data-URIs', async () => {
    const bomb = `before data:image/png;base64,${'A'.repeat(5000)} after`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(exaResponse(bomb)));
    const out = String(await makeWebFetchTool('taskBomb', CFG).execute({ url: 'https://a.com' }, { toolCallId: 'c' }));
    expect(out).toContain('[data-uri omitted');
    expect(out).not.toContain('A'.repeat(1000));
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('legacy makeRawWebFetchTool arm is untouched even when flag ON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(`<html><body><p>${BIG}</p></body></html>`, { status: 200, headers: { 'content-type': 'text/html' } }),
    ));
    const out = String(await makeRawWebFetchTool().execute({ url: 'https://a.com' }, { toolCallId: 'c' }));
    expect(out).toContain('…[truncated]');
    expect(out).not.toContain('Full text stored at');
    expect(shape(makeRawWebFetchTool())).toEqual(['url', 'prompt']);
  });

  it('raises the Exa maxCharacters request cap so the store sees the full page (flag ON)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(exaResponse('BODY'));
    vi.stubGlobal('fetch', fetchMock);
    await makeWebFetchTool('taskCap', CFG).execute({ url: 'https://a.com' }, { toolCallId: 'c' });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body ?? '{}'));
    expect(body.text.maxCharacters).toBe(500_000);
  });

  it('keeps the legacy Exa 30k request cap when flag OFF (byte-identical request)', async () => {
    vi.stubEnv('VESTRA_WEBFETCH_STORE', '0');
    const fetchMock = vi.fn().mockResolvedValue(exaResponse('BODY'));
    vi.stubGlobal('fetch', fetchMock);
    await makeWebFetchTool('taskCapOff', CFG).execute({ url: 'https://a.com' }, { toolCallId: 'c' });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body ?? '{}'));
    expect(body.text.maxCharacters).toBe(30_000);
  });

  it('store write failure falls back to the legacy clip instead of failing the fetch', async () => {
    storeMock.fail = true;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(exaResponse(BIG)));
    const out = String(await makeWebFetchTool('taskFail', CFG).execute({ url: 'https://a.com' }, { toolCallId: 'c' }));
    expect(out).toContain('…[truncated]');
    expect(out).not.toContain('WebFetch error');
    expect(out).toContain(BIG.slice(0, 100));
  });
});

describe('batch urls (flag ON)', () => {
  /** Route the exa proxy mock per requested URL; the raw-fetch tier never fires. */
  const perUrlExa = () =>
    vi.fn().mockImplementation((input: string | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      // Proxy tiers POST a JSON body with the target in urls[0]; the raw tier GETs the target directly.
      const url = body?.urls?.[0] ?? String(input);
      if (url.includes('bad.com')) return Promise.reject(new Error('boom'));
      return Promise.resolve(exaResponse(`BODY OF ${url}`, url));
    });

  it('exposes urls in the schema when flag ON', () => {
    expect(shape(makeWebFetchTool('t', CFG))).toEqual(['url', 'urls', 'prompt']);
  });

  it('fetches 2 URLs in one call, one section per URL', async () => {
    vi.stubGlobal('fetch', perUrlExa());
    const out = String(await makeWebFetchTool('tb', CFG).execute({ urls: ['https://a.com', 'https://b.com'] }, { toolCallId: 'c' }));
    expect(out).toContain('## https://a.com');
    expect(out).toContain('## https://b.com');
    expect(out).toContain('BODY OF https://a.com');
    expect(out).toContain('BODY OF https://b.com');
  });

  it('single-url output format is unchanged (no section header)', async () => {
    vi.stubGlobal('fetch', perUrlExa());
    const out = String(await makeWebFetchTool('tb', CFG).execute({ urls: ['https://a.com'] }, { toolCallId: 'c' }));
    expect(out.startsWith('Fetched https://a.com')).toBe(true);
    expect(out).not.toContain('## https://a.com');
  });

  it('caps at 5 URLs with a model-readable error', async () => {
    const out = String(await makeWebFetchTool('tb', CFG).execute(
      { urls: ['https://1.com', 'https://2.com', 'https://3.com', 'https://4.com', 'https://5.com', 'https://6.com'] },
      { toolCallId: 'c' },
    ));
    expect(out).toContain('WebFetch error: at most 5 urls');
  });

  it('rejects url+urls together and empty input', async () => {
    expect(String(await makeWebFetchTool('tb', CFG).execute({ url: 'https://a.com', urls: ['https://b.com'] }, { toolCallId: 'c' })))
      .toContain('WebFetch error: pass either url or urls');
    expect(String(await makeWebFetchTool('tb', CFG).execute({ urls: [] }, { toolCallId: 'c' })))
      .toContain('WebFetch error: no url provided');
  });

  it('one failing URL renders inline as an error section, siblings unaffected', async () => {
    vi.stubGlobal('fetch', perUrlExa());
    const out = String(await makeWebFetchTool('tb', CFG).execute({ urls: ['https://a.com', 'https://bad.com'] }, { toolCallId: 'c' }));
    expect(out).toContain('BODY OF https://a.com');
    expect(out).toContain('WebFetch error');
  });

  it('a non-https url in the batch errors inline without killing siblings', async () => {
    vi.stubGlobal('fetch', perUrlExa());
    const out = String(await makeWebFetchTool('tb', CFG).execute({ urls: ['ftp://x', 'https://a.com'] }, { toolCallId: 'c' }));
    expect(out).toContain('only http(s) URLs are supported');
    expect(out).toContain('BODY OF https://a.com');
  });

  it('REGRESSION: batch of 5 oversized pages — every footer file exists after the call returns', async () => {
    const BIGDOC = Array.from({ length: 800 }, (_, i) => `bulk-${i} ${'z'.repeat(30)}`).join('\n'); // ~30k > 12k per-URL budget
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const url = body?.urls?.[0] ?? String(input);
      return Promise.resolve(exaResponse(BIGDOC, url));
    }));
    const urls = [1, 2, 3, 4, 5].map((i) => `https://big${i}.com`);
    const out = String(await makeWebFetchTool('tbig', CFG).execute({ urls }, { toolCallId: 'c' }));
    const footers = [...out.matchAll(/Read\(file_path="([^"]+)", offset=\d+, limit=\d+\)/g)].map((m) => m[1]);
    expect(footers.length).toBe(5); // every section stored + advertised
    for (const f of footers) {
      await expect(readFile(f, 'utf8')).resolves.toBe(BIGDOC); // and every file SURVIVED the batch (no self-reap)
    }
  });

  it('batch budget scales: 1→30k, 2→30k, 5→12k, floor 8k', () => {
    expect(batchBudget(1)).toBe(30_000);
    expect(batchBudget(2)).toBe(30_000);
    expect(batchBudget(5)).toBe(12_000);
    expect(batchBudget(7)).toBe(8_571);
  });
});
