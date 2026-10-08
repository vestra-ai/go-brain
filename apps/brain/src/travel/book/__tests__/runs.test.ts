import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { TravelError } from '../../mcp-travel.js';
import { forgetLearnedPlaces } from '../../recipes/places.js';
import type { Capture, FetchPlan } from '../../recipes/recipe.js';
import { capture } from '../../recipes/__tests__/fixtures.js';
import { BOOK_DIR, loadBook } from '../book.js';
import { createEngine } from '../engine.js';
import { labelOf, type RunEvent } from '../run-event.js';

afterEach(() => forgetLearnedPlaces());

const { book } = loadBook();
const sample = (name: string): string => readFileSync(`${BOOK_DIR}samples/${name}`, 'utf8');
const TRAINS = 'ixigotrainsapi.confirmtkt.com/api/v1/trains/search';
const RSC = sample('plan.destination.rsc.txt');
const PAGE = sample('plan.destination.html');
/** The guide's place is a text input, so its runs go by the recipe's title. */
const GUIDE = labelOf(book.get('plan.destination')!, { place: 'Goa' });

/** An engine on a clock the runner moves, and every run event it says, by trip. */
function engineWith(runner: { read: (t: string, url: string, plan: FetchPlan) => Promise<{ captures: Capture[]; finalUrl: string }>; pageFetch?: (t: string, call: { url: string }) => Promise<Capture> }) {
  const clock = { ms: Date.parse('2026-10-07T12:00:00Z') };
  const events: Array<[string, RunEvent]> = [];
  const engine = createEngine({
    book, runner: () => runner, trip: async () => ({ people: 2, homes: [] }), now: () => new Date(clock.ms),
    onRun: (tripId, e) => events.push([tripId, e]),
  });
  return { engine, clock, events: () => events.map(([, e]) => e), trips: () => new Set(events.map(([t]) => t)) };
}

describe('the run strip', () => {
  it('shows a search and the lookup under it: each opened page, the calls that came back, and how each ended', async () => {
    const box = capture('searchFor=trainstationsLatLon', 'https://www.ixigo.com/action/content/trainstation?searchFor=trainstationsLatLon&value=Udaipur%20City', sample('trains.station_lookup.udaipur.json'));
    const trains = capture(TRAINS, `https://${TRAINS}?sourceStationCode=JP&destinationStationCode=UDZ`, sample('trains.between.page.json'));
    const s = engineWith({
      read: async (_t, url) => {
        s.clock.ms += url.includes('/search-pwa/') ? 2_000 : 800;
        return { captures: url.includes('/search-pwa/') ? [trains] : [box], finalUrl: url };
      },
    });
    const got = await s.engine.answer('trains.between', { from: 'Jaipur', to: 'Udaipur City', date: '2026-10-20' }, { tripId: 't_run' });
    const [search, lookup] = s.events().filter((e) => e.type === 'run_start').map((e) => e.run_id);
    expect(s.events()).toEqual([
      { type: 'run_start', run_id: search, recipe_id: 'trains.between', label: 'Jaipur → Udaipur City · 20 Oct', speed: 'page', at: '2026-10-07T12:00:00.000Z' },
      { type: 'run_start', run_id: lookup, recipe_id: 'trains.station_lookup', label: 'Udaipur City', speed: 'page', parent: search, at: '2026-10-07T12:00:00.000Z' },
      { type: 'step', run_id: lookup, text: 'opened /trains', at_ms: 0 },
      { type: 'call', run_id: lookup, path: '/action/content/trainstation', status: 200, at_ms: 1_200 },
      { type: 'run_end', run_id: lookup, ok: true, ms: 800, picked: 'Udaipur City (UDZ)' },
      { type: 'step', run_id: search, text: 'opened /trains/search-pwa/from/JP/to/UDZ/20-10-2026', at_ms: 800 },
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
      pageFetch: async () => {
        s.clock.ms += 366;
        return { ...capture('fast', '/plan/goa', RSC), content_type: 'text/x-component' };
      },
    });
    await s.engine.answer('plan.destination', { place: 'Goa' }, { tripId: 't_run' });
    const [run] = s.events().map((e) => e.run_id);
    expect(s.events()).toEqual([
      { type: 'run_start', run_id: run, recipe_id: 'plan.destination', label: GUIDE, speed: 'fast', at: '2026-10-07T12:00:00.000Z' },
      { type: 'call', run_id: run, method: 'GET', path: '/plan/goa', status: 200, at_ms: 0, ms: 366 },
      { type: 'run_end', run_id: run, ok: true, ms: 366, rows: 1 },
    ]);
  });

  it('ends a fast run that fails with where it fell and why, and the page run names the run it fell from', async () => {
    const s = engineWith({
      read: async (_t, url) => {
        s.clock.ms += 1_500;
        return { captures: [capture('/plan/goa$', url, PAGE)], finalUrl: url };
      },
      pageFetch: async () => {
        s.clock.ms += 200;
        throw new TravelError('unreachable', "ixigo's page call answered 403.");
      },
    });
    await s.engine.answer('plan.destination', { place: 'Goa' }, { tripId: 't_run' });
    const [fast, page] = s.events().filter((e) => e.type === 'run_start').map((e) => e.run_id);
    expect(s.events()).toEqual([
      { type: 'run_start', run_id: fast, recipe_id: 'plan.destination', label: GUIDE, speed: 'fast', at: '2026-10-07T12:00:00.000Z' },
      { type: 'run_end', run_id: fast, ok: false, ms: 200, fell_to: 'page', why: "unreachable: ixigo's page call answered 403." },
      { type: 'run_start', run_id: page, recipe_id: 'plan.destination', label: GUIDE, speed: 'page', fell_from: fast, at: '2026-10-07T12:00:00.200Z' },
      { type: 'step', run_id: page, text: 'opened /plan/goa', at_ms: 0 },
      { type: 'call', run_id: page, path: '/plan/goa', status: 200, at_ms: 1_200 },
      { type: 'run_end', run_id: page, ok: true, ms: 1_500, rows: 1 },
    ]);
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
