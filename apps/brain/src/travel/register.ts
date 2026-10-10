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
import { showHeadStartStays } from './head-start-wake.js';
import { createImages, registerImageRoute } from './images.js';
import { createIxigoLogin, renderLoginResume } from './login.js';
import { createLoginKeepAlive } from './login-keepalive.js';
import { createTravelLayer } from './layer.js';
import { registerLive } from './live.js';
import { startLiveSearch } from './live-search.js';
import { createHttpMcpCaller } from './mcp-caller.js';
import { createFakeTravel, createIxigoTravel } from './mcp-travel.js';
import { createIxigoWebBackend, LINK_ONLY_KINDS, searchKindOf } from './recipes/backend.js';
import { createOffers } from './recipes/offers.js';
import { offersNow } from './recipes/offers-now.js';
import { createEarlyStart } from './recipes/early.js';
import { earlyAnswer, earlySearchNow } from './recipes/now.js';
import { loadLearnedPlaces } from './recipes/places-store.js';
import { createPlaceFor } from './place-for.js';
import { createResultsStore } from './results.js';
import { createRunLog } from './runs.js';
import { createScreenFeed } from './screen-feed.js';
import { renderSearchWake, searchWakeAnswer } from './search-wake.js';
import { registerTravelTaps, renderOptionsTap } from './taps.js';
import { travelTools } from './tools.js';
import { budgetNow, budgetTool, createTripBudgets } from './trip-budget.js';
import type { TravelKind } from './travel.js';
import { createIxigoWarm, createStaysHeadStart, IXIGO_WARM_STEP, STAYS_HEAD_START_STEP, startComputerAtSetup, wakeForCheck, warmForTravel } from './warm.js';
import { waysThereTool } from './ways-there.js';
import { createWebStays } from './web-stays.js';
import { createWatchRunner, watchesNow } from './recipe-watches.js';
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
  // One person's ixigo login on the trip's computer: asked right after Go's hello at setup, at the first search of a trip
  // that never had that ask, and again when a recipe needs it.
  const login = createIxigoLogin({
    pool: brain.pool,
    link: brain.door.link,
    packs: brain.packs,
    runner: () => brain.recipeRunners?.browserFetch ?? null,
    tasks: () => brain.tasks ?? null,
    screen: () => brain.recipeRunners?.screen ?? null,
    browser: () => brain.recipeRunners?.login ?? null,
    desk: brain.desk,
    live: () => brain.switches.get('TRAVEL_MODE') === 'ixigo_web',
    now: brain.now,
    log: brain.log,
  });
  login.registerTaps(brain.taps);
  // The person's login kept alive in their browser: one read every few hours while it is logged in (login-keepalive.ts).
  // The browsers are the tasks lane's, which registers after this one: read when a pass runs, none without them.
  const keepAlive = createLoginKeepAlive({
    loggedInSince: async (before) => (await brain.recipeRunners?.login?.loggedInSince(before)) ?? [],
    status: (tripId) => login.status(tripId),
    live: () => brain.switches.get('TRAVEL_MODE') === 'ixigo_web',
    now: brain.now,
    log: brain.log,
  });
  keepAlive.start();
  brain.onStop(function stopLoginKeepAlive() {
    keepAlive.stop();
  });
  // Go's hello carries the login card and its line: one message to open a new trip, never two in a row.
  brain.context.addTurnCard((i) => login.helloCard(i));
  // The one owner of waking the trip's computer for travel (see warmForTravel); a new trip's computer is made at setup.
  // Travel intent is also when a trip with no ixigo login is asked for one, once (it never holds the search).
  const warm = (tripId: string, kind: TravelKind | null): void => {
    warmForTravel(brain, tripId, kind);
    login.nudge(tripId);
  };
  // Setup, in this order: the box started, the login prompt right after Go's hello, then the Chrome's first ixigo visit.
  brain.setup.addStep({ name: 'travel.computer', run: (tripId) => startComputerAtSetup(brain, tripId) });
  brain.setup.addStep(login.setupStep);
  const ixigoWarm = createIxigoWarm(brain);
  brain.setup.addStep({ name: IXIGO_WARM_STEP, after: 'travel.computer', run: (tripId) => ixigoWarm.run(tripId) });
  // Every recipe run as it happens, for the Server's live view of a trip (/v1/live): in memory, nothing written.
  const runs = createRunLog({ now: brain.now, log: brain.log });
  // And the trip computer's screen, live, from Bash's browser watch: only where searches run on it (ixigo_web).
  const screens = createScreenFeed({
    open: (tripId, signal) => (brain.switches.get('TRAVEL_MODE') === 'ixigo_web' ? brain.recipeRunners?.watch(tripId, signal) ?? null : null),
    log: brain.log,
  });
  brain.onStop(() => screens.stop());
  registerLive(brain, runs, screens);
  brain.tripLog.onEvent((ev) => login.onEvent(ev));
  // For "Forget me" in a trip (the memory lane): the person's ixigo login goes with them.
  brain.ixigoLogin = login;
  // The recipe book, checked at boot: a file that fails is left out, and the log says why.
  const { book, problems } = loadBook();
  for (const problem of problems) brain.log.warn({ problem }, 'travel: a recipe file was left out');
  // The tasks lane, which registers after this one, sets the browser fetch: a recipe reads it when it runs.
  // What each site's page offers to filter and sort on, as it lists them itself, per place: read on every search.
  const offers = createOffers({ now: brain.now });
  const engine = createEngine({
    book,
    runner: () => brain.recipeRunners?.browserFetch ?? null,
    pool: brain.pool,
    offers,
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
    // A recipe that needs the trip's ixigo login (auth: login) asks for it, and waits for it.
    login: (tripId, what) => login.ensure(tripId, what),
    now: brain.now,
    log: brain.log,
  });
  // The warm step's line too: how often ixigo answered a new trip's computer, and how fast; and the stays head start's.
  brain.recipeStats = () => [...engine.stats(), ...[ixigoWarm.stat(), headStart.stat()].filter((s) => s !== null)];
  // The watches going, per trip (how many, the next check), for the stage desk and the health view.
  brain.recipeWatches = () => watchesNow(brain.pool);
  // When each trip's live card last said "On it.", across its cards: one ask's second search says nothing (live-search.ts).
  const saidOnIt = new Map<string, number>();
  const ixigoWeb = createIxigoWebBackend({
    book,
    engine,
    now: brain.now,
    log: brain.log,
    live: (tripId, o) => startLiveSearch({ link: brain.door.link, images, now: brain.now, log: brain.log, saidOnIt }, tripId, o),
    // A computer that met Cloudflare's check moments ago opens no stays page for an ask (backend.ts CHALLENGE_COOL_MS).
    challengedAt: (tripId) => brain.recipeRunners?.browserFetch.lastChallenge?.(tripId) ?? null,
  });
  // The trip's likely first stays search, before anyone asks: after the warm at setup, when its dates or destination
  // change, and on a line after the last one ran out. Through Go's searches (shareStep), so no card, and the ask joins it.
  const headStart = createStaysHeadStart({
    switches: brain.switches,
    now: brain.now,
    log: brain.log,
    trip: async (tripId) => {
      const { destination, dates } = (await brain.packs.get(tripId)).trip;
      return { destination: destination?.name ?? null, start: dates?.start ?? null, end: dates?.end ?? null };
    },
    today: tripToday(brain.pool, brain.now),
    share: (tripId, ask, run) => ixigoWeb.shareStep('hotels.search', { ...ask }, { tripId, conditions: [], background: true }, run),
    run: (tripId, ask) => engine.answer('hotels.search', { ...ask }, { tripId, conditions: [], background: true }),
    ttlMs: (book.get('hotels.search')?.ttl_minutes ?? 10) * 60_000,
    warmGaveUp: (tripId) => ixigoWarm.gaveUp(tripId),
    computerSetUp: () => brain.recipeRunners !== undefined,
    // Dates agreed on a trip with a place: the kept stays go up as one card, unless Go has the last word.
    // A turn's own stays search for these dates, with any conditions, is the trip's one load: the head start skips it.
    staysKept: (tripId, ask) => ixigoWeb.pageKept('hotels.search', { ...ask }, { tripId }),
    onChangedKept: showHeadStartStays({ travel: () => brain.travel, packs: brain.packs, desk: brain.desk, results, now: brain.now, log: brain.log }),
  });
  brain.setup.addStep({ name: STAYS_HEAD_START_STEP, after: IXIGO_WARM_STEP, run: (tripId) => headStart.atSetup(tripId) });
  brain.tripLog.onEvent((ev) => headStart.onEvent(ev));
  const stopHeadStarts = (): void => headStart.stop();
  brain.onStop(stopHeadStarts);
  const travel = createTravelLayer({
    switches: brain.switches,
    now: brain.now,
    fake,
    ixigo,
    ixigoWeb,
    results,
    today: tripToday(brain.pool, brain.now),
    simulate: { setFlightDelay: (carrierCode, number, date, minutes) => store.setDelay(carrierCode, number, date, minutes) },
    // A stay from ixigo.com books on Go's test rail, after the trip's ixigo login and at ixigo's price now.
    webStays: createWebStays({ results, runner: () => brain.recipeRunners?.browserFetch ?? null, login, now: brain.now }),
    // A destination Go sets carries ixigo's place: its id, where it is, its time zone and its guide photo.
    placeFor: createPlaceFor({ pool: brain.pool, engine, images, log: brain.log }),
  });
  const today = tripToday(brain.pool, brain.now);
  // A stays card's top pick, its own page opened on the stage (a watched read: a progress to follow puts it there), its
  // details kept by the engine for "tell me about this villa". Only where Go reads ixigo.com itself.
  const showPick = (tripId: string, pageUrl: string): void => {
    if (brain.switches.get('TRAVEL_MODE') !== 'ixigo_web') return;
    void engine.answer('hotels.details', { hotel: pageUrl }, { tripId, onProgress: () => undefined }).catch((err: unknown) => {
      brain.log.warn({ tripId, err: String(err).slice(0, 200) }, "travel: the top pick's page didn't open on the stage");
    });
  };
  for (const t of travelTools({ travel, results, images, now: brain.now, desk: brain.desk, log: brain.log, warmForTravel: warm, today, showPick })) brain.tools.register(t);
  // The budget the group decided: kept with set_budget, and in "Right now" for every turn, as strong context, never a filter.
  const budgets = createTripBudgets({ pool: brain.pool, now: brain.now });
  brain.tools.register(budgetTool({ budgets }));
  brain.context.addNow(budgetNow({ budgets, trip: async (tripId) => (await brain.packs.get(tripId)).trip }));
  // Any other recipe in the book, by its id: ixigo's own facts for the model to say (the destination guide, and more).
  const recipesTool = ixigoTool({ book, engine, results, live: () => brain.switches.get('TRAVEL_MODE') === 'ixigo_web' });
  if (recipesTool) brain.tools.register(recipesTool);
  // How everyone gets to the trip, asked for: each home city's trains and buses side by side, on one card.
  brain.tools.register(
    waysThereTool({
      engine, results, link: brain.door.link, now: brain.now, log: brain.log,
      live: () => brain.switches.get('TRAVEL_MODE') === 'ixigo_web',
      slots: () => Number(brain.switches.get('BROWSER_FETCH_SLOTS')),
    }),
  );
  // Watches the group asks for on ixigo ("tell us when it confirms"): the tools, and the checks every 30 s that find
  // the due ones. What comes true goes through the proactive bar as the group's ask (RECIPE_WATCHES turns it all off).
  // A watch's first check reads what Go's searches keep before a page, and one already so puts its card up.
  const watching = { kept: ixigoWeb.keptAnswer, results, images };
  for (const t of watchTools({ pool: brain.pool, book, engine, switches: brain.switches, now: brain.now, ...watching })) brain.tools.register(t);
  const watchRunner = createWatchRunner({
    pool: brain.pool, book, engine, store: new ProactiveStore(brain.pool), switches: brain.switches, now: brain.now, log: brain.log,
    linkOpen: () => brain.door.link.isOpen(),
    wake: (tripId) => wakeForCheck(brain, tripId),
  });
  const watchEvery = setInterval(() => {
    watchRunner.tick().catch((err: unknown) => brain.log.warn({ err }, 'travel: the watch checks failed'));
  }, WATCH_TICK_MS);
  watchEvery.unref();
  const stopWatchChecks = (): void => clearInterval(watchEvery);
  brain.onStop(stopWatchChecks);
  registerTravelTaps(brain.taps, { results, link: brain.door.link, desk: brain.desk, now: brain.now, log: brain.log });
  const early = createEarlyStart({
    travel: () => brain.travel, switches: brain.switches, today: tripToday(brain.pool, brain.now), now: brain.now, log: brain.log,
    warmForTravel: warm,
    linkOnly: (kind) => LINK_ONLY_KINDS.has(kind),
  });
  brain.hooks.onRead((msg, read, pack) => early.onRead(msg, read, pack));
  brain.context.addNow(earlySearchNow({ early, results, travel, now: brain.now }));
  // The sites' own filter lists the trip's searches brought: the model maps the ask onto them (site_filters).
  brain.context.addNow(offersNow({ offers }));
  // A plain search ask whose early search found options answers with no model call: the card and a line from its data.
  // One still running is handed over, and the turn says nothing more: the live card covers the wait.
  brain.context.addDirect(earlyAnswer({ early, results, images, travel, today, now: brain.now, desk: brain.desk, log: brain.log }));
  // A search that outlived its turn wakes Go with its options, and that wake puts them up itself: card and line.
  brain.context.addDirect(searchWakeAnswer({ results, images, showPick }));
  brain.context.addWake('search', renderSearchWake);
  // A turn that ends ends the live search cards it left open.
  brain.context.addTurnEnd((t) => ixigoWeb.turnEnded(t));
  // Null for taps on other cards (pay, call): the next lane's renderer, or P1's generic line, reads those.
  brain.context.addWake('tap', renderOptionsTap);
  // A login that just landed: a booking that waited on it carries on, or, with none, Go takes off with the trip.
  brain.context.addWake('tap', renderLoginResume);
  brain.travel = travel;
};
