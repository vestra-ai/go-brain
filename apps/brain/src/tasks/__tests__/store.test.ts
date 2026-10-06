import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { createTaskStore, type NewTask, type TaskStore } from '../store.js';

let db: Awaited<ReturnType<typeof withSchema>>;
let store: TaskStore;
beforeAll(async () => {
  db = await withSchema();
  store = createTaskStore(db.pool);
});
afterAll(async () => {
  await db.drop();
});

const T0 = new Date('2026-10-07T12:00:00Z');
const task = (id: string, over: Partial<NewTask> = {}): NewTask => ({
  id, tripId: 't_goa', title: 'Finding villas', goal: 'Find villas', returnsKind: 'stays', returns: { type: 'object' }, context: { area: 'North Goa' },
  successCriteria: null, askedBy: 'p_meher', state: 'starting', cardId: `c_work_${id}`, steps: [{ text: 'Search', state: 'doing' }], deadlineAt: new Date(T0.getTime() + 480_000), createdAt: T0,
  ...over,
});

describe('task rows', () => {
  it('stores a job once and reads it back whole', async () => {
    expect(await store.insert(task('gt_a'))).toBe(true);
    expect(await store.insert(task('gt_a'))).toBe(false);
    expect(await store.get('gt_a')).toMatchObject({ id: 'gt_a', tripId: 't_goa', returnsKind: 'stays', returns: { type: 'object' }, context: { area: 'North Goa' }, state: 'starting', steps: [{ text: 'Search', state: 'doing' }], askedBy: 'p_meher', v1TaskId: null, createdAt: T0 });
    expect(await store.get('gt_nope')).toBeNull();
  });

  it('moves state only from the states named, so a late or repeated event changes nothing', async () => {
    await store.insert(task('gt_b'));
    expect(await store.transition('gt_b', ['starting'], 'running', { startedAt: T0 })).toBe(true);
    expect(await store.transition('gt_b', ['running'], 'done', { endedAt: T0, endReason: 'completed', result: { options: [] } })).toBe(true);
    expect(await store.transition('gt_b', ['running', 'needs_you'], 'failed')).toBe(false);
    expect(await store.get('gt_b')).toMatchObject({ state: 'done', endReason: 'completed', result: { options: [] } });
    await store.update('gt_b', { steps: [{ text: 'Done', state: 'done' }], screenshotUrl: 'https://go.test/img/i1.jpg' });
    expect(await store.get('gt_b')).toMatchObject({ steps: [{ text: 'Done', state: 'done' }], screenshotUrl: 'https://go.test/img/i1.jpg' });
  });

  it('maps a task start /v1 announced to the job whose message started it, once', async () => {
    await store.insert(task('gt_c'));
    await store.setTurn('gt_c', 'conv_1', 'turn_9');
    await store.recordStart('turn_9', 'task_77', 'Find villas');
    await store.recordStart('turn_9', 'task_77', 'Find villas');
    expect(await store.matchStarts()).toEqual([{ id: 'gt_c', v1TaskId: 'task_77' }]);
    expect(await store.matchStarts()).toEqual([]);
    expect((await store.byV1Task('task_77'))?.id).toBe('gt_c');
    expect(await store.hasActiveIn('conv_1')).toBe(true);
  });

  it('counts the active jobs of a trip and finds the oldest waiting one', async () => {
    await store.insert(task('gt_q1', { tripId: 't_q', state: 'queued', deadlineAt: null, createdAt: new Date(T0.getTime() + 1) }));
    await store.insert(task('gt_q2', { tripId: 't_q', state: 'queued', deadlineAt: null, createdAt: new Date(T0.getTime() + 2) }));
    await store.insert(task('gt_r1', { tripId: 't_q', state: 'running' }));
    expect(await store.countActive('t_q')).toBe(1);
    expect((await store.activeIds('t_q')).sort()).toEqual(['gt_r1']);
    expect((await store.oldestQueued('t_q'))?.id).toBe('gt_q1');
    expect((await store.listLive('t_q')).map((t) => t.id).sort()).toEqual(['gt_q1', 'gt_q2', 'gt_r1']);
  });

  it("takes a trip's job slots one at a time: five starts at once leave two queued, and a freed slot goes to one job", async () => {
    const states = await Promise.all(Array.from({ length: 5 }, (_, i) => store.insertCapped(task(`gt_cap${i}`, { tripId: 't_cap', createdAt: new Date(T0.getTime() + i) }), 3)));
    expect(states.filter((st) => st === 'queued')).toHaveLength(2);
    expect(states.filter((st) => st === 'starting')).toHaveLength(3);
    expect(await store.countActive('t_cap')).toBe(3);
    for (const q of (await store.listLive('t_cap')).filter((r) => r.state === 'queued')) expect(q.deadlineAt).toBeNull();
    expect(await store.insertCapped(task('gt_cap0', { tripId: 't_cap' }), 3)).toBeNull();
    const first = (await store.listLive('t_cap')).find((r) => r.state === 'starting')!;
    await store.transition(first.id, ['starting'], 'done', { endedAt: T0 });
    const later = new Date(T0.getTime() + 60_000);
    const deadline = new Date(T0.getTime() + 540_000);
    const promoted = await Promise.all([store.promoteQueued('t_cap', 3, later, deadline), store.promoteQueued('t_cap', 3, later, deadline)]);
    expect(promoted.filter((r) => r !== null)).toHaveLength(1);
    expect(promoted.find((r) => r !== null)).toMatchObject({ state: 'starting', startingAt: later, deadlineAt: deadline });
    expect(await store.countActive('t_cap')).toBe(3);
  });

  it('keeps the asks a job raised, once each, and settles them', async () => {
    await store.insert(task('gt_i'));
    const ask = { interactionId: 'int_1', taskId: 'gt_i', tripId: 't_goa', type: 'question', summary: 'Which dates?', questions: [{ question: 'Which dates?', options: ['6 to 9 Nov', '13 to 16 Nov'] }], forPersonIds: [], createdAt: T0 };
    expect(await store.addInteraction(ask)).toBe(true);
    expect(await store.addInteraction(ask)).toBe(false);
    expect((await store.openInteractions('gt_i')).map((i) => i.interactionId)).toEqual(['int_1']);
    expect((await store.allOpenInteractions()).some((i) => i.interactionId === 'int_1')).toBe(true);
    await store.setInteraction('int_1', 'answered', T0);
    expect(await store.openInteractions('gt_i')).toEqual([]);
  });
});
