/**
 * A place's lead photo from Wikipedia, for a place card of places Go picked itself (Keshav, 11 Oct: suggestions need no
 * ixigo, and ixigo's explorer was slow and brittle). The page summary's own image, a photograph only: a JPEG on
 * Wikimedia (a map, a flag or a seal is an SVG or a PNG), never a disambiguation page's. Its 1280 px copy, which Go's
 * image cache takes (an original can be over its 5 MB). Null when there is none in time: never a stock or made-up one.
 */
export type WikiFetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const SUMMARY = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
/** How long one page summary may take: the card waits for every place's cover at once (tools.ts COVER_WAIT_MS). */
export const WIKI_WAIT_MS = 2_000;
const PHOTO = /^https:\/\/upload\.wikimedia\.org\/.+\.jpe?g$/i;
/** Wikimedia's own thumbnail steps; 1280 is one it keeps. */
const WIDTH = 1280;

interface Summary {
  type?: string;
  originalimage?: { source?: string; width?: number };
  thumbnail?: { source?: string };
}

/** The photo a summary carries, at most WIDTH wide, or null when it has none that is a photograph. */
export function photoOf(page: Summary): string | null {
  if (page.type === 'disambiguation') return null;
  const original = page.originalimage?.source;
  if (typeof original === 'string' && PHOTO.test(original) && typeof page.originalimage?.width === 'number' && page.originalimage.width <= WIDTH) return original;
  const thumb = page.thumbnail?.source;
  if (typeof thumb !== 'string' || !/\/thumb\//.test(thumb)) return null;
  const wide = thumb.replace(/\/\d+px-([^/]+)$/, `/${WIDTH}px-$1`);
  return PHOTO.test(wide) ? wide : null;
}

/** The place's photo by its full name, then by the name before its first comma ("Manali, Himachal Pradesh", "Manali"). */
export async function wikiPhoto(name: string, d: { fetch?: WikiFetch } = {}): Promise<string | null> {
  const doFetch = d.fetch ?? (fetch as unknown as WikiFetch);
  const titles = [...new Set([name.trim(), name.split(',')[0]!.trim()])].filter((t) => t.length > 1);
  for (const title of titles) {
    try {
      const res = await doFetch(`${SUMMARY}${encodeURIComponent(title.replace(/ /g, '_'))}`, {
        signal: AbortSignal.timeout(WIKI_WAIT_MS),
        headers: { accept: 'application/json', 'user-agent': 'GoTravelAgent/1.0 (https://vestra.ai)' },
      });
      if (!res.ok) continue;
      const photo = photoOf((await res.json()) as Summary);
      if (photo) return photo;
    } catch {
      // None in time, or no such page: the next name, else none.
    }
  }
  return null;
}
