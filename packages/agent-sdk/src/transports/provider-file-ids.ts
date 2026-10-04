/**
 * url → provider file_id, upload-once per process (media-refs S1, spec §Rule 3).
 *
 * Success is cached for the process lifetime so every subsequent round
 * substitutes the SAME file_id — the provider-side prompt-cache prefix depends
 * on that determinism. Failure is deliberately NOT cached: the next round
 * retries (one transient prefix bust beats a permanently degraded lane).
 * In-flight dedup prevents double uploads when calls race. Never throws.
 *
 * Module-level Maps are safe here for the same reason media-bytes' cache is:
 * the url→file_id mapping is pure content addressing, identical for every
 * session in the process (files land in OUR provider org, not a user account).
 */
import Anthropic, { toFile as anthropicToFile } from '@anthropic-ai/sdk';
import OpenAI, { toFile as openaiToFile } from 'openai';
import { fetchImageAsBase64, filenameFromUrl } from './media-bytes.js';

export const ANTHROPIC_FILES_BETA = 'files-api-2025-04-14';

const anthropicIds = new Map<string, string>();
const openaiIds = new Map<string, string>();
const inFlight = new Map<string, Promise<string | null>>();

async function fileIdFor(
  scope: 'a' | 'o',
  ids: Map<string, string>,
  url: string,
  upload: (buf: Buffer, name: string, mime: string) => Promise<string>,
): Promise<string | null> {
  const hit = ids.get(url);
  if (hit) return hit;
  const key = `${scope}:${url}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const p = (async () => {
    try {
      const bytes = await fetchImageAsBase64(url);
      if (!bytes) return null;
      const name = filenameFromUrl(url) ?? 'image';
      const id = await upload(Buffer.from(bytes.data, 'base64'), name, bytes.mediaType);
      ids.set(url, id);
      return id;
    } catch {
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, p);
  return p;
}

export function anthropicFileIdFor(url: string, client: Anthropic): Promise<string | null> {
  return fileIdFor('a', anthropicIds, url, async (buf, name, mime) => {
    const file = await client.beta.files.upload({
      file: await anthropicToFile(buf, name, { type: mime }),
      betas: [ANTHROPIC_FILES_BETA],
    });
    return file.id;
  });
}

export function openaiFileIdFor(url: string, client: OpenAI): Promise<string | null> {
  return fileIdFor('o', openaiIds, url, async (buf, name, mime) => {
    const file = await client.files.create({
      file: await openaiToFile(buf, name, { type: mime }),
      purpose: 'vision',
    });
    return file.id;
  });
}

export function _resetProviderFileIdCachesForTest(): void {
  anthropicIds.clear();
  openaiIds.clear();
  inFlight.clear();
}
