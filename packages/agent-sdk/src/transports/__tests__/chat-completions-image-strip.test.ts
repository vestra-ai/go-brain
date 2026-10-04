import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import { stripImagesFromChatMessages } from '../chat-completions-messages.js';

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * Text-only models (the Fireworks OSS lane: GLM / DeepSeek) hard-400 on an
 * image_url content part. Since a persisted image is replayed into the request on
 * EVERY turn, one image would brick the whole session. stripImagesFromChatMessages
 * is the per-request projection that removes image_url parts (leaving the journal
 * intact) and leaves a short note so the model knows an image was dropped.
 */
describe('stripImagesFromChatMessages', () => {
  const NOTE = '[Image omitted: the selected model cannot view images.]';

  it('strips image_url parts from a user message but keeps its text (+ a note)', () => {
    const msgs: Msg[] = [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
          { type: 'text', text: 'what is this?' },
        ],
      },
    ];
    const out = stripImagesFromChatMessages(msgs);
    expect(out[0].content).toBe(`what is this?\n\n${NOTE}`);
  });

  it('replaces an image-only user message with just the note (never empty content)', () => {
    const msgs: Msg[] = [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] },
    ];
    const out = stripImagesFromChatMessages(msgs);
    expect(out[0].content).toBe(NOTE);
  });

  it('leaves a plain-string user message untouched (the common, cheap shape)', () => {
    const msgs: Msg[] = [{ role: 'user', content: 'hello' }];
    const out = stripImagesFromChatMessages(msgs);
    expect(out[0]).toEqual({ role: 'user', content: 'hello' });
  });

  it('leaves a text-only content array untouched (no images → no change, no note)', () => {
    const msgs: Msg[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    const out = stripImagesFromChatMessages(msgs);
    expect(out[0].content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('does not touch system / assistant / tool messages', () => {
    const msgs: Msg[] = [
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: 'ok' },
      { role: 'tool', tool_call_id: 't1', content: 'result' },
    ];
    expect(stripImagesFromChatMessages(msgs)).toEqual(msgs);
  });

  it('strips the persisted image on EVERY message that carries one (the un-brick case)', () => {
    const msgs: Msg[] = [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'a' } }, { type: 'text', text: 'first' }] },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second (text only)' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'b' } }, { type: 'text', text: 'third' }] },
    ];
    const out = stripImagesFromChatMessages(msgs);
    expect(out[0].content).toBe(`first\n\n${NOTE}`);
    expect(out[1]).toEqual({ role: 'assistant', content: 'reply' });
    expect(out[2]).toEqual({ role: 'user', content: 'second (text only)' });
    expect(out[3].content).toBe(`third\n\n${NOTE}`);
    // No image_url survives anywhere.
    const anyImage = JSON.stringify(out).includes('image_url');
    expect(anyImage).toBe(false);
  });
});
