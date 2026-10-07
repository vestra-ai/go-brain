/**
 * Lane C's travel at boot: the fake ixigo, ixigo's MCP server when configured, and ixigo.com through the recipes, behind
 * one layer (brain.travel); the composer's travel tools, the options taps, the tap wake line, Go's image route, the
 * early start of an ixigo.com search on intake and the right-now block that hands its answer to the turn.
 */
import type { RegisterLane } from '../app.js';
import { tripToday } from './dates.js';
import { readTravelEnv } from './env.js';
import { FakeIxigoStore } from './fake-ixigo/data.js';
import { createImages, registerImageRoute } from './images.js';
import { createTravelLayer } from './layer.js';
import { startLiveSearch } from './live-search.js';
import { createHttpMcpCaller } from './mcp-caller.js';
import { createFakeTravel, createIxigoTravel } from './mcp-travel.js';
import { createIxigoWebBackend, LINK_ONLY_KINDS } from './recipes/backend.js';
import { createEarlyStart } from './recipes/early.js';
import { earlySearchNow } from './recipes/now.js';
import { runnerFor } from './recipes/runners.js';
import { createResultsStore } from './results.js';
import { renderSearchWake } from './search-wake.js';
import { registerTravelTaps, renderOptionsTap } from './taps.js';
import { travelTools } from './tools.js';

export const registerTravel: RegisterLane = async (brain) => {
  const env = readTravelEnv(brain.env);
  const store = new FakeIxigoStore({ now: brain.now });
  const fake = createFakeTravel({ store, now: brain.now, payRail: () => brain.switches.get('PAY_RAIL') });
  // The caller is made here, not inside createIxigoTravel, so its connection can be closed when Go stops.
  const ixigoCaller = env.IXIGO_MCP_URL
    ? createHttpMcpCaller({ url: env.IXIGO_MCP_URL, name: 'go-ixigo', ...(env.IXIGO_MCP_TOKEN ? { token: env.IXIGO_MCP_TOKEN } : {}) })
    : null;
  const ixigo = env.IXIGO_MCP_URL && ixigoCaller ? createIxigoTravel({ url: env.IXIGO_MCP_URL, now: brain.now, caller: ixigoCaller }) : null;
  if (ixigoCaller) brain.onStop(() => ixigoCaller.close());
  if (!ixigo) brain.log.info('travel: IXIGO_MCP_URL is not set, so TRAVEL_MODE ixigo searches the fake ixigo (ixigo_web and fake are not affected)');
  const results = createResultsStore(brain.pool);
  const images = createImages({ pool: brain.pool, publicUrl: env.GO_PUBLIC_URL });
  const imageRoute = registerImageRoute(brain.http, { pool: brain.pool });
  brain.onStop(() => imageRoute.close());
  // The tasks lane, which registers after this one, sets the runners: a search reads them when it runs. Bash's browser
  // fetch reads a page when the TRAVEL_RUNNER switch says so and the page's list loads in a hidden tab; the agent job
  // reads the rest.
  const ixigoWeb = createIxigoWebBackend({
    runner: (recipe) => {
      const runners = brain.recipeRunners;
      if (!runners) return null;
      return recipe.fetchable ? runnerFor(brain.switches, runners) : runners.agentJob;
    },
    peopleOf: async (tripId) => (await brain.packs.get(tripId)).trip.people.length,
    homesOf: async (tripId) => (await brain.packs.get(tripId)).trip.people.flatMap((p) => (p.from_city ? [p.from_city] : [])),
    now: brain.now,
    live: (tripId, o) => startLiveSearch({ link: brain.door.link, images, now: brain.now, log: brain.log }, tripId, o),
    linkOnly: (kind) => LINK_ONLY_KINDS.has(kind),
  });
  const travel = createTravelLayer({
    switches: brain.switches,
    now: brain.now,
    fake,
    ixigo,
    ixigoWeb,
    results,
    today: tripToday(brain.pool, brain.now),
    simulate: { setFlightDelay: (carrierCode, number, date, minutes) => store.setDelay(carrierCode, number, date, minutes) },
  });
  for (const t of travelTools({ travel, results, images, now: brain.now, desk: brain.desk, log: brain.log })) brain.tools.register(t);
  registerTravelTaps(brain.taps, { results, link: brain.door.link, desk: brain.desk, now: brain.now, log: brain.log });
  const early = createEarlyStart({
    travel: () => brain.travel, switches: brain.switches, today: tripToday(brain.pool, brain.now), now: brain.now, log: brain.log,
    keepWarm: (tripId) => brain.recipeRunners?.keepWarm(tripId),
    linkOnly: (kind) => LINK_ONLY_KINDS.has(kind),
  });
  brain.hooks.onRead((msg, read, pack) => early.onRead(msg, read, pack));
  brain.context.addNow(earlySearchNow({ early, results, travel, now: brain.now }));
  // A search that outlived its turn wakes Go with its options.
  brain.context.addWake('search', renderSearchWake);
  // Null for taps on other cards (pay, call): the next lane's renderer, or P1's generic line, reads those.
  brain.context.addWake('tap', renderOptionsTap);
  brain.travel = travel;
};
