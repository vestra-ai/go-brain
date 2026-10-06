/**
 * Lane C's travel at boot: the fake ixigo and, when configured, ixigo's MCP server behind one layer (brain.travel),
 * the composer's travel tools, the options taps, the tap wake line and Go's image route.
 */
import type { RegisterLane } from '../app.js';
import { readTravelEnv } from './env.js';
import { FakeIxigoStore } from './fake-ixigo/data.js';
import { createImages, registerImageRoute } from './images.js';
import { createTravelLayer } from './layer.js';
import { createHttpMcpCaller } from './mcp-caller.js';
import { createFakeTravel, createIxigoTravel } from './mcp-travel.js';
import { createResultsStore } from './results.js';
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
  if (!ixigo) brain.log.info('travel: IXIGO_MCP_URL is not set, so searches use the fake ixigo whatever TRAVEL_MODE says');
  const results = createResultsStore(brain.pool);
  const images = createImages({ pool: brain.pool, publicUrl: env.GO_PUBLIC_URL });
  registerImageRoute(brain.http, { pool: brain.pool });
  const travel = createTravelLayer({
    switches: brain.switches,
    now: brain.now,
    fake,
    ixigo,
    results,
    simulate: { setFlightDelay: (carrierCode, number, date, minutes) => store.setDelay(carrierCode, number, date, minutes) },
  });
  for (const t of travelTools({ travel, results, images, now: brain.now })) brain.tools.register(t);
  registerTravelTaps(brain.taps, { results, link: brain.door.link, desk: brain.desk, now: brain.now, log: brain.log });
  // Null for taps on other cards (pay, call): the next lane's renderer, or P1's generic line, reads those.
  brain.context.addWake('tap', renderOptionsTap);
  brain.travel = travel;
};
