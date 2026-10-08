import { describe, expect, it, vi } from 'vitest';
import { loadBook } from '../../book/book.js';
import { createEngine, type Engine } from '../../book/engine.js';
import { TravelError } from '../../mcp-travel.js';
import { CARD_DELAY_MS, CHOOSING_MS, createIxigoWebBackend, NARROW_MIN, TRAVEL_WAIT_MS } from '../backend.js';
import type { RecipeOption } from '../recipe.js';
import { capture, fixture } from './fixtures.js';

const { book } = loadBook();
const OPTION: RecipeOption = {
  kind: 'train', title: 'Mandovi Express 10103', priceMinor: 120_000, currency: 'INR', priceNote: 'per person, SL', highlights: ['Sleeper'], facts: { class_code: 'SL' },
  sourceUrl: 'https://www.ixigo.com/trains/10103?orgn=CSMT&dstn=MAO&departDate=2026-11-06&quota=GN',
};

type Answer = Engine['answer'];
type Run = { id: string; given: Record<string, unknown>; tripId: string; conditions: string[] };

/** A recipe engine whose runs fail or answer in turn; hold() keeps the runs waiting until release(). */
function scripted(...outcomes: Array<'fail' | 'ok' | 'pick'>) {
  const runs: Run[] = [];
  let gate: Promise<void> | null = null;
  let open: () => void = () => undefined;
  const answer: Answer = async (id, given, o) => {
    runs.push({ id, given, tripId: o.tripId, conditions: o.conditions ?? [] });
    const outcome = outcomes[runs.length - 1] ?? 'ok';
    o.onProgress?.({ type: 'opening', recipeId: id, url: 'https://www.ixigo.com/x' });
    if (gate) await gate;
    if (outcome === 'fail') throw new TravelError('unreachable', 'ixigo took too long to answer.');
    if (outcome === 'pick') throw new TravelError('pick_place', 'ixigo knows more than one place for "Udaipur".', null, ['Udaipur City (UDZ)', 'Udaipur Junction (UDPU)']);
    o.onProgress?.({ type: 'captured', ms: 2_100 });
    return { as: 'options', options: [OPTION], page: 'https://www.ixigo.com/x', checkedAt: '2026-10-07T12:00:03.000Z', ms: 2_100 };
  };
  return {
    engine: { answer },
    runs,
    hold: () => {
      gate = new Promise((resolve) => {
        open = resolve;
      });
    },
    release: () => {
      gate = null;
      open();
    },
  };
}

let nowMs = Date.parse('2026-10-07T12:00:00Z');
const now = () => new Date(nowMs);
const backend = (engine: { answer: Answer }) => createIxigoWebBackend({ book, engine, now });
const TRAINS = { from: 'Mumbai', to: 'Goa', date: '2026-11-06' };
const FLIGHTS = { from: 'Delhi', to: 'Goa', date: '2026-11-06' };

/** The real engine, with no browser: a flight link loads nothing. */
const linkEngine = (people: number, homes: string[]) =>
  createEngine({ book, runner: () => null, trip: async () => ({ people, homes }), now });

describe('the ixigo_web backend', () => {
  it("runs each kind's recipe from the book, with the person's words and conditions as its inputs", async () => {
    const e = scripted();
    const found = await backend(e.engine).search('trains', TRAINS, { tripId: 't_goa' });
    // With the results page it read: "See all on ixigo" opens it.
    expect(found).toEqual({ results: [OPTION], checkedAt: '2026-10-07T12:00:03.000Z', runId: expect.stringMatching(/^trains\.between\|/), page: 'https://www.ixigo.com/x' });
    await backend(e.engine).search('stays', { area: 'Vagator', checkIn: '2026-11-06', checkOut: '2026-11-09', guests: 7, mustHave: ['pool'] }, { tripId: 't_goa' });
    await backend(e.engine).search('buses', TRAINS, { tripId: 't_goa' });
    expect(e.runs).toEqual([
      { id: 'trains.between', given: { from: 'Mumbai', to: 'Goa', date: '2026-11-06' }, tripId: 't_goa', conditions: [] },
      { id: 'hotels.search', given: { place: 'Vagator', check_in: '2026-11-06', check_out: '2026-11-09', adults: 7 }, tripId: 't_goa', conditions: ['pool'] },
      { id: 'buses.between', given: { from: 'Mumbai', to: 'Goa', date: '2026-11-06' }, tripId: 't_goa', conditions: [] },
    ]);
  });

  it('refuses a search without a trip before anything runs', async () => {
    const e = scripted();
    await expect(backend(e.engine).search('trains', TRAINS)).rejects.toMatchObject({ code: 'refused' });
    expect(e.runs).toEqual([]);
  });

  it('keeps a search for ten minutes by recipe and the words asked, whatever their case, and any trip can use it', async () => {
    const e = scripted();
    const b = backend(e.engine);
    await b.search('trains', TRAINS, { tripId: 't_goa' });
    await b.search('trains', { from: ' mumbai', to: 'GOA', date: '2026-11-06' }, { tripId: 't_other' });
    expect(e.runs).toHaveLength(1);
    // Other words are another search.
    await b.search('trains', { ...TRAINS, to: 'Madgaon' }, { tripId: 't_goa' });
    expect(e.runs).toHaveLength(2);
    nowMs += 10 * 60_000;
    await b.search('trains', TRAINS, { tripId: 't_goa' });
    expect(e.runs).toHaveLength(3);
  });

  it('lets a search join the same one in flight, so an early start and the composer make one page load', async () => {
    const e = scripted();
    const b = backend(e.engine);
    e.hold();
    const early = b.search('trains', TRAINS, { tripId: 't_goa' });
    const composer = b.search('trains', TRAINS, { tripId: 't_goa' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    e.release();
    expect(await composer).toEqual(await early);
    expect(e.runs).toHaveLength(1);
  });

  it("makes the early start's search and the composer's one search when they open the same ixigo page, whatever their words (the 8 Oct drill: North Goa ran twice)", async () => {
    const reads: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = {
      read: async (_t: string, url: string) => {
        reads.push(url);
        await gate;
        return { captures: [capture('/accommodation-search/api/v3/accommodations/search$', 'https://www.ixigo.com/accommodation-search/api/v3/accommodations/search', fixture('stays-goa-page1.json'))], finalUrl: url };
      },
    };
    const engine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now });
    const b = createIxigoWebBackend({ book, engine, now });
    // The early start reads no head count; the composer says "sleeping 4", in a trip of four: one page, adultCount=4.
    const early = b.search('stays', { area: 'north goa', checkIn: '2026-11-06', checkOut: '2026-11-09', mustHave: ['pool'] }, { tripId: 't_goa', messageId: 'm_1' });
    const composer = b.search('stays', { area: 'North Goa', checkIn: '2026-11-06', checkOut: '2026-11-09', guests: 4, mustHave: ['pool'] }, { tripId: 't_goa', turnId: 'turn_1' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    expect(await composer).toBe(await early);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain('adultCount=4');
    // Two of the four is another page: a search of its own.
    await b.search('stays', { area: 'North Goa', checkIn: '2026-11-06', checkOut: '2026-11-09', guests: 2, mustHave: ['pool'] }, { tripId: 't_goa', turnId: 'turn_2' });
    expect(reads).toHaveLength(2);
    expect(reads[1]).toContain('adultCount=2');
  });

  it('keeps North Goa and all of Goa apart though they open one page: all of Goa gets the south stays too (8 Oct)', async () => {
    const reads: string[] = [];
    const SEARCH = '/accommodation-search/api/v3/accommodations/search$';
    const SEARCH_URL = 'https://www.ixigo.com/accommodation-search/api/v3/accommodations/search';
    const runner = {
      read: async (_t: string, url: string) => {
        reads.push(url);
        return { captures: [capture(SEARCH, SEARCH_URL, fixture('stays-goa-page1.json')), capture(SEARCH, SEARCH_URL, fixture('stays-goa-page2.json'))], finalUrl: url };
      },
    };
    const engine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now });
    const b = createIxigoWebBackend({ book, engine, now });
    const dates = { checkIn: '2026-11-06', checkOut: '2026-11-09' };
    const north = await b.search('stays', { area: 'North Goa', ...dates }, { tripId: 't_goa', turnId: 'turn_1' });
    const all = await b.search('stays', { area: 'Goa', ...dates }, { tripId: 't_goa', turnId: 'turn_2' });
    // One page (all of Goa's), read twice: North Goa keeps the north, so its rows are not all of Goa's.
    expect(reads).toHaveLength(2);
    expect(reads[1]).toBe(reads[0]);
    // Soul Vacation is in Fatona, Colva: South Goa.
    expect(north.results.map((o) => o.title)).not.toContain('Soul Vacation Resort and Spa, Colva');
    expect(all.results.map((o) => o.title)).toContain('Soul Vacation Resort and Spa, Colva');
    expect(all.results.length).toBeGreaterThan(north.results.length);
    // North Goa asked again, in other words, still shares its own search.
    expect(await b.search('stays', { area: 'north goa', ...dates }, { tripId: 't_goa', turnId: 'turn_3' })).toBe(north);
    expect(reads).toHaveLength(2);
  });

  it('never keeps a failed search: the next ask runs it again', async () => {
    const e = scripted('fail', 'fail');
    const b = backend(e.engine);
    await expect(b.search('trains', TRAINS, { tripId: 't_goa' })).rejects.toMatchObject({ code: 'unreachable' });
    await expect(b.search('trains', TRAINS, { tripId: 't_goa' })).rejects.toMatchObject({ code: 'unreachable' });
    expect(e.runs).toHaveLength(2);
  });

  it('posts one live card per run: the steps go to it, and it is done before the search answers', async () => {
    const events: string[] = [];
    const cards: Array<{ tripId: string; runKey: string; kind: string }> = [];
    const live = (tripId: string, o: { runKey: string; kind: string }) => {
      cards.push({ tripId, runKey: o.runKey, kind: o.kind });
      return { progress: (e: { type: string }) => events.push(e.type), finish: async (ok: boolean) => { events.push(ok ? 'finish:ok' : 'finish:failed'); } };
    };
    const b = createIxigoWebBackend({ book, engine: scripted().engine, now, live: live as never, cardDelayMs: 0 });
    const first = b.search('trains', TRAINS, { tripId: 't_goa' });
    const joined = b.search('trains', TRAINS, { tripId: 't_goa' });
    await Promise.all([first, joined]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ tripId: 't_goa', kind: 'trains' });
    expect(cards[0]!.runKey).toBe((await first).runId);
    expect(events).toEqual(['opening', 'captured', 'extracted', 'finish:ok']);
    // A search no turn will try again (a job's, through Go's MCP server) ends its card failed before it answers.
    const failing = createIxigoWebBackend({ book, engine: scripted('fail').engine, now, live: live as never, cardDelayMs: 0 });
    events.length = 0;
    await expect(failing.search('trains', TRAINS, { tripId: 't_goa' })).rejects.toMatchObject({ code: 'unreachable' });
    expect(events).toEqual(['opening', 'failed', 'finish:failed']);
  });

  it('says how long a search may hold up the turn: 12 s from its start, and nothing to wait for on a link', async () => {
    const e = scripted();
    e.hold();
    const b = backend(e.engine);
    expect(await b.waitMs!('trains', TRAINS, { tripId: 't_goa' })).toBe(TRAVEL_WAIT_MS);
    void b.search('trains', TRAINS, { tripId: 't_goa' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    nowMs += 5_000;
    expect(await b.waitMs!('trains', TRAINS, { tripId: 't_goa' })).toBe(TRAVEL_WAIT_MS - 5_000);
    nowMs += 20_000;
    expect(await b.waitMs!('trains', TRAINS, { tripId: 't_goa' })).toBe(0);
    e.release();
    expect(await b.waitMs!('flights', FLIGHTS, { tripId: 't_goa' })).toBeNull();
    expect(await b.waitMs!('trains', TRAINS)).toBeNull();
  });

  it("answers flights with ixigo's page, set as asked, loading nothing and posting no card", async () => {
    const cards: string[] = [];
    const b = createIxigoWebBackend({
      book, engine: linkEngine(4, []), now,
      live: ((tripId: string) => { cards.push(tripId); return { progress: () => undefined, finish: async () => undefined }; }) as never,
    });
    const err = (await b.search('flights', { ...FLIGHTS, departAfter: '18:00', mustHave: ['non_stop'] }, { tripId: 't_goa' }).catch((e: unknown) => e)) as TravelError;
    expect(err).toMatchObject({
      code: 'link_only',
      link: 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026&returnDate=&adults=4&children=0&infants=0&class=e&source=Search%20Form&stops=0&takeOff=NIGHT&sort_type=cheapest',
    });
    expect(cards).toEqual([]);
  });

  it("leaves out of a flight link's adults the members who live by another airport", async () => {
    // Six people, five homes known: Arjun (Bangalore) and Meher (Mumbai) fly from elsewhere; the sixth may fly from Delhi.
    const b = createIxigoWebBackend({ book, engine: linkEngine(6, ['Delhi', 'Delhi', 'Bangalore', 'Mumbai', 'Delhi']), now });
    const err = (await b.search('flights', FLIGHTS, { tripId: 't_goa' }).catch((e: unknown) => e)) as TravelError;
    expect(err.link).toContain('&adults=4&');
  });

  it('never holds, confirms or reads a status: the group books on ixigo, from the link', async () => {
    const b = backend(scripted().engine);
    await expect(b.hold('ixigo:x', { name: 'Meher', personIds: ['p_meher'] })).rejects.toBeInstanceOf(TravelError);
    await expect(b.confirm('ixigo:h', { approvalId: 'ap', railRef: 'r' })).rejects.toMatchObject({ code: 'refused', message: expect.stringContaining('booked on ixigo') });
    await expect(b.status({ kind: 'pnr', pnr: '1234567890' })).rejects.toMatchObject({ code: 'refused' });
  });
});

/** A backend that records its live cards: how many it made, and each one's steps and ending, as "<card>:<what>". */
function carded(engine: { answer: Answer }) {
  const events: string[] = [];
  let made = 0;
  const live = () => {
    const n = ++made;
    return {
      progress: (e: { type: string }) => {
        if (e.type !== 'opening' && e.type !== 'captured') events.push(`${n}:${e.type}`);
      },
      finish: async (ok: boolean) => {
        events.push(`${n}:finish:${ok ? 'done' : 'failed'}`);
      },
    };
  };
  const b = createIxigoWebBackend({ book, engine, now, live: live as never, cardDelayMs: 0 });
  return { b, events, made: () => made };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const EARLY = { tripId: 't_goa', messageId: 'm_41' };
const COMPOSER = { tripId: 't_goa', turnId: 'turn_1' };

describe("a live card belongs to its search's turn", () => {
  it("keeps a failed early start's card open, and the composer's search in that turn carries on in it: one card, done once", async () => {
    const c = carded(scripted('fail', 'ok').engine);
    await expect(c.b.search('trains', TRAINS, EARLY)).rejects.toMatchObject({ code: 'unreachable' });
    expect(c.events).toEqual([]);
    await c.b.search('trains', TRAINS, COMPOSER);
    c.b.turnEnded({ tripId: 't_goa', turnId: 'turn_1', messageIds: ['m_41'] });
    expect(c.made()).toBe(1);
    expect(c.events).toEqual(['1:extracted', '1:finish:done']);
  });

  it("ends the card failed at once when the composer's own search fails, before that search answers", async () => {
    const c = carded(scripted('fail', 'fail').engine);
    await expect(c.b.search('trains', TRAINS, EARLY)).rejects.toThrow();
    await c.b.search('trains', TRAINS, COMPOSER).catch(() => c.events.push('answered'));
    expect(c.made()).toBe(1);
    expect(c.events).toEqual(['1:failed', '1:finish:failed', 'answered']);
  });

  it('ends the card a turn left open when the turn ends: failed, once, and only for that trip and its messages', async () => {
    const c = carded(scripted('fail').engine);
    await expect(c.b.search('trains', TRAINS, EARLY)).rejects.toThrow();
    c.b.turnEnded({ tripId: 't_other', turnId: 'turn_9', messageIds: ['m_41'] });
    c.b.turnEnded({ tripId: 't_goa', turnId: 'turn_2', messageIds: ['m_42'] });
    expect(c.events).toEqual([]);
    c.b.turnEnded({ tripId: 't_goa', turnId: 'turn_1', messageIds: ['m_41'] });
    c.b.turnEnded({ tripId: 't_goa', turnId: 'turn_1', messageIds: ['m_41'] });
    expect(c.events).toEqual(['1:failed', '1:finish:failed']);
  });

  it("never fails the card on a pick: it says Go is choosing, waits through the turn's end, and the search after the pick goes on in it (8 Oct, D1)", async () => {
    const c = carded(scripted('pick', 'pick', 'ok').engine);
    // The early start, then the composer with the same words: ixigo knows two Udaipurs.
    await expect(c.b.search('trains', TRAINS, EARLY)).rejects.toMatchObject({ code: 'pick_place' });
    await expect(c.b.search('trains', TRAINS, COMPOSER)).rejects.toMatchObject({ code: 'pick_place' });
    // The turn ends with Go asking the group which one: the card waits on, never red.
    c.b.turnEnded({ tripId: 't_goa', turnId: 'turn_1', messageIds: ['m_41'] });
    expect(c.events).toEqual(['1:choosing', '1:choosing']);
    // The pick, in other words: the same card carries on, and is done once.
    await c.b.search('trains', { ...TRAINS, to: 'Udaipur City (UDZ)' }, { tripId: 't_goa', turnId: 'turn_2' });
    expect(c.made()).toBe(1);
    expect(c.events).toEqual(['1:choosing', '1:choosing', '1:extracted', '1:finish:done']);
  });

  it('ends a card nobody picked for, failed, once it waited 15 minutes', async () => {
    const c = carded(scripted('pick').engine);
    await expect(c.b.search('trains', TRAINS, EARLY)).rejects.toMatchObject({ code: 'pick_place' });
    c.b.turnEnded({ tripId: 't_goa', turnId: 'turn_1', messageIds: ['m_41'] });
    nowMs += CHOOSING_MS;
    c.b.turnEnded({ tripId: 't_goa', turnId: 'turn_5', messageIds: [] });
    expect(c.events).toEqual(['1:choosing', '1:failed', '1:finish:failed']);
  });

  it('never reopens an ended card: the same ask afterwards gets a card of its own', async () => {
    const c = carded(scripted('fail', 'ok').engine);
    await expect(c.b.search('trains', TRAINS, EARLY)).rejects.toThrow();
    c.b.turnEnded({ tripId: 't_goa', turnId: 'turn_1', messageIds: ['m_41'] });
    await c.b.search('trains', TRAINS, { tripId: 't_goa', messageId: 'm_44' });
    expect(c.made()).toBe(2);
    expect(c.events).toEqual(['1:failed', '1:finish:failed', '2:extracted', '2:finish:done']);
  });

  it('lets a search still running when its turn ends keep its card, which its run ends', async () => {
    const ok = scripted('ok');
    const c = carded(ok.engine);
    ok.hold();
    const early = c.b.search('trains', TRAINS, EARLY);
    await tick();
    c.b.turnEnded({ tripId: 't_goa', turnId: 'turn_1', messageIds: ['m_41'] });
    expect(c.events).toEqual([]);
    ok.release();
    await early;
    expect(c.events).toEqual(['1:extracted', '1:finish:done']);
  });

  it('ends at once the card of an early start that fails after its turn is over', async () => {
    const failing = scripted('fail');
    const c = carded(failing.engine);
    failing.hold();
    const early = c.b.search('trains', TRAINS, EARLY).catch(() => 'failed');
    await tick();
    c.b.turnEnded({ tripId: 't_goa', turnId: 'turn_1', messageIds: ['m_41'] });
    failing.release();
    expect(await early).toBe('failed');
    expect(c.events).toEqual(['1:failed', '1:finish:failed']);
  });

  it("gives the card to the composer when it joins its early start's run: if that run fails, the card ends at once", async () => {
    const failing = scripted('fail');
    const c = carded(failing.engine);
    failing.hold();
    const early = c.b.search('trains', TRAINS, EARLY).catch(() => 'early failed');
    const composer = c.b.search('trains', TRAINS, COMPOSER).catch(() => 'composer failed');
    await tick();
    failing.release();
    expect(await Promise.all([early, composer])).toEqual(['early failed', 'composer failed']);
    expect(failing.runs).toHaveLength(1);
    expect(c.made()).toBe(1);
    expect(c.events).toEqual(['1:failed', '1:finish:failed']);
  });
});

describe('a fast answer', () => {
  it('posts no live card when the run answers within 1.5 s; a slower run shows its card, with the steps it missed', async () => {
    vi.useFakeTimers();
    try {
      expect(CARD_DELAY_MS).toBe(1_500);
      const seen: string[] = [];
      const live = () => {
        seen.push('card');
        return { progress: (e: { type: string }) => seen.push(e.type), finish: async (ok: boolean) => { seen.push(ok ? 'done' : 'failed'); } };
      };
      const quick = createIxigoWebBackend({ book, engine: scripted().engine, now, live: live as never });
      await quick.search('trains', TRAINS, { tripId: 't_goa' });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(seen).toEqual([]);
      const slow = scripted();
      slow.hold();
      const b = createIxigoWebBackend({ book, engine: slow.engine, now, live: live as never });
      const run = b.search('trains', TRAINS, { tripId: 't_goa' });
      await vi.advanceTimersByTimeAsync(CARD_DELAY_MS);
      expect(seen).toEqual(['card', 'opening']);
      slow.release();
      await run;
      expect(seen).toEqual(['card', 'opening', 'captured', 'extracted', 'done']);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** A stay as hotels.search reads one: with a pool or not (facts.pool), and any other fact it says. */
const stay = (n: number, pool: boolean, more: Record<string, boolean> = {}): RecipeOption => ({
  kind: 'stay', title: `Stay ${n}`, priceMinor: 500_000 + n, currency: 'INR', priceNote: 'per night, per room', highlights: pool ? ['Pool'] : [],
  facts: { pool, ...more }, sourceUrl: `https://www.ixigo.com/hotels/${n}/details`,
});
const IXIGO_POOL_LIST = [stay(91, true), stay(92, true), stay(93, true), stay(94, true)];
/** The trip's stays head start: its destination and dates, no conditions (warm.ts createStaysHeadStart). */
const HEAD = { place: 'Goa', check_in: '2026-11-06', check_out: '2026-11-09' };
const POOL = { to: 'Goa', checkIn: '2026-11-06', checkOut: '2026-11-09', mustHave: ['pool'] };

/**
 * hotels.search scripted: with no conditions it lists `wide` (checked at 12:00), and with any it lists ixigo's own filtered
 * stays (checked at 12:20): `filtered`, or IXIGO_POOL_LIST. Each run is recorded with its conditions and whether it ran in
 * the background. With requestOf, searches key on the page they open, as on staging; without, on the words.
 */
function staysEngine(wide: RecipeOption[], o: { filtered?: RecipeOption[]; head?: Record<string, unknown>; requestOf?: Engine['requestOf'] } = {}) {
  const head = o.head ?? HEAD;
  const runs: Array<{ conditions: string[]; background: boolean }> = [];
  const answer: Answer = async (_id, _given, ro) => {
    const conditions = ro.conditions ?? [];
    runs.push({ conditions, background: ro.background === true });
    return conditions.length > 0
      ? { as: 'options', options: o.filtered ?? IXIGO_POOL_LIST, page: 'https://www.ixigo.com/hotels/search/result?filters=FL_HF_29', checkedAt: '2026-10-07T12:20:00.000Z', ms: 9_000 }
      : { as: 'options', options: wide, page: 'https://www.ixigo.com/hotels/search/result', checkedAt: '2026-10-07T12:00:00.000Z', ms: 9_000 };
  };
  const cards: string[] = [];
  const b = createIxigoWebBackend({
    book, engine: { answer, ...(o.requestOf ? { requestOf: o.requestOf } : {}) }, now, cardDelayMs: 0,
    live: ((tripId: string) => { cards.push(tripId); return { progress: () => undefined, finish: async () => undefined }; }) as never,
  });
  /** The head start: hotels.search for the trip's place and dates, through Go's searches, kept once it finishes. */
  const headStart = async (): Promise<void> => {
    const shared = await b.shareStep('hotels.search', head, { tripId: 't_goa', conditions: [] }, () => answer('hotels.search', head, { tripId: 't_goa', conditions: [] }));
    await shared?.answer;
    await tick();
  };
  return { b, runs, cards, headStart };
}

describe('a stays ask answered from a kept search with no conditions (the head start)', () => {
  it("answers a pool ask at once from the kept list, its stays with a pool, in one search with no live card", async () => {
    const s = staysEngine([stay(1, true), stay(2, false), stay(3, true), stay(4, true), stay(5, false)]);
    await s.headStart();
    const found = await s.b.search('stays', POOL, { tripId: 't_goa', turnId: 'turn_1' });
    expect(found.results.map((r) => r.title)).toEqual(['Stay 1', 'Stay 3', 'Stay 4']);
    // The card says when the kept list was checked, and "See all on ixigo" opens that page.
    expect(found).toMatchObject({ checkedAt: '2026-10-07T12:00:00.000Z', page: 'https://www.ixigo.com/hotels/search/result' });
    expect(s.cards).toEqual([]);
    // ixigo's own pool search starts in the background: no card, no hold.
    expect(s.runs).toEqual([{ conditions: [], background: false }, { conditions: ['pool'], background: true }]);
    // A condition that is not the page's (a beach) is Go's own filter's: the pool still narrows.
    const near = await s.b.search('stays', { ...POOL, mustHave: ['pool', 'beach'] }, { tripId: 't_goa', turnId: 'turn_2' });
    expect(near.results.map((r) => r.title)).toEqual(['Stay 1', 'Stay 3', 'Stay 4']);
  });

  it('keeps the filtered search it ran: the next pool ask answers from it, loading nothing', async () => {
    const s = staysEngine([stay(1, true), stay(2, true), stay(3, true)]);
    await s.headStart();
    await s.b.search('stays', POOL, { tripId: 't_goa', turnId: 'turn_1' });
    await tick();
    const again = await s.b.search('stays', POOL, { tripId: 't_goa', turnId: 'turn_2' });
    expect(again.results.map((r) => r.title)).toEqual(['Stay 91', 'Stay 92', 'Stay 93', 'Stay 94']);
    expect(again.checkedAt).toBe('2026-10-07T12:20:00.000Z');
    expect(s.runs).toHaveLength(2);
    expect(s.cards).toEqual([]);
  });

  it(`runs its own search, with its card, when fewer than ${NARROW_MIN} kept stays have a pool`, async () => {
    const s = staysEngine([stay(1, true), stay(2, true), stay(3, false), stay(4, false)]);
    await s.headStart();
    const found = await s.b.search('stays', POOL, { tripId: 't_goa', turnId: 'turn_1' });
    expect(found.results.map((r) => r.title)).toEqual(['Stay 91', 'Stay 92', 'Stay 93', 'Stay 94']);
    expect(s.runs).toEqual([{ conditions: [], background: false }, { conditions: ['pool'], background: false }]);
    expect(s.cards).toEqual(['t_goa']);
  });

  /**
   * The lead's trip on staging, 8 Oct: five people in North Goa. The head start's list has three stays with a pool, one
   * of them with free cancellation; ixigo's own pool list has three with it. Keyed by the page, as on staging.
   */
  const NORTH = { area: 'North Goa', checkIn: '2026-11-06', checkOut: '2026-11-09' };
  function fiveInNorthGoa() {
    const fiveOfUs = createEngine({ book, runner: () => null, trip: async () => ({ people: 5, homes: [] }), now });
    const fc = { free_cancellation: true };
    return staysEngine([stay(1, true, fc), stay(2, true), stay(3, true), stay(4, false)], {
      head: { place: 'North Goa', check_in: '2026-11-06', check_out: '2026-11-09' },
      filtered: [stay(91, true, fc), stay(92, true, fc), stay(93, true), stay(94, true, fc)],
      requestOf: (id, given, ro) => fiveOfUs.requestOf(id, given, ro),
    });
  }

  // Staging, 8 Oct, run 1: the pool card came from the head start's list. Priya then asked "which of these has free
  // cancellation?", and the model searched "sleeping 5, with a pool, with free cancellation": a page load of 13 s, though
  // the pool search kept behind the card had them.
  it('answers "which of these has free cancellation?" after the pool card from the pool search kept behind it, sleeping 5 in a trip of five', async () => {
    const s = fiveInNorthGoa();
    await s.headStart();
    // "@Go find a villa with a pool in North Goa": the card at once from the head start's list, and ixigo's pool search kept behind it.
    const card = await s.b.search('stays', { ...NORTH, mustHave: ['pool'] }, { tripId: 't_goa', turnId: 'turn_1' });
    expect(card.results.map((r) => r.title)).toEqual(['Stay 1', 'Stay 2', 'Stay 3']);
    await tick();
    // The head start has one with both; the pool search has three, and answers at once. "Sleeping 5" is the trip's own
    // head count, the page both searches opened, not a condition.
    const asked = await s.b.search('stays', { ...NORTH, guests: 5, mustHave: ['pool', 'free_cancellation'] }, { tripId: 't_goa', turnId: 'turn_2' });
    expect(asked.results.map((r) => r.title)).toEqual(['Stay 91', 'Stay 92', 'Stay 94']);
    expect(asked.checkedAt).toBe('2026-10-07T12:20:00.000Z');
    expect(s.runs).toEqual([
      { conditions: [], background: false },
      { conditions: ['pool'], background: true },
      { conditions: ['pool', 'free_cancellation'], background: true },
    ]);
    expect(s.cards).toEqual([]);
  });

  // Run 2: Go's own pool card when the dates were locked ("Dates are locked, so here are pool stays…"), then "@Go find a
  // villa with a pool in North Goa", then the same follow-up, which loaded a page for 14 s.
  it("answers the follow-up at once in run 2's order too: Go's own pool card, the villa ask, then free cancellation", async () => {
    const s = fiveInNorthGoa();
    await s.headStart();
    const proactive = await s.b.search('stays', { ...NORTH, mustHave: ['pool'] }, { tripId: 't_goa', turnId: 'turn_1' });
    expect(proactive.results.map((r) => r.title)).toEqual(['Stay 1', 'Stay 2', 'Stay 3']);
    await tick();
    // The villa ask: ixigo's pool search, kept behind Go's card, as it is.
    const villa = await s.b.search('stays', { ...NORTH, mustHave: ['pool'] }, { tripId: 't_goa', turnId: 'turn_2' });
    expect(villa.results.map((r) => r.title)).toEqual(['Stay 91', 'Stay 92', 'Stay 93', 'Stay 94']);
    const asked = await s.b.search('stays', { ...NORTH, guests: 5, mustHave: ['pool', 'free_cancellation'] }, { tripId: 't_goa', turnId: 'turn_3' });
    expect(asked.results.map((r) => r.title)).toEqual(['Stay 91', 'Stay 92', 'Stay 94']);
    expect(s.runs).toEqual([
      { conditions: [], background: false },
      { conditions: ['pool'], background: true },
      { conditions: ['pool', 'free_cancellation'], background: true },
    ]);
    expect(s.cards).toEqual([]);
  });

  it("answers a watch's first check from what is kept, loading nothing: the kept stays narrowed, or null when nothing kept answers", async () => {
    const s = staysEngine([stay(1, true), stay(2, true), stay(3, true), stay(4, false)]);
    const pool = { tripId: 't_goa', conditions: ['pool'] };
    expect(await s.b.keptAnswer('hotels.search', HEAD, pool)).toBeNull();
    await s.headStart();
    const kept = await s.b.keptAnswer('hotels.search', HEAD, pool);
    expect(kept).toMatchObject({ as: 'options', checkedAt: '2026-10-07T12:00:00.000Z', page: 'https://www.ixigo.com/hotels/search/result' });
    expect(kept?.as === 'options' && kept.options.map((o) => o.title)).toEqual(['Stay 1', 'Stay 2', 'Stay 3']);
    // A page condition the stays don't say (paying at the hotel), or a recipe that is not a search: nothing kept answers.
    expect(await s.b.keptAnswer('hotels.search', HEAD, { tripId: 't_goa', conditions: ['pay_at_hotel'] })).toBeNull();
    expect(await s.b.keptAnswer('trains.confirm_chance', { from: 'Bangalore', to: 'Chennai', date: '2026-10-22' }, { tripId: 't_goa' })).toBeNull();
    // Reading what is kept runs nothing.
    expect(s.runs).toEqual([{ conditions: [], background: false }]);
  });

  it('knows a page is kept or running with any conditions (pageKept), so the head start loads nothing behind a pool search', async () => {
    const s = staysEngine([stay(1, true), stay(2, true), stay(3, true)]);
    const trip = { tripId: 't_goa' };
    expect(await s.b.pageKept('hotels.search', HEAD, trip)).toBe(false);
    // The turn's own "pool stays for 6 to 9 Nov": the same page with a condition.
    await s.b.search('stays', POOL, { tripId: 't_goa', turnId: 'turn_0' });
    expect(await s.b.pageKept('hotels.search', HEAD, trip)).toBe(true);
    // Other dates, or another place, are other pages.
    expect(await s.b.pageKept('hotels.search', { ...HEAD, check_out: '2026-11-10' }, trip)).toBe(false);
    expect(await s.b.pageKept('hotels.search', { ...HEAD, place: 'Manali' }, trip)).toBe(false);
    // Past its time it answers nothing.
    nowMs += 31 * 60_000;
    try {
      expect(await s.b.pageKept('hotels.search', HEAD, trip)).toBe(false);
    } finally {
      nowMs -= 31 * 60_000;
    }
    // Asking runs nothing.
    expect(s.runs).toEqual([{ conditions: ['pool'], background: false }]);
  });

  it("runs its own search for a page condition the stays don't say (paying at the hotel), and with no kept search", async () => {
    const s = staysEngine([stay(1, true), stay(2, true), stay(3, true)]);
    await s.b.search('stays', POOL, { tripId: 't_goa', turnId: 'turn_0' });
    expect(s.runs).toEqual([{ conditions: ['pool'], background: false }]);
    await s.headStart();
    await s.b.search('stays', { ...POOL, mustHave: ['pay_at_hotel'] }, { tripId: 't_goa', turnId: 'turn_1' });
    expect(s.runs.at(-1)).toEqual({ conditions: ['pay_at_hotel'], background: false });
    expect(s.cards).toEqual(['t_goa', 't_goa']);
  });
});
