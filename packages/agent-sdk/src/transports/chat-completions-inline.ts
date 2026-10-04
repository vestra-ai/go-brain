/**
 * Chat Completions lane wire-pass: https image_url parts → inline data: URLs
 * (media-refs S1, spec §Rule 3). This dialect has no file_id image source and
 * its providers (Fireworks, xAI) expose no files endpoint, so edge-inlining is
 * the native idiom that kills provider-side url-fetch flakiness. Canonical
 * history keeps the url form; only the wire copy changes. Clone-only-touched-
 * nodes: identity when nothing resolves; per-part fallback keeps the url form
 * on fetch failure. The media-bytes LRU makes repeated calls substitute the
 * SAME data: URL (prompt-cache prefix stability).
 */
import type OpenAI from 'openai';
import { fetchImageAsBase64 } from './media-bytes.js';

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ImagePart = OpenAI.Chat.Completions.ChatCompletionContentPartImage;

function isHttpsImagePart(p: unknown): p is ImagePart {
  const part = p as { type?: string; image_url?: { url?: unknown } };
  return (
    part?.type === 'image_url' &&
    typeof part.image_url?.url === 'string' &&
    part.image_url.url.startsWith('https://')
  );
}

function collectUrls(messages: Msg[]): string[] {
  const urls = new Set<string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) if (isHttpsImagePart(part)) urls.add(part.image_url.url);
  }
  return [...urls];
}

/** True when ≥1 message carries an https image_url part. */
export function hasHttpsChatImages(messages: Msg[]): boolean {
  return collectUrls(messages).length > 0;
}

export async function inlineChatImageParts(messages: Msg[]): Promise<Msg[]> {
  const urls = collectUrls(messages);
  if (urls.length === 0) return messages;

  const inlined = new Map<string, string>();
  await Promise.all(
    urls.map(async (url) => {
      const bytes = await fetchImageAsBase64(url);
      if (bytes) inlined.set(url, `data:${bytes.mediaType};base64,${bytes.data}`);
    }),
  );
  if (inlined.size === 0) return messages;

  let anyTouched = false;
  const out = messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    let touched = false;
    const parts = m.content.map((part) => {
      if (!isHttpsImagePart(part)) return part;
      const dataUrl = inlined.get(part.image_url.url);
      if (!dataUrl) return part;
      touched = true;
      return { ...part, image_url: { ...part.image_url, url: dataUrl } };
    });
    if (!touched) return m;
    anyTouched = true;
    return { ...m, content: parts } as Msg;
  });

  return anyTouched ? out : messages;
}
