import type { RegisterLane } from './app.js';
import { roomTools } from './composer/room-tools.js';
import { tripNow } from './composer/trip-now.js';
import { renderMessageWake, renderSetupWake, renderTripChangeWake } from './composer/wakes.js';

/** Lane A's own contributions, made through the same interfaces every lane uses. */
export const registerRoom: RegisterLane = (brain) => {
  for (const t of roomTools({ now: brain.now, pool: brain.pool, travel: () => brain.travel })) brain.tools.register(t);
  brain.context.addWake('message', renderMessageWake);
  brain.context.addWake('trip_change', renderTripChangeWake);
  brain.context.addWake('setup', renderSetupWake);
  brain.context.addNow(tripNow(brain.packs));
  // Go's side of setup: the trip row and pack, then hello, unless Go has already spoken here.
  brain.setup.addStep({
    name: 'brain.ready',
    run: async (tripId) => {
      const pack = await brain.packs.get(tripId);
      if (pack.messages.some((m) => m.author.kind === 'go')) return;
      await brain.desk.put({ id: `setup:${tripId}:greet`, tripId, kind: 'setup', ref: 'greet', dueAt: brain.now(), payload: {} });
    },
  });
};
