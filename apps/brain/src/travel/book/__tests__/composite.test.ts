import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TravelError } from '../../mcp-travel.js';
import { forgetLearnedPlaces } from '../../recipes/places.js';
import type { Capture, FetchPlan } from '../../recipes/recipe.js';
import { createIxigoWebBackend } from '../../recipes/backend.js';
import { createBrowserFetchRunner } from '../../recipes/runners.js';
import { capture, fixture } from '../../recipes/__tests__/fixtures.js';
import { BOOK_DIR, checkRecipe, loadBook } from '../book.js';
import { createEngine, type EngineAnswer, type StepsEvent } from '../engine.js';
import type { RunEvent } from '../run-event.js';

afterEach(() => forgetLearnedPlaces());

const { book, problems } = loadBook();
const WAYS = 'trip.how_we_get_there';
/** Three of the group live in Delhi (one wrote it "delhi "), one in Mumbai, one in Goa itself. */
const HOMES = ['Delhi', 'Delhi', 'Mumbai', 'delhi ', 'Goa'];
const trip = { people: 5, homes: HOMES, destination: 'Goa', start: '2026-11-06' };

/**
 * The results pages as a box's browser keeps their calls: Goa's trains from Delhi and Mumbai, Goa's buses from Mumbai, and
 * flights from either (ixigo's stream, read on staging 9 Oct).
 */
function pageFor(url: string): Capture[] | null {
  const trains = (name: string, from: string) => [
    capture('/trains/v1/search/between/', `https://www.ixigo.com/trains/v1/search/between/${from}/MAO?date=2026-11-06&languageCode=en`, fixture(`trains-${name}-between.json`)),
  ];
  if (url.includes('/search/result/train/NDLS/MAO/06112026')) return trains('ndls-mao', 'NDLS');
  if (url.includes('/search/result/train/CSMT/MAO/06112026')) return trains('csmt-mao', 'CSMT');
  if (url.includes('/buses/bus_search/Mumbai/4/Goa/102/06-11-2026')) return [capture('/buslist/v3/services$', 'https://www.ixigo.com/buslist/v3/services', fixture('buses-mumbai-goa.json'))];
  if (/\/search\/result\/flight\?from=(DEL|BOM)&to=GOI&date=06112026&/.test(url)) {
    return [capture('/flights/v2/search/stream', 'https://www.ixigo.com/flights/v2/search/stream', fixture('flights-del-goi-2026-11-13.sse'))];
  }
  return null;
}

/** Each city's flights page: its answer, or why it has none. */
const flightsOf = (got: EngineAnswer): string[] => (got.as === 'compare' ? got.entries.map((e) => e.steps[2]!.answer?.as ?? e.steps[2]!.why ?? '') : []);

const stepsOf = (got: EngineAnswer) => {
  if (got.as !== 'compare') throw new Error(`answered ${got.as}`);
  return got.entries.map((e) => ({ entry: e.entry, steps: e.steps.map((s) => [s.recipe, s.answer?.as ?? s.why]) }));
};

describe('a composite: the same recipes for each entry of a list, at once', () => {
  it("is in the book: trip.how_we_get_there runs trains, buses, flights and flights' link for each home city", () => {
    expect(problems).toEqual([]);
    expect(book.get(WAYS)?.steps?.run.map((s) => s.recipe)).toEqual(['trains.between', 'buses.between', 'flights.results', 'flights.search']);
  });

  it("runs each home city once, the most people's first and the trip's own place left out, and answers each step's answer or why", async () => {
    const events: RunEvent[] = [];
    const opened: string[] = [];
    const runner = {
      read: async (_trip: string, url: string, _plan: FetchPlan) => {
        opened.push(url);
        const caps = pageFor(url);
        // Delhi's buses need ixigo's box, which doesn't answer here.
        if (!caps) throw new TravelError('unreachable', 'ixigo took too long to answer. Try again in a moment.');
        return { captures: caps, finalUrl: url };
      },
    };
    const engine = createEngine({ book, runner: () => runner, trip: async () => trip, now: () => new Date('2026-10-08T12:00:00Z'), onRun: (_t, e) => events.push(e) });
    const got = await engine.answer(WAYS, {}, { tripId: 't_goa' });
    expect(stepsOf(got)).toEqual([
      { entry: 'Delhi', steps: [['trains.between', 'options'], ['buses.between', expect.stringMatching(/^unreachable/)], ['flights.results', expect.any(String)], ['flights.search', 'link']] },
      { entry: 'Mumbai', steps: [['trains.between', 'options'], ['buses.between', 'options'], ['flights.results', expect.any(String)], ['flights.search', 'link']] },
    ]);
    // One flights page across every trip in 20 s: one city's flights come back, the other's are held back (its link stands).
    expect(flightsOf(got).filter((a) => a === 'options')).toHaveLength(1);
    expect(flightsOf(got).find((a) => a !== 'options')).toMatch(/^unreachable: ixigo is given a moment between flights/);
    expect(opened.filter((u) => u.includes('/search/result/flight?'))).toHaveLength(1);
    if (got.as !== 'compare') return;
    expect(got.inputs).toEqual({ to: 'Goa', date: '2026-11-06' });
    // Flights' link is set for the people from that city: three from Delhi, one from Mumbai.
    const link = (i: number) => {
      const a = got.entries[i]!.steps[3]!.answer;
      return a?.as === 'link' ? a.link : '';
    };
    expect(link(0)).toContain('from=DEL&to=GOI&date=06112026&returnDate=&adults=3&');
    expect(link(1)).toContain('from=BOM&to=GOI&date=06112026&returnDate=&adults=1&');
    // The run strip: the composite, then every step at once, each naming it (step_of) and its city (lane), before any ends.
    const starts = events.filter((e): e is Extract<RunEvent, { type: 'run_start' }> => e.type === 'run_start');
    const composite = starts[0]!;
    expect(composite).toMatchObject({ recipe_id: WAYS, speed: 'steps', label: 'Delhi, Mumbai · 6 Nov' });
    const steps = starts.filter((e) => e.step_of === composite.run_id);
    expect(steps.map((e) => `${e.lane} ${e.recipe_id}`)).toEqual([
      'Delhi trains.between', 'Delhi buses.between', 'Delhi flights.results', 'Delhi flights.search',
      'Mumbai trains.between', 'Mumbai buses.between', 'Mumbai flights.results', 'Mumbai flights.search',
    ]);
    const lastStart = Math.max(...steps.map((s) => events.indexOf(s)));
    const firstEnd = events.findIndex((e) => e.type === 'run_end');
    expect(lastStart).toBeLessThan(firstEnd);
    // Delhi's bus lookup sits under Delhi's buses, as any lookup does.
    const delhiBuses = steps.find((e) => e.lane === 'Delhi' && e.recipe_id === 'buses.between')!;
    expect(starts.find((e) => e.recipe_id === 'buses.city_lookup')).toMatchObject({ parent: delhiBuses.run_id });
    // The composite ends last, with the steps that answered.
    expect(events.at(-1)).toMatchObject({ type: 'run_end', run_id: composite.run_id, ok: true, rows: 6 });
  });

  // The room's live view shows the comparison: its first city's first step (most people's trains) reads on the stage,
  // the rest behind, as many at once would fight over one stage (10 Oct, Jev and stage review, gap 3).
  it("reads the first city's first step on the stage, and every other step behind", async () => {
    const reads: string[] = [];
    const runner = {
      read: async (_trip: string, url: string, _plan: FetchPlan, o?: { stage?: boolean }) => {
        reads.push(`${url.includes('/train/NDLS/') ? 'Delhi trains' : url.includes('/train/CSMT/') ? 'Mumbai trains' : url.includes('/bus_search/') ? 'buses' : url.includes('/flight?') ? 'flights' : 'box'}${o?.stage ? ' (stage)' : ''}`);
        return { captures: pageFor(url) ?? [], finalUrl: url };
      },
    };
    const engine = createEngine({ book, runner: () => runner, trip: async () => trip, now: () => new Date('2026-10-08T12:00:00Z') });
    await engine.answer(WAYS, {}, { tripId: 't_goa' });
    expect(reads.filter((r) => r.endsWith('(stage)'))).toEqual(['Delhi trains (stage)']);
    expect(reads).toContain('Mumbai trains');
  });

  it("puts every city's trains ahead of its buses in the computer's queue, and tells each step as it ends", async () => {
    const asked = new Set<string>();
    const said: StepsEvent[] = [];
    const runner = {
      read: async (_trip: string, url: string, _plan: FetchPlan, o?: { priority?: number }) => {
        asked.add(`${url.includes('/train/') ? 'train page' : url.includes('/bus_search/') ? 'bus page' : url.includes('/flight?') ? 'flight page' : 'bus box'} ${o?.priority}`);
        return { captures: pageFor(url) ?? [], finalUrl: url };
      },
    };
    const engine = createEngine({ book, runner: () => runner, trip: async () => trip, now: () => new Date('2026-10-08T12:00:00Z') });
    await engine.answer(WAYS, {}, { tripId: 't_goa', onSteps: (e) => said.push(e) });
    // Trains are the file's first step: priority 0. A city's buses, their page and ixigo's box alike, come after; flights after them.
    expect([...asked].sort()).toEqual(['bus box 1', 'bus page 1', 'flight page 2', 'train page 0']);
    expect(said[0]).toEqual({ type: 'entries', entries: ['Delhi', 'Mumbai'] });
    const told = said.slice(1).map((e) => (e.type === 'step' ? `${e.entry} ${e.recipe} ${e.ok}` : e.type));
    expect(told.filter((t) => !t.includes('flights.results')).sort()).toEqual([
      'Delhi buses.between false', 'Delhi flights.search true', 'Delhi trains.between true',
      'Mumbai buses.between true', 'Mumbai flights.search true', 'Mumbai trains.between true',
    ]);
    // One city's flights page loads; the other's is held back.
    expect(told.filter((t) => t.includes('flights.results')).map((t) => t.endsWith('true')).sort()).toEqual([false, true]);
  });

  // p0's golden run, 10 Oct: the flights page skipped by Go's own spacing, and flights dropped from the card.
  it("waits out a flights page held back by Go's spacing, inside the composite's time, and asks once more", async () => {
    let nowMs = Date.parse('2026-10-08T12:00:00Z');
    const opened: string[] = [];
    const runner = {
      read: async (_trip: string, url: string, _plan: FetchPlan) => {
        opened.push(url);
        return { captures: pageFor(url) ?? [], finalUrl: url };
      },
    };
    const waits: number[] = [];
    const engine = createEngine({
      book, runner: () => runner, trip: async () => trip, now: () => new Date(nowMs),
      sleep: async (ms) => {
        waits.push(ms);
        nowMs += ms;
      },
    });
    const got = await engine.answer(WAYS, {}, { tripId: 't_goa', signal: new AbortController().signal });
    // Both cities' flights come back: the second after the 20 s gap, asked once more.
    expect(flightsOf(got)).toEqual(['options', 'options']);
    expect(opened.filter((u) => u.includes('/search/result/flight?'))).toHaveLength(2);
    expect(waits).toEqual([20_500]);
  });

  // The exam, 10 Oct (#23, #25): four cities' flights, one page a 20 s gap across every trip; three fell back to links in
  // 2 to 21 ms. Each person's flights (trip.flights_each) wait their turn as often as it takes, so every city's come back.
  it("waits its turn as often as it takes for each person's flights: four cities, four flights pages, each after the gap", async () => {
    let nowMs = Date.parse('2026-10-08T12:00:00Z');
    const opened: string[] = [];
    const runner = {
      read: async (_trip: string, url: string, _plan: FetchPlan) => {
        opened.push(url);
        const flights = /\/search\/result\/flight\?from=(DEL|BOM|BLR|PNQ)&to=GOI&date=06112026&/.test(url);
        return { captures: flights ? [capture('/flights/v2/search/stream', 'https://www.ixigo.com/flights/v2/search/stream', fixture('flights-del-goi-2026-11-13.sse'))] : [], finalUrl: url };
      },
    };
    const waits: number[] = [];
    const engine = createEngine({
      book, runner: () => runner, now: () => new Date(nowMs),
      trip: async () => ({ people: 4, homes: ['Delhi', 'Mumbai', 'Bengaluru', 'Pune'], destination: 'Goa', start: '2026-11-06' }),
      sleep: async (ms) => {
        waits.push(ms);
        nowMs += ms;
      },
    });
    const got = await engine.answer('trip.flights_each', {}, { tripId: 't_goa', signal: new AbortController().signal, waitOutPace: true });
    if (got.as !== 'compare') throw new Error(got.as);
    expect(got.entries.map((e) => [e.entry, e.steps[0]!.answer?.as ?? e.steps[0]!.why])).toEqual([
      ['Delhi', 'options'], ['Mumbai', 'options'], ['Bengaluru', 'options'], ['Pune', 'options'],
    ]);
    expect(opened.filter((u) => u.includes('/search/result/flight?'))).toHaveLength(4);
    // Each wait is the pacer's own gap: a city that missed its turn to another waits again rather than giving up.
    expect(waits.length).toBeGreaterThanOrEqual(1);
    expect(waits.every((w) => w >= 20_000)).toBe(true);
  });

  // p2's re-audit of Keshav's Varkala trip (11 Oct): "Book my flights" read every member's city for one person.
  it("reads one home city alone when from names it: one person's own flights, never every city's page", async () => {
    const opened: string[] = [];
    const runner = {
      read: async (_trip: string, url: string, _plan: FetchPlan) => {
        opened.push(url);
        return { captures: url.includes('/search/result/flight?') ? [capture('/flights/v2/search/stream', 'https://www.ixigo.com/flights/v2/search/stream', fixture('flights-del-goi-2026-11-13.sse'))] : [], finalUrl: url };
      },
    };
    const engine = createEngine({
      book, runner: () => runner, now: () => new Date('2026-10-08T12:00:00Z'),
      trip: async () => ({ people: 4, homes: ['Delhi', 'Mumbai', 'Bengaluru', 'Pune'], destination: 'Goa', start: '2026-11-06' }),
      sleep: async () => undefined,
    });
    const got = await engine.answer('trip.flights_each', { from: 'Mumbai' }, { tripId: 't_goa', signal: new AbortController().signal, waitOutPace: true });
    if (got.as !== 'compare') throw new Error(got.as);
    expect(got.entries.map((e) => e.entry)).toEqual(['Mumbai']);
    expect(opened.filter((u) => u.includes('/search/result/flight?'))).toEqual([expect.stringContaining('from=BOM&to=GOI')]);
  });

  // The same run: three cities' bus pages at once from one address, while ixigo was asking for Cloudflare's check.
  it('opens at most two pages of one recipe at once, the rest waiting their turn', async () => {
    let open = 0;
    let most = 0;
    const trains: string[] = [];
    const runner = {
      read: async (_trip: string, url: string, _plan: FetchPlan) => {
        if (!url.includes('/search/result/train/')) return { captures: pageFor(url) ?? [], finalUrl: url };
        trains.push(url);
        open += 1;
        most = Math.max(most, open);
        await new Promise((r) => setTimeout(r, 20));
        open -= 1;
        return { captures: pageFor(url) ?? [], finalUrl: url };
      },
    };
    const engine = createEngine({ book, runner: () => runner, trip: async () => ({ ...trip, homes: ['Delhi', 'Mumbai', 'Bangalore'] }), now: () => new Date('2026-10-08T12:00:00Z') });
    await engine.answer(WAYS, {}, { tripId: 't_goa' });
    expect(trains).toHaveLength(3);
    expect(most).toBe(2);
  });

  it('puts a check nobody waits on (a watch) behind every search a person is waiting on, even one that came after it', async () => {
    const asked: string[] = [];
    const ends: Array<() => void> = [];
    const v1 = {
      async call<T>(_m: string, _p: string, o: { body?: { url?: string } } = {}): Promise<T> {
        const url = o.body?.url ?? '';
        asked.push(/\/(\d\d)-11-2026\//.exec(url)?.[1] ?? url);
        await new Promise<void>((r) => ends.push(r));
        return { final_url: url, elapsed_ms: 900, woke: false, captures: pageFor(url) ?? [] } as T;
      },
    };
    const runner = createBrowserFetchRunner({
      v1, browser: { userFor: async (t) => `u-${t}`, again: async (t) => `u-${t}` }, now: () => new Date(), log: { warn: () => undefined }, slots: () => 1,
    });
    const engine = createEngine({ book, runner: () => runner, trip: async () => trip, now: () => new Date('2026-10-08T12:00:00Z') });
    const settle = (): Promise<void> => new Promise((r) => setImmediate(r));
    const buses = (date: string, background = false) =>
      engine.answer('buses.between', { from: 'Mumbai', to: 'Goa', date }, { tripId: 't_goa', ...(background ? { background } : {}) }).catch(() => undefined);
    const runs = [buses('2026-11-06')];
    await settle();
    runs.push(buses('2026-11-07', true));
    await settle();
    runs.push(buses('2026-11-08'));
    while (asked.length < 3 || ends.length > 0) {
      await settle();
      ends.shift()?.();
    }
    await Promise.all(runs);
    expect(asked).toEqual(['06', '08', '07']);
  });

  it("asks the trip's computer for no more pages at once than its slots: the rest wait their turn", async () => {
    const most = async (slots: number): Promise<number> => {
      let going = 0;
      let top = 0;
      const v1 = {
        async call<T>(_m: string, _p: string, o: { body?: { url?: string } } = {}): Promise<T> {
          going += 1;
          top = Math.max(top, going);
          await new Promise((r) => setImmediate(r));
          going -= 1;
          const url = o.body?.url ?? '';
          return { final_url: url, elapsed_ms: 900, woke: false, captures: pageFor(url) ?? [] } as T;
        },
      };
      const runner = createBrowserFetchRunner({
        v1, browser: { userFor: async (t) => `u-${t}`, again: async (t) => `u-${t}` }, now: () => new Date(), log: { warn: () => undefined }, slots: () => slots,
      });
      const engine = createEngine({ book, runner: () => runner, trip: async () => trip, now: () => new Date('2026-10-08T12:00:00Z') });
      await engine.answer(WAYS, {}, { tripId: 't_goa' });
      return top;
    };
    // Five pages: each city's trains, Mumbai's buses, Delhi's bus box, and one city's flights (one flights page in 20 s).
    expect(await most(2)).toBe(2);
    expect(await most(4)).toBe(4);
  });

  it("needs the trip's day and someone's home city, and takes another day when the ask names one", async () => {
    const opened: string[] = [];
    const runner = {
      read: async (_trip: string, url: string) => {
        opened.push(url);
        return { captures: pageFor(url) ?? [], finalUrl: url };
      },
    };
    const engineOf = (t: typeof trip | { people: number; homes: string[]; destination: string | null; start: string | null }) =>
      createEngine({ book, runner: () => runner, trip: async () => t, now: () => new Date('2026-10-08T12:00:00Z') });
    await expect(engineOf({ ...trip, start: null }).answer(WAYS, {}, { tripId: 't_goa' })).rejects.toMatchObject({ code: 'needs_more', message: expect.stringContaining('the day everyone travels') });
    await expect(engineOf({ ...trip, homes: ['Goa'] }).answer(WAYS, {}, { tripId: 't_goa' })).rejects.toMatchObject({ code: 'needs_more', message: expect.stringContaining('no home to run for') });
    expect(opened).toEqual([]);
    await engineOf({ ...trip, homes: ['Mumbai'] }).answer(WAYS, { date: '2026-11-07' }, { tripId: 't_goa' });
    expect(opened.some((u) => u.includes('/search/result/train/CSMT/MAO/07112026'))).toBe(true);
  });

  it('ends the steps still going when its signal says time is up, and answers why for them', async () => {
    const stop = new AbortController();
    const runner = {
      read: (_trip: string, url: string, _plan: FetchPlan, o?: { signal?: AbortSignal }) =>
        url.includes('/train/')
          ? Promise.resolve({ captures: pageFor(url) ?? [], finalUrl: url })
          : new Promise<never>((_, reject) => o?.signal?.addEventListener('abort', () => reject(o.signal!.reason))),
    };
    const engine = createEngine({ book, runner: () => runner, trip: async () => ({ ...trip, homes: ['Mumbai'] }), now: () => new Date('2026-10-08T12:00:00Z') });
    const going = engine.answer(WAYS, {}, { tripId: 't_goa', signal: stop.signal });
    await new Promise((r) => setImmediate(r));
    stop.abort();
    expect(stepsOf(await going)).toEqual([{ entry: 'Mumbai', steps: [['trains.between', 'options'], ['buses.between', 'out of time'], ['flights.results', 'out of time'], ['flights.search', 'link']] }]);
  });
});

describe("a composite's steps share Go's searches, keyed by the request they make", () => {
  const BUSES = { from: 'Mumbai', to: 'Goa', date: '2026-11-06' };
  const settle = (): Promise<void> => new Promise((r) => setImmediate(r));
  const pages = (opened: string[], kind: 'bus_search' | 'train') => opened.filter((u) => u.includes(kind === 'train' ? '/search/result/train/' : '/buses/bus_search/'));

  /** The engine and the search backend wired as Go wires them, on a browser that notes each page it opens. */
  function wired(o: { hold?: boolean } = {}) {
    const opened: string[] = [];
    const events: RunEvent[] = [];
    let open: () => void = () => undefined;
    const gate = o.hold ? new Promise<void>((r) => (open = r)) : null;
    const runner = {
      read: async (_trip: string, url: string) => {
        opened.push(url);
        if (gate) await gate;
        return { captures: pageFor(url) ?? [], finalUrl: url };
      },
    };
    const now = () => new Date('2026-10-08T12:00:00Z');
    const engine = createEngine({
      book, runner: () => runner, trip: async () => ({ ...trip, homes: ['Mumbai'] }), now, onRun: (_t, e) => events.push(e),
      searches: (id, given, ro, run) => backend.shareStep(id, given, ro, run),
    });
    const backend = createIxigoWebBackend({ book, engine, now });
    return { engine, backend, opened, events, release: () => open() };
  }

  it('the same city asked alone, then in the composite, gives one load: the step takes the kept search', async () => {
    const w = wired();
    const alone = await w.backend.search('buses', BUSES, { tripId: 't_goa' });
    expect(alone.results.length).toBeGreaterThan(0);
    const got = await w.engine.answer(WAYS, {}, { tripId: 't_goa' });
    expect(stepsOf(got)).toEqual([{ entry: 'Mumbai', steps: [['trains.between', 'options'], ['buses.between', 'options'], ['flights.results', 'options'], ['flights.search', 'link']] }]);
    expect(pages(w.opened, 'bus_search')).toHaveLength(1);
    // The same options, and on the strip the step is a kept run in its lane.
    if (got.as === 'compare') expect(got.entries[0]!.steps[1]!.answer).toMatchObject({ as: 'options', options: alone.results });
    expect(w.events.find((e) => e.type === 'run_start' && e.recipe_id === 'buses.between' && e.step_of)).toMatchObject({ speed: 'kept', lane: 'Mumbai' });
  });

  it("and the other way: a step's own search is kept, so the city asked alone after it loads nothing", async () => {
    const w = wired();
    await w.engine.answer(WAYS, {}, { tripId: 't_goa' });
    await w.backend.search('trains', BUSES, { tripId: 't_goa' });
    await w.backend.search('buses', BUSES, { tripId: 't_goa' });
    expect([pages(w.opened, 'train'), pages(w.opened, 'bus_search')].map((p) => p.length)).toEqual([1, 1]);
  });

  it("a step the composite's time cuts short still finishes and is kept: the city asked alone a moment later loads nothing", async () => {
    const w = wired({ hold: true });
    const stop = new AbortController();
    const composite = w.engine.answer(WAYS, {}, { tripId: 't_goa', signal: stop.signal });
    await settle();
    stop.abort();
    expect(stepsOf(await composite)).toEqual([{ entry: 'Mumbai', steps: [['trains.between', 'out of time'], ['buses.between', 'out of time'], ['flights.results', 'out of time'], ['flights.search', 'link']] }]);
    w.release();
    await settle();
    await w.backend.search('buses', BUSES, { tripId: 't_goa' });
    expect(pages(w.opened, 'bus_search')).toHaveLength(1);
  });

  it('a step that asks what a search still running asks joins it: one page for both', async () => {
    const w = wired({ hold: true });
    const alone = w.backend.search('buses', BUSES, { tripId: 't_goa' });
    await settle();
    const composite = w.engine.answer(WAYS, {}, { tripId: 't_goa' });
    await settle();
    w.release();
    await Promise.all([alone, composite]);
    expect(pages(w.opened, 'bus_search')).toHaveLength(1);
  });
});

describe('the book checks a composite', () => {
  const LINK = `id: test.link\ntitle: A link\nasks: [a link]\ninputs:\n  from: { kind: text }\npage: /trains\nanswer: { as: link, title: A link }\n`;
  /** A lookup, as a step might name it: ixigo's bus box, under another id. */
  const LOOKUP = readFileSync(`${BOOK_DIR}buses/city_lookup.yaml`, 'utf8').replace('id: buses.city_lookup', 'id: test.lookup');
  const composite = (id: string, steps: string) =>
    `id: ${id}\ntitle: A composite\nasks: [all of them]\nsteps:\n  each: "['a', 'b']"\n  as: entry\n  run:\n${steps}answer: { as: compare }\n`;

  it('refuses to run a composite that says it changes something on ixigo, whatever the book let in', async () => {
    const file = composite('trip.how_we_get_there', '    - { recipe: trains.between, given: { from: $entry } }\n').replace('answer:', 'changes_state: true\nanswer:');
    const checked = checkRecipe('trip/how_we_get_there.yaml', file);
    if (!('recipe' in checked)) throw new Error(checked.problems.join());
    const locked = { get: (id: string) => (id === WAYS ? checked.recipe : book.get(id)), all: () => book.all() };
    const read = async (): Promise<never> => {
      throw new Error('nothing opens');
    };
    const engine = createEngine({ book: locked, runner: () => ({ read }), trip: async () => trip, now: () => new Date('2026-10-08T12:00:00Z') });
    await expect(engine.answer(WAYS, {}, { tripId: 't_goa' })).rejects.toMatchObject({ code: 'refused', message: expect.stringContaining('runs only after the group says yes') });
  });

  it('opens nothing itself, and only a composite answers compare', () => {
    const page = checkRecipe('test/c.yaml', composite('test.c', '    - { recipe: test.link, given: { from: $entry } }\n').replace('answer:', 'page: /trains\nanswer:'));
    expect('problems' in page && page.problems.join()).toMatch(/opens nothing/);
    const bare = checkRecipe('test/c.yaml', LINK.replace('id: test.link', 'id: test.c').replace('{ as: link, title: A link }', '{ as: compare }'));
    expect('problems' in bare && bare.problems.join()).toMatch(/a composite has steps and answers compare/);
  });

  it('leaves out a composite whose step is not in the book, changes something on ixigo, is a lookup or a composite, or is given an input it lacks or not one it needs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-'));
    mkdirSync(join(dir, 'test'));
    const files: Record<string, string> = {
      'link.yaml': LINK,
      'lock.yaml': LINK.replace('id: test.link', 'id: test.lock').replace('page:', 'changes_state: true\npage:'),
      'lookup.yaml': LOOKUP,
      'good.yaml': composite('test.good', '    - { recipe: test.link, given: { from: $entry } }\n'),
      'missing.yaml': composite('test.missing', '    - { recipe: test.nowhere, given: { from: $entry } }\n'),
      'nested.yaml': composite('test.nested', '    - { recipe: test.good, given: {} }\n'),
      'paying.yaml': composite('test.paying', '    - { recipe: test.lock, given: { from: $entry } }\n'),
      'typo.yaml': composite('test.typo', '    - { recipe: test.link, given: { form: $entry } }\n'),
      'short.yaml': composite('test.short', '    - { recipe: test.link, given: {} }\n'),
      'boxed.yaml': composite('test.boxed', '    - { recipe: test.lookup, given: {} }\n'),
    };
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, 'test', name), text);
    const loaded = loadBook(dir);
    expect(loaded.book.all().map((r) => r.id).sort()).toEqual(['test.good', 'test.link', 'test.lock', 'test.lookup']);
    expect(loaded.problems.sort()).toEqual([
      'test.boxed: a step runs test.lookup, which is a lookup',
      'test.missing: a step runs test.nowhere, which is not in the book',
      'test.nested: a step runs test.good, which is a composite too',
      'test.paying: a step runs test.lock, which changes something on ixigo',
      'test.short: a step runs test.link, which needs from, and is not given it',
      'test.typo: a step runs test.link, which has no input form',
    ]);
  });
});
