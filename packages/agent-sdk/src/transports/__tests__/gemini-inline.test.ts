import { describe, it, expect, vi, afterEach } from 'vitest';
import { materializeGeminiBody } from '../gemini-inline.js';
import { blocksToGeminiParts } from '../gemini-messages.js';
import { GeminiTransport } from '../gemini-transport.js';
import { _resetMediaBytesCacheForTest } from '../media-bytes.js';

/**
 * Media-refs S1 — MEDIA_INLINE_GEMINI_V1 contract:
 *   projection: a url-bearing ImageBlock carries the INTERNAL vestraImageUrl marker
 *   ON:  url-only inlineData is edge-fetched and filled; fetch failure → a text
 *        placeholder naming the file (never an empty inlineData part)
 *   OFF: marker stripped, everything else untouched (today's wire, verbatim)
 */

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MEDIA_INLINE_GEMINI_V1;
  _resetMediaBytesCacheForTest();
});

const URL_IMG = 'https://cdn.test/u1/chart%20q3.png?sig=abc';

const okFetch = () =>
  vi.fn(
    async () =>
      new Response(new Uint8Array([3, 4]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
  );

describe('blocksToGeminiParts — marker projection', () => {
  it('a url-bearing block carries vestraImageUrl; a base64-only block does not', () => {
    const withUrl = blocksToGeminiParts([
      { type: 'image', data: '', mediaType: 'image/png', url: URL_IMG } as never,
    ]);
    expect(withUrl[0]).toEqual({
      inlineData: { mimeType: 'image/png', data: '' },
      vestraImageUrl: URL_IMG,
    });

    const b64Only = blocksToGeminiParts([
      { type: 'image', data: 'AAAA', mediaType: 'image/png' } as never,
    ]);
    expect(b64Only[0]).toEqual({ inlineData: { mimeType: 'image/png', data: 'AAAA' } });
  });
});

describe('materializeGeminiBody', () => {
  const bodyWith = (parts: unknown[]) => ({
    contents: [{ role: 'user', parts }],
    generationConfig: { maxOutputTokens: 10 },
  });

  it('ON: fills empty inlineData from fetched bytes and strips the marker', async () => {
    process.env.MEDIA_INLINE_GEMINI_V1 = '1';
    vi.stubGlobal('fetch', okFetch());
    const body = bodyWith([
      { inlineData: { mimeType: 'image/png', data: '' }, vestraImageUrl: URL_IMG },
      { text: 'what is this' },
    ]);
    const out = (await materializeGeminiBody(body)) as typeof body;
    const part = out.contents[0]!.parts[0] as { inlineData: { data: string }; vestraImageUrl?: string };
    expect(part.inlineData.data).toBe(Buffer.from([3, 4]).toString('base64'));
    expect(part.vestraImageUrl).toBeUndefined();
    expect(out.contents[0]!.parts[1]).toEqual({ text: 'what is this' });
    expect(out.generationConfig).toEqual({ maxOutputTokens: 10 });
  });

  it('ON: fetch failure becomes a text placeholder naming the file — never an empty part', async () => {
    process.env.MEDIA_INLINE_GEMINI_V1 = '1';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x', { status: 500 })),
    );
    const body = bodyWith([
      { inlineData: { mimeType: 'image/png', data: '' }, vestraImageUrl: URL_IMG },
    ]);
    const out = (await materializeGeminiBody(body)) as typeof body;
    expect(out.contents[0]!.parts[0]).toEqual({
      text: '[image unavailable: chart q3.png — re-read it from files/ if needed]',
    });
  });

  it('ON: a marker part that already has bytes just loses the marker (no fetch)', async () => {
    process.env.MEDIA_INLINE_GEMINI_V1 = '1';
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const body = bodyWith([
      { inlineData: { mimeType: 'image/png', data: 'AAAA' }, vestraImageUrl: URL_IMG },
    ]);
    const out = (await materializeGeminiBody(body)) as typeof body;
    expect(out.contents[0]!.parts[0]).toEqual({ inlineData: { mimeType: 'image/png', data: 'AAAA' } });
    expect(f).not.toHaveBeenCalled();
  });

  it('OFF: marker stripped, empty inlineData left as-is (today’s dormant wire, verbatim)', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const body = bodyWith([
      { inlineData: { mimeType: 'image/png', data: '' }, vestraImageUrl: URL_IMG },
      { text: 'hello' },
    ]);
    const out = (await materializeGeminiBody(body)) as typeof body;
    expect(out.contents[0]!.parts[0]).toEqual({ inlineData: { mimeType: 'image/png', data: '' } });
    expect(out.contents[0]!.parts[1]).toEqual({ text: 'hello' });
    expect(f).not.toHaveBeenCalled();
  });

  it('identity (same reference) for marker-free bodies', async () => {
    const body = bodyWith([{ text: 'plain' }]);
    const out = await materializeGeminiBody(body);
    expect(out).toBe(body);
  });
});

describe('GeminiTransport streamFactory path', () => {
  it('the injected factory receives the materialized body (marker stripped, bytes inlined)', async () => {
    process.env.MEDIA_INLINE_GEMINI_V1 = '1';
    vi.stubGlobal('fetch', okFetch());
    const seen: unknown[] = [];
    const t = new GeminiTransport({
      streamFactory: (_model: string, body: unknown) => {
        seen.push(body);
        return (async function* () {})() as never;
      },
    } as never);

    const history = t.emptyHistory();
    t.pushUser(history, 'look', [
      { type: 'image', data: '', mediaType: 'image/png', url: URL_IMG } as never,
    ]);
    const stream = t.callModel({
      model: 'gemini-2.5-pro',
      system: 'SYS',
      tools: [],
      history,
      maxTokens: 64,
    } as never);
    for await (const _ of stream as AsyncIterable<unknown>) {
      void _;
    }

    expect(seen).toHaveLength(1);
    const body = seen[0] as { contents: Array<{ parts: Array<Record<string, unknown>> }> };
    const imgPart = body.contents[0]!.parts.find((p) => 'inlineData' in p) as {
      inlineData: { data: string };
      vestraImageUrl?: string;
    };
    expect(imgPart.inlineData.data).toBe(Buffer.from([3, 4]).toString('base64'));
    expect(imgPart.vestraImageUrl).toBeUndefined();
  });
});
