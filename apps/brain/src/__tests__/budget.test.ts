import { FakeServer, goaFreshTrip } from '@go/sim';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { budgetProbe } from '../admin/health.js';
import { buildBrain, type Built } from '../app.js';
import { createBudget, limitRequestId, OverBudget } from '../budget.js';
import { OVER_BUDGET } from '../composer/turn.js';
import { withSchema } from '../db/test-db.js';
import { loadEnv } from '../env.js';
import { silentLog } from '../log.js';
import { anthropicSideModel, type SideClient } from '../memory/side-model.js';
import { registerRoom } from '../room.js';
import { fakeAnthropic, type Reply } from './fixtures/fake-anthropic.js';
import { SECRET, TEST_TIMINGS, newSince, sleep } from './e2e/harness.js';

let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
});
afterAll(() => db.drop());

/** A clock the test moves. */
function clock(iso: string) {
  let t = new Date(iso).getTime();
  return { now: () => new Date(t), set: (next: string) => { t = new Date(next).getTime(); } };
}
const cleared = () => db.pool.query('delete from model_spend');

describe('the daily model budget', () => {
  it('with no cap it allows every call and still counts what they cost', async () => {
    await cleared();
    const b = createBudget({ pool: db.pool, now: () => new Date(), capUsd: null, log: silentLog });
    await b.spend({ purpose: 'composer', model: 'claude-sonnet-5-5', usd: 500 });
    expect(b.allows()).toBe(true);
    expect(b.spentToday()).toBe(500);
  });

  it('allows calls under the cap, and the call that crosses it stops the next one', async () => {
    await cleared();
    const b = createBudget({ pool: db.pool, now: () => new Date(), capUsd: 1, log: silentLog });
    expect(b.allows()).toBe(true);
    await b.spend({ purpose: 'composer', model: 'claude-sonnet-5-5', usd: 0.4 });
    expect(b.allows()).toBe(true);
    await b.spend({ purpose: 'notes', model: 'claude-haiku-4-5', usd: 0.7 });
    expect(b.allows()).toBe(false);
    expect(b.spentToday()).toBeCloseTo(1.1, 6);
  });

  it("keeps today's total through a restart: a new process reads it back at boot", async () => {
    await cleared();
    const c = clock('2026-10-06T10:00:00Z');
    const before = createBudget({ pool: db.pool, now: c.now, capUsd: 1, log: silentLog });
    await before.spend({ purpose: 'composer', model: 'claude-sonnet-5-5', usd: 0.6 });
    const after = createBudget({ pool: db.pool, now: c.now, capUsd: 1, log: silentLog });
    expect(after.spentToday()).toBe(0);
    await after.refresh();
    expect(after.spentToday()).toBeCloseTo(0.6, 6);
    expect(after.allows()).toBe(true);
    await after.spend({ purpose: 'fold', model: 'claude-haiku-4-5', usd: 0.5 });
    expect(after.allows()).toBe(false);
  });

  it('starts each UTC day from nothing', async () => {
    await cleared();
    const c = clock('2026-10-06T23:59:00Z');
    const b = createBudget({ pool: db.pool, now: c.now, capUsd: 1, log: silentLog });
    await b.spend({ purpose: 'composer', model: 'claude-sonnet-5-5', usd: 2 });
    expect(b.allows()).toBe(false);
    c.set('2026-10-07T00:01:00Z');
    expect(b.allows()).toBe(true);
    await b.refresh();
    expect(b.spentToday()).toBe(0);
  });

  it('names the limit line once per trip and day, short enough for a request id', () => {
    const id = limitRequestId('t_goa', '2026-10-06');
    expect(id).toBe(limitRequestId('t_goa', '2026-10-06'));
    expect(id).not.toBe(limitRequestId('t_goa', '2026-10-07'));
    expect(id).not.toBe(limitRequestId('t_coorg', '2026-10-06'));
    expect(limitRequestId('t_'.padEnd(64, 'x'), '2026-10-06').length).toBeLessThanOrEqual(64);
  });
});

describe('side passes under the budget', () => {
  it('skip with no model call over the cap, and keep what a call cost under it', async () => {
    await cleared();
    let calls = 0;
    const client: SideClient = {
      messages: {
        async create() {
          calls += 1;
          return { content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 400_000, output_tokens: 0, cache_read_input_tokens: null } };
        },
      },
    };
    const budget = createBudget({ pool: db.pool, now: () => new Date(), capUsd: 0.5, log: silentLog });
    const side = anthropicSideModel(client, 'claude-haiku-4-5', silentLog, budget);
    expect(await side.complete({ purpose: 'notes', system: 's', user: 'u', maxTokens: 10 })).toBe('{}');
    // Haiku at $1 per million input tokens: 400,000 is $0.40, under the $0.50 cap.
    expect(budget.spentToday()).toBeCloseTo(0.4, 6);
    await side.complete({ purpose: 'fold', system: 's', user: 'u', maxTokens: 10 });
    await expect(side.complete({ purpose: 'notes', system: 's', user: 'u', maxTokens: 10 })).rejects.toBeInstanceOf(OverBudget);
    expect(calls).toBe(2);
  });
});

describe('the admin health row', () => {
  it('shows what today cost and the cap, red once over it', async () => {
    const at = (spent: number, capUsd: number | null) => budgetProbe({ capUsd, spentToday: () => spent }).run(new AbortController().signal);
    expect(await at(3.5, null)).toEqual({ ok: true, detail: '$3.50 today, no cap' });
    expect(await at(3.5, 20)).toEqual({ ok: true, detail: '$3.50 of the $20.00 cap today' });
    expect(await at(20.01, 20)).toEqual({ ok: false, detail: '$20.01 of the $20.00 cap today: Go makes no model calls until tomorrow (UTC)' });
  });
});

describe('a Go with a daily cap, end to end', () => {
  // claude-sonnet-5-5 at $2 per million input tokens: 600,000 is $1.20, over a $1 cap in one turn.
  const script = (body: any): Reply =>
    /flights/i.test(newSince(body))
      ? { text: 'Friday evening flights from Delhi, all after 6 pm.', usage: { input_tokens: 600_000 } }
      : { tools: [{ name: 'stay_silent', input: { reason: 'nothing for Go' } }] };
  let built: Built;
  let server: FakeServer;
  let model: ReturnType<typeof fakeAnthropic>;
  const goa = goaFreshTrip();
  const coorg = { ...goaFreshTrip(), trip_id: 't_coorg', title: 'Coorg' };
  const goLines = (tripId: string): string[] => server.messages(tripId).filter((m) => m.author.kind === 'go').map((m) => m.text ?? '');
  /** A $1 cap, or no MODEL_DAILY_BUDGET_USD at all. */
  const env = (capUsd: string | null) =>
    loadEnv({
      PORT: '0', DATABASE_URL: process.env.DATABASE_URL, GO_SIGNING_SECRET: SECRET, GO_PUBLIC_URL: 'http://127.0.0.1',
      ANTHROPIC_API_KEY: 'test-key', LOG_LEVEL: 'silent', ...(capUsd === null ? {} : { MODEL_DAILY_BUDGET_USD: capUsd }),
    });

  beforeAll(async () => {
    await cleared();
    model = fakeAnthropic(script);
    built = await buildBrain(env('1'), { pool: db.pool, anthropic: model.client, logger: false, timings: TEST_TIMINGS });
    await registerRoom(built.brain);
    const { port } = await built.start();
    server = new FakeServer({ goUrl: `http://127.0.0.1:${port}`, secret: SECRET, instance: 'sim-budget' });
    await server.start();
    await server.createTrip(goa);
    await server.createTrip(coorg);
  }, 30_000);
  afterAll(async () => {
    server.stop();
    await built.stop();
  });

  it('under the cap, Go answers', async () => {
    await server.say('p_priya', '@Go flights Delhi to Goa Friday evening', { tripId: goa.trip_id });
    await server.waitFor(() => goLines(goa.trip_id).includes('Friday evening flights from Delhi, all after 6 pm.'), 10_000);
    expect(built.brain.budget?.allows()).toBe(false);
  });

  it('once over, the next ask makes no model call, hears the limit once per trip, and typing goes off', async () => {
    const calls = model.bodies.length;
    for (const text of ['@Go and hotels?', '@Go anything?']) {
      await server.say('p_priya', text, { tripId: goa.trip_id });
      await server.waitFor(() => goLines(goa.trip_id).includes(OVER_BUDGET), 10_000);
      await sleep(1_500);
    }
    expect(goLines(goa.trip_id).filter((l) => l === OVER_BUDGET)).toHaveLength(1);
    expect(server.typingOn(goa.trip_id)).toBe(false);
    // Another trip gets its own one line.
    await server.say('p_rahul', '@Go flights to Coorg?', { tripId: coorg.trip_id });
    await server.waitFor(() => goLines(coorg.trip_id).includes(OVER_BUDGET), 10_000);
    expect(goLines(coorg.trip_id).filter((l) => l === OVER_BUDGET)).toHaveLength(1);
    expect(model.bodies.length).toBe(calls);
  }, 30_000);

  it('a Go that restarts on the same database starts over the cap too', async () => {
    const again = await buildBrain(env('1'), { pool: db.pool, anthropic: fakeAnthropic(script).client, logger: false, timings: TEST_TIMINGS });
    await again.brain.budget?.refresh();
    expect(again.brain.budget?.spentToday()).toBeGreaterThanOrEqual(1.2);
    expect(again.brain.budget?.allows()).toBe(false);
    await again.stop();
  });

  it('without MODEL_DAILY_BUDGET_USD there is no limit', async () => {
    const free = await buildBrain(env(null), { pool: db.pool, anthropic: fakeAnthropic(script).client, logger: false, timings: TEST_TIMINGS });
    expect(free.brain.budget?.capUsd).toBeNull();
    expect(free.brain.budget?.allows()).toBe(true);
    await free.stop();
  });
});
