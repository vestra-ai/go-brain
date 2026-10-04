import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import {
  journalToOpenAIResponsesInput,
  blocksToOpenAIResponsesContent,
} from '../openai-responses-messages.js';
import { OpenAIResponsesTransport } from '../openai-responses-transport.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { ContentBlock, ImageBlock } from '../../contract/blocks.js';
import type { ProviderHistory } from '../../engine/transport.js';

/**
 * PR1 — image input on the gpt (OpenAI Responses) arm.
 *
 * The OpenAI projection used to filter user content to text blocks only, so any
 * attached ImageBlock was silently dropped and gpt never saw the image. This
 * suite locks parity with the Anthropic arm (`blocksToAnthropic`):
 *   - an ImageBlock projects an `input_image` content part (NOT dropped),
 *   - the CDN `url` is preferred, falling back to a `data:` base64 url,
 *   - image-before-text ordering,
 *   - and CRUCIALLY a text-only user entry still projects a BARE STRING
 *     (byte-identical to before — no array of input_text parts).
 *
 * It covers BOTH paths that share the helper: the journal projection
 * (`journalToOpenAIResponsesInput`) and the in-memory `pushUser`.
 */

function baseEntry(seq: number, payload: JournalEntry['payload']): JournalEntry {
  return {
    uuid: `u_${seq}`,
    parentUuid: seq === 0 ? null : `u_${seq - 1}`,
    seq,
    taskId: 't1',
    rootTaskId: 't1',
    spawnDepth: 0,
    workspaceId: 'w1',
    agentId: 'native',
    principal: { kind: 'agent', agentId: 'native' },
    timestamp: '2026-01-01T00:00:00.000Z',
    payload,
  };
}

/** A 1x1 transparent PNG (base64), the canonical tiny image fixture. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function userInputItem(
  item: OpenAI.Responses.ResponseInputItem,
): { role?: string; content: unknown } {
  return item as unknown as { role?: string; content: unknown };
}

describe('blocksToOpenAIResponsesContent — image-aware user content projection', () => {
  it('projects an ImageBlock with a CDN url as an input_image content part carrying that url', () => {
    const url = 'https://cdn.example.com/pic.png';
    const blocks: ContentBlock[] = [
      { type: 'image', data: PNG_B64, mediaType: 'image/png', url },
      { type: 'text', text: 'what is this?' },
    ];
    const content = blocksToOpenAIResponsesContent(blocks);

    expect(Array.isArray(content)).toBe(true);
    const parts = content as OpenAI.Responses.ResponseInputContent[];
    const img = parts.find((p) => p.type === 'input_image') as
      | OpenAI.Responses.ResponseInputImage
      | undefined;
    expect(img).toBeDefined();
    expect(img!.image_url).toBe(url);
    expect(img!.detail).toBe('auto');
  });

  it('falls back to a data: base64 url when the ImageBlock has no url', () => {
    const blocks: ContentBlock[] = [
      { type: 'image', data: PNG_B64, mediaType: 'image/png' },
    ];
    const content = blocksToOpenAIResponsesContent(blocks);
    const parts = content as OpenAI.Responses.ResponseInputContent[];
    const img = parts.find((p) => p.type === 'input_image') as
      | OpenAI.Responses.ResponseInputImage
      | undefined;
    expect(img).toBeDefined();
    expect(img!.image_url).toBe(`data:image/png;base64,${PNG_B64}`);
  });

  it('orders image-before-text (parity with blocksToAnthropic)', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'caption first in the array' },
      { type: 'image', data: PNG_B64, mediaType: 'image/png', url: 'https://cdn/x.png' },
    ];
    const content = blocksToOpenAIResponsesContent(blocks);
    const parts = content as OpenAI.Responses.ResponseInputContent[];
    expect(parts.map((p) => p.type)).toEqual(['input_image', 'input_text']);
  });

  it('projects text blocks to input_text parts when an image is present', () => {
    const blocks: ContentBlock[] = [
      { type: 'image', data: PNG_B64, mediaType: 'image/png', url: 'https://cdn/x.png' },
      { type: 'text', text: 'line one' },
      { type: 'text', text: 'line two' },
    ];
    const content = blocksToOpenAIResponsesContent(blocks) as OpenAI.Responses.ResponseInputContent[];
    const texts = content.filter(
      (p): p is OpenAI.Responses.ResponseInputText => p.type === 'input_text',
    );
    expect(texts.map((t) => t.text)).toEqual(['line one', 'line two']);
  });

  it('REGRESSION: a text-only block array projects a bare STRING (byte-identical)', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'just text' },
      { type: 'text', text: 'second line' },
    ];
    const content = blocksToOpenAIResponsesContent(blocks);
    expect(typeof content).toBe('string');
    // Mirrors today's blocksToText: text blocks joined with a newline.
    expect(content).toBe('just text\nsecond line');
  });

  it('REGRESSION: an empty block array projects a bare empty string', () => {
    expect(blocksToOpenAIResponsesContent([])).toBe('');
  });
});

describe('journalToOpenAIResponsesInput — user images are projected (no longer dropped)', () => {
  it('a user entry with an ImageBlock (url) projects an input_image carrying the url', () => {
    const url = 'https://cdn.example.com/uploaded.png';
    const entries: JournalEntry[] = [
      baseEntry(0, {
        type: 'user',
        blocks: [
          { type: 'image', data: PNG_B64, mediaType: 'image/png', url },
          { type: 'text', text: 'describe the screenshot' },
        ],
      }),
    ];
    const input = journalToOpenAIResponsesInput(entries);
    expect(input).toHaveLength(1);
    const u = userInputItem(input[0]);
    expect(u.role).toBe('user');
    expect(Array.isArray(u.content)).toBe(true);
    const parts = u.content as OpenAI.Responses.ResponseInputContent[];
    expect(parts.map((p) => p.type)).toEqual(['input_image', 'input_text']);
    const img = parts[0] as OpenAI.Responses.ResponseInputImage;
    expect(img.image_url).toBe(url);
    expect(img.detail).toBe('auto');
    expect((parts[1] as OpenAI.Responses.ResponseInputText).text).toBe(
      'describe the screenshot',
    );
  });

  it('a user entry with an ImageBlock (no url) projects a data: base64 image_url', () => {
    const entries: JournalEntry[] = [
      baseEntry(0, {
        type: 'user',
        blocks: [{ type: 'image', data: PNG_B64, mediaType: 'image/jpeg' }],
      }),
    ];
    const input = journalToOpenAIResponsesInput(entries);
    const parts = userInputItem(input[0]).content as OpenAI.Responses.ResponseInputContent[];
    const img = parts[0] as OpenAI.Responses.ResponseInputImage;
    expect(img.type).toBe('input_image');
    expect(img.image_url).toBe(`data:image/jpeg;base64,${PNG_B64}`);
  });

  it('REGRESSION: a text-only user entry still projects { role:user, content: <string> }', () => {
    const entries: JournalEntry[] = [
      baseEntry(0, { type: 'user', blocks: [{ type: 'text', text: 'hello there' }] }),
    ];
    const input = journalToOpenAIResponsesInput(entries);
    expect(input).toEqual([{ role: 'user', content: 'hello there' }]);
  });
});

describe('OpenAIResponsesTransport.pushUser — images reach the in-memory history', () => {
  function transport() {
    // No client needed: pushUser is pure history mutation.
    return new OpenAIResponsesTransport({ client: {} as never });
  }

  it('pushes an input_image (image-before-text) when _images is provided', () => {
    const t = transport();
    const h = t.emptyHistory() as ProviderHistory;
    const images: ImageBlock[] = [
      { type: 'image', data: PNG_B64, mediaType: 'image/png', url: 'https://cdn/u.png' },
    ];
    t.pushUser(h, 'look at this', images);

    const items = h as OpenAI.Responses.ResponseInputItem[];
    expect(items).toHaveLength(1);
    const u = userInputItem(items[0]);
    expect(u.role).toBe('user');
    const parts = u.content as OpenAI.Responses.ResponseInputContent[];
    expect(parts.map((p) => p.type)).toEqual(['input_image', 'input_text']);
    expect((parts[0] as OpenAI.Responses.ResponseInputImage).image_url).toBe(
      'https://cdn/u.png',
    );
    expect((parts[1] as OpenAI.Responses.ResponseInputText).text).toBe('look at this');
  });

  it('REGRESSION: pushUser with no images still pushes a bare-string content (byte-identical)', () => {
    const t = transport();
    const h = t.emptyHistory() as ProviderHistory;
    t.pushUser(h, 'plain text turn');
    expect(h).toEqual([{ role: 'user', content: 'plain text turn' }]);
  });

  it('pushUser falls back to a data: url when an image has no CDN url', () => {
    const t = transport();
    const h = t.emptyHistory() as ProviderHistory;
    const images: ImageBlock[] = [{ type: 'image', data: PNG_B64, mediaType: 'image/webp' }];
    t.pushUser(h, '', images);
    const items = h as OpenAI.Responses.ResponseInputItem[];
    const parts = userInputItem(items[0]).content as OpenAI.Responses.ResponseInputContent[];
    // image only (no text part for an empty text)
    expect(parts.map((p) => p.type)).toEqual(['input_image']);
    expect((parts[0] as OpenAI.Responses.ResponseInputImage).image_url).toBe(
      `data:image/webp;base64,${PNG_B64}`,
    );
  });
});
