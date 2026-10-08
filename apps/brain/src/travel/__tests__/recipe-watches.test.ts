import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TurnCtx } from '../../composer/tools.js';
import { withSchema } from '../../db/test-db.js';
import { seedTrip } from '../../proactive/fakes.js';
import { ProactiveStore } from '../../proactive/store.js';
import { loadBook } from '../book/book.js';
import type { EngineAnswer, RunFor } from '../book/engine.js';
import { TravelError } from '../mcp-travel.js';
import type { RecipeOption } from '../recipes/recipe.js';
import { createEngine } from '../book/engine.js';
import { createIxigoWebBackend, type IxigoWebBackend } from '../recipes/backend.js';
import type { FetchPlan } from '../recipes/recipe.js';
import { capture, fixture } from '../recipes/__tests__/fixtures.js';
import { createWatchRunner, flipped, startWatch, WATCH_FAILURES, watchesNow } from '../recipe-watches.js';
import { watchTools } from '../watch-tools.js';

const { book } = loadBook();
const START = new Date('2026-10-08T06:00:00Z');
const MIN = 60_000;
const UNTIL = new Date('2026-10-22T18:29:00Z');

let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
});
afterAll(async () => {
  await db.drop();
});

/** ixigo's confirm_chance facts for one train and class. */
const chance = (line: string): EngineAnswer => ({
  as: 'facts', title: 'Bangalore to Chennai, 22 Oct', rows: [{ train: 'Lalbagh Sf Exp 12608', leaves: 'SBC 06:30', arrives: 'MAS 12:15', classes: [line] }],
  page: 'https://www.ixigo.com/trains/search-pwa/from/SBC/to/MAS/22-10-2026', checkedAt: START.toISOString(), ms: 900,
});
const stay = (title: string, rupees: number): RecipeOption => ({
  kind: 'stay', title, priceMinor: rupees * 100, currency: 'INR', priceNote: 'per night', highlights: [], facts: {}, sourceUrl: 'https://www.ixigo.com/hotels/1/details',
});
const stays = (...o: RecipeOption[]): EngineAnswer => ({ as: 'options', options: o, page: 'https://www.ixigo.com/hotels/search/result', checkedAt: START.toISOString(), ms: 2000 });

/** An engine whose answers come in turn; a TravelError in the list is thrown. Every call is kept. */
function engine(...answers: Array<EngineAnswer | TravelError>) {
  const calls: Array<{ id: string; given: Record<string, unknown>; o: RunFor }> = [];
  const answer = async (id: string, given: Record<string, unknown>, o: RunFor): Promise<EngineAnswer> => {
    calls.push({ id, given, o });
    const next = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    if (next instanceof TravelError) throw next;
    return next;
  };
  return { calls, answer, answerShared: answer };
}

const switches = (watches: 'on' | 'off' = 'on') => ({ get: (n: string) => (n === 'RECIPE_WATCHES' ? watches : n === 'TRAVEL_MODE' ? 'ixigo_web' : '') }) as never;

/** A runner on its own clock, its nudges in the real proactive store. */
function runner(e: ReturnType<typeof engine>, o: { cap?: number; watches?: 'on' | 'off' } = {}) {
  const clock = { now: START };
  const store = new ProactiveStore(db.pool);
  const r = createWatchRunner({
    pool: db.pool, book, engine: e, store, switches: switches(o.watches), now: () => clock.now, log: { warn: () => undefined },
    ...(o.cap ? { capPer10Min: o.cap } : {}),
  });
  return { r, clock, at: (ms: number) => { clock.now = new Date(START.getTime() + ms); } };
}

const CONFIRM = { recipe_id: 'trains.confirm_chance', inputs: { from: 'Bangalore', to: 'Chennai', date: '2026-10-22', train: '12608', class: 'CC' }, conditions: [], flip: 'confirms', flip_limit: null, label: "12608's CC to confirm", asked_by: 'p_priya', baseline: null, until: UNTIL };

async function watchRow(id: string) {
  return (await db.pool.query<{ active: boolean; stopped: string | null; fired_at: Date | null; errors: number }>('select active, stopped, fired_at, errors from recipe_watches where watch_id = $1', [id])).rows[0]!;
}
async function nudges(tripId: string) {
  return (await db.pool.query<{ dedupe_key: string; topic: string; asked: boolean; person_ids: string[]; facts: Record<string, unknown> }>(
    'select dedupe_key, topic, asked, person_ids, facts from proactive_candidates where trip_id = $1 order by created_at', [tripId],
  )).rows;
}

describe('a watch the group asked for', () => {
  it('says so exactly once when it comes true, never while it is still waitlisted, and ends there', async () => {
    await seedTrip(db.pool, 't_once');
    await startWatch(db.pool, { ...CONFIRM, watch_id: 'rw_once', trip_id: 't_once' }, START);
    const e = engine(chance('CC: WL 12, 61% chance to confirm, ixigo says Probable'), chance('CC: WL 12, 61% chance to confirm, ixigo says Probable'), chance('CC: Available 4'));
    const w = runner(e);
    // Not due yet: nothing loads.
    expect(await w.r.tick()).toBe(0);
    expect(e.calls).toHaveLength(0);
    w.at(61 * MIN);
    expect(await w.r.tick()).toBe(0);
    w.at(122 * MIN);
    expect(await w.r.tick()).toBe(0);
    // Still waitlisted twice: no nudge. The checks run in the background: no warm, no tab kept.
    expect(await nudges('t_once')).toEqual([]);
    expect(e.calls.every((c) => c.o.background === true && c.o.tripId === 't_once')).toBe(true);
    w.at(183 * MIN);
    expect(await w.r.tick()).toBe(1);
    const said = await nudges('t_once');
    expect(said).toEqual([expect.objectContaining({ dedupe_key: 'recipe_watch:rw_once:fired', topic: 'recipe_watch', asked: true, person_ids: ['p_priya'] })]);
    expect(said[0]!.facts).toMatchObject({ recipeWatchId: 'rw_once', label: "12608's CC to confirm", what: expect.stringContaining('CC: Available 4') });
    expect((await watchRow('rw_once')).active).toBe(false);
    // It ended: later checks find nothing, and nothing more is said.
    w.at(400 * MIN);
    expect(await w.r.tick()).toBe(0);
    expect(e.calls).toHaveLength(3);
    expect(await nudges('t_once')).toHaveLength(1);
  });

  it('stops after six checks in a row that failed, and says so in one line', async () => {
    await seedTrip(db.pool, 't_fail');
    await startWatch(db.pool, { ...CONFIRM, watch_id: 'rw_fail', trip_id: 't_fail' }, START);
    const e = engine(new TravelError('unreachable', 'ixigo took too long to answer.'));
    const w = runner(e);
    for (let i = 1; i <= WATCH_FAILURES; i++) {
      w.at(i * 70 * MIN);
      await w.r.tick();
    }
    expect(e.calls).toHaveLength(WATCH_FAILURES);
    expect(await watchRow('rw_fail')).toMatchObject({ active: false, stopped: 'failed', errors: WATCH_FAILURES });
    expect(await nudges('t_fail')).toEqual([expect.objectContaining({ dedupe_key: 'recipe_watch:rw_fail:stopped', topic: 'recipe_watch_stopped', asked: true })]);
    w.at(1000 * MIN);
    await w.r.tick();
    expect(e.calls).toHaveLength(WATCH_FAILURES);
  });

  it('checks no more than the cap across every trip in ten minutes, and the rest when there is room', async () => {
    for (let i = 0; i < 25; i++) {
      await seedTrip(db.pool, `t_cap${i}`);
      await startWatch(db.pool, { ...CONFIRM, watch_id: `rw_cap${i}`, trip_id: `t_cap${i}` }, START);
    }
    const e = engine(chance('CC: WL 12'));
    const w = runner(e, { cap: 20 });
    w.at(61 * MIN);
    await w.r.tick();
    const capped = e.calls.filter((c) => c.o.tripId.startsWith('t_cap')).length;
    expect(capped).toBe(20);
    await w.r.tick();
    expect(e.calls.filter((c) => c.o.tripId.startsWith('t_cap')).length).toBe(20);
    w.at(72 * MIN);
    await w.r.tick();
    expect(e.calls.filter((c) => c.o.tripId.startsWith('t_cap')).length).toBe(25);
  });

  it('ends with its trip, checking nothing, and does nothing at all with the switch off', async () => {
    await seedTrip(db.pool, 't_gone');
    await startWatch(db.pool, { ...CONFIRM, watch_id: 'rw_gone', trip_id: 't_gone' }, START);
    await seedTrip(db.pool, 't_off');
    await startWatch(db.pool, { ...CONFIRM, watch_id: 'rw_off', trip_id: 't_off' }, START);
    await db.pool.query(`update trips set gone_at = $2 where trip_id = $1`, ['t_gone', START]);
    const off = engine(chance('CC: Available 4'));
    const o = runner(off, { watches: 'off' });
    o.at(61 * MIN);
    await o.r.tick();
    expect(off.calls).toHaveLength(0);
    expect((await watchRow('rw_off')).active).toBe(true);
    const e = engine(chance('CC: WL 12'));
    const w = runner(e);
    w.at(61 * MIN);
    await w.r.tick();
    expect(e.calls.some((c) => c.o.tripId === 't_gone')).toBe(false);
    expect(await watchRow('rw_gone')).toMatchObject({ active: false, stopped: 'trip_gone' });
  });
});

describe('watch_ixigo', () => {
  const ctx = (tripId: string, id = 'rw_tool'): TurnCtx =>
    ({
      tripId, turnId: 'turn_1', wake: [{ id: 'd1', tripId, kind: 'message', ref: 'm_1', dueAt: START, payload: { messageId: 'm_1' } }],
      pack: { trip: { dates: { start: '2026-11-06', end: '2026-11-09' } }, messages: [{ message_id: 'm_1', seq: 1, author: { kind: 'person', person_id: 'p_priya' }, text: '@Go tell us when it confirms' }] },
      cards: [], lines: [], stableId: () => id, signal: new AbortController().signal,
    }) as unknown as TurnCtx;
  const tools = (e: ReturnType<typeof engine>) => {
    const [watch, stop] = watchTools({ pool: db.pool, book, engine: e, switches: switches(), now: () => START });
    return { watch: watch!, stop: stop! };
  };
  const ask = { recipe: 'trains.confirm_chance', inputs: CONFIRM.inputs, flip: 'confirms', label: "12608's CC to confirm" };

  it('answers at once what is already true on ixigo, and keeps no watch', async () => {
    await seedTrip(db.pool, 't_already');
    const out = await tools(engine(chance('CC: Available 4'))).watch.run(ask, ctx('t_already'));
    expect(out).toMatchObject({ already: true, now: expect.stringContaining('CC: Available 4') });
    expect((await db.pool.query('select 1 from recipe_watches where trip_id = $1', ['t_already'])).rowCount).toBe(0);
  });

  it('keeps a watch for what is not true yet, until the ask\'s date, for whoever asked; three a trip at most; stop_watch ends one', async () => {
    await seedTrip(db.pool, 't_tool');
    const t = tools(engine(chance('CC: WL 12')));
    const out = await t.watch.run(ask, ctx('t_tool', 'rw_t1'));
    expect(out).toMatchObject({ watching: true, watch_id: 'rw_t1', every_min: 60, until: '2026-10-22' });
    const row = (await db.pool.query('select asked_by, flip, until from recipe_watches where watch_id = $1', ['rw_t1'])).rows[0];
    expect(row).toMatchObject({ asked_by: 'p_priya', flip: 'confirms' });
    await t.watch.run(ask, ctx('t_tool', 'rw_t2'));
    await t.watch.run(ask, ctx('t_tool', 'rw_t3'));
    expect(await t.watch.run(ask, ctx('t_tool', 'rw_t4'))).toMatchObject({ error: 'too_many' });
    expect(await t.stop.run({ watch_id: 'rw_t2' }, ctx('t_tool'))).toEqual({ stopped: "12608's CC to confirm" });
    expect(await t.stop.run({}, ctx('t_tool'))).toMatchObject({ watches: [{ watch_id: 'rw_t1' }, { watch_id: 'rw_t3' }] });
  });

  it('refuses a flip the recipe has not got, and under with no price', async () => {
    const t = tools(engine(chance('CC: WL 12')));
    expect(await t.watch.run({ ...ask, flip: 'drops' }, ctx('t_x'))).toMatchObject({ error: 'needs_more' });
    expect(await t.watch.run({ recipe: 'hotels.search', inputs: { place: 'North Goa', check_in: '2026-11-06', check_out: '2026-11-09' }, flip: 'under', label: 'a pool stay under 4k' }, ctx('t_x'))).toMatchObject({ error: 'needs_more' });
  });
});

describe('a watch shares Go\'s searches', () => {
  it("takes its first check from a search for the same page in the same round: one page, not two (the 8 Oct drill's W2)", async () => {
    await seedTrip(db.pool, 't_share');
    const reads: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = {
      read: async (_t: string, url: string, _plan: FetchPlan) => {
        reads.push(url);
        await gate;
        return { captures: [capture('/accommodation-search/api/v3/accommodations/search$', 'https://www.ixigo.com/accommodation-search/api/v3/accommodations/search', fixture('stays-goa-page1.json'))], finalUrl: url };
      },
    };
    // Wired as register.ts wires them: the engine's searches are the backend's.
    let backend: IxigoWebBackend | null = null;
    const real = createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => START, searches: (id, given, o, run) => backend!.shareStep(id, given, o, run) });
    backend = createIxigoWebBackend({ book, engine: real, now: () => START });
    const [watch] = watchTools({ pool: db.pool, book, engine: real, switches: switches(), now: () => START });
    const ctx = ({
      tripId: 't_share', turnId: 'turn_1', wake: [], cards: [], lines: [], stableId: () => 'rw_share', signal: new AbortController().signal,
      pack: { trip: { dates: { start: '2026-11-06', end: '2026-11-09' } }, messages: [] },
    }) as unknown as TurnCtx;
    // The composer's search_stays and watch_ixigo, in one round.
    const searched = backend.search('stays', { area: 'North Goa', checkIn: '2026-11-06', checkOut: '2026-11-09', mustHave: ['pool'] }, { tripId: 't_share', turnId: 'turn_1' });
    const watched = watch!.run({ recipe: 'hotels.search', inputs: { place: 'North Goa', check_in: '2026-11-06', check_out: '2026-11-09' }, conditions: ['pool'], flip: 'under', limit: 3000, label: 'a pool stay under 3k' }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await searched;
    expect(await watched).toMatchObject({});
    expect(reads).toHaveLength(1);
  });
});

describe('the stage desk', () => {
  it('shows each trip with a watch going: how many, and when the next is checked, with no watch ids', async () => {
    await seedTrip(db.pool, 't_desk');
    await startWatch(db.pool, { ...CONFIRM, watch_id: 'rw_desk1', trip_id: 't_desk' }, START);
    await startWatch(db.pool, { ...CONFIRM, watch_id: 'rw_desk2', trip_id: 't_desk' }, START);
    const going = await watchesNow(db.pool, 500);
    expect(going).toContainEqual({ trip_id: 't_desk', active: 2, next_check_at: new Date(START.getTime() + 60 * MIN).toISOString() });
    expect(JSON.stringify(going)).not.toContain('rw_desk');
  });
});

describe('the flips', () => {
  const hotels = book.get('hotels.search')!;
  const confirms = book.get('trains.confirm_chance')!;
  const none = { inputs: {}, limit: null, baseline: null };

  it("a search's: anything at all, the cheapest under a price, the cheapest down a percent from the first check", async () => {
    expect((await flipped(hotels, 'appears', stays(), none)).on).toBe(false);
    expect((await flipped(hotels, 'appears', stays(stay('Villa Sol', 5200)), none)).on).toBe(true);
    expect((await flipped(hotels, 'under', stays(stay('Villa Sol', 5200), stay('Casa Azul', 4100)), { ...none, limit: 4000 })).on).toBe(false);
    const under = await flipped(hotels, 'under', stays(stay('Villa Sol', 5200), stay('Casa Azul', 3900)), { ...none, limit: 4000 });
    expect(under).toEqual({ on: true, reading: { cheapest: 390_000, rows: 2, what: '2 on ixigo; the cheapest ₹3,900: Casa Azul' } });
    const baseline = { cheapest: 500_000, rows: 1, what: '' };
    expect((await flipped(hotels, 'drops', stays(stay('Villa Sol', 4600)), { ...none, limit: 10, baseline })).on).toBe(false);
    expect((await flipped(hotels, 'drops', stays(stay('Villa Sol', 4500)), { ...none, limit: 10, baseline })).on).toBe(true);
  });

  it("confirm_chance's confirms: available, confirmed or RAC; never the waiting list or not available", async () => {
    for (const line of ['CC: Available 4', 'CC: AVL 12', 'CC: RAC 10', 'CC: CNF']) expect((await flipped(confirms, 'confirms', chance(line), none)).on, line).toBe(true);
    for (const line of ['CC: WL 12, 61% chance to confirm, ixigo says Probable', 'CC: Not Available', 'CC: Regret']) expect((await flipped(confirms, 'confirms', chance(line), none)).on, line).toBe(false);
  });
});
