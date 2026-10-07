import { describe, expect, it } from 'vitest';
import { applyConstraints } from '../../filters.js';
import type { TravelOption } from '../../travel.js';
import { readStaysPage, stays, WIDE_FETCH_MS } from '../stays.js';
import { capture, fixture } from './fixtures.js';

const slots = stays.slotsFrom({ area: 'Goa', checkIn: '2026-11-06', checkOut: '2026-11-09' }, { people: 4 });
const SEARCH_URL = 'https://www.ixigo.com/accommodation-search/api/v3/accommodations/search';
const pages = () => [
  // The page's first call ends in the same path plus "/static-metadata": it must never be read as hotels.
  capture('/accommodation-search/api/v3/accommodations/search$', `${SEARCH_URL}/static-metadata`, '{"data":{"filters":[]}}'),
  capture('/accommodation-search/api/v3/accommodations/search$', SEARCH_URL, fixture('stays-goa-page1.json')),
  capture('/accommodation-search/api/v3/accommodations/search$', SEARCH_URL, fixture('stays-goa-page2.json')),
];
const MERITAS =
  'https://www.ixigo.com/hotels/1384544/details?locationId=1366415&locationName=Goa&locationType=S&masterLocationId=48569&countryId=1' +
  '&checkinDate=06112026&checkoutDate=09112026&adultCount=4&roomCount=2&childCount=0&searchLocationId=32&hotelInfoToken=true%7C3001%7C1' +
  '&hName=Meritas%20Auberge%20Calangute%20Goa';

describe('the stays recipe', () => {
  it('searches all of Goa for Goa, two to a room', () => {
    expect(slots).toEqual({
      location: { locationId: 32, locationName: 'Goa', locationType: 'S', masterLocationId: 48569, countryId: 1 },
      checkIn: '2026-11-06', checkOut: '2026-11-09', adults: 4, rooms: 2, filters: [], half: null, wide: true,
    });
    expect(stays.slotsFrom({ area: 'Anjuna, Goa', checkIn: '2026-11-06', checkOut: '2026-11-09', guests: 5 }, { people: 4 })).toMatchObject({ adults: 5, rooms: 3 });
    expect(() => stays.slotsFrom({ area: 'Manali', checkIn: '2026-11-06', checkOut: '2026-11-09' }, { people: 4 })).toThrow('Go has no ixigo hotel location code for "Manali" yet.');
    expect(() => stays.slotsFrom({ area: 'Goa', checkIn: '2026-11-06' }, { people: 4 })).toThrow(/needs the place, check-in and check-out/);
  });

  it("lets ixigo filter the search: to the area asked for, and on the must-haves it has codes for", () => {
    const vagator = stays.slotsFrom({ area: 'Vagator', checkIn: '2026-11-06', checkOut: '2026-11-09', mustHave: ['pool', 'beach'] }, { people: 4 });
    expect(vagator.filters).toEqual(['FL_HF_29', 'PA_C_78528']);
    expect(stays.url(vagator)).toBe(
      'https://www.ixigo.com/hotels/search/result?locationId=32&locationName=Goa&locationType=S&masterLocationId=48569&countryId=1' +
      '&checkinDate=06112026&checkoutDate=09112026&adultCount=4&roomCount=2&childCount=0&filters=FL_HF_29%2CPA_C_78528',
    );
    const anjuna = stays.slotsFrom({ area: 'Anjuna', checkIn: '2026-11-06', checkOut: '2026-11-09', mustHave: ['free_cancellation', 'breakfast'] }, { people: 4 });
    expect(stays.url(anjuna)).toBe(
      'https://www.ixigo.com/hotels/search/result?locationId=1026&locationName=Anjuna&locationType=C&masterLocationId=50347&countryId=1' +
      '&checkinDate=06112026&checkoutDate=09112026&adultCount=4&roomCount=2&childCount=0&filters=MP_FB%2CMP_FC',
    );
  });

  it('searches North Goa as all of Goa, and drops a stay from South Goa', () => {
    const north = stays.slotsFrom({ area: 'North Goa', checkIn: '2026-11-06', checkOut: '2026-11-09' }, { people: 4 });
    expect(north).toMatchObject({ half: 'north', filters: [] });
    expect(stays.url(north)).not.toContain('&filters=');
    // Soul Vacation is in Fatona, Colva: South Goa.
    const titles = stays.extract(pages(), north).map((o) => o.title);
    expect(titles).toHaveLength(6);
    expect(titles).not.toContain('Soul Vacation Resort and Spa, Colva');
    const rows = readStaysPage(fixture('stays-goa.txt'), JSON.parse(fixture('stays-goa-links.json')) as string[]);
    expect(stays.fromAgent(rows, north).map((o) => o.title)).toEqual(titles);
    const south = stays.slotsFrom({ area: 'South Goa', checkIn: '2026-11-06', checkOut: '2026-11-09' }, { people: 4 });
    expect(south).toMatchObject({ half: 'south', filters: [] });
    expect(stays.extract(pages(), south).map((o) => o.title)).toEqual(['Soul Vacation Resort and Spa, Colva']);
  });

  it('takes pages 1 and 2 for all of Goa or a half of it, and page 1 for an area (re-drill 4)', () => {
    const two = {
      capture: [{ match: '/accommodation-search/api/v3/accommodations/search$', required: true, min_count: 2, max_count: 2 }],
      steps: [{ op: 'wait_for', match: '/accommodation-search/api/v3/accommodations/search$' }, { op: 'scroll', times: 3 }],
      // Page 2 sometimes never comes: at 12 s the fetch answers with page 1 (re-drill 6; a cold box gave both by 10 s).
      timeoutMs: WIDE_FETCH_MS,
    };
    expect(WIDE_FETCH_MS).toBe(12_000);
    const at = (area: string) => stays.slotsFrom({ area, checkIn: '2026-11-06', checkOut: '2026-11-09', mustHave: ['pool'] }, { people: 4 });
    for (const area of ['Goa', 'North Goa', 'South Goa']) expect(stays.fetchFor!(at(area)), area).toEqual(two);
    for (const area of ['Vagator', 'Anjuna', 'Candolim']) {
      expect(at(area).wide, area).toBe(false);
      expect(stays.fetchFor!(at(area)), area).toEqual({ capture: stays.capture });
    }
  });

  it('takes what ixigo filtered on as true of every stay it gave, even one that does not list it', () => {
    const withBreakfast = stays.slotsFrom({ area: 'Goa', checkIn: '2026-11-06', checkOut: '2026-11-09', mustHave: ['breakfast'] }, { people: 4 });
    const [meritas] = stays.extract(pages().slice(0, 2), withBreakfast);
    expect(meritas!.facts).toMatchObject({ breakfast: true, pool: true });
    expect(meritas!.highlights).toContain('Breakfast included');
    expect(stays.extract(pages().slice(0, 2), slots)[0]!.facts).toMatchObject({ breakfast: false });
  });

  it('opens the hotel results page the map gives, and keeps only the search call itself', () => {
    expect(stays.url(slots)).toBe(
      'https://www.ixigo.com/hotels/search/result?locationId=32&locationName=Goa&locationType=S&masterLocationId=48569&countryId=1' +
      '&checkinDate=06112026&checkoutDate=09112026&adultCount=4&roomCount=2&childCount=0',
    );
    expect(stays.capture).toEqual([{ match: '/accommodation-search/api/v3/accommodations/search$', required: true }]);
  });

  it('reads both pages of hotels, priced per night and per room with taxes, the whole stay for every room', () => {
    const options = stays.extract(pages(), slots);
    expect(options.map((o) => o.title)).toEqual([
      'Meritas Auberge Calangute Goa', 'Soul Vacation Resort and Spa, Colva', 'De Mandarin Hotel',
      'Zone Connect by The Park, Parra, Goa', '3102bce - A Vedic Resort', 'Calux Joia Do Mar Resort', 'HOLITEL ANJUNA GOA',
    ]);
    expect(options[0]).toMatchObject({
      kind: 'stay',
      priceMinor: 810_400,
      totalMinor: 810_400 * 3 * 2,
      currency: 'INR',
      priceNote: 'per night, per room',
      place: { name: 'Meritas Auberge Calangute Goa', address: 'Candolim', lat: 15.538268089294434, lng: 73.76802062988281 },
      rating: 4.5,
      highlights: ['2.3 km from Candolim Beach', 'Free cancellation', 'Pool'],
      facts: { nights: 3, rooms: 2, area: 'Candolim', stars: 4, rating_out_of_10: 9, reviews: 331, pool: true, breakfast: false, free_cancellation: true, beach_minutes: 29 },
      sourceUrl: MERITAS,
    });
    expect(options[0]!.imageUrl).toMatch(/^https:\/\/q-xx\.bstatic\.com\//);
    expect(options[1]).toMatchObject({ place: { address: 'Fatona, Colva' }, facts: { area: 'Fatona', beach_minutes: 4, breakfast: true } });
    expect(options[4]!.facts).not.toHaveProperty('beach_minutes');
  });

  it('takes page 1 alone when that is all that came back', () => {
    expect(stays.extract(pages().slice(0, 2), slots)).toHaveLength(3);
  });

  it('refuses when the page never loaded its hotels', () => {
    expect(() => stays.extract(pages().slice(0, 1), slots)).toThrow(/did not load its hotels/);
  });

  it('lets the filters keep a stated free cancellation and a beach within 10 minutes', () => {
    const options = stays.extract(pages(), slots).map((o) => ({ ...o, offerId: 'x' }) as TravelOption);
    const near = applyConstraints('stays', { mustHave: ['beach', 'free_cancellation'] }, options);
    expect(near.map((o) => o.title)).toEqual(['Soul Vacation Resort and Spa, Colva']);
  });

  it('reads the same hotels at the same prices and links from the page text, for the fallback runner', () => {
    const rows = readStaysPage(fixture('stays-goa.txt'), JSON.parse(fixture('stays-goa-links.json')) as string[]);
    expect(rows).toHaveLength(7);
    expect(rows[0]).toEqual({
      name: 'Meritas Auberge Calangute Goa', area: 'Candolim', distance: '2.3 km from Candolim Beach', rating: 9, reviews: 331,
      offerings: ['Free Cancellation'], price: 6426, taxes: 1678, hotel_id: 1384544, location_id: 1366415, token: 'true|3001|1',
    });
    const fromPage = stays.fromAgent(rows, slots);
    const fromCalls = stays.extract(pages(), slots);
    expect(fromPage.map((o) => o.title)).toEqual(fromCalls.map((o) => o.title));
    expect(fromPage.map((o) => o.priceMinor)).toEqual(fromCalls.map((o) => o.priceMinor));
    expect(fromPage.map((o) => o.sourceUrl)).toEqual(fromCalls.map((o) => o.sourceUrl));
    expect(fromPage[0]).toMatchObject({ rating: 4.5, facts: { area: 'Candolim', free_cancellation: true, beach_minutes: 29 } });
  });

  it('falls back to the results page for a hotel whose link the page did not show', () => {
    const rows = readStaysPage(fixture('stays-goa.txt'), []);
    expect(rows[0]).not.toHaveProperty('hotel_id');
    expect(stays.fromAgent(rows, slots)[0]!.sourceUrl).toBe(stays.url(slots));
  });

  it('refuses page rows that do not check out', () => {
    expect(() => stays.fromAgent([{ name: 'A villa', price: 'cheap' }], slots)).toThrow(/did not check out/);
  });
});
