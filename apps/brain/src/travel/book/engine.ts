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
import { IXIGO, type Capture, type CaptureSpec, type FetchPlan, type RecipeOption } from '../recipes/recipe.js';
import type { RecipeRunner } from '../recipes/runners.js';
import type { TravelKind } from '../travel.js';
import type { Book } from './book.js';
import { evaluate } from './expr.js';
import type { RecipeFile, Step } from './format.js';
import { clip } from '../cards.js';
import { boxFetches, pickSuggestion, readSuggestions, type End, type Suggestion } from './lookup.js';
import { readFacts, readOptions } from './read.js';
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

export type EngineAnswer =
  | { as: 'options'; options: RecipeOption[]; page: string; checkedAt: string; ms: number }
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
}

export type StepsEvent = { type: 'entries'; entries: string[] } | { type: 'step'; entry: string; recipe: string; ok: boolean };

/** A check nobody is waiting on (a watch) waits behind every fetch a person is. */
export const BACKGROUND_PRIORITY = 9;

/** What a run's fetches carry to the runner: when to stop, and their place in the computer's queue. */
const fetchFor = (o: RunFor): { signal?: AbortSignal; priority: number } => ({
  ...(o.signal ? { signal: o.signal } : {}),
  priority: o.priority ?? (o.background ? BACKGROUND_PRIORITY : 0),
});

/**
 * A step's run on the strip names its composite (step_of) and its lane. Not parent: a parent's run is a lookup, nested
 * in its search and never counted; a step is a run of its own, side by side with the others.
 */
const stepOf = (o: RunFor): { step_of?: string; lane?: string } => ({ ...(o.stepOf ? { step_of: o.stepOf } : {}), ...(o.lane ? { lane: o.lane } : {}) });

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

  /** $conditions and the recipe's let, worked out once. */
  async function bindingsOf(recipe: RecipeFile, inputs: Record<string, unknown>, o: RunFor): Promise<Record<string, unknown>> {
    const conditions: unknown[] = [];
    for (const [name, source] of Object.entries(recipe.conditions ?? {})) {
      if (o.conditions?.includes(name)) conditions.push(await evaluate(source, inputs, { inputs }));
    }
    const bindings: Record<string, unknown> = { conditions };
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

  /** Runs a recipe for the given inputs (place inputs as the person's words), on the run strip from its first speed. */
  async function run(id: string, given: Record<string, unknown>, o: RunFor, took: (s: Speed) => void = () => undefined): Promise<EngineAnswer> {
    const recipe = d.book.get(id);
    if (!recipe) throw new TravelError('refused', `There is no ixigo recipe ${id}.`);
    if (recipe.changes_state) throw new TravelError('refused', `${recipe.title} changes something on ixigo, so it runs only after the group says yes.`);
    if (!recipe.page) throw new TravelError('refused', `${recipe.title} has no page to open.`);
    await loggedIn(recipe, o.tripId);
    const runner = d.runner(o.tripId);
    const speed: Speed = recipe.answer.as === 'link' ? 'link' : recipe.fast && fastOn(runner) && !o.background ? 'fast' : 'page';
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
    const bindings = await bindingsOf(recipe, inputs, o);
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
    if (recipe.fast && fastOn(runner) && runner.pageFetch && !o.background) {
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
        const got = await runner.pageFetch(o.tripId, call, { ...fetchFor(o), onTrace: (t) => fastRun.trace(t) });
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
        const answer = await answerFrom([{ ...got, url: absolute }], fastRead, started);
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
    const plan = await fetchPlanOf(recipe, inputs, bindings);
    const started = d.now().getTime();
    const pageRun = strip.line;
    o.onProgress?.({ type: 'opening', recipeId: recipe.id, url: page });
    pageRun.step(`opened ${pathOf(page)}`);
    const got = await runner.read(o.tripId, page, plan, {
      ...fetchFor(o),
      // The pictures go to the live card as before, and to the run strip's browser pane.
      onProgress: (e) => {
        if (e.type === 'frames') pageRun.frames(e.frames, started);
        o.onProgress?.(e);
      },
      onTrace: (t) => pageRun.trace(t),
    });
    refusePayments(got.finalUrl);
    o.onProgress?.({ type: 'captured', ms: d.now().getTime() - started });
    return answerFrom(got.captures, filled, started);
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
      // takes the computer's slots before any city's second.
      const stepFor = async (entry: string, step: NonNullable<RecipeFile['steps']>['run'][number], priority: number): Promise<StepAnswer> => {
        try {
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
        } catch (err) {
          if (o.signal?.aborted) return { recipe: step.recipe, why: 'out of time' };
          if (!(err instanceof TravelError)) d.log?.warn({ recipe: step.recipe, err: String(err).slice(0, 200) }, 'book: a step of a composite failed');
          return { recipe: step.recipe, why: whyOf(err) };
        }
      };
      const told = async (entry: string, step: NonNullable<RecipeFile['steps']>['run'][number], priority: number): Promise<StepAnswer> => {
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
        const bindings = await bindingsOf(recipe, inputs, o);
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
    answer,
    answerShared,
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
