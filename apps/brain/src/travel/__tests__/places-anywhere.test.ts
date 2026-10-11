import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GO_RULES } from '../../composer/rules.js';
import type { TurnCtx } from '../../composer/tools.js';
import { withSchema } from '../../db/test-db.js';
import { goaPack } from '../../tasks/testing/goa.js';
import type { Images } from '../images.js';
import { loadBook } from '../book/book.js';
import { createEngine } from '../book/engine.js';
import { createIxigoWebBackend } from '../recipes/backend.js';
import { airportOf, forgetLearnedPlaces, stayPlaceOf } from '../recipes/places.js';
import { learnFromPage, loadLearnedPlaces } from '../recipes/places-store.js';
import type { ResultsStore } from '../results.js';
import { travelTools } from '../tools.js';
import type { Travel } from '../travel.js';
import { TravelError } from '../mcp-travel.js';

let db: { pool: Pool; drop: () => Promise<void> };
beforeAll(async () => { db = await withSchema(); });
afterAll(async () => { await db.drop(); });
afterEach(() => forgetLearnedPlaces());

/** The sites Go must never send anyone to. */
const OTHER_SITES = /google flights|skyscanner|makemytrip|booking\.com|airbnb|cleartrip|goibibo|agoda|kayak|expedia/i;

// The Goa trip: Rahul, Priya and Kabir live in Delhi, Arjun in Bangalore, Meher in Mumbai.
const pack = goaPack();
const { book } = loadBook();
const now = () => new Date('2026-10-07T12:00:31Z');
// No trip's computer here: a flight link loads nothing, and a place Go has not searched can't be asked of ixigo's box.
const engine = createEngine({
  book,
  runner: () => null,
  trip: async () => ({ people: pack.trip.people.length, homes: pack.trip.people.flatMap((p) => (p.from_city ? [p.from_city] : [])) }),
  now,
});
const backend = createIxigoWebBackend({ book, engine, now });

function tool(name: string) {
  const cards: Array<Record<string, unknown>> = [];
  const turn = { tripId: 't_goa', turnId: 'turn_w1', cards, pack, wake: [], stableId: (p: string) => `${p}_turn_w1_1` } as unknown as TurnCtx;
  // The page ixigo's own link opens, set as the search ran: Go shows it nobody (G1), but it says what the search asked.
  const links: string[] = [];
  const travel = {
    search: (kind: never, q: never, o: never) => backend.search(kind, q, o).catch((err: unknown) => { if (err instanceof TravelError && err.link) links.push(err.link); throw err; }),
    waitMs: async () => null,
  } as unknown as Travel;
  const tools = travelTools({ travel, results: {} as ResultsStore, images: {} as Images, now: () => new Date('2026-10-07T12:00:31Z') });
  const t = tools.find((x) => x.name === name)!;
  return { cards, links, run: (args: Record<string, unknown>) => t.run(args, turn) as Promise<Record<string, unknown>> };
}

describe('a flight anywhere', () => {
  it("London to Delhi on 20 Oct, non-stop: searched as LHR to DEL, the date, the travellers, non-stop and the cheapest first", async () => {
    // Keshav's ask on staging: "@Go what is the most economical non stop flight between London and Delhi on 20th October?"
    const t = tool('search_flights');
    const out = await t.run({ from: 'London (LHR)', to: 'Delhi', date: '2026-10-20', non_stop: true });
    const link = String(t.links.at(-1));
    expect(link).toMatch(/^https:\/\/www\.ixigo\.com\/search\/result\/flight\?from=LHR&to=DEL&date=20102026&/);
    // Nobody in the trip lives by Heathrow, so the link is for the whole group.
    expect(link).toContain('&adults=5&');
    expect(link).toContain('&stops=0');
    expect(link.endsWith('&sort_type=cheapest')).toBe(true);
    // No page loads here, so Go says it plainly: never ixigo's link on a card (G1, 11 Oct).
    expect(t.cards).toEqual([]);
    expect(out).toMatchObject({ not_loaded: true, tell_the_room: expect.stringContaining("I couldn't load flights from London (LHR) to Delhi just now") });
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
  // The lead, 11 Oct (with G1): said in words, the nearest place ixigo knows offered, never ixigo's own search page.
  it("says which place ixigo doesn't know and offers the nearest it would, with no card, and never names another site", async () => {
    for (const [name, args, stop] of [
      ['search_flights', { from: 'London', to: 'Delhi', date: '2026-10-20' }, 'an airport'],
      ['search_trains', { from: 'Kasol', to: 'Delhi', date: '2026-11-06' }, 'a station'],
      ['search_buses', { from: 'Manali', to: 'Delhi', date: '2026-11-06' }, 'a stop'],
      ['search_stays', { area: 'Manali', check_in: '2026-11-06', check_out: '2026-11-09' }, 'a place to stay'],
    ] as const) {
      const t = tool(name);
      const out = await t.run(args);
      expect(out, name).toMatchObject({ count: 0, unknown_place: expect.stringContaining('Go has no ixigo') });
      expect(out.tell_the_room, name).toContain(`which place ixigo doesn't know as ${stop}`);
      expect(out.tell_the_room, name).toContain('Search from there?');
      expect(out.tell_the_room, name).toContain('Never send them to ixigo');
      expect(out.tell_the_room, name).toContain('Never name or suggest any other travel or booking site or app');
      expect(JSON.stringify(out), name).not.toMatch(OTHER_SITES);
      expect(JSON.stringify(out), name).not.toContain('ixigo.com');
      expect(out, name).not.toHaveProperty('error');
      expect(t.cards, name).toEqual([]);
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
    // The stays search goes straight to Manali's results page: no lookup, one page.
    const opened: string[] = [];
    const reading = createEngine({
      book, runner: () => ({ read: async (_t: string, url: string) => { opened.push(url); return { captures: [], finalUrl: url }; } }), trip: async () => ({ people: 5, homes: [] }), now,
    });
    await reading.answer('hotels.search', { place: 'Manali', check_in: '2026-11-06', check_out: '2026-11-09' }, { tripId: 't_mnl' }).catch(() => undefined);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain('/hotels/search/result?locationId=4567&locationName=Manali&locationType=C&masterLocationId=48890&countryId=1');
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
