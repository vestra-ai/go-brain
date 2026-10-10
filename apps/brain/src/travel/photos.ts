/**
 * Labelled photos (the Server team's 10 Oct B3): a stay's, a vote option's and a destination's, as the App shows them,
 * every one through Go's image cache as a cover photo is. A label is the source's own words for what the photo shows
 * ("Swimming pool", "Baga Beach"), never Go's guess; with none, the photo has no label.
 */
import type { Photo } from '@go/contract';
import type { Images } from './images.js';

/** The most photos a Place, an Option or a DecisionOption carries. */
export const MAX_PHOTOS = 12;
const MAX_LABEL = 40;

/** A source photo: its address alone, or with what it shows. */
export type SourcePhoto = string | { url?: unknown; label?: unknown };

/**
 * Up to twelve photos, in the source's order: each re-hosted by Go's image cache (one that won't fetch is left out), the
 * same photo once, and its label cut to 40 characters, or none when the source gave none.
 */
export async function photosOf(list: readonly SourcePhoto[], images: Pick<Images, 'rehostUrl'>): Promise<Photo[]> {
  const wanted: Array<{ url: string; label: string | null }> = [];
  const seen = new Set<string>();
  for (const p of list) {
    const url = typeof p === 'string' ? p : typeof p?.url === 'string' ? p.url : null;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const raw = typeof p === 'object' && typeof p.label === 'string' ? p.label.replace(/\s+/g, ' ').trim() : '';
    wanted.push({ url, label: raw ? raw.slice(0, MAX_LABEL).trim() : null });
    if (wanted.length === MAX_PHOTOS) break;
  }
  const hosted = await Promise.all(wanted.map(async (w) => ({ ...w, url: await images.rehostUrl(w.url) })));
  const out: Photo[] = [];
  const kept = new Set<string>();
  for (const h of hosted) {
    if (!h.url || kept.has(h.url)) continue;
    kept.add(h.url);
    out.push(h.label ? { url: h.url, label: h.label } : { url: h.url });
  }
  return out;
}

/** A facts row's photo lists (a destination's, a stay's) are for the App's cards, never words: the model never reads them. */
const PHOTO_KEYS = new Set(['photos', 'photo_list']);
export const withoutPhotos = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(row).filter(([k]) => !PHOTO_KEYS.has(k)));
