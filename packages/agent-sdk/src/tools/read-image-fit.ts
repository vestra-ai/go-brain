/**
 * read-image-fit — SCREENSHOT_PRUNE_CACHE_V1: an image Read is fitted before it enters the journal
 * and the wire (#4357 review H1).
 *
 * With the flag on, the screenshot prune no longer stubs Read images, so what bounds them is the
 * media rail; and Read returned a file's raw bytes, up to 5 MB, at any size. Fitting at the source
 * keeps every lane's request small and changes nothing the model sees that matters:
 *   - the long edge is held to READ_IMAGE_MAX_EDGE (1568 px), where Anthropic downsamples anyway
 *     and prices images by pixels, so a larger original buys no detail and costs bytes;
 *   - an image already that small and under READ_IMAGE_MAX_BYTES is returned untouched, byte for
 *     byte (a diagram, a screenshot, an icon);
 *   - never upscaled; a photo (JPEG, WebP) is re-encoded as JPEG, a PNG or GIF stays PNG unless
 *     the PNG is still over READ_IMAGE_MAX_BYTES (a photo saved as PNG), then JPEG.
 *
 * Pure here: the dimensions come from the file header, and the pixel work is the HOST's
 * `ImageFitter` (the sandbox runs ffmpeg on the box, sips on a Mac). A fitter that fails, or
 * returns nothing smaller, leaves the original: a Read never fails because a fit did.
 */
import type { ImageMediaType } from '../contract/blocks.js';

/** The long edge a Read image is held to (Anthropic's own downsample size). */
export const READ_IMAGE_MAX_EDGE = 1568;
/** An image over this many bytes is re-encoded even when its edge already fits. */
export const READ_IMAGE_MAX_BYTES = 1024 * 1024;

export interface ImageSize {
  width: number;
  height: number;
}

/**
 * What the host is asked to produce: the image turned upright by `orientation` (the EXIF tag, 1 to
 * 8; 1 = as stored) and fitted within `width` x `height` by its own aspect, never larger than the
 * original, in `format`. `width` x `height` is the UPRIGHT size: a phone photo stored landscape
 * with orientation 6 is asked for portrait.
 */
export interface ImageFitRequest extends ImageSize {
  data: Buffer;
  mediaType: ImageMediaType;
  format: 'png' | 'jpeg';
  orientation: number;
}

/** The host's pixel work; null (or a throw) leaves the original. */
export type ImageFitter = (req: ImageFitRequest) => Promise<{ data: Buffer; mediaType: ImageMediaType } | null>;

export interface FittedImage {
  data: Buffer;
  mediaType: ImageMediaType;
  /** Set when the image was fitted: the original size and the size sent. */
  fitted?: { from: ImageSize; to: ImageSize };
}

const u16be = (b: Buffer, i: number) => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Buffer, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Buffer, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);

/** An image's pixel size, read from its header; null when the header does not say. Never throws. */
export function imageDimensions(b: Buffer, mediaType: ImageMediaType): ImageSize | null {
  try {
    if (mediaType === 'image/png' && b.length >= 24) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (mediaType === 'image/gif' && b.length >= 10) return { width: u16le(b, 6), height: u16le(b, 8) };
    if (mediaType === 'image/webp' && b.length >= 30) {
      const chunk = b.toString('ascii', 12, 16);
      if (chunk === 'VP8 ') return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
      if (chunk === 'VP8L') {
        return { width: 1 + (((b[22]! & 0x3f) << 8) | b[21]!), height: 1 + (((b[24]! & 0x0f) << 10) | (b[23]! << 2) | ((b[22]! & 0xc0) >> 6)) };
      }
      if (chunk === 'VP8X') return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
      return null;
    }
    if (mediaType === 'image/jpeg') {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1]!;
        if (marker === 0xff) { i += 1; continue; } // fill byte
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; } // no length
        // SOF0..SOF15 carry the frame size, except DHT (C4), JPG (C8) and DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: u16be(b, i + 7), height: u16be(b, i + 5) };
        }
        i += 2 + u16be(b, i + 2);
      }
    }
  } catch {
    /* a truncated header says nothing */
  }
  return null;
}

/**
 * A JPEG's EXIF orientation (1 to 8), read from its APP1 Exif segment; 1 when it has none. Never
 * throws. A phone stores a portrait photo as landscape pixels plus orientation 6 (or 8).
 */
export function jpegOrientation(b: Buffer): number {
  try {
    let i = 2;
    while (i + 4 < b.length && b[i] === 0xff) {
      const marker = b[i + 1]!;
      if (marker === 0xda || marker === 0xd9) break; // the scan starts: no more headers
      const len = u16be(b, i + 2);
      if (marker === 0xe1 && b.toString('ascii', i + 4, i + 10) === 'Exif\0\0') {
        const t = i + 10; // the TIFF header
        const le = b.toString('ascii', t, t + 2) === 'II';
        const u16 = (o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
        const u32 = (o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
        const ifd = t + u32(t + 4);
        const count = u16(ifd);
        for (let k = 0; k < count; k++) {
          const e = ifd + 2 + k * 12;
          if (u16(e) === 0x0112) {
            const v = u16(e + 8);
            return v >= 1 && v <= 8 ? v : 1;
          }
        }
        return 1;
      }
      i += 2 + len;
    }
  } catch {
    /* a malformed segment says nothing */
  }
  return 1;
}

/** The size an image shows at once its orientation is applied (5 to 8 turn it a quarter). */
export function uprightSize(size: ImageSize, orientation: number): ImageSize {
  return orientation >= 5 && orientation <= 8 ? { width: size.height, height: size.width } : size;
}

/** The size a fitted image is sent at: the long edge held to READ_IMAGE_MAX_EDGE, never upscaled. */
export function fittedSize(size: ImageSize): ImageSize {
  const scale = Math.min(1, READ_IMAGE_MAX_EDGE / Math.max(size.width, size.height));
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}

/** Fit one Read image (see the header). Never throws; the original is the fallback. */
export async function fitReadImage(data: Buffer, mediaType: ImageMediaType, fit: ImageFitter): Promise<FittedImage> {
  const stored = imageDimensions(data, mediaType);
  if (!stored || stored.width < 1 || stored.height < 1) return { data, mediaType }; // unknown size: the rail bounds it
  if (Math.max(stored.width, stored.height) <= READ_IMAGE_MAX_EDGE && data.length <= READ_IMAGE_MAX_BYTES) return { data, mediaType };
  // Sized by how it shows: a phone photo stored landscape with orientation 6 is fitted as portrait.
  const orientation = mediaType === 'image/jpeg' ? jpegOrientation(data) : 1;
  const from = uprightSize(stored, orientation);
  const to = fittedSize(from);
  const photo = mediaType === 'image/jpeg' || mediaType === 'image/webp';
  try {
    let out = await fit({ data, mediaType, ...to, orientation, format: photo ? 'jpeg' : 'png' });
    if (out && !photo && out.data.length > READ_IMAGE_MAX_BYTES) {
      // A photo saved as PNG goes JPEG; if that attempt fails, the fitted PNG still stands.
      const jpeg = await fit({ data, mediaType, ...to, orientation, format: 'jpeg' }).catch(() => null);
      if (jpeg) out = jpeg;
    }
    if (out && out.data.length > 0 && out.data.length < data.length) return { data: out.data, mediaType: out.mediaType, fitted: { from, to } };
  } catch {
    /* the original stands */
  }
  return { data, mediaType };
}
