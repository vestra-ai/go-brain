import { describe, expect, it, vi } from 'vitest';
import { CARD_LINE } from '../../composer/rules.js';
import { SAY_NOTHING, type TurnCtx } from '../../composer/tools.js';
import type { DeskItem } from '../../desk/desk.js';
import type { Images } from '../images.js';
import { TravelError } from '../mcp-travel.js';
import type { ResultsStore } from '../results.js';
import { msg } from '../../__tests__/fixtures/goa.js';
import { goaPack } from '../../tasks/testing/goa.js';
import { createIxigoWebBackend, LINK_ONLY_KINDS } from '../recipes/backend.js';
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
const ctx = { tripId: 't_goa', turnId: 'turn_w1', cards: [], stableId: (p: string) => `${p}_turn_w1_1` } as unknown as TurnCtx;

function setup(search: () => Promise<TravelSearch>, wait: number | null, withDesk = true) {
  const puts: Array<Omit<DeskItem, 'id'> & { id?: string }> = [];
  const desk = { put: vi.fn(async (item: Omit<DeskItem, 'id'> & { id?: string }) => { puts.push(item); }) };
  const results = { save: async (s: Record<string, unknown>) => ({ ...s, resultsId: 'r_late1' }) } as unknown as ResultsStore;
  const travel = { search: vi.fn(search), waitMs: async () => wait } as unknown as Travel;
  const tools = travelTools({ travel, results, images: {} as Images, now: () => new Date('2026-10-07T12:00:31Z'), ...(withDesk ? { desk } : {}) });
  const searchBuses = tools.find((t) => t.name === 'search_buses')!;
  return { run: () => searchBuses.run(BUSES, ctx) as Promise<Record<string, unknown>>, puts, travel };
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
    // The turn's own search: its live card is this turn's.
    expect(w.travel.search).toHaveBeenCalledWith('buses', expect.anything(), { tripId: 't_goa', turnId: 'turn_w1' });
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

describe('a search ixigo will only show as a link', () => {
  it("posts a card that links to the flights on ixigo with the conditions set, and never says there are none", async () => {
    const page = 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026&returnDate=&adults=4&children=0&infants=0&class=e&source=Search%20Form';
    const cards: unknown[] = [];
    const turn = { ...ctx, cards } as unknown as TurnCtx;
    const travel = { search: async () => { throw new TravelError('link_only', "ixigo won't show its results to Go's computer right now.", page); }, waitMs: async () => null } as unknown as Travel;
    const tools = travelTools({ travel, results: {} as ResultsStore, images: {} as Images, now: () => new Date('2026-10-07T12:00:31Z') });
    const out = (await tools.find((t) => t.name === 'search_flights')!.run({ from: 'Delhi', to: 'Goa', date: '2026-11-06', depart_after: '18:00' }, turn)) as Record<string, unknown>;
    expect(out).toMatchObject({ count: 0, link: `${page}&takeOff=NIGHT`, set_for: 'for 4 from Delhi' });
    // Go books no flights: the room line sends people to ixigo and offers only to note their pick.
    expect(out.tell_the_room).toContain("to book on ixigo, and that if they tell you which one, you'll note it for the group");
    expect(out.tell_the_room).toContain('never offer to book one or to take it from there');
    expect(out.tell_the_room).toContain('Never say there are no flights');
    expect(cards).toEqual([expect.objectContaining({
      kind: 'notice', card_id: 'c_link_turn_w1_1', title: 'Flights, Delhi to Goa', source: { name: 'ixigo', url: `${page}&takeOff=NIGHT` },
      body: expect.stringContaining('set for 4 from Delhi'),
      actions: [{ action_id: 'see_on_ixigo', label: 'See flights on ixigo', style: 'primary' }],
    })]);
  });
});

describe("a flight's travellers", () => {
  // The Goa trip: Rahul, Priya and Kabir live in Delhi, Arjun in Bangalore, Meher in Mumbai.
  const pack = goaPack();
  const backend = createIxigoWebBackend({
    runner: () => ({ name: 'browser_fetch', run: async () => { throw new Error('a link loads nothing'); } }) as never,
    peopleOf: async () => pack.trip.people.length,
    homesOf: async () => pack.trip.people.flatMap((p) => (p.from_city ? [p.from_city] : [])),
    now: () => new Date('2026-10-07T12:00:31Z'),
    linkOnly: (kind) => LINK_ONLY_KINDS.has(kind),
  });
  const travel = { search: (kind: never, q: never, o: never) => backend.search(kind, q, o), waitMs: async () => null } as unknown as Travel;
  const search = (ask: string, travellers?: number) => {
    const line = msg(90, 'p_rahul', ask);
    const turn = { ...ctx, cards: [], pack: { ...pack, messages: [...pack.messages, line] }, wake: [{ kind: 'message', payload: { messageId: line.message_id, seq: 90 } }] } as unknown as TurnCtx;
    const tools = travelTools({ travel, results: {} as ResultsStore, images: {} as Images, now: () => new Date('2026-10-07T12:00:31Z') });
    return tools.find((t) => t.name === 'search_flights')!.run({ from: 'Delhi', to: 'Goa', date: '2026-11-06', ...(travellers ? { travellers } : {}) }, turn) as Promise<Record<string, unknown>>;
  };

  it("never take the model's count for the whole trip: the link is for the 3 who live in Delhi (re-drill 5)", async () => {
    for (const travellers of [5, 4, undefined]) {
      const out = await search('@Go flights from Delhi to Goa on Friday', travellers);
      expect(out.link, String(travellers)).toContain('&adults=3&');
      expect(out.set_for).toBe('for 3 from Delhi');
    }
  });

  it('take a number the ask itself says: "for 2 of us"', async () => {
    const out = await search('@Go flights from Delhi to Goa on Friday for 2 of us', 2);
    expect(out.link).toContain('&adults=2&');
    expect(out.set_for).toBe('for 2 from Delhi');
    // A different number from the model's than the ask's: the ask's people, counted by home.
    expect((await search('@Go flights from Delhi to Goa on Friday for 2 of us', 5)).link).toContain('&adults=3&');
  });
});

describe('the search wake line', () => {
  const item = (payload: unknown): DeskItem => ({ id: 'search:t_goa:x', tripId: 't_goa', kind: 'search', ref: 'buses', dueAt: new Date(), payload });

  it('shows the options it found, without saying "on it" again; the summary is data', () => {
    const line = renderSearchWake(item({ source: 'travel_search', search: 'buses from Mumbai to Goa', count: 3, resultsId: 'r_1', summary: '3 buses: ₹1,500 to ₹5,000', error: null }))!;
    expect(line).toContain('finished with 3 options (results_id "r_1")');
    expect(line).toContain('show_options');
    expect(line).toContain("don't say so again");
    // A continuation of the search, not a second "on it", said to whoever asked (re-drill 4: "Meher asked for…" to Meher),
    // finished, with no reasoning and no options counted (re-drill 5).
    expect(line).toContain('carries on from the search, not a new start');
    expect(line).toContain(CARD_LINE);
    expect(line).toContain('<data>3 buses: ₹1,500 to ₹5,000</data>');
  });

  it('says plainly when nothing came back or the search failed, and leaves other desk items alone', () => {
    expect(renderSearchWake(item({ source: 'travel_search', search: 'buses', count: 0, resultsId: null, summary: 'Nothing came back.', error: null }))).toContain('nothing to show');
    expect(renderSearchWake(item({ source: 'travel_search', search: 'buses', count: 0, resultsId: null, summary: '', error: 'unreachable' }))).toContain("didn't work (unreachable)");
    expect(renderSearchWake(item({ source: 'something_else' }))).toBeNull();
  });
});
