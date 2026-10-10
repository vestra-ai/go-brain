import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyConstraints } from '../../filters.js';
import type { CaptureSpec, FetchPlan } from '../../recipes/recipe.js';
import { capture, fixture } from '../../recipes/__tests__/fixtures.js';
import type { TravelOption } from '../../travel.js';
import { BOOK_DIR, loadBook } from '../book.js';
import { createEngine } from '../engine.js';

// The four searches as recipe files, on saved ixigo pages: the address each opens, the fetch, and the options it reads.
// Trains: the page speed reads the results page's www.ixigo.com call; the fast speed, ixigo's train service on confirmtkt.
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
  it('has a Hinglish ask for every recipe a person asks for (not a lookup), as the group writes them, for Jev and the tests', () => {
    const hinglish = /\b(hai|hain|kya|kaise|kaun|kaunsa|kaunsi|kitna|kitne|kitni|mein|se|ke|ki|ka|ko|pe|wala|wale|wali|dikhao|batao|chahiye|milega|jaayein|jaati|chal|raha|rahe|nahi|kab|kahan|kaha|log|kal|ghoomne|sasta|liye|aayegi)\b/;
    const without = book.all().filter((r) => r.answer.as !== 'places' && !r.asks.some((a) => hinglish.test(a))).map((r) => r.id);
    expect(without).toEqual([]);
  });

  it('loads every file, with nothing left out', () => {
    expect(problems).toEqual([]);
    expect(book.all().map((r) => r.id).sort()).toEqual([
      'buses.between', 'buses.city_lookup', 'buses.offers', 'buses.points', 'flights.airport_lookup', 'flights.fare_calendar', 'flights.results', 'flights.search',
      'help.downtime', 'help.faq', 'help.services',
      'hotels.details', 'hotels.offers', 'hotels.place_lookup', 'hotels.reviews', 'hotels.rooms', 'hotels.search', 'hotels.search_filters', 'hotels.similar',
      'offers.campaign', 'offers.details', 'offers.list',
      'plan.destination', 'plan.explore', 'plan.top_locations',
      'trains.alternate_dates', 'trains.alternate_travel_plan', 'trains.alternates', 'trains.between', 'trains.boarding_stations', 'trains.by_name', 'trains.coach_position', 'trains.confirm_chance', 'trains.offers',
      'trains.platform_locator', 'trains.pnr_status', 'trains.route', 'trains.running_status', 'trains.schedule', 'trains.station_lookup', 'trains.station_status', 'trains.tatkal', 'trains.train_calendar',
      'trip.how_we_get_there',
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

  it('takes pages 1 and 2 for all of Goa or a half of it, six scrolls bringing page 2, and page 1 for an area; closes the popup; settles 550 ms', async () => {
    // ixigo's popup shows 1 s after the page mounts: closed first, looked for up to 3 s, then again once the results are in.
    const POPUP = { op: 'click', name: 'Close modal', optional: true, within_ms: 3_000 };
    // Bash's whole 20 s: ixigo sent page 1 of all of Goa with a pool at 10.2 s (staging, 8 Oct), so 12 s failed it.
    const two = {
      capture: [{ match: SEARCH, required: true, min_count: 2, max_count: 2 }],
      steps: [POPUP, { op: 'wait_for', match: SEARCH }, { op: 'click', name: 'Close modal', optional: true }, { op: 'scroll', times: 6 }, { op: 'click', name: 'Close modal', optional: true }],
      timeoutMs: 20_000,
      settleMs: 550,
    };
    for (const area of ['Goa', 'North Goa', 'South Goa']) expect((await stays(area, ['pool'])).runs[0]!.plan, area).toEqual(two);
    for (const area of ['Vagator', 'Anjuna', 'Candolim']) {
      expect((await stays(area, ['pool'])).runs[0]!.plan, area).toEqual({
        capture: [{ match: SEARCH, required: true }],
        steps: [POPUP, { op: 'wait_for', match: SEARCH }, { op: 'click', name: 'Close modal', optional: true }],
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
      facts: { nights: 3, rooms: 2, guests: 4, area: 'Candolim', stars: 4, rating_out_of_10: 9, reviews: 331, pool: true, breakfast: false, free_cancellation: true, beach_minutes: 29 },
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

  // What ixigo's list gives for a stay (staging, 8 Oct, Anjuna, saved whole): up to seven photos, a few amenities.
  it("reads a stay's photos from ixigo's list, up to seven and larger, and its amenities in ixigo's words", async () => {
    const { options } = await stays('Anjuna', [], [capture(SEARCH, SEARCH_URL, fixture('stays-anjuna-full.json'))]);
    const riva = options.find((o) => o.title === 'Riva Beach Resort')!;
    expect(riva.imageUrls).toHaveLength(7);
    expect(riva.imageUrls![0]).toBe('https://pix8.agoda.net/property/109600/0/047a9028e97fbe184313ae32363b5282.jpeg?ce=0&s=1024x768');
    // The card keeps its own picture, the same photo smaller.
    expect(riva.imageUrl).toBe('https://pix8.agoda.net/property/109600/0/047a9028e97fbe184313ae32363b5282.jpeg?ce=0&s=840x460');
    // "Breakfast Included" is the rate, not the place: it stays a highlight.
    expect(riva.amenities).toEqual(['Free Wifi', 'Swimming pool at the property', 'Private Beach', 'Restaurants']);
    expect(riva.facts).toMatchObject({ rating_word: 'Excellent', reviews: 1737, distance: '120 m from Mandrem Beach', area: 'Mandrem', stars: 4 });
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
    expect(o).not.toHaveProperty('imageUrls');
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
  // The results page's own calls on www.ixigo.com, which a box's browser keeps (the pre-engine reader's saved pages).
  const page = (name: string, from: string, to: string, date: string, ddmmyyyy: string, withSeats = true) => [
    capture('/trains/v1/search/between/', `https://www.ixigo.com/trains/v1/search/between/${from}/${to}?date=${date}&languageCode=en`, fixture(`trains-${name}-between.json`)),
    ...(withSeats
      ? [capture('/api/v3/trains/availability', `https://www.ixigo.com/api/v3/trains/availability?originCode=${from}&destinationCode=${to}&travelDate=${ddmmyyyy}`, fixture(`trains-${name}-availability.json`))]
      : []),
  ];

  it("opens ixigo's results page, whose call is on www.ixigo.com (the 8 Oct drill: the confirmtkt page never answers on a box), one option per train and class", async () => {
    const { engine, runs } = engineWith(() => page('ndls-mao', 'NDLS', 'MAO', '2026-11-06', '06112026'));
    const got = await engine.answer('trains.between', { from: 'Delhi', to: 'Goa', date: '2026-11-06' }, { tripId: 't_goa' });
    if (got.as !== 'options') throw new Error('not options');
    expect(got.page).toBe('https://www.ixigo.com/search/result/train/NDLS/MAO/06112026//1/0/0/0/ALL');
    expect(runs[0]!.plan.capture).toEqual([{ match: '/trains/v1/search/between/', required: true }, { match: '/api/v3/trains/availability', required: false }]);
    // On the stage, the trains' class tiles come on screen and are drawn for the last picture.
    expect(runs[0]!.plan).toMatchObject({ steps: [{ op: 'wait_for', match: '/trains/v1/search/between/' }, { op: 'scroll', times: 1 }], settleMs: 550 });
    // Never a call on another site: the page speed's captures are all www.ixigo.com's.
    expect(runs[0]!.plan.capture.every((c) => c.match.startsWith('/'))).toBe(true);
    expect(got.options).toHaveLength(25);
    expect(got.options[0]).toEqual({
      kind: 'train',
      title: 'NZM ERS SF EXP 22656',
      priceMinor: 311_500,
      currency: 'INR',
      priceNote: 'per person, 2A',
      journey: {
        mode: 'train',
        origin: { name: 'Delhi Hazrat Nizamuddin', code: 'NZM' },
        destination: { name: 'Madgaon Junction', code: 'MAO' },
        depart_at: '2026-11-06T05:00:00+05:30',
        arrive_at: '2026-11-07T10:10:00+05:30',
        carrier_name: 'Indian Railways',
        number: '22656',
      },
      highlights: ['AC 2 Tier', 'WL 26', '29 h 10 m'],
      facts: { class_code: '2A', availability: 'WL 26', duration_min: 1750 },
      sourceUrl: 'https://www.ixigo.com/trains/22656?orgn=NZM&dstn=MAO&departDate=2026-11-06&quota=GN',
    });
    const chance = got.options.find((o) => o.title === 'Sampark Kranthi 12218' && o.facts.class_code === '3E')!;
    expect(chance.highlights).toContain('39% chance to confirm');
    // Without the seats call the trains still show, with their fares.
    const bare = await engineWith(() => page('ndls-mao', 'NDLS', 'MAO', '2026-11-06', '06112026', false)).engine.answer('trains.between', { from: 'Delhi', to: 'Goa', date: '2026-11-06' }, { tripId: 't_goa' });
    expect(bare.as === 'options' && bare.options[0]).toMatchObject({ priceMinor: 311_500, highlights: ['AC 2 Tier', '29 h 10 m'] });
  });

  // ixigo's between call of 10 Oct splits each class's fare (baseFare, serviceCharge, railwayCharges, cateringCharges,
  // otherCharges) and gives each train's averageRating; the 8 Oct page gave baseFare alone.
  it("without the seats call, a class's fare is its breakup summed; the train's rating is kept", async () => {
    const between = JSON.parse(fixture('trains-ndls-mao-between.json')) as { data: { trainsBetweenStations: Array<{ attributes: Record<string, unknown>; fares: Record<string, unknown> }> } };
    const first = between.data.trainsBetweenStations[0]!;
    first.fares['2A'] = { baseFare: 3000, serviceCharge: 40, railwayCharges: 60, cateringCharges: 0, otherCharges: 15 };
    first.attributes['averageRating'] = 4.1;
    const call = capture('/trains/v1/search/between/', 'https://www.ixigo.com/trains/v1/search/between/NDLS/MAO?date=2026-11-06&languageCode=en', JSON.stringify(between));
    const got = await engineWith(() => [call]).engine.answer('trains.between', { from: 'Delhi', to: 'Goa', date: '2026-11-06' }, { tripId: 't_goa' });
    if (got.as !== 'options') throw new Error('not options');
    expect(got.options[0]).toMatchObject({ title: 'NZM ERS SF EXP 22656', priceMinor: 311_500, facts: { class_code: '2A', rating: 4.1 } });
  });

  it('shows Tatkal next to the General quota once it is open, and a train that boards at another station of the city', async () => {
    const { engine } = engineWith(() => page('csmt-mao', 'CSMT', 'MAO', '2026-10-08', '08102026'));
    const got = await engine.answer('trains.between', { from: 'Mumbai', to: 'Goa', date: '2026-10-08' }, { tripId: 't_goa' });
    if (got.as !== 'options') throw new Error('not options');
    expect(got.options).toHaveLength(60);
    expect(got.options.find((o) => o.title === 'Mandovi Express 10103' && o.facts.class_code === '3A')).toMatchObject({
      priceMinor: 113_000,
      highlights: ['AC 3 Tier', 'RAC 10', 'Tatkal: Available 86, ₹1,460'],
      facts: { availability: 'RAC 10', tatkal_availability: 'Available 86', tatkal_fare_minor: 146_000, duration_min: 885 },
    });
    expect(got.options.find((o) => o.journey?.number === '22115')!.journey).toMatchObject({ origin: { code: 'LTT' }, destination: { code: 'KRMI' } });
  });

  it("reads ixigo's train service's own call (confirmtkt.com) at the fast speed, in its own shape: one option per train and class, with its seats and chance", async () => {
    const MATCH = 'ixigotrainsapi.confirmtkt.com/api/v1/trains/search';
    const calls: Array<{ url: string }> = [];
    const runner = {
      read: async () => {
        throw new Error('the fast speed answered: no page opens');
      },
      pageFetch: async (_t: string, call: { url: string }) => {
        calls.push(call);
        return capture('fast', `https://${MATCH}?sourceStationCode=SBC&destinationStationCode=MAS&dateOfJourney=22-10-2026`, sample('trains.between.page.json'));
      },
    };
    const engine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: HOMES }), now: () => new Date('2026-10-07T12:00:00Z') });
    const got = await engine.answer('trains.between', { from: 'Bangalore', to: 'Chennai', date: '2026-10-22' }, { tripId: 't_goa' });
    if (got.as !== 'options') throw new Error('not options');
    expect(calls[0]!.url).toMatch(/^https:\/\/ixigotrainsapi\.confirmtkt\.com\/api\/v1\/trains\/search\?sourceStationCode=SBC&destinationStationCode=MAS&/);
    expect(got.page).toBe('https://www.ixigo.com/search/result/train/SBC/MAS/22102026//1/0/0/0/ALL');
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
    // On the stage, the buses' cards come on screen and are drawn for the last picture.
    expect(runs[0]!.plan).toEqual({
      capture: [{ match: '/buslist/v3/services$', required: true }],
      steps: [{ op: 'wait_for', match: '/buslist/v3/services$' }, { op: 'scroll', times: 1 }],
      settleMs: 550,
    });
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
      // What the page's own filters read (AC, sleeper), from the bus type: Go's wants pick on them.
      facts: { bus_type: 'VE AC Sleeper (2 + 1)', seats_left: 31, duration_min: 985, reviews: 15, ac: true, sleeper: true },
      sourceUrl: RESULTS,
    });
    expect(got.options[1]!.priceMinor).toBe(300_000);
    expect(Math.min(...got.options.map((o) => o.priceMinor))).toBe(150_000);
  });

  // Keshav, 10 Oct: buses have many pickup and drop points. The list call names every point with ixigo's rank (field names
  // as the 10 Oct Bengaluru to Goa read sent them; the names here are Mumbai's and Goa's, the ids and stops set for the test).
  it('reads each bus\'s pickup and drop points by name, the busiest first, and clicks ixigo\'s chips for the ones the group named', async () => {
    const body = JSON.parse(fixture('buses-mumbai-goa.json'));
    body.boardingPointList = [
      { filterID: 1, filterName: 'Borivali East', filterStatus: false, placeId: '101', lat: '19.2307', long: '72.8567', rank: '1' },
      { filterID: 2, filterName: 'Andheri East', filterStatus: false, placeId: '102', lat: '19.1136', long: '72.8697', rank: '2' },
      { filterID: 3, filterName: 'Sion', filterStatus: false, placeId: '103', lat: '', long: '', rank: '0' },
      { filterID: 4, filterName: ' ', filterStatus: false, placeId: '104', lat: '', long: '', rank: '0' },
    ];
    body.droppingPointList = [
      { filterID: 7, filterName: 'Mapusa- Isbt Private Bus Stand', filterStatus: false, placeId: '201', lat: '', long: '', rank: '0' },
      { filterID: 8, filterName: 'Panjim', filterStatus: false, placeId: '202', lat: '15.4939', long: '73.8369', rank: '1' },
      { filterID: 9, filterName: 'Mapusa', filterStatus: false, placeId: '203', lat: '15.589', long: '73.8099', rank: '2' },
    ];
    body.services[0].filters = { boardingPoints: [3, 2, 1, 4, 99], droppingPoints: [7, 9, 8], amenities: [] };
    body.services[1].filters = { boardingPoints: [3], droppingPoints: [], amenities: [] };
    const { engine, runs } = engineWith(() => [capture('/buslist/v3/services$', 'https://www.ixigo.com/buslist/v3/services', JSON.stringify(body))]);
    const got = await engine.answer('buses.between', { from: 'Mumbai', to: 'Goa', date: '2026-11-06', board_at: 'Andheri', drop_at: 'Mapusa' }, { tripId: 't_goa' });
    if (got.as !== 'options') throw new Error('not options');
    // An id the list doesn't name, or a blank name, is left out; a point with no rank comes after the ranked ones.
    expect(got.options[0]!.facts).toMatchObject({ boarding_points: 'Borivali East; Andheri East; Sion', dropping_points: 'Panjim; Mapusa; Mapusa- Isbt Private Bus Stand' });
    // The drops ixigo placed, for the nearest one to the group's stay (group-stay.ts): Mapusa's bus stand has no position.
    expect(got.options[0]!.facts['drop_spots']).toBe('Mapusa (15.589, 73.8099); Panjim (15.4939, 73.8369)');
    expect(got.options[1]!.facts['boarding_points']).toBe('Sion');
    expect(got.options[1]!.facts).not.toHaveProperty('dropping_points');
    expect(got.options[1]!.facts).not.toHaveProperty('drop_spots');
    expect(got.options[2]!.facts).not.toHaveProperty('boarding_points');
    // On the stage: the pickup's chip, then the Dropping Points tab and the drop's chip, each skipped when it isn't there.
    expect(runs[0]!.plan.steps).toEqual([
      { op: 'wait_for', match: '/buslist/v3/services$' },
      { op: 'click', role: 'link', text: 'Andheri', optional: true, within_ms: 1500 },
      { op: 'click', role: 'link', name: 'Dropping Points', optional: true, within_ms: 1500 },
      { op: 'click', role: 'link', text: 'Mapusa', optional: true, within_ms: 1500 },
      { op: 'scroll', times: 1 },
    ]);
    await engine.answer('buses.between', { from: 'Mumbai', to: 'Goa', date: '2026-11-07', drop_at: 'Panjim' }, { tripId: 't_goa' });
    expect(runs[1]!.plan.steps).toEqual([
      { op: 'wait_for', match: '/buslist/v3/services$' },
      { op: 'click', role: 'link', name: 'Dropping Points', optional: true, within_ms: 1500 },
      { op: 'click', role: 'link', text: 'Panjim', optional: true, within_ms: 1500 },
      { op: 'scroll', times: 1 },
    ]);
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

// ixigo's flights page from a staging box, 9 Oct 18:24Z (Delhi to Goa, 13 Nov, for 2): its own call is a stream of
// server-sent events whose one data line holds every fare (145; four kept here, booking tokens left out).
describe('flights.results', () => {
  const STREAM = '/flights/v2/search/stream';
  const STREAM_URL = 'https://www.ixigo.com/flights/v2/search/stream';
  const GIVEN = { from: 'Delhi', to: 'Goa', date: '2026-11-13' };

  // Staging, 10 Oct 02:53Z: a flights read was refused after Bash answered it, and the log said nothing of why.
  it("says, when a page answered and its answer didn't read, which check failed and each capture's status, size and cut; never the body", async () => {
    const said: Array<{ obj: any; msg: string }> = [];
    const log = { info: () => undefined, warn: (obj: object, msg: string) => said.push({ obj, msg }) };
    const read = async (caps: ReturnType<typeof capture>[]) => {
      const runner = { read: async (_t: string, url: string) => ({ captures: caps, finalUrl: url }) };
      const engine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 2, homes: [] }), now: () => new Date('2026-10-10T03:00:00Z'), log });
      return engine.answer('flights.results', GIVEN, { tripId: 't_unread' }).catch((e: unknown) => e);
    };
    const body = fixture('flights-del-goi-2026-11-13.sse');
    await read([capture(STREAM, STREAM_URL, '{"message":"Forbidden"}', 403)]);
    await read([{ ...capture(STREAM, STREAM_URL, body.slice(0, 900)), truncated: true }]);
    await read([capture(STREAM, STREAM_URL, 'data:{"data":{"flightJourneys":[{"flightFare":[{"flightKeys":"x"}]}]}}')]);
    await read([]);
    expect(said.map((s) => [s.msg, s.obj.recipe, s.obj.check])).toEqual([
      ["book: a page answered, and its answer didn't read", 'flights.results', 'status'],
      ["book: a page answered, and its answer didn't read", 'flights.results', 'truncated'],
      ["book: a page answered, and its answer didn't read", 'flights.results', 'shape'],
      ["book: a page answered, and its answer didn't read", 'flights.results', 'not_sent'],
    ]);
    expect(said[0]!.obj.caps).toEqual([{ match: STREAM, status: 403, bytes: 23, truncated: false }]);
    expect(said[1]!.obj.caps).toEqual([{ match: STREAM, status: 200, bytes: 900, truncated: true }]);
    // A shape refusal says what the reader made of it, in counts: one event, one value, one row found, none read.
    expect(said[2]!.obj.shape).toEqual({ events: 1, values: 1, rows: 1 });
    expect(said[0]!.obj.shape).toBeUndefined();
    // Never a body: only the match, status, size and cut of each capture.
    expect(JSON.stringify(said)).not.toContain('Forbidden');
    expect(JSON.stringify(said)).not.toContain('flightJourneys');
  });

  it('reads a stream whose one event comes split over several data lines, as the stream format allows', async () => {
    const body = fixture('flights-del-goi-2026-11-13.sse');
    // The same event, its value written over many lines, each a data line of its own.
    const value: unknown = JSON.parse(body.trim().slice('data:'.length));
    const split = `${JSON.stringify(value, null, 1).split('\n').map((l) => `data:${l}`).join('\n')}\n\n`;
    const { engine } = engineWith(() => [capture(STREAM, STREAM_URL, split)]);
    const got = await engine.answer('flights.results', GIVEN, { tripId: 't_split' });
    expect(got.as === 'options' && got.options.map((o) => o.title)).toEqual(['Air-India Express IX1196', 'IndiGo 6E328 + 6E5106', 'Air-India Express IX1108', 'IndiGo 6E5341']);
    // And two events, each one value on its own line, read as two.
    const { engine: two } = engineWith(() => [capture(STREAM, STREAM_URL, `${body.trim()}\n\n${body.trim()}\n\n`)]);
    const both = await two.answer('flights.results', GIVEN, { tripId: 't_two' });
    expect(both.as === 'options' && both.options).toHaveLength(4);
  });

  // A logged-in browser's stream may differ (10 Oct): more than one event, named event types, comments, fields Go doesn't
  // read. Every event's value is read, and the flights of each merge, once each.
  it("merges the flights of every event, whatever its event type, around other events and comments", async () => {
    const value = JSON.parse(fixture('flights-del-goi-2026-11-13.sse').trim().slice('data:'.length)) as { data: { flightJourneys: Array<{ flightFare: unknown[] }> } };
    const fares = value.data.flightJourneys[0]!.flightFare;
    const part = (from: number, to: number) => JSON.stringify({ ...value, data: { ...value.data, extra: { loyalty: true }, flightJourneys: [{ ...value.data.flightJourneys[0], flightFare: fares.slice(from, to) }] } });
    const stream = [
      ': ok', '',
      'event: meta', 'data: {"data":{"type":"META","userTier":"x"}}', '',
      'event: result', `id: 1`, `data: ${part(0, 3)}`, '',
      'event: result', `id: 2`, `data: ${part(2, 4)}`, '',
    ].join('\n');
    const { engine } = engineWith(() => [capture(STREAM, STREAM_URL, stream)]);
    const got = await engine.answer('flights.results', GIVEN, { tripId: 't_events' });
    expect(got.as === 'options' && got.options.map((o) => o.title)).toEqual(['Air-India Express IX1196', 'IndiGo 6E328 + 6E5106', 'Air-India Express IX1108', 'IndiGo 6E5341']);
  });

  it("reads the flights from ixigo's stream: each one's airline and numbers, its fare per person, its times and stops", async () => {
    const { engine, runs } = engineWith(() => [capture(STREAM, STREAM_URL, fixture('flights-del-goi-2026-11-13.sse'))]);
    const got = await engine.answer('flights.results', GIVEN, { tripId: 't_goa' });
    if (got.as !== 'options') throw new Error(got.as);
    expect(runs[0]!.url).toContain('/search/result/flight?from=DEL&to=GOI&date=13112026&');
    // Bash's most a capture keeps (1 MB): a long route's stream is never cut short of it.
    expect(runs[0]!.plan.capture).toEqual([{ match: STREAM, required: true, max_bytes: 1_048_576 }]);
    expect(got.options.map((o) => o.title)).toEqual(['Air-India Express IX1196', 'IndiGo 6E328 + 6E5106', 'Air-India Express IX1108', 'IndiGo 6E5341']);
    expect(got.options[0]).toMatchObject({
      kind: 'flight', priceMinor: 863_000, currency: 'INR', priceNote: 'per person',
      journey: {
        mode: 'flight', origin: { name: 'New Delhi', code: 'DEL' }, destination: { name: 'Goa', code: 'GOI' },
        depart_at: '2026-11-13T18:35:00+05:30', arrive_at: '2026-11-13T21:15:00+05:30',
        carrier_name: 'Air-India Express', carrier_code: 'IX', number: 'IX1196', stops: 0,
      },
      highlights: ['Non-stop', '2 h 40 m'],
      facts: { stops: 0, duration_min: 160, flights: 'IX1196' },
    });
    // A flight with a stop lands the next day: the arrival is the departure and the whole journey's length.
    expect(got.options[1]).toMatchObject({
      priceMinor: 942_200, journey: { depart_at: '2026-11-13T17:45:00+05:30', arrive_at: '2026-11-14T00:40:00+05:30', stops: 1, number: '6E328' }, highlights: ['1 stop', '6 h 55 m'],
    });
    // Goa's other airport is said as Goa, with its own code.
    expect(got.options[2]!.journey!.destination).toEqual({ name: 'Goa', code: 'GOX' });
  });

  it('loads one flights page across every trip in 20 s, and none for 10 minutes after ixigo refused one: held back, it fails at once, loading nothing', async () => {
    let nowMs = Date.parse('2026-10-09T18:00:00Z');
    let refuse = false;
    const runs: string[] = [];
    const runner = {
      read: async (_trip: string, url: string) => {
        runs.push(url);
        return { captures: [capture(STREAM, STREAM_URL, refuse ? '{"message":"Forbidden"}' : fixture('flights-del-goi-2026-11-13.sse'), refuse ? 403 : 200)], finalUrl: url };
      },
    };
    const engine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: HOMES }), now: () => new Date(nowMs) });
    expect((await engine.answer('flights.results', GIVEN, { tripId: 't_a' })).as).toBe('options');
    // Another trip 5 s later: held back (one flights page across every trip in 20 s), nothing loaded.
    nowMs += 5_000;
    expect(engine.pacedOut('flights.results')).toBe(true);
    await expect(engine.answer('flights.results', { ...GIVEN, date: '2026-11-14' }, { tripId: 't_b' })).rejects.toMatchObject({ code: 'unreachable' });
    expect(runs).toHaveLength(1);
    // 20 s on, the page loads; ixigo refuses it (403): ten quiet minutes follow.
    nowMs += 20_000;
    refuse = true;
    await expect(engine.answer('flights.results', { ...GIVEN, date: '2026-11-15' }, { tripId: 't_b' })).rejects.toMatchObject({ code: 'refused' });
    expect(runs).toHaveLength(2);
    nowMs += 9 * 60_000;
    expect(engine.pacedOut('flights.results')).toBe(true);
    refuse = false;
    nowMs += 61_000;
    expect(engine.pacedOut('flights.results')).toBe(false);
    expect((await engine.answer('flights.results', { ...GIVEN, date: '2026-11-16' }, { tripId: 't_b' })).as).toBe('options');
    expect(runs).toHaveLength(3);
    // Every other recipe is never paced.
    expect(engine.pacedOut('trains.between')).toBe(false);
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
