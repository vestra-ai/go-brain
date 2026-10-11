import { describe, expect, it } from 'vitest';
import { photoOf, wikiPhoto, type WikiFetch } from '../wiki-photo.js';

// Keshav, 11 Oct: places Go picks itself get a real photo with no ixigo page read: Wikipedia's own photo of the place,
// its file's page kept for a credit (the lead: never a flag, a coat of arms, a logo or a map, JPEG photos only).
const THUMB = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Manali_valley.jpg/330px-Manali_valley.jpg';
const big = (file: string, project = 'commons') => ({
  originalimage: { source: `https://upload.wikimedia.org/wikipedia/${project}/a/ab/${file}`, width: 4000 },
  thumbnail: { source: `https://upload.wikimedia.org/wikipedia/${project}/thumb/a/ab/${file}/330px-${file}` },
});

describe("a place's photo from Wikipedia", () => {
  it('takes a photograph only, a small original as it is and a big one at 1280 px, with its file page for a credit', () => {
    expect(photoOf({ originalimage: { source: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Goa_beach.jpg', width: 1024 } })).toEqual({
      url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Goa_beach.jpg', page: 'https://commons.wikimedia.org/wiki/File:Goa_beach.jpg',
    });
    expect(photoOf(big('Manali_valley.jpg'))).toEqual({
      url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Manali_valley.jpg/1280px-Manali_valley.jpg',
      page: 'https://commons.wikimedia.org/wiki/File:Manali_valley.jpg',
    });
    // A file on English Wikipedia itself: its page is there.
    expect(photoOf(big('Ooty_lake.jpeg', 'en'))?.page).toBe('https://en.wikipedia.org/wiki/File:Ooty_lake.jpeg');
  });

  it('never a flag, a coat of arms, an emblem, a seal, a logo or a map, even as a JPEG; no SVG or PNG; no disambiguation page', () => {
    for (const file of ['Flag_of_Goa.jpg', 'Coat_of_arms_of_Kerala.jpg', 'Emblem_of_Sikkim.jpg', 'Seal_of_Ladakh.jpg', 'Goa_Tourism_logo.jpg', 'Kerala_locator_map.jpg', 'Map_of_Coorg.jpg']) {
      expect(photoOf(big(file)), file).toBeNull();
    }
    // A place whose name has "map" inside a word is a photo all the same.
    expect(photoOf(big('Mapusa_market.jpg'))?.url).toContain('1280px-Mapusa_market.jpg');
    expect(photoOf({ originalimage: { source: 'https://upload.wikimedia.org/wikipedia/commons/1/1a/Kerala_view.svg', width: 800 }, thumbnail: { source: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/Kerala_view.svg/330px-Kerala_view.svg.png' } })).toBeNull();
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
    expect(await wikiPhoto('Manali, Himachal Pradesh', { fetch })).toEqual({
      url: THUMB.replace('330px-', '1280px-'), page: 'https://commons.wikimedia.org/wiki/File:Manali_valley.jpg',
    });
    expect(asked).toEqual(['Manali,_Himachal_Pradesh', 'Manali']);
    const down: WikiFetch = async () => {
      throw new Error('timed out');
    };
    expect(await wikiPhoto('Spiti Valley', { fetch: down })).toBeNull();
  });
});
