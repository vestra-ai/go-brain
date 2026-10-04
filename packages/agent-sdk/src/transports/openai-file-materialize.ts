/**
 * OpenAI Responses lane wire-pass: https input_image urls → uploaded file_id
 * (media-refs S1, spec §Rule 3 — "never remote-URL": OpenAI's server-side url
 * fetch fails >10% on signed URLs, the exact mechanism Codex rejects).
 *
 * Fallback ladder per image: file_id → inline data: URL (the upload failed but
 * the bytes are already in the media-bytes LRU from the attempt) → keep the
 * url form as last resort (bytes unfetchable). Clone-only-touched-nodes; when
 * nothing changes, the ORIGINAL array reference is returned. Same-url images
 * substitute the SAME cached file_id call-to-call (prompt-cache stability).
 */
import type OpenAI from 'openai';
import { openaiFileIdFor } from './provider-file-ids.js';
import { fetchImageAsBase64 } from './media-bytes.js';

type InputItem = OpenAI.Responses.ResponseInputItem;

interface HttpsImagePart {
  type: 'input_image';
  image_url: string;
  detail?: string;
}

function isHttpsImagePart(part: unknown): part is HttpsImagePart {
  const p = part as { type?: string; image_url?: unknown };
  return (
    p?.type === 'input_image' &&
    typeof p.image_url === 'string' &&
    p.image_url.startsWith('https://')
  );
}

function partsOf(item: unknown): unknown[] | null {
  const it = item as { content?: unknown; output?: unknown };
  if (Array.isArray(it?.content)) return it.content;
  if (Array.isArray(it?.output)) return it.output;
  return null;
}

function collectUrls(input: InputItem[]): string[] {
  const urls = new Set<string>();
  for (const item of input) {
    const parts = partsOf(item);
    if (!parts) continue;
    for (const part of parts) if (isHttpsImagePart(part)) urls.add(part.image_url);
  }
  return [...urls];
}

/** True when the input carries ≥1 https-sourced input_image part. */
export function hasHttpsInputImages(input: InputItem[]): boolean {
  return collectUrls(input).length > 0;
}

export async function materializeOpenAIFileIds(
  input: InputItem[],
  client: OpenAI,
): Promise<InputItem[]> {
  const urls = collectUrls(input);
  if (urls.length === 0) return input;

  // Resolve each unique url down the ladder once, in parallel.
  const substitutions = new Map<string, { file_id: string } | { image_url: string }>();
  await Promise.all(
    urls.map(async (url) => {
      const id = await openaiFileIdFor(url, client);
      if (id) {
        substitutions.set(url, { file_id: id });
        return;
      }
      const bytes = await fetchImageAsBase64(url);
      if (bytes) {
        substitutions.set(url, { image_url: `data:${bytes.mediaType};base64,${bytes.data}` });
      }
      // else: keep the url form — no substitution entry.
    }),
  );
  if (substitutions.size === 0) return input;

  let anyTouched = false;
  const out = input.map((item) => {
    const parts = partsOf(item);
    if (!parts) return item;
    let touched = false;
    const nextParts = parts.map((part) => {
      if (!isHttpsImagePart(part)) return part;
      const sub = substitutions.get(part.image_url);
      if (!sub) return part;
      touched = true;
      const { image_url: _drop, ...rest } = part;
      return { ...rest, ...sub };
    });
    if (!touched) return item;
    anyTouched = true;
    const container = item as unknown as { content?: unknown; output?: unknown };
    return Array.isArray(container.content)
      ? ({ ...(item as object), content: nextParts } as InputItem)
      : ({ ...(item as object), output: nextParts } as InputItem);
  });

  return anyTouched ? out : input;
}
