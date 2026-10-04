import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import type { ImageMediaType } from '../contract/blocks.js';

/**
 * read-media.ts — binary media detection for the Read tool (multimodal Read).
 *
 * The Read tool's utf8 path garbles binary files. This module lets it detect
 * images (PNG/JPEG/GIF/WEBP) and PDFs and divert them off that path: images are
 * returned as an image content block the model can actually see; PDFs are refused
 * with actionable guidance (no dependency-free PDF text/render path exists in the
 * SDK package — see the Read description).
 *
 * Detection is by extension AND magic bytes, never the extension alone: the
 * extension only NOMINATES a candidate (cheap gate that keeps the common text read
 * untouched); the leading bytes DECIDE. A `.png` that isn't a PNG never yields a
 * broken image block — it falls through to the text path.
 */

/** Enough leading bytes to cover every signature below (WEBP needs bytes 0–11). */
export const MEDIA_HEADER_BYTES = 16;

const IMAGE_EXTS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/**
 * Extension → media candidate, or null to read as text. Uses `extname` so a dot in
 * a parent directory (`dir.png/file`) or a leading-dot file (`.bashrc`) is not an
 * extension. This is a GATE only — the candidate is confirmed by magic bytes.
 */
export function mediaCandidate(filePath: string): 'image' | 'pdf' | null {
  const ext = extname(filePath).slice(1).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  return null;
}

/**
 * The actual image media type from a buffer's magic bytes, or null if the leading
 * bytes are not one of the four supported signatures. Authoritative over the
 * extension: a `.jpg` holding PNG bytes reads as `image/png`.
 */
export function detectImageMediaType(buf: Buffer): ImageMediaType | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return 'image/png';
  // JPEG: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // GIF: "GIF87a" / "GIF89a"
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61
  ) return 'image/gif';
  // WEBP: "RIFF" .... "WEBP"
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return 'image/webp';
  return null;
}

/** True when the buffer starts with the `%PDF-` signature. */
export function isPdfHeader(buf: Buffer): boolean {
  return (
    buf.length >= 5 &&
    buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2d
  );
}

/**
 * The `returnsContentBlocks` envelope the tool dispatcher unwraps into blocks (each
 * image item's `mimeType` → `ImageBlock.mediaType`). The single source of the
 * image-result shape for the Read tool. Mirrors the browser-control screenshot
 * envelope so the image flows through the already-proven transport image-block path
 * — PLUS a leading text caption.
 *
 * The caption is load-bearing for graceful degradation: two arms flatten a
 * tool_result to text and drop the image (Chat Completions `role:'tool'` and Gemini
 * `functionResponse` are text-only by API design; only Anthropic and OpenAI
 * Responses forward an image in a tool_result). On those arms the caption is the
 * whole output, so the model still learns an image was read and its type/size; on
 * image-capable arms the model sees the caption then the image.
 */
export interface ImageToolResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: ImageMediaType }
  >;
}

export function imageEnvelope(caption: string, data: string, mimeType: ImageMediaType): ImageToolResult {
  return { content: [{ type: 'text', text: caption }, { type: 'image', data, mimeType }] };
}

/**
 * Read only the leading `MEDIA_HEADER_BYTES` of a file for magic-byte detection —
 * cheap even for a huge, mislabeled file (a 200MB `.png` that is really text is
 * sniffed with a 16-byte read, then falls through to the text path's own guards).
 */
export async function readMediaHeader(abs: string): Promise<Buffer> {
  const fh = await open(abs, 'r');
  try {
    const buf = Buffer.alloc(MEDIA_HEADER_BYTES);
    const { bytesRead } = await fh.read(buf, 0, MEDIA_HEADER_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}
