import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  materializeAnthropicFileIds,
  hasUrlImageSources,
} from '../anthropic-file-materialize.js';
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
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      }),
  );

const clientWith = (upload: ReturnType<typeof vi.fn>) =>
  ({ beta: { files: { upload } } }) as never;

const urlImage = (url: string) => ({ type: 'image', source: { type: 'url', url } });
const msgs = (blocks: unknown[]) => [{ role: 'user', content: blocks }] as never[];

describe('materializeAnthropicFileIds', () => {
  it('substitutes a file source and reports usedFileIds', async () => {
    vi.stubGlobal('fetch', okFetch());
    const upload = vi.fn(async () => ({ id: 'file_1' }));
    const r = await materializeAnthropicFileIds(
      msgs([urlImage('https://c/a.jpg'), { type: 'text', text: 'hi' }]),
      clientWith(upload),
    );
    expect(r.usedFileIds).toBe(true);
    const content = (r.messages[0] as { content: unknown[] }).content;
    expect(content[0]).toEqual({ type: 'image', source: { type: 'file', file_id: 'file_1' } });
    expect(content[1]).toEqual({ type: 'text', text: 'hi' });
  });

  it('returns the SAME references when there are no url images', async () => {
    const input = msgs([{ type: 'text', text: 'plain' }]);
    const r = await materializeAnthropicFileIds(input, clientWith(vi.fn()));
    expect(r.messages).toBe(input);
    expect(r.usedFileIds).toBe(false);
  });

  it('keeps base64 image sources and string-content messages untouched', async () => {
    const b64 = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
    const input = [
      { role: 'user', content: 'just a string' },
      { role: 'user', content: [b64] },
    ] as never[];
    const r = await materializeAnthropicFileIds(input, clientWith(vi.fn()));
    expect(r.messages).toBe(input);
  });

  it('falls back to the url source per-image when upload fails (identity when nothing changes)', async () => {
    vi.stubGlobal('fetch', okFetch());
    const upload = vi.fn(async () => {
      throw new Error('nope');
    });
    const input = msgs([urlImage('https://c/f.jpg')]);
    const r = await materializeAnthropicFileIds(input, clientWith(upload));
    expect(r.messages).toBe(input);
    expect(r.usedFileIds).toBe(false);
  });

  it('handles tool_result nested image blocks and uploads a shared url once', async () => {
    vi.stubGlobal('fetch', okFetch());
    const upload = vi.fn(async () => ({ id: 'file_2' }));
    const input = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: [urlImage('https://c/s.png')] },
        ],
      },
      { role: 'user', content: [urlImage('https://c/s.png')] },
    ] as never[];
    const r = await materializeAnthropicFileIds(input, clientWith(upload));
    expect(upload).toHaveBeenCalledTimes(1);
    const tr = (r.messages[0] as { content: Array<{ content: unknown[] }> }).content[0]!;
    expect(tr.content[0]).toEqual({ type: 'image', source: { type: 'file', file_id: 'file_2' } });
    const direct = (r.messages[1] as { content: unknown[] }).content[0];
    expect(direct).toEqual({ type: 'image', source: { type: 'file', file_id: 'file_2' } });
  });

  it('leaves assistant messages untouched even if they somehow carried image-shaped blocks', async () => {
    const input = [
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ] as never[];
    const r = await materializeAnthropicFileIds(input, clientWith(vi.fn()));
    expect(r.messages).toBe(input);
  });
});

describe('hasUrlImageSources', () => {
  it('detects top-level and tool_result-nested url image sources', () => {
    expect(hasUrlImageSources(msgs([urlImage('https://c/a.jpg')]) as never)).toBe(true);
    expect(
      hasUrlImageSources([
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't', content: [urlImage('https://c/b.png')] }],
        },
      ] as never),
    ).toBe(true);
  });

  it('is false for base64-only, string-content, and empty histories', () => {
    expect(hasUrlImageSources([] as never)).toBe(false);
    expect(hasUrlImageSources([{ role: 'user', content: 'hi' }] as never)).toBe(false);
    expect(
      hasUrlImageSources(
        msgs([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } }]) as never,
      ),
    ).toBe(false);
  });
});
