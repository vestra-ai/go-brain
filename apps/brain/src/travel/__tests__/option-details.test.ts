import * as C from '@go/contract';
import { describe, expect, it } from 'vitest';
import type { EngineAnswer } from '../book/engine.js';
import { clockOf, optionDetailsHandler, reviewDate } from '../option-details.js';
import type { ResultsStore } from '../results.js';

// The Server team's rev 5 (R9): an option's Details as a person opens them (get_option_details, 3 s), from what Go keeps.
const PAGE =
  'https://www.ixigo.com/hotels/1384544/details?locationId=1366415&locationName=Goa&locationType=S&masterLocationId=48569&countryId=1' +
  '&checkinDate=06112026&checkoutDate=09112026&adultCount=4&roomCount=2&childCount=0&searchLocationId=32&hName=Meritas';
const meta = { frameId: 'f_1' } as never;
const ask = { trip_id: 't_goa', card_id: 'c_opt_1', option_id: 'opt_c_opt_1_1', person_id: 'p_priya' };

const facts = (rows: Array<Record<string, unknown>>): Promise<EngineAnswer> =>
  Promise.resolve({ as: 'facts', title: 'Meritas', rows, page: PAGE, checkedAt: '2026-10-11T02:00:00.000Z', ms: 2000 });

function rig(o: { kind?: string; kept?: Record<string, Promise<EngineAnswer>>; live?: boolean } = {}) {
  const option = {
    option_id: 'opt_c_opt_1_1', title: 'Meritas Auberge', details: { why: ['Pool, as asked'], rating: 9 },
    photos: [{ url: 'https://go.test/img/pool.jpg', label: 'Pool' }, { url: 'https://go.test/img/room.jpg', label: 'Deluxe Room' }],
    room_types: [{ room_type_id: 'rt_family', label: 'Family Room', sleeps: 2, price_minor: 945_000 }],
  };
  const results = {
    card: async (tripId: string, cardId: string) => (tripId === 't_goa' && cardId === 'c_opt_1' ? { card: { options: [option] } } : null),
    offer: async (optionId: string) => (optionId === option.option_id ? { optionId, kind: o.kind ?? 'stay', title: option.title, resultsId: 'r_1', n: 1, sourceUrl: PAGE } : null),
    get: async () => ({
      checkedAt: '2026-10-11T01:00:00.000Z',
      options: [{ kind: 'stay', title: 'Meritas Auberge', highlights: [], facts: { type: 'Hotel', stars: 3 }, place: { name: 'Meritas Auberge', address: 'Candolim, Goa', lat: 15.52, lng: 73.76 } }],
    }),
  } as unknown as Pick<ResultsStore, 'card' | 'offer' | 'get'>;
  const peeked: string[] = [];
  const read: Array<{ id: string; given: Record<string, unknown>; o: Record<string, unknown> }> = [];
  const engine = {
    peek: (id: string, given: Record<string, unknown>) => {
      peeked.push(`${id}|${String(given['hotel'] ?? given['place'])}`);
      return o.kept?.[id] ?? null;
    },
    answer: async (id: string, given: Record<string, unknown>, ro: Record<string, unknown>) => {
      read.push({ id, given, o: ro });
      return facts([]);
    },
  };
  const handler = optionDetailsHandler({ results, engine: engine as never, people: async () => ['p_rahul', 'p_priya', 'p_arjun', 'p_kabir'], live: () => o.live ?? true });
  return { handler, peeked, read };
}

describe("an option's Details on demand", () => {
  it('says a review month and a time of day the way the contract writes them', () => {
    expect(reviewDate('Sep 2026')).toBe('2026-09');
    expect(reviewDate('September 2026')).toBe('2026-09');
    expect(reviewDate('2026-09-12')).toBe('2026-09-12');
    expect(reviewDate('last week')).toBeNull();
    expect(clockOf('12:00')).toBe('12:00');
    expect(clockOf('2 PM')).toBe('14:00');
    expect(clockOf('12:30 am')).toBe('00:30');
    expect(clockOf('25:00')).toBeNull();
    expect(clockOf('noon')).toBeNull();
  });

  it("answers a stay whole from its kept page and reviews: times, rules, nearby in metres, rooms, reviews, never a fresh read", async () => {
    const page = facts([{
      area: 'Calangute', town: 'Goa', stars: 4, lat: 15.544, lng: 73.761, check_in_from: '12:00', check_out_by: '11:00',
      house_rules: ['Property Policies: Primary Guest should be 18+ years of age', ''],
      nearby_list: [{ name: 'Shubadra', distance: 0.1, unit: 'km' }, { name: 'Shubadra', distance: 0.1, unit: 'km' }, { name: 'Sub Centre, assagao', distance: 0.7, unit: 'km' }, { name: 'Baga Beach' }],
    }]);
    const reviews = facts([{ rating_out_of_10: 10, when: 'Sep 2026', title: 'Lovely', said: 'Great pool and staff.' }, { rating_out_of_10: 8, when: 'Sep 2026', said: '' }]);
    const r = rig({ kept: { 'hotels.details': page, 'hotels.reviews': reviews } });
    const got = await r.handler(ask, meta);
    expect(C.OptionFullDetails.safeParse(got).success).toBe(true);
    expect(got).toMatchObject({
      why: ['Pool, as asked'], rating: 9, gallery_urls: ['https://go.test/img/pool.jpg', 'https://go.test/img/room.jpg'], url: PAGE,
      address: 'Calangute, Goa', map: { lat: 15.544, lng: 73.761 }, check_in: '12:00', check_out: '11:00', stars: 4, property_type: 'hotel',
      policies: ['Property Policies: Primary Guest should be 18+ years of age'],
      nearby: [{ name: 'Shubadra', distance_m: 100 }, { name: 'Sub Centre, assagao', distance_m: 700 }, { name: 'Baga Beach' }],
      rooms: [{ room_type_id: 'rt_family', label: 'Family Room', sleeps: 2, price_minor: 945_000 }],
      reviews: [{ text: 'Lovely: Great pool and staff.', rating: 10, date: '2026-09', source: 'ixigo' }],
    });
    expect(got).not.toHaveProperty('complete');
    expect(r.read).toEqual([]);
  });

  it("answers what is kept at once, says it is partial, and reads the stay's page and reviews in the background", async () => {
    const r = rig();
    const got = await r.handler(ask, meta);
    expect(C.OptionFullDetails.safeParse(got).success).toBe(true);
    expect(got).toMatchObject({ why: ['Pool, as asked'], url: PAGE, address: 'Candolim, Goa', map: { lat: 15.52, lng: 73.76 }, property_type: 'hotel', stars: 3, complete: false });
    expect(r.read.map((x) => [x.id, x.given, x.o['background']])).toEqual([['hotels.details', { hotel: PAGE }, true], ['hotels.reviews', { hotel: PAGE }, true]]);
    // Not on ixigo.com now: nothing is read, and the answer is still partial.
    const off = rig({ live: false });
    expect(await off.handler(ask, meta)).toMatchObject({ complete: false });
    expect(off.read).toEqual([]);
  });

  // Keshav, 11 Oct: a place card's Details as Saket's App draws them, "Things the crew can do" too. The card's first three
  // get their guide in the background (showPlaces); any other place gets its guide when it is opened.
  it("answers a place with its guide's best time and places to visit once read, else reads the guide in the background", async () => {
    const guide = facts([{ best_time: 'October to March', places_to_visit: ['Taj Mahal (4.8, monument): white marble', 'Agra Fort'] }]);
    const kept = rig({ kind: 'place', kept: { 'plan.destination': guide } });
    const got = await kept.handler(ask, meta);
    expect(C.OptionFullDetails.safeParse(got).success).toBe(true);
    expect(got).toMatchObject({ why: ['Pool, as asked', 'Best time to go: October to March'], activities: ['Taj Mahal', 'Agra Fort'] });
    expect(got).not.toHaveProperty('complete');
    expect(kept.peeked).toEqual(['plan.destination|Meritas Auberge']);
    expect(kept.read).toEqual([]);
    const cold = rig({ kind: 'place' });
    expect(await cold.handler(ask, meta)).toMatchObject({ why: ['Pool, as asked'], complete: false });
    expect(cold.read.map((x) => [x.id, x.given, x.o['background']])).toEqual([['plan.destination', { place: 'Meritas Auberge' }, true]]);
  });

  it("answers anything but a stay from its card alone, and refuses an option that isn't on the card", async () => {
    const r = rig({ kind: 'flight' });
    const got = await r.handler(ask, meta);
    expect(got).toEqual({ why: ['Pool, as asked'], rating: 9, gallery_urls: ['https://go.test/img/pool.jpg', 'https://go.test/img/room.jpg'], url: PAGE });
    expect(r.peeked).toEqual([]);
    await expect(r.handler({ ...ask, option_id: 'opt_gone' }, meta)).rejects.toMatchObject({ code: 404 });
  });
});
