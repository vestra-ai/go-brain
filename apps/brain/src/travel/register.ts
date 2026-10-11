/**
 * Lane C's travel at boot: the fake ixigo, ixigo's MCP server when configured, and ixigo.com through the recipes, behind
 * one layer (brain.travel); the composer's travel tools, the options taps, the tap wake line, Go's image route, the
 * early start of a search on intake (every TRAVEL_MODE) and the right-now block that hands its answer to the turn.
 */
import type { RegisterLane } from '../app.js';
import { loadBook } from './book/book.js';
import { createEngine } from './book/engine.js';
import { ixigoTool, runOnStage, toolRecipes } from './book/tool.js';
import { bookingsNow } from './booking/booking-now.js';
import { createBusBooking } from './booking/bus-booking.js';
import { bookingOnFor, createFlightBooking } from './booking/flight-booking.js';
import { tripToday } from './dates.js';
import { readTravelEnv } from './env.js';
import { FakeIxigoStore } from './fake-ixigo/data.js';
import { bookFlightTool, bookingNow } from './book-flight.js';
import { eachTryAgain, flightsEachTool } from './flights-each.js';
import { showHeadStartStays } from './head-start-wake.js';
import { createImages, registerImageRoute } from './images.js';
import { createIxigoLogin, ixigoLoginTool, LOGIN_SWEEP_MS, renderLoginResume } from './login.js';
import { createLoginKeepAlive } from './login-keepalive.js';
import { createTravelLayer } from './layer.js';
import { registerLive } from './live.js';
import { openRecipeCards, startLiveSearch } from './live-search.js';
import { createHttpMcpCaller } from './mcp-caller.js';
import { createFakeTravel, createIxigoTravel } from './mcp-travel.js';
import { createIxigoWebBackend, LINK_ONLY_KINDS, searchKindOf, searchRecipeOf } from './recipes/backend.js';
import { createOffers } from './recipes/offers.js';
import { offersNow } from './recipes/offers-now.js';
import { createEarlyStart } from './recipes/early.js';
import { earlyAnswer, earlyReadNow, earlySearchNow, jevPickNow } from './recipes/now.js';
import { loadLearnedPlaces } from './recipes/places-store.js';
import { optionOnCard } from './recipes/option-on-card.js';
import { createGuideOf, createPlaceFor, keptPhoto } from './place-for.js';
import { wikiPhoto } from './wiki-photo.js';
import { placeInfoHandler, registerPlaceLearn } from './place-info.js';
import { createGroupStay } from './group-stay.js';
import { createResultsStore } from './results.js';
import { createRoomsCards, ROOMS_PICK, roomsCardOnClose, roomsTap } from './rooms-card.js';
import { createRunLog } from './runs.js';
import { createScreenFeed } from './screen-feed.js';
import { renderSearchWake, searchWakeAnswer, tryAgainAnswer } from './search-wake.js';
import { registerTravelTaps, renderOptionsTap } from './taps.js';
import { typedMoreAnswer } from './typed-more.js';
import { travelTools } from './tools.js';
import { budgetNow, budgetTool, createTripBudgets, stayCap } from './trip-budget.js';
import { showBusDrops } from './bus-drops.js';
import { saveTrip } from '../trips/save-trip.js';
import { placeOnClose, placeOptions, showPlaces, type PlacePick } from './places-card.js';
import { optionDetailsHandler } from './option-details.js';
import { showPickPhotos, type TopPick } from './pick-photos.js';
import type { TravelKind, TravelQuery } from './travel.js';
import { createIxigoWarm, createStaysHeadStart, IXIGO_WARM_STEP, STAYS_HEAD_START_STEP, startComputerAtSetup, wakeForCheck, warmForTravel } from './warm.js';
import { waysThereTool } from './ways-there.js';
import { createWebStays, stayOf } from './web-stays.js';
import { createWatchRunner, watchesNow } from './recipe-watches.js';
import { watchTools } from './watch-tools.js';
import { ProactiveStore } from '../proactive/store.js';

/** How often Go looks for watches that are due: each watch's own pace is an hour or half an hour. */
export const WATCH_TICK_MS = 30_000;

/** The messages a turn woke for. */
const messageIdsOf = (wake: ReadonlyArray<{ kind: string; payload: unknown }>): string[] =>
  wake.flatMap((w) => {
    const id = w.kind === 'message' ? (w.payload as { messageId?: unknown } | null)?.messageId : undefined;
    return typeof id === 'string' ? [id] : [];
  });

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
    endScreen: () => brain.recipeRunners?.endScreen ?? null,
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
    status: (tripId, o) => login.keepAlive(tripId, o),
    live: () => brain.switches.get('TRAVEL_MODE') === 'ixigo_web',
    now: brain.now,
    log: brain.log,
  });
  keepAlive.start();
  brain.onStop(function stopLoginKeepAlive() {
    keepAlive.stop();
  });
  // One-tap logins, looked over every minute from their rows: a wait a restart of Go lost is picked up, one past its time ends.
  const loginSweep = setInterval(() => {
    login.sweep().catch((err: unknown) => brain.log.warn({ err }, 'travel: the one-tap login sweep failed'));
  }, LOGIN_SWEEP_MS);
  loginSweep.unref();
  brain.onStop(function stopLoginSweep() {
    clearInterval(loginSweep);
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
        end: dates?.end ?? null,
        today: await tripToday(brain.pool, brain.now)(tripId),
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
  // A live card's view of the trip's screen (R7): a view-only session on the browser its search runs in. The tasks lane,
  // which owns the computers, registers after this one: read when a card starts.
  const liveViews = {
    liveView: async (tripId: string) => {
      const screen = brain.recipeRunners?.screen;
      if (!screen) throw new Error("no trip computer here for a live view");
      return screen(tripId, 'view');
    },
    endView: async (sessionId: string) => {
      await brain.recipeRunners?.endScreen?.(sessionId);
    },
  };
  const ixigoWeb = createIxigoWebBackend({
    book,
    engine,
    now: brain.now,
    log: brain.log,
    live: (tripId, o) => startLiveSearch({ link: brain.door.link, images, now: brain.now, log: brain.log, saidOnIt, ...liveViews }, tripId, o),
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
    // A line that asks for stays loads its own: the head start adds no second page beside it (the read hooks run first).
    asksStays: (tripId, messageId) => early.asksStays(tripId, messageId),
    onChangedKept: showHeadStartStays({ travel: () => brain.travel, packs: brain.packs, desk: brain.desk, results, now: brain.now, log: brain.log }),
  });
  brain.setup.addStep({ name: STAYS_HEAD_START_STEP, after: IXIGO_WARM_STEP, run: (tripId) => headStart.atSetup(tripId) });
  brain.tripLog.onEvent((ev) => headStart.onEvent(ev));
  const stopHeadStarts = (): void => headStart.stop();
  brain.onStop(stopHeadStarts);
  // A destination Go sets carries ixigo's place: its id, where it is, its time zone, its guide photos and best months.
  const placeFor = createPlaceFor({ pool: brain.pool, engine, images, log: brain.log });
  const travel = createTravelLayer({
    switches: brain.switches,
    now: brain.now,
    fake,
    ixigo,
    ixigoWeb,
    results,
    today: tripToday(brain.pool, brain.now),
    simulate: { setFlightDelay: (carrierCode, number, date, minutes) => store.setDelay(carrierCode, number, date, minutes) },
    booksFlights: (tripId) => bookingOnFor({ pool: brain.pool, switches: brain.switches }, tripId),
    // A stay from ixigo.com books on Go's test rail, after the trip's ixigo login and at ixigo's price now.
    webStays: createWebStays({
      results, runner: () => brain.recipeRunners?.browserFetch ?? null, login, now: brain.now, link: brain.door.link, log: brain.log,
      // BOOKING: the group's voted stay on ixigo's own pages, on the stage, up to Pay.
      bookingOn: (tripId) => bookingOnFor({ pool: brain.pool, switches: brain.switches }, tripId),
    }),
    placeFor,
  });
  // The Server team's rev 5 (R6): what a place is like, for the ideas on the home screen, from the places Go has learned;
  // the operator learns one ahead through a trip of their own (place-info.ts).
  brain.door.handle('place_info', placeInfoHandler({ pool: brain.pool }));
  registerPlaceLearn(brain.http, {
    adminToken: brain.env.ADMIN_TOKEN, pool: brain.pool, placeFor, guideOf: createGuideOf({ engine, images, log: brain.log }),
    live: () => brain.switches.get('TRAVEL_MODE') === 'ixigo_web',
  });
  const today = tripToday(brain.pool, brain.now);
  // A stays card's top pick opened on the stage, as a person opens it: its card clicked on the results by its name, its
  // page by its address if the click brings nothing (a watched read: a progress to follow puts it on the stage). Its
  // details are kept by the engine for "tell me about this villa". Only where Go reads ixigo.com itself.
  // A bus's top pick: its own "Select Seats" clicked on the results the stage shows, by its operator and time, read only,
  // its stops and cancellation kept for "where do we board and when". Never on a Bash that can't click one card's own
  // button (before bash #4637): no other card's is clicked instead. A stay's: its page's own photos, labelled, then
  // replace the search's on its card (pick-photos.ts, 10 Oct B3).
  /** A stay's own page read, its labelled photos and its rooms for the trip's people onto its card option (pick-photos.ts). */
  const stayPage = (tripId: string, pick: TopPick, o: { onProgress?: () => undefined; clickFrom?: string; background?: true }): Promise<void> =>
    engine.answer('hotels.details', { hotel: pick.page }, { tripId, ...o }).then(async (got) => {
      // The rooms' prices for the trip's people, for the stay's nights (REV4 B4).
      const stay = stayOf(pick.page);
      const personIds = (await brain.packs.get(tripId)).trip.people.map((p) => p.person_id);
      await showPickPhotos({ results, images, link: brain.door.link, ...(brain.cardPosted ? { posted: brain.cardPosted } : {}) }, tripId, pick, got, stay ? { personIds, nights: stay.nights } : undefined);
    });
  const showPick = (tripId: string, pick: TopPick, more: TopPick[] = []): void => {
    if (brain.switches.get('TRAVEL_MODE') !== 'ixigo_web') return;
    if (pick.kind === 'bus' && brain.recipeRunners?.browserFetch?.canPickOne?.() === false) return;
    const run = pick.kind === 'bus'
      ? engine.answer('buses.stops', { bus: pick.page }, { tripId, onProgress: () => undefined, staged: true }).then((got) =>
          // Its line says its own drops, the times the answer will give (bus-drops.ts).
          showBusDrops({ results, link: brain.door.link, ...(brain.cardPosted ? { posted: brain.cardPosted } : {}) }, tripId, pick, got).catch((err: unknown) => {
            brain.log.warn({ tripId, err: String(err).slice(0, 200) }, "travel: the top bus's drops didn't reach its card");
          }),
        )
      : stayPage(tripId, pick, { onProgress: () => undefined, clickFrom: pick.name });
    void run
      .catch((err: unknown) => {
        brain.log.warn({ tripId, err: String(err).slice(0, 200) }, "travel: the top pick's page didn't open on the stage, or its photos didn't reach its card");
      })
      .then(async () => {
        // The card's next stays, after the top pick's and one at a time, in the background: queued behind any page a person
        // waits on (the computer's slots take a background read last), never on the stage (rev 5 R1).
        for (const next of more) {
          await stayPage(tripId, next, { background: true }).catch((err: unknown) => {
            brain.log.warn({ tripId, err: String(err).slice(0, 200) }, "travel: a stay's own page didn't reach its card");
          });
        }
      });
  };
  // The Server team's rev 5 (R9): an option's Details as a person opens them, from what Go has read and kept, in 3 s; what
  // isn't read yet is read in the background and the answer says it is partial (option-details.ts).
  brain.door.handle('get_option_details', optionDetailsHandler({
    results, engine, log: brain.log,
    people: async (tripId) => (await brain.packs.get(tripId)).trip.people.map((p) => p.person_id),
    live: () => brain.switches.get('TRAVEL_MODE') === 'ixigo_web',
  }));
  // Where the group stays (booked, else the vote's winner, else the latest stays card's top pick): each bus's nearest drop.
  const groupStay = createGroupStay({ trip: async (tripId) => (await brain.packs.get(tripId)).trip, results });
  // The budget the group decided: the group's in the App, or one kept with set_budget, and in "Right now" for every turn,
  // as strong context. The App's, or a stay budget, also picks ixigo's own price bands for a stays search (one band over
  // kept), never Go dropping a stay.
  const budgets = createTripBudgets({ pool: brain.pool, now: brain.now });
  const stayBudget = async (tripId: string): Promise<number | null> => stayCap(await budgets.get(tripId, (await brain.packs.get(tripId)).trip));
  // The Server team's rev 5 (R2): "where should we go" as a card of places. The explorer's places are saved as results of
  // kind place for show_options; a place card's first three get their own place and guide in the background.
  // Each place's fit line weighs ixigo's estimate for the whole trip against the group's budget for the whole trip only.
  const placesOf = async (tripId: string, rows: Array<Record<string, unknown>>, checkedAt: string, asked: { origin?: string; month?: string }): Promise<string | null> => {
    const budget = await budgets.get(tripId, (await brain.packs.get(tripId)).trip).catch(() => null);
    const options = placeOptions(rows, { ...asked, budgetMinor: budget?.covers === 'whole_trip' ? budget.perPersonMinor : null });
    return options.length > 0 ? (await results.save({ tripId, optionKind: 'place', source: 'search', query: {}, options, checkedAt })).resultsId : null;
  };
  // A place's cover from its guide, for one the explorer gave no photo: placeFor keeps it for good, so a second card is instant.
  // A place's cover as its card goes up, reading no ixigo page (Keshav, 11 Oct: suggestions need no ixigo): its photo
  // kept from ixigo's guide, else Wikipedia's photo of it through Go's image cache, else none. A card's first three get
  // ixigo's own hero after, in the background (showPlaces).
  const placePhoto = async (_tripId: string, name: string): Promise<{ url: string; credit?: string } | null> => {
    const kept = await keptPhoto(brain.pool, name).catch(() => null);
    if (kept) return { url: kept };
    const wiki = await wikiPhoto(name);
    return wiki ? { url: wiki.url, credit: wiki.page } : null;
  };
  const placeCover = async (tripId: string, name: string): Promise<string | null> => {
    const found = await placePhoto(tripId, name);
    return found ? images.rehostUrl(found.url) : null;
  };
  const showPlacesOf = (tripId: string, picks: PlacePick[]): void => {
    if (brain.switches.get('TRAVEL_MODE') !== 'ixigo_web') return;
    void showPlaces({
      placeFor: async (words, o) => (await travel.placeFor?.(words, o)) ?? null,
      engine, results, link: brain.door.link, ...(brain.cardPosted ? { posted: brain.cardPosted } : {}), log: brain.log,
    }, tripId, picks);
  };
  // When ixigo's own quiet on a search's page ends (it refused one): Go's tries again wait past it (try-again.ts).
  const ixigoQuiet = (kind: TravelKind, q: TravelQuery): number | null => engine.ixigoQuietUntil(searchRecipeOf(kind, q));
  for (const t of travelTools({ travel, results, images, now: brain.now, desk: brain.desk, ixigoQuiet, log: brain.log, warmForTravel: warm, today, showPick, showPlaces: showPlacesOf, placeCover, placePhoto, stayBudget, groupStay })) brain.tools.register(t);
  brain.tools.register(budgetTool({ budgets, pool: brain.pool, now: brain.now, log: brain.log }));
  brain.context.addNow(budgetNow({ budgets, trip: async (tripId) => (await brain.packs.get(tripId)).trip }));
  // A person's own flight booking, in the turns they speak in (the lead, 11 Oct: Ankur's "?" after his stopped).
  brain.context.addNow(bookingsNow({ pool: brain.pool, packs: brain.packs, now: brain.now }));
  // A recipe's live card: its runs on the stage, as a search's are, so the room watches every page Go opens. Kept while
  // open, so the turn that answered ends its own done (exam #9, 10 Oct: two cards left failed beside a good answer).
  const recipeCards = openRecipeCards();
  const recipeCard = (tripId: string, o: { runKey: string; recipe: string }) =>
    recipeCards.card(tripId, o.runKey, () => startLiveSearch({ link: brain.door.link, images, now: brain.now, log: brain.log, saidOnIt }, tripId, o));
  brain.context.addTurnEnd((t) => recipeCards.turnEnded(t));
  // Any other recipe in the book, by its id: ixigo's own facts for the model to say (the destination guide, and more).
  const recipesTool = ixigoTool({
    book, engine, results, live: () => brain.switches.get('TRAVEL_MODE') === 'ixigo_web',
    card: recipeCard, placesOf,
    // A call that is the read the early start began for the message this turn woke for joins it, on its card.
    joined: (ctx, recipe, inputs) => early.joined(ctx.tripId, messageIdsOf(ctx.wake), recipe, inputs),
  });
  if (recipesTool) brain.tools.register(recipesTool);
  // Someone asks to log in to ixigo (again): the card goes up for whoever logs in for the trip, with a line saying whose.
  brain.tools.register(ixigoLoginTool(login));
  // How everyone gets to the trip, asked for: each home city's trains and buses side by side, on one card.
  brain.tools.register(
    waysThereTool({
      engine, results, link: brain.door.link, now: brain.now, log: brain.log,
      live: () => brain.switches.get('TRAVEL_MODE') === 'ixigo_web',
      slots: () => Number(brain.switches.get('BROWSER_FETCH_SLOTS')),
    }),
  );
  // Each person's own flights from their home city, on cards for them alone (B7): one page per city, posted as it lands,
  // and a city whose page didn't come tried again (try-again.ts).
  const eachDeps = { engine, results, link: brain.door.link, now: brain.now, desk: brain.desk, ixigoQuiet, log: brain.log, live: () => brain.switches.get('TRAVEL_MODE') === 'ixigo_web' };
  brain.tools.register(flightsEachTool(eachDeps));
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
  // "Book it" on a person's own flight: Go books it on the stage up to ixigo's pay button when BOOKING is on.
  const nameOf = async (tripId: string, personId: string): Promise<string> =>
    (await brain.packs.get(tripId)).trip.people.find((p) => p.person_id === personId)?.name ?? 'you';
  const booking = createFlightBooking({
    pool: brain.pool, nameOf, runner: () => brain.recipeRunners?.browserFetch ?? null, link: brain.door.link, switches: brain.switches, now: brain.now, log: brain.log,
    // Money registers after travel: its Pay is read when Pay is tapped.
    pay: () => brain.pay,
    login,
    results,
  });
  // Keshav, 11 Oct: "when logged in, automatically continue". The login landing carries on the bookings that waited on it;
  // the minute's sweep catches one nothing heard land, and puts a person's card back for a login let go or never in.
  // A person's own bus, as a flight (Keshav, 11 Oct): the same stage, login, vault and ticket.
  const busBooking = createBusBooking({
    pool: brain.pool, nameOf, runner: () => brain.recipeRunners?.browserFetch ?? null, link: brain.door.link, switches: brain.switches, now: brain.now, log: brain.log,
    pay: () => brain.pay,
    login,
    results,
  });
  login.onLoggedIn((tripId) => {
    booking.resumeWaiting(tripId).catch((err: unknown) => brain.log.warn({ err, tripId }, 'travel: carrying on bookings after the login failed'));
    busBooking.resumeWaiting(tripId).catch((err: unknown) => brain.log.warn({ err, tripId }, 'travel: carrying on bus bookings after the login failed'));
  });
  const bookingSweep = setInterval(() => {
    booking.sweep().catch((err: unknown) => brain.log.warn({ err }, 'travel: the flight bookings sweep failed'));
    busBooking.sweep().catch((err: unknown) => brain.log.warn({ err }, 'travel: the bus bookings sweep failed'));
  }, LOGIN_SWEEP_MS);
  bookingSweep.unref();
  brain.onStop(function stopBookingSweep() {
    clearInterval(bookingSweep);
  });
  const { seeMore } = registerTravelTaps(brain.taps, { results, pool: brain.pool, link: brain.door.link, desk: brain.desk, now: brain.now, log: brain.log, booking, busBooking, nameOf, images, travel, placeCover });
  // "show more" typed right after an options card: its See more, with no model round (the lead, 11 Oct).
  brain.context.addDirect(typedMoreAnswer({ seeMore, results }));
  // With BOOKING on for a trip, the model is told Go books its people's flights, and books a pick made before by words.
  brain.tools.register(bookFlightTool({ booking, pool: brain.pool, results, nameOf }));
  brain.context.addNow(bookingNow({ booking, pool: brain.pool, nameOf }));
  // The Server's REV4 B5: once a vote picks a stay, its rooms card (the ways to take its rooms, who shares, what each pays)
  // on the turn that says so; a tap keeps the way picked, for the expense per room (B6, chosenArrangement).
  const roomsCards = createRoomsCards(brain.pool);
  const rooms = { engine, results, store: roomsCards, link: brain.door.link, packs: brain.packs, log: brain.log };
  brain.context.addTurnCard(roomsCardOnClose(rooms));
  // A place a vote picked becomes the trip's, its title following when it named the old place (rev 5 R2).
  brain.context.addTurnCard(placeOnClose({
    results, log: brain.log,
    // The vote decided it.
    save: (pack, change, requestId) => saveTrip({ pool: brain.pool, now: brain.now, travel: () => brain.travel }, { link: brain.door.link, tripId: pack.trip.trip_id, pack, requestId }, { ...change, agreed: true }),
  }));
  brain.taps.on('rooms', ROOMS_PICK, roomsTap(rooms));
  const early = createEarlyStart({
    travel: () => brain.travel, switches: brain.switches, today: tripToday(brain.pool, brain.now), now: brain.now, log: brain.log,
    warmForTravel: warm,
    linkOnly: (kind) => LINK_ONLY_KINDS.has(kind),
    // The asks beyond the searches (a train's status, a guide, the offers...): the facts recipes the ixigo tool offers, so
    // its call for the same inputs joins the read (the engine keeps a facts read in flight).
    recipes: {
      has: (id) => toolRecipes(book).some((r) => r.id === id),
      run: (id, given, o) => runOnStage({ engine, card: recipeCard }, o.tripId, o.runKey, book.get(id) ?? { id, title: id }, given),
      read: (id, given, o) => engine.answer(id, given, { tripId: o.tripId }),
    },
    optionFor: (tripId, text, kind) => optionOnCard(brain.pool, results, tripId, text, kind),
    // The decided stays budget the search tool takes: a stays read early is the one the composer's search joins.
    stayBudget,
  });
  brain.hooks.onRead((msg, read, pack) => early.onRead(msg, read, pack));
  brain.context.addNow(earlySearchNow({ early, results, travel, now: brain.now }));
  brain.context.addNow(earlyReadNow({ early, now: brain.now }));
  // Jev's sure pick for a line nothing started early for: the tool that reads it on ixigo, never memory (EXAM, 10 Oct).
  brain.context.addNow(jevPickNow({
    early,
    canRead: (recipe) => brain.switches.get('TRAVEL_MODE') === 'ixigo_web' && toolRecipes(book).some((r) => r.id === recipe),
  }));
  // The sites' own filter lists the trip's searches brought: the model maps the ask onto them (site_filters).
  brain.context.addNow(offersNow({ offers }));
  // The tries again Go promised when ixigo didn't load a search (G1, 11 Oct): first, so each starts whatever else woke Go.
  brain.context.addDirect(tryAgainAnswer({ travel, results, desk: brain.desk, ixigoQuiet, now: brain.now, log: brain.log, each: eachTryAgain(eachDeps) }));
  // A plain search ask whose early search found options answers with no model call: the card and a line from its data.
  // One still running is handed over, and the turn says nothing more: the live card covers the wait.
  brain.context.addDirect(earlyAnswer({ early, results, images, travel, today, now: brain.now, desk: brain.desk, ixigoQuiet, log: brain.log }));
  // A search that outlived its turn wakes Go with its options, and that wake puts them up itself: card and line.
  brain.context.addDirect(searchWakeAnswer({ results, images, showPick, now: brain.now, log: brain.log }));
  brain.context.addWake('search', renderSearchWake);
  // A turn that ends ends the live search cards it left open.
  brain.context.addTurnEnd((t) => ixigoWeb.turnEnded(t));
  // Null for taps on other cards (pay, call): the next lane's renderer, or P1's generic line, reads those.
  brain.context.addWake('tap', renderOptionsTap);
  // A login that just landed: a booking that waited on it carries on, or, with none, Go takes off with the trip.
  brain.context.addWake('tap', renderLoginResume);
  brain.travel = travel;
};
