import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TravelError } from '../../mcp-travel.js';
import { forgetLearnedPlaces } from '../../recipes/places.js';
import type { Capture, FetchPlan } from '../../recipes/recipe.js';
import { createBrowserFetchRunner } from '../../recipes/runners.js';
import { capture, fixture } from '../../recipes/__tests__/fixtures.js';
import { BOOK_DIR, checkRecipe, loadBook } from '../book.js';
import { createEngine, type EngineAnswer } from '../engine.js';
import type { RunEvent } from '../run-event.js';

afterEach(() => forgetLearnedPlaces());

const { book, problems } = loadBook();
const WAYS = 'trip.how_we_get_there';
/** Three of the group live in Delhi (one wrote it "delhi "), one in Mumbai, one in Goa itself. */
const HOMES = ['Delhi', 'Delhi', 'Mumbai', 'delhi ', 'Goa'];
const trip = { people: 5, homes: HOMES, destination: 'Goa', start: '2026-11-06' };

/** The results pages as a box's browser keeps their calls: Goa's trains from Delhi and Mumbai, Goa's buses from Mumbai. */
function pageFor(url: string): Capture[] | null {
  const trains = (name: string, from: string) => [
    capture('/trains/v1/search/between/', `https://www.ixigo.com/trains/v1/search/between/${from}/MAO?date=2026-11-06&languageCode=en`, fixture(`trains-${name}-between.json`)),
  ];
  if (url.includes('/search/result/train/NDLS/MAO/06112026')) return trains('ndls-mao', 'NDLS');
  if (url.includes('/search/result/train/CSMT/MAO/06112026')) return trains('csmt-mao', 'CSMT');
  if (url.includes('/buses/bus_search/Mumbai/4/Goa/102/06-11-2026')) return [capture('/buslist/v3/services$', 'https://www.ixigo.com/buslist/v3/services', fixture('buses-mumbai-goa.json'))];
  return null;
}

const stepsOf = (got: EngineAnswer) => {
  if (got.as !== 'compare') throw new Error(`answered ${got.as}`);
  return got.entries.map((e) => ({ entry: e.entry, steps: e.steps.map((s) => [s.recipe, s.answer?.as ?? s.why]) }));
};

describe('a composite: the same recipes for each entry of a list, at once', () => {
  it('is in the book: trip.how_we_get_there runs trains, buses and flights for each home city', () => {
    expect(problems).toEqual([]);
    expect(book.get(WAYS)?.steps?.run.map((s) => s.recipe)).toEqual(['trains.between', 'buses.between', 'flights.search']);
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
      { entry: 'Delhi', steps: [['trains.between', 'options'], ['buses.between', expect.stringMatching(/^unreachable/)], ['flights.search', 'link']] },
      { entry: 'Mumbai', steps: [['trains.between', 'options'], ['buses.between', 'options'], ['flights.search', 'link']] },
    ]);
    if (got.as !== 'compare') return;
    expect(got.inputs).toEqual({ to: 'Goa', date: '2026-11-06' });
    // Flights are a link, set for the people from that city: three from Delhi, one from Mumbai.
    const link = (i: number) => {
      const a = got.entries[i]!.steps[2]!.answer;
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
      'Delhi trains.between', 'Delhi buses.between', 'Delhi flights.search', 'Mumbai trains.between', 'Mumbai buses.between', 'Mumbai flights.search',
    ]);
    const lastStart = Math.max(...steps.map((s) => events.indexOf(s)));
    const firstEnd = events.findIndex((e) => e.type === 'run_end');
    expect(lastStart).toBeLessThan(firstEnd);
    // Delhi's bus lookup sits under Delhi's buses, as any lookup does.
    const delhiBuses = steps.find((e) => e.lane === 'Delhi' && e.recipe_id === 'buses.between')!;
    expect(starts.find((e) => e.recipe_id === 'buses.city_lookup')).toMatchObject({ parent: delhiBuses.run_id });
    // The composite ends last, with the steps that answered.
    expect(events.at(-1)).toMatchObject({ type: 'run_end', run_id: composite.run_id, ok: true, rows: 5 });
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
        v1, computer: { userIdFor: (t) => `u-${t}`, ensureUser: async (t) => `u-${t}` }, now: () => new Date(), log: { warn: () => undefined }, slots: () => slots,
      });
      const engine = createEngine({ book, runner: () => runner, trip: async () => trip, now: () => new Date('2026-10-08T12:00:00Z') });
      await engine.answer(WAYS, {}, { tripId: 't_goa' });
      return top;
    };
    // Four pages: each city's trains, Mumbai's buses, and Delhi's bus box. Flights load nothing.
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
    expect(stepsOf(await going)).toEqual([{ entry: 'Mumbai', steps: [['trains.between', 'options'], ['buses.between', 'out of time'], ['flights.search', 'link']] }]);
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
