import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  IMAGE_OMITTED_NOTE,
  imageOmittedNote,
  toolResultText,
  stripImagesFromChatMessages,
} from '../chat-completions-messages.js';
import { inlineChatImageParts, hasHttpsChatImages } from '../chat-completions-inline.js';
import { ChatCompletionsTransport } from '../chat-completions-transport.js';
import { _resetMediaBytesCacheForTest } from '../media-bytes.js';

/**
 * Media-refs S1 — MEDIA_INLINE_CHAT_V1 contract:
 *   vision models: https image_url parts are edge-inlined as data: URLs
 *   blind models:  the omission notes NAME the image (derived from the url)
 *   OFF: every output above is byte-identical to today (generic notes, url parts)
 */

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MEDIA_INLINE_CHAT_V1;
  _resetMediaBytesCacheForTest();
});

const okFetch = () =>
  vi.fn(
    async () =>
      new Response(new Uint8Array([7, 8]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      }),
  );

const URL_IMG = 'https://cdn.test/u1/stamp%20v2.png?sig=abc';

describe('imageOmittedNote', () => {
  it('unnamed form IS the existing constant (OFF-axis pin)', () => {
    expect(imageOmittedNote(null)).toBe(IMAGE_OMITTED_NOTE);
    expect(imageOmittedNote()).toBe(IMAGE_OMITTED_NOTE);
  });

  it('named form carries the filename', () => {
    expect(imageOmittedNote('a.png')).toBe(
      '[Image omitted: a.png — the selected model cannot view images.]',
    );
  });
});

describe('toolResultText — named option', () => {
  const blocks = [
    { type: 'image', data: '', mediaType: 'image/png', url: URL_IMG },
  ] as never[];

  it('default path is byte-identical to today (generic note)', () => {
    expect(toolResultText(blocks, 'saw it')).toBe(`saw it\n${IMAGE_OMITTED_NOTE}`);
  });

  it('named path derives the filename from the image url', () => {
    expect(toolResultText(blocks, 'saw it', { named: true })).toBe(
      'saw it\n[Image omitted: stamp v2.png — the selected model cannot view images.]',
    );
  });

  it('named path falls back to the generic note when the block has no url', () => {
    const noUrl = [{ type: 'image', data: 'AA', mediaType: 'image/png' }] as never[];
    expect(toolResultText(noUrl, '', { named: true })).toBe(IMAGE_OMITTED_NOTE);
  });
});

describe('stripImagesFromChatMessages — named option', () => {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: URL_IMG } },
        { type: 'text', text: 'look' },
      ],
    },
  ] as never[];

  it('default path is byte-identical to today (generic note)', () => {
    const out = stripImagesFromChatMessages(messages) as Array<{ content: string }>;
    expect(out[0]!.content).toBe(`look\n\n${IMAGE_OMITTED_NOTE}`);
  });

  it('named path names the first stripped image', () => {
    const out = stripImagesFromChatMessages(messages, { named: true }) as Array<{
      content: string;
    }>;
    expect(out[0]!.content).toBe(
      'look\n\n[Image omitted: stamp v2.png — the selected model cannot view images.]',
    );
  });

  it('named path keeps the generic note for data: URL parts', () => {
    const dataMsgs = [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
          { type: 'text', text: 'pasted' },
        ],
      },
    ] as never[];
    const out = stripImagesFromChatMessages(dataMsgs, { named: true }) as Array<{
      content: string;
    }>;
    expect(out[0]!.content).toBe(`pasted\n\n${IMAGE_OMITTED_NOTE}`);
  });
});

describe('inlineChatImageParts', () => {
  it('inlines https image_url parts as data: URLs', async () => {
    vi.stubGlobal('fetch', okFetch());
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: URL_IMG } },
          { type: 'text', text: 'look' },
        ],
      },
    ] as never[];
    const out = await inlineChatImageParts(messages);
    const part = (out[0] as { content: Array<{ image_url: { url: string } }> }).content[0]!;
    expect(part.image_url.url.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect((out[0] as { content: unknown[] }).content[1]).toEqual({ type: 'text', text: 'look' });
  });

  it('keeps the url part on fetch failure and returns identity when nothing changes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x', { status: 500 })),
    );
    const messages = [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: URL_IMG } }] },
    ] as never[];
    const out = await inlineChatImageParts(messages);
    expect(out).toBe(messages);
  });

  it('identity for string-content and image-free messages', async () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'plain' }] },
    ] as never[];
    const out = await inlineChatImageParts(messages);
    expect(out).toBe(messages);
  });
});

describe('hasHttpsChatImages', () => {
  it('detects https parts; false for data: parts and plain text', () => {
    expect(
      hasHttpsChatImages([
        { role: 'user', content: [{ type: 'image_url', image_url: { url: URL_IMG } }] },
      ] as never),
    ).toBe(true);
    expect(
      hasHttpsChatImages([
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }],
        },
      ] as never),
    ).toBe(false);
    expect(hasHttpsChatImages([{ role: 'user', content: 'hi' }] as never)).toBe(false);
  });
});

describe('ChatCompletionsTransport — MEDIA_INLINE_CHAT_V1 three axes', () => {
  function makeMockClient() {
    const calls: Array<{ body: any; opts: any }> = [];
    const stream = vi.fn((body: any, opts: any) => {
      calls.push({ body, opts });
      return (async function* () {})();
    });
    return { client: { chat: { completions: { stream } } } as any, calls };
  }

  const visionParams = (history: unknown) => ({
    model: 'gpt-5.2', // vision-capable on this arm
    system: 'SYS',
    tools: [] as unknown[],
    history,
    maxTokens: 512,
  });

  const blindParams = (history: unknown) => ({
    model: 'glm-5.2', // text-only (Fireworks OSS lane)
    system: 'SYS',
    tools: [] as unknown[],
    history,
    maxTokens: 512,
  });

  const urlHistory = () => [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: URL_IMG } },
        { type: 'text', text: 'look' },
      ],
    },
  ];

  async function drain(providerStream: unknown) {
    for await (const _ of providerStream as AsyncIterable<unknown>) {
      void _;
    }
  }

  it('OFF vision: url part rides untouched, synchronously', () => {
    const { client, calls } = makeMockClient();
    const t = new ChatCompletionsTransport({ client });
    t.callModel(visionParams(urlHistory()) as any);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.messages[1].content[0].image_url.url).toBe(URL_IMG);
  });

  it('ON vision: url part is inlined as a data: URL on the wire', async () => {
    process.env.MEDIA_INLINE_CHAT_V1 = '1';
    vi.stubGlobal('fetch', okFetch());
    const { client, calls } = makeMockClient();
    const t = new ChatCompletionsTransport({ client });
    await drain(t.callModel(visionParams(urlHistory()) as any));
    expect(calls).toHaveLength(1);
    expect(
      calls[0].body.messages[1].content[0].image_url.url.startsWith('data:image/jpeg;base64,'),
    ).toBe(true);
  });

  it('OFF blind: strip note stays the generic constant', () => {
    const { client, calls } = makeMockClient();
    const t = new ChatCompletionsTransport({ client });
    t.callModel(blindParams(urlHistory()) as any);
    expect(calls[0].body.messages[1].content).toBe(`look\n\n${IMAGE_OMITTED_NOTE}`);
  });

  it('ON blind: strip note names the image', () => {
    process.env.MEDIA_INLINE_CHAT_V1 = '1';
    const { client, calls } = makeMockClient();
    const t = new ChatCompletionsTransport({ client });
    t.callModel(blindParams(urlHistory()) as any);
    expect(calls[0].body.messages[1].content).toBe(
      'look\n\n[Image omitted: stamp v2.png — the selected model cannot view images.]',
    );
  });

  it('ON base: an image-free history is byte-identical to OFF', () => {
    const textHistory = () => [{ role: 'user', content: 'hi' }];
    const off = makeMockClient();
    new ChatCompletionsTransport({ client: off.client }).callModel(
      visionParams(textHistory()) as any,
    );

    process.env.MEDIA_INLINE_CHAT_V1 = '1';
    const on = makeMockClient();
    new ChatCompletionsTransport({ client: on.client }).callModel(
      visionParams(textHistory()) as any,
    );

    expect(on.calls).toHaveLength(1); // sync — no lazy path without https images
    expect(JSON.stringify(on.calls[0].body)).toBe(JSON.stringify(off.calls[0].body));
  });
});
