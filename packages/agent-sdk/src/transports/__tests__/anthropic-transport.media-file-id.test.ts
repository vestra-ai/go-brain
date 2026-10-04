import { describe, it, expect, vi, afterEach } from 'vitest';
import { AnthropicMessagesTransport } from '../anthropic-transport.js';
import { ANTHROPIC_FILES_BETA, _resetProviderFileIdCachesForTest } from '../provider-file-ids.js';
import { _resetMediaBytesCacheForTest } from '../media-bytes.js';

/**
 * Media-refs S1 — MEDIA_FILE_ID_ANTHROPIC_V1 three-axis contract:
 *   OFF + url image  → wire body byte-identical to today (url source, no files beta)
 *   ON  + url image  → file source + files beta header; upload once across calls
 *   ON  + no image   → byte-identical to OFF (materialization never engages)
 *   ON  + upload err → per-image url fallback, no files beta header
 */

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MEDIA_FILE_ID_ANTHROPIC_V1;
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

function makeMockClient(uploadImpl?: () => Promise<{ id: string }>) {
  const calls: Array<{ body: any; opts: any }> = [];
  const stream = vi.fn((body: any, opts: any) => {
    calls.push({ body, opts });
    return {
      async *[Symbol.asyncIterator]() {},
      async finalMessage() {
        return { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
      },
    } as any;
  });
  const upload = vi.fn(uploadImpl ?? (async () => ({ id: 'file_wire' })));
  return { client: { messages: { stream }, beta: { files: { upload } } } as any, calls, upload };
}

const URL_IMG = 'https://cdn.test/u1/stamp.png?sig=abc';

function paramsWithUrlImage() {
  return {
    model: 'claude-sonnet-5',
    system: 'SYS',
    tools: [] as unknown[],
    history: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: URL_IMG } },
          { type: 'text', text: 'look' },
        ],
      },
    ] as unknown,
    maxTokens: 1024,
  };
}

function paramsTextOnly() {
  return {
    model: 'claude-sonnet-5',
    system: 'SYS',
    tools: [] as unknown[],
    history: [{ role: 'user', content: 'hi' }] as unknown,
    maxTokens: 1024,
  };
}

/** Drain the provider stream so a lazy facade actually issues the request. */
async function drain(t: AnthropicMessagesTransport, providerStream: unknown) {
  for await (const _ of t.readStream(providerStream)) {
    void _;
  }
}

describe('MEDIA_FILE_ID_ANTHROPIC_V1 — OFF axis', () => {
  it('url image rides as a url source, synchronously, with no files beta header', () => {
    const { client, calls, upload } = makeMockClient();
    const t = new AnthropicMessagesTransport({ client });
    t.callModel(paramsWithUrlImage() as any);

    expect(calls).toHaveLength(1); // sync — no lazy facade on the OFF path
    const imgBlock = calls[0].body.messages[0].content[0];
    expect(imgBlock.source).toEqual({ type: 'url', url: URL_IMG });
    expect(calls[0].opts.headers).toBeUndefined();
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('MEDIA_FILE_ID_ANTHROPIC_V1 — ON axis (feature)', () => {
  it('substitutes file_id, sends the files beta, and uploads once across two calls', async () => {
    process.env.MEDIA_FILE_ID_ANTHROPIC_V1 = '1';
    vi.stubGlobal('fetch', okFetch());
    const { client, calls, upload } = makeMockClient();
    const t = new AnthropicMessagesTransport({ client });

    await drain(t, t.callModel(paramsWithUrlImage() as any));
    expect(calls).toHaveLength(1);
    const imgBlock = calls[0].body.messages[0].content[0];
    expect(imgBlock.source).toEqual({ type: 'file', file_id: 'file_wire' });
    // sibling text block untouched
    expect(calls[0].body.messages[0].content[1]).toMatchObject({ type: 'text', text: 'look' });
    expect(calls[0].opts.headers).toEqual({ 'anthropic-beta': ANTHROPIC_FILES_BETA });

    // Second round over the same (grown) history: SAME file_id, no re-upload —
    // deterministic substitution is what keeps the prompt-cache prefix stable.
    await drain(t, t.callModel(paramsWithUrlImage() as any));
    expect(calls).toHaveLength(2);
    expect(calls[1].body.messages[0].content[0].source).toEqual({
      type: 'file',
      file_id: 'file_wire',
    });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('falls back to the url source (no files beta) when the upload fails', async () => {
    process.env.MEDIA_FILE_ID_ANTHROPIC_V1 = '1';
    vi.stubGlobal('fetch', okFetch());
    const { client, calls } = makeMockClient(async () => {
      throw new Error('files api down');
    });
    const t = new AnthropicMessagesTransport({ client });

    await drain(t, t.callModel(paramsWithUrlImage() as any));
    expect(calls).toHaveLength(1);
    expect(calls[0].body.messages[0].content[0].source).toEqual({ type: 'url', url: URL_IMG });
    expect(calls[0].opts.headers).toBeUndefined();
  });
});

describe('MEDIA_FILE_ID_ANTHROPIC_V1 — ON axis (base)', () => {
  it('a no-image history is byte-identical to the OFF path (sync, no header, no upload)', () => {
    process.env.MEDIA_FILE_ID_ANTHROPIC_V1 = '1';
    const off = makeMockClient();
    delete process.env.MEDIA_FILE_ID_ANTHROPIC_V1;
    const tOff = new AnthropicMessagesTransport({ client: off.client });
    tOff.callModel(paramsTextOnly() as any);

    process.env.MEDIA_FILE_ID_ANTHROPIC_V1 = '1';
    const on = makeMockClient();
    const tOn = new AnthropicMessagesTransport({ client: on.client });
    tOn.callModel(paramsTextOnly() as any);

    expect(on.calls).toHaveLength(1); // still sync — facade never engages without url images
    expect(JSON.stringify(on.calls[0].body)).toBe(JSON.stringify(off.calls[0].body));
    expect(on.calls[0].opts.headers).toBeUndefined();
    expect(on.upload).not.toHaveBeenCalled();
  });
});
