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
import { registerLive } from './live.js';
import { startLiveSearch } from './live-search.js';
import { createHttpMcpCaller } from './mcp-caller.js';
import { createFakeTravel, createIxigoTravel } from './mcp-travel.js';
import { createIxigoWebBackend, LINK_ONLY_KINDS, searchKindOf } from './recipes/backend.js';
import { createEarlyStart } from './recipes/early.js';
import { earlyAnswer, earlySearchNow } from './recipes/now.js';
import { loadLearnedPlaces } from './recipes/places-store.js';
import { createResultsStore } from './results.js';
import { createRunLog } from './runs.js';
import { createScreenFeed } from './screen-feed.js';
import { renderSearchWake } from './search-wake.js';
import { registerTravelTaps, renderOptionsTap } from './taps.js';
import { travelTools } from './tools.js';
import type { TravelKind } from './travel.js';
import { startComputerAtSetup, warmForTravel } from './warm.js';
import { waysThereTool } from './ways-there.js';
import { createWatchRunner } from './recipe-watches.js';
import { watchTools } from './watch-tools.js';
import { ProactiveStore } from '../proactive/store.js';

/** How often Go looks for watches that are due: each watch's own pace is an hour or half an hour. */
export const WATCH_TICK_MS = 30_000;

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
  // The one owner of waking the trip's computer for travel (see warmForTravel); a new trip's computer is made at setup.
  const warm = (tripId: string, kind: TravelKind | null): void => warmForTravel(brain, tripId, kind);
  brain.setup.addStep({ name: 'travel.computer', run: (tripId) => startComputerAtSetup(brain, tripId) });
  // Every recipe run as it happens, for the Server's live view of a trip (/v1/live): in memory, nothing written.
  const runs = createRunLog({ now: brain.now, log: brain.log });
  // And the trip computer's screen, live, from Bash's browser watch: only where searches run on it (ixigo_web).
  const screens = createScreenFeed({
    open: (tripId, signal) => (brain.switches.get('TRAVEL_MODE') === 'ixigo_web' ? brain.recipeRunners?.watch(tripId, signal) ?? null : null),
    log: brain.log,
  });
  brain.onStop(() => screens.stop());
  registerLive(brain, runs, screens);
  // The recipe book, checked at boot: a file that fails is left out, and the log says why.
  const { book, problems } = loadBook();
  for (const problem of problems) brain.log.warn({ problem }, 'travel: a recipe file was left out');
  // The tasks lane, which registers after this one, sets the browser fetch: a recipe reads it when it runs.
  const engine = createEngine({
    book,
    runner: () => brain.recipeRunners?.browserFetch ?? null,
    pool: brain.pool,
    trip: async (tripId) => {
      const { people, destination, dates } = (await brain.packs.get(tripId)).trip;
      return {
        people: Math.max(1, people.length),
        homes: people.flatMap((p) => (p.from_city ? [p.from_city] : [])),
        destination: destination?.name ?? null,
        start: dates?.start ?? null,
      };
    },
    // A run that opens a page warms for its kind of search; any other recipe's page, for no kind.
    warm: (tripId, recipeId) => warm(tripId, searchKindOf(recipeId)),
    // Each run's events, for the live view.
    onRun: runs.record,
    // A composite's steps share the backend's searches: a city searched a minute ago, or being searched, loads nothing.
    searches: (id, given, o, run) => ixigoWeb.shareStep(id, given, o, run),
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
  const today = tripToday(brain.pool, brain.now);
  for (const t of travelTools({ travel, results, images, now: brain.now, desk: brain.desk, log: brain.log, warmForTravel: warm, today })) brain.tools.register(t);
  // Any other recipe in the book, by its id: ixigo's own facts for the model to say (the destination guide, and more).
  const recipesTool = ixigoTool({ book, engine, results, live: () => brain.switches.get('TRAVEL_MODE') === 'ixigo_web' });
  if (recipesTool) brain.tools.register(recipesTool);
  // How everyone gets to the trip, asked for: each home city's trains and buses side by side, on one card.
  brain.tools.register(waysThereTool({ engine, results, live: () => brain.switches.get('TRAVEL_MODE') === 'ixigo_web' }));
  // Watches the group asks for on ixigo ("tell us when it confirms"): the tools, and the checks every 30 s that find
  // the due ones. What comes true goes through the proactive bar as the group's ask (RECIPE_WATCHES turns it all off).
  for (const t of watchTools({ pool: brain.pool, book, engine, switches: brain.switches, now: brain.now })) brain.tools.register(t);
  const watchRunner = createWatchRunner({ pool: brain.pool, book, engine, store: new ProactiveStore(brain.pool), switches: brain.switches, now: brain.now, log: brain.log });
  const watchEvery = setInterval(() => {
    watchRunner.tick().catch((err: unknown) => brain.log.warn({ err }, 'travel: the watch checks failed'));
  }, WATCH_TICK_MS);
  watchEvery.unref();
  brain.onStop(() => clearInterval(watchEvery));
  registerTravelTaps(brain.taps, { results, link: brain.door.link, desk: brain.desk, now: brain.now, log: brain.log });
  const early = createEarlyStart({
    travel: () => brain.travel, switches: brain.switches, today: tripToday(brain.pool, brain.now), now: brain.now, log: brain.log,
    warmForTravel: warm,
    linkOnly: (kind) => LINK_ONLY_KINDS.has(kind),
  });
  brain.hooks.onRead((msg, read, pack) => early.onRead(msg, read, pack));
  brain.context.addNow(earlySearchNow({ early, results, travel, now: brain.now }));
  // A plain search ask whose early search found options answers with no model call: the card and a line from its data.
  brain.context.addDirect(earlyAnswer({ early, results, images, travel, today }));
  // A search that outlived its turn wakes Go with its options.
  brain.context.addWake('search', renderSearchWake);
  // A turn that ends ends the live search cards it left open.
  brain.context.addTurnEnd((t) => ixigoWeb.turnEnded(t));
  // Null for taps on other cards (pay, call): the next lane's renderer, or P1's generic line, reads those.
  brain.context.addWake('tap', renderOptionsTap);
  brain.travel = travel;
};
