/**
 * read-media.test.ts — magic-byte media detection for multimodal Read.
 *
 * Read must not trust the extension alone: the media type is decided by the
 * file's leading bytes. These unit-test the pure detectors used by read-tool.ts
 * to divert image/PDF reads off the utf8 path.
 */
import { describe, it, expect } from 'vitest';
import { mediaCandidate, detectImageMediaType, isPdfHeader, imageEnvelope } from '../read-media.js';

// Minimal magic-byte headers (detection reads only the signature, not a full image).
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const GIF87 = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x01, 0x00]);
const GIF89 = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
const PDF = Buffer.from('%PDF-1.4\n', 'utf8');
const TEXT = Buffer.from('hello world, not an image\n', 'utf8');

describe('mediaCandidate (extension → candidate)', () => {
  it('maps image extensions (case-insensitive) to image', () => {
    for (const p of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.WEBP', 'dir/sub/f.png']) {
      expect(mediaCandidate(p)).toBe('image');
    }
  });
  it('maps .pdf to pdf', () => {
    expect(mediaCandidate('report.pdf')).toBe('pdf');
    expect(mediaCandidate('X.PDF')).toBe('pdf');
  });
  it('returns null for text/code/no-extension/dotfiles', () => {
    for (const p of ['a.ts', 'README.md', 'Makefile', '.bashrc', 'dir.png/file', 'png']) {
      expect(mediaCandidate(p)).toBeNull();
    }
  });
});

describe('detectImageMediaType (magic bytes are authoritative)', () => {
  it('detects each supported image type from its signature', () => {
    expect(detectImageMediaType(PNG)).toBe('image/png');
    expect(detectImageMediaType(JPEG)).toBe('image/jpeg');
    expect(detectImageMediaType(GIF87)).toBe('image/gif');
    expect(detectImageMediaType(GIF89)).toBe('image/gif');
    expect(detectImageMediaType(WEBP)).toBe('image/webp');
  });
  it('returns null for non-image bytes (text, pdf, empty)', () => {
    expect(detectImageMediaType(TEXT)).toBeNull();
    expect(detectImageMediaType(PDF)).toBeNull();
    expect(detectImageMediaType(Buffer.alloc(0))).toBeNull();
  });
  it('does not misread a truncated RIFF (no WEBP tag) as an image', () => {
    // "RIFF" but bytes 8-11 are not "WEBP" (e.g. a WAV) → not an image.
    const wav = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);
    expect(detectImageMediaType(wav)).toBeNull();
  });
});

describe('isPdfHeader', () => {
  it('is true only for the %PDF- signature', () => {
    expect(isPdfHeader(PDF)).toBe(true);
    expect(isPdfHeader(TEXT)).toBe(false);
    expect(isPdfHeader(PNG)).toBe(false);
    expect(isPdfHeader(Buffer.from('%PD', 'utf8'))).toBe(false);
  });
});

describe('imageEnvelope', () => {
  it('leads with a text caption then the image so text-only arms degrade informatively', () => {
    // Chat Completions (role:'tool') and Gemini (functionResponse) flatten a
    // tool_result to text and drop the image; the caption keeps those arms informed.
    const env = imageEnvelope('Image file pic.png (image/png, 3 bytes).', 'QUJD', 'image/png');
    expect(env).toEqual({
      content: [
        { type: 'text', text: 'Image file pic.png (image/png, 3 bytes).' },
        { type: 'image', data: 'QUJD', mimeType: 'image/png' },
      ],
    });
  });
});
