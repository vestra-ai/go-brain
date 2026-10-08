import { describe, expect, it } from 'vitest';
import * as C from '@go/contract';
import { makeTurnCtx } from '../../composer/tools.js';
import type { OptionsCardT } from '../cards.js';
import { goaPack } from '../../tasks/testing/goa.js';
import { stayDetails, trainDetails } from '../details.js';
import type { ResultOption, ResultsStore } from '../results.js';
import { putUpCard } from '../tools.js';

// Riva Beach Resort as ixigo's list gave it (staging, 8 Oct; recipes/__fixtures__/stays-anjuna-full.json), read by
// hotels.search for 6 to 9 Nov, two rooms.
const RIVA: ResultOption = {
  kind: 'stay', title: 'Riva Beach Resort', priceMinor: 990_400, currency: 'INR', priceNote: 'per night, per room', totalMinor: 990_400 * 3 * 2,
  place: { name: 'Riva Beach Resort', address: 'Mandrem', lat: 15.66, lng: 73.71, timezone: 'Asia/Kolkata' },
  imageUrl: 'https://pix8.agoda.net/property/109600/0/a.jpeg?ce=0&s=840x460',
  imageUrls: ['https://pix8.agoda.net/property/109600/0/a.jpeg?ce=0&s=1024x768', 'https://pix8.agoda.net/hotelImages/109600/-1/b.jpg?ce=0&s=1024x768'],
  amenities: ['Free Wifi', 'Swimming pool at the property', 'Private Beach', 'Restaurants'],
  rating: 4.1, highlights: ['120 m from Mandrem Beach', 'Breakfast included', 'Pool'],
  facts: {
    nights: 3, rooms: 2, area: 'Mandrem', distance: '120 m from Mandrem Beach', stars: 4, rating_out_of_10: 8.1, rating_word: 'Excellent',
    reviews: 1737, pool: true, breakfast: true, free_cancellation: false, beach_minutes: 2,
  },
  sourceUrl: 'https://www.ixigo.com/hotels/4599837/details',
};
const ASK = { area: 'North Goa', checkIn: '2026-11-06', checkOut: '2026-11-09', mustHave: ['pool' as const, 'beach' as const], maxPriceMinor: 1_000_000 };

describe("a stay's details sheet", () => {
  it("is what the search read, nothing made up: photos, why it fits the ask, the stay split between its people, ixigo's words and rating", () => {
    const d = stayDetails(RIVA, ASK, 4, ['https://go.test/img/u1.jpg', 'https://go.test/img/u2.jpg'])!;
    expect(d).toEqual({
      gallery_urls: ['https://go.test/img/u1.jpg', 'https://go.test/img/u2.jpg'],
      why: ['Has a pool, as asked', 'About 2 min on foot to the beach', 'Within ₹10,000 a night'],
      costs: [{ label: '3 nights, each of 4', emoji: '🛏️', amount_minor: 1_485_600, currency: 'INR' }],
      total_minor: 1_485_600,
      amenities: ['Free Wifi', 'Swimming pool at the property', 'Private Beach', 'Restaurants'],
      facts: [
        { label: 'Area', value: 'Mandrem' },
        { label: 'Nearby', value: '120 m from Mandrem Beach' },
        { label: 'Hotel class', value: '4-star' },
        { label: 'Guests say', value: 'Excellent' },
        { label: 'Whole stay', value: '₹59,424 for 3 nights, 2 rooms' },
      ],
      rating: 8.1,
      review_count: 1737,
    });
    // The contract takes it as it is.
    expect(C.OptionDetails.parse(d)).toEqual(d);
  });

  it('says free cancellation only when ixigo did, with a date only when Go has one, and leaves out what ixigo left out', () => {
    const fc = { ...RIVA, facts: { ...RIVA.facts, free_cancellation: true } };
    expect(stayDetails(fc, {}, 4, [])?.cancellation).toBe('Free cancellation');
    expect(stayDetails({ ...fc, refundableUntil: '2026-11-04T23:59:00+05:30' }, {}, 4, [])?.cancellation).toBe('Free cancellation until 4 Nov');
    // Nothing asked: no why. No people known: no split. No photos, amenities or rating: none of those.
    const bare = stayDetails({ ...RIVA, amenities: [], facts: { nights: 3, rooms: 2 } }, {}, 0, [])!;
    expect(bare).toEqual({ facts: [{ label: 'Whole stay', value: '₹59,424 for 3 nights, 2 rooms' }] });
    expect(bare).not.toHaveProperty('why');
    expect(bare).not.toHaveProperty('costs');
    expect(bare).not.toHaveProperty('gallery_urls');
  });
});

describe("a train's details sheet", () => {
  it('is its class, seats, chance to confirm, the journey and Tatkal, as rows', () => {
    const train: ResultOption = {
      kind: 'train', title: 'Lalbagh Sf Exp 12608', priceMinor: 52_500, currency: 'INR', priceNote: 'per person, CC', highlights: [],
      facts: { class_code: 'CC', availability: 'WL 10', chance: 91, duration_min: 345, tatkal_availability: 'Available 12', tatkal_fare_minor: 68_000 },
    };
    expect(trainDetails(train)).toEqual({
      facts: [
        { label: 'Class', value: 'AC Chair Car (CC)' },
        { label: 'Seats', value: 'WL 10' },
        { label: 'Chance to confirm', value: "91%, ixigo's prediction" },
        { label: 'Journey', value: '5 h 45 m' },
        { label: 'Tatkal', value: 'Available 12, ₹680' },
      ],
    });
    expect(trainDetails({ ...train, facts: {} })).toBeNull();
  });
});

describe('the options card', () => {
  it("carries each stay's sheet, its photos through Go's image cache, and the stay's place with its time zone", async () => {
    const results = { saveCard: async () => undefined, card: async () => null } as unknown as ResultsStore;
    const images = { rehostUrl: async (u: string) => `https://go.test/img/${u.endsWith('s=1024x768') ? (u.includes('/b.jpg') ? 'b' : 'a') : 'card'}.jpg` } as never;
    const ctx = makeTurnCtx({ tripId: 't_goa', turnId: 'turn_d1', link: {} as never, pack: goaPack(), wake: [], signal: new AbortController().signal });
    const set = { resultsId: 'r_d1', tripId: 't_goa', optionKind: 'stay' as const, source: 'search' as const, query: ASK, options: [RIVA], checkedAt: '2026-10-08T12:00:00.000Z' };
    await putUpCard(set, [1], { title: 'Pool stays in North Goa', line: 'x' }, ctx, { results, images });
    const option = (ctx.cards[0] as OptionsCardT).options[0]!;
    expect(option.image_url).toBe('https://go.test/img/card.jpg');
    expect(option.details?.gallery_urls).toEqual(['https://go.test/img/a.jpg', 'https://go.test/img/b.jpg']);
    // The Goa five: the stay split five ways.
    expect(option.details?.costs).toEqual([{ label: '3 nights, each of 5', emoji: '🛏️', amount_minor: 1_188_480, currency: 'INR' }]);
    expect(option.place).toMatchObject({ name: 'Riva Beach Resort', timezone: 'Asia/Kolkata' });
  });
});
