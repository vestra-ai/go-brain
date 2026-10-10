import { describe, expect, it, vi } from 'vitest';
import { loadBook } from '../../book/book.js';
import { createEngine, type Engine, type RunFor } from '../../book/engine.js';
import { TravelError } from '../../mcp-travel.js';
import { CARD_DELAY_MS, CHALLENGE_COOL_MS, CHOOSING_MS, createIxigoWebBackend, NARROW_MIN, TRAVEL_WAIT_MS } from '../backend.js';
import type { RecipeOption } from '../recipe.js';
import { NothingCaughtError } from '../runners.js';
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
    // Flights read their page too (flights.results), unless the page is paced: then the link answers at once.
    expect(await b.waitMs!('flights', FLIGHTS, { tripId: 't_goa' })).toBe(TRAVEL_WAIT_MS);
    expect(await b.waitMs!('trains', TRAINS)).toBeNull();
  });

  it("answers flights ixigo's page can't give (no computer here) with ixigo's page, set as asked, posting no card", async () => {
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

  // Flights read ixigo's page now (flights.results, 9 Oct: 145 fares, Delhi to Goa), paced, as ixigo refuses our boxes'
  // shared address under a burst; a page held back, refused, or with nothing on it answers with the link instead.
  describe('flights', () => {
    const FLIGHT: RecipeOption = { ...OPTION, kind: 'flight', title: 'IndiGo 6E357', priceNote: 'per person' };
    function flightsEngine(o: { results?: 'options' | 'empty' | 'refused' | 'unknown_place'; live?: unknown } = {}) {
      const real = linkEngine(4, []);
      const runs: string[] = [];
      const state = { paced: false, results: o.results ?? 'options' };
      const engine = {
        answer: (async (id, given, r) => {
          runs.push(id);
          if (id === 'flights.search') return real.answer(id, given, r);
          if (state.results === 'refused') throw new TravelError('refused', "ixigo's page did not send flights between two airports on a date.");
          if (state.results === 'unknown_place') throw new TravelError('unknown_place', 'ixigo knows no airport for "Atlantis".');
          return { as: 'options', options: state.results === 'empty' ? [] : [FLIGHT], page: 'https://www.ixigo.com/x', checkedAt: '2026-10-07T12:00:03.000Z', ms: 4_100 };
        }) as Answer,
        pacedOut: (id: string) => id === 'flights.results' && state.paced,
      };
      return { backend: createIxigoWebBackend({ book, engine, now, ...(o.live ? { live: o.live as never, cardDelayMs: 0 } : {}) }), runs, state };
    }

    // Keshav's live test, 10 Oct: "DIDN'T WORK · Searching flights on ixigo", then the link card that answered the group.
    it("ends a refused page's live card calm and done, saying the link answered: never \"Didn't work\" when the group got something", async () => {
      const seen: string[] = [];
      const live = () => ({
        progress: (e: { type: string; text?: string }) => {
          if (e.type === 'answered' || e.type === 'failed') seen.push(e.type === 'answered' ? `answered: ${e.text}` : 'failed');
        },
        finish: async (ok: boolean) => {
          seen.push(ok ? 'done' : 'failed');
        },
      });
      const f = flightsEngine({ results: 'refused', live });
      await expect(f.backend.search('flights', FLIGHTS, { tripId: 't_goa', turnId: 'turn_calm' })).rejects.toMatchObject({ code: 'link_only' });
      expect(seen).toEqual([expect.stringMatching(/^answered: Here's ixigo's page, set /), 'done']);
    });

    it("reads flights from their page, and keeps them: asked again while the page is paced, the kept flights answer", async () => {
      const f = flightsEngine();
      expect((await f.backend.search('flights', FLIGHTS, { tripId: 't_goa' })).results.map((r) => r.title)).toEqual(['IndiGo 6E357']);
      f.state.paced = true;
      expect((await f.backend.search('flights', FLIGHTS, { tripId: 't_goa' })).results.map((r) => r.title)).toEqual(['IndiGo 6E357']);
      expect(f.runs).toEqual(['flights.results']);
    });

    it('answers a page held back, refused, or with nothing on it with the link, set as asked: never "no flights"', async () => {
      for (const way of ['paced', 'refused', 'empty'] as const) {
        const f = flightsEngine(way === 'paced' ? {} : { results: way });
        f.state.paced = way === 'paced';
        const err = (await f.backend.search('flights', { ...FLIGHTS, departAfter: '18:00' }, { tripId: 't_goa' }).catch((e: unknown) => e)) as TravelError;
        expect(err, way).toMatchObject({ code: 'link_only', link: expect.stringContaining('from=DEL&to=GOI&date=06112026&') });
        expect(err.link, way).toContain('takeOff=NIGHT');
        // Held back, no page loads: the link alone.
        expect(f.runs, way).toEqual(way === 'paced' ? ['flights.search'] : ['flights.results', 'flights.search']);
      }
    });

    it('says a place ixigo does not know as before, and waits for nothing while the page is paced', async () => {
      const f = flightsEngine({ results: 'unknown_place' });
      await expect(f.backend.search('flights', { ...FLIGHTS, from: 'Atlantis' }, { tripId: 't_goa' })).rejects.toMatchObject({ code: 'unknown_place' });
      f.state.paced = true;
      expect(await f.backend.waitMs!('flights', FLIGHTS, { tripId: 't_goa' })).toBeNull();
    });
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
  it("joins a search begun while its city needed ixigo's box by its words, once the box has answered: one load, one card", async () => {
    const s = scripted('ok', 'ok');
    s.hold();
    // Before the box answers, the words key the search; after, the page they open does (keyFor).
    let boxAnswered = false;
    const engine = { answer: s.engine.answer, requestOf: async () => (boxAnswered ? 'the buses page from Hubballi' : null) };
    const c = carded(engine);
    const BUSES = { from: 'hubli', to: 'goa', date: '2026-11-06' };
    const early = c.b.search('buses', BUSES, EARLY);
    await tick();
    boxAnswered = true;
    // The composer's call for the same ask, as the model words it.
    const composer = c.b.search('buses', { ...BUSES, from: 'Hubli' }, COMPOSER);
    await tick();
    s.release();
    await expect(Promise.all([early, composer])).resolves.toHaveLength(2);
    expect(s.runs).toHaveLength(1);
    expect(c.made()).toBe(1);
  });

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
  it('posts no live card for an answer with no page to open; a run that opens one shows its card at once, with every step', async () => {
    vi.useFakeTimers();
    try {
      expect(CARD_DELAY_MS).toBe(1_500);
      const seen: string[] = [];
      const live = () => {
        seen.push('card');
        return { progress: (e: { type: string }) => seen.push(e.type), finish: async (ok: boolean) => { seen.push(ok ? 'done' : 'failed'); } };
      };
      // A kept answer (or a fast call): no page opened, so no card, before or after 1.5 s.
      const kept = { answer: async () => ({ as: 'options' as const, options: [OPTION], page: 'https://www.ixigo.com/x', checkedAt: '2026-10-07T12:00:03.000Z', ms: 40 }) };
      const quick = createIxigoWebBackend({ book, engine: kept as never, now, live: live as never });
      await quick.search('trains', TRAINS, { tripId: 't_goa' });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(seen).toEqual([]);
      // A page on the stage: its card the moment it opens (10 Oct: the live view 1.5 s sooner), never after the delay.
      const slow = scripted();
      slow.hold();
      const b = createIxigoWebBackend({ book, engine: slow.engine, now, live: live as never });
      const run = b.search('trains', TRAINS, { tripId: 't_goa' });
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toEqual(['card', 'opening']);
      await vi.advanceTimersByTimeAsync(CARD_DELAY_MS);
      expect(seen.filter((x) => x === 'card')).toHaveLength(1);
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
 * the background, and its options as asked (asks). With requestOf, searches key on the page they open, as on staging;
 * without, on the words. hangs: a filtered page catches nothing, as the runner says it (NothingCaughtError for a caller
 * that falls back, else a timeout).
 */
function staysEngine(
  wide: RecipeOption[],
  o: { filtered?: RecipeOption[]; head?: Record<string, unknown>; requestOf?: Engine['requestOf']; hangs?: boolean; said?: boolean; pageOf?: Engine['pageOf']; challengedAt?: (tripId: string) => number | null } = {},
) {
  const head = o.head ?? HEAD;
  const runs: Array<{ conditions: string[]; background: boolean }> = [];
  const asks: RunFor[] = [];
  const answer: Answer = async (_id, _given, ro) => {
    const conditions = ro.conditions ?? [];
    runs.push({ conditions, background: ro.background === true });
    asks.push(ro);
    const filtered = conditions.length > 0 || (ro.siteFilters?.length ?? 0) > 0;
    if (o.hangs && filtered) throw ro.fallsBack ? new NothingCaughtError() : new TravelError('unreachable', 'ixigo took too long to answer. Try again in a moment.');
    // ixigo's own filters by their names on its list (site_filters): what the engine says the site did with them.
    if (ro.siteFilters?.length) {
      const list = { recipeId: 'hotels.search', about: 'stays in Goa', at: 0, offers: [{ kind: 'filter' as const, group: 'Facilities', name: 'Pet-friendly property', code: 'FL_HF_21' }] };
      const site = { filtered: ro.siteFilters.filter((n) => n === 'Pet-friendly property'), sorted: null, unknown: ro.siteFilters.filter((n) => n !== 'Pet-friendly property'), listed: true, list };
      return { as: 'options', options: o.filtered ?? IXIGO_POOL_LIST, page: 'https://www.ixigo.com/hotels/search/result?filters=FL_HF_21', checkedAt: '2026-10-07T12:20:00.000Z', ms: 9_000, site };
    }
    return conditions.length > 0
      ? { as: 'options', options: o.filtered ?? IXIGO_POOL_LIST, page: 'https://www.ixigo.com/hotels/search/result?filters=FL_HF_29', checkedAt: '2026-10-07T12:20:00.000Z', ms: 9_000 }
      : {
          as: 'options', options: wide, page: 'https://www.ixigo.com/hotels/search/result', checkedAt: '2026-10-07T12:00:00.000Z', ms: 9_000,
          // said: the engine's word on the site, as a recipe with offers gives it: a plain read applied nothing.
          ...(o.said ? { site: { filtered: [], sorted: null, unknown: [], listed: false, list: null } } : {}),
        };
  };
  const cards: string[] = [];
  const b = createIxigoWebBackend({
    book, engine: { answer, ...(o.requestOf ? { requestOf: o.requestOf } : {}), ...(o.pageOf ? { pageOf: o.pageOf } : {}) }, now, cardDelayMs: 0,
    ...(o.challengedAt ? { challengedAt: o.challengedAt } : {}),
    live: ((tripId: string) => { cards.push(tripId); return { progress: () => undefined, finish: async () => undefined }; }) as never,
  });
  /** The head start: hotels.search for the trip's place and dates, through Go's searches, kept once it finishes. */
  const headStart = async (): Promise<void> => {
    const shared = await b.shareStep('hotels.search', head, { tripId: 't_goa', conditions: [] }, () => answer('hotels.search', head, { tripId: 't_goa', conditions: [] }));
    await shared?.answer;
    await tick();
  };
  return { b, runs, asks, cards, headStart };
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

describe("a filtered stays search whose page catches nothing (staging, 9 Oct: Goa sleeping 5 with a pool, 20 s on a logged-in computer)", () => {
  it('reads the page again at once without its filters, on the same card, and says which ixigo left off', async () => {
    const s = staysEngine([stay(1, true), stay(2, false), stay(3, true)], { hangs: true });
    const found = await s.b.search('stays', { ...POOL, guests: 5 }, { tripId: 't_goa', turnId: 'turn_1' });
    // The filtered page once, asked as one that falls back; then the page without the pool, the head count kept.
    expect(s.runs).toEqual([{ conditions: ['pool'], background: false }, { conditions: [], background: false }]);
    expect(s.asks[0]).toMatchObject({ fallsBack: true });
    expect(s.asks[1]).not.toHaveProperty('fallsBack');
    // Every stay the page has: Go's own filters pick from them (layer.ts), and the answer says the pool was left off.
    expect(found.results.map((r) => r.title)).toEqual(['Stay 1', 'Stay 2', 'Stay 3']);
    expect(found).toMatchObject({ unapplied: ['pool'], checkedAt: '2026-10-07T12:00:00.000Z', page: 'https://www.ixigo.com/hotels/search/result' });
    expect(s.cards).toEqual(['t_goa']);
    // A condition that is not the page's (a beach) is Go's own filter's either way: the page is read with none.
    const near = staysEngine([stay(1, true)], { hangs: true });
    await near.b.search('stays', { ...POOL, mustHave: ['pool', 'beach'] }, { tripId: 't_goa', turnId: 'turn_2' });
    expect(near.runs.map((r) => r.conditions)).toEqual([['pool', 'beach'], []]);
  });

  it("takes a fresh read of the page kept or running (the head start) instead of loading it again", async () => {
    const s = staysEngine([stay(1, true), stay(2, false)], { hangs: true });
    await s.headStart();
    // Fewer than NARROW_MIN kept stays have a pool, so the ask runs ixigo's pool search, which catches nothing.
    const found = await s.b.search('stays', POOL, { tripId: 't_goa', turnId: 'turn_1' });
    expect(s.runs).toEqual([{ conditions: [], background: false }, { conditions: ['pool'], background: false }]);
    expect(found.results.map((r) => r.title)).toEqual(['Stay 1', 'Stay 2']);
    expect(found.unapplied).toEqual(['pool']);
  });

  it("never answers for the filter from the list read without it: a search sharing it reads the stays that say it, and what is kept is narrowed", async () => {
    const s = staysEngine([stay(1, true), stay(2, false), stay(3, false)], { hangs: true });
    await s.b.search('stays', POOL, { tripId: 't_goa', turnId: 'turn_1' });
    const shared = await s.b.shareStep('hotels.search', HEAD, { tripId: 't_goa', conditions: ['pool'] }, () => {
      throw new Error('the kept search answers');
    });
    expect(shared?.joined).toBe(true);
    const a = await shared!.answer;
    expect(a.as === 'options' && a.options.map((o) => o.title)).toEqual(['Stay 1']);
    await tick();
    // One stay with a pool is fewer than NARROW_MIN: nothing kept answers a watch's first check.
    expect(await s.b.keptAnswer('hotels.search', HEAD, { tripId: 't_goa', conditions: ['pool'] })).toBeNull();
    expect(s.runs).toHaveLength(2);
  });

  it('fails as ever on anything else, and an ask with no filter the stays say never falls back', async () => {
    const s = staysEngine([stay(1, true)], { hangs: true });
    // Paying at the hotel: no stay says it, so its page is asked as ever, and its timeout is the search's.
    await expect(s.b.search('stays', { ...POOL, mustHave: ['pay_at_hotel'] }, { tripId: 't_goa', turnId: 'turn_1' })).rejects.toMatchObject({ code: 'unreachable' });
    expect(s.runs).toEqual([{ conditions: ['pay_at_hotel'], background: false }]);
    expect(s.asks[0]).not.toHaveProperty('fallsBack');
    // No conditions at all: the page itself, asked once.
    const plain = await s.b.search('stays', { ...POOL, mustHave: [] }, { tripId: 't_goa', turnId: 'turn_2' });
    expect(plain).not.toHaveProperty('unapplied');
    expect(s.asks[1]).not.toHaveProperty('fallsBack');
  });
});

// p0's golden run, 10 Oct: all four hotels loads on Cloudflare's check, and Go only said "Want me to try again?".
describe("a stays read that fails is never a bare \"try again\"", () => {
  const PAY = { ...POOL, mustHave: ['pay_at_hotel'] };
  const PAGE = 'https://www.ixigo.com/hotels/search/result?locationId=32&roomCount=3&filters=PT_PAY_AT_HOTEL';

  it("answers with Go's earlier read of the same page, dated as it was read, and loads nothing more", async () => {
    const s = staysEngine([stay(1, true), stay(2, false)], { hangs: true });
    await s.headStart();
    const found = await s.b.search('stays', PAY, { tripId: 't_goa', turnId: 'turn_1' });
    expect(found).toMatchObject({ earlier: true, checkedAt: '2026-10-07T12:00:00.000Z' });
    expect(found.results.map((r) => r.title)).toEqual(['Stay 1', 'Stay 2']);
    expect(s.runs).toEqual([{ conditions: [], background: false }, { conditions: ['pay_at_hotel'], background: false }]);
  });

  it("with no earlier read, gives ixigo's own stays page set as asked, as a link, as flights do", async () => {
    const s = staysEngine([stay(1, true)], { hangs: true, pageOf: async () => PAGE });
    await expect(s.b.search('stays', PAY, { tripId: 't_goa', turnId: 'turn_1' })).rejects.toMatchObject({ code: 'link_only', link: PAGE });
  });

  it("opens no stays page on a computer that met Cloudflare's check moments ago: the fallback answers at once", async () => {
    let met: number | null = null;
    const s = staysEngine([stay(1, true), stay(2, false)], { challengedAt: () => met, pageOf: async () => PAGE });
    await s.headStart();
    met = now().getTime() - 30_000;
    const found = await s.b.search('stays', PAY, { tripId: 't_goa', turnId: 'turn_1' });
    expect(found).toMatchObject({ earlier: true });
    // The head start's read only: the ask loaded nothing.
    expect(s.runs).toEqual([{ conditions: [], background: false }]);
    // Two minutes on, the ask's own page is read again.
    met = now().getTime() - CHALLENGE_COOL_MS;
    await s.b.search('stays', PAY, { tripId: 't_goa', turnId: 'turn_2' });
    expect(s.runs).toHaveLength(2);
  });
});

describe("a stays ask by ixigo's own filters, by their names on its list (site_filters)", () => {
  const PETS = { to: 'Goa', checkIn: '2026-11-06', checkOut: '2026-11-09', siteFilters: ['Pet-friendly property', 'beachfront'] };

  it("runs the page with them, as one that falls back, apart from the plain page; says what ixigo filtered and what it didn't", async () => {
    const s = staysEngine([stay(1, true), stay(2, false)]);
    await s.headStart();
    const found = await s.b.search('stays', PETS, { tripId: 't_goa', turnId: 'turn_1' });
    // Not the kept plain page: ixigo's own filtered one.
    expect(s.runs).toHaveLength(2);
    expect(s.asks[1]).toMatchObject({ siteFilters: ['Pet-friendly property', 'beachfront'], fallsBack: true });
    expect(found.site).toEqual({ filtered: ['Pet-friendly property'], sorted: null, unknown: ['beachfront'], listed: true, offers: 'Facilities: Pet-friendly property' });
    expect(found).not.toHaveProperty('unapplied');
    // The same ask again joins it; the plain page is another search.
    await s.b.search('stays', PETS, { tripId: 't_goa', turnId: 'turn_2' });
    expect(s.runs).toHaveLength(2);
  });

  it("never passes off another ask's search as this one's: a search its names couldn't change (no list kept yet) leaves them all to pick", async () => {
    // The real engine opens the same page when no name is on a kept list: one request, so one search.
    const s = staysEngine([stay(1, true), stay(2, false)], { requestOf: async () => 'the same page', said: true });
    const plain = await s.b.search('stays', { to: 'Goa', checkIn: '2026-11-06', checkOut: '2026-11-09' }, { tripId: 't_goa', turnId: 'turn_0' });
    expect(plain.site).toMatchObject({ filtered: [], unknown: [] });
    const found = await s.b.search('stays', PETS, { tripId: 't_goa', turnId: 'turn_1' });
    expect(s.runs).toHaveLength(1);
    expect(found.results.map((r) => r.title)).toEqual(['Stay 1', 'Stay 2']);
    expect(found.site).toMatchObject({ filtered: [], unknown: ['Pet-friendly property', 'beachfront'] });
  });

  it('reads the page plain at once when the filtered one catches nothing, the head start first, and says which filters ixigo left off', async () => {
    const s = staysEngine([stay(1, true), stay(2, false)], { hangs: true });
    await s.headStart();
    const found = await s.b.search('stays', PETS, { tripId: 't_goa', turnId: 'turn_1' });
    expect(s.runs).toHaveLength(2);
    expect(found.results.map((r) => r.title)).toEqual(['Stay 1', 'Stay 2']);
    expect(found.unapplied).toEqual(['Pet-friendly property', 'beachfront']);
  });
});

// The lead, 10 Oct: a decided budget picks ixigo's own price bands; a band that holds no stay falls back to the plain list.
describe("a stays search by the group's decided budget", () => {
  it("asks ixigo's price bands by the budget, apart from the search without it, and reads without them when they hold no stay", async () => {
    const runs: RunFor[] = [];
    const answer: Answer = async (_id, _given, ro) => {
      runs.push(ro);
      return { as: 'options', options: ro.budgetMinor ? [] : [stay(1, true), stay(2, false)], page: 'https://www.ixigo.com/hotels/search/result', checkedAt: '2026-10-10T05:00:00.000Z', ms: 900 };
    };
    const b = createIxigoWebBackend({ book, engine: { answer }, now });
    const found = await b.search('stays', { to: 'Goa', checkIn: '2026-11-06', checkOut: '2026-11-09', budgetMinor: 450_000 }, { tripId: 't_band' });
    expect(found.results.map((r) => r.title)).toEqual(['Stay 1', 'Stay 2']);
    expect(runs.map((r) => r.budgetMinor)).toEqual([450_000, undefined]);
  });

  // Jev's early read of a place is often its first, before ixigo's list (and so its bands) is known; the composer's
  // search of the same budget comes after it is. Keyed by the bands, they were two pages for one ask.
  it('keys a budgeted search by its amount, not the bands it picks: the early read and the composer\'s search are one', async () => {
    const runs: RunFor[] = [];
    const answer: Answer = async (_id, _given, ro) => {
      runs.push(ro);
      return { as: 'options', options: [stay(1, true), stay(2, false)], page: 'https://www.ixigo.com/hotels/search/result', checkedAt: '2026-10-10T05:00:00.000Z', ms: 900 };
    };
    // A page whose request would change once the list is known: the bands join it.
    let listKnown = false;
    const requestOf: Engine['requestOf'] = async (_id, _given, ro) => (ro.budgetMinor && listKnown ? 'the page with bands' : 'the page');
    const b = createIxigoWebBackend({ book, engine: { answer, requestOf }, now });
    const goa = { to: 'Goa', checkIn: '2026-11-06', checkOut: '2026-11-09' };
    await b.search('stays', { ...goa, budgetMinor: 450_000 }, { tripId: 't_band', messageId: 'm_early' });
    listKnown = true;
    await b.search('stays', { ...goa, budgetMinor: 450_000 }, { tripId: 't_band', turnId: 'turn_1' });
    expect(runs.map((r) => r.budgetMinor)).toEqual([450_000]);
    // Another budget, and no budget, are their own searches.
    await b.search('stays', { ...goa, budgetMinor: 800_000 }, { tripId: 't_band', turnId: 'turn_2' });
    await b.search('stays', goa, { tripId: 't_band', turnId: 'turn_3' });
    expect(runs.map((r) => r.budgetMinor)).toEqual([450_000, 800_000, undefined]);
  });
});
