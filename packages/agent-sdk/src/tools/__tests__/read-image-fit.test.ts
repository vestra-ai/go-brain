/**
 * SCREENSHOT_PRUNE_CACHE_V1 — an image Read is fitted to a 1568 px long edge before it enters the
 * journal (#4357 review H1): the decision (read-image-fit.ts, pure, from the file header) and the
 * Read tool's use of the host's fitter. The pixel work is the host's; here a fake fitter records
 * what it was asked for.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs, realpathSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fitReadImage,
  fittedSize,
  imageDimensions,
  jpegOrientation,
  READ_IMAGE_MAX_BYTES,
  READ_IMAGE_MAX_EDGE,
  type ImageFitRequest,
  type ImageFitter,
} from '../read-image-fit.js';
import { makeReadTool } from '../read-tool.js';

/** A PNG whose IHDR says `w` x `h`, padded to `size` bytes (only the header is ever parsed here). */
function png(w: number, h: number, size = 64): Buffer {
  const b = Buffer.alloc(Math.max(size, 33));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b, 0);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function jpeg(w: number, h: number, size = 64): Buffer {
  const head = Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // APP0
    0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, // SOF0
  ]);
  const b = Buffer.alloc(Math.max(size, head.length + 8));
  head.copy(b, 0);
  return b;
}
/** A JPEG stored `w` x `h` whose EXIF says `orientation` (an APP1 Exif segment before the frame). */
function jpegExif(w: number, h: number, orientation: number, le: boolean, size = 64): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write(le ? 'II' : 'MM', 0, 'ascii');
  const u16 = (v: number, o: number) => (le ? tiff.writeUInt16LE(v, o) : tiff.writeUInt16BE(v, o));
  const u32 = (v: number, o: number) => (le ? tiff.writeUInt32LE(v, o) : tiff.writeUInt32BE(v, o));
  u16(42, 2); u32(8, 4); u16(1, 8); // one IFD0 entry
  u16(0x0112, 10); u16(3, 12); u32(1, 14); u16(orientation, 18); u32(0, 22);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
  const rest = jpeg(w, h, size).subarray(2); // the APP0 and the frame
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, rest]);
}
const gif = (w: number, h: number) => Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, w & 0xff, w >> 8, h & 0xff, h >> 8, 0, 0]);
function webpVp8x(w: number, h: number): Buffer {
  const b = Buffer.alloc(32);
  b.write('RIFF', 0, 'ascii');
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}

/** A fake host fitter: records each request and answers a buffer of `answer(req)` bytes. */
function fakeFitter(answer: (req: ImageFitRequest) => number | null): { fit: ImageFitter; asked: ImageFitRequest[] } {
  const asked: ImageFitRequest[] = [];
  return {
    asked,
    fit: async (req) => {
      asked.push(req);
      const n = answer(req);
      return n === null ? null : { data: Buffer.alloc(n, 1), mediaType: req.format === 'png' ? 'image/png' : 'image/jpeg' };
    },
  };
}

describe('imageDimensions: from the header, every format Read accepts', () => {
  it('reads PNG, JPEG, GIF and WebP sizes; a truncated header says nothing', () => {
    expect(imageDimensions(png(4000, 3000), 'image/png')).toEqual({ width: 4000, height: 3000 });
    expect(imageDimensions(jpeg(3024, 4032), 'image/jpeg')).toEqual({ width: 3024, height: 4032 });
    expect(imageDimensions(gif(640, 480), 'image/gif')).toEqual({ width: 640, height: 480 });
    expect(imageDimensions(webpVp8x(2000, 1000), 'image/webp')).toEqual({ width: 2000, height: 1000 });
    expect(imageDimensions(Buffer.from([0x89, 0x50]), 'image/png')).toBeNull();
  });
});

describe('jpegOrientation: the EXIF tag a phone writes, either byte order', () => {
  it('reads orientation 6 and 8 in both byte orders, and 1 when there is none', () => {
    expect(jpegOrientation(jpegExif(4000, 3000, 6, true))).toBe(6);
    expect(jpegOrientation(jpegExif(4000, 3000, 8, false))).toBe(8);
    expect(jpegOrientation(jpeg(4000, 3000))).toBe(1);
    expect(imageDimensions(jpegExif(4000, 3000, 6, true), 'image/jpeg')).toEqual({ width: 4000, height: 3000 }); // as stored
  });
});

describe('fitReadImage: the long edge held to 1568 px, never upscaled', () => {
  it('a phone photo stored landscape with orientation 6 is asked for upright: portrait, by its real aspect', async () => {
    const { fit, asked } = fakeFitter(() => 300_000);
    const out = await fitReadImage(jpegExif(4000, 3000, 6, true, 3_000_000), 'image/jpeg', fit);
    // Mutation: size by the stored frame → 1568 x 1176 asked, and the turned photo is squashed.
    expect(asked[0]).toMatchObject({ width: 1176, height: 1568, orientation: 6 });
    expect(out.fitted).toEqual({ from: { width: 3000, height: 4000 }, to: { width: 1176, height: 1568 } });
  });

  it('a 1000 px PNG under the byte line is untouched, byte for byte, and the host is never asked', async () => {
    const { fit, asked } = fakeFitter(() => 10);
    const original = png(1000, 800, 200_000);
    const out = await fitReadImage(original, 'image/png', fit);
    expect(out.data).toBe(original);
    expect(out.fitted).toBeUndefined();
    expect(asked).toHaveLength(0);
  });

  it('a 4000 x 3000 photo goes out as a 1568 x 1176 JPEG', async () => {
    const { fit, asked } = fakeFitter(() => 300_000);
    const out = await fitReadImage(jpeg(4000, 3000, 5_000_000), 'image/jpeg', fit);
    expect(asked).toEqual([expect.objectContaining({ width: READ_IMAGE_MAX_EDGE, height: 1176, format: 'jpeg' })]);
    expect(out.mediaType).toBe('image/jpeg');
    expect(out.data.length).toBe(300_000);
    expect(out.fitted).toEqual({ from: { width: 4000, height: 3000 }, to: { width: 1568, height: 1176 } });
  });

  it('a large PNG stays PNG when it comes out small (a diagram), and goes JPEG when it does not (a photo saved as PNG)', async () => {
    const diagram = fakeFitter(() => 200_000);
    expect((await fitReadImage(png(3000, 2000, 2_000_000), 'image/png', diagram.fit)).mediaType).toBe('image/png');
    expect(diagram.asked.map((r) => r.format)).toEqual(['png']);
    const photo = fakeFitter((r) => (r.format === 'png' ? READ_IMAGE_MAX_BYTES + 1 : 400_000));
    expect((await fitReadImage(png(3000, 2000, 4_000_000), 'image/png', photo.fit)).mediaType).toBe('image/jpeg');
    expect(photo.asked.map((r) => r.format)).toEqual(['png', 'jpeg']);
    // The JPEG attempt failing (a Mac keeps PNG for transparency) leaves the fitted PNG, not the original.
    const noJpeg = fakeFitter((r) => (r.format === 'png' ? READ_IMAGE_MAX_BYTES + 1 : null));
    const kept = await fitReadImage(png(3000, 2000, 4_000_000), 'image/png', noJpeg.fit);
    expect(kept.mediaType).toBe('image/png');
    expect(kept.data.length).toBe(READ_IMAGE_MAX_BYTES + 1);
  });

  it('an image whose edge fits but whose bytes do not is re-encoded at its own size (never upscaled)', async () => {
    const { fit, asked } = fakeFitter(() => 500_000);
    await fitReadImage(png(1200, 900, 3_000_000), 'image/png', fit);
    expect(asked[0]).toMatchObject({ width: 1200, height: 900 });
    expect(fittedSize({ width: 800, height: 600 })).toEqual({ width: 800, height: 600 });
  });

  it('a host that fails, throws or answers nothing smaller leaves the original', async () => {
    const original = jpeg(4000, 3000, 2_000_000);
    expect((await fitReadImage(original, 'image/jpeg', fakeFitter(() => null).fit)).data).toBe(original);
    expect((await fitReadImage(original, 'image/jpeg', async () => { throw new Error('no ffmpeg'); })).data).toBe(original);
    expect((await fitReadImage(original, 'image/jpeg', fakeFitter(() => 3_000_000).fit)).data).toBe(original);
  });
});

describe('the Read tool with a host fitter', () => {
  let ws = '';
  afterEach(async () => {
    if (ws) await fs.rm(ws, { recursive: true, force: true });
    ws = '';
  });
  const fresh = () => (ws = realpathSync(mkdtempSync(join(tmpdir(), 'read-fit-'))));
  type Out = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };

  it('fits a large image before it is returned, and says so in the caption', async () => {
    fresh();
    await fs.writeFile(join(ws, 'sheet.png'), png(5000, 2500, 4_500_000));
    const { fit } = fakeFitter((r) => (r.format === 'png' ? 2_000_000 : 350_000));
    const out = (await makeReadTool(() => ws, undefined, { fitImage: fit }).execute({ file_path: 'sheet.png' }, {})) as Out;
    const image = out.content.find((c) => c.type === 'image')!;
    // Mutation: drop the fit → the 4.5 MB original rides into the journal.
    expect(Buffer.from(image.data!, 'base64').length).toBe(350_000);
    expect(image.mimeType).toBe('image/jpeg');
    expect(out.content[0]!.text).toContain('shown at 1568x784 (from 5000x2500) as image/jpeg');
  });

  it('a small image, and any image without a fitter (the flag off), are returned exactly as read', async () => {
    fresh();
    const small = png(1000, 700, 50_000);
    await fs.writeFile(join(ws, 'chart.png'), small);
    const { fit, asked } = fakeFitter(() => 10);
    const withFit = (await makeReadTool(() => ws, undefined, { fitImage: fit }).execute({ file_path: 'chart.png' }, {})) as Out;
    const without = (await makeReadTool(() => ws).execute({ file_path: 'chart.png' }, {})) as Out;
    expect(withFit).toEqual(without);
    expect(Buffer.from(without.content[1]!.data!, 'base64').equals(small)).toBe(true);
    expect(asked).toHaveLength(0);
  });
});
