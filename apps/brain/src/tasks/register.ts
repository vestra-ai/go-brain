/**
 * Lane C's tasks at boot: the /v1 client, the trip's computer (its two setup steps) and its ixigo recipe runners, tasks,
 * events, the follower, the sweep, the webhook endpoint, Go's MCP server, the job tools, Watch and Stop, the tasks block
 * and the task wake.
 * With the /v1 settings missing, jobs stay off and Go says so in the log.
 */
import type { Brain, RegisterLane } from '../app.js';
import { mcpCallRecorder, registerGoMcp } from '../mcp/routes.js';
import { createTokenStore } from '../mcp/tokens.js';
import { tripToday } from '../travel/dates.js';
import { createImages } from '../travel/images.js';
import { createResultsStore } from '../travel/results.js';
import { createCardUpdater } from './card-updater.js';
import { addComputerSteps, createComputer, type Computer } from './computer.js';
import { renderTaskWake, tasksNow } from './context.js';
import { readTasksEnv } from './env.js';
import { createEventStore } from './event-store.js';
import { createTaskEvents, type TaskEvents } from './events.js';
import { createFollower, type Follower, type FollowerDeps } from './follower.js';
import { createKeepWarm } from './keep-warm.js';
import { createScreens, SCREENS_PER_MINUTE_PER_KEY, type Screens } from './screens.js';
import { createTaskStore, type TaskStore } from './store.js';
import { SWEEP_EVERY_MS, createSweep, type Sweep } from './sweep.js';
import { registerTaskTaps } from './taps.js';
import { createTasks, type TasksService } from './tasks.js';
import { taskTools } from './tools.js';
import { createBrowserFetchRunner } from '../travel/recipes/runners.js';
import { createV1Client, type V1Client } from './v1-client.js';
import { registerV1Webhooks } from './webhooks.js';

export interface TasksLaneOptions {
  /** 0 turns the timed sweep off (tests run it by hand). */
  sweepEveryMs?: number;
  cardGapMs?: number;
  follower?: Partial<Pick<FollowerDeps, 'reconnectMs' | 'quietMs' | 'pollMs' | 'screenMs'>>;
}

export interface TasksLane {
  tasks: TasksService;
  events: TaskEvents;
  follower: Follower;
  sweep: Sweep;
  screens: Screens;
  computer: Computer;
  v1: V1Client;
  store: TaskStore;
}

export async function createTasksLane(brain: Brain, o: TasksLaneOptions = {}): Promise<TasksLane | null> {
  const env = readTasksEnv(brain.env);
  if (!env) {
    brain.log.warn('tasks: VESTRA_API_URL, VESTRA_API_KEYS, VESTRA_ADMIN_KEY, VESTRA_WEBHOOK_SECRET and VESTRA_DEPLOYMENT_ID are not all set, so jobs are off');
    return null;
  }
  const v1 = createV1Client({ baseUrl: env.VESTRA_API_URL, keys: env.VESTRA_API_KEYS, adminKey: env.VESTRA_ADMIN_KEY });
  const tokens = createTokenStore(brain.pool, brain.now);
  const computer = createComputer({ pool: brain.pool, v1, tokens, env, now: brain.now, log: brain.log });
  addComputerSteps(brain.setup, computer);
  // ixigo.com searches (TRAVEL_MODE ixigo_web) run on the trip's computer too, through its browser fetch, and the travel
  // lane keeps the computer awake while people talk travel.
  const keeper = createKeepWarm({ warm: (tripId, keepMs) => computer.warm(tripId, { keepMs }), now: brain.now, log: brain.log });
  brain.recipeRunners = {
    browserFetch: createBrowserFetchRunner({ v1, computer, now: brain.now, log: brain.log }),
    keepWarm: (tripId) => keeper.touch(tripId),
  };
  const store = createTaskStore(brain.pool);
  const eventStore = createEventStore(brain.pool, brain.now);
  const results = createResultsStore(brain.pool);
  const images = createImages({ pool: brain.pool, publicUrl: env.GO_PUBLIC_URL });
  const cards = createCardUpdater({ link: brain.door.link, log: brain.log, ...(o.cardGapMs !== undefined ? { gapMs: o.cardGapMs } : {}) });
  let following: Follower | null = null;
  const follow = (conversationId: string, tripId: string): void => following?.ensure(conversationId, tripId);
  const tasks = createTasks({
    store, v1, computer, cards, link: brain.door.link, desk: brain.desk, packs: brain.packs, now: brain.now, log: brain.log, follow,
    listingsSimulated: () => brain.travel?.simulated?.() === true,
  });
  const events = createTaskEvents({ store, tasks, v1, desk: brain.desk, results, packs: brain.packs, now: brain.now, log: brain.log });
  const screens = createScreens({
    v1, store, images, tasks, userIdFor: computer.userIdFor, now: brain.now, log: brain.log,
    perMinute: SCREENS_PER_MINUTE_PER_KEY * env.VESTRA_API_KEYS.length,
  });
  const follower = createFollower({ v1, store, streams: eventStore, apply: events.apply, screens, log: brain.log, ...(o.follower ?? {}) });
  following = follower;
  const sweep = createSweep({ v1, store, eventStore, tasks, events, computer, follow, desk: brain.desk, packs: brain.packs, now: brain.now, log: brain.log });

  await registerV1Webhooks(brain.http, { secrets: env.VESTRA_WEBHOOK_SECRET, events: eventStore, apply: events.apply, now: brain.now, log: brain.log });
  await registerGoMcp(brain.http, {
    packs: brain.packs,
    memory: () => brain.memory,
    travel: () => brain.travel,
    results,
    record: mcpCallRecorder(brain.pool, (tripId) => store.activeIds(tripId), brain.now),
    tokens,
    log: brain.log,
  });
  for (const t of taskTools({ tasks, today: tripToday(brain.pool, brain.now) })) brain.tools.register(t);
  registerTaskTaps(brain.taps, { store, tasks, v1, userIdFor: computer.userIdFor, log: brain.log });
  brain.context.addNow(tasksNow({ store, packs: brain.packs, now: brain.now }));
  brain.context.addWake('task', renderTaskWake);
  sweep.start(o.sweepEveryMs ?? SWEEP_EVERY_MS);
  // When Go stops (built.stop()): no new sweep, every stream and wait aborted, the last card updates sent.
  brain.onStop(async () => {
    await sweep.stop();
    await follower.close();
    await cards.flush();
  });
  brain.tasks = tasks;
  return { tasks, events, follower, sweep, screens, computer, v1, store };
}

export const registerTasks: RegisterLane = async (brain) => {
  await createTasksLane(brain);
};
