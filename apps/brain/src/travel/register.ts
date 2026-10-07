/**
 * Lane C's travel at boot: the fake ixigo, ixigo's MCP server when configured, and ixigo.com through the recipes, behind
 * one layer (brain.travel); the composer's travel tools, the options taps, the tap wake line, Go's image route, the
 * early start of a search on intake (every TRAVEL_MODE) and the right-now block that hands its answer to the turn.
 */
import type { RegisterLane } from '../app.js';
import { loadBook } from './book/book.js';
import { createEngine } from './book/engine.js';
import { ixigoTool } from './book/tool.js';
import { tripToday } from './dates.js';
import { readTravelEnv } from './env.js';
import { FakeIxigoStore } from './fake-ixigo/data.js';
import { createImages, registerImageRoute } from './images.js';
import { createTravelLayer } from './layer.js';
import { startLiveSearch } from './live-search.js';
import { createHttpMcpCaller } from './mcp-caller.js';
import { createFakeTravel, createIxigoTravel } from './mcp-travel.js';
import { createIxigoWebBackend, LINK_ONLY_KINDS, searchKindOf } from './recipes/backend.js';
import { createEarlyStart } from './recipes/early.js';
import { earlySearchNow } from './recipes/now.js';
import { loadLearnedPlaces } from './recipes/places-store.js';
import { createResultsStore } from './results.js';
import { renderSearchWake } from './search-wake.js';
import { registerTravelTaps, renderOptionsTap } from './taps.js';
import { travelTools } from './tools.js';
import type { TravelKind } from './travel.js';
import { warmForTravel } from './warm.js';

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
  // The places ixigo's forms resolved before this boot: a cache, so a failed load only means slower first searches.
  await loadLearnedPlaces(brain.pool).catch((err: unknown) => brain.log.warn({ err: String(err) }, 'travel: could not load the places ixigo resolved'));
  const images = createImages({ pool: brain.pool, publicUrl: env.GO_PUBLIC_URL });
  const imageRoute = registerImageRoute(brain.http, { pool: brain.pool });
  brain.onStop(() => imageRoute.close());
  // The one owner of waking the trip's computer for travel (see warmForTravel).
  const warm = (tripId: string, kind: TravelKind | null): void => warmForTravel(brain, tripId, kind);
  // The recipe book, checked at boot: a file that fails is left out, and the log says why.
  const { book, problems } = loadBook();
  for (const problem of problems) brain.log.warn({ problem }, 'travel: a recipe file was left out');
  // The tasks lane, which registers after this one, sets the browser fetch: a recipe reads it when it runs.
  const engine = createEngine({
    book,
    runner: () => brain.recipeRunners?.browserFetch ?? null,
    pool: brain.pool,
    trip: async (tripId) => {
      const people = (await brain.packs.get(tripId)).trip.people;
      return { people: Math.max(1, people.length), homes: people.flatMap((p) => (p.from_city ? [p.from_city] : [])) };
    },
    // A run that opens a page warms for its kind of search; any other recipe's page, for no kind.
    warm: (tripId, recipeId) => warm(tripId, searchKindOf(recipeId)),
    now: brain.now,
    log: brain.log,
  });
  brain.recipeStats = () => engine.stats();
  const ixigoWeb = createIxigoWebBackend({
    book,
    engine,
    now: brain.now,
    live: (tripId, o) => startLiveSearch({ link: brain.door.link, images, now: brain.now, log: brain.log }, tripId, o),
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
  for (const t of travelTools({ travel, results, images, now: brain.now, desk: brain.desk, log: brain.log, warmForTravel: warm })) brain.tools.register(t);
  // Any other recipe in the book, by its id: ixigo's own facts for the model to say (the destination guide, and more).
  const ixigo = ixigoTool({ book, engine, live: () => brain.switches.get('TRAVEL_MODE') === 'ixigo_web' });
  if (ixigo) brain.tools.register(ixigo);
  registerTravelTaps(brain.taps, { results, link: brain.door.link, desk: brain.desk, now: brain.now, log: brain.log });
  const early = createEarlyStart({
    travel: () => brain.travel, switches: brain.switches, today: tripToday(brain.pool, brain.now), now: brain.now, log: brain.log,
    warmForTravel: warm,
    linkOnly: (kind) => LINK_ONLY_KINDS.has(kind),
  });
  brain.hooks.onRead((msg, read, pack) => early.onRead(msg, read, pack));
  brain.context.addNow(earlySearchNow({ early, results, travel, now: brain.now }));
  // A search that outlived its turn wakes Go with its options.
  brain.context.addWake('search', renderSearchWake);
  // A turn that ends ends the live search cards it left open.
  brain.context.addTurnEnd((t) => ixigoWeb.turnEnded(t));
  // Null for taps on other cards (pay, call): the next lane's renderer, or P1's generic line, reads those.
  brain.context.addWake('tap', renderOptionsTap);
  brain.travel = travel;
};
