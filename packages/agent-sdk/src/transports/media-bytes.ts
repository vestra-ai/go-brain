/**
 * Edge materialization bytes — fetch an image ref's bytes at request build.
 *
 * Media-refs S1 (spec §Rule 3): the Gemini and Chat Completions lanes inline
 * image bytes into the wire body instead of relying on provider-side URL fetch
 * (>10% observed failure on signed URLs), and the file_id lanes need the bytes
 * to upload. Module-level LRU keyed by URL: the mapping is pure content
 * addressing (same URL → same bytes), so it is safe across the multi-session
 * process by construction; bounded so a long-lived runner can't grow it
 * unbounded. Never throws — a null return tells the caller to fall back to the
 * lane's current form. Failures are deliberately NOT cached (next round
 * retries; a transient CDN blip must not degrade the lane for the session).
 */

const CACHE_MAX_ENTRIES = 48;
const FETCH_TIMEOUT_MS = 10_000;

const cache = new Map<string, { data: string; mediaType: string }>();
const inFlight = new Map<string, Promise<{ data: string; mediaType: string } | null>>();

const EXT_TO_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

function mediaTypeFor(url: string, contentType: string | null): string {
  if (contentType && contentType.startsWith('image/')) return contentType.split(';')[0]!.trim();
  const name = filenameFromUrl(url);
  const ext = name?.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_MIME[ext] ?? 'image/jpeg';
}

/**
 * Decoded basename of the url's pathname (query stripped); null when
 * unparsable or not http(s) — a data: URL "parses" but its pathname is the
 * payload, not a name.
 */
export function filenameFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const base = u.pathname.split('/').pop() ?? '';
    const decoded = decodeURIComponent(base);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

export async function fetchImageAsBase64(
  url: string,
): Promise<{ data: string; mediaType: string } | null> {
  const hit = cache.get(url);
  if (hit) return hit;
  const pending = inFlight.get(url);
  if (pending) return pending;

  const p = (async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      const entry = {
        data: buf.toString('base64'),
        mediaType: mediaTypeFor(url, res.headers.get('content-type')),
      };
      if (cache.size >= CACHE_MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(url, entry);
      return entry;
    } catch {
      return null;
    } finally {
      inFlight.delete(url);
    }
  })();
  inFlight.set(url, p);
  return p;
}

export function _resetMediaBytesCacheForTest(): void {
  cache.clear();
  inFlight.clear();
}
