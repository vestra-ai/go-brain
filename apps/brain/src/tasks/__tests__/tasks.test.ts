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
    expect(follow.body).toMatchObject({ hand_off: 'auto', metadata: { go_task_id: r.taskId } });
    expect(follow.body.message).toContain('Also look in Assagao');
    await expect(tasks.message('gt_nope', 'x')).rejects.toMatchObject({ code: 'unknown_task' });
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
    await cards.flush();
    expect(lb.link.card(r.cardId)).toMatchObject({ state: 'failed', fallback_text: `Stopped: ${TITLE}`, actions: [] });
    expect(lb.desk.cancelled).toContainEqual({ tripId: 't_s', ref: r.taskId });
    expect(fake.tasks.get(v1Id)?.stopped).toBe(true);
  });

  it('stops a job on /v1 the moment /v1 names it, when the stop came first', async () => {
    const early = await tasks.start('t_s', { ...VILLAS, key: 'stop2' });
    await tasks.settled();
    await tasks.stop(early.taskId);
    const v1Id = await mapped(early.taskId);
    expect(fake.tasks.get(v1Id)?.stopped).toBe(true);
    expect((await store.get(early.taskId))?.state).toBe('stopped');
  });
});
