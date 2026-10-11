import { describe, expect, it, vi } from 'vitest';
import { CARD_LINE } from '../../composer/rules.js';
import { SAY_NOTHING, type TurnCtx } from '../../composer/tools.js';
import type { DeskItem } from '../../desk/desk.js';
import type { Images } from '../images.js';
import { TravelError } from '../mcp-travel.js';
import type { ResultsStore } from '../results.js';
import { msg } from '../../__tests__/fixtures/goa.js';
import { goaPack } from '../../tasks/testing/goa.js';
import { loadBook } from '../book/book.js';
import { createEngine } from '../book/engine.js';
import { createIxigoWebBackend } from '../recipes/backend.js';
import { renderSearchWake, searchWakeAnswer, tryAgainAnswer } from '../search-wake.js';
import { answerItself, handOver, putUpCard, searchAnswer, travelTools } from '../tools.js';
import { makeTurnCtx } from '../../composer/tools.js';
import type { Travel, TravelSearch } from '../travel.js';
import { TRY_AGAIN_MS, type TryAgain } from '../try-again.js';

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
  const warmed: string[] = [];
  const warmForTravel = (tripId: string, kind: string): void => {
    warmed.push(`${tripId}:${kind}`);
  };
  const tools = travelTools({ travel, results, images: {} as Images, now: () => new Date('2026-10-07T12:00:31Z'), warmForTravel, ...(withDesk ? { desk } : {}) });
  const searchBuses = tools.find((t) => t.name === 'search_buses')!;
  return { run: () => searchBuses.run(BUSES, ctx) as Promise<Record<string, unknown>>, puts, warmed, travel };
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
    // A search starting is travel intent: the trip's computer is held awake for it, once.
    expect(w.warmed).toEqual(['t_goa:buses']);
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
    expect((w.puts[0]!.payload as { summary: string }).summary).toContain('1 bus from Mumbai to Goa on 2026-11-06');
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

describe('a stays search past its 12 s (staging pass, 8 Oct: a cold box took 13 s)', () => {
  const stay = (title: string, priceMinor: number) => ({
    kind: 'stay' as const, title, priceMinor, currency: 'INR', priceNote: 'per night, per room', highlights: [], facts: {},
    sourceUrl: `https://www.ixigo.com/hotels/1/details?hName=${encodeURIComponent(title)}`,
  });
  const STAYS: TravelSearch = {
    checkedAt: '2026-10-07T12:00:30.000Z', found: 4, runId: 'ixigo.hotels|anjuna|1791370800000',
    results: [stay('Anjuna Beach Villa', 650_000), stay('Casa Anjuna', 480_000), stay('Hilltop Stay', 720_000), stay('Budget Inn', 179_000)],
  };
  const ANJUNA = { area: 'Anjuna', check_in: '2026-11-06', check_out: '2026-11-09' };

  /** A results store that keeps what it saves, as the real one does, and the cards put up from it. */
  function store() {
    const sets = new Map<string, Record<string, unknown>>();
    let n = 0;
    return {
      save: async (s: Record<string, unknown>) => {
        n += 1;
        const set = { ...s, resultsId: `r_stays${n}` };
        sets.set(set.resultsId, set);
        return set;
      },
      get: async (_t: string, id: string) => sets.get(id) ?? null,
      saveCard: async () => undefined, shownFrom: async () => [],
      card: async () => null,
    } as unknown as ResultsStore;
  }
  const images = { rehostUrl: async (u: string) => u } as unknown as Images;

  it('posts its card and one line when it finishes, after its turn ended, with no model call', async () => {
    const run = later<TravelSearch>();
    const puts: DeskItem[] = [];
    const desk = { put: async (item: Omit<DeskItem, 'id'> & { id?: string }) => { puts.push({ ...item, id: item.id! }); } };
    const results = store();
    const travel = { search: async () => run.p, waitMs: async () => 0 } as unknown as Travel;
    const tools = travelTools({ travel, results, images, now: () => new Date('2026-10-07T12:00:31Z'), desk });
    const out = (await tools.find((t) => t.name === 'search_stays')!.run(ANJUNA, ctx)) as Record<string, unknown>;
    expect(out).toMatchObject({ running: true, tell_the_room: SAY_NOTHING });
    expect(String(out.note)).not.toMatch(/join/i);
    run.resolve(STAYS);
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    const pack = goaPack();
    const next = makeTurnCtx({ tripId: 't_goa', turnId: 'turn_w9', link: {} as never, pack, wake: [puts[0]!], signal: new AbortController().signal });
    expect(await searchWakeAnswer({ results, images })({ tripId: 't_goa', wake: [puts[0]!], pack, ctx: next })).toBe(true);
    expect(next.cards).toHaveLength(1);
    // Up to 10 on a card (rev 5 R3): all four, in the engine's order.
    expect((next.cards[0] as { options: Array<{ title: string }> }).options.map((o) => o.title)).toEqual(['Anjuna Beach Villa', 'Casa Anjuna', 'Hilltop Stay', 'Budget Inn']);
    // One line, the card's, from its own cheapest: never a stay the card leaves out.
    expect(next.lines).toEqual(['Stays in Anjuna for 6 to 9 Nov, from ₹1,790 a night.']);
    expect(next.answered).toBe(true);
  });

  it("says first that ixigo's filter was left off: the card is titled and lined as searched without it (staging, 9 Oct: Goa with a pool)", async () => {
    const results = store();
    const puts: DeskItem[] = [];
    const desk = { put: async (item: Omit<DeskItem, 'id'> & { id?: string }) => { puts.push({ ...item, id: item.id! }); } };
    const now = () => new Date('2026-10-07T12:00:31Z');
    const query = { area: 'goa', checkIn: '2026-10-12', checkOut: '2026-10-14', guests: 5, mustHave: ['pool' as const] };
    const left = "ixigo's pool filter didn't load in time, so these aren't filtered for a pool";
    handOver('stays', query, Promise.resolve({ ...STAYS, runId: 'ixigo.hotels|goa|left', unapplied: ['pool'] }), { tripId: 't_goa', fallbackId: 'turn_w5:stays' }, { desk, now, results });
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.payload).toMatchObject({ lead: `${left}: `, summary: expect.stringContaining(`${left}.`) });
    const saved = await results.get('t_goa', (puts[0]!.payload as { resultsId: string }).resultsId);
    expect(saved?.query).toMatchObject({ mustHave: [] });
    const pack = goaPack();
    const next = makeTurnCtx({ tripId: 't_goa', turnId: 'turn_w6', link: {} as never, pack, wake: [puts[0]!], signal: new AbortController().signal });
    expect(await searchWakeAnswer({ results, images })({ tripId: 't_goa', wake: [puts[0]!], pack, ctx: next })).toBe(true);
    expect(next.lines).toEqual([`${left}: stays in Goa for 12 to 14 Oct, sleeping 5, from ₹1,790 a night.`]);
    expect((next.cards[0] as { title: string }).title).toBe('Stays in Goa, 12 to 14 Oct');
    // The search answering its own turn says it the same way.
    const own = makeTurnCtx({ tripId: 't_goa', turnId: 'turn_w4', link: {} as never, pack, wake: [], signal: new AbortController().signal });
    await answerItself('stays', query, { ...STAYS, unapplied: ['pool'] }, own, { results, images });
    expect(own.lines).toEqual([`${left}: stays in Goa for 12 to 14 Oct, sleeping 5, from ₹1,790 a night.`]);
    // ixigo's own filter left off because with it there was no stay (the exam's re-run, 10 Oct: Private Pool): said first,
    // these the nearest without it, never a fit for it.
    const near = makeTurnCtx({ tripId: 't_goa', turnId: 'turn_drop1', link: {} as never, pack, wake: [], signal: new AbortController().signal });
    await answerItself('stays', query, { ...STAYS, dropped: ['Private Pool'] }, near, { results, images });
    expect(near.lines).toEqual(['Private Pool alone leaves out every stay, so these leave it out: pool stays in Goa for 12 to 14 Oct, sleeping 5, from ₹1,790 a night.']);
  });

  it("leaves what ixigo didn't filter to the model, which picks it from each stay's amenities: never a card of the engine's first three", async () => {
    const results = store();
    const withAmenities = { ...STAYS, results: STAYS.results.map((o, i) => ({ ...o, amenities: i === 0 ? ['Beach access', 'Free Wifi'] : ['Free Wifi'], facts: { distance: `${i + 1} km from Anjuna Beach` } })) };
    const site = { filtered: ['Pet-friendly property'], sorted: null, unknown: ['beachfront'], listed: true, offers: null };
    const found: TravelSearch = { ...withAmenities, runId: 'ixigo.hotels|anjuna|pick', site };
    // The search tool: a plain ask, but with something left to pick, so no card of its own.
    const travel = { search: async () => found, waitMs: async () => null } as unknown as Travel;
    const tools = travelTools({ travel, results, images, now: () => new Date('2026-10-07T12:00:31Z') });
    const args = { ...ANJUNA, check_in: '2026-11-06', check_out: '2026-11-09', site_filters: ['Pet-friendly property', 'beachfront'], wants: ['quiet'] };
    const out = (await tools.find((t) => t.name === 'search_stays')!.run(args, ctx)) as Record<string, unknown>;
    expect(out).not.toHaveProperty('answered');
    expect(String(out.summary)).toContain("Pet-friendly property (ixigo's filter)");
    expect(String(out.summary)).toContain("Not filtered by ixigo, for you to pick from each option's amenities and details: beachfront and quiet.");
    expect((out.results as Array<Record<string, unknown>>)[0]).toMatchObject({ amenities: ['Beach access', 'Free Wifi'], details: { distance: '1 km from Anjuna Beach' } });
    expect(String(out.note)).toContain('Show the options whose amenities or details fit beachfront and quiet');
    // Past its turn: the wake is the model's, to pick, not a card posted with no model call.
    const puts: DeskItem[] = [];
    const desk = { put: async (item: Omit<DeskItem, 'id'> & { id?: string }) => { puts.push({ ...item, id: item.id! }); } };
    const q = { area: 'anjuna', checkIn: '2026-11-06', checkOut: '2026-11-09', siteFilters: ['Pet-friendly property', 'beachfront'], wants: ['quiet'] };
    handOver('stays', q, Promise.resolve({ ...found, runId: 'ixigo.hotels|anjuna|pick2' }), { tripId: 't_goa', fallbackId: 'turn_w3:stays' }, { desk, now: () => new Date('2026-10-07T12:00:31Z'), results });
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.payload).toMatchObject({ pick: true });
    const pack = goaPack();
    const next = makeTurnCtx({ tripId: 't_goa', turnId: 'turn_w2', link: {} as never, pack, wake: [puts[0]!], signal: new AbortController().signal });
    expect(await searchWakeAnswer({ results, images })({ tripId: 't_goa', wake: [puts[0]!], pack, ctx: next })).toBe(false);
    expect(next.cards).toEqual([]);
  });

  it("wakes nothing for a run whose options a card in the room already showed, unless it stands in for a later ask's page, and leaves a failure or nothing found to the model", async () => {
    const results = store();
    const puts: DeskItem[] = [];
    const desk = { put: async (item: Omit<DeskItem, 'id'> & { id?: string }) => { puts.push({ ...item, id: item.id! }); } };
    const now = () => new Date('2026-10-07T12:00:31Z');
    const query = { area: 'anjuna', checkIn: '2026-11-06', checkOut: '2026-11-09' };
    const found = { ...STAYS, runId: 'ixigo.hotels|anjuna|shown' };
    // The model showed this run's options in its own turn (show_options on the search's results_id).
    const a = await searchAnswer('stays', query, found, 't_goa', { results, now });
    const shown = makeTurnCtx({ tripId: 't_goa', turnId: 'turn_w8', link: {} as never, pack: goaPack(), wake: [], signal: new AbortController().signal });
    await putUpCard((await results.get('t_goa', a.results_id!))!, [1, 2, 3], { title: 'Stays in Anjuna', line: 'x' }, shown, { results, images });
    handOver('stays', query, Promise.resolve(found), { tripId: 't_goa', fallbackId: 'early:m_1' }, { desk, now, results });
    await new Promise((r) => setTimeout(r, 20));
    expect(puts).toEqual([]);
    // The same read standing in for a later ask's page that failed (backend.ts staysFallback, earlier) answers that ask:
    // it wakes, the model's to say it is Go's earlier read (the exam, 10 Oct: the second stays ask got the first one's read
    // back, already shown, and the room stayed on "On it.").
    handOver('stays', query, Promise.resolve({ ...found, earlier: true }), { tripId: 't_goa', fallbackId: 'turn_w9:stays' }, { desk, now, results });
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.payload).toMatchObject({ source: 'travel_search', pick: true, error: null });
    // A wake with nothing found or a failure is the model's, which says so in one line.
    const pack = goaPack();
    const failed: DeskItem = { id: 'search:t_goa:x:failed', tripId: 't_goa', kind: 'search', ref: 'stays', dueAt: now(), payload: { source: 'travel_search', search: 'stays', count: 0, resultsId: null, summary: '', error: 'unreachable' } };
    const ctx2 = makeTurnCtx({ tripId: 't_goa', turnId: 'turn_w7', link: {} as never, pack, wake: [failed], signal: new AbortController().signal });
    expect(await searchWakeAnswer({ results, images })({ tripId: 't_goa', wake: [failed], pack, ctx: ctx2 })).toBe(false);
  });
});

// G1, the App team, 11 Oct: on prod one traveller got options, the other a link card ("Go can't read ixigo's flights from
// its computer right now"). An ixigo search link card is never the answer: Go says it plainly and tries again.
describe("a search ixigo didn't load", () => {
  const page = 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026&returnDate=&adults=4&children=0&infants=0&class=e&source=Search%20Form';
  const refused = () => new TravelError('link_only', "ixigo won't show its results to Go's computer right now.", page);
  const DELHI_GOA = { from: 'Delhi', to: 'Goa', date: '2026-11-06' };
  const now = () => new Date('2026-10-07T12:00:31Z');
  const inAMinute = new Date(now().getTime() + TRY_AGAIN_MS);
  const deskOf = () => {
    const puts: DeskItem[] = [];
    return { puts, desk: { put: async (item: Omit<DeskItem, 'id'> & { id?: string }) => { puts.push({ ...item, id: item.id! }); } } };
  };
  const turnOf = (wake: DeskItem[], turnId = 'turn_g1') => makeTurnCtx({ tripId: 't_goa', turnId, link: {} as never, pack: goaPack(), wake, signal: new AbortController().signal });

  it('says so in plain words with no card, and puts its try again on the desk a minute out', async () => {
    const cards: unknown[] = [];
    const turn = { ...ctx, cards } as unknown as TurnCtx;
    const { puts, desk } = deskOf();
    const travel = { search: async () => { throw refused(); }, waitMs: async () => null } as unknown as Travel;
    const tools = travelTools({ travel, results: {} as ResultsStore, images: {} as Images, now, desk });
    const out = (await tools.find((t) => t.name === 'search_flights')!.run({ ...DELHI_GOA, depart_after: '18:00' }, turn)) as Record<string, unknown>;
    expect(cards).toEqual([]);
    expect(out).toMatchObject({ count: 0, not_loaded: true });
    expect(out).not.toHaveProperty('link');
    expect(out.tell_the_room).toContain(`"I couldn't load flights from Delhi to Goa just now; I'll try again in a minute."`);
    expect(out.tell_the_room).toContain('Never send or offer a link');
    expect(out.tell_the_room).toContain('never say there are none');
    expect(puts).toEqual([expect.objectContaining({
      id: expect.stringMatching(/^try_again:t_goa:search_\w+:1$/), tripId: 't_goa', kind: 'search', ref: 'flights', dueAt: inAMinute,
      payload: { source: 'travel_try_again', key: expect.any(String), what: 'flights from Delhi to Goa', n: 1, query: expect.objectContaining({ ...DELHI_GOA, departAfter: '18:00' }) },
    })]);
  });

  // The lead, 11 Oct: a try may go through Go's own quiet, never ixigo's (a 403, a 429, Cloudflare's check), which would
  // risk the shared address for every trip. Go says so, and the try waits past it.
  it('when ixigo itself asked us to slow down, says so and puts the try just past its quiet, never inside it', async () => {
    const turn = { ...ctx, cards: [] } as unknown as TurnCtx;
    const { puts, desk } = deskOf();
    const quietEnds = now().getTime() + 9 * 60_000 + 30_000;
    const ixigoQuiet = vi.fn(() => quietEnds);
    const travel = { search: async () => { throw refused(); }, waitMs: async () => null } as unknown as Travel;
    const tools = travelTools({ travel, results: {} as ResultsStore, images: {} as Images, now, desk, ixigoQuiet });
    const out = (await tools.find((t) => t.name === 'search_flights')!.run(DELHI_GOA, turn)) as Record<string, unknown>;
    expect(out.tell_the_room).toContain(`"I couldn't load flights from Delhi to Goa: ixigo asked us to slow down, so I'll try again in about 10 minutes."`);
    expect(ixigoQuiet).toHaveBeenCalledWith('flights', expect.objectContaining(DELHI_GOA));
    expect(puts).toEqual([expect.objectContaining({ id: expect.stringMatching(new RegExp(`^try_again:t_goa:search_\\w+:1:${quietEnds}$`)), dueAt: new Date(quietEnds + 5_000) })]);
    // A late search the same: its line on the wake says it, and its try waits past the quiet.
    const late = deskOf();
    handOver('flights', DELHI_GOA, Promise.reject(refused()), { tripId: 't_goa', fallbackId: 'turn_q1:flights' }, { desk: late.desk, now, ixigoQuiet, results: {} as ResultsStore });
    await vi.waitFor(() => expect(late.puts).toHaveLength(2));
    expect(late.puts.map((p) => [p.id, p.dueAt])).toEqual([[`try_again:t_goa:turn_q1:flights:1:${quietEnds}`, new Date(quietEnds + 5_000)], ['search:t_goa:turn_q1:flights:not_loaded', now()]]);
    expect(late.puts[1]!.payload).toMatchObject({ line: "I couldn't load flights from Delhi to Goa: ixigo asked us to slow down, so I'll try again in about 10 minutes." });
  });

  it("a try that comes inside ixigo's own quiet (it refused another page since) asks nothing: the same try goes back on the desk past it", async () => {
    const { puts, desk } = deskOf();
    const search = vi.fn(async () => FOUND);
    const quietEnds = now().getTime() + 8 * 60_000;
    const answer = tryAgainAnswer({ travel: { search } as unknown as Travel, results: {} as ResultsStore, desk, now, ixigoQuiet: () => quietEnds });
    const t: DeskItem = { id: 'try_again:t_goa:k4:2', tripId: 't_goa', kind: 'search', ref: 'flights', dueAt: now(), payload: { source: 'travel_try_again', key: 'k4', what: 'flights from Delhi to Goa', n: 2, query: DELHI_GOA } satisfies TryAgain };
    const turn = turnOf([t]);
    expect(await answer({ tripId: 't_goa', wake: [t], pack: goaPack(), ctx: turn })).toBe(true);
    expect(search).not.toHaveBeenCalled();
    expect([turn.cards, turn.lines]).toEqual([[], []]);
    expect(puts).toEqual([expect.objectContaining({ id: `try_again:t_goa:k4:2:${quietEnds}`, dueAt: new Date(quietEnds + 5_000), payload: expect.objectContaining({ n: 2, key: 'k4', query: DELHI_GOA }) })]);
  });

  it('a late search says so on its wake, with no card and no model call, and its try goes on the desk', async () => {
    const { puts, desk } = deskOf();
    handOver('flights', DELHI_GOA, Promise.reject(refused()), { tripId: 't_goa', fallbackId: 'turn_l1:flights' }, { desk, now, results: {} as ResultsStore });
    await vi.waitFor(() => expect(puts).toHaveLength(2));
    const line = "I couldn't load flights from Delhi to Goa just now; I'll try again in a minute.";
    expect(puts.map((p) => [p.id, p.dueAt])).toEqual([['try_again:t_goa:turn_l1:flights:1', inAMinute], ['search:t_goa:turn_l1:flights:not_loaded', now()]]);
    const said = puts[1]!;
    expect(said.payload).toMatchObject({ source: 'travel_search', error: 'link_only', line });
    expect(said.payload).not.toHaveProperty('link');
    // Woken with other things too, the model says the same line, never a link.
    expect(renderSearchWake(said)).toContain('never send a link');
    expect(renderSearchWake(said)).toContain(line);
    const next = turnOf([said]);
    expect(await searchWakeAnswer({ results: {} as ResultsStore, images: {} as Images })({ tripId: 't_goa', wake: [said], pack: goaPack(), ctx: next })).toBe(true);
    expect([next.cards, next.lines, next.answered]).toEqual([[], [line], true]);
  });

  it('each try searches again through ixigo\'s quiet, posts nothing itself, and the next goes on the desk when it fails too', async () => {
    const { puts, desk } = deskOf();
    const search = vi.fn(async () => { throw refused(); });
    const answer = tryAgainAnswer({ travel: { search } as unknown as Travel, results: {} as ResultsStore, desk, now });
    const first: DeskItem = { id: 'try_again:t_goa:k1:1', tripId: 't_goa', kind: 'search', ref: 'flights', dueAt: now(), payload: { source: 'travel_try_again', key: 'k1', what: 'flights from Delhi to Goa', n: 1, query: DELHI_GOA } satisfies TryAgain };
    const turn = turnOf([first]);
    expect(await answer({ tripId: 't_goa', wake: [first], pack: goaPack(), ctx: turn })).toBe(true);
    expect([turn.cards, turn.lines, turn.answered]).toEqual([[], [], true]);
    expect(search).toHaveBeenCalledWith('flights', DELHI_GOA, { tripId: 't_goa', retry: true });
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ id: 'try_again:t_goa:k1:2', dueAt: inAMinute, payload: { n: 2, key: 'k1', query: DELHI_GOA } });
    // The last try failing too: Go's last word, plain, and no third try.
    const last = turnOf([puts[0]!], 'turn_g2');
    expect(await answer({ tripId: 't_goa', wake: [puts[0]!], pack: goaPack(), ctx: last })).toBe(true);
    await vi.waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]).toMatchObject({ id: 'search:t_goa:k1:gave_up', dueAt: now(), payload: { error: 'link_only', line: "I tried again and still couldn't load flights from Delhi to Goa. Ask me in a bit and I'll look once more." } });
    const word = turnOf([puts[1]!], 'turn_g3');
    expect(await searchWakeAnswer({ results: {} as ResultsStore, images: {} as Images })({ tripId: 't_goa', wake: [puts[1]!], pack: goaPack(), ctx: word })).toBe(true);
    expect(word.cards).toEqual([]);
  });

  it('a try that lands wakes Go with its options, whose card goes up as any late search\'s does', async () => {
    const { puts, desk } = deskOf();
    const results = { save: async (s: Record<string, unknown>) => ({ ...s, resultsId: 'r_try1' }) } as unknown as ResultsStore;
    // A run of its own: no card in the room has shown it.
    const landed = { ...FOUND, runId: 'ixigo.buses|try|1791370860000' };
    const answer = tryAgainAnswer({ travel: { search: async () => landed } as unknown as Travel, results, desk, now });
    const t: DeskItem = { id: 'try_again:t_goa:k2:1', tripId: 't_goa', kind: 'search', ref: 'buses', dueAt: now(), payload: { source: 'travel_try_again', key: 'k2', what: 'buses from Mumbai to Goa', n: 1, query: BUSES } satisfies TryAgain };
    expect(await answer({ tripId: 't_goa', wake: [t], pack: goaPack(), ctx: turnOf([t]) })).toBe(true);
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ id: `search:t_goa:${landed.runId}`, ref: 'buses', payload: { source: 'travel_search', count: 1, resultsId: 'r_try1', error: null } });
  });

  it('woken with a message too, the try still starts, and the model answers the message, saying nothing of the try', async () => {
    const { desk } = deskOf();
    const search = vi.fn(async () => FOUND);
    const answer = tryAgainAnswer({ travel: { search } as unknown as Travel, results: { save: async () => ({ resultsId: 'r' }) } as unknown as ResultsStore, desk, now });
    const t: DeskItem = { id: 'try_again:t_goa:k3:1', tripId: 't_goa', kind: 'search', ref: 'buses', dueAt: now(), payload: { source: 'travel_try_again', key: 'k3', what: 'buses from Mumbai to Goa', n: 1, query: BUSES } satisfies TryAgain };
    const message: DeskItem = { id: 'm1', tripId: 't_goa', kind: 'message', ref: 'm1', dueAt: now(), payload: { messageId: 'm1', seq: 9 } };
    expect(await answer({ tripId: 't_goa', wake: [t, message], pack: goaPack(), ctx: turnOf([t, message]) })).toBe(false);
    expect(search).toHaveBeenCalledTimes(1);
    expect(renderSearchWake(t)).toContain('Say nothing about it');
  });
});

describe("a flight's travellers", () => {
  // The Goa trip: Rahul, Priya and Kabir live in Delhi, Arjun in Bangalore, Meher in Mumbai.
  const pack = goaPack();
  const { book } = loadBook();
  const engine = createEngine({
    book,
    runner: () => ({ read: async () => { throw new Error('a link loads nothing'); } }),
    trip: async () => ({ people: pack.trip.people.length, homes: pack.trip.people.flatMap((p) => (p.from_city ? [p.from_city] : [])) }),
    now: () => new Date('2026-10-07T12:00:31Z'),
  });
  const backend = createIxigoWebBackend({ book, engine, now: () => new Date('2026-10-07T12:00:31Z') });
  // The page ixigo's own link opens, set for the travellers the search ran with: Go shows it nobody (G1), but its count is the search's.
  const links: string[] = [];
  const travel = {
    search: (kind: never, q: never, o: never) => backend.search(kind, q, o).catch((err: unknown) => { if (err instanceof TravelError && err.link) links.push(err.link); throw err; }),
    waitMs: async () => null,
  } as unknown as Travel;
  const search = async (ask: string, travellers?: number): Promise<string> => {
    const line = msg(90, 'p_rahul', ask);
    const turn = { ...ctx, cards: [], pack: { ...pack, messages: [...pack.messages, line] }, wake: [{ kind: 'message', payload: { messageId: line.message_id, seq: 90 } }] } as unknown as TurnCtx;
    const tools = travelTools({ travel, results: {} as ResultsStore, images: {} as Images, now: () => new Date('2026-10-07T12:00:31Z') });
    await tools.find((t) => t.name === 'search_flights')!.run({ from: 'Delhi', to: 'Goa', date: '2026-11-06', ...(travellers ? { travellers } : {}) }, turn);
    return links.at(-1)!;
  };

  it("never take the model's count for the whole trip: the link is for the 3 who live in Delhi (re-drill 5)", async () => {
    for (const travellers of [5, 4, undefined]) {
      expect(await search('@Go flights from Delhi to Goa on Friday', travellers), String(travellers)).toContain('&adults=3&');
    }
  });

  it('take a number the ask itself says: "for 2 of us"', async () => {
    expect(await search('@Go flights from Delhi to Goa on Friday for 2 of us', 2)).toContain('&adults=2&');
    // A different number from the model's than the ask's: the ask's people, counted by home.
    expect(await search('@Go flights from Delhi to Goa on Friday for 2 of us', 5)).toContain('&adults=3&');
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

  it('a search that failed is said in one line and offered again, never handed to a job (staging, 9 Oct: start_task on a blank page)', async () => {
    const w = setup(async () => { throw new TravelError('unreachable', "Someone is using the trip's computer's browser."); }, null);
    const out = await w.run();
    expect(out).toMatchObject({ count: 0, error: 'unreachable', tell_the_room: expect.stringContaining('Never start_task for it') });
    expect(renderSearchWake(item({ source: 'travel_search', search: 'buses', count: 0, resultsId: null, summary: '', error: 'unreachable' }))).toContain('Never start_task');
  });

  it('says plainly when nothing came back or the search failed, and leaves other desk items alone', () => {
    expect(renderSearchWake(item({ source: 'travel_search', search: 'buses', count: 0, resultsId: null, summary: 'Nothing came back.', error: null }))).toContain('nothing to show');
    expect(renderSearchWake(item({ source: 'travel_search', search: 'buses', count: 0, resultsId: null, summary: '', error: 'unreachable' }))).toContain("didn't work (unreachable)");
    expect(renderSearchWake(item({ source: 'something_else' }))).toBeNull();
  });

  it('shows the nearest stays when none fits all of the ask, never as a fit', () => {
    const line = renderSearchWake(item({ source: 'travel_search', search: 'stays in North Goa', count: 0, resultsId: 'r_near', summary: 'None of the 5 stays fits. The nearest: 1. Lotus', error: null }))!;
    expect(line).toContain('nothing fits all of the ask; its nearest are saved (results_id "r_near")');
    expect(line).toContain('never call them a fit');
    expect(line).toContain('<data>None of the 5 stays fits. The nearest: 1. Lotus</data>');
  });
});
