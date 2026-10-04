import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  anthropicFileIdFor,
  openaiFileIdFor,
  _resetProviderFileIdCachesForTest,
  ANTHROPIC_FILES_BETA,
} from '../provider-file-ids.js';
import { _resetMediaBytesCacheForTest } from '../media-bytes.js';

afterEach(() => {
  vi.unstubAllGlobals();
  _resetProviderFileIdCachesForTest();
  _resetMediaBytesCacheForTest();
});

const okFetch = () =>
  vi.fn(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      }),
  );

function fakeAnthropic(uploadImpl?: () => Promise<{ id: string }>) {
  const upload = vi.fn(uploadImpl ?? (async () => ({ id: 'file_abc' })));
  return { client: { beta: { files: { upload } } } as never, upload };
}

function fakeOpenAI(createImpl?: () => Promise<{ id: string }>) {
  const create = vi.fn(createImpl ?? (async () => ({ id: 'file-xyz' })));
  return { client: { files: { create } } as never, create };
}

describe('anthropicFileIdFor', () => {
  it('uploads once per url with the files beta and returns the id', async () => {
    vi.stubGlobal('fetch', okFetch());
    const { client, upload } = fakeAnthropic();
    expect(await anthropicFileIdFor('https://c/u/a.jpg', client)).toBe('file_abc');
    expect(await anthropicFileIdFor('https://c/u/a.jpg', client)).toBe('file_abc');
    expect(upload).toHaveBeenCalledTimes(1);
    expect((upload.mock.calls[0] as unknown[])[0]).toMatchObject({ betas: [ANTHROPIC_FILES_BETA] });
  });

  it('dedupes concurrent in-flight uploads for the same url', async () => {
    vi.stubGlobal('fetch', okFetch());
    const { client, upload } = fakeAnthropic();
    const [a, b] = await Promise.all([
      anthropicFileIdFor('https://c/u/racy.jpg', client),
      anthropicFileIdFor('https://c/u/racy.jpg', client),
    ]);
    expect(a).toBe('file_abc');
    expect(b).toBe('file_abc');
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('returns null on byte-fetch failure and on upload throw, and does not cache failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x', { status: 500 })),
    );
    const { client, upload } = fakeAnthropic();
    expect(await anthropicFileIdFor('https://c/u/b.jpg', client)).toBeNull();
    expect(upload).not.toHaveBeenCalled();

    vi.stubGlobal('fetch', okFetch());
    expect(await anthropicFileIdFor('https://c/u/b.jpg', client)).toBe('file_abc');
  });

  it('returns null when the upload rejects, then succeeds on retry', async () => {
    vi.stubGlobal('fetch', okFetch());
    let calls = 0;
    const { client } = fakeAnthropic(async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return { id: 'file_retry' };
    });
    expect(await anthropicFileIdFor('https://c/u/c.jpg', client)).toBeNull();
    expect(await anthropicFileIdFor('https://c/u/c.jpg', client)).toBe('file_retry');
  });
});

describe('openaiFileIdFor', () => {
  it('uploads once per url with purpose vision and returns the id', async () => {
    vi.stubGlobal('fetch', okFetch());
    const { client, create } = fakeOpenAI();
    expect(await openaiFileIdFor('https://c/u/a.jpg', client)).toBe('file-xyz');
    expect(await openaiFileIdFor('https://c/u/a.jpg', client)).toBe('file-xyz');
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0] as unknown[])[0]).toMatchObject({ purpose: 'vision' });
  });

  it('returns null when the upload rejects', async () => {
    vi.stubGlobal('fetch', okFetch());
    const { client } = fakeOpenAI(async () => {
      throw new Error('quota');
    });
    expect(await openaiFileIdFor('https://c/u/c.jpg', client)).toBeNull();
  });

  it('keeps per-provider caches independent (same url uploads to each provider once)', async () => {
    vi.stubGlobal('fetch', okFetch());
    const a = fakeAnthropic();
    const o = fakeOpenAI();
    expect(await anthropicFileIdFor('https://c/u/shared.jpg', a.client)).toBe('file_abc');
    expect(await openaiFileIdFor('https://c/u/shared.jpg', o.client)).toBe('file-xyz');
    expect(a.upload).toHaveBeenCalledTimes(1);
    expect(o.create).toHaveBeenCalledTimes(1);
  });
});
