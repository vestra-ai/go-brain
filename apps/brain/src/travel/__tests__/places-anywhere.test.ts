import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GO_RULES } from '../../composer/rules.js';
import type { TurnCtx } from '../../composer/tools.js';
import { withSchema } from '../../db/test-db.js';
import { goaPack } from '../../tasks/testing/goa.js';
import type { Images } from '../images.js';
import { createIxigoWebBackend, LINK_ONLY_KINDS } from '../recipes/backend.js';
import { airportOf, forgetLearnedPlaces, stayPlaceOf } from '../recipes/places.js';
import { learnFromPage, loadLearnedPlaces } from '../recipes/places-store.js';
import { stays } from '../recipes/stays.js';
import type { ResultsStore } from '../results.js';
import { travelTools } from '../tools.js';
import type { Travel } from '../travel.js';

let db: { pool: Pool; drop: () => Promise<void> };
beforeAll(async () => { db = await withSchema(); });
afterAll(async () => { await db.drop(); });
afterEach(() => forgetLearnedPlaces());

/** The sites Go must never send anyone to. */
const OTHER_SITES = /google flights|skyscanner|makemytrip|booking\.com|airbnb|cleartrip|goibibo|agoda|kayak|expedia/i;

// The Goa trip: Rahul, Priya and Kabir live in Delhi, Arjun in Bangalore, Meher in Mumbai.
const pack = goaPack();
const backend = createIxigoWebBackend({
  runner: () => ({ name: 'browser_fetch', run: async () => { throw new Error('this test loads no page'); } }) as never,
  peopleOf: async () => pack.trip.people.length,
  homesOf: async () => pack.trip.people.flatMap((p) => (p.from_city ? [p.from_city] : [])),
  now: () => new Date('2026-10-07T12:00:31Z'),
  linkOnly: (kind) => LINK_ONLY_KINDS.has(kind),
});

function tool(name: string) {
  const cards: Array<Record<string, unknown>> = [];
  const turn = { tripId: 't_goa', turnId: 'turn_w1', cards, pack, wake: [], stableId: (p: string) => `${p}_turn_w1_1` } as unknown as TurnCtx;
  const travel = { search: (kind: never, q: never, o: never) => backend.search(kind, q, o), waitMs: async () => null } as unknown as Travel;
  const tools = travelTools({ travel, results: {} as ResultsStore, images: {} as Images, now: () => new Date('2026-10-07T12:00:31Z') });
  const t = tools.find((x) => x.name === name)!;
  return { cards, run: (args: Record<string, unknown>) => t.run(args, turn) as Promise<Record<string, unknown>> };
}

describe('a flight anywhere', () => {
  it("London to Delhi on 20 Oct, non-stop: ixigo's link for LHR to DEL, the date, the travellers, non-stop and the cheapest first", async () => {
    // Keshav's ask on staging: "@Go what is the most economical non stop flight between London and Delhi on 20th October?"
    const t = tool('search_flights');
    const out = await t.run({ from: 'London (LHR)', to: 'Delhi', date: '2026-10-20', non_stop: true });
    const link = String(out.link);
    expect(link).toMatch(/^https:\/\/www\.ixigo\.com\/search\/result\/flight\?from=LHR&to=DEL&date=20102026&/);
    // Nobody in the trip lives by Heathrow, so the link is for the whole group.
    expect(link).toContain('&adults=5&');
    expect(link).toContain('&stops=0');
    expect(link.endsWith('&sort_type=cheapest')).toBe(true);
    expect(t.cards).toEqual([expect.objectContaining({ kind: 'notice', title: 'Flights, London (LHR) to Delhi', source: { name: 'ixigo', url: link } })]);
    expect(JSON.stringify(out)).not.toMatch(OTHER_SITES);
  });

  it("takes the airport code the model knows, in brackets, and never a guess from a bare name", () => {
    expect(airportOf('Reykjavik (KEF)')).toEqual({ code: 'KEF', city: 'Reykjavik' });
    expect(() => airportOf('Reykjavik')).toThrow(expect.objectContaining({ code: 'unknown_place' }));
    // Not a code: lower case, or not three letters.
    expect(() => airportOf('Reykjavik (kef)')).toThrow(expect.objectContaining({ code: 'unknown_place' }));
    expect(() => airportOf('Reykjavik (KEFL)')).toThrow(expect.objectContaining({ code: 'unknown_place' }));
  });
});

describe('a place Go has no ixigo code for', () => {
  it("answers with ixigo's own page for that kind of search, and never names another site", async () => {
    for (const [name, args, url, label] of [
      ['search_flights', { from: 'London', to: 'Delhi', date: '2026-10-20' }, 'https://www.ixigo.com/flights', 'See flights on ixigo'],
      ['search_trains', { from: 'Kasol', to: 'Delhi', date: '2026-11-06' }, 'https://www.ixigo.com/trains', 'See trains on ixigo'],
      ['search_buses', { from: 'Manali', to: 'Delhi', date: '2026-11-06' }, 'https://www.ixigo.com/buses', 'See buses on ixigo'],
      ['search_stays', { area: 'Manali', check_in: '2026-11-06', check_out: '2026-11-09' }, 'https://www.ixigo.com/hotels', 'See hotels on ixigo'],
    ] as const) {
      const t = tool(name);
      const out = await t.run(args);
      expect(out, name).toMatchObject({ count: 0, link: url });
      expect(out.tell_the_room, name).toContain('Never name or suggest any other travel or booking site or app');
      expect(JSON.stringify(out), name).not.toMatch(OTHER_SITES);
      expect(out, name).not.toHaveProperty('error');
      expect(t.cards, name).toEqual([expect.objectContaining({ kind: 'notice', source: { name: 'ixigo', url }, actions: [expect.objectContaining({ action_id: 'see_on_ixigo', label })] })]);
    }
  });
});

describe('the places ixigo resolved', () => {
  // A results page an ixigo form landed on for "Manali" (the ids here are made up for the test).
  const MANALI = 'https://www.ixigo.com/hotels/search/result?locationId=4567&locationName=Manali&locationType=C&masterLocationId=48890&countryId=1&checkinDate=06112026&checkoutDate=09112026&adultCount=2&roomCount=1&childCount=0';

  it('are learnt from the results page for the words people used, kept, and back after a restart', async () => {
    expect(() => stayPlaceOf('Manali')).toThrow(expect.objectContaining({ code: 'unknown_place' }));
    expect(await learnFromPage(db.pool, 'stays', { area: 'manali ' }, MANALI)).toBe(1);
    const manali = { locationId: 4567, locationName: 'Manali', locationType: 'C', masterLocationId: 48890, countryId: 1 };
    expect(stayPlaceOf('Manali')).toEqual({ location: manali, areas: [], half: null });
    // A restart: the cache is empty until the boot load puts travel_places back.
    forgetLearnedPlaces();
    expect(() => stayPlaceOf('Manali')).toThrow(expect.objectContaining({ code: 'unknown_place' }));
    expect(await loadLearnedPlaces(db.pool)).toBe(1);
    const slots = stays.slotsFrom({ area: 'Manali', checkIn: '2026-11-06', checkOut: '2026-11-09' }, { people: 5 });
    expect(slots).toMatchObject({ location: manali, half: null, wide: false });
    expect(stays.url(slots)).toContain('locationId=4567&locationName=Manali&locationType=C&masterLocationId=48890&countryId=1');
  });

  it("learn a flight's airports, and nothing from a page that isn't ixigo's results", async () => {
    const page = 'https://www.ixigo.com/search/result/flight?from=LHR&to=DEL&date=20102026&returnDate=&adults=1&children=0&infants=0&class=e&source=Search%20Form';
    expect(await learnFromPage(db.pool, 'flights', { from: 'london', to: 'delhi' }, page)).toBe(2);
    expect(airportOf('London')).toEqual({ code: 'LHR', city: 'London' });
    expect(await learnFromPage(db.pool, 'flights', { from: 'paris', to: 'delhi' }, 'https://www.ixigo.com/flights')).toBe(0);
    expect(() => airportOf('Paris')).toThrow(expect.objectContaining({ code: 'unknown_place' }));
  });
});

describe("Go's rules", () => {
  it('never name another travel or booking site, and give a flight abroad its airport code', () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nTruth and money\n'), GO_RULES.indexOf('\nForget me\n'));
    expect(section).toContain('Never name or suggest another travel or booking site or app (Google Flights, Skyscanner, MakeMyTrip, Booking.com, Airbnb, Cleartrip, Goibibo, Agoda or any other)');
    expect(section).toContain('search it, or give ixigo\'s page for it.');
    expect(section).toContain('"London (LHR)"');
  });
});
