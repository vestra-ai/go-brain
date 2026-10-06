import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createV1Client } from '../../v1-client.js';
import { FakeV1 } from '../fake-v1.js';

const KEYS = [`vk_test_${'a'.repeat(43)}`];
const ADMIN = `vk_test_${'z'.repeat(43)}`;
const fake = new FakeV1({ keys: KEYS, adminKey: ADMIN, now: () => new Date('2026-10-07T12:00:00Z') });
let v1: ReturnType<typeof createV1Client>;

beforeAll(async () => {
  await fake.start();
  v1 = createV1Client({ baseUrl: fake.url, keys: KEYS, adminKey: ADMIN, sleep: async () => undefined });
});
afterAll(async () => {
  await fake.close();
});

describe('the fake /v1', () => {
  it('creates users only with the admin key, and replays an idempotent conversation create', async () => {
    await expect(v1.call('POST', '/v1/users', { body: { user_id: 'gotrip-1' } })).rejects.toMatchObject({ status: 403, code: 'scope_missing' });
    await v1.call('POST', '/v1/users', { admin: true, body: { user_id: 'gotrip-1' } });
    const a = await v1.call<{ id: string }>('POST', '/v1/conversations', { idempotencyKey: 'go-conv-1', body: { user_id: 'gotrip-1', deployment: 'dep_go' } });
    const b = await v1.call<{ id: string }>('POST', '/v1/conversations', { idempotencyKey: 'go-conv-1', body: { user_id: 'gotrip-1', deployment: 'dep_go' } });
    expect(b.id).toBe(a.id);
  });

  it('starts a task from a hand_off message on the stream, resumes after Last-Event-ID, and cuts streams on demand', async () => {
    const conv = await v1.call<{ id: string }>('POST', '/v1/conversations', { body: { user_id: 'gotrip-1' } });
    const turn = await v1.call<{ id: string }>('POST', `/v1/conversations/${conv.id}/messages`, { idempotencyKey: 'go-msg-1', body: { message: 'Find a villa', hand_off: 'always' } });
    await new Promise((r) => setTimeout(r, 20));
    const task = fake.lastTask()!;
    expect(task.turnId).toBe(turn.id);
    fake.progress(task.id, [['Search stays', 'in_progress']]);
    fake.dropAfterFrames = 1;
    const first = await v1.stream(`/v1/conversations/${conv.id}/events`, { lastEventId: null });
    const seen: number[] = [];
    await (async () => {
      for await (const f of first.frames) if (f.id !== null) seen.push(f.id);
    })().catch(() => undefined);
    expect(seen).toEqual([1]);
    const second = await v1.stream(`/v1/conversations/${conv.id}/events`, { lastEventId: 1 });
    const it2 = second.frames[Symbol.asyncIterator]();
    expect((await it2.next()).value).toMatchObject({ id: 2, event: 'task.progress' });
    expect(fake.cutStreams()).toBe(1);
    expect(await it2.next().then((r) => r.done, () => true)).toBe(true);
    second.close();
    expect(fake.callsTo('GET', /\/events$/).at(-1)!.headers['last-event-id']).toBe('1');
  });

  it('lists only webhook kinds on GET /v1/events, oldest first after an id', async () => {
    const all = await v1.call<{ data: Array<{ id: string; type: string }> }>('GET', '/v1/events', { query: { limit: 100 } });
    expect(all.data.map((e) => e.type)).not.toContain('task.progress');
    const oldest = all.data.at(-1)!;
    const after = await v1.call<{ data: Array<{ id: string }> }>('GET', '/v1/events', { query: { after: oldest.id } });
    expect(after.data.map((e) => e.id)).toEqual(all.data.slice(0, -1).reverse().map((e) => e.id));
  });

  it('keeps turns as /v1 does: a follow-up waits for the next run, each run settles the turns it took, idle only at the end', async () => {
    const conv = await v1.call<{ id: string }>('POST', '/v1/conversations', { body: { user_id: 'gotrip-1' } });
    fake.autoStart = false;
    const start = await v1.call<{ id: string }>('POST', `/v1/conversations/${conv.id}/messages`, { body: { message: 'Find a villa', hand_off: 'always' } });
    const task = fake.startTask(conv.id, start.id, 'Find a villa', { queued: true });
    const follow = await v1.call<{ id: string }>('POST', `/v1/conversations/${conv.id}/messages`, { body: { message: 'Also pets', hand_off: 'auto' } });
    expect(task.inbox).toEqual([start.id, follow.id]);
    const status = async () => (await v1.call<{ status: string }>('GET', `/v1/conversations/${conv.id}`)).status;
    fake.nextRun(task.id, [follow.id]);
    fake.complete(task.id, null, 'pets');
    expect(await status()).toBe('working');
    expect(fake.turns.get(follow.id)?.status).toBe('completed');
    expect(fake.turns.get(start.id)?.status).toBe('working');
    fake.nextRun(task.id);
    fake.complete(task.id, { summary: 'Villas.' }, 'Villas.');
    expect(await status()).toBe('idle');
    const settled = fake.conversations.get(conv.id)!.events.filter((e) => e.type === 'conversation.status').map((e) => [e.data.turn_id, e.data.status]);
    expect(settled).toEqual([[follow.id, 'working'], [start.id, 'idle']]);
    expect(fake.conversations.get(conv.id)!.events.filter((e) => e.type === 'task.completed')).toHaveLength(2);
    fake.autoStart = true;
  });

  it('answers a view session, and refuses control unless shared control is on', async () => {
    const view = await v1.call<{ url: string; expires_at: string }>('POST', '/v1/sessions', { body: { user_id: 'gotrip-1', screen: 'view' } });
    expect(view.url).toMatch(/^https:\/\//);
    expect(view.expires_at).toBe('2026-10-07T12:15:00.000Z');
    await expect(v1.call('POST', '/v1/sessions', { body: { user_id: 'gotrip-1', screen: 'control' } })).rejects.toMatchObject({ status: 409, code: 'screen_control_unavailable' });
  });
});
