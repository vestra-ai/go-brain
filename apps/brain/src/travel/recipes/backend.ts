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
 * A stays ask whose only page conditions are ones ixigo's own rows say (NARROWED_BY: pool, breakfast, free cancellation)
 * answers at once from a finished, kept search of the same page with no conditions (the trip's stays head start, or an
 * earlier ask), its rows that have them all, when at least NARROW_MIN do; the card's checked time is that search's. The
 * filtered search then runs in the background, with no card and no message, and is kept under its own key for the next
 * ask. The posted card is never touched.
 */
import { createHash } from 'node:crypto';
import type { TurnEnd } from '../../composer/context.js';
import type { Book } from '../book/book.js';
import type { Engine, EngineAnswer, ShareSearch } from '../book/engine.js';
import type { LiveSearch } from '../live-search.js';
import { TravelError } from '../mcp-travel.js';
import type { SearchFor, TravelBackend, TravelKind, TravelQuery, TravelSearch } from '../travel.js';
import { RECIPE_TTL_MS } from './recipe.js';

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

/** A search's query as its recipe's inputs: the places as the person's words, and the conditions ixigo may filter on. */
export function recipeInputs(kind: TravelKind, q: TravelQuery): { given: Record<string, unknown>; conditions: string[] } {
  const conditions = [...(q.mustHave ?? [])];
  if (kind === 'stays') {
    return { given: { place: q.area ?? q.to, check_in: q.checkIn, check_out: q.checkOut, adults: q.guests }, conditions };
  }
  if (kind === 'flights') {
    return {
      given: {
        from: q.from, to: q.to, date: q.date, adults: q.guests,
        depart_after: q.departAfter, depart_before: q.departBefore, arrive_before: q.arriveBefore, max_price: q.maxPriceMinor,
      },
      conditions,
    };
  }
  return { given: { from: q.from, to: q.to, date: q.date }, conditions };
}

/** The same ask, whatever its spacing or case: "North Goa" and " north goa" are one search. */
const keyOf = (given: Record<string, unknown>, conditions: string[]): string =>
  JSON.stringify([
    Object.entries(given)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, typeof v === 'string' ? v.trim().toLowerCase().replace(/\s+/g, ' ') : v]),
    [...conditions].sort(),
  ]);

/** The ixigo_web backend, and the hook a turn's end calls to end the live cards it left open. */
export type IxigoWebBackend = TravelBackend & { turnEnded(t: TurnEnd): void; shareStep: ShareSearch };

/** Whose a live card is: the message whose early start ran its search, or the composer turn whose search tool did. */
type Owner = { kind: 'message' | 'turn'; id: string } | null;

/** A search kept under its key: when it started, for how long, its run, and what it found once it finished (done). */
interface Kept {
  at: number;
  ttl: number;
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

/** The conditions a kept stays search with none answers from its own rows: each stay says them (facts.pool and the rest). */
export const NARROWED_BY: ReadonlySet<string> = new Set(['pool', 'breakfast', 'free_cancellation']);
/** The fewest rows a kept search must have with the conditions to answer from them; fewer, and the ask runs its own search. */
export const NARROW_MIN = 3;

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

  /**
   * The ask's page conditions, when there are some and each is NARROWED_BY, so a kept search with none can answer it;
   * null otherwise. Conditions that are not the page's (a beach, a villa) are not ixigo's to filter: Go's own filters read
   * them as ever.
   */
  function narrowedBy(id: string, conditions: string[]): string[] | null {
    const recipe = d.book.get(id);
    const byPage = conditions.filter((c) => recipe?.conditions !== undefined && Object.hasOwn(recipe.conditions, c));
    return byPage.length > 0 && byPage.every((c) => NARROWED_BY.has(c)) ? byPage : null;
  }

  /**
   * A stays ask answered from a finished, kept search of the same page with no conditions: its rows that have every one
   * of the ask's page conditions (narrowedBy); null when there is no such search, or fewer than NARROW_MIN rows fit.
   */
  async function fromKept(id: string, given: Record<string, unknown>, byPage: string[], tripId: string): Promise<TravelSearch | null> {
    const wide = kept.get(await keyFor(id, given, [], tripId));
    if (!wide?.done || d.now().getTime() - wide.at >= wide.ttl) return null;
    const rows = wide.done.results.filter((o) => byPage.every((c) => o.facts[c] === true));
    if (rows.length < NARROW_MIN) return null;
    return { ...wide.done, results: rows, runId: `${wide.done.runId ?? id}|${[...byPage].sort().join('+')}` };
  }

  /** The search itself, in the background: no card, no hold, kept under its own key for the next ask. */
  function runQuietly(key: string, id: string, given: Record<string, unknown>, conditions: string[], tripId: string, ttl: number): void {
    const nowMs = d.now().getTime();
    const runId = `${key}|${nowMs}`;
    const ran = d.engine.answer(id, given, { tripId, conditions, background: true });
    const search = ran.then((run): TravelSearch => {
      if (run.as !== 'options') throw new TravelError('refused', `${id} gives no options.`);
      return { results: run.options, checkedAt: run.checkedAt, runId, page: run.page };
    });
    keep(key, { at: nowMs, ttl, search, ran });
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
    const { given, conditions } = recipeInputs(kind, q);
    const link = recipe.answer.as === 'link';
    const ttl = recipe.ttl_minutes * 60_000 || RECIPE_TTL_MS;
    return { tripId, id, given, conditions, link, ttl, key: link ? `${id}|${keyOf(given, conditions)}` : await keyFor(id, given, conditions, tripId) };
  }

  /**
   * A search's key. The page is ixigo's public results, the same in any trip's browser: the trip runs it, and the request
   * it makes keys it (the page and its fetch), so two asks that open the same page are one search whatever their words
   * (8 Oct: an early "with a pool" and the composer's "sleeping 4, with a pool" ran twice). A place that still needs
   * ixigo's box has no request until it loads: the words key that one.
   */
  async function keyFor(id: string, given: Record<string, unknown>, conditions: string[], tripId: string): Promise<string> {
    const request = (await d.engine.requestOf?.(id, given, { tripId, conditions })) ?? null;
    return request ? `${id}|${createHash('sha256').update(request).digest('hex').slice(0, 24)}` : `${id}|${keyOf(given, conditions)}`;
  }

  return {
    async search(kind, q, o?: SearchFor) {
      const { tripId, id, given, conditions, link, ttl, key } = await plan(kind, q, o?.tripId);
      // Never "no flights" when ixigo refuses Go's computer: the group gets the page itself, set as they asked.
      if (link) {
        const a = await d.engine.answer(id, given, { tripId, conditions });
        if (a.as === 'link') throw new TravelError('link_only', "ixigo won't show its results to Go's computer right now.", a.link);
      }
      const owner: Owner = o?.turnId ? { kind: 'turn', id: o.turnId } : o?.messageId ? { kind: 'message', id: o.messageId } : null;
      const cardKey = `${tripId}|${key}`;
      const nowMs = d.now().getTime();
      const fresh = (k: Kept | undefined): k is Kept => k !== undefined && nowMs - k.at < k.ttl;
      let hit = kept.get(key);
      // The search itself kept and done answers as it is; until then, a kept search of the same page with no conditions
      // answers from its rows, and the search itself runs in the background (unless it is running already). Only an ask
      // that can be narrowed waits here, so every other search reads what is kept and keeps its own with no wait between.
      const byPage = narrowedBy(id, conditions);
      if (byPage && !(fresh(hit) && hit.done)) {
        const narrowed = await fromKept(id, given, byPage, tripId);
        // The wait let another search of this key start, or finish: what is kept is read again.
        hit = kept.get(key);
        if (narrowed && !(fresh(hit) && hit.done)) {
          if (!fresh(hit)) runQuietly(key, id, given, conditions, tripId, ttl);
          return narrowed;
        }
      }
      if (fresh(hit)) {
        // The composer joining a run its early start began takes the card: if that run fails, nothing retries it.
        const running = cards.get(cardKey);
        if (running?.running && owner?.kind === 'turn') running.owner = owner;
        return hit.search;
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
      const ran = d.engine.answer(id, given, { tripId, conditions, ...(live ? { onProgress: live.progress } : {}) });
      const search = ran.then(
        async (run): Promise<TravelSearch> => {
          if (run.as !== 'options') throw new TravelError('refused', `${id} gives no options.`);
          live?.progress({ type: 'extracted', count: run.options.length });
          // The card is done before the options card posts.
          if (card) await end(cardKey, card, true);
          return { results: run.options, checkedAt: run.checkedAt, runId, page: run.page };
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
      keep(key, { at: nowMs, ttl, search, ran });
      return search;
    },
    async shareStep(id, given, o, run) {
      const kind = searchKindOf(id);
      const recipe = d.book.get(id);
      // A link loads nothing, and anything else is not a search: the step runs on its own.
      if (!kind || !recipe || recipe.answer.as !== 'options') return null;
      const conditions = o.conditions ?? [];
      const key = await keyFor(id, given, conditions, o.tripId);
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
      keep(key, { at: nowMs, ttl: recipe.ttl_minutes * 60_000 || RECIPE_TTL_MS, search, ran });
      return { answer: ran, joined: false };
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
