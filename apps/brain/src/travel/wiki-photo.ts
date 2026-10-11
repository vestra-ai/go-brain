/**
 * A place's lead photo from Wikipedia, for a place card of places Go picked itself (Keshav, 11 Oct: suggestions need no
 * ixigo, and ixigo's explorer was slow and brittle). The page summary's own image, a photograph only: a JPEG on
 * Wikimedia, never a flag, a coat of arms, an emblem, a seal, a logo or a map (by its file's name; an SVG or a PNG is
 * none of them anyway), never a disambiguation page's. Its 1280 px copy, which Go's image cache takes (an original can
 * be over its 5 MB). With its file's own page, kept for its credit. Null when there is none in time: never a stock or
 * made-up one.
 */
export type WikiFetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** A photo, and the page of its file on Wikimedia (its author and licence, for a credit). */
export interface WikiPhoto {
  url: string;
  page: string;
}

const SUMMARY = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
/** How long one page summary may take: the card waits for every place's cover at once (tools.ts COVER_WAIT_MS). */
export const WIKI_WAIT_MS = 2_000;
const PHOTO = /^https:\/\/upload\.wikimedia\.org\/wikipedia\/([a-z]+)\/.+\.jpe?g$/i;
/** A file that is a symbol or a map, not a photo of the place, by the words in its name. */
const NOT_A_PHOTO = /(^|[_\-\s.(,])(flag|coat[_\s-]of[_\s-]arms|emblem|seal|logo|locator|map)([_\-\s.),]|$)/i;
/** Wikimedia's own thumbnail steps; 1280 is one it keeps. */
const WIDTH = 1280;

interface Summary {
  type?: string;
  originalimage?: { source?: string; width?: number };
  thumbnail?: { source?: string };
}

/** A Wikimedia image's file name and its project ("commons", "en"), from its address or its thumbnail's. */
function fileOf(url: string): { name: string; project: string } | null {
  const parts = new URL(url).pathname.split('/').filter((x) => x !== '');
  // /wikipedia/<project>/[thumb/]<a>/<ab>/<File.jpg>[/<1280px-File.jpg>]
  const thumb = parts[2] === 'thumb';
  const name = parts[thumb ? 5 : 4];
  return parts[0] === 'wikipedia' && parts[1] && name ? { name: decodeURIComponent(name), project: parts[1] } : null;
}

/** A photo's file page: Commons for a Commons file, the Wikipedia it is on for any other. */
function pageOf(file: { name: string; project: string }): string {
  const host = file.project === 'commons' ? 'commons.wikimedia.org' : `${file.project}.wikipedia.org`;
  return `https://${host}/wiki/File:${encodeURIComponent(file.name.replace(/ /g, '_'))}`;
}

/** The photo a summary carries, at most WIDTH wide, with its file's page; null when it has none that is a photograph. */
export function photoOf(page: Summary): WikiPhoto | null {
  if (page.type === 'disambiguation') return null;
  const original = page.originalimage?.source;
  const thumb = page.thumbnail?.source;
  const url =
    typeof original === 'string' && PHOTO.test(original) && typeof page.originalimage?.width === 'number' && page.originalimage.width <= WIDTH
      ? original
      : typeof thumb === 'string' && /\/thumb\//.test(thumb) ? thumb.replace(/\/\d+px-([^/]+)$/, `/${WIDTH}px-$1`) : null;
  if (!url || !PHOTO.test(url)) return null;
  const file = fileOf(url);
  if (!file || NOT_A_PHOTO.test(file.name)) return null;
  return { url, page: pageOf(file) };
}

/** The place's photo by its full name, then by the name before its first comma ("Manali, Himachal Pradesh", "Manali"). */
export async function wikiPhoto(name: string, d: { fetch?: WikiFetch } = {}): Promise<WikiPhoto | null> {
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
