import { describe, expect, it } from 'vitest';
import * as C from '@go/contract';
import { makeTurnCtx } from '../../composer/tools.js';
import type { OptionsCardT } from '../cards.js';
import { goaPack } from '../../tasks/testing/goa.js';
import { stayDetails, trainDetails } from '../details.js';
import type { ResultOption, ResultsStore } from '../results.js';
import { placeOptions } from '../places-card.js';
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

  it("says each person's share of the whole stay against a budget a head, split by the head count ixigo priced it for", () => {
    // ixigo priced it for four: ₹59,424 is ₹14,856 each, within ₹15,000 a head; the sheet splits it by ixigo's head count.
    const four = { ...RIVA, facts: { ...RIVA.facts, guests: 4 } };
    const d = stayDetails(four, { maxShareMinor: 1_500_000 }, 5, [])!;
    expect(d.why).toEqual(['₹14,856 each for the stay, within ₹15,000 a head']);
    expect(d.costs).toEqual([{ label: '3 nights, each of 4', emoji: '🛏️', amount_minor: 1_485_600, currency: 'INR' }]);
    // A share that isn't whole rupees is said to the rupee (staging, 10 Oct: "₹14,366.40 each" for ₹71,832 between five).
    const villa = { ...RIVA, totalMinor: 7_183_200, facts: { ...RIVA.facts, guests: 5 } };
    expect(stayDetails(villa, { maxShareMinor: 1_500_000 }, 5, [])?.why).toEqual(['₹14,366 each for the stay, within ₹15,000 a head']);
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
  // The Server team's rev 5 (R2): a card of places, each with ixigo's estimate a person and a sheet of why and getting
  // there; its first three get their own place and guide in the background (places-card.ts showPlaces).
  it("puts places up with ixigo's estimate a person and their sheet, and hands the first three on for their own photos", async () => {
    const results = { saveCard: async () => undefined, card: async () => null } as unknown as ResultsStore;
    const images = { rehostUrl: async () => 'https://go.test/img/x.jpg' } as never;
    const ctx = makeTurnCtx({ tripId: 't_goa', turnId: 'turn_pl', link: {} as never, pack: goaPack(), wake: [], signal: new AbortController().signal });
    const place = (name: string) => ({ place: name, estimate_minor: 900_000, estimate_nights: 3, getting_there_minor: 17_000, kind: ['beaches'] });
    const options = placeOptions([place('Agra, India'), place('Goa, India'), place('Manali, India'), place('Ladakh, India')]);
    const set = { resultsId: 'r_pl', tripId: 't_goa', optionKind: 'place' as const, source: 'search' as const, query: {}, options, checkedAt: '2026-10-11T02:00:00.000Z' };
    const handed: Array<Array<{ cardId: string; optionId: string; name: string }>> = [];
    await putUpCard(set, [1, 2, 3, 4], { title: 'Where to go in December', line: 'x' }, ctx, { results, images, showPlaces: (_trip, picks) => handed.push(picks) });
    const card = ctx.cards[0] as OptionsCardT;
    expect(card.option_kind).toBe('place');
    expect(card.options[0]).toMatchObject({
      title: 'Agra, India', price_minor: 900_000, price_note: 'a person, 3 nights', price_min_minor: 900_000, place: { name: 'Agra, India' },
      details: { why: ['Beaches'], facts: [{ label: 'Getting there', value: 'from ₹170 a person' }, { label: 'The trip', value: "about ₹9,000 a person for 3 nights, ixigo's estimate" }] },
    });
    expect(handed).toEqual([card.options.slice(0, 3).map((o) => ({ cardId: card.card_id, optionId: o.option_id, name: o.title }))]);
  });

  // The Server team's rev 5 (R1): labelled photos on every stay, not the top pick's alone. The card's next two stays go
  // with the top pick, their own pages read after its page, in the background (register.ts showPick).
  it("hands the top pick's next two stays with it, each by its own ixigo page; none off ixigo.com, none past the third", async () => {
    const results = { saveCard: async () => undefined, card: async () => null } as unknown as ResultsStore;
    const images = { rehostUrl: async () => 'https://go.test/img/x.jpg' } as never;
    const ctx = makeTurnCtx({ tripId: 't_goa', turnId: 'turn_d5', link: {} as never, pack: goaPack(), wake: [], signal: new AbortController().signal });
    const villa = (id: number, title: string, sourceUrl = `https://www.ixigo.com/hotels/${id}/details`) => ({ ...RIVA, title, sourceUrl });
    const set = {
      resultsId: 'r_d5', tripId: 't_goa', optionKind: 'stay' as const, source: 'search' as const, query: ASK, checkedAt: '2026-10-08T12:00:00.000Z',
      options: [villa(1, 'One'), villa(2, 'Two'), villa(3, 'Three', 'https://example.com/three'), villa(4, 'Four')],
    };
    const calls: Array<{ page: string; more: Array<{ page: string; name: string; kind?: string; cardId: string; optionId: string }> }> = [];
    await putUpCard(set, [1, 2, 3, 4], { title: 'Stays', line: 'x' }, ctx, { results, images, showPick: (_trip, pick, more) => calls.push({ page: pick.page, more: more ?? [] }) });
    const card = ctx.cards[0] as OptionsCardT;
    expect(calls).toEqual([{
      page: 'https://www.ixigo.com/hotels/1/details',
      more: [{ page: 'https://www.ixigo.com/hotels/2/details', name: 'Two', kind: 'stay', cardId: card.card_id, optionId: card.options[1]!.option_id }],
    }]);
  });

  it("carries each stay's sheet, its photos through Go's image cache, and the stay's place with its time zone", async () => {
    const results = { saveCard: async () => undefined, card: async () => null } as unknown as ResultsStore;
    const images = { rehostUrl: async (u: string) => `https://go.test/img/${u.endsWith('s=1024x768') ? (u.includes('/b.jpg') ? 'b' : 'a') : 'card'}.jpg` } as never;
    const ctx = makeTurnCtx({ tripId: 't_goa', turnId: 'turn_d1', link: {} as never, pack: goaPack(), wake: [], signal: new AbortController().signal });
    const set = { resultsId: 'r_d1', tripId: 't_goa', optionKind: 'stay' as const, source: 'search' as const, query: ASK, options: [RIVA], checkedAt: '2026-10-08T12:00:00.000Z' };
    const opened: Array<{ page: string; name: string; kind?: string; cardId: string; optionId: string }> = [];
    await putUpCard(set, [1], { title: 'Pool stays in North Goa', line: 'x' }, ctx, { results, images, showPick: (_trip, pick) => opened.push(pick) });
    // The top pick opens on the stage once its card is up, its card clicked by its name, for the room to watch (10 Oct).
    // Its card and option go with it, so the photos its page lists can replace the search's there (pick-photos.ts).
    const cardId = (ctx.cards[0] as OptionsCardT).card_id;
    expect(opened).toEqual([{ page: 'https://www.ixigo.com/hotels/4599837/details', name: 'Riva Beach Resort', kind: 'stay', cardId, optionId: (ctx.cards[0] as OptionsCardT).options[0]!.option_id }]);
    // A stay from anywhere but ixigo.com opens nothing.
    const elsewhere = makeTurnCtx({ tripId: 't_goa', turnId: 'turn_d2', link: {} as never, pack: goaPack(), wake: [], signal: new AbortController().signal });
    await putUpCard({ ...set, resultsId: 'r_d2', options: [{ ...RIVA, sourceUrl: 'https://example.com/villa' }] }, [1], { title: 'x', line: 'x' }, elsewhere, { results, images, showPick: (_trip, pick) => opened.push(pick) });
    expect(opened).toHaveLength(1);
    // A bus's top pick: its seat layout, by the address that carries its operator and time; a bus read before it had one
    // (no "#") opens nothing, so no other card's button is clicked.
    const RESULTS = 'https://www.ixigo.com/buses/bus_search/Bengaluru/7/Goa/102/06-11-2026/O';
    const bus = (sourceUrl: string) => ({
      kind: 'bus' as const, title: 'VRL Travels', priceMinor: 150_000, currency: 'INR', priceNote: 'per seat, from', highlights: [], facts: {}, sourceUrl,
      journey: { mode: 'bus' as const, origin: { name: 'Bengaluru' }, destination: { name: 'Goa' }, depart_at: '2026-11-06T19:30:00+05:30', arrive_at: '2026-11-07T09:30:00+05:30' },
    });
    const buses = { ...set, resultsId: 'r_d3', optionKind: 'bus' as const, query: { from: 'Bengaluru', to: 'Goa', date: '2026-11-06' } };
    const onBus = makeTurnCtx({ tripId: 't_goa', turnId: 'turn_d3', link: {} as never, pack: goaPack(), wake: [], signal: new AbortController().signal });
    await putUpCard({ ...buses, options: [bus(`${RESULTS}#VRL%20Travels@19:30`)] }, [1], { title: 'Buses', line: 'x' }, onBus, { results, images, showPick: (_trip, pick) => opened.push(pick) });
    expect(opened[1]).toMatchObject({ page: `${RESULTS}#VRL%20Travels@19:30`, name: 'VRL Travels', kind: 'bus', cardId: (onBus.cards[0] as OptionsCardT).card_id });
    const older = makeTurnCtx({ tripId: 't_goa', turnId: 'turn_d4', link: {} as never, pack: goaPack(), wake: [], signal: new AbortController().signal });
    await putUpCard({ ...buses, resultsId: 'r_d4', options: [bus(RESULTS)] }, [1], { title: 'Buses', line: 'x' }, older, { results, images, showPick: (_trip, pick) => opened.push(pick) });
    expect(opened).toHaveLength(2);
    const option = (ctx.cards[0] as OptionsCardT).options[0]!;
    expect(option.image_url).toBe('https://go.test/img/card.jpg');
    expect(option.details?.gallery_urls).toEqual(['https://go.test/img/a.jpg', 'https://go.test/img/b.jpg']);
    // 10 Oct B3: the same photos as the option's own, with no labels (ixigo's list gives none).
    expect(option.photos).toEqual([{ url: 'https://go.test/img/a.jpg' }, { url: 'https://go.test/img/b.jpg' }]);
    // The Goa five: the stay split five ways.
    expect(option.details?.costs).toEqual([{ label: '3 nights, each of 5', emoji: '🛏️', amount_minor: 1_188_480, currency: 'INR' }]);
    expect(option.place).toMatchObject({ name: 'Riva Beach Resort', timezone: 'Asia/Kolkata' });
  });
});
