import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createOffers } from '../../recipes/offers.js';
import type { Capture } from '../../recipes/recipe.js';
import { capture, fixture } from '../../recipes/__tests__/fixtures.js';
import { BOOK_DIR, loadBook } from '../book.js';
import { createEngine, type EngineAnswer } from '../engine.js';
import { readSuggestions } from '../lookup.js';

// Staging, 10 Oct: Keshav's logged-in browser got flights in a shape the logged-out reader refused. Every search recipe
// reads its logged-out sample and a logged-in style variant of it the same: the body wrapped beside the person's own
// fields, numbers the reader uses sent as text, a field nobody reads on every row. The variants are built here from the
// recorded samples; none holds anyone's data.
const { book } = loadBook();
const sample = (name: string): string => readFileSync(`${BOOK_DIR}samples/${name}`, 'utf8');

/** What a logged-in or personalised answer may do to a body, all at once. */
interface Personalised {
  /** Keys whose numbers come as text ("4.5", "1120"). */
  strings: string[];
  /** A key a row has: each object with it gets a field nobody reads. */
  rows: string;
  /** The body wrapped beside the person's own fields; for a stream, each event's value. */
  wrap?: boolean;
}

function personalised(v: unknown, p: Personalised): unknown {
  if (Array.isArray(v)) return v.map((x) => personalised(x, p));
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = typeof x === 'number' && p.strings.includes(k) ? String(x) : personalised(x, p);
  if (p.rows in out) out['memberOffer'] = { label: 'Member price', percent: 5 };
  return out;
}

/** A JSON body as a logged-in browser might get it. */
function loggedIn(json: string, p: Personalised): string {
  const body = personalised(JSON.parse(json), p);
  return JSON.stringify(p.wrap === false ? body : { response: body, user: { loggedIn: true, tier: 'GOLD', wallet: { points: 120 } } });
}

/** A server-sent stream as a logged-in browser might get it: each event's value personalised and wrapped. */
function loggedInStream(text: string, p: Personalised): string {
  return text
    .split(/\r?\n\r?\n/)
    .filter((e) => e.trim().length > 0)
    .map((e) => {
      const data = e.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      return `event: result\ndata: ${loggedIn(data, p)}`;
    })
    .join('\n\n') + '\n\n';
}

function engineWith(captures: (url: string) => Capture[], o: { offers?: ReturnType<typeof createOffers>; people?: number } = {}) {
  const runner = { read: async (_trip: string, url: string) => ({ captures: captures(url), finalUrl: url }) };
  return createEngine({
    book, runner: () => runner, trip: async () => ({ people: o.people ?? 4, homes: [] }), now: () => new Date('2026-10-10T04:00:00Z'),
    ...(o.offers ? { offers: o.offers } : {}),
  });
}

/** What a read gives, without when it was read. */
const read = (a: EngineAnswer): unknown => (a.as === 'options' ? a.options : a.as === 'facts' ? a.rows : a);

/** The same recipe read from the logged-out captures and the logged-in ones: the same answer, and not an empty one. */
async function same(id: string, given: Record<string, unknown>, out: (url: string) => Capture[], inn: (url: string) => Capture[]) {
  const plain = read(await engineWith(out).answer(id, given, { tripId: 't_out' }));
  const personal = read(await engineWith(inn).answer(id, given, { tripId: 't_in' }));
  expect(Array.isArray(plain) && plain.length).toBeGreaterThan(0);
  expect(personal).toEqual(plain);
}

describe("a logged-in browser's answers read as the logged-out ones do", () => {
  it('hotels.search: its stays, from both pages of all of Goa', async () => {
    const SEARCH = '/accommodation-search/api/v3/accommodations/search$';
    const URL = 'https://www.ixigo.com/accommodation-search/api/v3/accommodations/search';
    const p: Personalised = { strings: ['hotelId', 'displayedBaseFare', 'taxesAndFees', 'userRatingCount', 'starRating', 'userRating', 'locationId'], rows: 'hotelId' };
    const pages = (f: (s: string) => string) => () => [capture(SEARCH, URL, f(fixture('stays-goa-page1.json'))), capture(SEARCH, URL, f(fixture('stays-goa-page2.json')))];
    await same('hotels.search', { place: 'Goa', check_in: '2026-11-06', check_out: '2026-11-09' }, pages((s) => s), pages((s) => loggedIn(s, p)));
  });

  it("hotels.search's list of ixigo's own filters and sorts, from its metadata call", async () => {
    const META = '/accommodation-search/api/v2/accommodations/search/metadata$';
    const listed = async (body: string) => {
      const offers = createOffers({ now: () => new Date('2026-10-10T04:00:00Z') });
      const engine = engineWith(() => [
        capture('/accommodation-search/api/v3/accommodations/search$', 'https://www.ixigo.com/accommodation-search/api/v3/accommodations/search', fixture('stays-goa-page1.json')),
        capture(META, 'https://www.ixigo.com/accommodation-search/api/v2/accommodations/search/metadata?locationId=32', body),
      ], { offers });
      await engine.answer('hotels.search', { place: 'Goa', check_in: '2026-11-06', check_out: '2026-11-09' }, { tripId: 't_offers' });
      return offers.get('hotels.search', '32')?.offers ?? [];
    };
    const plain = await listed(sample('hotels.search_filters.json'));
    expect(plain.length).toBeGreaterThan(0);
    expect(await listed(loggedIn(sample('hotels.search_filters.json'), { strings: [], rows: 'code' }))).toEqual(plain);
  });

  it('trains.between: each train and class, its fare and seats', async () => {
    const BETWEEN = 'https://www.ixigo.com/trains/v1/search/between/NDLS/MAO?date=2026-11-06&languageCode=en';
    const SEATS = 'https://www.ixigo.com/api/v3/trains/availability';
    const p: Personalised = { strings: ['baseFare', 'f', 'p'], rows: 'attributes' };
    const page = (f: (s: string) => string) => () => [
      capture('/trains/v1/search/between/', BETWEEN, f(fixture('trains-ndls-mao-between.json'))),
      capture('/api/v3/trains/availability', SEATS, f(fixture('trains-ndls-mao-availability.json'))),
    ];
    await same('trains.between', { from: 'Delhi', to: 'Goa', date: '2026-11-06' }, page((s) => s), page((s) => loggedIn(s, p)));
  });

  it("trains.confirm_chance: each class's seats and ixigo's chance a waitlisted ticket confirms", async () => {
    const BETWEEN = 'https://www.ixigo.com/trains/v1/search/between/NDLS/MAO?date=2026-11-06&languageCode=en';
    const SEATS = 'https://www.ixigo.com/api/v3/trains/availability';
    const p: Personalised = { strings: ['f', 'p'], rows: 'attributes' };
    const page = (f: (s: string) => string) => () => [
      capture('/trains/v1/search/between/', BETWEEN, f(fixture('trains-ndls-mao-between.json'))),
      capture('/api/v3/trains/availability', SEATS, f(fixture('trains-ndls-mao-availability.json'))),
    ];
    await same('trains.confirm_chance', { from: 'Delhi', to: 'Goa', date: '2026-11-06' }, page((s) => s), page((s) => loggedIn(s, p)));
  });

  it("trains.station_lookup: a city's stations from ixigo's box", async () => {
    const lookup = book.get('trains.station_lookup')!;
    const URL = 'https://www.ixigo.com/action/content/trainstation?searchFor=trainstationsLatLon&anchor=false&value=udaipur';
    const plain = await readSuggestions(lookup, [capture('searchFor=trainstationsLatLon', URL, sample('trains.station_lookup.udaipur.json'))], 'udaipur');
    expect(plain.length).toBeGreaterThan(0);
    const personal = await readSuggestions(lookup, [capture('searchFor=trainstationsLatLon', URL, loggedIn(sample('trains.station_lookup.udaipur.json'), { strings: [], rows: 'e' }))], 'udaipur');
    expect(personal).toEqual(plain);
  });

  it('buses.between: each bus, its fare, rating and seats left', async () => {
    const SERVICES = '/buslist/v3/services$';
    const URL = 'https://www.ixigo.com/buslist/v3/services';
    const p: Personalised = { strings: ['availableSeats', 'rating', 'noOfRatings', 'offerPrice', 'fare'], rows: 'travelerAgentName' };
    await same(
      'buses.between', { from: 'Mumbai', to: 'Goa', date: '2026-11-06' },
      () => [capture(SERVICES, URL, fixture('buses-mumbai-goa.json'))],
      () => [capture(SERVICES, URL, loggedIn(fixture('buses-mumbai-goa.json'), p))],
    );
  });

  it("plan.destination: the guide's best time, weather and its places, their ratings sent as text", async () => {
    const html = sample('plan.destination.html');
    // The page's payload is escaped inside its document: its ratings as text, and a field nobody reads beside each.
    const personal = html.replace(/\\"rating\\":(\d+(?:\.\d+)?)/g, '\\"rating\\":\\"$1\\",\\"memberOffer\\":\\"5%\\"');
    expect(personal).not.toBe(html);
    await same('plan.destination', { place: 'Goa' }, (url) => [capture('/plan/goa$', url, html)], (url) => [capture('/plan/goa$', url, personal)]);
  });

  it('flights.results: each flight, its fare, time and stops, from a stream whose events come wrapped', async () => {
    const STREAM = '/flights/v2/search/stream';
    const URL = 'https://www.ixigo.com/flights/v2/search/stream';
    const p: Personalised = { strings: ['displayFare', 'time', 'stop'], rows: 'flightKeys' };
    const body = fixture('flights-del-goi-2026-11-13.sse');
    await same('flights.results', { from: 'Delhi', to: 'Goa', date: '2026-11-13' }, () => [capture(STREAM, URL, body)], () => [capture(STREAM, URL, loggedInStream(body, p))]);
  });
});
