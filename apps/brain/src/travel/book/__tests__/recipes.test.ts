import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyConstraints } from '../../filters.js';
import type { CaptureSpec, FetchPlan } from '../../recipes/recipe.js';
import { capture, fixture } from '../../recipes/__tests__/fixtures.js';
import type { TravelOption } from '../../travel.js';
import { BOOK_DIR, loadBook } from '../book.js';
import { createEngine } from '../engine.js';

// The four searches as recipe files, on saved ixigo pages: the address each opens, the fetch, and the options it reads.
// Trains read ixigo's own train call, which the results page uses since October (p4's sample).
const { book, problems } = loadBook();
const sample = (name: string): string => readFileSync(`${BOOK_DIR}samples/${name}`, 'utf8');
// The Goa trip: three members live in Delhi, one in Bangalore, one in Mumbai.
const HOMES = ['Delhi', 'Delhi', 'Bangalore', 'Mumbai', 'Delhi'];

function engineWith(answer: (url: string, plan: FetchPlan) => ReturnType<typeof capture>[], people = 4) {
  const runs: Array<{ url: string; plan: FetchPlan }> = [];
  const runner = {
    read: async (_trip: string, url: string, plan: FetchPlan) => {
      runs.push({ url, plan });
      return { captures: answer(url, plan), finalUrl: url };
    },
  };
  const engine = createEngine({ book, runner: () => runner, trip: async () => ({ people, homes: HOMES }), now: () => new Date('2026-10-07T12:00:00Z') });
  return { engine, runs };
}

describe('the recipe book', () => {
  it('loads every file, with nothing left out', () => {
    expect(problems).toEqual([]);
    expect(book.all().map((r) => r.id).sort()).toEqual([
      'buses.between', 'buses.city_lookup', 'flights.airport_lookup', 'flights.fare_calendar', 'flights.search',
      'help.downtime', 'help.faq', 'help.services',
      'hotels.details', 'hotels.offers', 'hotels.place_lookup', 'hotels.reviews', 'hotels.rooms', 'hotels.search', 'hotels.search_filters', 'hotels.similar',
      'offers.campaign', 'offers.details', 'offers.list',
      'plan.destination', 'plan.explore', 'plan.top_locations', 'trains.between', 'trains.station_lookup',
    ]);
  });
});

describe('hotels.search', () => {
  const SEARCH = '/accommodation-search/api/v3/accommodations/search$';
  const SEARCH_URL = 'https://www.ixigo.com/accommodation-search/api/v3/accommodations/search';
  // The page's first call ends in the same path plus "/static-metadata": it must never be read as hotels.
  const pages = () => [
    capture(SEARCH, `${SEARCH_URL}/static-metadata`, '{"data":{"filters":[]}}'),
    capture(SEARCH, SEARCH_URL, fixture('stays-goa-page1.json')),
    capture(SEARCH, SEARCH_URL, fixture('stays-goa-page2.json')),
  ];
  const DATES = { check_in: '2026-11-06', check_out: '2026-11-09' };
  const MERITAS =
    'https://www.ixigo.com/hotels/1384544/details?locationId=1366415&locationName=Goa&locationType=S&masterLocationId=48569&countryId=1' +
    '&checkinDate=06112026&checkoutDate=09112026&adultCount=4&roomCount=2&childCount=0&searchLocationId=32&hotelInfoToken=true%7C3001%7C1' +
    '&hName=Meritas%20Auberge%20Calangute%20Goa';
  const stays = async (place: string, conditions: string[] = [], caps = pages(), extra: Record<string, unknown> = {}) => {
    const e = engineWith(() => caps);
    const got = await e.engine.answer('hotels.search', { place, ...DATES, ...extra }, { tripId: 't_goa', conditions });
    if (got.as !== 'options') throw new Error('not options');
    return { ...got, runs: e.runs };
  };

  it('opens all of Goa for Goa, two to a room; an area, or a place of its own, with ixigo filtering it and the must-haves it has codes for', async () => {
    expect((await stays('Goa')).page).toBe(
      'https://www.ixigo.com/hotels/search/result?locationId=32&locationName=Goa&locationType=S&masterLocationId=48569&countryId=1' +
      '&checkinDate=06112026&checkoutDate=09112026&adultCount=4&roomCount=2&childCount=0',
    );
    expect((await stays('Vagator', ['pool', 'beach'])).page).toBe(
      'https://www.ixigo.com/hotels/search/result?locationId=32&locationName=Goa&locationType=S&masterLocationId=48569&countryId=1' +
      '&checkinDate=06112026&checkoutDate=09112026&adultCount=4&roomCount=2&childCount=0&filters=FL_HF_29%2CPA_C_78528',
    );
    expect((await stays('Anjuna', ['free_cancellation', 'breakfast'])).page).toBe(
      'https://www.ixigo.com/hotels/search/result?locationId=1026&locationName=Anjuna&locationType=C&masterLocationId=50347&countryId=1' +
      '&checkinDate=06112026&checkoutDate=09112026&adultCount=4&roomCount=2&childCount=0&filters=MP_FB%2CMP_FC',
    );
    // Five people: three rooms.
    expect((await stays('Anjuna, Goa', [], pages(), { adults: 5 })).page).toContain('&adultCount=5&roomCount=3&');
  });

  it('takes page 1, and page 2 when six scrolls bring it, for all of Goa or a half of it, page 1 for an area; closes the popup; settles 550 ms', async () => {
    // Page 2 is kept when it came while the steps ran; the fetch never waits on it. 20 s, Bash's most, is spent only on
    // a slow page 1 (a box's first ixigo hotels load).
    const two = {
      capture: [{ match: SEARCH, required: true, min_count: 1, max_count: 2 }],
      steps: [{ op: 'wait_for', match: SEARCH }, { op: 'click', name: 'Close modal', optional: true }, { op: 'scroll', times: 6 }, { op: 'click', name: 'Close modal', optional: true }],
      timeoutMs: 20_000,
      settleMs: 550,
    };
    for (const area of ['Goa', 'North Goa', 'South Goa']) expect((await stays(area, ['pool'])).runs[0]!.plan, area).toEqual(two);
    for (const area of ['Vagator', 'Anjuna', 'Candolim']) {
      expect((await stays(area, ['pool'])).runs[0]!.plan, area).toEqual({
        capture: [{ match: SEARCH, required: true }],
        steps: [{ op: 'wait_for', match: SEARCH }, { op: 'click', name: 'Close modal', optional: true }],
        settleMs: 550,
      });
    }
  });

  it('reads both pages of hotels, priced per night and per room with taxes, the whole stay for every room', async () => {
    const { options } = await stays('Goa');
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
    // Page 1 alone, when that is all that came back.
    expect((await stays('Goa', [], pages().slice(0, 2))).options).toHaveLength(3);
    // The filters keep a stated free cancellation and a beach within 10 minutes.
    const near = applyConstraints('stays', { mustHave: ['beach', 'free_cancellation'] }, options.map((o) => ({ ...o, offerId: 'x' }) as TravelOption));
    expect(near.map((o) => o.title)).toEqual(['Soul Vacation Resort and Spa, Colva']);
  });

  it('searches North Goa as all of Goa, and drops a stay from South Goa', async () => {
    const north = await stays('North Goa');
    expect(north.page).not.toContain('&filters=');
    // Soul Vacation is in Fatona, Colva: South Goa.
    expect(north.options.map((o) => o.title)).toHaveLength(6);
    expect(north.options.map((o) => o.title)).not.toContain('Soul Vacation Resort and Spa, Colva');
    expect((await stays('South Goa')).options.map((o) => o.title)).toEqual(['Soul Vacation Resort and Spa, Colva']);
  });

  it('takes what ixigo filtered on as true of every stay it gave, even one that does not list it', async () => {
    const [meritas] = (await stays('Goa', ['breakfast'], pages().slice(0, 2))).options;
    expect(meritas!.facts).toMatchObject({ breakfast: true, pool: true });
    expect(meritas!.highlights).toContain('Breakfast included');
    expect((await stays('Goa', [], pages().slice(0, 2))).options[0]!.facts).toMatchObject({ breakfast: false });
  });

  it("reads a hotel with null details (O Hotel Goa's null image), and leaves out one it can't read, never the whole page", async () => {
    const page = JSON.parse(fixture('stays-goa-page1.json'));
    const list = page.data.result.inventoryInfoList as Array<Record<string, unknown>>;
    const [first, second] = [list[0]!, list[1]!];
    first['imageInfoList'] = [{ url: null, urlMedium: null }];
    first['locality'] = null;
    first['userRatingCount'] = null;
    first['hotelInfoToken'] = null;
    delete second['fareDetail'];
    const read = (await stays('Goa', [], [capture(SEARCH, SEARCH_URL, fixture('stays-goa-page1.json'))])).options;
    const options = (await stays('Goa', [], [capture(SEARCH, SEARCH_URL, JSON.stringify(page))])).options;
    expect(options.map((o) => o.title)).toEqual(read.map((o) => o.title).filter((t) => t !== String(second['name']).trim()));
    const o = options.find((x) => x.title === String(first['name']).trim())!;
    expect(o).not.toHaveProperty('imageUrl');
    expect(o.facts).not.toHaveProperty('area');
    expect(o.facts).not.toHaveProperty('reviews');
    // Every hotel unreadable: a changed shape, said plainly, never "no stays".
    for (const h of list) delete h['fareDetail'];
    await expect(stays('Goa', [], [capture(SEARCH, SEARCH_URL, JSON.stringify(page))])).rejects.toThrow(/shape Go does not read/);
    // The page never loaded its hotels.
    await expect(stays('Goa', [], pages().slice(0, 1))).rejects.toThrow(/did not send/);
  });
});

describe('trains.between', () => {
  it("reads ixigo's own train call (confirmtkt.com since October), one option per train and class, with its seats and chance", async () => {
    const MATCH = 'ixigotrainsapi.confirmtkt.com/api/v1/trains/search';
    const caps = [capture(MATCH, `https://${MATCH}?sourceStationCode=SBC&destinationStationCode=MAS&dateOfJourney=22-10-2026`, sample('trains.between.page.json'))];
    const { engine, runs } = engineWith(() => caps);
    const got = await engine.answer('trains.between', { from: 'Bangalore', to: 'Chennai', date: '2026-10-22' }, { tripId: 't_goa' });
    if (got.as !== 'options') throw new Error('not options');
    expect(got.page).toBe('https://www.ixigo.com/trains/search-pwa/from/SBC/to/MAS/22-10-2026');
    expect(runs[0]!.plan.capture).toEqual([{ match: MATCH, required: true }]);
    expect(got.options.map((o) => `${o.title} ${o.facts.class_code} ${o.facts.availability}`)).toEqual([
      'Muzaffarpur EXP 15227 1A WL 9', 'Muzaffarpur EXP 15227 2A Available 2', 'Muzaffarpur EXP 15227 3A Available 8',
      'Muzaffarpur EXP 15227 3E Regret', 'Muzaffarpur EXP 15227 SL WL 127', 'Shatabdi EXP 12028 EC Available 25',
      'Shatabdi EXP 12028 CC Available 659', 'Lalbagh SF EXP 12608 CC WL 7', 'Lalbagh SF EXP 12608 2S Available 291',
    ]);
    expect(got.options[0]).toEqual({
      kind: 'train',
      title: 'Muzaffarpur EXP 15227',
      priceMinor: 145_500,
      currency: 'INR',
      priceNote: 'per person, 1A',
      journey: {
        mode: 'train',
        origin: { name: 'Smvt Bengaluru', code: 'SMVB' },
        destination: { name: 'Perambur', code: 'PER' },
        depart_at: '2026-10-22T00:30:00+05:30',
        arrive_at: '2026-10-22T06:35:00+05:30',
        carrier_name: 'Indian Railways',
        number: '15227',
      },
      highlights: ['AC First Class', 'WL 9', '76% chance to confirm', '6 h 5 m'],
      facts: { class_code: '1A', availability: 'WL 9', chance: 76, duration_min: 365, rating: expect.any(Number) },
      sourceUrl: 'https://www.ixigo.com/trains/15227?orgn=SMVB&dstn=PER&departDate=2026-10-22&quota=GN',
    });
  });
});

describe('buses.between', () => {
  const RESULTS = 'https://www.ixigo.com/buses/bus_search/Mumbai/4/Goa/102/06-11-2026/O';
  // The page loads /buslist/v3/services/meta/105 first: it must never be read as the buses.
  const caps = () => [
    capture('/buslist/v3/services$', 'https://www.ixigo.com/buslist/v3/services/meta/105', '{"status":"success","meta":{}}'),
    capture('/buslist/v3/services$', 'https://www.ixigo.com/buslist/v3/services', fixture('buses-mumbai-goa.json')),
  ];

  it('opens the AbhiBus city ids, and reads every bus from its lowest seat fare after the offer ixigo applies', async () => {
    const { engine, runs } = engineWith(() => caps());
    const got = await engine.answer('buses.between', { from: 'Mumbai', to: 'North Goa', date: '2026-11-06' }, { tripId: 't_goa' });
    if (got.as !== 'options') throw new Error('not options');
    expect(got.page).toBe(RESULTS);
    expect(runs[0]!.plan).toEqual({ capture: [{ match: '/buslist/v3/services$', required: true }] });
    expect(got.options).toHaveLength(71);
    expect(got.options[0]).toEqual({
      kind: 'bus',
      title: 'Paulo Travels Express',
      priceMinor: 270_000,
      currency: 'INR',
      priceNote: 'per seat, from',
      journey: {
        mode: 'bus',
        origin: { name: 'Mumbai' },
        destination: { name: 'Goa' },
        depart_at: '2026-11-06T18:20:00+05:30',
        arrive_at: '2026-11-07T10:45:00+05:30',
        carrier_name: 'Paulo Travels Express',
      },
      rating: 4.6,
      highlights: ['VE AC Sleeper (2 + 1)', '16 h 25 m'],
      facts: { bus_type: 'VE AC Sleeper (2 + 1)', seats_left: 31, duration_min: 985, reviews: 15 },
      sourceUrl: RESULTS,
    });
    expect(got.options[1]!.priceMinor).toBe(300_000);
    expect(Math.min(...got.options.map((o) => o.priceMinor))).toBe(150_000);
  });

  it("reads a bus with null details, and refuses a page that sent only its meta call", async () => {
    const body = JSON.parse(fixture('buses-mumbai-goa.json'));
    Object.assign(body.services[0], { busTypeName: null, rating: null, noOfRatings: null, seatStats: { availableSeats: null } });
    const { engine } = engineWith(() => [capture('/buslist/v3/services$', 'https://www.ixigo.com/buslist/v3/services', JSON.stringify(body))]);
    const got = await engine.answer('buses.between', { from: 'Mumbai', to: 'Goa', date: '2026-11-06' }, { tripId: 't_goa' });
    if (got.as !== 'options') throw new Error('not options');
    expect(got.options).toHaveLength(71);
    expect(got.options[0]).toMatchObject({ title: 'Paulo Travels Express', highlights: ['16 h 25 m'], facts: { duration_min: 985 } });
    expect(got.options[0]).not.toHaveProperty('rating');
    const meta = engineWith(() => caps().slice(0, 1));
    await expect(meta.engine.answer('buses.between', { from: 'Mumbai', to: 'Goa', date: '2026-11-06' }, { tripId: 't_goa' })).rejects.toThrow(/did not send/);
  });
});

describe('flights.search', () => {
  it("is a link, set for the members who live by the airport, with people's conditions and the cheapest first", async () => {
    const { engine, runs } = engineWith(() => [], 5);
    const base = (from: string, adults: number) =>
      `https://www.ixigo.com/search/result/flight?from=${from}&to=GOI&date=06112026&returnDate=&adults=${adults}&children=0&infants=0&class=e&source=Search%20Form`;
    expect(await engine.answer('flights.search', { from: 'Delhi', to: 'Goa', date: '2026-11-06', depart_after: '18:00' }, { tripId: 't_goa', conditions: ['non_stop'] }))
      .toEqual({ as: 'link', link: `${base('DEL', 3)}&stops=0&takeOff=NIGHT&sort_type=cheapest`, title: 'Flights, Delhi to Goa', who: 'for 3 from Delhi' });
    expect(await engine.answer('flights.search', { from: 'Mumbai', to: 'Goa', date: '2026-11-06', arrive_before: '12:00', max_price: 900_050 }, { tripId: 't_goa' }))
      .toEqual({ as: 'link', link: `${base('BOM', 1)}&landing=EARLY_MORNING,MORNING&price=0,9000&sort_type=cheapest`, title: 'Flights, Mumbai to Goa', who: 'for 1 from Mumbai' });
    // A number the ask gave counts as it is.
    expect(await engine.answer('flights.search', { from: 'Delhi', to: 'Goa', date: '2026-11-06', adults: 2, depart_after: '10:00', depart_before: '15:00' }, { tripId: 't_goa' }))
      .toEqual({ as: 'link', link: `${base('DEL', 2)}&takeOff=MORNING,AFTERNOON&sort_type=cheapest`, title: 'Flights, Delhi to Goa', who: 'for 2 from Delhi' });
    // A link loads nothing.
    expect(runs).toEqual([]);
  });

  it("checks the capture's shape: Go's capture specs are what the browser fetch keeps", () => {
    const r = book.get('hotels.search')!;
    expect(r.capture as CaptureSpec[]).toEqual([{ match: '/accommodation-search/api/v3/accommodations/search$', required: true }]);
  });
});
