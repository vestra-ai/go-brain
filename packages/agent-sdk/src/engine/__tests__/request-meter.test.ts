import { describe, it, expect } from 'vitest';
import { measureWireMedia, measureRequestBytes } from '../request-meter.js';

describe('measureWireMedia — S1 file_id dialects', () => {
  it('counts an Anthropic file source as an image weighing its file_id length', () => {
    const history = [
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'file', file_id: 'file_abc123' } }],
      },
    ];
    expect(measureWireMedia(history)).toEqual({ imageCount: 1, imageBytes: 'file_abc123'.length });
  });

  it('counts an OpenAI input_image with file_id (no image_url) as an image weighing its id length', () => {
    const history = [
      { role: 'user', content: [{ type: 'input_image', detail: 'auto', file_id: 'file-xyz9' }] },
    ];
    expect(measureWireMedia(history)).toEqual({ imageCount: 1, imageBytes: 'file-xyz9'.length });
  });
});

describe('measureWireMedia — all four wire dialects', () => {
  it('counts Anthropic base64 + url source blocks', () => {
    const history = [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(4000) } },
          { type: 'image', source: { type: 'url', url: 'https://x/a.png' } },
          { type: 'text', text: 'hi' },
        ],
      },
    ];
    const m = measureWireMedia(history);
    expect(m.imageCount).toBe(2);
    expect(m.imageBytes).toBe(4000 + 'https://x/a.png'.length);
  });

  it('counts OpenAI Responses input_image items', () => {
    const history = [
      { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,' + 'B'.repeat(1000) }] },
    ];
    const m = measureWireMedia(history);
    expect(m.imageCount).toBe(1);
    expect(m.imageBytes).toBeGreaterThan(1000);
  });

  it('counts Chat Completions image_url parts', () => {
    const history = [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/b.png' } }] },
    ];
    expect(measureWireMedia(history).imageCount).toBe(1);
  });

  it('counts Gemini inlineData parts', () => {
    const history = [
      { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'C'.repeat(500) } }] },
    ];
    const m = measureWireMedia(history);
    expect(m.imageCount).toBe(1);
    expect(m.imageBytes).toBe(500);
  });

  it('zero for text-only history; never throws on junk', () => {
    expect(measureWireMedia([{ role: 'user', content: 'hello' }])).toEqual({ imageCount: 0, imageBytes: 0 });
    expect(() => measureWireMedia(undefined)).not.toThrow();
    expect(() => measureWireMedia({ a: { b: null } })).not.toThrow();
  });
});

describe('measureRequestBytes', () => {
  it('measures the serialized request skeleton', () => {
    const n = measureRequestBytes('sys', [{ name: 'tool' }], [{ role: 'user', content: 'hé' }]);
    expect(n).toBe(
      Buffer.byteLength(
        JSON.stringify({ system: 'sys', tools: [{ name: 'tool' }], messages: [{ role: 'user', content: 'hé' }] }),
      ),
    );
  });
  it('never throws on circular input (returns 0)', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(measureRequestBytes('s', [], a)).toBe(0);
  });
});
