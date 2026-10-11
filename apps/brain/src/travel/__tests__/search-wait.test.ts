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
import { renderSearchWake, searchWakeAnswer } from '../search-wake.js';
import { answerItself, handOver, putUpCard, RETRIES, searchAnswer, travelTools } from '../tools.js';
import { makeTurnCtx } from '../../composer/tools.js';
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

  it('says so plainly when the search fails after the turn went on, and tries it again (G1)', async () => {
    const run = later<TravelSearch>();
    const w = setup(() => run.p, 0);
    await w.run();
    run.reject(new TravelError('unreachable', 'ixigo took too long to answer.'));
    await vi.waitFor(() => expect(w.puts).toHaveLength(1));
    expect(w.puts[0]).toMatchObject({
      id: 'search:t_goa:turn_w1:buses:couldnt', payload: { error: 'unreachable', count: 0, line: "I couldn't load buses from Mumbai just now; I'll try again in a minute." },
    });
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
      saveCard: async () => undefined,
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
    expect((next.cards[0] as { options: Array<{ title: string }> }).options.map((o) => o.title)).toEqual(['Anjuna Beach Villa', 'Casa Anjuna', 'Hilltop Stay']);
    // One line, the card's, from its own cheapest: never the cheaper stay the card leaves out.
    expect(next.lines).toEqual(['Stays in Anjuna for 6 to 9 Nov, from ₹4,800 a night.']);
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
    expect(next.lines).toEqual([`${left}: stays in Goa for 12 to 14 Oct, sleeping 5, from ₹4,800 a night.`]);
    expect((next.cards[0] as { title: string }).title).toBe('Stays in Goa, 12 to 14 Oct');
    // The search answering its own turn says it the same way.
    const own = makeTurnCtx({ tripId: 't_goa', turnId: 'turn_w4', link: {} as never, pack, wake: [], signal: new AbortController().signal });
    await answerItself('stays', query, { ...STAYS, unapplied: ['pool'] }, own, { results, images });
    expect(own.lines).toEqual([`${left}: stays in Goa for 12 to 14 Oct, sleeping 5, from ₹4,800 a night.`]);
    // ixigo's own filter left off because with it there was no stay (the exam's re-run, 10 Oct: Private Pool): said first,
    // these the nearest without it, never a fit for it.
    const near = makeTurnCtx({ tripId: 't_goa', turnId: 'turn_drop1', link: {} as never, pack, wake: [], signal: new AbortController().signal });
    await answerItself('stays', query, { ...STAYS, dropped: ['Private Pool'] }, near, { results, images });
    expect(near.lines).toEqual(['Private Pool alone leaves out every stay, so these leave it out: pool stays in Goa for 12 to 14 Oct, sleeping 5, from ₹4,800 a night.']);
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

// The App team, 11 Oct (G1): a search ixigo didn't give is never ixigo's own page as the answer. Go says so plainly and
// tries again a minute later, twice; the card goes up when a try lands.
describe("a search ixigo didn't give", () => {
  const now = () => new Date('2026-10-07T12:00:31Z');
  const page = 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026&returnDate=&adults=4&children=0&infants=0&class=e&source=Search%20Form';
  const heldBack = () => new TravelError('link_only', "ixigo won't show its results to Go's computer right now.", page);
  const FLIGHTS = { from: 'Delhi', to: 'Goa', date: '2026-11-06' };
  const deskOf = () => {
    const puts: DeskItem[] = [];
    return { puts, desk: { put: async (item: Omit<DeskItem, 'id'> & { id?: string }) => { puts.push({ ...item, id: item.id! }); } } };
  };
  const turnOf = (cards: unknown[]) => ({ ...ctx, cards, lines: [], pack: goaPack(), wake: [] }) as unknown as TurnCtx;

  it('says so plainly in its turn and tries again a minute later: the options wake Go when a try lands, never a link card', async () => {
    let calls = 0;
    const later: TravelSearch = {
      checkedAt: '2026-10-07T12:01:31.000Z', found: 1, runId: 'ixigo.hotels|anjuna|try',
      results: [{ kind: 'stay', title: 'Casa Anjuna', priceMinor: 480_000, currency: 'INR', priceNote: 'per night, per room', highlights: [], facts: {} }],
    };
    const travel = {
      search: async () => {
        calls += 1;
        if (calls === 1) throw new TravelError('link_only', "ixigo won't show its stays to Go's computer right now.", 'https://www.ixigo.com/hotels/search/result?locationId=1');
        return later;
      },
      waitMs: async () => null,
    } as unknown as Travel;
    const { puts, desk } = deskOf();
    const results = { save: async (s: Record<string, unknown>) => ({ ...s, resultsId: 'r_try' }) } as unknown as ResultsStore;
    const tools = travelTools({ travel, results, images: {} as Images, now, desk, retryMs: 5 });
    const cards: unknown[] = [];
    const out = (await tools.find((t) => t.name === 'search_stays')!.run({ area: 'Anjuna', check_in: '2026-11-06', check_out: '2026-11-09' }, turnOf(cards))) as Record<string, unknown>;
    expect(out).toMatchObject({ count: 0, trying_again: true, tell_the_room: "Say only this, in one line: I couldn't load stays in Anjuna just now; I'll try again in a minute." });
    expect(JSON.stringify(out)).not.toContain('ixigo.com');
    expect(cards).toEqual([]);
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    expect(calls).toBe(2);
    expect(puts[0]!.payload).toMatchObject({ source: 'travel_search', count: 1, resultsId: 'r_try', error: null });
  });

  it("after the last try, says once that it still couldn't, with no model call and no card", async () => {
    let calls = 0;
    const travel = { search: async () => { calls += 1; throw heldBack(); }, waitMs: async () => null } as unknown as Travel;
    const { puts, desk } = deskOf();
    const tools = travelTools({ travel, results: {} as ResultsStore, images: {} as Images, now, desk, retryMs: 5 });
    await tools.find((t) => t.name === 'search_flights')!.run(FLIGHTS, turnOf([]));
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    expect(calls).toBe(1 + RETRIES);
    const last = "I still couldn't load flights from Delhi. Ask me again in a bit.";
    expect(puts[0]!.payload).toMatchObject({ error: 'link_only', line: last });
    expect(renderSearchWake(puts[0]!)).toContain(`Say only this, in one line: ${last}`);
    const pack = goaPack();
    const next = makeTurnCtx({ tripId: 't_goa', turnId: 'turn_l2', link: {} as never, pack, wake: [puts[0]!], signal: new AbortController().signal });
    expect(await searchWakeAnswer({ results: {} as ResultsStore, images: {} as Images })({ tripId: 't_goa', wake: [puts[0]!], pack, ctx: next })).toBe(true);
    expect([next.cards, next.lines, next.answered]).toEqual([[], [last], true]);
  });

  it('a search that outlived its turn and was not given: said plainly once, then tried again; with no way to try again, said once', async () => {
    let calls = 0;
    const travel = { search: async () => { calls += 1; throw heldBack(); } } as unknown as Travel;
    const { puts, desk } = deskOf();
    handOver('flights', FLIGHTS, Promise.reject(heldBack()), { tripId: 't_goa', fallbackId: 'turn_l1:flights' }, { desk, now, results: {} as ResultsStore, travel, retryMs: 5 });
    await vi.waitFor(() => expect(puts).toHaveLength(2));
    expect(puts.map((p) => (p.payload as { line?: string }).line)).toEqual([
      "I couldn't load flights from Delhi just now; I'll try again in a minute.",
      "I still couldn't load flights from Delhi. Ask me again in a bit.",
    ]);
    expect(calls).toBe(RETRIES);
    const one = deskOf();
    handOver('flights', FLIGHTS, Promise.reject(heldBack()), { tripId: 't_goa', fallbackId: 'turn_l3:flights' }, { desk: one.desk, now, results: {} as ResultsStore });
    await vi.waitFor(() => expect(one.puts).toHaveLength(1));
    expect(one.puts[0]!.payload).toMatchObject({ error: 'link_only', line: "I couldn't load flights from Delhi just now. Ask me again in a minute." });
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
  // The page Go would read is set for who flies: the link the backend builds says it (the room never gets the link, G1).
  const links: string[] = [];
  const travel = {
    search: (kind: never, q: never, o: never) => backend.search(kind, q, o).catch((e: unknown) => {
      if (e instanceof TravelError && e.link) links.push(e.link);
      throw e;
    }),
    waitMs: async () => null,
  } as unknown as Travel;
  const search = async (ask: string, travellers?: number): Promise<string> => {
    const line = msg(90, 'p_rahul', ask);
    const turn = { ...ctx, cards: [], pack: { ...pack, messages: [...pack.messages, line] }, wake: [{ kind: 'message', payload: { messageId: line.message_id, seq: 90 } }] } as unknown as TurnCtx;
    const tools = travelTools({ travel, results: {} as ResultsStore, images: {} as Images, now: () => new Date('2026-10-07T12:00:31Z') });
    const out = (await tools.find((t) => t.name === 'search_flights')!.run({ from: 'Delhi', to: 'Goa', date: '2026-11-06', ...(travellers ? { travellers } : {}) }, turn)) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain('ixigo.com');
    return links.at(-1) ?? '';
  };

  it("never take the model's count for the whole trip: the link is for the 3 who live in Delhi (re-drill 5)", async () => {
    for (const travellers of [5, 4, undefined]) expect(await search('@Go flights from Delhi to Goa on Friday', travellers), String(travellers)).toContain('&adults=3&');
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

  it('a search that failed is said in one line and tried again, never handed to a job (staging, 9 Oct: start_task on a blank page)', async () => {
    const w = setup(async () => { throw new TravelError('unreachable', "Someone is using the trip's computer's browser. Try again in a moment."); }, null);
    const out = await w.run();
    expect(out).toMatchObject({ count: 0, trying_again: true, tell_the_room: "Say only this, in one line: I couldn't load buses from Mumbai just now; I'll try again in a minute." });
    expect(out.note).toContain('never start_task for it');
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
