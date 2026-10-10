/**
 * The recipe engine: runs any recipe in the book. It fills the recipe's inputs (places through ixigo's own search box,
 * counts from the trip), opens the recipe's page in the trip's browser and reads its answer, or answers with the page as
 * a link. It knows how to use ixigo, never what is on it: every place, page and reading is in a recipe file.
 *
 * Nothing ever goes to /payments/: ixigo's payment page opens with a saved card ready to pay in one click. The engine
 * refuses any address, step or landing under it, whatever a file says.
 */
import type { Pool } from 'pg';
import { TravelError } from '../mcp-travel.js';
import { airportOf, busCityOf, goaHalves, norm, stationOf, stayPlaceOf, wordsOf } from '../recipes/places.js';
import { keepPlace } from '../recipes/places-store.js';
import type { OnProgress } from '../recipes/progress.js';
import { asOffers, offerWords, pickOffers, type Offer, type OfferList, type Offers } from '../recipes/offers.js';
import { IXIGO, matches, type Capture, type CaptureSpec, type FetchPlan, type RecipeOption } from '../recipes/recipe.js';
import type { RecipeRunner } from '../recipes/runners.js';
import type { TravelKind } from '../travel.js';
import type { Book } from './book.js';
import { evaluate } from './expr.js';
import type { RecipeFile, Step } from './format.js';
import { clip } from '../cards.js';
import { boxFetches, pickSuggestion, readSuggestions, type End, type Suggestion } from './lookup.js';
import { readFacts, readOptions, shapeOf, unreadBecause, unwrapped } from './read.js';
import { labelOf, pathOf, runLine, whyOf, type OnRun, type RunLine } from './run-event.js';
import { fill } from './template.js';

/** Whether an address or path is ixigo's payment page, or anything under it. */
export function isPayments(urlOrPath: string): boolean {
  let path = urlOrPath;
  try {
    path = new URL(urlOrPath, IXIGO).pathname;
  } catch {
    // a path as it is
  }
  return /(^|\/)payments?(\/|$)/i.test(path);
}

function refusePayments(where: string): void {
  if (isPayments(where)) throw new TravelError('refused', 'Go never opens ixigo\'s payment page: paying goes only through the group\'s approved path.');
}

export interface EngineDeps {
  book: Book;
  /** The trip's browser fetch; null while the trip's computer is not set up here. */
  runner: (tripId: string) => Pick<RecipeRunner, 'read' | 'pageFetch' | 'canPageFetch'> | null;
  /** Keeps a place ixigo resolved; absent in tests that keep nothing. */
  pool?: Pool;
  /** The lists of what each recipe's page offers, per place (offers.ts); absent, no run filters on the site's own list. */
  offers?: Offers;
  /** The trip as a recipe's inputs read it ($trip): its head count, the members' home cities (one per member who gave
   *  one), and where and from when it goes, once the trip says. */
  trip: (tripId: string) => Promise<{ people: number; homes: string[]; destination?: string | null; start?: string | null }>;
  /** Holds the trip's computer awake for the travel the trip is talking: called once a run will open a page there. */
  warm?: (tripId: string, recipeId: string) => void;
  now: () => Date;
  log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  /** The trip's run log, for the run strip beside Go's browser: every run's start, calls, steps and end (run-event.ts). */
  onRun?: OnRun;
  /** Go's searches (the search backend's), which a composite's steps share: absent, every step runs its own page. */
  searches?: ShareSearch;
  /** Waits ms, or until the signal aborts (a composite's step waiting out a paced page's gap); tests pass their own. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * The trip's ixigo login (travel/login.ts), for a recipe with auth: login: ok, or the line for the model once the
   * person was asked. Absent, such a recipe never runs.
   */
  login?: (tripId: string, what: string) => Promise<{ ok: true } | { ok: false; note: string }>;
}

/**
 * How a composite's step that is one of the searches shares Go's searches: the answer of a search kept or running for
 * the same request (joined), or of the step's own run, which is kept for the next ask. Null when the step is not one it
 * keeps (a link, a facts recipe): the step runs on its own.
 */
export type ShareSearch = (
  id: string,
  given: Record<string, unknown>,
  o: RunFor,
  run: () => Promise<EngineAnswer>,
) => Promise<{ answer: Promise<EngineAnswer>; joined: boolean } | null>;

/** ms, or less once the signal aborts; never rejects. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    t.unref?.();
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

/**
 * A paced page held back by Go's own spacing (pace), loading nothing. waitMs: how long until its gap ends; null in its
 * quiet after a failure, which no wait inside a turn outlasts.
 */
export class PacedOutError extends TravelError {
  constructor(id: string, readonly waitMs: number | null) {
    super('unreachable', `ixigo is given a moment between ${id.split('.')[0]} pages.`);
  }
}

/**
 * At most this many pages of one recipe at once in a composite: ixigo sees every one of our boxes as one address (p0's
 * golden run, 10 Oct: three cities' bus pages at once from one address, while it was asking for Cloudflare's check).
 */
export const STEP_PAGES_AT_ONCE = 2;
/** A paced page asked again this long after its gap ends. */
const PACE_MARGIN_MS = 500;

/** Runs at most n at once; the rest wait their turn, in order. */
function atMost(n: number): <T>(run: () => Promise<T>) => Promise<T> {
  let free = n;
  const waiting: Array<() => void> = [];
  return async (run) => {
    if (free > 0) free -= 1;
    else await new Promise<void>((r) => waiting.push(r));
    try {
      return await run();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else free += 1;
    }
  };
}

/** A promise, or the signal's reason once it aborts, whichever comes first. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const stop = (): void => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', stop);
        resolve(v);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', stop);
        reject(err);
      },
    );
  });
}

/** How fast a recipe answers at one speed: its runs, its failures, and the middle and slow end of its last runs. */
export interface RecipeStat {
  recipe: string;
  speed: Speed;
  runs: number;
  failed: number;
  p50_ms: number | null;
  p90_ms: number | null;
}
/** link: an answer that loads nothing; fast: the page's own call from the trip's warm tab; page: the browser fetch of a
 *  page (a lookup's box, or a results page); kept: a facts answer from earlier inside its recipe's TTL, or a composite's
 *  step answered by a search Go kept or was running; steps: a composite, whose steps run at their own speeds. */
export type Speed = 'link' | 'fast' | 'page' | 'kept' | 'steps';
/** The last runs a recipe's speeds are measured over. */
const LAST_RUNS = 100;

const percentile = (sorted: number[], p: number): number | null =>
  sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;

/**
 * What the site itself did with the ask (a recipe with offers): the filters it applied and the sort, in words; the names
 * the run asked for that it didn't (not on its list, or no list kept yet: listed false); and its list as now known.
 */
export interface SiteSaid {
  filtered: string[];
  sorted: string | null;
  unknown: string[];
  listed: boolean;
  list: OfferList | null;
}

/** A run's ask of the site's own list (siteOf): the list's key for the place, what of it applies, and what isn't on it. */
interface Site {
  key: string | null;
  filters: Offer[];
  sort: Offer | null;
  unknown: string[];
  listed: boolean;
}

export type EngineAnswer =
  | { as: 'options'; options: RecipeOption[]; page: string; checkedAt: string; ms: number; site?: SiteSaid }
  | { as: 'facts'; title: string; rows: Array<Record<string, unknown>>; page: string; checkedAt: string; ms: number }
  | { as: 'link'; link: string; title: string; who: string | null }
  /** A composite's: its inputs as filled, and each entry (a home city) with each step's answer, or why it has none. */
  | { as: 'compare'; inputs: Record<string, unknown>; entries: Array<{ entry: string; steps: StepAnswer[] }>; checkedAt: string; ms: number };

/** One step of a composite for one entry: its recipe, and its answer or why it has none ("unreachable: ..."). */
export interface StepAnswer {
  recipe: string;
  answer?: EngineAnswer;
  why?: string;
}

/** The entries a composite runs for at most, those listed most often first (the home cities most people come from). */
export const STEPS_ENTRIES_MAX = 4;

/** Facts answers kept by recipe and inputs for the recipe's TTL: a second question about the same place is instant. */
const KEPT_FACTS_MAX = 200;

export interface RunFor {
  tripId: string;
  /** The conditions the person set that a recipe may ask ixigo to filter on: pool, non_stop, … */
  conditions?: string[];
  signal?: AbortSignal;
  onProgress?: OnProgress;
  /** A step of a composite: the composite's run, and the entry the step runs for (its lane on the strip). */
  stepOf?: string;
  lane?: string;
  /** Its fetches' place among those waiting for the computer's slots: lower first (runners.ts). */
  priority?: number;
  /** A composite's steps as they go: its entries once it knows them, then each step as it ends (ok: it answered). */
  onSteps?: (e: StepsEvent) => void;
  /**
   * A check nobody is waiting on (a watch the group asked for): it never holds the trip's computer awake (no warm) and
   * keeps no tab open there (no fast speed), so the computer sleeps again right after the page.
   */
  background?: boolean;
  /**
   * The caller reads another way when the page catches nothing (backend.ts: a filtered stays search, read again without
   * its filters): the page is asked once, and throws NothingCaughtError (runners.ts).
   */
  fallsBack?: boolean;
  /** The site's own filters and sort the run asks for, by their names on the list the recipe's page offers (offers.ts). */
  siteFilters?: string[];
  siteSort?: string;
}

export type StepsEvent = { type: 'entries'; entries: string[] } | { type: 'step'; entry: string; recipe: string; ok: boolean };

/** The most of the site's list of what it offers that a read keeps (ixigo's stays metadata: about 23 KB). */
export const OFFERS_MAX_BYTES = 300_000;
/** How long past the rest a read waits for the site's list while none is kept for the place: Bash's most grace. */
export const OFFERS_GRACE_MS = 3_000;

/** A check nobody is waiting on (a watch) waits behind every fetch a person is. */
export const BACKGROUND_PRIORITY = 9;

/** What a run's fetches carry to the runner: when to stop, and their place in the computer's queue. */
/**
 * A run a person watches: a search with its live card, never a check nobody waits on and never a composite's step (many
 * at once). It acts on the browser's stage, where the room sees it (Bash's stage: one front tab), page by page, and never
 * as a hidden page call (staging, 10 Oct: a trains search ran as a call in a tab left on ixigo's home page, and the live
 * view showed the home page for 2.6 s, then nothing).
 */
const watched = (o: RunFor): boolean => !o.background && o.onProgress !== undefined && o.stepOf === undefined;

const fetchFor = (o: RunFor): { signal?: AbortSignal; priority: number } => ({
  ...(o.signal ? { signal: o.signal } : {}),
  priority: o.priority ?? (o.background ? BACKGROUND_PRIORITY : 0),
});

/**
 * A step's run on the strip names its composite (step_of) and its lane. Not parent: a parent's run is a lookup, nested
 * in its search and never counted; a step is a run of its own, side by side with the others.
 */
const stepOf = (o: RunFor): { step_of?: string; lane?: string } => ({ ...(o.stepOf ? { step_of: o.stepOf } : {}), ...(o.lane ? { lane: o.lane } : {}) });

/** A page read as the log says it when its time runs out: its recipe, the conditions it filters on, its yes-or-no lets ("wide"). */
const aboutOf = (recipe: RecipeFile, o: RunFor, bindings: Record<string, unknown>): Record<string, string | boolean | string[]> => ({
  recipe: recipe.id,
  conditions: Object.keys(recipe.conditions ?? {}).filter((c) => o.conditions?.includes(c)),
  site: Array.isArray(bindings['site']) ? (bindings['site'] as unknown[]).filter((c): c is string => typeof c === 'string') : [],
  ...Object.fromEntries(Object.entries(bindings).filter((e): e is [string, boolean] => typeof e[1] === 'boolean')),
});

/** A choice the model was offered, by its exact name: it resolves without another load, and is kept for the words asked. */
interface Offered { lookup: string; asked: string; place: Record<string, unknown>; at: number }
const OFFERED_MS = 15 * 60_000;
const OFFERED_MAX = 500;

/** The place a search's input holds, from what Go keeps: a kind's own shape, with the words people used. */
function known(kind: TravelKind, words: string): Record<string, unknown> | null {
  try {
    if (kind === 'flights') return { words, ...airportOf(words) };
    if (kind === 'trains') return { words, ...stationOf(words) };
    if (kind === 'buses') return { words, ...busCityOf(words) };
    const p = stayPlaceOf(words);
    // A place inside one half of Goa reads its half's places (until areas come from ixigo's own area filter).
    return { words, ...p, ...(p.half ? { halves: goaHalves() } : {}) };
  } catch (err) {
    if (err instanceof TravelError && err.code === 'unknown_place') return null;
    throw err;
  }
}

/** Whether a recipe's fast speed is worth trying on this runner: it has page calls, and its Bash takes them now. */
const fastOn = (runner: ReturnType<EngineDeps['runner']>): boolean => !!runner?.pageFetch && runner.canPageFetch?.() !== false;

const choiceLine = (s: Suggestion): string => (s.line ? `"${s.name}" (${s.line})` : `"${s.name}"`);

/** How many rows an answer has, for its run's end; a link has none. */
const rowsOf = (a: EngineAnswer): { rows?: number } =>
  a.as === 'options'
    ? { rows: a.options.length }
    : a.as === 'facts'
      ? { rows: a.rows.length }
      : a.as === 'compare'
        ? { rows: a.entries.reduce((n, e) => n + e.steps.filter((s) => s.answer).length, 0) }
        : {};

export function createEngine(d: EngineDeps) {
  /** A recipe with auth: login runs only on a logged-in trip computer; otherwise the person is asked and it is refused. */
  async function loggedIn(recipe: RecipeFile, tripId: string): Promise<void> {
    if (recipe.auth !== 'login') return;
    const l = d.login ? await d.login(tripId, recipe.title) : { ok: false as const, note: `${recipe.title} needs an ixigo login, which Go can't ask for here.` };
    if (!l.ok) throw new TravelError('refused', l.note);
  }
  const offered = new Map<string, Offered>();
  /** The places ixigo listed for words it knows more than one place for, by lookup and words: asked again, the same list. */
  const listed = new Map<string, { choices: Suggestion[]; at: number }>();
  const keptFacts = new Map<string, { at: number; answer: Promise<EngineAnswer> }>();
  const timings = new Map<string, { recipe: string; speed: Speed; ms: number[]; runs: number; failed: number }>();
  /**
   * Each paced recipe's (pace) last page load and the end of its quiet after one failed, in ms. One per process, for every
   * trip at once: ixigo sees all of our boxes as one address.
   */
  const paces = new Map<string, { at: number; quietUntil: number }>();

  /** Whether a paced recipe's page may not load now: within its gap of the last load, or in its quiet after a failure. */
  function pacedOut(id: string): boolean {
    const pace = d.book.get(id)?.pace;
    const p = paces.get(id);
    if (!pace || !p) return false;
    const now = d.now().getTime();
    return now < p.quietUntil || now - p.at < pace.gap_seconds * 1_000;
  }

  /** One run, in the log and the numbers: recipe, speed, how long, and how it ended. */
  function record(recipe: string, speed: Speed, ms: number, outcome: string): void {
    const key = `${recipe}|${speed}`;
    const t = timings.get(key) ?? { recipe, speed, ms: [], runs: 0, failed: 0 };
    t.runs += 1;
    if (outcome === 'ok') {
      t.ms.push(ms);
      if (t.ms.length > LAST_RUNS) t.ms.shift();
    } else {
      t.failed += 1;
    }
    timings.set(key, t);
    d.log?.info({ recipe, speed, ms, outcome }, 'book: run');
  }

  /** Times a run and records it, whatever it ends in. */
  /** speed: the speed the run took, read when it ends (a run that tried fast and fell to the page says page). */
  async function timed<T>(recipe: string, speed: Speed | (() => Speed), run: () => Promise<T>): Promise<T> {
    const started = d.now().getTime();
    const speedNow = (): Speed => (typeof speed === 'function' ? speed() : speed);
    try {
      const out = await run();
      record(recipe, speedNow(), d.now().getTime() - started, 'ok');
      return out;
    } catch (err) {
      record(recipe, speedNow(), d.now().getTime() - started, err instanceof TravelError ? err.code : 'failed');
      throw err;
    }
  }
  /** A run on the trip's run strip. A watcher that throws is logged, and never stops the run. */
  const line = (tripId: string, start: Parameters<typeof runLine>[2]): RunLine =>
    runLine(
      (e) => {
        try {
          d.onRun?.(tripId, e);
        } catch (err) {
          d.log?.warn({ err: String(err).slice(0, 200) }, 'book: the run log failed');
        }
      },
      d.now,
      start,
    );

  /** $known(lookup, words): the place Go keeps for the words, or nothing; never a load (a member's home city). */
  const knownBy = (lookupId: string, words: string): Record<string, unknown> | undefined => {
    const kind = d.book.get(lookupId)?.keeps;
    return kind && typeof words === 'string' ? (known(kind, words) ?? undefined) : undefined;
  };

  function offer(lookup: RecipeFile, asked: string, choices: Suggestion[]): void {
    const at = d.now().getTime();
    for (const c of choices) offered.set(`${lookup.id}|${norm(c.name)}`, { lookup: lookup.id, asked, place: c.place, at });
    listed.delete(`${lookup.id}|${norm(asked)}`);
    listed.set(`${lookup.id}|${norm(asked)}`, { choices, at });
    for (const m of [offered, listed] as Array<Map<string, unknown>>) {
      while (m.size > OFFERED_MAX) {
        const oldest = m.keys().next().value;
        if (oldest === undefined) break;
        m.delete(oldest);
      }
    }
  }

  /** pick_place: the model's choice to make between the places ixigo listed for the words, by their names on the list. */
  function pickPlace(input: string, words: string, choices: Suggestion[]): TravelError {
    return new TravelError(
      'pick_place',
      `ixigo knows more than one place for "${words.slice(0, 60)}": ${choices.map(choiceLine).join('; ')}. ` +
        `Search again with ${input} written exactly as the one the ask means, or ask the group which one if it doesn't say.`,
      null,
      choices.map((c) => c.name),
    );
  }

  async function keep(lookup: RecipeFile, words: string[], place: Record<string, unknown>, from: string): Promise<void> {
    for (const w of new Set(words.map(wordsOf))) {
      try {
        await keepPlace(d.pool ?? null, lookup.keeps!, w, place, from);
      } catch (err) {
        d.log?.warn({ lookup: lookup.id, err: String(err) }, 'book: a place ixigo resolved could not be kept');
      }
    }
  }

  /**
   * The places for a search's place inputs: kept ones at once; a choice the model just made from ixigo's list; the rest
   * through ixigo's own box, all ends of one lookup in one fetch, as a run of its own under the search's (parent). With no
   * parent, nothing loads: null when a place still needs ixigo's box.
   */
  async function places(recipe: RecipeFile, given: Record<string, unknown>, o: RunFor, parent: string | null): Promise<Record<string, Record<string, unknown>> | null> {
    const out: Record<string, Record<string, unknown>> = {};
    const unknownByLookup = new Map<string, Array<{ input: string; end: End; words: string }>>();
    for (const [name, input] of Object.entries(recipe.inputs)) {
      if (input.kind !== 'place') continue;
      const words = given[name];
      if (typeof words !== 'string' || words.trim().length < 2) {
        if (input.optional) continue;
        throw new TravelError('needs_more', `${recipe.title} needs ${input.about ?? name}.`);
      }
      const lookup = d.book.get(input.lookup!)!;
      const kind = lookup.keeps!;
      // A choice the model just made from ixigo's list goes first, even when its name alone resolves ("Udaipur City
      // (UDZ)", a station's own code): it is kept for the words first asked too, so "Udaipur" means it from then on.
      const chosen = offered.get(`${lookup.id}|${norm(words)}`);
      if (chosen && d.now().getTime() - chosen.at < OFFERED_MS) {
        await keep(lookup, [chosen.asked, words], chosen.place, 'the model chose from ixigo\'s list');
        out[name] = known(kind, words) ?? { words, ...chosen.place };
        continue;
      }
      const have = known(kind, words);
      if (have) {
        out[name] = have;
        continue;
      }
      // Words ixigo just listed more than one place for: the same choice, with no second load of the list.
      const list = listed.get(`${lookup.id}|${norm(words)}`);
      if (list && d.now().getTime() - list.at < OFFERED_MS) throw pickPlace(name, words, list.choices);
      const end: End = name === 'to' ? 'to' : name === 'from' ? 'from' : 'place';
      unknownByLookup.set(lookup.id, [...(unknownByLookup.get(lookup.id) ?? []), { input: name, end, words }]);
    }
    if (unknownByLookup.size > 0 && parent === null) return null;
    for (const [lookupId, ends] of unknownByLookup) {
      const lookup = d.book.get(lookupId)!;
      const runner = d.runner(o.tripId);
      if (!runner?.read) throw new TravelError('unknown_place', `Go can't ask ixigo's box about ${ends.map((e) => `"${e.words}"`).join(' and ')} from here.`);
      const lookupRun = line(o.tripId, { recipe_id: lookupId, label: ends.map((e) => clip(e.words.trim(), 40)).join(' → '), speed: 'page', ...(parent ? { parent } : {}) });
      try {
        // Each end's suggestion call opened as the page (box.open), at once; or one fetch typing every end into the box.
        const fetches = await boxFetches(lookup, ends.map((e) => ({ end: e.end, words: e.words })));
        for (const f of fetches) refusePayments(f.path);
        const fetchStarted = d.now().getTime();
        const captures = await timed(lookupId, 'page', async () =>
          (
            await Promise.all(
              fetches.map((f) => {
                lookupRun.step(`opened ${pathOf(f.path)}`);
                return runner.read(o.tripId, `${IXIGO}${f.path}`, { capture: f.capture, steps: f.steps }, {
                  ...fetchFor(o),
                  tag: lookupRun.id,
                  onProgress: (e) => {
                    if (e.type === 'frames') lookupRun.frames(e.frames, fetchStarted);
                  },
                  onTrace: (t) => lookupRun.trace(t),
                });
              }),
            )
          ).flatMap((got) => got.captures),
        );
        const shown: string[] = [];
        for (const [i, e] of ends.entries()) {
          const list = await readSuggestions(lookup, captures, e.words);
          // A box that answered and read as nothing is said in the log as a page is (saidUnread): its calls, never a body.
          // ("[]" is ixigo knowing no place, not a shape.)
          if (list.length === 0 && captures.some((c) => c.status >= 200 && c.status < 300 && c.body.trim().length > 2)) {
            d.log?.warn({
              recipe: lookup.id, speed: 'box', check: 'shape',
              caps: captures.map((c) => ({ match: c.match.slice(0, 60), status: c.status, bytes: c.body.length, truncated: c.truncated })),
            }, "book: a page answered, and its answer didn't read");
          }
          const picked = pickSuggestion(e.words, list);
          if (!picked) throw new TravelError('unknown_place', `ixigo's ${lookup.keeps} box knows no place for "${e.words.slice(0, 60)}".`);
          if ('choose' in picked) {
            offer(lookup, e.words, picked.choose);
            throw pickPlace(e.input, e.words, picked.choose);
          }
          await keep(lookup, [e.words], picked.place, `${IXIGO}${fetches[Math.min(i, fetches.length - 1)]!.path}`);
          out[e.input] = known(lookup.keeps!, e.words) ?? { words: e.words, ...picked.place };
          // The entry as ixigo's list shows it: "Udaipur City (UDZ)".
          shown.push(list.find((s) => s.place === picked.place)?.name ?? e.words);
        }
        lookupRun.end({ ok: true, picked: shown.join(' → ') });
      } catch (err) {
        lookupRun.end({ ok: false, why: whyOf(err) });
        throw err;
      }
    }
    return out;
  }

  /** The recipe's inputs, filled: places, then counts and the rest, then what a count works out from them. */
  async function inputsOf(recipe: RecipeFile, given: Record<string, unknown>, o: RunFor, run: string | null): Promise<Record<string, unknown> | null> {
    const placed = await places(recipe, given, o, run);
    if (!placed) return null;
    const inputs: Record<string, unknown> = { ...placed };
    for (const [name, input] of Object.entries(recipe.inputs)) {
      if (input.kind === 'place' || input.value) continue;
      const v = given[name];
      if (v === undefined || v === null || v === '') {
        if (!input.optional) throw new TravelError('needs_more', `${recipe.title} needs ${input.about ?? name.replace(/_/g, ' ')}.`);
        continue;
      }
      inputs[name] = v;
    }
    const trip = await d.trip(o.tripId);
    for (const [name, input] of Object.entries(recipe.inputs)) {
      if (!input.value) continue;
      const v = given[name] ?? (await evaluate(input.value, inputs, { inputs, trip, known: knownBy }));
      if (v === undefined && input.optional) continue;
      if (input.kind === 'count') {
        const n = Math.round(Number(v));
        if (!Number.isFinite(n)) throw new TravelError('needs_more', `${recipe.title} needs ${input.about ?? name}.`);
        inputs[name] = Math.min(input.max ?? n, Math.max(input.min ?? n, n));
      } else {
        inputs[name] = v;
      }
    }
    return inputs;
  }

  /**
   * The site's own filters and sort a run asks for by name, from the list the recipe's page offers for this place: their
   * codes for the page, and the names that aren't on it. With no list kept yet nothing is filtered: the run reads the
   * page as it is, which brings the list (keepOffers).
   */
  async function siteOf(recipe: RecipeFile, inputs: Record<string, unknown>, o: RunFor): Promise<Site> {
    const asked = [...(o.siteFilters ?? []), ...(o.siteSort ? [o.siteSort] : [])];
    const key = recipe.offers ? await fill(recipe.offers.for, inputs, { url: false }) : null;
    const list = key !== null ? (d.offers?.get(recipe.id, key) ?? null) : null;
    if (!list) return { key, filters: [], sort: null, unknown: asked, listed: false };
    const f = pickOffers(list.offers, o.siteFilters ?? [], 'filter');
    const s = o.siteSort ? pickOffers(list.offers, [o.siteSort], 'sort') : { picked: [], unknown: [] };
    return { key, filters: f.picked, sort: s.picked[0] ?? null, unknown: [...f.unknown, ...s.unknown], listed: true };
  }

  /** The list the page offers, from the call it made (recipe.offers.from), kept for the place; a list that won't read is logged, never the run's failure. */
  async function keepOffers(recipe: RecipeFile, site: Site, inputs: Record<string, unknown>, captures: Capture[], tripId: string): Promise<void> {
    const offers = recipe.offers;
    const call = offers ? captures.find((c) => matches(offers.from, c.url) && c.status >= 200 && c.status < 300 && !c.truncated) : undefined;
    if (!offers || !call || site.key === null) return;
    try {
      const body: unknown = JSON.parse(call.body);
      // As it is first; then without what a logged-in answer may wrap it in (read.ts unwrapped).
      let list: Offer[] = [];
      for (const inner of [body, ...unwrapped(body)]) {
        list = asOffers(await evaluate(offers.list, inner, {}).catch(() => undefined));
        if (list.length > 0) break;
      }
      d.offers?.keep(recipe.id, site.key, await fill(offers.about, inputs, { url: false }), list, tripId);
    } catch (err) {
      d.log?.warn({ recipe: recipe.id, err: String(err).slice(0, 200) }, "book: the site's list of what it offers did not read");
    }
  }

  /**
   * Why a page (or the fast speed's page call) that answered still didn't read: which check, each capture's status, size
   * and cut, and for a shape refusal what the reader made of the body, in counts. Never a body. Every recipe's read comes
   * here, page or fast.
   */
  async function saidUnread(err: unknown, read: RecipeFile, captures: Capture[], bindings: Record<string, unknown>, speed: 'page' | 'fast'): Promise<void> {
    if (!(err instanceof TravelError) || err.code !== 'refused') return;
    const check = unreadBecause(read, captures);
    d.log?.warn({
      recipe: read.id, speed, check,
      caps: captures.map((c) => ({ match: c.match.slice(0, 60), status: c.status, bytes: c.body.length, truncated: c.truncated })),
      ...(check === 'shape' ? { shape: await shapeOf(read, captures, bindings).catch(() => null) } : {}),
    }, "book: a page answered, and its answer didn't read");
  }

  /** $conditions, the site's own filters and sort ($site, $site_sort) and the recipe's let, worked out once. */
  async function bindingsOf(recipe: RecipeFile, inputs: Record<string, unknown>, o: RunFor, site: Site): Promise<Record<string, unknown>> {
    const conditions: unknown[] = [];
    for (const [name, source] of Object.entries(recipe.conditions ?? {})) {
      if (o.conditions?.includes(name)) conditions.push(await evaluate(source, inputs, { inputs }));
    }
    const bindings: Record<string, unknown> = { conditions, site: site.filters.map((f) => f.code), site_sort: site.sort?.code ?? null };
    for (const [name, source] of Object.entries(recipe.let ?? {})) bindings[name] = await evaluate(source, inputs, { inputs, ...bindings });
    return bindings;
  }

  /** The fetch a recipe's page speed makes for these inputs: its captures (templates filled), or the first fetch whose
   *  when holds, with its steps' words filled like a box's ("{area}"). */
  async function fetchPlanOf(recipe: RecipeFile, inputs: Record<string, unknown>, bindings: Record<string, unknown>): Promise<FetchPlan> {
    const match = (m: string): Promise<string> => (m.includes('{') ? fill(m, inputs, { url: false, bindings }) : Promise.resolve(m));
    const captures = async (cs: RecipeFile['capture']): Promise<CaptureSpec[]> =>
      Promise.all((cs ?? []).map(async (c) => ({ ...c, match: await match(c.match) }) as CaptureSpec));
    const filledSteps = async (steps: Step[]): Promise<Step[]> =>
      Promise.all(
        steps.map(async (s) => ({
          ...s,
          ...('text' in s && s.text ? { text: await fill(s.text, inputs, { url: false, bindings }) } : {}),
          ...('name' in s && s.name ? { name: await fill(s.name, inputs, { url: false, bindings }) } : {}),
        }) as Step),
      );
    for (const f of recipe.fetch ?? []) {
      if ((await evaluate(f.when, inputs, { inputs, ...bindings })) !== true) continue;
      return {
        capture: await captures(f.capture ?? recipe.capture),
        ...(f.steps ? { steps: await filledSteps(f.steps) } : {}),
        ...(f.timeout_ms ? { timeoutMs: f.timeout_ms } : {}),
        ...(f.settle_ms ? { settleMs: f.settle_ms } : {}),
      };
    }
    return { capture: await captures(recipe.capture) };
  }

  /**
   * A read's plan with the call that lists what the site offers kept too, when Go keeps lists. While no list is kept for
   * the place it is waited for, a grace at most after the rest (a fresh computer's first North Goa read, 10 Oct: the
   * page made it after Bash had answered, so the list never came); once one is kept, it is only taken when it comes.
   */
  function withOffers(plan: FetchPlan, recipe: RecipeFile, site: Site): FetchPlan {
    if (!recipe.offers || !d.offers || site.key === null) return plan;
    const call: CaptureSpec = { match: recipe.offers.from, required: false, max_bytes: OFFERS_MAX_BYTES };
    return site.listed
      ? { ...plan, capture: [...plan.capture, { ...call, besides: true }] }
      : { ...plan, capture: [...plan.capture, call], graceMs: plan.graceMs ?? OFFERS_GRACE_MS };
  }

  /** Runs a recipe for the given inputs (place inputs as the person's words), on the run strip from its first speed. */
  async function run(id: string, given: Record<string, unknown>, o: RunFor, took: (s: Speed) => void = () => undefined): Promise<EngineAnswer> {
    const recipe = d.book.get(id);
    if (!recipe) throw new TravelError('refused', `There is no ixigo recipe ${id}.`);
    if (recipe.changes_state) throw new TravelError('refused', `${recipe.title} changes something on ixigo, so it runs only after the group says yes.`);
    if (!recipe.page) throw new TravelError('refused', `${recipe.title} has no page to open.`);
    await loggedIn(recipe, o.tripId);
    const runner = d.runner(o.tripId);
    // A watched run never takes the fast speed (it reads its page on the stage): its strip says page from the start.
    const speed: Speed = recipe.answer.as === 'link' ? 'link' : recipe.fast && fastOn(runner) && !o.background && !watched(o) ? 'fast' : 'page';
    const strip = { line: line(o.tripId, { recipe_id: recipe.id, label: labelOf(recipe, given), speed, ...stepOf(o) }) };
    try {
      const answer = await runRecipe(recipe, recipe.page, given, o, runner, strip, took);
      strip.line.end({ ok: true, ...rowsOf(answer) });
      return answer;
    } catch (err) {
      strip.line.end({ ok: false, why: whyOf(err) });
      throw err;
    }
  }

  /** The run itself: its inputs, then its link, or its fastest speed that answers. strip.line is the speed now running. */
  async function runRecipe(
    recipe: RecipeFile,
    pageTemplate: string,
    given: Record<string, unknown>,
    o: RunFor,
    runner: ReturnType<EngineDeps['runner']>,
    strip: { line: RunLine },
    took: (s: Speed) => void,
  ): Promise<EngineAnswer> {
    if (recipe.answer.as !== 'link' && !o.background) d.warm?.(o.tripId, recipe.id);
    const inputs = (await inputsOf(recipe, given, o, strip.line.id))!;
    const site = await siteOf(recipe, inputs, o);
    const bindings = await bindingsOf(recipe, inputs, o, site);
    const page = `${IXIGO}${await fill(pageTemplate, inputs, { url: true, bindings })}`;
    refusePayments(page);
    if (recipe.answer.as === 'link') {
      const who = recipe.answer.who ? await evaluate(recipe.answer.who, inputs, { inputs, ...bindings }) : null;
      return { as: 'link', link: page, title: await fill(recipe.answer.title, inputs, { url: false, bindings }), who: typeof who === 'string' ? who : null };
    }
    if (recipe.answer.as !== 'options' && recipe.answer.as !== 'facts') throw new TravelError('refused', `${recipe.title} is not a recipe Go runs this way.`);
    if (!runner?.read) throw new TravelError('refused', "An ixigo.com search needs the trip's computer, which is not set up here.");
    // A capture's match may be a template too: "/plan/{$slug}$" keeps that one page's document, whatever the place.
    const match = (m: string): Promise<string> => (m.includes('{') ? fill(m, inputs, { url: false, bindings }) : Promise.resolve(m));
    const read = recipe.read!;
    const filled: RecipeFile = {
      ...recipe,
      read: {
        ...read,
        rows: { ...read.rows, from: await match(read.rows.from) },
        ...(read.also ? { also: Object.fromEntries(await Promise.all(Object.entries(read.also).map(async ([k, a]) => [k, { ...a, from: await match(a.from) }]))) } : {}),
      },
    };
    const answerFrom = async (caps: Capture[], recipeRead: RecipeFile, started: number): Promise<EngineAnswer> => {
      if (recipe.answer.as === 'facts') {
        const rows = await readFacts(recipeRead, caps, inputs, page, bindings);
        const at = d.now();
        return { as: 'facts', title: await fill(recipe.answer.title, inputs, { url: false, bindings }), rows, page, checkedAt: at.toISOString(), ms: at.getTime() - started };
      }
      const options = await readOptions(recipeRead, caps, inputs, page, bindings);
      const at = d.now();
      return { as: 'options', options, page, checkedAt: at.toISOString(), ms: at.getTime() - started };
    };
    // Fast first: the page's own call from the trip's warm tab, read as its answer. Any failure falls to the page.
    if (recipe.fast && fastOn(runner) && runner.pageFetch && !o.background && !watched(o)) {
      const started = d.now().getTime();
      try {
        const url = await fill(recipe.fast.url, inputs, { url: true, bindings });
        refusePayments(url);
        const call = {
          url, method: recipe.fast.method,
          ...(recipe.fast.headers ? { headers: recipe.fast.headers } : {}),
          ...(recipe.fast.body ? { body: await fill(recipe.fast.body, inputs, { url: false, bindings }) } : {}),
        };
        const fastRun = strip.line;
        const got = await runner.pageFetch(o.tripId, call, { ...fetchFor(o), onTrace: (t) => fastRun.trace(t), tag: fastRun.id });
        const absolute = new URL(got.url || url, IXIGO).toString();
        refusePayments(absolute);
        // A call in a shape of its own (trains: confirmtkt's, where the page reads www.ixigo.com's) reads with the fast
        // speed's own list and each, its rows the call itself; any other reads with the recipe's read and answer.
        const fastRead: RecipeFile = recipe.fast.list
          ? {
              ...filled,
              read: { rows: { from: absolute, format: recipe.fast.format, list: recipe.fast.list } },
              ...(recipe.fast.each && (recipe.answer.as === 'options' || recipe.answer.as === 'facts') ? { answer: { ...recipe.answer, each: recipe.fast.each } } : {}),
            }
          : { ...filled, read: { ...filled.read!, rows: { ...filled.read!.rows, format: recipe.fast.format } } };
        const answer = await answerFrom([{ ...got, url: absolute }], fastRead, started).catch(async (err: unknown) => {
          await saidUnread(err, fastRead, [{ ...got, url: absolute }], { inputs, page, ...bindings }, 'fast');
          throw err;
        });
        took('fast');
        return answer;
      } catch (err) {
        // A Bash that takes no page calls is not a failed fast run: the run is the page's, and fast resumes once it does.
        if (fastOn(runner)) record(recipe.id, 'fast', d.now().getTime() - started, err instanceof TravelError ? err.code : 'failed');
        d.log?.warn({ recipe: recipe.id, err: String(err).slice(0, 200) }, 'book: the fast speed failed; the page speed runs');
        const fell = strip.line;
        fell.end({ ok: false, fell_to: 'page', why: whyOf(err) });
        strip.line = line(o.tripId, { recipe_id: recipe.id, label: labelOf(recipe, given), speed: 'page', fell_from: fell.id, ...stepOf(o) });
      }
    }
    const readPage = async (): Promise<EngineAnswer> => {
      const plan = withOffers(await fetchPlanOf(recipe, inputs, bindings), recipe, site);
      const started = d.now().getTime();
      const pageRun = strip.line;
      o.onProgress?.({ type: 'opening', recipeId: recipe.id, url: page });
      pageRun.step(`opened ${pathOf(page)}`);
      const got = await runner.read(o.tripId, page, plan, {
        ...fetchFor(o),
        tag: pageRun.id,
        // The page stays open as the warm tab, so the live view sees ixigo draw it; never for a check nobody waits on. A
        // live card takes one more picture of it once ixigo has drawn it (the runner's look).
        ...(o.background ? {} : { keepOpen: true, ...(o.onProgress ? { look: true } : {}) }),
        // A run a person watches acts on the stage, the one front tab the room's live view follows.
        ...(watched(o) ? { stage: true } : {}),
        // The pictures go to the live card as before, and to the run strip's browser pane, the drawn page's too.
        onProgress: (e) => {
          if (e.type === 'frames' || e.type === 'drawn') pageRun.frames(e.frames, started);
          o.onProgress?.(e);
        },
        onTrace: (t) => pageRun.trace(t),
        ...(o.fallsBack ? { fallsBack: true } : {}),
        about: aboutOf(recipe, o, bindings),
      });
      refusePayments(got.finalUrl);
      o.onProgress?.({ type: 'captured', ms: d.now().getTime() - started });
      await keepOffers(recipe, site, inputs, got.captures, o.tripId);
      const answer = await answerFrom(got.captures, filled, started).catch(async (err: unknown) => {
        await saidUnread(err, filled, got.captures, { inputs, page, ...bindings }, 'page');
        throw err;
      });
      if (!recipe.offers || answer.as !== 'options') return answer;
      // What the site did with the ask, and its list as it is now known (the page just brought it, when none was kept).
      const list = site.key !== null ? (d.offers?.get(recipe.id, site.key) ?? null) : null;
      return { ...answer, site: { filtered: site.filters.map(offerWords), sorted: site.sort?.name ?? null, unknown: site.unknown, listed: site.listed, list } };
    };
    // A paced page (pace: flights) loads at most once a gap across every trip, and not in its quiet after a failure;
    // one held back fails at once, and its caller has another way (the link to ixigo's own page).
    const pace = recipe.pace;
    if (!pace) return readPage();
    if (pacedOut(recipe.id)) {
      const p = paces.get(recipe.id)!;
      const now = d.now().getTime();
      throw new PacedOutError(recipe.id, now < p.quietUntil ? null : Math.max(0, p.at + pace.gap_seconds * 1_000 - now));
    }
    paces.set(recipe.id, { at: d.now().getTime(), quietUntil: 0 });
    try {
      return await readPage();
    } catch (err) {
      // ixigo refused or didn't answer: quiet. A run our own time cut short (a composite's) says nothing about ixigo.
      if (!o.signal?.aborted) paces.set(recipe.id, { at: d.now().getTime(), quietUntil: d.now().getTime() + pace.quiet_minutes * 60_000 });
      throw err;
    }
  }

  /**
   * A composite: its inputs, the entries it runs for, then every step for every entry at once, each a run of its own that
   * names this one (step_of) and its entry (lane). The trip's computer runs as many fetches at once as its slots allow
   * (runners.ts), and the rest wait their turn. A step that fails is its entry's why, never the composite's failure. When
   * o.signal aborts (the turn's time is up), the steps still going answer "out of time": a shared search's run goes on and
   * is kept for the next ask; any other step's run stops.
   */
  async function runSteps(recipe: RecipeFile, given: Record<string, unknown>, o: RunFor): Promise<EngineAnswer> {
    const steps = recipe.steps!;
    const started = d.now().getTime();
    let strip: RunLine | null = null;
    try {
      if (recipe.changes_state) throw new TravelError('refused', `${recipe.title} changes something on ixigo, so it runs only after the group says yes.`);
      await loggedIn(recipe, o.tripId);
      // A composite has no place inputs (format.ts), so nothing here loads.
      const inputs = (await inputsOf(recipe, given, o, null))!;
      for (const [name, input] of Object.entries(recipe.inputs)) {
        if (!input.optional && (inputs[name] === undefined || inputs[name] === null || inputs[name] === '')) {
          throw new TravelError('needs_more', `${recipe.title} needs ${input.about ?? name.replace(/_/g, ' ')}.`);
        }
      }
      const trip = await d.trip(o.tripId);
      const listed = await evaluate(steps.each, inputs, { inputs, trip });
      // Each entry once, whatever its case or spacing, the most listed first: the cities most people come from.
      const counts = new Map<string, { entry: string; n: number }>();
      for (const e of Array.isArray(listed) ? listed : listed === undefined ? [] : [listed]) {
        if (typeof e !== 'string' || e.trim() === '') continue;
        const had = counts.get(norm(e));
        counts.set(norm(e), { entry: had?.entry ?? e.trim(), n: (had?.n ?? 0) + 1 });
      }
      const entries = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, STEPS_ENTRIES_MAX).map((c) => c.entry);
      if (entries.length === 0) throw new TravelError('needs_more', `${recipe.title} has no ${steps.as.replace(/_/g, ' ')} to run for yet.`);
      const composite = line(o.tripId, { recipe_id: recipe.id, label: `${entries.map((e) => clip(e, 30)).join(', ')} · ${labelOf(recipe, inputs)}`, speed: 'steps' });
      strip = composite;
      o.onSteps?.({ type: 'entries', entries });
      // A step's fetches wait their turn by its place in the file: every city's first step (trains, the slower page)
      // takes the computer's slots before any city's second; and no more than STEP_PAGES_AT_ONCE of one recipe at once.
      const limits = new Map(steps.run.map((s) => [s.recipe, atMost(STEP_PAGES_AT_ONCE)] as const));
      const sleep = d.sleep ?? pause;
      type Step = NonNullable<RecipeFile['steps']>['run'][number];
      const loadStep = async (entry: string, step: Step, priority: number): Promise<StepAnswer> => {
        // Its turn came after the composite's time: nothing more loads.
        if (o.signal?.aborted) return { recipe: step.recipe, why: 'out of time' };
        const stepGiven: Record<string, unknown> = {};
        for (const [name, source] of Object.entries(step.given)) stepGiven[name] = await evaluate(source, inputs, { inputs, trip, [steps.as]: entry });
        const stepRun: RunFor = { tripId: o.tripId, stepOf: composite.id, lane: entry, priority, ...(o.conditions ? { conditions: o.conditions } : {}) };
        const own = (signal?: AbortSignal): Promise<EngineAnswer> => answer(step.recipe, stepGiven, { ...stepRun, ...(signal ? { signal } : {}) });
        // A search asked a minute ago, or running now (an early start, another lane's), answers the step with no load. A
        // step's own search is kept for the next ask, so the composite's time never cuts it short: it finishes in the
        // background (Bash's own timeout bounds it), and only the step stops waiting.
        const shared = d.searches ? await d.searches(step.recipe, stepGiven, stepRun, () => own()) : null;
        if (!shared) return { recipe: step.recipe, answer: await own(o.signal) };
        const got = shared.joined ? fromKept(step.recipe, stepGiven, stepRun, shared.answer) : shared.answer;
        return { recipe: step.recipe, answer: await untilAborted(got, o.signal) };
      };
      const stepFor = async (entry: string, step: Step, priority: number, again = true): Promise<StepAnswer> => {
        try {
          return await limits.get(step.recipe)!(() => loadStep(entry, step, priority));
        } catch (err) {
          if (o.signal?.aborted) return { recipe: step.recipe, why: 'out of time' };
          // A paced page held back by Go's own spacing waits out the gap and is asked once more, inside the composite's
          // time limit (p0's golden run, 10 Oct: the flights page skipped, and flights dropped from the card). With no
          // limit, nothing waits.
          if (again && o.signal && err instanceof PacedOutError && err.waitMs !== null) {
            await sleep(err.waitMs + PACE_MARGIN_MS, o.signal);
            return o.signal?.aborted ? { recipe: step.recipe, why: 'out of time' } : stepFor(entry, step, priority, false);
          }
          if (!(err instanceof TravelError)) d.log?.warn({ recipe: step.recipe, err: String(err).slice(0, 200) }, 'book: a step of a composite failed');
          return { recipe: step.recipe, why: whyOf(err) };
        }
      };
      const told = async (entry: string, step: Step, priority: number): Promise<StepAnswer> => {
        const s = await stepFor(entry, step, priority);
        o.onSteps?.({ type: 'step', entry, recipe: s.recipe, ok: !!s.answer });
        return s;
      };
      const done = await Promise.all(entries.map(async (entry) => ({ entry, steps: await Promise.all(steps.run.map((step, i) => told(entry, step, i))) })));
      const at = d.now();
      const out: EngineAnswer = { as: 'compare', inputs, entries: done, checkedAt: at.toISOString(), ms: at.getTime() - started };
      const rows = rowsOf(out);
      composite.end(rows.rows ? { ok: true, ...rows } : { ok: false, why: 'no step answered' });
      return out;
    } catch (err) {
      (strip ?? line(o.tripId, { recipe_id: recipe.id, label: labelOf(recipe, given), speed: 'steps' })).end({ ok: false, why: whyOf(err) });
      throw err;
    }
  }

  /** An answer kept from earlier or another run's, on the strip as kept: its run ends when that answer is in. */
  function fromKept(id: string, given: Record<string, unknown>, o: RunFor, hit: Promise<EngineAnswer>): Promise<EngineAnswer> {
    const recipe = d.book.get(id);
    const keptRun = line(o.tripId, { recipe_id: id, label: recipe ? labelOf(recipe, given) : id, speed: 'kept', ...stepOf(o) });
    return timed(id, 'kept', () => hit).then(
      (a) => {
        keptRun.end({ ok: true, ...rowsOf(a) });
        return a;
      },
      (err: unknown) => {
        keptRun.end({ ok: false, why: whyOf(err) });
        throw err;
      },
    );
  }

  /**
   * A recipe's answer through Go's searches (the search backend's, by the request it makes), when it is one of the
   * searches: a search kept or running for the same page answers it with no load (a kept run on the strip), and a run of
   * its own is kept for the next ask. Anything else, or with no searches wired, is answer()'s. o.signal ends only the
   * wait: the run itself finishes and is kept. A watch's checks take it, so a search the group just made answers them.
   */
  async function answerShared(id: string, given: Record<string, unknown>, o: RunFor): Promise<EngineAnswer> {
    const { signal, ...run } = o;
    const shared = d.searches ? await d.searches(id, given, run, () => answer(id, given, run)) : null;
    if (!shared) return answer(id, given, o);
    return untilAborted(shared.joined ? fromKept(id, given, run, shared.answer) : shared.answer, signal);
  }

  /** Runs a recipe for the given inputs (place inputs as the person's words), timed and recorded. */
  function answer(id: string, given: Record<string, unknown>, o: RunFor): Promise<EngineAnswer> {
    const recipe = d.book.get(id);
    if (recipe?.steps) return timed(id, 'steps', () => runSteps(recipe, given, o));
    let speed: Speed = recipe?.answer.as === 'link' ? 'link' : 'page';
    const took = (s: Speed): void => {
      speed = s;
    };
    if (recipe?.answer.as === 'facts') {
      const hit = keptHit(recipe, given);
      if (hit) return fromKept(id, given, o, hit);
      return timed(id, () => speed, () => kept(id, given, run(id, given, o, took)));
    }
    return timed(id, () => speed, () => run(id, given, o, took));
  }

  const factsKey = (id: string, given: Record<string, unknown>): string =>
    `${id}|${JSON.stringify(Object.entries(given).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, typeof v === 'string' ? norm(v) : v]))}`;

  /** A facts answer kept from earlier, inside its recipe's TTL. */
  function keptHit(recipe: RecipeFile, given: Record<string, unknown>): Promise<EngineAnswer> | null {
    const hit = keptFacts.get(factsKey(recipe.id, given));
    return hit && d.now().getTime() - hit.at < recipe.ttl_minutes * 60_000 ? hit.answer : null;
  }

  /** A facts answer, kept for its recipe's TTL by recipe and the words asked; one that fails is not kept. */
  function kept(id: string, given: Record<string, unknown>, answer: Promise<EngineAnswer>): Promise<EngineAnswer> {
    const key = factsKey(id, given);
    const nowMs = d.now().getTime();
    keptFacts.delete(key);
    keptFacts.set(key, { at: nowMs, answer });
    answer.catch(() => {
      if (keptFacts.get(key)?.answer === answer) keptFacts.delete(key);
    });
    while (keptFacts.size > KEPT_FACTS_MAX) {
      const oldest = keptFacts.keys().next().value;
      if (oldest === undefined) break;
      keptFacts.delete(oldest);
    }
    return answer;
  }

  return {
    /**
     * The request a run of the recipe will make, when every place is one Go already knows: the page it opens and the
     * fetch it makes there. Two asks with the same request are one search, whatever their words: an early start's "with
     * a pool" and the composer's "sleeping 4, with a pool" in a trip of four open the same page. Null when a place still
     * needs ixigo's box, or the recipe loads no page. Loads nothing.
     */
    async requestOf(id: string, given: Record<string, unknown>, o: RunFor): Promise<string | null> {
      const recipe = d.book.get(id);
      if (!recipe?.page || recipe.changes_state || (recipe.answer.as !== 'options' && recipe.answer.as !== 'facts')) return null;
      try {
        const inputs = await inputsOf(recipe, given, o, null);
        if (!inputs) return null;
        const bindings = await bindingsOf(recipe, inputs, o, await siteOf(recipe, inputs, o));
        const page = `${IXIGO}${await fill(recipe.page, inputs, { url: true, bindings })}`;
        const plan = await fetchPlanOf(recipe, inputs, bindings);
        // A recipe that keeps only some of a page's rows by the place's half (hotels.search: North Goa opens all of Goa's
        // page and keeps the north) shares the page with all of Goa, but not its rows, which are read after the keep: the
        // half joins the key, or all of Goa would get North Goa's stays (staging, 8 Oct).
        if (recipe.answer.as !== 'options' || !recipe.answer.keep) return JSON.stringify([page, plan]);
        const half = (inputs['place'] as { half?: unknown } | null | undefined)?.half ?? null;
        return JSON.stringify([page, plan, { half }]);
      } catch {
        // An ask the run itself refuses (a missing date): keyed by its words, and the run says why.
        return null;
      }
    },
    /**
     * The ixigo.com page a run of the recipe opens, set as asked (its filters and sort in the address), when every place
     * is one Go already knows: what the group opens themselves when Go's computer can't. Loads nothing.
     */
    async pageOf(id: string, given: Record<string, unknown>, o: RunFor): Promise<string | null> {
      const recipe = d.book.get(id);
      if (!recipe?.page || recipe.changes_state) return null;
      try {
        const inputs = await inputsOf(recipe, given, o, null);
        if (!inputs) return null;
        const bindings = await bindingsOf(recipe, inputs, o, await siteOf(recipe, inputs, o));
        return `${IXIGO}${await fill(recipe.page, inputs, { url: true, bindings })}`;
      } catch {
        return null;
      }
    },
    answer,
    answerShared,
    /** Whether a paced recipe's page may not load now (pace): its caller goes another way at once, loading nothing. */
    pacedOut,
    /**
     * A place as ixigo's box answers it for the words: the suggestion a person would pick, with what it shows (its
     * region, its country) and the place it stands for (place-for.ts reads its coordinates). Null when ixigo knows none,
     * knows more than one that fits, or there is no computer to ask from. One load of the box's own call; nothing kept.
     */
    async suggest(lookupId: string, words: string, o: RunFor): Promise<Suggestion | null> {
      const lookup = d.book.get(lookupId);
      const runner = d.runner(o.tripId);
      if (!lookup || lookup.answer.as !== 'places' || !runner?.read) return null;
      const [f] = await boxFetches(lookup, [{ end: 'place', words }]);
      if (!f) return null;
      refusePayments(f.path);
      const got = await timed(lookupId, 'page', () => runner.read!(o.tripId, `${IXIGO}${f.path}`, { capture: f.capture, steps: f.steps }, fetchFor(o)));
      const list = await readSuggestions(lookup, got.captures, words);
      const picked = pickSuggestion(words, list);
      return picked && 'place' in picked ? (list.find((x) => x.place === picked.place) ?? null) : null;
    },
    /** Each recipe's numbers at each speed, slowest middle first. */
    stats(): RecipeStat[] {
      return [...timings.values()]
        .map((t) => {
          const sorted = [...t.ms].sort((a, b) => a - b);
          return { recipe: t.recipe, speed: t.speed, runs: t.runs, failed: t.failed, p50_ms: percentile(sorted, 50), p90_ms: percentile(sorted, 90) };
        })
        .sort((a, b) => (b.p50_ms ?? 0) - (a.p50_ms ?? 0));
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;
