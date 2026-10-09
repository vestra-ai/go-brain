/**
 * TRAVEL_MODE ixigo_web: Go's travel search on ixigo.com itself, through the recipe book: each kind of search is a recipe
 * file (flights.search, trains.between, buses.between, hotels.search), run by the recipe engine in the trip's own browser,
 * so it needs the trip. Its options carry their ixigo.com page and no offer id: the group books on ixigo, and Go never
 * holds or pays for them. A recipe that answers with a link (flights) loads nothing.
 *
 * A search is kept for its recipe's TTL (10 minutes), by recipe and the words asked; while it runs, the same search joins
 * it, so an early start on intake and the composer's own call make one page load, and one live search card: the card
 * starts with the run and is marked done before the search answers.
 *
 * A composite's step that is one of these searches (trip.how_we_get_there's trains and buses) shares them too
 * (shareStep): it takes a search kept or running for the same request, and one it runs is kept for the next ask, early
 * starts and the composer's searches alike. A step gets no live card of its own: the composite's card and Go Live's
 * tiles show it.
 *
 * A live card belongs to the turn that handles its search: the turn for the message whose early start ran it, or the
 * composer turn whose search tool did. A failed early start leaves its card open, and the composer's search in that turn
 * carries on in it. The composer's own search that fails ends its card failed at once, before Go's line. When a turn ends
 * (turnEnded), a card it left open ends failed. So the room sees one card per search, ending done or failed exactly once,
 * and never after its turn; a search still running when its turn ends keeps its card until the run ends it. A card that
 * ended never reopens: a later ask gets a card of its own. A search that stops on a pick (ixigo knows more than one place
 * for the words) is not a failure: its card says Go is choosing, stays open through the turn's end, and the search after
 * the pick goes on in it, whatever its words.
 *
 * A search answers inline within TRAVEL_WAIT_MS of its start; past that the search tool goes on and the options come when
 * the run finishes (waitMs).
 *
 * A stays ask filters on ixigo's own list for the place (site_filters, offers.ts): its page with those filters on is
 * its own search, kept under its own key. A search answers only the ask it was read for: anything more is a filtered
 * read or the model's pick (forAsk), never a kept list passed off as filtered (staging, 9 Oct: "pool villas" answered
 * with an apartment hotel from the kept pool stays). The head count is the page's: "sleeping 5" in a trip of five opens
 * the same page as the trip's own search (keyFor).
 *
 * A filtered page that catches nothing in its time is read again at once without its filters: ixigo's own filter can be
 * what hangs (staging, 9 Oct: Goa sleeping 5 with a pool caught nothing in 20 s on a logged-in computer, and the same
 * computer read Goa's stays in 8 s after). A fresh read of that page, kept or running (the head start), answers instead
 * of a new one. The answer says which filters ixigo left off (unapplied), and the model picks on them.
 */
import { createHash } from 'node:crypto';
import type { TurnEnd } from '../../composer/context.js';
import type { Book } from '../book/book.js';
import type { Engine, EngineAnswer, RunFor, ShareSearch } from '../book/engine.js';
import type { LiveSearch } from '../live-search.js';
import { TravelError } from '../mcp-travel.js';
import type { SearchFor, TravelBackend, TravelKind, TravelQuery, TravelSearch } from '../travel.js';
import { offersText, sameName } from './offers.js';
import { RECIPE_TTL_MS, type RecipeOption } from './recipe.js';
import { NothingCaughtError } from './runners.js';

/** How long a search may hold up the turn, from its start: a train search on a sleeping box took about 8 s on staging. */
export const TRAVEL_WAIT_MS = 12_000;

export interface IxigoWebDeps {
  book: Pick<Book, 'get'>;
  /**
   * Runs a recipe: the trip's head count and homes, its places and its page are the engine's. requestOf keys a search on
   * the page it will open, not the words asked; absent in tests whose engine is scripted, which key on the words.
   */
  engine: Pick<Engine, 'answer'> & Partial<Pick<Engine, 'requestOf'>>;
  now: () => Date;
  /** The live search card for a run; absent in tests that don't look at it. */
  live?: (tripId: string, o: { runKey: string; kind: TravelKind; query: TravelQuery }) => LiveSearch;
  /** How long a run goes before its live card shows (CARD_DELAY_MS); 0 shows it at once. */
  cardDelayMs?: number;
  log?: { warn(obj: object, msg: string): void };
}

/**
 * A run that answers within this (a recipe's fast call from the warm tab) posts its options card with no live card
 * first: the "On it." card shows only for a run still going after it, with the steps it missed.
 */
export const CARD_DELAY_MS = 1_500;

/** A live card that shows only once the run has gone delayMs; until then its steps wait, and a run done by then shows none. */
function shownAfter(delayMs: number, make: () => LiveSearch): LiveSearch {
  if (delayMs <= 0) return make();
  let live: LiveSearch | null = null;
  const waiting: Array<Parameters<LiveSearch['progress']>[0]> = [];
  const timer = setTimeout(() => {
    live = make();
    for (const e of waiting.splice(0)) live.progress(e);
  }, delayMs);
  timer.unref?.();
  return {
    progress: (e) => {
      if (live) live.progress(e);
      else waiting.push(e);
    },
    finish: async (ok) => {
      clearTimeout(timer);
      // A card never shown has nothing to end.
      if (live) await live.finish(ok);
    },
  };
}

/** Each kind of search's recipe in the book. */
export const SEARCH_RECIPES: Record<TravelKind, string> = { flights: 'flights.search', trains: 'trains.between', buses: 'buses.between', stays: 'hotels.search' };

/** The kind of search a recipe is, when it is one of the four. */
export const searchKindOf = (recipeId: string): TravelKind | null =>
  (Object.entries(SEARCH_RECIPES) as Array<[TravelKind, string]>).find(([, id]) => id === recipeId)?.[0] ?? null;

/** The site's own filters and sort an ask names, by their names on the site's list (recipes/offers.ts). */
export interface SiteAsk {
  filters: string[];
  sort?: string;
}
const NO_SITE: SiteAsk = { filters: [] };
/**
 * What the site did with this ask's own filters and sort: a search joined, or read for an ask that named none, applied
 * none of them (its names had no list to go by), so every name it didn't apply is this ask's to pick (unknown).
 */
function forAsk(found: TravelSearch, site: SiteAsk): TravelSearch {
  const asked = [...site.filters, ...(site.sort ? [site.sort] : [])];
  if (!found.site || asked.length === 0) return found;
  const applied = [...found.site.filtered, ...(found.site.sorted ? [found.site.sorted] : [])];
  const unknown = asked.filter((n) => !applied.some((a) => sameName(a, n)));
  return { ...found, site: { ...found.site, unknown } };
}

/** A run's site filters and sort, as the engine takes them. */
const siteRun = (site: SiteAsk): Pick<RunFor, 'siteFilters' | 'siteSort'> => ({
  ...(site.filters.length > 0 ? { siteFilters: site.filters } : {}),
  ...(site.sort ? { siteSort: site.sort } : {}),
});

/** A search's query as its recipe's inputs: the places as the person's words, and the site's own filters and sort the ask names. */
export function recipeInputs(kind: TravelKind, q: TravelQuery): { given: Record<string, unknown>; site: SiteAsk } {
  if (kind === 'stays') {
    const site = { filters: [...(q.siteFilters ?? [])], ...(q.siteSort ? { sort: q.siteSort } : {}) };
    return { given: { place: q.area ?? q.to, check_in: q.checkIn, check_out: q.checkOut, adults: q.guests }, site };
  }
  if (kind === 'flights') {
    return {
      given: {
        from: q.from, to: q.to, date: q.date, adults: q.guests,
        depart_after: q.departAfter, depart_before: q.departBefore, arrive_before: q.arriveBefore, max_price: q.maxPriceMinor,
        stops: q.nonStop ? 0 : undefined,
      },
      site: NO_SITE,
    };
  }
  return { given: { from: q.from, to: q.to, date: q.date }, site: NO_SITE };
}

/** The same ask, whatever its spacing or case: "North Goa" and " north goa" are one search. */
const keyOf = (given: Record<string, unknown>, site: SiteAsk = NO_SITE): string =>
  JSON.stringify([
    Object.entries(given)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, typeof v === 'string' ? v.trim().toLowerCase().replace(/\s+/g, ' ') : v]),
    ...(site.filters.length > 0 || site.sort ? [[...site.filters].map((f) => f.trim().toLowerCase()).sort(), site.sort?.trim().toLowerCase() ?? null] : []),
  ]);

/** A search's answer from what is kept, loading nothing; null when nothing kept answers it. */
export type KeptAnswer = (id: string, given: Record<string, unknown>, o: RunFor) => Promise<EngineAnswer | null>;

/** Whether a search of this page, with any filters, is kept or running: the page is already being read. */
export type PageKept = (id: string, given: Record<string, unknown>, o: { tripId: string }) => Promise<boolean>;

/** The ixigo_web backend, and the hook a turn's end calls to end the live cards it left open. */
export type IxigoWebBackend = TravelBackend & { turnEnded(t: TurnEnd): void; shareStep: ShareSearch; keptAnswer: KeptAnswer; pageKept: PageKept };

/** Whose a live card is: the message whose early start ran its search, or the composer turn whose search tool did. */
type Owner = { kind: 'message' | 'turn'; id: string } | null;

/** A search kept under its key: when it started, for how long, its run, and what it found once it finished (done). */
interface Kept {
  at: number;
  ttl: number;
  /** The same search's key with no filters: its page, whatever it filters (pageKept). */
  page: string;
  search: Promise<TravelSearch>;
  ran: Promise<EngineAnswer>;
  done?: TravelSearch;
}

/**
 * A live card that has not ended: its search running, a failed early start's card waiting for the composer's search, or
 * a card waiting on a pick (choosingSince: ixigo knew more than one place, and the search after the pick, whatever its
 * words, goes on in it).
 */
interface OpenCard {
  live: LiveSearch;
  kind: TravelKind;
  owner: Owner;
  running: boolean;
  /** Why the last run failed, for the card's failed step. */
  code: string;
  choosingSince: number | null;
}

/** How long a card waits on a pick: as long as the engine keeps ixigo's list for the model to choose from. */
export const CHOOSING_MS = 15 * 60_000;

/** Turns and messages remembered as over, so a run that fails after its turn ended ends its card at once. */
const OVER_MAX = 2_000;

/** Flights: ixigo answers our box egress with "No flights found", then a 403 (7 Oct), so flights.search is a link. */
export const LINK_ONLY_KINDS: ReadonlySet<TravelKind> = new Set(['flights']);

const BOOK_ON_IXIGO = 'Options from ixigo.com are booked on ixigo, from their link.';
const CACHE_MAX = 200;

export function createIxigoWebBackend(d: IxigoWebDeps): IxigoWebBackend {
  /** Searches by request: the run's own answer (ran) and the search made of it, which a step and a search each take. */
  const kept = new Map<string, Kept>();

  /** A run kept for its TTL under its key; one that fails is not kept, so the next ask runs it again. */
  function keep(key: string, entry: Kept): void {
    kept.delete(key);
    kept.set(key, entry);
    while (kept.size > CACHE_MAX) {
      const oldest = kept.keys().next().value;
      if (oldest === undefined) break;
      kept.delete(oldest);
    }
    entry.search.then(
      (found) => {
        entry.done = found;
      },
      () => {
        if (kept.get(key)?.search === entry.search) kept.delete(key);
      },
    );
  }

  /** A search with no card of its own, kept under its key for the next ask: its run. */
  function runKept(key: string, page: string, id: string, given: Record<string, unknown>, o: RunFor, ttl: number): Promise<EngineAnswer> {
    const nowMs = d.now().getTime();
    const runId = `${key}|${nowMs}`;
    const ran = d.engine.answer(id, given, o);
    const search = ran.then((run): TravelSearch => {
      if (run.as !== 'options') throw new TravelError('refused', `${id} gives no options.`);
      return { results: run.options, checkedAt: run.checkedAt, runId, page: run.page };
    });
    keep(key, { at: nowMs, ttl, search, ran, page });
    return ran;
  }

  /**
   * The page with no filters, for a filtered search whose page caught nothing (NothingCaughtError): a fresh read of it
   * kept or running (the head start), or one run now on the ask's live card, kept under the page's key.
   */
  function unfiltered(page: string, id: string, given: Record<string, unknown>, tripId: string, ttl: number, onProgress: RunFor['onProgress']): Promise<EngineAnswer> {
    const hit = kept.get(page);
    if (hit && d.now().getTime() - hit.at < hit.ttl) return hit.ran;
    return runKept(page, page, id, given, { tripId, ...(onProgress ? { onProgress } : {}) }, ttl);
  }
  /** The live cards that have not ended, by trip and search. */
  const cards = new Map<string, OpenCard>();
  /** Owners whose turn has ended, as "<trip>|turn:<id>" and "<trip>|message:<id>". */
  const over = new Set<string>();
  const ownerKey = (o: Owner): string => (o ? `${o.kind}:${o.id}` : '');

  /** The card's one ending: its last step ticked (done) or marked failed, sent before the search answers. */
  function end(cardKey: string, card: OpenCard, ok: boolean): Promise<void> {
    if (cards.get(cardKey) === card) cards.delete(cardKey);
    if (!ok) card.live.progress({ type: 'failed', code: card.code });
    return card.live.finish(ok);
  }

  /** The trip's cards that waited on a pick past CHOOSING_MS end failed: nobody picked. */
  function sweepChoosing(tripId: string): void {
    for (const [k, card] of cards) {
      if (k.startsWith(`${tripId}|`) && card.choosingSince !== null && d.now().getTime() - card.choosingSince >= CHOOSING_MS) void end(k, card, false);
    }
  }

  /** The trip's card waiting on a pick for this kind of search, under its key. */
  function choosingCard(tripId: string, kind: TravelKind): [string, OpenCard] | null {
    sweepChoosing(tripId);
    for (const [k, card] of cards) if (k.startsWith(`${tripId}|`) && card.choosingSince !== null && card.kind === kind) return [k, card];
    return null;
  }

  /** The recipe, its inputs and the search's key, or a plain refusal before anything runs. */
  async function plan(kind: TravelKind, q: TravelQuery, tripId: string | undefined) {
    if (!tripId) throw new TravelError('refused', "An ixigo.com search runs on a trip's computer, so it needs the trip.");
    const id = SEARCH_RECIPES[kind];
    const recipe = d.book.get(id);
    if (!recipe) throw new TravelError('refused', `Go's recipe book has no ${id}.`);
    const { given, site } = recipeInputs(kind, q);
    const link = recipe.answer.as === 'link';
    const ttl = recipe.ttl_minutes * 60_000 || RECIPE_TTL_MS;
    const key = link ? `${id}|${keyOf(given, site)}` : await keyFor(id, given, tripId, site);
    const plain = site.filters.length === 0 && !site.sort;
    return { tripId, id, given, site, link, ttl, key, page: !plain && !link ? await keyFor(id, given, tripId) : key };
  }

  /**
   * A search's key. The page is ixigo's public results, the same in any trip's browser: the trip runs it, and the request
   * it makes keys it (the page and its fetch), so two asks that open the same page are one search whatever their words
   * (8 Oct: an early "with a pool" and the composer's "sleeping 4, with a pool" ran twice). A place that still needs
   * ixigo's box has no request until it loads: the words key that one.
   */
  async function keyFor(id: string, given: Record<string, unknown>, tripId: string, site: SiteAsk = NO_SITE): Promise<string> {
    const request = (await d.engine.requestOf?.(id, given, { tripId, ...siteRun(site) })) ?? null;
    return request ? `${id}|${createHash('sha256').update(request).digest('hex').slice(0, 24)}` : `${id}|${keyOf(given, site)}`;
  }

  return {
    async search(kind, q, o?: SearchFor) {
      const { tripId, id, given, site, link, ttl, key, page } = await plan(kind, q, o?.tripId);
      // Never "no flights" when ixigo refuses Go's computer: the group gets the page itself, set as they asked.
      if (link) {
        const a = await d.engine.answer(id, given, { tripId });
        if (a.as === 'link') throw new TravelError('link_only', "ixigo won't show its results to Go's computer right now.", a.link);
      }
      const owner: Owner = o?.turnId ? { kind: 'turn', id: o.turnId } : o?.messageId ? { kind: 'message', id: o.messageId } : null;
      const cardKey = `${tripId}|${key}`;
      const nowMs = d.now().getTime();
      const fresh = (k: Kept | undefined): k is Kept => k !== undefined && nowMs - k.at < k.ttl;
      const hit = kept.get(key);
      if (fresh(hit)) {
        // The composer joining a run its early start began takes the card: if that run fails, nothing retries it.
        const running = cards.get(cardKey);
        if (running?.running && owner?.kind === 'turn') running.owner = owner;
        return hit.search.then((found) => forAsk(found, site));
      }
      const runId = `${key}|${nowMs}`;
      // A failed early start's card, still open in its turn, carries on with this search, and so does a card waiting on a
      // pick of this kind of search, whatever this search's words ("Udaipur City (UDZ)" after "Udaipur"); otherwise the
      // run gets its own.
      let card = cards.get(cardKey) ?? null;
      const waiting = card ? null : choosingCard(tripId, kind);
      if (waiting) {
        cards.delete(waiting[0]);
        card = waiting[1];
        cards.set(cardKey, card);
      }
      if (card && !card.running) {
        card.running = true;
        card.choosingSince = null;
        card.owner = owner ?? card.owner;
      } else if (d.live) {
        const make = d.live;
        card = { live: shownAfter(d.cardDelayMs ?? CARD_DELAY_MS, () => make(tripId, { runKey: runId, kind, query: q })), kind, owner, running: true, code: 'failed', choosingSince: null };
        cards.set(cardKey, card);
      } else {
        card = null;
      }
      const live = card?.live;
      // A page filtered on ixigo's own filters that catches nothing: the page again without them, at once. A search never
      // fails because ixigo was slow on a filter.
      const filtered = site.filters;
      let unapplied: string[] | null = null;
      const asked = d.engine.answer(id, given, {
        tripId, ...siteRun(site), ...(filtered.length > 0 ? { fallsBack: true } : {}), ...(live ? { onProgress: live.progress } : {}),
      });
      const read = filtered.length > 0
        ? asked.catch((err: unknown) => {
            if (!(err instanceof NothingCaughtError)) throw err;
            unapplied = filtered;
            d.log?.warn({ tripId, recipe: id, site: filtered.length }, 'travel: a filtered stays page caught nothing; reading it without its filters');
            return unfiltered(page, id, given, tripId, ttl, live?.progress);
          })
        : asked;
      // A search that shares this one (shareStep: a watch's check) reads ixigo's filtered page itself, or its failure:
      // never the page read without the filters, passed off as filtered.
      const ran = asked;
      const search = read.then(
        async (run): Promise<TravelSearch> => {
          if (run.as !== 'options') throw new TravelError('refused', `${id} gives no options.`);
          live?.progress({ type: 'extracted', count: run.options.length });
          // The card is done before the options card posts.
          if (card) await end(cardKey, card, true);
          const said = run.site
            ? { filtered: run.site.filtered, sorted: run.site.sorted, unknown: run.site.unknown, listed: run.site.listed, offers: run.site.list ? offersText(run.site.list) : null }
            : null;
          return { results: run.options, checkedAt: run.checkedAt, runId, page: run.page, ...(unapplied ? { unapplied } : {}), ...(said ? { site: said } : {}) };
        },
        async (err: unknown): Promise<never> => {
          if (card) {
            card.code = err instanceof TravelError ? err.code : 'failed';
            if (err instanceof TravelError && err.code === 'pick_place') {
              // Not a failure: the model, or the group, chooses between the places ixigo knows. The card says so and
              // waits, through the turn's end, for the search after the pick.
              card.running = false;
              card.choosingSince = d.now().getTime();
              card.live.progress({ type: 'choosing', between: err.choices });
            } else if (card.owner?.kind === 'message' && !over.has(`${tripId}|${ownerKey(card.owner)}`)) {
              // A failed early start waits, open, for the composer's search in its turn. Anything else ends failed now,
              // before the search answers: the composer's own search, a job's, or one whose turn is already over.
              card.running = false;
            } else {
              await end(cardKey, card, false);
            }
          }
          throw err;
        },
      );
      keep(key, { at: nowMs, ttl, search, ran, page });
      return search.then((found) => forAsk(found, site));
    },
    async shareStep(id, given, o, run) {
      const kind = searchKindOf(id);
      const recipe = d.book.get(id);
      // A link loads nothing, and anything else is not a search: the step runs on its own.
      if (!kind || !recipe || recipe.answer.as !== 'options') return null;
      const site: SiteAsk = { filters: o.siteFilters ?? [], ...(o.siteSort ? { sort: o.siteSort } : {}) };
      const key = await keyFor(id, given, o.tripId, site);
      const page = site.filters.length > 0 || site.sort ? await keyFor(id, given, o.tripId) : key;
      const nowMs = d.now().getTime();
      const hit = kept.get(key);
      if (hit && nowMs - hit.at < hit.ttl) return { answer: hit.ran, joined: true };
      const ran = run();
      const runId = `${key}|${nowMs}`;
      const search = ran.then(
        (a): TravelSearch => {
          if (a.as !== 'options') throw new TravelError('refused', `${id} gives no options.`);
          return { results: a.options, checkedAt: a.checkedAt, runId, page: a.page };
        },
        // A step's run is never cut short by its composite, but anything that is not a travel error is said as one.
        (err: unknown): never => {
          throw err instanceof TravelError ? err : new TravelError('unreachable', 'ixigo took too long to answer. Try again in a moment.');
        },
      );
      keep(key, { at: nowMs, ttl: recipe.ttl_minutes * 60_000 || RECIPE_TTL_MS, search, ran, page });
      return { answer: ran, joined: false };
    },
    /**
     * A search's answer from what is kept, loading nothing: the search itself, kept and done, as its filters were applied.
     * Null when nothing kept answers it: one read without the ask's filters (unapplied) never does. A watch's first check
     * reads it before it loads a page (watch-tools.ts), as an ask does.
     */
    async keptAnswer(id, given, o) {
      const recipe = d.book.get(id);
      if (!searchKindOf(id) || !recipe || recipe.answer.as !== 'options') return null;
      const site: SiteAsk = { filters: o.siteFilters ?? [], ...(o.siteSort ? { sort: o.siteSort } : {}) };
      const hit = kept.get(await keyFor(id, given, o.tripId, site));
      const done = hit?.done && d.now().getTime() - hit.at < hit.ttl ? forAsk(hit.done, site) : null;
      const found = done && !done.unapplied && (done.site?.unknown.length ?? 0) === 0 ? done : null;
      return found ? { as: 'options', options: found.results as RecipeOption[], page: found.page ?? '', checkedAt: found.checkedAt, ms: 0 } : null;
    },
    /**
     * A search of this page kept or running, with any filters, finished or not: the page is already being read, so the
     * stays head start loads nothing behind it (warm.ts). A failed run is not kept.
     */
    async pageKept(id, given, o) {
      const page = await keyFor(id, given, o.tripId);
      const nowMs = d.now().getTime();
      for (const k of kept.values()) if (k.page === page && nowMs - k.at < k.ttl) return true;
      return false;
    },
    async waitMs(kind, q, o) {
      // A search that refuses does so at once, and a link loads nothing: nothing to wait for.
      let p: Awaited<ReturnType<typeof plan>>;
      try {
        p = await plan(kind, q, o?.tripId);
      } catch {
        return null;
      }
      if (p.link) return null;
      const started = kept.get(p.key)?.at ?? d.now().getTime();
      return Math.max(0, TRAVEL_WAIT_MS - (d.now().getTime() - started));
    },
    turnEnded(t) {
      const owners = new Set([`turn:${t.turnId}`, ...t.messageIds.map((id) => `message:${id}`)]);
      for (const k of owners) {
        over.delete(`${t.tripId}|${k}`);
        over.add(`${t.tripId}|${k}`);
      }
      while (over.size > OVER_MAX) {
        const oldest = over.values().next().value;
        if (oldest === undefined) break;
        over.delete(oldest);
      }
      // A card the turn left open ends failed; one whose search still runs is ended by its run, and one waiting on a pick
      // waits on (the group may be choosing), up to CHOOSING_MS.
      for (const [k, card] of cards) {
        if (k.startsWith(`${t.tripId}|`) && !card.running && card.choosingSince === null && owners.has(ownerKey(card.owner))) void end(k, card, false);
      }
      sweepChoosing(t.tripId);
    },
    async status() {
      throw new TravelError('refused', "Flight and PNR status aren't read from ixigo.com yet.");
    },
    async hold() {
      throw new TravelError('refused', BOOK_ON_IXIGO);
    },
    async confirm() {
      throw new TravelError('refused', BOOK_ON_IXIGO);
    },
  };
}
