import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { TravelError } from '../../mcp-travel.js';
import { forgetLearnedPlaces } from '../../recipes/places.js';
import type { LiveFrame } from '../../recipes/progress.js';
import type { Capture } from '../../recipes/recipe.js';
import type { FetchTrace, ReadOptions, RecipeRunner } from '../../recipes/runners.js';
import { capture, fixture } from '../../recipes/__tests__/fixtures.js';
import { BOOK_DIR, loadBook } from '../book.js';
import { createEngine } from '../engine.js';
import { labelOf, type RunEvent } from '../run-event.js';

afterEach(() => forgetLearnedPlaces());

const { book } = loadBook();
const sample = (name: string): string => readFileSync(`${BOOK_DIR}samples/${name}`, 'utf8');
const TRAINS = '/trains/v1/search/between/JP/UDZ';
const RSC = sample('plan.destination.rsc.txt');
const PAGE = sample('plan.destination.html');
/** The guide's place is a text input, so its runs go by the recipe's title. */
const GUIDE = labelOf(book.get('plan.destination')!, { place: 'Goa' });

/** An engine on a clock the runner moves, and every run event it says, by trip. */
function engineWith(runner: Pick<RecipeRunner, 'read' | 'pageFetch'>) {
  const clock = { ms: Date.parse('2026-10-07T12:00:00Z') };
  const events: Array<[string, RunEvent]> = [];
  const engine = createEngine({
    book, runner: () => runner, trip: async () => ({ people: 2, homes: [] }), now: () => new Date(clock.ms),
    onRun: (tripId, e) => events.push([tripId, e]),
  });
  return { engine, clock, events: () => events.map(([, e]) => e), trips: () => new Set(events.map(([t]) => t)) };
}

/**
 * A Bash call as the runner makes it: it takes ms on the clock, sends its pictures, then says what it did (its trace):
 * the calls it kept, unless the trace names others.
 */
function fetched(clock: { ms: number }, o: ReadOptions | undefined, ms: number, captures: Capture[], trace: Partial<FetchTrace> = {}, frames: LiveFrame[] = []): void {
  const startedAt = clock.ms;
  clock.ms += ms;
  if (frames.length > 0) o?.onProgress?.({ type: 'frames', frames });
  o?.onTrace?.({ started_at: startedAt, elapsed_ms: ms, woke: false, timings: null, calls: captures.map((c) => ({ url: c.url, status: c.status, at_ms: c.at_ms })), ...trace });
}

describe('the run strip', () => {
  it('shows a search and the lookup under it: each opened page, the calls that came back, and how each ended', async () => {
    const box = capture('searchFor=trainstationsLatLon', 'https://www.ixigo.com/action/content/trainstation?searchFor=trainstationsLatLon&value=Udaipur%20City', sample('trains.station_lookup.udaipur.json'));
    const trains = capture('/trains/v1/search/between/', `https://www.ixigo.com${TRAINS}?date=2026-10-20&languageCode=en`, fixture('trains-ndls-mao-between.json'));
    const s = engineWith({
      read: async (_t, url, _plan, o) => {
        const results = url.includes('/search/result/');
        fetched(s.clock, o, results ? 2_000 : 800, [results ? trains : box]);
        return { captures: [results ? trains : box], finalUrl: url };
      },
    });
    const got = await s.engine.answer('trains.between', { from: 'Jaipur', to: 'Udaipur City', date: '2026-10-20' }, { tripId: 't_run' });
    const [search, lookup] = s.events().filter((e) => e.type === 'run_start').map((e) => e.run_id);
    expect(s.events()).toEqual([
      { type: 'run_start', run_id: search, recipe_id: 'trains.between', label: 'Jaipur → Udaipur City · 20 Oct', speed: 'page', at: '2026-10-07T12:00:00.000Z' },
      { type: 'run_start', run_id: lookup, recipe_id: 'trains.station_lookup', label: 'Udaipur City', speed: 'page', parent: search, at: '2026-10-07T12:00:00.000Z' },
      { type: 'step', run_id: lookup, text: 'opened /action/content/trainstation', at_ms: 0 },
      { type: 'call', run_id: lookup, path: '/action/content/trainstation', status: 200, at_ms: 1_200 },
      { type: 'run_end', run_id: lookup, ok: true, ms: 800, picked: 'Udaipur City (UDZ)' },
      { type: 'step', run_id: search, text: 'opened /search/result/train/JP/UDZ/20102026//1/0/0/0/ALL', at_ms: 800 },
      { type: 'call', run_id: search, path: TRAINS, status: 200, at_ms: 2_000 },
      { type: 'run_end', run_id: search, ok: true, ms: 2_800, rows: got.as === 'options' ? got.options.length : -1 },
    ]);
    expect(s.trips()).toEqual(new Set(['t_run']));
    // Paths only: the words asked and the station codes ride in the queries, and no query is ever on the strip.
    expect(JSON.stringify(s.events())).not.toContain('?');
  });

  it("shows a fast run as the page's own call, with its method and how long it took", async () => {
    const s = engineWith({
      read: async () => {
        throw new Error('no page is opened');
      },
      pageFetch: async (_t, _call, o) => {
        fetched(s.clock, o, 366, [], { calls: [{ method: 'GET', url: 'https://www.ixigo.com/plan/goa', status: 200, at_ms: 340, ms: 340 }] });
        return { ...capture('fast', '/plan/goa', RSC), content_type: 'text/x-component', at_ms: 340 };
      },
    });
    await s.engine.answer('plan.destination', { place: 'Goa' }, { tripId: 't_run' });
    const [run] = s.events().map((e) => e.run_id);
    expect(s.events()).toEqual([
      { type: 'run_start', run_id: run, recipe_id: 'plan.destination', label: GUIDE, speed: 'fast', at: '2026-10-07T12:00:00.000Z' },
      { type: 'call', run_id: run, method: 'GET', path: '/plan/goa', status: 200, at_ms: 340, ms: 340 },
      { type: 'run_end', run_id: run, ok: true, ms: 366, rows: 1 },
    ]);
  });

  it('ends a fast run that fails with where it fell and why, and the page run names the run it fell from', async () => {
    const s = engineWith({
      read: async (_t, url, _plan, o) => {
        const page = capture('/plan/goa$', url, PAGE);
        fetched(s.clock, o, 1_500, [page]);
        return { captures: [page], finalUrl: url };
      },
      pageFetch: async (_t, _call, o) => {
        fetched(s.clock, o, 200, [], { calls: [{ method: 'GET', url: 'https://www.ixigo.com/plan/goa', status: 403, at_ms: 180, ms: 180 }] });
        throw new TravelError('unreachable', "ixigo's page call answered 403.");
      },
    });
    await s.engine.answer('plan.destination', { place: 'Goa' }, { tripId: 't_run' });
    const [fast, page] = s.events().filter((e) => e.type === 'run_start').map((e) => e.run_id);
    expect(s.events()).toEqual([
      { type: 'run_start', run_id: fast, recipe_id: 'plan.destination', label: GUIDE, speed: 'fast', at: '2026-10-07T12:00:00.000Z' },
      { type: 'call', run_id: fast, method: 'GET', path: '/plan/goa', status: 403, at_ms: 180, ms: 180 },
      { type: 'run_end', run_id: fast, ok: false, ms: 200, fell_to: 'page', why: "unreachable: ixigo's page call answered 403." },
      { type: 'run_start', run_id: page, recipe_id: 'plan.destination', label: GUIDE, speed: 'page', fell_from: fast, at: '2026-10-07T12:00:00.200Z' },
      { type: 'step', run_id: page, text: 'opened /plan/goa', at_ms: 0 },
      { type: 'call', run_id: page, path: '/plan/goa', status: 200, at_ms: 1_200 },
      { type: 'run_end', run_id: page, ok: true, ms: 1_500, rows: 1 },
    ]);
  });

  it("shows where a page's time went, what a fetch that ran out of time still kept, and only the pictures Go may show", async () => {
    const buses = { ...capture('/buslist/v3/services$', 'https://www.ixigo.com/buslist/v3/services?from=Mumbai&to=Goa', fixture('buses-mumbai-goa.json')), at_ms: 5_200 };
    const frame = (page_url: string, at_ms: number): LiveFrame => ({ label: 'results', at_ms, page_url, jpeg_base64: 'AAAA' });
    let opened = '';
    const s = engineWith({
      read: async (_t, url, _plan, o) => {
        opened = url;
        fetched(
          s.clock, o, 6_000, [buses],
          { woke: true, timings: { wake_ms: 3_000, nav_ms: 3_800, first_capture_ms: 5_200, done_ms: 6_000 }, failed: { status: 504, why: 'ran out of time at 3 scroll' } },
          [frame(`${url}`, 5_400), frame('https://www.ixigo.com/payments/abc', 5_600)],
        );
        return { captures: [buses], finalUrl: url };
      },
    });
    const card: string[] = [];
    const got = await s.engine.answer('buses.between', { from: 'Mumbai', to: 'Goa', date: '2026-11-06' }, { tripId: 't_run', onProgress: (e) => card.push(e.type) });
    const page = new URL(opened).pathname;
    const [run] = s.events().map((e) => e.run_id);
    expect(page).toMatch(/^\/buses\/bus_search\//);
    expect(s.events()).toEqual([
      { type: 'run_start', run_id: run, recipe_id: 'buses.between', label: 'Mumbai → Goa · 6 Nov', speed: 'page', at: '2026-10-07T12:00:00.000Z' },
      { type: 'step', run_id: run, text: `opened ${page}`, at_ms: 0 },
      // The payment page's picture never leaves the engine.
      { type: 'frames', run_id: run, frames: [{ label: 'results', at_ms: 5_400, page, jpeg_base64: 'AAAA' }] },
      { type: 'step', run_id: run, text: 'computer woke', at_ms: 3_000 },
      { type: 'step', run_id: run, text: 'page showed', at_ms: 3_800 },
      { type: 'step', run_id: run, text: 'first data', at_ms: 5_200 },
      { type: 'call', run_id: run, path: '/buslist/v3/services', status: 200, at_ms: 5_200 },
      { type: 'step', run_id: run, text: 'stopped: ran out of time at 3 scroll (504)', at_ms: 6_000 },
      { type: 'run_end', run_id: run, ok: true, ms: 6_000, rows: got.as === 'options' ? got.options.length : -1 },
    ]);
    // The live card still gets its pictures, as it did before.
    expect(card).toContain('frames');
  });

  it('shows a link as a run that loads nothing, and a facts answer kept from earlier as a kept run', async () => {
    const s = engineWith({
      read: async (_t, url) => ({ captures: [capture('/plan/goa$', url, PAGE)], finalUrl: url }),
    });
    await s.engine.answer('flights.search', { from: 'Delhi', to: 'Goa', date: '2026-11-06' }, { tripId: 't_run' });
    await s.engine.answer('plan.destination', { place: 'Goa' }, { tripId: 't_run' });
    await s.engine.answer('plan.destination', { place: 'goa ' }, { tripId: 't_run' });
    const ends = s.events().filter((e) => e.type === 'run_end');
    expect(s.events().filter((e) => e.type === 'run_start').map((e) => [e.recipe_id, e.speed, e.label])).toEqual([
      ['flights.search', 'link', 'Delhi → Goa · 6 Nov'],
      ['plan.destination', 'page', GUIDE],
      ['plan.destination', 'kept', GUIDE],
    ]);
    expect(ends.map((e) => [e.ok, e.rows])).toEqual([[true, undefined], [true, 1], [true, 1]]);
  });

  it('ends the lookup and the search failed when ixigo knows more than one place, with why', async () => {
    const two = JSON.stringify([{ e: 'Udaipur City (UDZ)', c: '' }, { e: 'Udaipur Junction (UDPU)', c: '' }]);
    const s = engineWith({
      read: async () => ({ captures: [capture('searchFor=trainstationsLatLon', 'https://www.ixigo.com/action/content/trainstation?searchFor=trainstationsLatLon&value=Udaipur', two)], finalUrl: 'https://www.ixigo.com/trains' }),
    });
    await expect(s.engine.answer('trains.between', { from: 'Jaipur', to: 'Udaipur', date: '2026-10-20' }, { tripId: 't_run' })).rejects.toMatchObject({ code: 'pick_place' });
    const ends = s.events().filter((e) => e.type === 'run_end');
    expect(ends.map((e) => [e.ok, e.why?.split(':')[0]])).toEqual([[false, 'pick_place'], [false, 'pick_place']]);
    expect(ends[1]!.why).toContain('"Udaipur City (UDZ)"; "Udaipur Junction (UDPU)"');
  });

  it('never stops a run when the run log throws', async () => {
    const runner = { read: async (_t: string, url: string) => ({ captures: [capture('/plan/goa$', url, PAGE)], finalUrl: url }) };
    const warned: string[] = [];
    const engine = createEngine({
      book, runner: () => runner, trip: async () => ({ people: 2, homes: [] }), now: () => new Date('2026-10-07T12:00:00Z'),
      onRun: () => {
        throw new Error('the viewer went away');
      },
      log: { info: () => undefined, warn: (_o, msg) => warned.push(msg) },
    });
    const got = await engine.answer('plan.destination', { place: 'Goa' }, { tripId: 't_run' });
    expect(got.as === 'facts' && got.rows).toHaveLength(1);
    expect(warned).toContain('book: the run log failed');
  });
});

describe("a run's label", () => {
  it('is the places and dates asked, never a count or what a person typed in words', () => {
    expect(labelOf(book.get('hotels.search')!, { place: 'Manali', check_in: '2026-11-06', check_out: '2026-11-09', adults: 4 })).toBe('Manali · 6 Nov → 9 Nov');
    const typed = labelOf(book.get('trains.station_lookup')!, { words: "my aunt's flat near the station" });
    expect(typed).not.toMatch(/aunt|flat/);
    expect(book.get('trains.station_lookup')!.title.startsWith(typed.replace(/…$/, ''))).toBe(true);
    expect(GUIDE).toMatch(/^A destination's guide on ixigo/);
    expect(GUIDE.length).toBeLessThanOrEqual(60);
  });
});
