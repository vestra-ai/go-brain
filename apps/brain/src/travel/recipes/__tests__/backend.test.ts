import { describe, expect, it } from 'vitest';
import { TravelError } from '../../mcp-travel.js';
import { createIxigoWebBackend, LINK_ONLY_KINDS, TRAVEL_WAIT_MS } from '../backend.js';
import type { RecipeOption } from '../recipe.js';
import type { RecipeRunner } from '../runners.js';

const OPTION: RecipeOption = {
  kind: 'flight', title: 'IndiGo 6E 5341', priceMinor: 789_600, currency: 'INR', priceNote: 'per person', highlights: ['Non-stop'], facts: { stops: 0 },
  sourceUrl: 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026&returnDate=&adults=4&children=0&infants=0&class=e&source=Search%20Form',
};

function runner(fail = false) {
  const runs: Array<{ tripId: string; recipe: string; slots: unknown }> = [];
  let release: () => void = () => undefined;
  let gate: Promise<void> | null = null;
  const r: RecipeRunner = {
    name: 'agent_job',
    async run(tripId, recipe, slots) {
      runs.push({ tripId, recipe: recipe.id, slots });
      if (gate) await gate;
      if (fail) throw new TravelError('unreachable', 'ixigo took too long to answer.');
      return { options: [OPTION], checkedAt: '2026-10-07T12:00:03.000Z', ms: 3_100 };
    },
  };
  /** Holds every run until released, so two searches meet while one is in flight. */
  const hold = () => {
    gate = new Promise((resolve) => {
      release = resolve;
    });
  };
  return { r, runs, hold, release: () => release() };
}

let nowMs = Date.parse('2026-10-07T12:00:00Z');
const backend = (r: RecipeRunner | null) => createIxigoWebBackend({ runner: () => r, peopleOf: async () => 4, now: () => new Date(nowMs) });
const FLIGHTS = { from: 'Delhi', to: 'Goa', date: '2026-11-06' };
const TRAINS = { from: 'Delhi', to: 'Goa', date: '2026-11-06' };

describe('the ixigo_web backend', () => {
  it("runs the kind's recipe in the trip's browser, for the trip's head count when nobody gave a number", async () => {
    const { r, runs } = runner();
    const found = await backend(r).search('flights', { from: 'Delhi', to: 'Goa', date: '2026-11-06' }, { tripId: 't_goa' });
    expect(runs).toEqual([{ tripId: 't_goa', recipe: 'ixigo.flights', slots: { from: 'DEL', to: 'GOI', date: '2026-11-06', adults: 4 } }]);
    expect(found).toEqual({ results: [OPTION], checkedAt: '2026-10-07T12:00:03.000Z', runId: expect.stringMatching(/^ixigo\.flights\|/) });
    await backend(r).search('stays', { area: 'Vagator', checkIn: '2026-11-06', checkOut: '2026-11-09', guests: 7 }, { tripId: 't_goa' });
    expect(runs[1]).toMatchObject({ recipe: 'ixigo.stays', slots: { adults: 7, rooms: 4 } });
  });

  it("refuses a search without a trip, without the trip's computer, or for a place it has no code for, before anything runs", async () => {
    const { r, runs } = runner();
    await expect(backend(r).search('flights', { from: 'Delhi', to: 'Goa', date: '2026-11-06' })).rejects.toMatchObject({ code: 'refused' });
    await expect(backend(null).search('flights', { from: 'Delhi', to: 'Goa', date: '2026-11-06' }, { tripId: 't_goa' })).rejects.toMatchObject({ code: 'refused', message: expect.stringContaining('not set up') });
    await expect(backend(r).search('buses', { from: 'Pune', to: 'Goa', date: '2026-11-06' }, { tripId: 't_goa' })).rejects.toMatchObject({ code: 'unknown_place' });
    expect(runs).toEqual([]);
  });

  it('keeps a search for ten minutes by recipe and slots, so "Delhi" and "DEL" are one page load, and any trip can use it', async () => {
    const { r, runs } = runner();
    const b = backend(r);
    await b.search('flights', FLIGHTS, { tripId: 't_goa' });
    await b.search('flights', { from: 'DEL', to: 'GOI', date: '2026-11-06' }, { tripId: 't_other' });
    expect(runs).toHaveLength(1);
    // Another head count is another search: it asks ixigo for other adults.
    await b.search('flights', { ...FLIGHTS, guests: 6 }, { tripId: 't_goa' });
    expect(runs).toHaveLength(2);
    nowMs += 10 * 60_000;
    await b.search('flights', FLIGHTS, { tripId: 't_goa' });
    expect(runs).toHaveLength(3);
  });

  it('lets a search join the same one in flight, so an early start and the composer make one page load', async () => {
    const one = runner();
    const b = backend(one.r);
    one.hold();
    const early = b.search('flights', FLIGHTS, { tripId: 't_goa' });
    const composer = b.search('flights', { from: 'New Delhi', to: 'Goa', date: '2026-11-06' }, { tripId: 't_goa' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    one.release();
    expect(await composer).toEqual(await early);
    expect(one.runs).toHaveLength(1);
  });

  it('never keeps a failed search: the next ask runs it again', async () => {
    const failing = runner(true);
    const b = backend(failing.r);
    await expect(b.search('flights', FLIGHTS, { tripId: 't_goa' })).rejects.toMatchObject({ code: 'unreachable' });
    await expect(b.search('flights', FLIGHTS, { tripId: 't_goa' })).rejects.toMatchObject({ code: 'unreachable' });
    expect(failing.runs).toHaveLength(2);
  });

  it('posts one live card per run: the steps go to it, and it is done before the search answers', async () => {
    const events: string[] = [];
    const cards: Array<{ tripId: string; runKey: string; kind: string }> = [];
    const live = (tripId: string, o: { runKey: string; kind: string }) => {
      cards.push({ tripId, runKey: o.runKey, kind: o.kind });
      return { progress: (e: { type: string }) => events.push(e.type), finish: async (ok: boolean) => { events.push(ok ? 'finish:ok' : 'finish:failed'); } };
    };
    const reporting: RecipeRunner = {
      name: 'browser_fetch',
      async run(_t, recipe, _s, o) {
        o?.onProgress?.({ type: 'opening', recipeId: recipe.id, url: 'https://www.ixigo.com/x' });
        o?.onProgress?.({ type: 'captured', ms: 2_100 });
        return { options: [OPTION], checkedAt: '2026-10-07T12:00:03.000Z', ms: 2_100 };
      },
    };
    const b = createIxigoWebBackend({ runner: () => reporting, peopleOf: async () => 4, now: () => new Date(nowMs), live: live as never });
    const first = b.search('flights', FLIGHTS, { tripId: 't_goa' });
    const joined = b.search('flights', FLIGHTS, { tripId: 't_goa' });
    await Promise.all([first, joined]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ tripId: 't_goa', kind: 'flights' });
    expect(cards[0]!.runKey).toBe((await first).runId);
    expect(events).toEqual(['opening', 'captured', 'extracted', 'finish:ok']);
    // A search no turn will try again (a job's, through Go's MCP server) ends its card failed before it answers.
    const failing = createIxigoWebBackend({ runner: () => runner(true).r, peopleOf: async () => 4, now: () => new Date(nowMs), live: live as never });
    events.length = 0;
    await expect(failing.search('flights', FLIGHTS, { tripId: 't_goa' })).rejects.toMatchObject({ code: 'unreachable' });
    expect(events).toEqual(['failed', 'finish:failed']);
  });

  it('runs each recipe on the runner chosen for it', async () => {
    const asked: string[] = [];
    const { r } = runner();
    const b = createIxigoWebBackend({ runner: (recipe) => { asked.push(recipe.id); return r; }, peopleOf: async () => 4, now: () => new Date(nowMs) });
    await b.search('buses', { from: 'Mumbai', to: 'Goa', date: '2026-11-06' }, { tripId: 't_goa' });
    expect(asked).toEqual(['ixigo.buses']);
  });

  it("says how long a search may hold up the turn: 12 s from its start through the browser fetch, none for the agent job", async () => {
    const fetchRunner: RecipeRunner = { ...runner().r, name: 'browser_fetch' };
    const one = runner();
    one.hold();
    const b = createIxigoWebBackend({ runner: () => ({ ...one.r, name: 'browser_fetch' }), peopleOf: async () => 4, now: () => new Date(nowMs), });
    expect(await b.waitMs!('flights', FLIGHTS, { tripId: 't_goa' })).toBe(TRAVEL_WAIT_MS);
    void b.search('flights', FLIGHTS, { tripId: 't_goa' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    nowMs += 5_000;
    expect(await b.waitMs!('flights', FLIGHTS, { tripId: 't_goa' })).toBe(TRAVEL_WAIT_MS - 5_000);
    nowMs += 20_000;
    expect(await b.waitMs!('flights', FLIGHTS, { tripId: 't_goa' })).toBe(0);
    one.release();
    expect(await createIxigoWebBackend({ runner: () => runner().r, peopleOf: async () => 4, now: () => new Date(nowMs) }).waitMs!('flights', FLIGHTS, { tripId: 't_goa' })).toBe(0);
    expect(await createIxigoWebBackend({ runner: () => fetchRunner, peopleOf: async () => 4, now: () => new Date(nowMs) }).waitMs!('flights', FLIGHTS)).toBeNull();
  });

  it("answers a link-only kind with ixigo's page, loading nothing and posting no card", async () => {
    const { r, runs } = runner();
    const cards: string[] = [];
    const b = createIxigoWebBackend({
      runner: () => r, peopleOf: async () => 4, now: () => new Date(nowMs),
      live: ((tripId: string) => { cards.push(tripId); return { progress: () => undefined, finish: async () => undefined }; }) as never,
      linkOnly: (kind) => LINK_ONLY_KINDS.has(kind),
    });
    const err = (await b.search('flights', FLIGHTS, { tripId: 't_goa' }).catch((e: unknown) => e)) as TravelError;
    expect(err).toMatchObject({ code: 'link_only', link: 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026&returnDate=&adults=4&children=0&infants=0&class=e&source=Search%20Form' });
    expect(await b.waitMs!('flights', FLIGHTS, { tripId: 't_goa' })).toBeNull();
    expect(runs).toEqual([]);
    expect(cards).toEqual([]);
    // Other kinds still search.
    await b.search('trains', { from: 'Delhi', to: 'Goa', date: '2026-11-06' }, { tripId: 't_goa' });
    expect(runs).toHaveLength(1);
  });

  it("leaves out of a flight link's adults the members who live by another airport", async () => {
    // Six people, five homes known: Arjun (Bangalore) and Meher (Mumbai) fly from elsewhere; the sixth may fly from Delhi.
    const b = createIxigoWebBackend({
      runner: () => runner().r, peopleOf: async () => 6, homesOf: async () => ['Delhi', 'Delhi', 'Bangalore', 'Mumbai', 'Delhi'],
      now: () => new Date(nowMs), linkOnly: (kind) => LINK_ONLY_KINDS.has(kind),
    });
    const err = (await b.search('flights', FLIGHTS, { tripId: 't_goa' }).catch((e: unknown) => e)) as TravelError;
    expect(err.link).toContain('&adults=4&');
  });

  it('never holds, confirms or reads a status: the group books on ixigo, from the link', async () => {
    const b = backend(runner().r);
    await expect(b.hold('ixigo:x', { name: 'Meher', personIds: ['p_meher'] })).rejects.toBeInstanceOf(TravelError);
    await expect(b.confirm('ixigo:h', { approvalId: 'ap', railRef: 'r' })).rejects.toMatchObject({ code: 'refused', message: expect.stringContaining('booked on ixigo') });
    await expect(b.status({ kind: 'pnr', pnr: '1234567890' })).rejects.toMatchObject({ code: 'refused' });
  });
});

/** A runner whose runs fail or answer in turn; hold() keeps the runs waiting until release(). */
function scripted(...outcomes: Array<'fail' | 'ok'>) {
  let calls = 0;
  let gate: Promise<void> | null = null;
  let open: () => void = () => undefined;
  const r: RecipeRunner = {
    name: 'browser_fetch',
    async run() {
      const outcome = outcomes[calls++] ?? 'ok';
      if (gate) await gate;
      if (outcome === 'fail') throw new TravelError('unreachable', 'ixigo took too long to answer.');
      return { options: [OPTION], checkedAt: '2026-10-07T12:00:30.000Z', ms: 9_000 };
    },
  };
  return {
    r,
    calls: () => calls,
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

/** A backend that records its live cards: how many it made, and each one's steps and ending, as "<card>:<what>". */
function carded(r: RecipeRunner) {
  const events: string[] = [];
  let made = 0;
  const live = () => {
    const n = ++made;
    return {
      progress: (e: { type: string }) => events.push(`${n}:${e.type}`),
      finish: async (ok: boolean) => {
        events.push(`${n}:finish:${ok ? 'done' : 'failed'}`);
      },
    };
  };
  const b = createIxigoWebBackend({ runner: () => r, peopleOf: async () => 4, now: () => new Date(nowMs), live: live as never });
  return { b, events, made: () => made };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const EARLY = { tripId: 't_goa', messageId: 'm_41' };
const COMPOSER = { tripId: 't_goa', turnId: 'turn_1' };

describe("a live card belongs to its search's turn", () => {
  it("keeps a failed early start's card open, and the composer's search in that turn carries on in it: one card, done once", async () => {
    const c = carded(scripted('fail', 'ok').r);
    await expect(c.b.search('trains', TRAINS, EARLY)).rejects.toMatchObject({ code: 'unreachable' });
    expect(c.events).toEqual([]);
    await c.b.search('trains', TRAINS, COMPOSER);
    c.b.turnEnded({ tripId: 't_goa', turnId: 'turn_1', messageIds: ['m_41'] });
    expect(c.made()).toBe(1);
    expect(c.events).toEqual(['1:extracted', '1:finish:done']);
  });

  it("ends the card failed at once when the composer's own search fails, before that search answers", async () => {
    const c = carded(scripted('fail', 'fail').r);
    await expect(c.b.search('trains', TRAINS, EARLY)).rejects.toThrow();
    await c.b.search('trains', TRAINS, COMPOSER).catch(() => c.events.push('answered'));
    expect(c.made()).toBe(1);
    expect(c.events).toEqual(['1:failed', '1:finish:failed', 'answered']);
  });

  it('ends the card a turn left open when the turn ends: failed, once, and only for that trip and its messages', async () => {
    const c = carded(scripted('fail').r);
    await expect(c.b.search('trains', TRAINS, EARLY)).rejects.toThrow();
    c.b.turnEnded({ tripId: 't_other', turnId: 'turn_9', messageIds: ['m_41'] });
    c.b.turnEnded({ tripId: 't_goa', turnId: 'turn_2', messageIds: ['m_42'] });
    expect(c.events).toEqual([]);
    c.b.turnEnded({ tripId: 't_goa', turnId: 'turn_1', messageIds: ['m_41'] });
    c.b.turnEnded({ tripId: 't_goa', turnId: 'turn_1', messageIds: ['m_41'] });
    expect(c.events).toEqual(['1:failed', '1:finish:failed']);
  });

  it('never reopens an ended card: the same ask afterwards gets a card of its own', async () => {
    const c = carded(scripted('fail', 'ok').r);
    await expect(c.b.search('trains', TRAINS, EARLY)).rejects.toThrow();
    c.b.turnEnded({ tripId: 't_goa', turnId: 'turn_1', messageIds: ['m_41'] });
    await c.b.search('trains', TRAINS, { tripId: 't_goa', messageId: 'm_44' });
    expect(c.made()).toBe(2);
    expect(c.events).toEqual(['1:failed', '1:finish:failed', '2:extracted', '2:finish:done']);
  });

  it('lets a search still running when its turn ends keep its card, which its run ends', async () => {
    const ok = scripted('ok');
    const c = carded(ok.r);
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
    const c = carded(failing.r);
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
    const c = carded(failing.r);
    failing.hold();
    const early = c.b.search('trains', TRAINS, EARLY).catch(() => 'early failed');
    const composer = c.b.search('trains', TRAINS, COMPOSER).catch(() => 'composer failed');
    await tick();
    failing.release();
    expect(await Promise.all([early, composer])).toEqual(['early failed', 'composer failed']);
    expect(failing.calls()).toBe(1);
    expect(c.made()).toBe(1);
    expect(c.events).toEqual(['1:failed', '1:finish:failed']);
  });
});
