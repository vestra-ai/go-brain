import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchImageAsBase64,
  filenameFromUrl,
  _resetMediaBytesCacheForTest,
} from '../media-bytes.js';

afterEach(() => {
  vi.unstubAllGlobals();
  _resetMediaBytesCacheForTest();
});

function okFetch(bytes: Uint8Array, contentType = 'image/jpeg') {
  return vi.fn(
    async () => new Response(bytes as any, { status: 200, headers: { 'content-type': contentType } }),
  );
}

describe('fetchImageAsBase64', () => {
  it('fetches, base64-encodes, and reports mediaType from content-type', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal('fetch', okFetch(bytes, 'image/png'));
    const r = await fetchImageAsBase64('https://cdn.example/a.png?sig=x');
    expect(r).toEqual({ data: Buffer.from(bytes).toString('base64'), mediaType: 'image/png' });
  });

  it('caches by url — second call does not re-fetch', async () => {
    const f = okFetch(new Uint8Array([9]));
    vi.stubGlobal('fetch', f);
    await fetchImageAsBase64('https://cdn.example/a.jpg');
    await fetchImageAsBase64('https://cdn.example/a.jpg');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent in-flight fetches', async () => {
    const f = okFetch(new Uint8Array([9]));
    vi.stubGlobal('fetch', f);
    await Promise.all([
      fetchImageAsBase64('https://c/x.jpg'),
      fetchImageAsBase64('https://c/x.jpg'),
    ]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('returns null on non-200 and on thrown fetch, and does NOT cache failures', async () => {
    const bad = vi.fn(async () => new Response('nope', { status: 403 }));
    vi.stubGlobal('fetch', bad);
    expect(await fetchImageAsBase64('https://c/y.jpg')).toBeNull();

    const thrown = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', thrown);
    expect(await fetchImageAsBase64('https://c/y.jpg')).toBeNull();

    vi.stubGlobal('fetch', okFetch(new Uint8Array([7])));
    expect(await fetchImageAsBase64('https://c/y.jpg')).not.toBeNull();
  });

  it('falls back to extension-derived mediaType when content-type is absent/generic', async () => {
    vi.stubGlobal('fetch', okFetch(new Uint8Array([1]), 'application/octet-stream'));
    const r = await fetchImageAsBase64('https://c/z.webp');
    expect(r?.mediaType).toBe('image/webp');
  });

  it('evicts the oldest entry once the cap is reached (bounded cache)', async () => {
    const f = okFetch(new Uint8Array([5]));
    vi.stubGlobal('fetch', f);
    for (let i = 0; i < 49; i++) {
      await fetchImageAsBase64(`https://c/img-${i}.jpg`);
    }
    expect(f).toHaveBeenCalledTimes(49);
    // img-0 was evicted by the 49th insert (cap 48) → re-fetching it hits the network.
    await fetchImageAsBase64('https://c/img-0.jpg');
    expect(f).toHaveBeenCalledTimes(50);
    // img-48 (newest) is still cached.
    await fetchImageAsBase64('https://c/img-48.jpg');
    expect(f).toHaveBeenCalledTimes(50);
  });
});

describe('filenameFromUrl', () => {
  it('extracts the decoded basename, query stripped', () => {
    expect(filenameFromUrl('https://c/u1/stamp%20v2.png?token=abc')).toBe('stamp v2.png');
  });

  it('returns null for unparsable or empty-path urls', () => {
    expect(filenameFromUrl('not a url')).toBeNull();
    expect(filenameFromUrl('https://c/')).toBeNull();
  });

  it('returns null for non-http(s) urls — a data: URL pathname is payload, not a name', () => {
    expect(filenameFromUrl('data:image/png;base64,iVBORw0KGgo')).toBeNull();
    expect(filenameFromUrl('file:///tmp/x.png')).toBeNull();
  });
});
