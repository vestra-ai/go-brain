import { describe, expect, it, vi } from 'vitest';
import { loadBook } from '../../book/book.js';
import { createEngine, type Engine } from '../../book/engine.js';
import { TravelError } from '../../mcp-travel.js';
import { CARD_DELAY_MS, createIxigoWebBackend, TRAVEL_WAIT_MS } from '../backend.js';
import type { RecipeOption } from '../recipe.js';

const { book } = loadBook();
const OPTION: RecipeOption = {
  kind: 'train', title: 'Mandovi Express 10103', priceMinor: 120_000, currency: 'INR', priceNote: 'per person, SL', highlights: ['Sleeper'], facts: { class_code: 'SL' },
  sourceUrl: 'https://www.ixigo.com/trains/10103?orgn=CSMT&dstn=MAO&departDate=2026-11-06&quota=GN',
};

type Answer = Engine['answer'];
type Run = { id: string; given: Record<string, unknown>; tripId: string; conditions: string[] };

/** A recipe engine whose runs fail or answer in turn; hold() keeps the runs waiting until release(). */
function scripted(...outcomes: Array<'fail' | 'ok'>) {
  const runs: Run[] = [];
  let gate: Promise<void> | null = null;
  let open: () => void = () => undefined;
  const answer: Answer = async (id, given, o) => {
    runs.push({ id, given, tripId: o.tripId, conditions: o.conditions ?? [] });
    const outcome = outcomes[runs.length - 1] ?? 'ok';
    o.onProgress?.({ type: 'opening', recipeId: id, url: 'https://www.ixigo.com/x' });
    if (gate) await gate;
    if (outcome === 'fail') throw new TravelError('unreachable', 'ixigo took too long to answer.');
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
    expect(found).toEqual({ results: [OPTION], checkedAt: '2026-10-07T12:00:03.000Z', runId: expect.stringMatching(/^trains\.between\|/) });
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
