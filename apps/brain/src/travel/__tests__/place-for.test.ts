import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as C from '@go/contract';
import { BOOK_DIR, loadBook } from '../book/book.js';
import { createEngine, type EngineAnswer } from '../book/engine.js';
import type { Suggestion } from '../book/lookup.js';
import { TravelError } from '../mcp-travel.js';
import { createPlaceFor, timezoneOf } from '../place-for.js';
import { capture } from '../recipes/__tests__/fixtures.js';

const { book } = loadBook();
const sample = (name: string): string => readFileSync(`${BOOK_DIR}samples/${name}`, 'utf8');

/** place_details as a map, the way the table keeps it: by the words, once. */
function memoryPool() {
  const rows = new Map<string, { place: unknown; kind: string; within: string[] }>();
  return {
    rows,
    query: async (sql: string, params: unknown[]) => {
      if (sql.startsWith('select')) {
        const row = rows.get(params[0] as string);
        return { rows: row ? [row] : [] };
      }
      if (!rows.has(params[0] as string)) rows.set(params[0] as string, { place: params[1], kind: params[2] as string, within: params[3] as string[] });
      return { rows: [] };
    },
  };
}

const OLD_MANALI: Suggestion = {
  name: 'Old Manali', line: 'Manali, Himachal Pradesh', all: false, country: 'India', placeName: '',
  place: { locationId: 3588, locationName: 'Old Manali', locationType: 'L', masterLocationId: 31346, countryId: 1, lat: 32.2521478, lng: 77.1787114 },
};
const guide = (photo: string | null): EngineAnswer => ({
  as: 'facts', title: 'Manali', rows: [{ destination: 'Manali, India', ...(photo ? { photo } : {}) }], page: 'https://www.ixigo.com/plan/manali', checkedAt: '2026-10-08T12:00:00.000Z', ms: 400,
});

describe("a place by its words, as ixigo knows it (contract 1.1's Place)", () => {
  it("is ixigo's place: its id, where it is, its time zone from its country, the guide's photo, and what it lies within; kept for good", async () => {
    const pool = memoryPool();
    const asked: string[] = [];
    const engine = {
      suggest: async (_id: string, words: string) => {
        asked.push(`box:${words}`);
        return OLD_MANALI;
      },
      answer: async (_id: string, given: Record<string, unknown>) => {
        asked.push(`guide:${String(given['place'])}`);
        // Old Manali has no guide of its own: Manali's photo.
        if (given['place'] === 'Old Manali') throw new TravelError('refused', "ixigo's page did not send the guide.");
        return guide('https://imagedelivery.net/pyX3WeyB0txAwUsxwjq_eg/manali/public');
      },
    };
    const images = { rehostUrl: async (u: string) => (u.includes('imagedelivery') ? 'https://go.test/img/manali.jpg' : null) };
    const placeFor = createPlaceFor({ pool: pool as never, engine: engine as never, images });
    const got = await placeFor('old manali', { tripId: 't_goa' });
    expect(got).toEqual({
      place: {
        name: 'Old Manali', place_id: 'ixigo:3588', lat: 32.2521478, lng: 77.1787114, timezone: 'Asia/Kolkata', photo_url: 'https://go.test/img/manali.jpg',
      },
      kind: 'area',
      within: ['Manali', 'Himachal Pradesh'],
    });
    expect(C.Place.parse(got!.place)).toEqual(got!.place);
    expect(asked).toEqual(['box:old manali', 'guide:Old Manali', 'guide:Manali']);
    // The same words again, in any trip: nothing loads.
    expect(await placeFor('Old  Manali', { tripId: 't_other' })).toEqual(got);
    expect(asked).toHaveLength(3);
  });

  it('leaves out what ixigo does not say: no time zone for a country with several, no photo with no guide; nothing for words ixigo does not know', async () => {
    const vegas: Suggestion = { name: 'Las Vegas', line: 'Nevada', all: false, country: 'United States', placeName: 'Las Vegas', place: { locationId: 9, locationType: 'C' } };
    const engine = { suggest: async (_id: string, words: string) => (words === 'Las Vegas' ? vegas : null), answer: async () => guide(null) };
    const placeFor = createPlaceFor({ pool: memoryPool() as never, engine: engine as never, images: { rehostUrl: async () => null } });
    expect(await placeFor('Las Vegas', { tripId: 't_goa' })).toEqual({ place: { name: 'Las Vegas', place_id: 'ixigo:9' }, kind: 'city', within: ['Nevada'] });
    expect(await placeFor('Nowhere at all', { tripId: 't_goa' })).toBeNull();
    expect(timezoneOf('India')).toBe('Asia/Kolkata');
    expect(timezoneOf('United States')).toBeNull();
    expect(timezoneOf(null)).toBeNull();
  });
});

describe("a destination's photos (the Server team's 10 Oct B3)", () => {
  it("are the guide's, labelled, through Go's image cache: the place itself first, then its places to visit by name", async () => {
    const goa: Suggestion = { name: 'Goa', line: 'India', all: false, country: 'India', placeName: 'Goa', place: { locationId: 48569, locationType: 'S' } };
    const runner = { read: async (_t: string, url: string) => ({ captures: [capture('/plan/goa$', url, sample('plan.destination.html'))], finalUrl: url }) };
    const guideEngine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-08T12:00:00Z') });
    const engine = { suggest: async () => goa, answer: guideEngine.answer };
    const images = { rehostUrl: async (u: string) => `https://go.test/img/${u.split('/').at(u.endsWith('/public') ? -2 : -1)!.slice(0, 12)}.jpg` };
    const got = await createPlaceFor({ pool: memoryPool() as never, engine: engine as never, images })('Goa', { tripId: 't_goa' });
    const photos = got!.place.photos!;
    expect(photos).toHaveLength(12);
    expect(photos.slice(0, 4)).toEqual([
      { url: 'https://go.test/img/goa.jpg', label: 'Goa, India' },
      { url: expect.stringMatching(/^https:\/\/go\.test\/img\//), label: 'Baga Beach' },
      { url: expect.stringMatching(/^https:\/\/go\.test\/img\//), label: 'Dudhsagar Falls' },
      { url: expect.stringMatching(/^https:\/\/go\.test\/img\//), label: 'Cape Goa Cliff' },
    ]);
    expect(got!.place.photo_url).toBe('https://go.test/img/goa.jpg');
    expect(C.Place.parse(got!.place)).toEqual(got!.place);
  });
});

describe("ixigo's hotel box, asked for one place", () => {
  it('answers the pick a person would make, with its region, its country and where it is', async () => {
    const runner = {
      read: async (_t: string, url: string) => ({
        captures: [capture('/hotels-autocompleter/api/v2/results', url, sample('hotels.place_lookup.old-manali.json'))], finalUrl: url,
      }),
    };
    const engine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-08T12:00:00Z') });
    const s = await engine.suggest('hotels.place_lookup', 'Old Manali', { tripId: 't_goa' });
    expect(s).toMatchObject({ name: 'Old Manali', line: 'Manali, Himachal Pradesh', country: 'India', place: { locationId: 3588, locationType: 'L', lat: 32.2521478 } });
    // No computer to ask from: nothing.
    const none = createEngine({ book, runner: () => null, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-08T12:00:00Z') });
    expect(await none.suggest('hotels.place_lookup', 'Old Manali', { tripId: 't_goa' })).toBeNull();
  });
});
