import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAIResponsesTransport } from '../openai-responses-transport.js';
import { _resetProviderFileIdCachesForTest } from '../provider-file-ids.js';
import { _resetMediaBytesCacheForTest } from '../media-bytes.js';

/**
 * Media-refs S1 — MEDIA_FILE_ID_OPENAI_V1 three-axis contract:
 *   OFF + url image  → wire input byte-identical to today (https image_url)
 *   ON  + url image  → file_id part; files.create once across two calls
 *   ON  + no image   → byte-identical to OFF (materialization never engages)
 */

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MEDIA_FILE_ID_OPENAI_V1;
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

function makeMockClient() {
  const calls: Array<{ body: any; opts: any }> = [];
  const stream = vi.fn((body: any, opts: any) => {
    calls.push({ body, opts });
    return (async function* () {})();
  });
  const create = vi.fn(async () => ({ id: 'file-wire' }));
  return { client: { responses: { stream }, files: { create } } as any, calls, create };
}

const URL_IMG = 'https://cdn.test/u1/shot.png?sig=xyz';

function paramsWithUrlImage() {
  return {
    model: 'gpt-5.2',
    system: 'SYS',
    tools: [] as unknown[],
    history: [
      {
        role: 'user',
        content: [
          { type: 'input_image', detail: 'auto', image_url: URL_IMG },
          { type: 'input_text', text: 'look' },
        ],
      },
    ] as unknown,
    maxTokens: 1024,
  };
}

function paramsTextOnly() {
  return {
    model: 'gpt-5.2',
    system: 'SYS',
    tools: [] as unknown[],
    history: [
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ] as unknown,
    maxTokens: 1024,
  };
}

async function drain(providerStream: unknown) {
  for await (const _ of providerStream as AsyncIterable<unknown>) {
    void _;
  }
}

describe('MEDIA_FILE_ID_OPENAI_V1 — OFF axis', () => {
  it('url image rides as image_url, synchronously, with no upload', () => {
    const { client, calls, create } = makeMockClient();
    const t = new OpenAIResponsesTransport({ client });
    t.callModel(paramsWithUrlImage() as any);

    expect(calls).toHaveLength(1); // sync — no lazy generator on the OFF path
    const part = calls[0].body.input[0].content[0];
    expect(part).toEqual({ type: 'input_image', detail: 'auto', image_url: URL_IMG });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('MEDIA_FILE_ID_OPENAI_V1 — ON axis (feature)', () => {
  it('substitutes file_id and uploads once across two calls', async () => {
    process.env.MEDIA_FILE_ID_OPENAI_V1 = '1';
    vi.stubGlobal('fetch', okFetch());
    const { client, calls, create } = makeMockClient();
    const t = new OpenAIResponsesTransport({ client });

    await drain(t.callModel(paramsWithUrlImage() as any));
    expect(calls).toHaveLength(1);
    expect(calls[0].body.input[0].content[0]).toEqual({
      type: 'input_image',
      detail: 'auto',
      file_id: 'file-wire',
    });
    expect(calls[0].body.input[0].content[1]).toEqual({ type: 'input_text', text: 'look' });

    await drain(t.callModel(paramsWithUrlImage() as any));
    expect(calls).toHaveLength(2);
    expect(calls[1].body.input[0].content[0]).toEqual({
      type: 'input_image',
      detail: 'auto',
      file_id: 'file-wire',
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('falls back to an inline data: URL when the upload fails', async () => {
    process.env.MEDIA_FILE_ID_OPENAI_V1 = '1';
    vi.stubGlobal('fetch', okFetch());
    const calls: Array<{ body: any }> = [];
    const stream = vi.fn((body: any) => {
      calls.push({ body });
      return (async function* () {})();
    });
    const create = vi.fn(async () => {
      throw new Error('quota');
    });
    const t = new OpenAIResponsesTransport({
      client: { responses: { stream }, files: { create } } as any,
    });

    await drain(t.callModel(paramsWithUrlImage() as any));
    const part = calls[0]!.body.input[0].content[0];
    expect(part.file_id).toBeUndefined();
    expect(part.image_url.startsWith('data:image/jpeg;base64,')).toBe(true);
  });
});

describe('MEDIA_FILE_ID_OPENAI_V1 — ON axis (base)', () => {
  it('a no-image history is byte-identical to the OFF path (sync, no upload)', () => {
    const off = makeMockClient();
    const tOff = new OpenAIResponsesTransport({ client: off.client });
    tOff.callModel(paramsTextOnly() as any);

    process.env.MEDIA_FILE_ID_OPENAI_V1 = '1';
    const on = makeMockClient();
    const tOn = new OpenAIResponsesTransport({ client: on.client });
    tOn.callModel(paramsTextOnly() as any);

    expect(on.calls).toHaveLength(1); // still sync — generator never engages without https images
    expect(JSON.stringify(on.calls[0].body)).toBe(JSON.stringify(off.calls[0].body));
    expect(on.create).not.toHaveBeenCalled();
  });
});
