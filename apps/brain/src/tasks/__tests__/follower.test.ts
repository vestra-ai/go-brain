import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually } from '../testing/lane-brain.js';
import { createFollower, type Follower } from '../follower.js';
import { HARNESS_ADMIN, HARNESS_KEYS, VILLA_BRIEF, makeTaskHarness, type TaskHarness } from '../testing/harness.js';
import { createV1Client } from '../v1-client.js';

let h: TaskHarness;
let follower: Follower;
const noScreens = { tick: async () => undefined };

beforeAll(async () => {
  h = await makeTaskHarness({ autoStart: true });
  follower = createFollower({ v1: h.v1, store: h.store, streams: h.eventStore, apply: h.events.apply, screens: noScreens, log: h.lb.brain.log, reconnectMs: [10, 20], pollMs: 20, screenMs: 60_000 });
  h.onFollow = (c, t) => follower.ensure(c, t);
});
afterAll(async () => {
  await follower.close();
  await h.close();
});

const OPTIONS = { summary: 'Three villas.', options: [{ title: 'Villa Sol', area: 'Anjuna', price_minor: 1280000, price_note: 'per night', highlights: ['Private pool'], why: 'Pool.' }] };
const stateOf = async (id: string) => (await h.store.get(id))?.state;

describe('the follower', () => {
  it("follows a job's conversation: it starts, its to-do list ticks the card, it finishes, and the stream is let go", async () => {
    const r = await h.tasks.start('t_f1', { ...VILLA_BRIEF, key: 'f1' });
    await h.tasks.settled();
    await eventually(async () => (await stateOf(r.taskId)) === 'running');
    const row = (await h.store.get(r.taskId))!;
    expect(follower.following()).toContain(row.conversationId);
    h.fake.progress(row.v1TaskId!, [['Search stays', 'completed'], ['Read reviews', 'in_progress']]);
    await eventually(async () => ((await h.store.get(r.taskId))?.steps ?? []).some((s) => s.text === 'Read reviews' && s.state === 'doing'));
    h.fake.complete(row.v1TaskId!, OPTIONS, 'Three villas.');
    await eventually(async () => (await stateOf(r.taskId)) === 'done');
    await eventually(() => follower.following().length === 0);
    expect(h.lb.desk.items.filter((i) => i.id === `task:${r.taskId}:done`)).toHaveLength(1);
  });

  it('reopens a dropped stream from the last event number and applies every event once', async () => {
    h.fake.dropAfterFrames = 2;
    const r = await h.tasks.start('t_f2', { ...VILLA_BRIEF, key: 'f2' });
    await h.tasks.settled();
    await eventually(async () => (await stateOf(r.taskId)) === 'running');
    const row = (await h.store.get(r.taskId))!;
    h.fake.progress(row.v1TaskId!, [['Search stays', 'in_progress']]);
    const reads = () => h.fake.callsTo('GET', new RegExp(`/v1/conversations/${row.conversationId}/events$`));
    await eventually(() => reads().length >= 2);
    expect(reads().at(-1)!.headers['last-event-id']).toBeDefined();
    h.fake.progress(row.v1TaskId!, [['Search stays', 'completed'], ['Read reviews', 'in_progress']]);
    h.fake.complete(row.v1TaskId!, OPTIONS, 'Three villas.');
    await eventually(async () => (await stateOf(r.taskId)) === 'done');
    // The row reads done a moment before its wake is on the desk (the card goes first).
    await eventually(() => h.lb.desk.items.some((i) => i.id === `task:${r.taskId}:done`));
    expect(h.lb.desk.items.filter((i) => i.id === `task:${r.taskId}:done`)).toHaveLength(1);
  });

  it('follows from the head when the resume point is too old (410)', async () => {
    h.fake.autoStart = false;
    h.fake.failNextStream = { status: 410, code: 'stream_expired' };
    const r = await h.tasks.start('t_f3', { ...VILLA_BRIEF, key: 'f3' });
    await h.tasks.settled();
    const row = (await h.store.get(r.taskId))!;
    await eventually(() => h.fake.callsTo('GET', new RegExp(`/v1/conversations/${row.conversationId}$`)).length > 0);
    await eventually(() => h.fake.callsTo('GET', new RegExp(`/v1/conversations/${row.conversationId}/events$`)).some((c) => c.headers['last-event-id'] === '0'));
    const t = h.fake.startTask(row.conversationId!, row.v1TurnId!, row.title);
    await eventually(async () => (await stateOf(r.taskId)) === 'running');
    h.fake.complete(t.id, OPTIONS, 'Three villas.');
    await eventually(async () => (await stateOf(r.taskId)) === 'done');
    h.fake.autoStart = true;
  });

  it("polls the events as JSON when every key's streams are in use", async () => {
    const oneKey = createV1Client({ baseUrl: h.fake.url, keys: [HARNESS_KEYS[0]!], adminKey: HARNESS_ADMIN, sleep: async () => undefined });
    const polling = createFollower({ v1: oneKey, store: h.store, streams: h.eventStore, apply: h.events.apply, screens: noScreens, log: h.lb.brain.log, reconnectMs: [10], pollMs: 20, screenMs: 60_000 });
    h.onFollow = (c, t) => polling.ensure(c, t);
    h.fake.failNextStream = { status: 429, code: 'too_many_streams' };
    const r = await h.tasks.start('t_f4', { ...VILLA_BRIEF, key: 'f4' });
    await h.tasks.settled();
    await eventually(async () => (await stateOf(r.taskId)) === 'running');
    const row = (await h.store.get(r.taskId))!;
    expect(h.fake.callsTo('GET', new RegExp(`/v1/conversations/${row.conversationId}/events$`)).some((c) => c.query.format === 'json')).toBe(true);
    h.fake.complete(row.v1TaskId!, OPTIONS, 'Three villas.');
    await eventually(async () => (await stateOf(r.taskId)) === 'done');
    await polling.close();
    h.onFollow = (c, t) => follower.ensure(c, t);
  });
});
