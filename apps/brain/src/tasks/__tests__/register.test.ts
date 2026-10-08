import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as C from '@go/contract';
import { withSchema } from '../../db/test-db.js';
import { createTasksLane, registerTasks, type TasksLane } from '../register.js';
import { FakeV1 } from '../testing/fake-v1.js';
import { HARNESS_ADMIN, HARNESS_KEYS } from '../testing/harness.js';
import { makeLaneBrain, type LaneBrain } from '../testing/lane-brain.js';

const SECRET = 'whsec_register_test_0123456789';
let db: Awaited<ReturnType<typeof withSchema>>;
let fake: FakeV1;
let env: Record<string, string>;
let lb: LaneBrain;
let lane: TasksLane;

beforeAll(async () => {
  db = await withSchema();
  fake = new FakeV1({ keys: HARNESS_KEYS, adminKey: HARNESS_ADMIN, now: () => new Date('2026-10-07T12:00:00Z') });
  await fake.start();
  env = { VESTRA_API_URL: fake.url, VESTRA_API_KEYS: HARNESS_KEYS.join(','), VESTRA_ADMIN_KEY: HARNESS_ADMIN, VESTRA_WEBHOOK_SECRET: SECRET, VESTRA_DEPLOYMENT_ID: 'dep_go', VESTRA_MCP_SERVER_ID: 'mcp_go' };
  lb = makeLaneBrain({ pool: db.pool, env });
  lane = (await createTasksLane(lb.brain, { sweepEveryMs: 0, cardGapMs: 0, follower: { reconnectMs: [20], screenMs: 60_000 } }))!;
});
afterAll(async () => {
  await lb.stop();
  await lb.http.close();
  await fake.close();
  await db.drop();
});

const VILLA = {
  title: 'Finding villas with a pool in North Goa', goal: 'Find villas with a pool in North Goa for 6 to 9 Nov, under 8,000 rupees a head.', returns: 'stays',
  steps: ['Search stays', 'Read reviews'], context: { area: 'North Goa' }, asked_by: 'meher',
};

describe('registerTasks', () => {
  it("makes a new trip's computer (start), then has its browser visit ixigo once (prime), before anyone asks", async () => {
    await lb.brain.recipeRunners!.start('t_prime');
    expect(fake.callsTo('POST', /^\/v1\/users\/[^/]+\/warm$/).length).toBeGreaterThan(0);
    expect(fake.callsTo('POST', /\/browser\/fetch$/)).toHaveLength(0);
    await lb.brain.recipeRunners!.prime('t_prime');
    expect(fake.callsTo('POST', /\/browser\/fetch$/)).toHaveLength(1);
    expect(fake.callsTo('POST', /\/browser\/fetch$/)[0]!.body).toMatchObject({
      url: 'https://www.ixigo.com/',
      steps: [{ op: 'click', name: 'Close modal', optional: true }, { op: 'page_fetch', url: '/', capture_as: 'prime' }],
    });
  });

  it('leaves jobs off when the /v1 settings are missing', async () => {
    const bare = makeLaneBrain({ pool: db.pool });
    await registerTasks(bare.brain);
    expect(bare.brain.tasks).toBeUndefined();
    expect(bare.tools.list()).toEqual([]);
  });

  it('sets brain.tasks and registers the job tools, Watch and Stop, the tasks block, the task wake, setup steps and routes', async () => {
    expect(lb.brain.tasks).toBe(lane.tasks);
    expect(lb.tools.list().map((t) => t.name)).toEqual(['start_task', 'message_task', 'stop_task', 'settle_handoff']);
    expect([...lb.taps.handlers.keys()].sort()).toEqual(['working/stop', 'working/watch']);
    expect(lb.context.nows.map((n) => [n.name, n.order])).toEqual([['tasks', 30]]);
    expect(lb.context.wakes.has('task')).toBe(true);
    expect(lb.setup.steps.map((s) => s.name)).toEqual(['computer.user']);
    expect((await lb.http.inject({ method: 'POST', url: '/mcp', payload: {} })).statusCode).toBe(401);
    expect((await lb.http.inject({ method: 'POST', url: '/v1-webhooks', headers: { 'content-type': 'application/json' }, payload: '{}' })).statusCode).toBe(401);
  });

  it('stops the sweep, the event streams and the card timers through brain.onStop, and follows nothing after', async () => {
    const other = makeLaneBrain({ pool: db.pool, env });
    const l = (await createTasksLane(other.brain, { sweepEveryMs: 60_000, cardGapMs: 0 }))!;
    const sweepStop = vi.spyOn(l.sweep, 'stop');
    const followerClose = vi.spyOn(l.follower, 'close');
    expect(other.stoppers).toHaveLength(1);
    await other.stop();
    expect(sweepStop).toHaveBeenCalledOnce();
    expect(followerClose).toHaveBeenCalledOnce();
    l.follower.ensure('conv_after_stop', 't_goa');
    expect(l.follower.following()).toEqual([]);
    await other.http.close();
  });
});

describe('start_task', () => {
  it("puts the working card in the turn's cards with the turn's ids, pins hand-offs to the person named, and gives the job the trip facts", async () => {
    const ctx = lb.ctx({ turnId: 'turn_st1' });
    const out = (await lb.tools.run('start_task', VILLA, ctx)) as any;
    expect(out.card_id).toBe('c_work_turn_st1_1');
    expect(ctx.cards).toEqual([expect.objectContaining({ kind: 'working', card_id: 'c_work_turn_st1_1', task_id: out.task_id, state: 'running' })]);
    const row = (await lane.store.get(out.task_id))!;
    expect(row).toMatchObject({ askedBy: 'p_meher', returnsKind: 'stays', context: { area: 'North Goa', trip: { destination: 'North Goa', dates: { start: '2026-11-06', end: '2026-11-09' }, people: 5 } } });
    const again = lb.ctx({ turnId: 'turn_st1' });
    expect(((await lb.tools.run('start_task', VILLA, again)) as any).task_id).toBe(out.task_id);
    expect(again.cards.map((c) => c.card_id)).toEqual([out.card_id]);
    await lane.tasks.settled();
  });

  it('tells the composer message_task is never for a code: a sign-in is done on Go\'s screen through Watch', () => {
    const description = lb.tools.list().find((t) => t.name === 'message_task')!.description;
    expect(description).toContain('Never for a one-time code or a password');
    expect(description).toContain('Watch');
    expect(description).not.toMatch(/code for its hand-off/);
  });

  it('answers a job that is not there as a tool answer, not a crash', async () => {
    expect(await lb.tools.run('message_task', { task_id: 'gt_000000nothing', text: 'hi' }, lb.ctx())).toMatchObject({ error: 'unknown_task' });
    expect(await lb.tools.run('settle_handoff', { task_id: 'gt_000000nothing', outcome: 'done' }, lb.ctx())).toMatchObject({ error: 'unknown_task' });
    expect(await lb.tools.run('stop_task', { task_id: 'gt_000000nothing' }, lb.ctx())).toMatchObject({ ok: true });
  });
});

describe('Watch and Stop', () => {
  async function job(turnId: string): Promise<{ id: string; card: C.Card }> {
    const ctx = lb.ctx({ turnId });
    const out = (await lb.tools.run('start_task', VILLA, ctx)) as any;
    await lane.tasks.settled();
    return { id: out.task_id, card: ctx.cards[0]! };
  }
  const tap = (card: C.Card, action: string, person = 'p_priya', tapId = `tap_${Math.random()}`) => ({ tap_id: tapId, trip_id: 't_goa', card_id: card.card_id, action_id: action, person_id: person });

  it('opens a fresh 15-minute view of the screen on every tap, and never posts the link', async () => {
    const { card } = await job('turn_w1');
    const posts = lb.link.sent('post_message').length;
    const a = await lb.taps.tap('working', 'watch', tap(card, 'watch'), card);
    const b = await lb.taps.tap('working', 'watch', tap(card, 'watch'), card);
    expect(a).toMatchObject({ result: 'open', url: expect.stringMatching(/^https:\/\//) });
    expect(b.result === 'open' && a.result === 'open' && b.url !== a.url).toBe(true);
    expect(fake.callsTo('POST', /^\/v1\/sessions$/).at(-1)!.body).toMatchObject({ screen: 'view' });
    expect(lb.link.sent('post_message')).toHaveLength(posts);
  });

  it('asks for control only for the person a hand-off waits on, and falls back to a view when control is off', async () => {
    const { id, card } = await job('turn_w2');
    await lane.store.transition(id, ['starting', 'running'], 'needs_you', { needsPersonId: 'p_meher' });
    const sessions = () => fake.callsTo('POST', /^\/v1\/sessions$/);
    const before = sessions().length;
    expect((await lb.taps.tap('working', 'watch', tap(card, 'watch', 'p_meher'), card)).result).toBe('open');
    expect(sessions().slice(before).map((c) => c.body.screen)).toEqual(['control', 'view']);
    fake.controlAvailable = true;
    await lb.taps.tap('working', 'watch', tap(card, 'watch', 'p_meher'), card);
    expect(sessions().at(-1)!.body.screen).toBe('control');
    await lb.taps.tap('working', 'watch', tap(card, 'watch', 'p_kabir'), card);
    expect(sessions().at(-1)!.body.screen).toBe('view');
    fake.controlAvailable = false;
  });

  it('stops a live job from its card, and refuses a finished one or one from another trip', async () => {
    const { id, card } = await job('turn_s1');
    expect(await lb.taps.tap('working', 'stop', tap(card, 'stop'), card)).toEqual({ result: 'done', toast: 'Stopping it' });
    expect((await lane.store.get(id))?.state).toBe('stopped');
    expect(await lb.taps.tap('working', 'stop', tap(card, 'stop'), card)).toEqual({ result: 'refused', toast: 'That job has already finished' });
    expect(await lb.taps.tap('working', 'watch', { ...tap(card, 'watch'), trip_id: 't_other' }, card)).toEqual({ result: 'refused', toast: 'That job is not here any more' });
  });
});
