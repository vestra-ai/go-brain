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
import { createOffers } from '../../recipes/offers.js';
import { createEngine, isPayments, OFFERS_GRACE_MS, OFFERS_MAX_BYTES } from '../engine.js';

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

describe('a page a person waits on', () => {
  it('stays open as the warm tab, so the live view sees ixigo draw it; a check nobody waits on keeps none', async () => {
    const asked: Array<boolean | undefined> = [];
    const runner = {
      read: async (_trip: string, url: string, plan: FetchPlan, o: { keepOpen?: boolean } = {}) => {
        asked.push(o.keepOpen);
        return { captures: [capture(plan.capture[0]!.match, url, sample('plan.destination.html'))], finalUrl: url };
      },
    };
    const engine = engineFor(book, runner);
    // What the guide says is not this test's: only what each read asked of the computer.
    await engine.answer('plan.destination', { place: 'Goa' }, { tripId: 't_keep' }).catch(() => null);
    await engine.answer('plan.destination', { place: 'Kerala' }, { tripId: 't_keep', background: true }).catch(() => null);
    expect(asked).toEqual([true, undefined]);
  });
});

describe('a filtered stays read whose caller falls back (backend.ts)', () => {
  it('asks the runner so, with what the read is for the log: its conditions and its yes-or-no lets, never a word or a date', async () => {
    const asked: Array<{ url: string; fallsBack?: boolean; about?: unknown }> = [];
    const runner = {
      read: async (_trip: string, url: string, _plan: FetchPlan, o: { fallsBack?: boolean; about?: unknown } = {}) => {
        asked.push({ url, ...(o.fallsBack ? { fallsBack: o.fallsBack } : {}), about: o.about });
        return { captures: [capture(SEARCH, 'https://www.ixigo.com/accommodation-search/api/v3/accommodations/search', fixture('stays-goa-page1.json'))], finalUrl: url };
      },
    };
    const engine = engineFor(book, runner);
    const goa = { place: 'Goa', check_in: '2026-10-12', check_out: '2026-10-14', adults: 5 };
    await engine.answer('hotels.search', goa, { tripId: 't_pool', conditions: ['pool'], fallsBack: true });
    await engine.answer('hotels.search', goa, { tripId: 't_pool' });
    expect(asked).toEqual([
      { url: expect.stringContaining('&filters=FL_HF_29'), fallsBack: true, about: { recipe: 'hotels.search', conditions: ['pool'], site: [], wide: true } },
      { url: expect.not.stringContaining('filters='), about: { recipe: 'hotels.search', conditions: [], site: [], wide: true } },
    ]);
  });
});

describe("the site's own list of what it offers (hotels.search: ixigo's filters and sorts)", () => {
  const META = 'https://www.ixigo.com/accommodation-search/api/v2/accommodations/search/metadata?locationId=32';
  it('keeps the list each read brings; an ask by its names then filters and sorts on ixigo itself, and a name not on it is left for the model', async () => {
    const offers = createOffers({ now: () => new Date('2026-10-07T12:00:00Z') });
    const reads: string[] = [];
    const plans: FetchPlan[] = [];
    const runner = {
      read: async (_trip: string, url: string, plan: FetchPlan) => {
        reads.push(url);
        plans.push(plan);
        return {
          captures: [
            capture(SEARCH, 'https://www.ixigo.com/accommodation-search/api/v3/accommodations/search', fixture('stays-goa-page1.json')),
            capture('/accommodation-search/api/v2/accommodations/search/metadata$', META, sample('hotels.search_filters.json')),
          ],
          finalUrl: url,
        };
      },
    };
    const engine = createEngine({ book, runner: () => runner, pool: db.pool, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-07T12:00:00Z'), offers });
    const goa = { place: 'Goa', check_in: '2026-11-06', check_out: '2026-11-09' };
    // No list kept yet: the page as a person opens it, which brings ixigo's list; the name waits for it.
    const first = await engine.answer('hotels.search', goa, { tripId: 't_site', siteFilters: ['Pet-friendly property'] });
    expect(reads[0]).not.toContain('filters=');
    expect(first.as === 'options' && first.site).toMatchObject({ filtered: [], sorted: null, unknown: ['Pet-friendly property'], listed: false });
    expect(offers.get('hotels.search', '32')?.offers).toContainEqual({ kind: 'filter', group: 'Facilities', name: 'Pet-friendly property', code: 'FL_HF_21' });
    expect(offers.forTrip('t_site').map((l) => l.about)).toEqual(['stays in Goa']);
    // While no list is kept, the read waits for ixigo's list call, a grace at most after the rest (a fresh computer's
    // first read, 10 Oct: the page made it after Bash had answered).
    const LIST = '/accommodation-search/api/v2/accommodations/search/metadata$';
    expect(plans[0]!.capture.at(-1)).toEqual({ match: LIST, required: false, max_bytes: OFFERS_MAX_BYTES });
    expect(plans[0]!.graceMs).toBe(OFFERS_GRACE_MS);
    // Asks nobody wrote a rule for: pets, cheapest first, and a beachfront ixigo has no filter for.
    const second = await engine.answer('hotels.search', goa, { tripId: 't_site', siteFilters: ['pet friendly property', 'beachfront'], siteSort: 'Price (Low to High)' });
    expect(reads[1]).toContain('&filters=FL_HF_21');
    expect(reads[1]).toContain('&sort=SC_P_LH');
    expect(second.as === 'options' && second.site).toMatchObject({ filtered: ['Pet-friendly property'], sorted: 'Price (Low to High)', unknown: ['beachfront'], listed: true });
    // Once one is kept, the list is only taken when it comes.
    expect(plans[1]!.capture.at(-1)).toEqual({ match: LIST, required: false, max_bytes: OFFERS_MAX_BYTES, besides: true });
    expect(plans[1]).not.toHaveProperty('graceMs');
    // The page's own areas and the site's filters go together, as ixigo's page takes them.
    await engine.answer('hotels.search', { ...goa, place: 'Vagator' }, { tripId: 't_site', siteFilters: ['Star Rating 5'] });
    expect(reads[2]).toContain(`&filters=${encodeURIComponent('PA_C_78528,SR_5')}`);
  });

  // Staging, 10 Oct: ixigo's Entire house and Swimming Pool for five on all of Goa answered 424 with no stay at three rooms
  // (two to a room), and five pool villas at one room.
  it('books an entire house whole, one room for the group priced for every head', async () => {
    const offers = createOffers({ now: () => new Date('2026-10-07T12:00:00Z') });
    const reads: string[] = [];
    const plans: FetchPlan[] = [];
    const runner = {
      read: async (_trip: string, url: string, plan: FetchPlan) => {
        reads.push(url);
        plans.push(plan);
        return {
          captures: [
            capture(SEARCH, 'https://www.ixigo.com/accommodation-search/api/v3/accommodations/search', fixture('stays-goa-page1.json')),
            capture('/accommodation-search/api/v2/accommodations/search/metadata$', META, sample('hotels.search_filters.json')),
          ],
          finalUrl: url,
        };
      },
    };
    const engine = createEngine({ book, runner: () => runner, pool: db.pool, trip: async () => ({ people: 5, homes: [] }), now: () => new Date('2026-10-07T12:00:00Z'), offers });
    const goa = { place: 'Goa', check_in: '2026-11-06', check_out: '2026-11-09' };
    await engine.answer('hotels.search', goa, { tripId: 't_villa' });
    const villas = await engine.answer('hotels.search', goa, { tripId: 't_villa', siteFilters: ['Entire house', 'Swimming Pool'] });
    expect(reads[0]).toContain('&adultCount=5&roomCount=3&');
    expect(reads[1]).toContain('&adultCount=5&roomCount=1&');
    expect(reads[1]).toContain(`&filters=${encodeURIComponent('AT_EH,FL_HF_29')}`);
    // All of Goa is read as a careful person would, both pages, filtered or not.
    expect(plans[0]!.capture[0]).toMatchObject({ min_count: 2 });
    expect(plans[1]!.capture[0]).toMatchObject({ min_count: 2 });
    if (villas.as !== 'options') throw new Error('not options');
    const first = villas.options[0]!;
    expect(first.facts).toMatchObject({ nights: 3, rooms: 1, guests: 5 });
    expect(first.totalMinor).toBe(first.priceMinor * 3);
    // Its one room is the whole place: priced per night, never "per room".
    expect(first.priceNote).toBe('per night');
  });
});

describe("ixigo's price bands for the group's decided budget", () => {
  const META = 'https://www.ixigo.com/accommodation-search/api/v2/accommodations/search/metadata?locationId=32';
  it("asks the bands at or under each room's share a night of the budget, and one over, and says the cap", async () => {
    const offers = createOffers({ now: () => new Date('2026-10-10T05:00:00Z') });
    const reads: string[] = [];
    const runner = {
      read: async (_trip: string, url: string) => {
        reads.push(url);
        return {
          captures: [
            capture(SEARCH, 'https://www.ixigo.com/accommodation-search/api/v3/accommodations/search', fixture('stays-goa-page1.json')),
            capture('/accommodation-search/api/v2/accommodations/search/metadata$', META, sample('hotels.search_filters.json')),
          ],
          finalUrl: url,
        };
      },
    };
    const engine = createEngine({ book, runner: () => runner, pool: db.pool, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-10T05:00:00Z'), offers });
    const goa = { place: 'Goa', check_in: '2026-11-06', check_out: '2026-11-09' };
    await engine.answer('hotels.search', goa, { tripId: 't_budget' });
    // ₹4,500 each for four over three nights in two rooms: ₹3,000 a night a room. The bands to it, and ₹3,000 to ₹3,500.
    const got = await engine.answer('hotels.search', goa, { tripId: 't_budget', budgetMinor: 450_000 });
    expect(reads[1]).toContain(`&filters=${encodeURIComponent('DP_1600_1800,DP_1800_2000,DP_2000_2500,DP_2500_3000,DP_3000_3500')}`);
    expect(got.as === 'options' && got.site).toMatchObject({ priced: 3000, filtered: [] });
    // With no budget, no band.
    await engine.answer('hotels.search', { ...goa, check_out: '2026-11-08' }, { tripId: 't_budget' });
    expect(reads[2]).not.toContain('DP_');
    // "8k a head" for the stay: ₹8,000 × 4 ÷ 3 nights ÷ 2 rooms = ₹5,333 a night a room. "8k a head a night" is ₹24,000
    // a head for the stay (tools.ts): ₹16,000 a night a room, never divided by the nights twice.
    const head = await engine.answer('hotels.search', goa, { tripId: 't_budget', budgetMinor: 800_000 });
    expect(head.as === 'options' && head.site?.priced).toBe(5333);
    expect(reads[3]).toContain(encodeURIComponent('DP_4500_5000,DP_5000_6000'));
    expect(reads[3]).not.toContain('DP_6000_7000');
    const night = await engine.answer('hotels.search', goa, { tripId: 't_budget', budgetMinor: 2_400_000 });
    expect(night.as === 'options' && night.site?.priced).toBe(16000);
    expect(reads[4]).toContain('DP_8000_9000');
  });

  // p1-a's review of #357: Jev's early read of a place is often its first, before its list (and so its bands) is known.
  // The same run opens the page again with the bands once the first read brought the list, so the composer's search that
  // joins it gets the banded list; the first read answers when the banded one holds nothing.
  it("opens a place's first budgeted read again with its bands, in the same run, and keeps the first when they hold nothing", async () => {
    const offers = createOffers({ now: () => new Date('2026-10-10T05:00:00Z') });
    const reads: string[] = [];
    let bandsEmpty = false;
    const runner = {
      read: async (_trip: string, url: string) => {
        reads.push(url);
        const empty = bandsEmpty && url.includes('DP_');
        return {
          captures: [
            capture(SEARCH, 'https://www.ixigo.com/accommodation-search/api/v3/accommodations/search', empty ? '{"data":{}}' : fixture('stays-goa-page1.json')),
            capture('/accommodation-search/api/v2/accommodations/search/metadata$', META, sample('hotels.search_filters.json')),
          ],
          finalUrl: url,
        };
      },
    };
    const engine = createEngine({ book, runner: () => runner, pool: db.pool, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-10T05:00:00Z'), offers });
    const goa = { place: 'Goa', check_in: '2026-11-06', check_out: '2026-11-09' };
    const got = await engine.answer('hotels.search', goa, { tripId: 't_first', budgetMinor: 450_000 });
    expect(reads).toHaveLength(2);
    expect(reads[0]).not.toContain('DP_');
    expect(reads[1]).toContain(encodeURIComponent('DP_2500_3000,DP_3000_3500'));
    expect(got.as === 'options' && got.site).toMatchObject({ priced: 3000, listed: true });
    expect(got.as === 'options' && got.page).toBe(reads[1]);
    // Kept now: the next budgeted read of the place opens with its bands at once.
    await engine.answer('hotels.search', { ...goa, check_out: '2026-11-08' }, { tripId: 't_first', budgetMinor: 450_000 });
    expect(reads).toHaveLength(3);
    expect(reads[2]).toContain('DP_');
    // Bands that hold nothing: the first read answers, unbanded.
    const fresh = createEngine({ book, runner: () => runner, pool: db.pool, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-10T05:00:00Z'), offers: createOffers({ now: () => new Date('2026-10-10T05:00:00Z') }) });
    bandsEmpty = true;
    const plain = await fresh.answer('hotels.search', goa, { tripId: 't_first', budgetMinor: 450_000 });
    expect(reads).toHaveLength(5);
    expect(plain.as === 'options' && plain.options.length).toBeGreaterThan(0);
    expect(plain.as === 'options' && plain.page).toBe(reads[3]);
  });
});

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

  it("takes a station's own Indian Railways code as the model writes it, with no lookup, so a box that fails never blocks a train search", async () => {
    const trains = [capture('/trains/v1/search/between/', 'https://www.ixigo.com/trains/v1/search/between/JP/UDZ?date=2026-10-20&languageCode=en', fixture('trains-ndls-mao-between.json'))];
    const b = browser(() => {
      throw new Error("ixigo's box is never asked");
    }, trains);
    const got = await engineFor(book, b.runner).answer('trains.between', { from: 'Jaipur (JP)', to: 'Udaipur City (UDZ)', date: '2026-10-20' }, { tripId: 't_codes' });
    expect(b.runs.map((r) => r.url)).toEqual(['https://www.ixigo.com/search/result/train/JP/UDZ/20102026//1/0/0/0/ALL']);
    expect(got.as === 'options' && got.options.length).toBe(25);
  });

  it("asks ixigo's list once for the same words: asked again before the pick, the same choice with no second load", async () => {
    const two = JSON.stringify([{ e: 'Udaipur City (UDZ)', c: '' }, { e: 'Udaipur Junction (UDPU)', c: '' }]);
    const b = browser(() => [capture('searchFor=trainstationsLatLon', 'https://www.ixigo.com/action/content/trainstation?searchFor=trainstationsLatLon&anchor=false&value=Udaipur', two)]);
    const engine = engineFor(book, b.runner);
    for (let i = 0; i < 2; i++) {
      const err = await engine.answer('trains.between', { from: 'Jaipur', to: 'Udaipur', date: '2026-10-20' }, { tripId: 't_udr2' }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'pick_place', choices: ['Udaipur City (UDZ)', 'Udaipur Junction (UDPU)'] });
    }
    expect(b.runs).toHaveLength(1);
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

  // Staging, 10 Oct: a watched trains search ran as a page call, and the room saw ixigo's home page, not the search.
  it('never takes the fast speed for a run a person watches (its live card): it opens the page on the stage', async () => {
    const calls: unknown[] = [];
    const reads: Array<{ url: string; stage?: boolean }> = [];
    const runner = {
      read: async (_t: string, url: string, _plan: unknown, o?: { stage?: boolean }) => {
        reads.push({ url, ...(o?.stage ? { stage: true } : {}) });
        return { captures: [capture('/plan/goa$', url, PAGE)], finalUrl: url };
      },
      pageFetch: async (_t: string, call: unknown) => {
        calls.push(call);
        return { ...capture('fast', '/plan/goa', RSC), content_type: 'text/x-component' };
      },
    };
    // A fresh engine each time: a guide's facts are kept, and a kept answer runs nothing.
    const engine = () => createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-07T12:00:00Z') });
    const events: Array<{ type: string; speed?: string }> = [];
    const watchedEngine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-07T12:00:00Z'), onRun: (_t, e) => events.push(e) });
    await watchedEngine.answer('plan.destination', { place: 'Goa' }, { tripId: 't_watch', onProgress: () => undefined });
    expect(calls).toEqual([]);
    // Its strip says page from the start, never fast (staging, 10 Oct: "speed=fast" on a run that read the stage).
    expect(events.find((e) => e.type === 'run_start')).toMatchObject({ speed: 'page' });
    expect(reads).toEqual([{ url: expect.stringContaining('/plan/goa'), stage: true }]);
    // Off the stage: a check nobody waits on reads its page behind, as before, and a composite's step (many at once)
    // still takes the fast speed.
    await engine().answer('plan.destination', { place: 'Goa' }, { tripId: 't_watch', background: true, onProgress: () => undefined });
    await engine().answer('plan.destination', { place: 'Goa' }, { tripId: 't_watch', stepOf: 'r_ways', onProgress: () => undefined });
    expect(calls).toHaveLength(1);
    expect(reads).toEqual([{ url: expect.stringContaining('/plan/goa'), stage: true }, { url: expect.stringContaining('/plan/goa') }]);
  });

  it("reads the guide's own photo of the destination: its hero's first, else the first place to visit's (8 Oct)", async () => {
    const photo = async (rsc: string): Promise<unknown> => {
      const runner = {
        read: async () => {
          throw new Error('no page load');
        },
        pageFetch: async () => ({ ...capture('fast', '/plan/goa', rsc), content_type: 'text/x-component' }),
      };
      const engine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-07T12:00:00Z') });
      const got = await engine.answer('plan.destination', { place: 'Goa' }, { tripId: 't_photo' });
      return got.as === 'facts' ? got.rows[0]?.['photo'] : undefined;
    };
    // The hero carousel, as /plan/goa sends it: its first photo.
    expect(await photo(RSC)).toBe('https://imagedelivery.net/pyX3WeyB0txAwUsxwjq_eg/goa/public');
    // A guide with no hero: the first place to visit's (Baga Beach).
    expect(await photo(RSC.replace('"photos":', '"gone":'))).toMatch(/^https:\/\/ta\.ixigo\.es\/google-photo\/ATplDJZfXxwJOxwj31QqDOQjJUSVjoycmdlgiFR0yYMZ/);
  });

  it("skips the fast speed while Bash takes no page calls, and counts the run as the page's, not a failed fast run", async () => {
    let can = true;
    let calls = 0;
    const runner = {
      read: async (_t: string, url: string) => ({ captures: [capture('/plan/goa$', url, PAGE)], finalUrl: url }),
      pageFetch: async () => {
        calls += 1;
        // The runner remembers that this Bash takes no page calls (Bash's 400).
        can = false;
        throw new TravelError('unreachable', 'fast unavailable: Bash answered 400 invalid_request');
      },
      canPageFetch: () => can,
    };
    const engine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-07T12:00:00Z') });
    await engine.answer('plan.destination', { place: 'Goa' }, { tripId: 't_fast' });
    await engine.answer('plan.destination', { place: 'Kerala' }, { tripId: 't_fast' });
    expect(calls).toBe(1);
    expect(engine.stats().map((s) => [s.recipe, s.speed, s.runs, s.failed])).toEqual([['plan.destination', 'page', 2, 0]]);
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
