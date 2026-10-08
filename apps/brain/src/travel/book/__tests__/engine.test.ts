import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../../db/test-db.js';
import { TravelError } from '../../mcp-travel.js';
import { forgetLearnedPlaces } from '../../recipes/places.js';
import { loadLearnedPlaces } from '../../recipes/places-store.js';
import type { Capture, FetchPlan } from '../../recipes/recipe.js';
import { capture, fixture } from '../../recipes/__tests__/fixtures.js';
import { BOOK_DIR, checkRecipe, loadBook, type Book } from '../book.js';
import { createEngine, isPayments } from '../engine.js';

let db: { pool: Pool; drop: () => Promise<void> };
beforeAll(async () => { db = await withSchema(); });
afterAll(async () => { await db.drop(); });
afterEach(() => forgetLearnedPlaces());

const { book } = loadBook();
const sample = (name: string): string => readFileSync(`${BOOK_DIR}samples/${name}`, 'utf8');
const SEARCH = '/accommodation-search/api/v3/accommodations/search$';

/** A trip's browser that answers ixigo's box with a sample, and any results page with a saved page. */
function browser(box: (url: string, plan: FetchPlan) => Capture[], results: Capture[] = []) {
  const runs: Array<{ url: string; plan: FetchPlan }> = [];
  return {
    runs,
    runner: {
      read: async (_trip: string, url: string, plan: FetchPlan) => {
        runs.push({ url, plan });
        const resultsPage = ['/search/result', '/bus_search/', '/search-pwa/'].some((p) => url.includes(p));
        return { captures: resultsPage ? results : box(url, plan), finalUrl: url };
      },
    },
  };
}

const engineFor = (b: Book, runner: ReturnType<typeof browser>['runner']) =>
  createEngine({ book: b, runner: () => runner, pool: db.pool, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-07T12:00:00Z') });

describe('a place Go has not searched before', () => {
  it("is asked of ixigo's own suggestion call, opened as the page with nothing typed, picked, kept, and gone straight to the next time, after a restart too", async () => {
    // The 8 Oct drill: typing Manali into the hotels box timed out on the box's browser. The call itself needs no box.
    const SUGGEST = 'https://www.ixigo.com/hotels-autocompleter/api/v2/results?query=Manali&size=10&v=3';
    const b = browser(
      (url) => (url === SUGGEST ? [capture('/hotels-autocompleter/api/v2/results', SUGGEST, sample('hotels.place_lookup.manali.json'))] : []),
      [capture(SEARCH, 'https://www.ixigo.com/accommodation-search/api/v3/accommodations/search', fixture('stays-goa-page1.json'))],
    );
    const engine = engineFor(book, b.runner);
    const ask = { place: 'Manali', check_in: '2026-11-06', check_out: '2026-11-09' };
    const got = await engine.answer('hotels.search', ask, { tripId: 't_mnl' });
    expect(b.runs.map((r) => r.url)).toEqual([
      SUGGEST,
      'https://www.ixigo.com/hotels/search/result?locationId=184&locationName=Manali&locationType=C&masterLocationId=9425&countryId=1&checkinDate=06112026&checkoutDate=09112026&adultCount=4&roomCount=2&childCount=0',
    ]);
    expect(b.runs[0]!.plan).toEqual({ capture: [{ match: '/hotels-autocompleter/api/v2/results', required: true, min_count: 1, max_count: 1, max_bytes: 200_000 }], steps: [] });
    expect(got.as === 'options' && got.options.length).toBeGreaterThan(0);
    // Kept: after a restart, the same words go straight to the results page.
    forgetLearnedPlaces();
    expect(await loadLearnedPlaces(db.pool)).toBe(1);
    b.runs.length = 0;
    await engine.answer('hotels.search', ask, { tripId: 't_mnl' });
    expect(b.runs.map((r) => r.url.split('?')[0])).toEqual(['https://www.ixigo.com/hotels/search/result']);
  });

  it('hands the model ixigo\'s list when more than one place fits, and takes the one it names, for the words asked too', async () => {
    const two = JSON.stringify([{ e: 'Udaipur City (UDZ)', c: '' }, { e: 'Udaipur Junction (UDPU)', c: '' }]);
    const trains = [capture('/trains/v1/search/between/', 'https://www.ixigo.com/trains/v1/search/between/JP/UDZ?date=2026-10-20&languageCode=en', fixture('trains-ndls-mao-between.json'))];
    const b = browser(() => [capture('searchFor=trainstationsLatLon', 'https://www.ixigo.com/action/content/trainstation?searchFor=trainstationsLatLon&anchor=false&value=Udaipur', two)], trains);
    const engine = engineFor(book, b.runner);
    const err = await engine.answer('trains.between', { from: 'Jaipur', to: 'Udaipur', date: '2026-10-20' }, { tripId: 't_udr' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TravelError);
    expect(err).toMatchObject({ code: 'pick_place' });
    expect((err as TravelError).message).toContain('"Udaipur City (UDZ)"; "Udaipur Junction (UDPU)"');
    expect(b.runs).toHaveLength(1);
    // The model names one: no second load, and "Udaipur" now means that one.
    const named = await engine.answer('trains.between', { from: 'Jaipur', to: 'Udaipur City (UDZ)', date: '2026-10-20' }, { tripId: 't_udr' });
    expect(named.as === 'options' && named.page).toBe('https://www.ixigo.com/search/result/train/JP/UDZ/20102026//1/0/0/0/ALL');
    const again = await engine.answer('trains.between', { from: 'Jaipur', to: 'Udaipur', date: '2026-10-20' }, { tripId: 't_udr' });
    expect(again.as === 'options' && again.page).toBe('https://www.ixigo.com/search/result/train/JP/UDZ/20102026//1/0/0/0/ALL');
    expect(b.runs.filter((r) => !r.url.includes('/search/result/'))).toHaveLength(1);
  });

  it('opens each end\'s own suggestion call when both places are new: two fetches at once, nothing typed, then the results page', async () => {
    const suggest = (words: string): string => `https://www.ixigo.com/action/content/trainstation?searchFor=trainstationsLatLon&anchor=false&value=${encodeURIComponent(words)}`;
    const bodies: Record<string, string> = {
      [suggest('Bikaner')]: JSON.stringify([{ e: 'Bikaner Jn (BKN)', c: '' }]),
      [suggest('Udaipur City')]: JSON.stringify([{ e: 'Udaipur City (UDZ)', c: '' }]),
    };
    const trains = [capture('/trains/v1/search/between/', 'https://www.ixigo.com/trains/v1/search/between/BKN/UDZ?date=2026-10-20&languageCode=en', fixture('trains-ndls-mao-between.json'))];
    const b = browser((url) => (bodies[url] ? [capture('searchFor=trainstationsLatLon', url, bodies[url]!)] : []), trains);
    const got = await engineFor(book, b.runner).answer('trains.between', { from: 'Bikaner', to: 'Udaipur City', date: '2026-10-20' }, { tripId: 't_bkn' });
    expect(b.runs.map((r) => r.url)).toEqual([suggest('Bikaner'), suggest('Udaipur City'), 'https://www.ixigo.com/search/result/train/BKN/UDZ/20102026//1/0/0/0/ALL']);
    expect(b.runs.slice(0, 2).every((r) => r.plan.steps?.length === 0)).toBe(true);
    expect(got.as === 'options' && got.options.length).toBe(25);
  });

  it('is unknown_place when ixigo knows nothing for the words, so the search answers with ixigo\'s own page', async () => {
    const b = browser(() => [capture('/wap/abus-autocompleter/api/v1/results', 'https://www.ixigo.com/wap/abus-autocompleter/api/v1/results?s=Atlantis', '[]')]);
    const err = await engineFor(book, b.runner).answer('buses.between', { from: 'Atlantis', to: 'Goa', date: '2026-11-06' }, { tripId: 't_x' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'unknown_place' });
  });
});

describe('the fast speed', () => {
  const RSC = sample('plan.destination.rsc.txt');
  const PAGE = sample('plan.destination.html');

  it("makes the page's own call from the warm tab first, and loads no page when it answers", async () => {
    const calls: unknown[] = [];
    const pages: string[] = [];
    const runner = {
      read: async (_t: string, url: string) => {
        pages.push(url);
        return { captures: [capture('/plan/goa$', url, PAGE)], finalUrl: url };
      },
      pageFetch: async (_t: string, call: { url: string; method: string; headers?: Record<string, string> }) => {
        calls.push(call);
        return { ...capture('fast', '/plan/goa', RSC), content_type: 'text/x-component' };
      },
    };
    const engine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-07T12:00:00Z') });
    const got = await engine.answer('plan.destination', { place: 'Goa' }, { tripId: 't_fast' });
    expect(calls).toEqual([{ url: '/plan/goa', method: 'GET', headers: { RSC: '1' } }]);
    expect(pages).toEqual([]);
    expect(got.as === 'facts' && got.rows[0]).toMatchObject({ destination: 'Goa, India', best_time: 'November - March' });
    expect(engine.stats().map((s) => [s.recipe, s.speed, s.runs, s.failed])).toEqual([['plan.destination', 'fast', 1, 0]]);
  });

  it('falls to the page speed when the call fails, and counts the failed call', async () => {
    const runner = {
      read: async (_t: string, url: string) => ({ captures: [capture('/plan/goa$', url, PAGE)], finalUrl: url }),
      pageFetch: async () => {
        throw new TravelError('unreachable', "ixigo's page call answered 403.");
      },
    };
    const engine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-07T12:00:00Z') });
    const got = await engine.answer('plan.destination', { place: 'Goa' }, { tripId: 't_fast' });
    expect(got.as === 'facts' && got.rows[0]).toMatchObject({ best_time: 'November - March' });
    expect(engine.stats().map((s) => [s.recipe, s.speed, s.runs, s.failed]).sort()).toEqual([['plan.destination', 'fast', 1, 1], ['plan.destination', 'page', 1, 0]]);
  });

  it('never makes a page call to the payment page', async () => {
    const file = readFileSync(`${BOOK_DIR}plan/destination.yaml`, 'utf8').replace('fast: { url: "/plan/{$slug}"', 'fast: { url: "/payments/{$slug}"');
    expect(checkRecipe('plan/destination.yaml', file)).toEqual({ problems: ['plan/destination.yaml: file: no recipe may open or read anything under /payments/'] });
  });
});

describe('the numbers', () => {
  it('logs and counts every run by recipe and speed: the middle and slow end of its last runs, and how many failed', async () => {
    let nowMs = Date.parse('2026-10-07T12:00:00Z');
    const logged: unknown[] = [];
    const runner = {
      read: async (_t: string, url: string) => {
        nowMs += url.includes('Mumbai') ? 2_000 : 1_000;
        return { captures: [capture('/buslist/v3/services$', 'https://www.ixigo.com/buslist/v3/services', fixture('buses-mumbai-goa.json'))], finalUrl: url };
      },
    };
    const engine = createEngine({
      book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => new Date(nowMs),
      log: { info: (o: unknown) => logged.push(o), warn: () => undefined },
    });
    await engine.answer('buses.between', { from: 'Mumbai', to: 'Goa', date: '2026-11-06' }, { tripId: 't_n' });
    await engine.answer('buses.between', { from: 'Mumbai', to: 'Goa', date: '2026-11-07' }, { tripId: 't_n' });
    await engine.answer('flights.search', { from: 'Delhi', to: 'Goa', date: '2026-11-06' }, { tripId: 't_n' });
    await engine.answer('buses.between', { from: 'Atlantis', to: 'Goa', date: '2026-11-06' }, { tripId: 't_n' }).catch(() => undefined);
    expect(engine.stats()).toEqual([
      { recipe: 'buses.between', speed: 'page', runs: 3, failed: 1, p50_ms: 2_000, p90_ms: 2_000 },
      { recipe: 'buses.city_lookup', speed: 'page', runs: 1, failed: 0, p50_ms: 1_000, p90_ms: 1_000 },
      { recipe: 'flights.search', speed: 'link', runs: 1, failed: 0, p50_ms: 0, p90_ms: 0 },
    ]);
    expect(logged).toContainEqual({ recipe: 'buses.between', speed: 'page', ms: 2_000, outcome: 'ok' });
    expect(logged).toContainEqual({ recipe: 'buses.between', speed: 'page', ms: 1_000, outcome: 'unknown_place' });
  });
});

describe("ixigo's payment page", () => {
  it('is never a recipe\'s page, a lookup\'s box, or a page a run may land on', async () => {
    expect(isPayments('https://www.ixigo.com/payments/view/home/abc')).toBe(true);
    expect(isPayments('/payment/confirm')).toBe(true);
    expect(isPayments('https://www.ixigo.com/flights')).toBe(false);
    const file = readFileSync(`${BOOK_DIR}buses/between.yaml`, 'utf8').replace('page: /buses/bus_search/', 'page: /payments/bus_search/');
    expect(checkRecipe('buses/between.yaml', file)).toEqual({ problems: ['buses/between.yaml: file: no recipe may open or read anything under /payments/'] });
    // A run whose page moved on to the payment page is refused, and nothing it read is used.
    const runner = {
      read: async () => ({ captures: [capture('/buslist/v3/services$', 'https://www.ixigo.com/buslist/v3/services', fixture('buses-mumbai-goa.json'))], finalUrl: 'https://www.ixigo.com/payments/view/home/x' }),
    };
    const err = await engineFor(book, runner).answer('buses.between', { from: 'Mumbai', to: 'Goa', date: '2026-11-06' }, { tripId: 't_pay' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'refused', message: expect.stringContaining("never opens ixigo's payment page") });
  });

  it('a recipe that changes something on ixigo never runs without the group\'s yes', async () => {
    const file = readFileSync(`${BOOK_DIR}buses/between.yaml`, 'utf8').replace('changes_state: false', 'changes_state: true');
    const checked = checkRecipe('buses/between.yaml', file);
    if (!('recipe' in checked)) throw new Error('the file should check out');
    const locked: Book = { get: (id) => (id === 'buses.between' ? checked.recipe : book.get(id)), all: () => book.all() };
    const b = browser(() => []);
    const err = await engineFor(locked, b.runner).answer('buses.between', { from: 'Mumbai', to: 'Goa', date: '2026-11-06' }, { tripId: 't_lock' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'refused', message: expect.stringContaining('runs only after the group says yes') });
    expect(b.runs).toEqual([]);
  });
});
