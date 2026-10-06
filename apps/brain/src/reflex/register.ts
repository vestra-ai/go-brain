import type { RegisterLane } from '../app.js';
import { createJev } from './jev.js';
import { createJevReflex } from './jev-reflex.js';

/** Replaces P1's all-unsure stub with Jev, and keeps the connection pool warm until Go stops. */
export const registerReflex: RegisterLane = (brain) => {
  const jev = createJev({ apiKey: brain.env.TYPESAFE_API_KEY, baseUrl: brain.env.TYPESAFE_BASE_URL, model: brain.env.JEV_MODEL });
  jev.startKeepWarm(); // its interval is unref()ed in jev.ts
  brain.onStop(() => jev.stopKeepWarm());
  brain.reflex = createJevReflex({
    jev,
    pool: brain.pool,
    liveValue: () => brain.switches.get('REFLEX_LIVE'),
    deadlineMs: brain.env.JEV_DEADLINE_MS,
    dailyCapPerTrip: brain.env.JEV_DAILY_CALLS_PER_TRIP,
    now: brain.now,
    log: brain.log,
  });
};
