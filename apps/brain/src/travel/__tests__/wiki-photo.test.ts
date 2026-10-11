import { describe, expect, it } from 'vitest';
import { photoOf, wikiPhoto, type WikiFetch } from '../wiki-photo.js';

// Keshav, 11 Oct: places Go picks itself get a real photo with no ixigo page read: Wikipedia's own photo of the place.
const THUMB = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Manali_valley.jpg/330px-Manali_valley.jpg';

describe("a place's photo from Wikipedia", () => {
  it('takes a photograph only: a small original as it is, a big one at 1280 px, never a map, a flag or a disambiguation page', () => {
    expect(photoOf({ originalimage: { source: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Goa_beach.jpg', width: 1024 } }))
      .toBe('https://upload.wikimedia.org/wikipedia/commons/a/ab/Goa_beach.jpg');
    expect(photoOf({ originalimage: { source: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Manali_valley.jpg', width: 4000 }, thumbnail: { source: THUMB } }))
      .toBe('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Manali_valley.jpg/1280px-Manali_valley.jpg');
    expect(photoOf({ originalimage: { source: 'https://upload.wikimedia.org/wikipedia/commons/1/1a/Kerala_locator_map.svg', width: 800 }, thumbnail: { source: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/Kerala_locator_map.svg/330px-Kerala_locator_map.svg.png' } })).toBeNull();
    expect(photoOf({ type: 'disambiguation', thumbnail: { source: THUMB } })).toBeNull();
    expect(photoOf({})).toBeNull();
    expect(photoOf({ originalimage: { source: 'https://example.com/goa.jpg', width: 800 } })).toBeNull();
  });

  it('asks by the full name, then by the name before its first comma, and gives none when neither has a photo in time', async () => {
    const asked: string[] = [];
    const pages: Record<string, unknown> = { Manali: { thumbnail: { source: THUMB } } };
    const fetch: WikiFetch = async (url) => {
      const title = decodeURIComponent(url.split('/page/summary/')[1]!);
      asked.push(title);
      return pages[title] ? { ok: true, json: async () => pages[title] } : { ok: false, json: async () => ({}) };
    };
    expect(await wikiPhoto('Manali, Himachal Pradesh', { fetch })).toBe(THUMB.replace('330px-', '1280px-'));
    expect(asked).toEqual(['Manali,_Himachal_Pradesh', 'Manali']);
    const down: WikiFetch = async () => {
      throw new Error('timed out');
    };
    expect(await wikiPhoto('Spiti Valley', { fetch: down })).toBeNull();
  });
});
