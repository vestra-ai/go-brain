import { describe, expect, it, vi } from 'vitest';
import { SAY_NOTHING, type TurnCtx } from '../../composer/tools.js';
import type { DeskItem } from '../../desk/desk.js';
import type { Images } from '../images.js';
import { TravelError } from '../mcp-travel.js';
import type { ResultsStore } from '../results.js';
import { renderSearchWake } from '../search-wake.js';
import { travelTools } from '../tools.js';
import type { Travel, TravelSearch } from '../travel.js';

const FOUND: TravelSearch = {
  checkedAt: '2026-10-07T12:00:30.000Z',
  found: 1,
  runId: 'ixigo.buses|{"date":"2026-11-06"}|1791370800000',
  results: [{
    kind: 'bus', title: 'Paulo Travels Express', priceMinor: 270_000, currency: 'INR', priceNote: 'per seat, from', highlights: [], facts: {},
    sourceUrl: 'https://www.ixigo.com/buses/bus_search/Mumbai/4/Goa/102/06-11-2026/O',
    journey: { mode: 'bus', origin: { name: 'Mumbai' }, destination: { name: 'Goa' }, depart_at: '2026-11-06T18:20:00+05:30', arrive_at: '2026-11-07T10:45:00+05:30' },
  }],
};
const BUSES = { from: 'Mumbai', to: 'Goa', date: '2026-11-06' };
const ctx = { tripId: 't_goa', turnId: 'turn_w1' } as TurnCtx;

function setup(search: () => Promise<TravelSearch>, wait: number | null, withDesk = true) {
  const puts: Array<Omit<DeskItem, 'id'> & { id?: string }> = [];
  const desk = { put: vi.fn(async (item: Omit<DeskItem, 'id'> & { id?: string }) => { puts.push(item); }) };
  const results = { save: async (s: Record<string, unknown>) => ({ ...s, resultsId: 'r_late1' }) } as unknown as ResultsStore;
  const travel = { search: vi.fn(search), waitMs: async () => wait } as unknown as Travel;
  const tools = travelTools({ travel, results, images: {} as Images, now: () => new Date('2026-10-07T12:00:31Z'), ...(withDesk ? { desk } : {}) });
  const searchBuses = tools.find((t) => t.name === 'search_buses')!;
  return { run: () => searchBuses.run(BUSES, ctx) as Promise<Record<string, unknown>>, puts };
}

function later<T>() {
  let settle!: { resolve: (v: T) => void; reject: (e: unknown) => void };
  const p = new Promise<T>((resolve, reject) => {
    settle = { resolve, reject };
  });
  return { p, ...settle };
}

describe('a search that outlives its turn', () => {
  it('answers at once that it is running, then wakes Go with its options when it finishes', async () => {
    const run = later<TravelSearch>();
    const w = setup(() => run.p, 0);
    const out = await w.run();
    expect(out).toMatchObject({ search: 'buses from Mumbai to Goa on 2026-11-06', count: 0, running: true, tell_the_room: SAY_NOTHING });
    expect(w.puts).toEqual([]);
    run.resolve(FOUND);
    await vi.waitFor(() => expect(w.puts).toHaveLength(1));
    expect(w.puts[0]).toMatchObject({
      id: `search:t_goa:${FOUND.runId}`,
      tripId: 't_goa',
      kind: 'search',
      ref: 'buses',
      payload: { source: 'travel_search', search: 'buses from Mumbai to Goa on 2026-11-06', count: 1, resultsId: 'r_late1', error: null },
    });
    expect((w.puts[0]!.payload as { summary: string }).summary).toContain('1 buses from Mumbai to Goa on 2026-11-06');
  });

  it('wakes Go to say so when the search fails after the turn went on', async () => {
    const run = later<TravelSearch>();
    const w = setup(() => run.p, 0);
    await w.run();
    run.reject(new TravelError('unreachable', 'ixigo took too long to answer.'));
    await vi.waitFor(() => expect(w.puts).toHaveLength(1));
    expect(w.puts[0]).toMatchObject({ id: 'search:t_goa:turn_w1:buses:failed', payload: { error: 'unreachable', count: 0 } });
  });

  it('answers inline when the search is back in time, even one a slow runner kept from before', async () => {
    const kept = setup(async () => FOUND, 0);
    expect(await kept.run()).toMatchObject({ count: 1, results_id: 'r_late1' });
    expect(kept.puts).toEqual([]);
  });

  it('waits for the search when there is no desk to wake Go on, as before', async () => {
    const w = setup(() => new Promise((r) => setTimeout(() => r(FOUND), 50)), 0, false);
    expect(await w.run()).toMatchObject({ count: 1 });
  });
});

describe('the search wake line', () => {
  const item = (payload: unknown): DeskItem => ({ id: 'search:t_goa:x', tripId: 't_goa', kind: 'search', ref: 'buses', dueAt: new Date(), payload });

  it('shows the options it found, without saying "on it" again; the summary is data', () => {
    const line = renderSearchWake(item({ source: 'travel_search', search: 'buses from Mumbai to Goa', count: 3, resultsId: 'r_1', summary: '3 buses: ₹1,500 to ₹5,000', error: null }))!;
    expect(line).toContain('finished with 3 options (results_id "r_1")');
    expect(line).toContain('show_options');
    expect(line).toContain("don't say so again");
    expect(line).toContain('<data>3 buses: ₹1,500 to ₹5,000</data>');
  });

  it('says plainly when nothing came back or the search failed, and leaves other desk items alone', () => {
    expect(renderSearchWake(item({ source: 'travel_search', search: 'buses', count: 0, resultsId: null, summary: 'Nothing came back.', error: null }))).toContain('nothing to show');
    expect(renderSearchWake(item({ source: 'travel_search', search: 'buses', count: 0, resultsId: null, summary: '', error: 'unreachable' }))).toContain("didn't work (unreachable)");
    expect(renderSearchWake(item({ source: 'something_else' }))).toBeNull();
  });
});
