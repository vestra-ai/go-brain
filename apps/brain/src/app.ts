import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from 'fastify';
import type pg from 'pg';
import { createSwitches, type Switches } from './admin/switches.js';
import { createBudget, type Budget } from './budget.js';
import { anthropicClient, type AnthropicLike } from './composer/anthropic.js';
import { createContext, type Context } from './composer/context.js';
import { createSpeak } from './composer/speak.js';
import { createTools, type Tools } from './composer/tools.js';
import { createComposer } from './composer/turn.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { createDesk, type Desk, type TurnRunner } from './desk/desk.js';
import { createCardStore } from './door/cards.js';
import { createDoor } from './door/door.js';
import type { Door } from './door/handlers.js';
import { createReplayGuard } from './door/replay-guard.js';
import { createServerLink } from './door/server-link.js';
import { createTapRouter, type TapRouter } from './door/taps.js';
import { newUlid } from './door/ulid.js';
import type { Env } from './env.js';
import type { Memory } from './memory/memory.js';
import type { Pay } from './money/pay.js';
import { unsureReflex, type Reflex } from './reflex/reflex.js';
import type { Browsers } from './tasks/browsers.js';
import type { Tasks } from './tasks/tasks.js';
import type { RecipeStat } from './travel/book/engine.js';
import type { IxigoLogin } from './travel/login.js';
import type { TripWatches } from './travel/recipe-watches.js';
import type { RecipeRunner } from './travel/recipes/runners.js';
import type { ScreenStream } from './travel/screen-feed.js';
import type { Travel } from './travel/travel.js';
import { createGoneTrips } from './trips/gone.js';
import { createMessageHooks, type MessageHooks } from './trips/hooks.js';
import { createIntake } from './trips/intake.js';
import { createTripLog, type TripLog } from './trips/log.js';
import { createPacks, type Packs } from './trips/pack.js';
import { createSetup, type Setup } from './trips/setup.js';

/**
 * What every lane receives at boot. main.ts calls the lanes in this order: registerRoom, registerReflex,
 * registerMemory, registerStats, registerTravel, registerTasks, registerMoney, registerProactive,
 * registerCalls, registerAdmin. A lane that has not landed yet is simply not called.
 */
export interface Brain {
  env: Env;
  pool: pg.Pool;
  log: FastifyBaseLogger;
  now: () => Date;
  http: FastifyInstance;
  /** The model client buildBrain was given; every lane's side model uses it (so tests and the bench inject a fake). */
  anthropic: AnthropicLike;
  /**
   * Lanes stop their timers, streams and sockets here. `built.stop()` runs every stopper in reverse order of
   * registration (each awaited; one that throws is logged and the rest still run), then closes the HTTP server and the pool.
   */
  onStop(fn: () => Promise<void> | void): void;
  door: Door;
  taps: TapRouter;
  tripLog: TripLog;
  packs: Packs;
  setup: Setup;
  desk: Desk;
  tools: Tools;
  context: Context;
  hooks: MessageHooks;
  switches: Switches;
  /** P1 sets an all-unsure stub; P2 replaces it. */
  reflex: Reflex;
  /**
   * True once Go's post of a card has answered (door/cards.ts posted), waiting at most withinMs: for a card a lane changes
   * from work that runs while the turn posting it still goes (the top pick's photos). Set by P1.
   */
  cardPosted?: (tripId: string, cardId: string, withinMs: number) => Promise<boolean>;
  /** Set by P2. */
  memory?: Memory;
  /** Set by P4. */
  travel?: Travel;
  /** Set by P4. */
  tasks?: Tasks;
  /**
   * Set by P4's tasks lane, which owns the computers. All of these use the trip's browser, the organizer's own computer
   * shared by all of their trips (tasks/browsers.ts), never the trip's job computer: the browser fetch the recipe engine
   * reads ixigo.com pages with; keepWarm, which holds the computer awake for two minutes (Bash's warm keep_ms), which only travel's
   * warmForTravel calls; start, which makes the trip's computer (or wakes it) with no hold, for travel's setup step and a
   * watch's check, and says whether it was up ('ready'), is on its way ('waking'), or was woken in the last minute
   * ('skipped'); prime, the computer's first ixigo visit, travel's next setup step (it throws when ixigo did not answer);
   * and watch, Bash's browser watch of the trip's computer (never a wake), for the live view's screen (screen-feed.ts).
   */
  recipeRunners?: {
    browserFetch: RecipeRunner;
    keepWarm(tripId: string): void;
    /** Holds the trip's computer awake keepMs once it is up (Bash's warm keep_ms), for the keepalive while people talk. */
    keepAwake?(tripId: string, keepMs: number): Promise<'ready' | 'waking'>;
    /**
     * A person is active in the trip before typing (they opened its room after a while, or tapped a card): its computer
     * is held awake as when they post (tasks/awake.ts), so their first ask never waits for it to wake. Fire and forget.
     */
    roomActive?(tripId: string): void;
    start(tripId: string): Promise<'ready' | 'waking' | 'skipped'>;
    prime(tripId: string): Promise<void>;
    watch(tripId: string, signal: AbortSignal): Promise<ScreenStream>;
    /**
     * A fresh 15-minute session on the trip's screen, in control or to view (POST /v1/sessions): the ixigo login's Watch.
     * driver: user puts a control screen in the person's hands from the first frame, with no Take control.
     */
    screen(tripId: string, mode: 'view' | 'control', o?: { driver?: 'user' }): Promise<{ id?: string; url: string; expires_at: string }>;
    /** Ends a session now (DELETE /v1/sessions/{id}): its Watch closes itself, and its control ends with it. */
    endScreen?(sessionId: string): Promise<void>;
    /** Where the trip's browser's ixigo login stands: one browser, and one login, for every trip of its organizer. */
    login?: Pick<Browsers, 'login' | 'setLogin' | 'loggedInSince'>;
  };
  /** Set by P4's travel lane: how fast each ixigo recipe answers, for the admin's health view. */
  recipeStats?: () => RecipeStat[];
  /** Set by the travel lane: the watches groups asked for that are going, per trip, for the admin's health view. */
  recipeWatches?: () => Promise<TripWatches[]>;
  /**
   * Set by the travel lane: the trip's ixigo login (travel/login.ts). personGone logs the trip's computer out of ixigo
   * when the login is that person's: travel calls it when they leave; "Forget me" in the trip should call it too.
   */
  ixigoLogin?: Pick<IxigoLogin, 'personGone'>;
  /** Set by P5. */
  pay?: Pay;
  /** The daily model budget (MODEL_DAILY_BUDGET_USD). buildBrain always sets it; it is optional only so lane test doubles need not. */
  budget?: Budget;
}

export type RegisterLane = (brain: Brain) => void | Promise<void>;

export interface Timings {
  pingMs: number;
  idleMs: number;
  /** The wait after a message for Go. */
  waitMs: number;
  deskPollMs: number;
  deskRetryMs: number[];
  leaseMs: number;
  typingEveryMs: number;
  setupSweepMs: number;
  /** The once-a-minute re-read of active trips. */
  refreshMs: number;
  pruneMs: number;
  /** How often the daily model budget re-reads today's spend from the database. */
  budgetRefreshMs: number;
  turnTimeoutMs: number;
  /** The least an untagged turn's typing shows before its post (composer TYPING_MIN_MS). */
  typingMinMs: number;
  linkTimeoutMs: number;
  waitForSocketMs: number;
}

export const DEFAULT_TIMINGS: Timings = {
  pingMs: 20_000,
  idleMs: 40_000,
  waitMs: 2_000,
  deskPollMs: 1_000,
  deskRetryMs: [1_000, 4_000],
  leaseMs: 60_000,
  typingEveryMs: 5_000,
  setupSweepMs: 120_000,
  refreshMs: 60_000,
  pruneMs: 60_000,
  budgetRefreshMs: 60_000,
  turnTimeoutMs: 20_000,
  typingMinMs: 1_200,
  linkTimeoutMs: 2_500,
  waitForSocketMs: 15_000,
};

export interface BuildOptions {
  /** Tests pass a pool on their own schema; otherwise one is made from DATABASE_URL. */
  pool?: pg.Pool;
  /** Tests pass a scripted model; otherwise the real client with ANTHROPIC_API_KEY. */
  anthropic?: AnthropicLike;
  now?: () => Date;
  logger?: boolean;
  /** Tests wrap the composer's turn to make it crash at a chosen moment. */
  wrapTurn?: (run: TurnRunner) => TurnRunner;
  timings?: Partial<Timings>;
}

export interface Built {
  brain: Brain;
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
}

/**
 * How a request line is logged. A backstop: no route reads a token from a URL, and the routes that might see one log at
 * warn, but any token= that still reaches a logged URL is blanked.
 */
export function logRequest(req: Pick<FastifyRequest, 'method' | 'url' | 'host' | 'ip'>): { method: string; url: string; host: string; remoteAddress: string } {
  return { method: req.method, url: req.url.replace(/([?&;]token=)[^&;#]*/gi, '$1[hidden]'), host: req.host, remoteAddress: req.ip };
}

export async function buildBrain(env: Env, o: BuildOptions = {}): Promise<Built> {
  const now = o.now ?? (() => new Date());
  const t: Timings = { ...DEFAULT_TIMINGS, ...o.timings };
  const http = Fastify({ logger: o.logger === false ? false : { level: env.LOG_LEVEL, serializers: { req: logRequest } } });
  const log = http.log;
  const pool = o.pool ?? createPool(env.DATABASE_URL);
  await migrate(pool);

  const cards = createCardStore({ pool, now });
  // A trip the Server answers 404 for is gone: its pack goes, and every sweep leaves it alone (trips.gone_at).
  const gone = createGoneTrips({ pool, log, now, dropped: (tripId) => packs.invalidate(tripId) });
  const link = createServerLink({
    pool, log, now, timeoutMs: t.linkTimeoutMs, waitForSocketMs: t.waitForSocketMs, onSend: cards.sending,
    onResult: async (method, params, result, stored) => {
      await cards.observe(method, params, result, stored);
      await gone.answered(method, params);
    },
    onFail: async (method, params, err, instance) => {
      await cards.failed(method, params);
      await gone.failed(method, params, err, instance);
    },
  });
  const guard = createReplayGuard({ pool, now });
  const door = createDoor({
    http, secret: env.GO_SIGNING_SECRET, guard, link, log, now, pingMs: t.pingMs, idleMs: t.idleMs,
    // Read at each request: the tasks lane sets the trip computer's hold after the door is made.
    onTripActive: (tripId) => brain.recipeRunners?.roomActive?.(tripId),
  });
  const taps = createTapRouter({ pool, cards, log });
  // send_event's answer waits on one write only, on connections of its own: never behind the work of earlier events on
  // the main pool (GO-TEAM-FINAL §6, 10 Oct: mandate.set took 2,142 ms, the promise is 2 s).
  const appendPool = o.pool ? undefined : createPool(env.DATABASE_URL, { max: 2 });
  const tripLog = createTripLog({ pool, log, now, ...(appendPool ? { appendPool } : {}) });
  const packs = createPacks({ pool, link, log, now });
  const hooks = createMessageHooks(log);
  const setup = createSetup({ pool, log, now });
  const desk = createDesk({
    pool, log, now, holder: `brain-${process.pid}-${newUlid()}`, pollMs: t.deskPollMs, leaseMs: t.leaseMs, retryDelaysMs: t.deskRetryMs,
  });
  const tools = createTools();
  const context = createContext(log);
  const speak = createSpeak({ pool, link, now, everyMs: t.typingEveryMs });
  const switches = createSwitches({
    pool, now,
    env: {
      TRAVEL_MODE: env.TRAVEL_MODE, TRAVEL_RUNNER: env.TRAVEL_RUNNER, PAY_RAIL: env.PAY_RAIL, CALLS_MODE: env.CALLS_MODE, REFLEX_LIVE: env.REFLEX_LIVE,
      BROWSER_FETCH_SLOTS: env.BROWSER_FETCH_SLOTS, RECIPE_WATCHES: env.RECIPE_WATCHES, BOOKING: env.BOOKING,
    },
  });

  // One model client for the composer and every lane's side passes: a test's fake or the bench's recorder reaches all of them.
  const anthropic = o.anthropic ?? anthropicClient(env.ANTHROPIC_API_KEY);
  const budget = createBudget({ pool, now, capUsd: env.MODEL_DAILY_BUDGET_USD ?? null, log });
  // What stop() runs, newest first: lanes register after buildBrain returns, so their timers stop while the room is still up.
  const stoppers: Array<() => Promise<void> | void> = [];
  const onStop = (fn: () => Promise<void> | void): void => {
    stoppers.push(fn);
  };
  const brain: Brain = {
    env, pool, log, now, http, anthropic, onStop, door, taps, tripLog, packs, setup, desk, tools, context, hooks, switches, reflex: unsureReflex, budget,
    cardPosted: cards.posted,
  };

  const composer = createComposer({
    pool, log, now, link, packs, tools, context, speak,
    client: anthropic,
    model: env.COMPOSER_MODEL,
    budget,
    claimNew: desk.claimNew,
    release: desk.release,
    turnTimeoutMs: t.turnTimeoutMs,
    typingMinMs: t.typingMinMs,
  });
  desk.setRunner(o.wrapTurn ? o.wrapTurn(composer.runTurn) : composer.runTurn, composer.giveUp);

  // send_event and card_tap need the trip log, packs and setup internals, so they are wired here, not in a lane.
  const intake = createIntake({
    pool, log, now, tripLog, packs, setup, desk, speak, hooks,
    reflex: () => brain.reflex,
    runningTasks: async (tripId) => (await brain.tasks?.running(tripId)) ?? [],
    waitMs: t.waitMs,
    away: (tripId) => link.away(tripId),
    rehome: (tripId, home) => link.rehome(tripId, home),
  });
  door.handle('send_event', intake.sendEvent);
  door.handle('card_tap', taps.handle);

  // P1's own stops go through the same rail as every lane's, registered first so they run last:
  // the setup sweep, the minute refresh and the prune, then the link, the desk poller and its turns, then typing.
  const timers: NodeJS.Timeout[] = [];
  onStop(() => speak.stopAll());
  onStop(() => desk.stop());
  onStop(() => link.close());
  onStop(() => {
    for (const x of timers) clearInterval(x);
  });

  let listening = false;
  return {
    brain,
    async start() {
      await switches.refresh();
      await budget.refresh();
      await http.listen({ port: env.PORT, host: '0.0.0.0' });
      listening = true;
      desk.start();
      await intake.recover();
      void link.resumePending().catch((e: unknown) => log.warn({ err: e }, 'resending writes after a restart failed'));
      // unref: these never keep the process alive on their own; the stopper above clears them.
      timers.push(
        setInterval(() => void setup.sweep().catch((e: unknown) => log.warn({ err: e }, 'the setup sweep failed')), t.setupSweepMs).unref(),
        setInterval(() => void intake.refreshActive().catch((e: unknown) => log.warn({ err: e }, 'the trip refresh failed')), t.refreshMs).unref(),
        setInterval(() => void guard.prune().catch((e: unknown) => log.warn({ err: e }, 'pruning signatures failed')), t.pruneMs).unref(),
        setInterval(() => void budget.refresh().catch((e: unknown) => log.warn({ err: e }, 'reading the model budget failed')), t.budgetRefreshMs).unref(),
      );
      const addr = http.server.address();
      return { port: typeof addr === 'object' && addr ? addr.port : env.PORT };
    },
    async stop() {
      // Newest first. splice(0) empties the list, so a second stop() runs nothing twice.
      for (const fn of stoppers.splice(0).reverse()) {
        try {
          await fn();
        } catch (e) {
          log.warn({ err: e }, 'a stopper failed; stopping the rest');
        }
      }
      door.close();
      if (listening) await http.close();
      await intake.idle();
      if (!o.pool) await pool.end();
      await appendPool?.end();
    },
  };
}
