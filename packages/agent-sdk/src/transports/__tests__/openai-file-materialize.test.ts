import { describe, it, expect, vi, afterEach } from 'vitest';
import { materializeOpenAIFileIds, hasHttpsInputImages } from '../openai-file-materialize.js';
import { _resetProviderFileIdCachesForTest } from '../provider-file-ids.js';
import { _resetMediaBytesCacheForTest } from '../media-bytes.js';

afterEach(() => {
  vi.unstubAllGlobals();
  _resetProviderFileIdCachesForTest();
  _resetMediaBytesCacheForTest();
});

const okFetch = () =>
  vi.fn(
    async () =>
      new Response(new Uint8Array([1, 2]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      }),
  );

describe('materializeOpenAIFileIds', () => {
  it('substitutes file_id for https input_image in user content and function_call_output', async () => {
    vi.stubGlobal('fetch', okFetch());
    const create = vi.fn(async () => ({ id: 'file-9' }));
    const client = { files: { create } } as never;
    const input = [
      {
        role: 'user',
        content: [
          { type: 'input_image', detail: 'auto', image_url: 'https://c/a.jpg' },
          { type: 'input_text', text: 'see' },
        ],
      },
      {
        type: 'function_call_output',
        call_id: 'c1',
        output: [{ type: 'input_image', image_url: 'https://c/a.jpg' }],
      },
    ] as never[];
    const out = await materializeOpenAIFileIds(input, client);
    expect((out[0] as { content: unknown[] }).content[0]).toEqual({
      type: 'input_image',
      detail: 'auto',
      file_id: 'file-9',
    });
    expect((out[0] as { content: unknown[] }).content[1]).toEqual({
      type: 'input_text',
      text: 'see',
    });
    expect((out[1] as { output: unknown[] }).output[0]).toEqual({
      type: 'input_image',
      file_id: 'file-9',
    });
    // one shared url ⇒ one upload
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('leaves data: URLs untouched (identity when nothing changes)', async () => {
    const input = [
      {
        role: 'user',
        content: [{ type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,AA' }],
      },
    ] as never[];
    const out = await materializeOpenAIFileIds(input, { files: { create: vi.fn() } } as never);
    expect(out).toBe(input);
  });

  it('falls back to an inline data: URL when the upload fails but bytes are fetchable', async () => {
    vi.stubGlobal('fetch', okFetch());
    const create = vi.fn(async () => {
      throw new Error('quota');
    });
    const input = [
      {
        role: 'user',
        content: [{ type: 'input_image', detail: 'auto', image_url: 'https://c/d.jpg' }],
      },
    ] as never[];
    const out = await materializeOpenAIFileIds(input, { files: { create } } as never);
    const part = (out[0] as { content: Array<{ image_url: string }> }).content[0]!;
    expect(part.image_url.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('keeps the url form as last resort when bytes are unfetchable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x', { status: 500 })),
    );
    const input = [
      {
        role: 'user',
        content: [{ type: 'input_image', detail: 'auto', image_url: 'https://c/e.jpg' }],
      },
    ] as never[];
    const out = await materializeOpenAIFileIds(input, { files: { create: vi.fn() } } as never);
    expect(out).toBe(input);
  });

  it('returns the SAME reference for image-free input', async () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'plain' }] }] as never[];
    const out = await materializeOpenAIFileIds(input, { files: { create: vi.fn() } } as never);
    expect(out).toBe(input);
  });
});

describe('hasHttpsInputImages', () => {
  it('detects https input_image parts in content and output arrays', () => {
    expect(
      hasHttpsInputImages([
        { role: 'user', content: [{ type: 'input_image', image_url: 'https://c/a.jpg' }] },
      ] as never),
    ).toBe(true);
    expect(
      hasHttpsInputImages([
        { type: 'function_call_output', call_id: 'c', output: [{ type: 'input_image', image_url: 'https://c/b.jpg' }] },
      ] as never),
    ).toBe(true);
  });

  it('is false for data: URLs, file_id parts, plain text, and empty input', () => {
    expect(hasHttpsInputImages([] as never)).toBe(false);
    expect(
      hasHttpsInputImages([
        { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA' }] },
      ] as never),
    ).toBe(false);
    expect(
      hasHttpsInputImages([
        { role: 'user', content: [{ type: 'input_image', file_id: 'file-1' }] },
      ] as never),
    ).toBe(false);
    expect(
      hasHttpsInputImages([{ role: 'user', content: 'string content' }] as never),
    ).toBe(false);
  });
});
