/**
 * Lane C's task harness for tests: a fresh schema, the lane brain, a fake /v1, and the real task store, computer,
 * tasks and events wired the way registerTasks wires them.
 */
import type pg from 'pg';
import { withSchema } from '../../db/test-db.js';
import { createTokenStore } from '../../mcp/tokens.js';
import { createResultsStore, type ResultsStore } from '../../travel/results.js';
import { createCardUpdater, type CardUpdater } from '../card-updater.js';
import { createComputer, type Computer } from '../computer.js';
import { createEventStore, type EventStore } from '../event-store.js';
import { createTaskEvents, type TaskEvents } from '../events.js';
import { returnsSchema } from '../returns.js';
import { createTaskStore, type TaskRow, type TaskStore } from '../store.js';
import { createTasks, type TaskBrief, type TasksService } from '../tasks.js';
import { createV1Client, type V1Client } from '../v1-client.js';
import { FakeV1 } from './fake-v1.js';
import { makeLaneBrain, type LaneBrain } from './lane-brain.js';

export const HARNESS_KEYS = [`vk_test_${'a'.repeat(43)}`, `vk_test_${'b'.repeat(43)}`];
export const HARNESS_ADMIN = `vk_test_${'z'.repeat(43)}`;

export const VILLA_BRIEF: TaskBrief = {
  goal: 'Find a villa with a pool in North Goa under 8k a head, near the beach',
  returns: returnsSchema('stays'),
  context: { area: 'North Goa', people: 5 },
  title: 'Finding villas with a pool in North Goa',
  steps: ['Search stays', 'Read reviews', 'Pick three'],
  returnsKind: 'stays',
  askedBy: 'p_meher',
};

export interface TaskHarness {
  pool: pg.Pool;
  lb: LaneBrain;
  fake: FakeV1;
  v1: V1Client;
  store: TaskStore;
  eventStore: EventStore;
  results: ResultsStore;
  cards: CardUpdater;
  computer: Computer;
  tasks: TasksService;
  events: TaskEvents;
  /** Told when a job reaches a conversation; a test sets it to a real follower. */
  onFollow: ((conversationId: string, tripId: string) => void) | null;
  /** The villa job, started, handed to /v1 and named by it (task.started applied). Needs fake.autoStart off. */
  runningJob(key: string, tripId?: string): Promise<{ row: TaskRow; v1TaskId: string }>;
  close(): Promise<void>;
}

export async function makeTaskHarness(o: { autoStart?: boolean; cardGapMs?: number } = {}): Promise<TaskHarness> {
  const db = await withSchema();
  const lb = makeLaneBrain({ pool: db.pool });
  const fake = new FakeV1({ keys: HARNESS_KEYS, adminKey: HARNESS_ADMIN, now: lb.clock.now });
  fake.autoStart = o.autoStart ?? false;
  await fake.start();
  const v1 = createV1Client({ baseUrl: fake.url, keys: HARNESS_KEYS, adminKey: HARNESS_ADMIN, sleep: async () => undefined });
  const store = createTaskStore(db.pool);
  const eventStore = createEventStore(db.pool, lb.clock.now);
  const results = createResultsStore(db.pool);
  const cards = createCardUpdater({ link: lb.link, log: lb.brain.log, gapMs: o.cardGapMs ?? 0 });
  const computer = createComputer({
    pool: db.pool, v1, tokens: createTokenStore(db.pool, lb.clock.now), env: { VESTRA_DEPLOYMENT_ID: 'dep_go', VESTRA_MCP_SERVER_ID: 'mcp_go' }, now: lb.clock.now, log: lb.brain.log,
  });
  let onFollow: TaskHarness['onFollow'] = null;
  const tasks = createTasks({
    store, v1, computer, cards, link: lb.link, desk: lb.desk, packs: lb.brain.packs, now: lb.clock.now, log: lb.brain.log,
    follow: (conversationId, tripId) => onFollow?.(conversationId, tripId),
  });
  const events = createTaskEvents({ store, tasks, v1, desk: lb.desk, results, packs: lb.brain.packs, now: lb.clock.now, log: lb.brain.log });
  return {
    pool: db.pool, lb, fake, v1, store, eventStore, results, cards, computer, tasks, events,
    get onFollow() {
      return onFollow;
    },
    set onFollow(f) {
      onFollow = f;
    },
    async runningJob(key, tripId = 't_goa') {
      const r = await tasks.start(tripId, { ...VILLA_BRIEF, key });
      await tasks.settled();
      const row = await store.get(r.taskId);
      if (!row?.conversationId || !row.v1TurnId) throw new Error(`job ${key} did not reach /v1`);
      const t = fake.startTask(row.conversationId, row.v1TurnId, row.title);
      await events.apply({ type: 'task.started', data: { task_id: t.id, title: row.title, turn_id: row.v1TurnId }, source: 'stream' });
      await cards.flush();
      return { row: (await store.get(r.taskId))!, v1TaskId: t.id };
    },
    async close() {
      await cards.flush();
      await fake.close();
      await db.drop();
    },
  };
}
