import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as C from '@go/contract';
import { withSchema } from '../../db/test-db.js';
import { createTokenStore } from '../../mcp/tokens.js';
import { stableId } from '../../travel/ids.js';
import { createCardUpdater, type CardUpdater } from '../card-updater.js';
import { createComputer } from '../computer.js';
import { returnsSchema } from '../returns.js';
import { createTaskStore, type TaskStore } from '../store.js';
import { createTasks, type TaskBrief, type TasksService } from '../tasks.js';
import { FakeV1 } from '../testing/fake-v1.js';
import { makeLaneBrain, type LaneBrain } from '../testing/lane-brain.js';
import { createV1Client } from '../v1-client.js';

const KEYS = [`vk_test_${'a'.repeat(43)}`];
const ADMIN = `vk_test_${'z'.repeat(43)}`;
let db: Awaited<ReturnType<typeof withSchema>>;
let lb: LaneBrain;
let fake: FakeV1;
let store: TaskStore;
let cards: CardUpdater;
let tasks: TasksService;
const followed: string[] = [];

beforeAll(async () => {
  db = await withSchema();
  lb = makeLaneBrain({ pool: db.pool });
  fake = new FakeV1({ keys: KEYS, adminKey: ADMIN, now: lb.clock.now });
  fake.autoStart = false;
  await fake.start();
  const v1 = createV1Client({ baseUrl: fake.url, keys: KEYS, adminKey: ADMIN, sleep: async () => undefined });
  store = createTaskStore(db.pool);
  cards = createCardUpdater({ link: lb.link, log: lb.brain.log, gapMs: 0 });
  const computer = createComputer({ pool: db.pool, v1, tokens: createTokenStore(db.pool, lb.clock.now), env: { VESTRA_DEPLOYMENT_ID: 'dep_go', VESTRA_MCP_SERVER_ID: 'mcp_go' }, now: lb.clock.now, log: lb.brain.log });
  tasks = createTasks({ store, v1, computer, cards, link: lb.link, desk: lb.desk, packs: lb.brain.packs, now: lb.clock.now, log: lb.brain.log, follow: (c) => { followed.push(c); } });
});
afterAll(async () => {
  await fake.close();
  await db.drop();
});

const VILLAS: TaskBrief = {
  goal: 'Find a villa with a pool in North Goa under 8k a head, near the beach', returns: returnsSchema('stays'), context: { area: 'North Goa', people: 5 },
  title: 'Finding villas with a pool in North Goa', steps: ['Search stays', 'Read reviews', 'Pick three'], returnsKind: 'stays', askedBy: 'p_meher',
};
const TITLE = 'Finding villas with a pool in North Goa';

/** /v1 announces the job (what task.started does), and Go maps it. */
async function mapped(taskId: string): Promise<string> {
  const row = (await store.get(taskId))!;
  const t = fake.startTask(row.conversationId!, row.v1TurnId!, row.title);
  await store.recordStart(row.v1TurnId!, t.id, row.title);
  await tasks.mapStarts();
  return t.id;
}

describe('starting a job', () => {
  it('posts a running card at once, then hands off: the trip token first, one message with hand_off always, the schema and the context', async () => {
    const r = await tasks.start('t_a', { ...VILLAS, key: 'turn_1:villas' });
    expect(lb.link.card(r.cardId)).toMatchObject({ kind: 'working', state: 'running', task_id: r.taskId, steps: [{ text: 'Search stays', state: 'doing' }, { text: 'Read reviews', state: 'todo' }, { text: 'Pick three', state: 'todo' }] });
    await tasks.settled();
    const order = fake.calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf('PUT /v1/secrets/TRIP_TOKEN')).toBeLessThan(order.findIndex((p) => /^POST \/v1\/conversations\/[^/]+\/messages$/.test(p)));
    const msg = fake.callsTo('POST', /\/messages$/).at(-1)!;
    expect(msg.body).toMatchObject({ message: VILLAS.goal, hand_off: 'always', output_schema: returnsSchema('stays'), context: { area: 'North Goa', people: 5 }, metadata: { go_task_id: r.taskId } });
    expect(msg.headers['idempotency-key']).toBe(`go-msg-${r.taskId}`);
    const row = (await store.get(r.taskId))!;
    expect(row.v1TurnId).toMatch(/^turn_/);
    expect(followed).toContain(row.conversationId);
    const v1Id = await mapped(r.taskId);
    expect(await store.get(r.taskId)).toMatchObject({ state: 'running', v1TaskId: v1Id });
  });

  it('starts one job for one key, however often it is asked', async () => {
    const a = await tasks.start('t_b', { ...VILLAS, key: 'turn_same:villas' });
    const b = await tasks.start('t_b', { ...VILLAS, key: 'turn_same:villas' });
    expect(b).toEqual(a);
    expect(lb.link.sent('post_message').filter((p) => (p.card as { card_id: string }).card_id === a.cardId)).toHaveLength(1);
    await tasks.settled();
  });

  it("inside a turn, puts the working card in the turn's cards with the turn's card id instead of posting it", async () => {
    const cards: C.Card[] = [];
    const r = await tasks.start('t_c', { ...VILLAS, key: 'task_turn_c_1', cardId: 'c_work_turn_c_1', cards });
    expect(r.cardId).toBe('c_work_turn_c_1');
    expect(cards).toEqual([expect.objectContaining({ kind: 'working', card_id: 'c_work_turn_c_1', task_id: r.taskId, state: 'running' })]);
    expect(lb.link.sent('post_message').some((p) => (p.card as { card_id?: string } | undefined)?.card_id === 'c_work_turn_c_1')).toBe(false);
    await tasks.settled();
  });

  it('never runs more than three jobs of a trip, even when five start at the same moment', async () => {
    const started = await Promise.all(Array.from({ length: 5 }, (_, i) => tasks.start('t_race', { ...VILLAS, key: `race${i}` })));
    await tasks.settled();
    const states = await Promise.all(started.map(async (r) => (await store.get(r.taskId))?.state));
    expect(states.filter((st) => st === 'queued')).toHaveLength(2);
    expect(states.filter((st) => st === 'starting' || st === 'running')).toHaveLength(3);
  });

  it('hands a job to /v1 once, even when it is dispatched again while its hand-off is still going', async () => {
    const r = await tasks.start('t_once', { ...VILLAS, key: 'once' });
    await Promise.all([tasks.dispatch(r.taskId), tasks.dispatch(r.taskId)]);
    await tasks.settled();
    expect(fake.callsTo('POST', /\/messages$/).filter((c) => c.headers['idempotency-key'] === `go-msg-${r.taskId}`)).toHaveLength(1);
  });

  it('keeps a fourth job waiting until one of three ends', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push((await tasks.start('t_q', { ...VILLAS, key: `q${i}` })).taskId);
    const fourth = await tasks.start('t_q', { ...VILLAS, key: 'q3' });
    await tasks.settled();
    const sentFor = (id: string) => fake.callsTo('POST', /\/messages$/).some((c) => c.headers['idempotency-key'] === `go-msg-${id}`);
    expect((await store.get(fourth.taskId))?.state).toBe('queued');
    expect(lb.link.card(fourth.cardId)?.fallback_text).toBe(`Waiting to start: ${TITLE}`);
    expect(sentFor(fourth.taskId)).toBe(false);
    await tasks.stop(ids[0]!);
    await tasks.settled();
    expect((await store.get(fourth.taskId))?.state).toBe('starting');
    expect(sentFor(fourth.taskId)).toBe(true);
  });

  it('ends as "Didn\'t work" with one line for the composer when /v1 refuses the job', async () => {
    fake.failNextPost = { path: /\/messages$/, status: 402, code: 'wallet_empty' };
    const r = await tasks.start('t_w', { ...VILLAS, key: 'broke' });
    await tasks.settled();
    await cards.flush();
    expect(await store.get(r.taskId)).toMatchObject({ state: 'failed', endReason: 'dispatch_failed' });
    expect(lb.link.card(r.cardId)?.fallback_text).toBe(`Didn't work: ${TITLE}`);
    expect(lb.desk.items.find((i) => i.id === `task:${r.taskId}:failed`)?.payload).toMatchObject({ event: 'failed', reason: "Go's account for the trip's computer is out of credit." });
  });

  it('gives up on a job whose card could not be posted, so nothing runs without a card', async () => {
    lb.link.failNext = { method: 'post_message', error: new Error('503 unavailable') };
    await expect(tasks.start('t_n', { ...VILLAS, key: 'nocard' })).rejects.toThrow(/503/);
    expect((await store.get(stableId('gt', 't_n', 'nocard')))?.state).toBe('failed');
  });
});

describe('talking to a job', () => {
  it("answers the job's open question with the person's words, and passes other words on with hand_off auto", async () => {
    const r = await tasks.start('t_m', { ...VILLAS, key: 'msg' });
    await tasks.settled();
    const v1Id = await mapped(r.taskId);
    const ask = fake.ask(v1Id, {
      type: 'question', kind: 'ask_question', summary: 'Which dates?',
      questions: [{ question: 'Which dates?', header: 'Dates', options: [{ label: '6 to 9 Nov', description: '' }, { label: '13 to 16 Nov', description: '' }], multi_select: false }],
    });
    await store.addInteraction({ interactionId: ask.id, taskId: r.taskId, tripId: 't_m', type: 'question', summary: 'Which dates?', questions: [{ question: 'Which dates?', options: ['6 to 9 Nov', '13 to 16 Nov'] }], forPersonIds: [], createdAt: lb.clock.now() });
    await tasks.message(r.taskId, '6 to 9 Nov');
    expect(fake.interactions.get(ask.id)).toMatchObject({ status: 'resolved', answer: { answers: ['6 to 9 Nov'] } });
    expect(await store.openInteractions(r.taskId)).toEqual([]);
    await tasks.message(r.taskId, 'Also look in Assagao');
    const follow = fake.callsTo('POST', /\/messages$/).at(-1)!;
    // The job's output_schema rides every message, so whichever run ends the job answers in its shape.
    expect(follow.body).toMatchObject({ hand_off: 'auto', output_schema: returnsSchema('stays'), metadata: { go_task_id: r.taskId } });
    expect(follow.body.message).toContain('Also look in Assagao');
    await expect(tasks.message('gt_nope', 'x')).rejects.toMatchObject({ code: 'unknown_task' });
  });

  it('puts words for a job still waiting for a slot into its goal, so it starts with them and nothing extra goes to /v1', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push((await tasks.start('t_fold', { ...VILLAS, key: `fold${i}` })).taskId);
    const fourth = await tasks.start('t_fold', { ...VILLAS, key: 'fold3' });
    await tasks.settled();
    expect((await store.get(fourth.taskId))?.state).toBe('queued');
    await tasks.message(fourth.taskId, 'Also check if any of them allow pets');
    const sentFor = (id: string) => fake.callsTo('POST', /\/messages$/).filter((c) => c.body?.metadata?.go_task_id === id);
    expect(sentFor(fourth.taskId)).toEqual([]);
    await tasks.stop(ids[0]!);
    await tasks.settled();
    const sent = sentFor(fourth.taskId);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ hand_off: 'always', output_schema: returnsSchema('stays') });
    expect(sent[0]!.body.message).toBe(`${VILLAS.goal}\n\nAlso from the group: Also check if any of them allow pets`);
  });

  it('sends words that landed while the hand-off was on its way as the next message, with the schema', async () => {
    const v1 = createV1Client({ baseUrl: fake.url, keys: KEYS, adminKey: ADMIN, sleep: async () => undefined });
    const real = createComputer({ pool: db.pool, v1, tokens: createTokenStore(db.pool, lb.clock.now), env: { VESTRA_DEPLOYMENT_ID: 'dep_go', VESTRA_MCP_SERVER_ID: 'mcp_go' }, now: lb.clock.now, log: lb.brain.log });
    let own: TasksService | null = null;
    const taskId = stableId('gt', 't_late', 'late1');
    // Someone adds to the job after the hand-off read its goal, before /v1 has the message.
    const computer = { ...real, conversation: async (tripId: string, id: string) => {
      await own!.message(taskId, 'Also check if any of them allow pets');
      return real.conversation(tripId, id);
    } };
    own = createTasks({ store, v1, computer, cards, link: lb.link, desk: lb.desk, packs: lb.brain.packs, now: lb.clock.now, log: lb.brain.log, follow: () => undefined });
    await own.start('t_late', { ...VILLAS, key: 'late1' });
    await own.settled();
    const sent = fake.callsTo('POST', /\/messages$/).filter((c) => c.body?.metadata?.go_task_id === taskId);
    expect(sent.map((c) => c.body.hand_off)).toEqual(['always', 'auto']);
    expect(sent[0]!.body.message).toBe(VILLAS.goal);
    expect(sent[1]!.body).toMatchObject({ output_schema: returnsSchema('stays') });
    expect(sent[1]!.body.message).toContain('Also from the group: Also check if any of them allow pets');
    expect(await store.get(taskId)).toMatchObject({ state: 'starting', endReason: null });
  });

  it('settles a hand-off the person did themselves, and the card stops pinning them', async () => {
    const r = await tasks.start('t_h', { ...VILLAS, key: 'handoff' });
    await tasks.settled();
    const v1Id = await mapped(r.taskId);
    const ask = fake.ask(v1Id, { type: 'handoff', kind: 'ask_question', summary: 'Sign in to the villa site', browser: { suggested_mode: 'control', url: null } });
    await store.addInteraction({ interactionId: ask.id, taskId: r.taskId, tripId: 't_h', type: 'handoff', summary: 'Sign in', questions: [], forPersonIds: ['p_meher'], createdAt: lb.clock.now() });
    await store.transition(r.taskId, ['running'], 'needs_you', { needsPersonId: 'p_meher' });
    await tasks.handoff(r.taskId, 'done');
    expect(fake.interactions.get(ask.id)?.answer).toEqual({ done: true });
    expect(await store.get(r.taskId)).toMatchObject({ state: 'running', needsPersonId: null });
    await cards.flush();
    const card = lb.link.card(r.cardId)!;
    expect(card.state).toBe('running');
    expect(card.for_person_ids).toBeUndefined();
    await expect(tasks.handoff(r.taskId, 'done')).rejects.toMatchObject({ code: 'no_handoff' });
  });

  it('lists the live jobs of a trip by their titles', async () => {
    const live = await tasks.running('t_a');
    expect(live).toEqual([{ id: expect.stringMatching(/^gt_/), brief: TITLE, state: 'running' }]);
  });
});

describe('stopping a job', () => {
  it('says Stopped on the card at once, cancels its desk items, and stops it on /v1', async () => {
    const r = await tasks.start('t_s', { ...VILLAS, key: 'stop1' });
    await tasks.settled();
    const v1Id = await mapped(r.taskId);
    await tasks.stop(r.taskId);
    await tasks.settled();
    await cards.flush();
    expect(lb.link.card(r.cardId)).toMatchObject({ state: 'failed', fallback_text: `Stopped: ${TITLE}`, actions: [] });
    expect(lb.desk.cancelled).toContainEqual({ tripId: 't_s', ref: r.taskId });
    expect(fake.tasks.get(v1Id)?.stopped).toBe(true);
  });

  it('stops a job on /v1 the moment /v1 names it, when the stop came first', async () => {
    const early = await tasks.start('t_s', { ...VILLAS, key: 'stop2' });
    await tasks.settled();
    await tasks.stop(early.taskId);
    await tasks.settled();
    const v1Id = await mapped(early.taskId);
    expect(fake.tasks.get(v1Id)?.stopped).toBe(true);
    expect((await store.get(early.taskId))?.state).toBe('stopped');
  });

  it('answers a stop at once with the job stopped in Go, and stops it on /v1 behind, however slow /v1 is', async () => {
    const real = createV1Client({ baseUrl: fake.url, keys: KEYS, adminKey: ADMIN, sleep: async () => undefined });
    let release!: () => void;
    const slow = new Promise<void>((r) => {
      release = r;
    });
    // /v1 takes as long as the test likes to answer a stop.
    const v1 = { ...real, call: async <T>(method: Parameters<typeof real.call>[0], path: string, opts?: Parameters<typeof real.call>[2]): Promise<T> => {
      if (/\/stop$/.test(path)) await slow;
      return real.call<T>(method, path, opts);
    } };
    const computer = createComputer({ pool: db.pool, v1, tokens: createTokenStore(db.pool, lb.clock.now), env: { VESTRA_DEPLOYMENT_ID: 'dep_go', VESTRA_MCP_SERVER_ID: 'mcp_go' }, now: lb.clock.now, log: lb.brain.log });
    const own = createTasks({ store, v1, computer, cards, link: lb.link, desk: lb.desk, packs: lb.brain.packs, now: lb.clock.now, log: lb.brain.log, follow: () => undefined });
    const r = await own.start('t_slow_stop', { ...VILLAS, key: 'slow1' });
    await own.settled();
    const row = (await store.get(r.taskId))!;
    const t = fake.startTask(row.conversationId!, row.v1TurnId!, row.title);
    await store.recordStart(row.v1TurnId!, t.id, row.title);
    await own.mapStarts();
    await own.stop(r.taskId);
    expect((await store.get(r.taskId))?.state).toBe('stopped');
    expect(fake.tasks.get(t.id)?.stopped).toBe(false);
    release();
    await own.settled();
    expect(fake.tasks.get(t.id)?.stopped).toBe(true);
  });

  it("looks the job up on /v1 when the stop lands after /v1 started it but before Go heard, and stops it there", async () => {
    const r = await tasks.start('t_s2', { ...VILLAS, key: 'stop3' });
    await tasks.settled();
    const row = (await store.get(r.taskId))!;
    // /v1 has started the job, but its task.started has not reached Go.
    const t = fake.startTask(row.conversationId!, row.v1TurnId!, row.title);
    await tasks.stop(r.taskId);
    await tasks.settled();
    expect(fake.tasks.get(t.id)?.stopped).toBe(true);
    expect(await store.get(r.taskId)).toMatchObject({ state: 'stopped', v1TaskId: t.id });
  });

  it('stops on /v1 a job whose hand-off failed after its message got through, once /v1 names it', async () => {
    const v1 = createV1Client({ baseUrl: fake.url, keys: KEYS, adminKey: ADMIN, sleep: async () => undefined });
    const computer = createComputer({ pool: db.pool, v1, tokens: createTokenStore(db.pool, lb.clock.now), env: { VESTRA_DEPLOYMENT_ID: 'dep_go', VESTRA_MCP_SERVER_ID: 'mcp_go' }, now: lb.clock.now, log: lb.brain.log });
    // The message reached /v1, then the hand-off failed in Go (here: following the conversation threw).
    const own = createTasks({ store, v1, computer, cards, link: lb.link, desk: lb.desk, packs: lb.brain.packs, now: lb.clock.now, log: lb.brain.log, follow: () => {
      throw new Error('the follower is down');
    } });
    const r = await own.start('t_failed_handoff', { ...VILLAS, key: 'fh1' });
    await own.settled();
    const row = (await store.get(r.taskId))!;
    expect(row).toMatchObject({ state: 'failed', endReason: 'dispatch_failed' });
    expect(row.stopRequestedAt).not.toBeNull();
    const t = fake.startTask(row.conversationId!, row.v1TurnId!, row.title);
    await store.recordStart(row.v1TurnId!, t.id, row.title);
    await own.mapStarts();
    expect(fake.tasks.get(t.id)?.stopped).toBe(true);
  });

  it('stops on /v1 a job /v1 names after Go has ended it, even with no stop asked', async () => {
    const r = await tasks.start('t_ended', { ...VILLAS, key: 'ended1' });
    await tasks.settled();
    const row = (await store.get(r.taskId))!;
    await store.transition(row.id, ['starting'], 'failed', { endedAt: lb.clock.now(), endReason: 'card_failed' });
    const t = fake.startTask(row.conversationId!, row.v1TurnId!, row.title);
    await store.recordStart(row.v1TurnId!, t.id, row.title);
    await tasks.mapStarts();
    expect(fake.tasks.get(t.id)?.stopped).toBe(true);
    expect((await store.get(row.id))?.state).toBe('failed');
  });

  it('hands nothing over and leaves no live token when the stop lands while the token is being armed', async () => {
    const v1 = createV1Client({ baseUrl: fake.url, keys: KEYS, adminKey: ADMIN, sleep: async () => undefined });
    const tokens = createTokenStore(db.pool, lb.clock.now);
    const real = createComputer({ pool: db.pool, v1, tokens, env: { VESTRA_DEPLOYMENT_ID: 'dep_go', VESTRA_MCP_SERVER_ID: 'mcp_go' }, now: lb.clock.now, log: lb.brain.log });
    let taskId = '';
    let own: TasksService | null = null;
    // The stop lands after dispatch began and before the token exists, so stop() itself finds nothing to revoke.
    const computer = { ...real, armToken: async (tripId: string, until: Date) => {
      await own!.stop(taskId);
      await real.armToken(tripId, until);
    } };
    own = createTasks({ store, v1, computer, cards, link: lb.link, desk: lb.desk, packs: lb.brain.packs, now: lb.clock.now, log: lb.brain.log, follow: () => undefined });
    taskId = stableId('gt', 't_tok', 'tok1');
    const r = await own.start('t_tok', { ...VILLAS, key: 'tok1' });
    expect(r.taskId).toBe(taskId);
    await own.settled();
    expect((await store.get(taskId))?.state).toBe('stopped');
    expect(fake.callsTo('POST', /\/messages$/).some((c) => c.headers['idempotency-key'] === `go-msg-${taskId}`)).toBe(false);
    const token = fake.callsTo('PUT', /TRIP_TOKEN/).at(-1)!.body.value as string;
    expect(await tokens.tripFor(token)).toBeNull();
  });
});

describe('a stop and /v1 naming the job, in every order', () => {
  /**
   * Tasks over a store that runs `naming` (what the follower does when /v1's task.started arrives: record the start,
   * then mapStarts) at one exact point inside stop(): just before it records the stop, or just before it moves the job
   * to stopped. No sleeps: the start is held until that call.
   */
  function withNamingAt(at: 'update' | 'transition') {
    let naming: (() => Promise<void>) | null = null;
    const hooked: TaskStore = {
      ...store,
      async update(id, patch) {
        if (at === 'update' && naming && patch.stopRequestedAt) {
          const run = naming;
          naming = null;
          await run();
        }
        return store.update(id, patch);
      },
      async transition(id, from, to, patch) {
        if (at === 'transition' && naming && to === 'stopped') {
          const run = naming;
          naming = null;
          await run();
        }
        return store.transition(id, from, to, patch);
      },
    };
    const v1 = createV1Client({ baseUrl: fake.url, keys: KEYS, adminKey: ADMIN, sleep: async () => undefined });
    const computer = createComputer({ pool: db.pool, v1, tokens: createTokenStore(db.pool, lb.clock.now), env: { VESTRA_DEPLOYMENT_ID: 'dep_go', VESTRA_MCP_SERVER_ID: 'mcp_go' }, now: lb.clock.now, log: lb.brain.log });
    const own = createTasks({ store: hooked, v1, computer, cards, link: lb.link, desk: lb.desk, packs: lb.brain.packs, now: lb.clock.now, log: lb.brain.log, follow: () => undefined });
    return { own, nameAt: (run: () => Promise<void>) => { naming = run; } };
  }

  /** A job handed to /v1, which has started it; Go has not heard yet. */
  async function startedOnV1(own: TasksService, tripId: string): Promise<{ taskId: string; cardId: string; v1TaskId: string; turnId: string }> {
    const r = await own.start(tripId, { ...VILLAS, key: `${tripId}_job` });
    await own.settled();
    const row = (await store.get(r.taskId))!;
    const t = fake.startTask(row.conversationId!, row.v1TurnId!, row.title);
    return { taskId: r.taskId, cardId: r.cardId, v1TaskId: t.id, turnId: row.v1TurnId! };
  }

  const stopsSent = (v1TaskId: string) => fake.callsTo('POST', new RegExp(`^/v1/tasks/${v1TaskId}/stop$`)).length;

  async function expectStoppedOnce(own: TasksService, job: { taskId: string; cardId: string; v1TaskId: string }) {
    await own.settled();
    await cards.flush();
    expect(stopsSent(job.v1TaskId)).toBe(1);
    expect(fake.tasks.get(job.v1TaskId)?.stopped).toBe(true);
    expect(await store.get(job.taskId)).toMatchObject({ state: 'stopped', v1TaskId: job.v1TaskId });
    expect(lb.link.card(job.cardId)).toMatchObject({ state: 'failed', fallback_text: `Stopped: ${TITLE}` });
  }

  it('(a) named before the stop: the stop sends /v1 one stop', async () => {
    const { own } = withNamingAt('update');
    const job = await startedOnV1(own, 't_order_a');
    await store.recordStart(job.turnId, job.v1TaskId, TITLE);
    await own.mapStarts();
    expect((await store.get(job.taskId))?.state).toBe('running');
    await own.stop(job.taskId);
    await expectStoppedOnce(own, job);
  });

  it("(b) named between the stop's first read and the moment it records the stop: still one stop on /v1", async () => {
    const { own, nameAt } = withNamingAt('update');
    const job = await startedOnV1(own, 't_order_b1');
    nameAt(async () => {
      await store.recordStart(job.turnId, job.v1TaskId, TITLE);
      await own.mapStarts();
    });
    await own.stop(job.taskId);
    await expectStoppedOnce(own, job);
  });

  it('(b) named after the stop is recorded but before the job moves to stopped: one stop on /v1, not two', async () => {
    const { own, nameAt } = withNamingAt('transition');
    const job = await startedOnV1(own, 't_order_b2');
    nameAt(async () => {
      await store.recordStart(job.turnId, job.v1TaskId, TITLE);
      await own.mapStarts();
    });
    await own.stop(job.taskId);
    await expectStoppedOnce(own, job);
  });

  it('(c) named after the stop: mapStarts sees the stop and sends /v1 one stop', async () => {
    const { own } = withNamingAt('update');
    const r = await own.start('t_order_c', { ...VILLAS, key: 't_order_c_job' });
    await own.settled();
    const row = (await store.get(r.taskId))!;
    await own.stop(r.taskId);
    await own.settled();
    // /v1 starts it only now, and Go hears of it afterwards.
    const t = fake.startTask(row.conversationId!, row.v1TurnId!, row.title);
    await store.recordStart(row.v1TurnId!, t.id, row.title);
    await own.mapStarts();
    await expectStoppedOnce(own, { taskId: r.taskId, cardId: r.cardId, v1TaskId: t.id });
  });
});
