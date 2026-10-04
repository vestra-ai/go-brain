/**
 * The blind-lane image note. `look` is retired (every picker model sees images
 * now), so the note has ONE job again: say an image was here and NAME it when
 * media-refs S1 naming is on, so the handle survives a wire that cannot carry
 * the pixels. The exact bytes are pinned here — the note is what a blind model
 * reads instead of the image, and it must never silently drift.
 */
import { describe, expect, test } from 'vitest';
import type OpenAI from 'openai';
import type { ContentBlock } from '../../contract/blocks.js';
import {
  IMAGE_OMITTED_NOTE,
  imageOmittedNote,
  stripImagesFromChatMessages,
  toolResultText,
} from '../chat-completions-messages.js';

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const imgBlocks: ContentBlock[] = [
  { type: 'image', data: 'aGk=', mediaType: 'image/png' },
];

const imgMsg = (url: string): Msg => ({
  role: 'user',
  content: [
    { type: 'text', text: 'see this' },
    { type: 'image_url', image_url: { url } },
  ],
});

describe('imageOmittedNote', () => {
  test('the unnamed note IS the exported constant, byte for byte', () => {
    expect(imageOmittedNote()).toBe(IMAGE_OMITTED_NOTE);
    expect(imageOmittedNote(null)).toBe(IMAGE_OMITTED_NOTE);
    expect(IMAGE_OMITTED_NOTE).toBe('[Image omitted: the selected model cannot view images.]');
  });

  test('a named image keeps its handle in the note', () => {
    expect(imageOmittedNote('q3-chart.png')).toBe(
      '[Image omitted: q3-chart.png — the selected model cannot view images.]',
    );
  });

  test('the note never teaches a tool — `look` is gone', () => {
    expect(imageOmittedNote('q3-chart.png')).not.toMatch(/look/i);
    expect(IMAGE_OMITTED_NOTE).not.toMatch(/look/i);
  });
});

describe('toolResultText', () => {
  test('an image-bearing tool result appends the note after the caller text', () => {
    expect(toolResultText(imgBlocks, '[screenshot]')).toBe(`[screenshot]\n${IMAGE_OMITTED_NOTE}`);
  });

  test('with S1 naming on, the note names the omitted image and nothing else changes', () => {
    const named: ContentBlock[] = [
      { type: 'image', data: 'aGk=', mediaType: 'image/png', url: 'https://cdn/a/dash.png?sig=2' },
    ];
    expect(toolResultText(named, '[screenshot]', { named: true })).toBe(
      '[screenshot]\n[Image omitted: dash.png — the selected model cannot view images.]',
    );
  });
});

describe('stripImagesFromChatMessages', () => {
  test('the stripped message keeps its text and carries the note', () => {
    const [m] = stripImagesFromChatMessages([imgMsg('https://cdn/a/dash.png')]);
    expect(m.content).toBe(`see this\n\n${IMAGE_OMITTED_NOTE}`);
  });

  test('with S1 naming on, the note names the image from its url (query stripped)', () => {
    const [m] = stripImagesFromChatMessages([imgMsg('https://cdn/a/dash.png?sig=2')], { named: true });
    expect(m.content).toBe(
      'see this\n\n[Image omitted: dash.png — the selected model cannot view images.]',
    );
  });
});
