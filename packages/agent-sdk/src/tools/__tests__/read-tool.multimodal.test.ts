/**
 * read-tool.multimodal.test.ts — multimodal Read: images return an image content
 * block (not utf8 garble); PDFs are refused with guidance; the text path is
 * unchanged.
 *
 * The image result is the `returnsContentBlocks` envelope
 * `{ content: [{ type:'image', data:<base64>, mimeType }] }` — the SAME shape the
 * browser-control screenshot tools return, so the dispatcher unwraps it into an
 * ImageBlock and the transports forward a real image to the model.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs, realpathSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeReadTool } from '../read-tool.js';
import { isToolError } from '../tool-types.js';
import { createFileViewState } from '../file-view-state.js';

// Canonical 1×1 transparent PNG (starts with the PNG magic 89 50 4E 47 …).
const PNG_1x1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQBH6i9AAAAAAElFTkSuQmCC';
const PNG_BYTES = Buffer.from(PNG_1x1_B64, 'base64');
// Minimal JPEG: only the FF D8 FF signature is load-bearing for detection.
const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

type TextItem = { type: 'text'; text: string };
type ImageItem = { type: 'image'; data: string; mimeType: string };
type ImageResult = { content: Array<TextItem | ImageItem> };
const imageOf = (r: ImageResult) => r.content.find((c): c is ImageItem => c.type === 'image')!;
const textOf = (r: ImageResult) => r.content.find((c): c is TextItem => c.type === 'text');

let WS = '';
afterEach(async () => { if (WS) await fs.rm(WS, { recursive: true, force: true }); WS = ''; });
const freshWs = () => { WS = realpathSync(mkdtempSync(join(tmpdir(), 'read-mm-'))); return WS; };

describe('Read images → image content block', () => {
  it('returns a captioned image envelope with the correct media type and round-trips the base64', async () => {
    const ws = freshWs();
    await fs.writeFile(join(ws, 'pic.png'), PNG_BYTES);
    const read = makeReadTool(() => ws);
    const out = (await read.execute({ file_path: 'pic.png' }, {})) as ImageResult;

    expect(typeof out).not.toBe('string'); // not the utf8/garble path
    const image = imageOf(out);
    expect(image).toEqual({ type: 'image', data: PNG_1x1_B64, mimeType: 'image/png' });
    // base64 decodes back to the exact bytes on disk.
    expect(Buffer.from(image.data, 'base64').equals(PNG_BYTES)).toBe(true);
    // a text caption precedes the image so text-only tool_result arms degrade informatively.
    expect(textOf(out)?.text).toContain('image/png');
    expect(textOf(out)?.text).toContain('pic.png');
  });

  it('detects media type by magic bytes, not the extension (a .jpg holding PNG bytes reads image/png)', async () => {
    const ws = freshWs();
    await fs.writeFile(join(ws, 'mislabeled.jpg'), PNG_BYTES);
    const read = makeReadTool(() => ws);
    const out = (await read.execute({ file_path: 'mislabeled.jpg' }, {})) as ImageResult;
    expect(imageOf(out).mimeType).toBe('image/png');
  });

  it('returns image/jpeg for a JPEG', async () => {
    const ws = freshWs();
    await fs.writeFile(join(ws, 'photo.jpeg'), JPEG_BYTES);
    const read = makeReadTool(() => ws);
    const out = (await read.execute({ file_path: 'photo.jpeg' }, {})) as ImageResult;
    expect(imageOf(out).mimeType).toBe('image/jpeg');
  });

  it('records the read-state (mtime+size) for an image read', async () => {
    const ws = freshWs();
    const abs = join(ws, 'pic.png');
    await fs.writeFile(abs, PNG_BYTES);
    const store = createFileViewState();
    const read = makeReadTool(() => ws, store);
    await read.execute({ file_path: 'pic.png' }, {});
    const rec = store.get(abs);
    expect(rec?.size).toBe(PNG_BYTES.length);
    expect(rec?.mtimeMs).toBeGreaterThan(0);
  });

  it('sets returnsContentBlocks so the dispatcher unwraps the image envelope', () => {
    const read = makeReadTool(() => '/tmp');
    expect(read.returnsContentBlocks).toBe(true);
  });

  it('refuses an oversized image with too_large', async () => {
    const ws = freshWs();
    const p = join(ws, 'huge.png');
    await fs.writeFile(p, PNG_BYTES);         // real PNG magic at the head
    await fs.truncate(p, 6 * 1024 * 1024);     // extend to 6MB (zeros) — magic preserved
    const read = makeReadTool(() => ws);
    const out = await read.execute({ file_path: 'huge.png' }, {});
    expect(isToolError(out)).toBe(true);
    if (!isToolError(out)) throw new Error('unreachable');
    expect(out.__toolError.code).toBe('too_large');
  });
});

describe('Read PDF → unavailable with guidance', () => {
  it('refuses a PDF with actionable extract-first guidance', async () => {
    const ws = freshWs();
    await fs.writeFile(join(ws, 'doc.pdf'), Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n', 'latin1'));
    const read = makeReadTool(() => ws);
    const out = await read.execute({ file_path: 'doc.pdf' }, {});
    expect(isToolError(out)).toBe(true);
    if (!isToolError(out)) throw new Error('unreachable');
    expect(out.__toolError.code).toBe('unavailable');
    expect(out.__toolError.message.toLowerCase()).toContain('pdf');
    expect(out.__toolError.message.toLowerCase()).toMatch(/extract|text|convert/);
  });
});

describe('Read text path is unchanged (byte-identical)', () => {
  it('a plain text file still returns the cat -n numbered string, not an envelope', async () => {
    const ws = freshWs();
    await fs.writeFile(join(ws, 'notes.txt'), 'alpha\nbeta\ngamma');
    const read = makeReadTool(() => ws);
    const out = (await read.execute({ file_path: 'notes.txt' }, {})) as string;
    expect(typeof out).toBe('string');
    expect(out).toMatch(/1\talpha/);
    expect(out).toMatch(/3\tgamma/);
  });

  it('a file with an image extension but text content falls through to the text path', async () => {
    const ws = freshWs();
    await fs.writeFile(join(ws, 'notreally.png'), 'this is plain text, not a PNG');
    const read = makeReadTool(() => ws);
    const out = (await read.execute({ file_path: 'notreally.png' }, {})) as string;
    expect(typeof out).toBe('string');
    expect(out).toMatch(/1\tthis is plain text, not a PNG/);
  });
});
