// Wires proactive Go into the service: openings from the chat and trip changes, timers, watches, the
// promoter, the wake text, the openings block, the notice tools and the demo's "fire a watch".
import type { Brain, RegisterLane } from '../app.js';
import type { Trip } from '../door/methods.js';
import type { Travel } from '../travel/travel.js';
import { registerFireRoute } from '../watches/admin.js';
import { noteWatchNotice, syncWatches } from '../watches/plan.js';
import { createWatchRunner } from '../watches/runner.js';
import { composerRules } from './allowed.js';
import { noticeTools } from './notice-tools.js';
import { createOpenings } from './openings.js';
import { PROACTIVE_KINDS, type ProactivePayload } from './payload.js';
import { createPromoter } from './promoter.js';
import { ProactiveStore } from './store.js';
import { replanTimers } from './timers.js';
import { openingsNow, renderWake } from './wake.js';

export const PROMOTE_EVERY_MS = 15_000;
export const WATCH_EVERY_MS = 30_000;
export const SWEEP_EVERY_MS = 10 * 60_000;
export const ACTIVE_TRIP_DAYS = 90;

export interface ProactiveHandles {
  store: ProactiveStore;
  promote(): Promise<number>;
  checkWatches(): Promise<number>;
  sweep(): Promise<void>;
  stop(): void;
}

export interface StartProactiveOpts {
  /** Tests pass false and drive the passes by hand. */
  intervals?: boolean;
  /** Overrides `brain.travel` for the watches; null turns watches off. */
  travel?: Pick<Travel, 'status'> | null;
}

export async function startProactive(brain: Brain, opts: StartProactiveOpts = {}): Promise<ProactiveHandles> {
  // The bar's limits are enforced by P1's turn (master §6.3: Context.addTurnRules). Without it a proactive
  // turn could post or act beyond what the bar allowed, so refuse to start, before anything is registered.
  if (typeof brain.context.addTurnRules !== 'function') {
    const why = 'proactive: P1 has no Context.addTurnRules (master §6.3), so the bar cannot limit proactive turns; not starting';
    brain.log.error(why);
    throw new Error(why);
  }
  const store = new ProactiveStore(brain.pool);
  const log = brain.log;
  const promoter = createPromoter({ store, desk: brain.desk, packs: brain.packs, now: brain.now, log });
  const travel = opts.travel !== undefined ? opts.travel : (brain.travel ?? null);
  const watches = createWatchRunner({ pool: brain.pool, travel, store, now: brain.now, log });
  const readTrip = (tripId: string): Promise<Trip> => brain.door.link.request('read_trip', { trip_id: tripId });
  const replan = async (tripId: string, trip: Trip): Promise<void> => {
    await replanTimers(store, trip, await store.tripTz(tripId), brain.now());
    await syncWatches(brain.pool, trip, brain.now());
  };
  const openings = createOpenings({ store, packs: brain.packs, readTrip, replan, now: brain.now });

  brain.hooks.onRead((msg, read, pack) => openings.onRead(msg, read, pack));
  brain.tripLog.onEvent((ev) => openings.onEvent(ev));
  for (const kind of PROACTIVE_KINDS) brain.context.addWake(kind, (item, pack) => renderWake(item, pack, brain.now()));
  brain.context.addNow(openingsNow());
  brain.context.addTurnRules(composerRules);
  const onPosted = async (p: ProactivePayload, cardId: string): Promise<void> => {
    const watchId = p.candidate.facts.watchId;
    if (typeof watchId === 'string') await noteWatchNotice(brain.pool, watchId, cardId);
  };
  for (const tool of noticeTools({ store, now: brain.now, onPosted })) brain.tools.register(tool);
  registerFireRoute(brain.http, { adminToken: brain.env.ADMIN_TOKEN, store, now: brain.now, promote: (tripId) => promoter.promoteTrip(tripId) });

  /** Level-triggered: every active trip's timers and watches are re-planned from the trip as it is now. */
  const sweep = async (): Promise<void> => {
    const since = new Date(brain.now().getTime() - ACTIVE_TRIP_DAYS * 86_400_000);
    // A trip the Server no longer has (gone_at) is never re-planned: its timers and watches were retired with it.
    const trips = await brain.pool.query<{ trip_id: string }>(`select trip_id from trips where created_at > $1 and gone_at is null`, [since]);
    for (const { trip_id } of trips.rows) {
      // Its Server has been away for minutes (a closed drill): its read would wait, then reach another Server's 404.
      if (await brain.door.link.away?.(trip_id)) continue;
      try {
        await replan(trip_id, await readTrip(trip_id));
      } catch (err) {
        log.warn({ err, tripId: trip_id }, 'proactive: the sweep could not re-plan a trip');
      }
    }
    await openings.checkIgnored();
  };

  const handles: NodeJS.Timeout[] = [];
  if (opts.intervals !== false) {
    const every = (ms: number, what: string, fn: () => Promise<unknown>): void => {
      const h = setInterval(() => {
        fn().catch((err: unknown) => log.warn({ err }, `proactive: ${what} failed`));
      }, ms);
      h.unref();
      handles.push(h);
    };
    every(PROMOTE_EVERY_MS, 'promote', () => promoter.tick());
    every(WATCH_EVERY_MS, 'watch check', () => watches.tick());
    every(SWEEP_EVERY_MS, 'sweep', sweep);
  }

  const stop = (): void => {
    for (const h of handles.splice(0)) clearInterval(h);
  };
  // When Go stops (master §6.3: Brain.onStop), the promoter, the watch checks and the sweep stop with it.
  brain.onStop(stop);

  return {
    store,
    promote: () => promoter.tick(),
    checkWatches: () => watches.tick(),
    sweep,
    stop,
  };
}

export const registerProactive: RegisterLane = async (brain) => {
  await startProactive(brain);
};
