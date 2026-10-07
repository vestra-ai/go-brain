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
import { boxPlan, pickSuggestion, readSuggestions, type End, type Suggestion } from './lookup.js';
import { readFacts, readOptions } from './read.js';
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
  runner: (tripId: string) => Pick<RecipeRunner, 'read' | 'pageFetch'> | null;
  /** Keeps a place ixigo resolved; absent in tests that keep nothing. */
  pool?: Pool;
  /** The trip as a recipe's inputs read it ($trip): its head count and the members' home cities. */
  trip: (tripId: string) => Promise<{ people: number; homes: string[] }>;
  /** Holds the trip's computer awake for the travel the trip is talking: called once a run will open a page there. */
  warm?: (tripId: string, recipeId: string) => void;
  now: () => Date;
  log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
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
 *  page (a lookup's box, or a results page); kept: a facts answer from earlier, inside its recipe's TTL. */
export type Speed = 'link' | 'fast' | 'page' | 'kept';
/** The last runs a recipe's speeds are measured over. */
const LAST_RUNS = 100;

const percentile = (sorted: number[], p: number): number | null =>
  sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;

export type EngineAnswer =
  | { as: 'options'; options: RecipeOption[]; page: string; checkedAt: string; ms: number }
  | { as: 'facts'; title: string; rows: Array<Record<string, unknown>>; page: string; checkedAt: string; ms: number }
  | { as: 'link'; link: string; title: string; who: string | null };

/** Facts answers kept by recipe and inputs for the recipe's TTL: a second question about the same place is instant. */
const KEPT_FACTS_MAX = 200;

export interface RunFor {
  tripId: string;
  /** The conditions the person set that a recipe may ask ixigo to filter on: pool, non_stop, … */
  conditions?: string[];
  signal?: AbortSignal;
  onProgress?: OnProgress;
}

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

const choiceLine = (s: Suggestion): string => (s.line ? `"${s.name}" (${s.line})` : `"${s.name}"`);

export function createEngine(d: EngineDeps) {
  const offered = new Map<string, Offered>();
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
  /** $known(lookup, words): the place Go keeps for the words, or nothing; never a load (a member's home city). */
  const knownBy = (lookupId: string, words: string): Record<string, unknown> | undefined => {
    const kind = d.book.get(lookupId)?.keeps;
    return kind && typeof words === 'string' ? (known(kind, words) ?? undefined) : undefined;
  };

  function offer(lookup: RecipeFile, asked: string, choices: Suggestion[]): void {
    const at = d.now().getTime();
    for (const c of choices) offered.set(`${lookup.id}|${norm(c.name)}`, { lookup: lookup.id, asked, place: c.place, at });
    while (offered.size > OFFERED_MAX) {
      const oldest = offered.keys().next().value;
      if (oldest === undefined) break;
      offered.delete(oldest);
    }
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
   * through ixigo's own box, all ends of one lookup in one fetch.
   */
  async function places(recipe: RecipeFile, given: Record<string, unknown>, o: RunFor): Promise<Record<string, Record<string, unknown>>> {
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
      const have = known(kind, words);
      if (have) {
        out[name] = have;
        continue;
      }
      const chosen = offered.get(`${lookup.id}|${norm(words)}`);
      if (chosen && d.now().getTime() - chosen.at < OFFERED_MS) {
        await keep(lookup, [chosen.asked, words], chosen.place, 'the model chose from ixigo\'s list');
        out[name] = known(kind, words) ?? { words, ...chosen.place };
        continue;
      }
      const end: End = name === 'to' ? 'to' : name === 'from' ? 'from' : 'place';
      unknownByLookup.set(lookup.id, [...(unknownByLookup.get(lookup.id) ?? []), { input: name, end, words }]);
    }
    for (const [lookupId, ends] of unknownByLookup) {
      const lookup = d.book.get(lookupId)!;
      const runner = d.runner(o.tripId);
      if (!runner?.read) throw new TravelError('unknown_place', `Go can't ask ixigo's box about ${ends.map((e) => `"${e.words}"`).join(' and ')} from here.`);
      const plan = await boxPlan(lookup, ends.map((e) => ({ end: e.end, words: e.words })));
      refusePayments(plan.path);
      const { captures } = await timed(lookupId, 'page', () =>
        runner.read(o.tripId, `${IXIGO}${plan.path}`, { capture: plan.capture, steps: plan.steps }, o.signal ? { signal: o.signal } : {}),
      );
      for (const e of ends) {
        const list = await readSuggestions(lookup, captures, e.words);
        const picked = pickSuggestion(e.words, list);
        if (!picked) throw new TravelError('unknown_place', `ixigo's ${lookup.keeps} box knows no place for "${e.words.slice(0, 60)}".`);
        if ('choose' in picked) {
          offer(lookup, e.words, picked.choose);
          throw new TravelError(
            'pick_place',
            `ixigo knows more than one place for "${e.words.slice(0, 60)}": ${picked.choose.map(choiceLine).join('; ')}. ` +
              `Search again with ${e.input} written exactly as the one the ask means, or ask the group which one if it doesn't say.`,
          );
        }
        await keep(lookup, [e.words], picked.place, `${IXIGO}${plan.path}`);
        out[e.input] = known(lookup.keeps!, e.words) ?? { words: e.words, ...picked.place };
      }
    }
    return out;
  }

  /** The recipe's inputs, filled: places, then counts and the rest, then what a count works out from them. */
  async function inputsOf(recipe: RecipeFile, given: Record<string, unknown>, o: RunFor): Promise<Record<string, unknown>> {
    const inputs: Record<string, unknown> = { ...(await places(recipe, given, o)) };
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

  /** Runs a recipe for the given inputs (place inputs as the person's words). */
  async function run(id: string, given: Record<string, unknown>, o: RunFor, took: (s: Speed) => void = () => undefined): Promise<EngineAnswer> {
    const recipe = d.book.get(id);
    if (!recipe) throw new TravelError('refused', `There is no ixigo recipe ${id}.`);
    if (recipe.changes_state) throw new TravelError('refused', `${recipe.title} changes something on ixigo, so it runs only after the group says yes.`);
    if (!recipe.page) throw new TravelError('refused', `${recipe.title} has no page to open.`);
    if (recipe.answer.as !== 'link') d.warm?.(o.tripId, recipe.id);
    const inputs = await inputsOf(recipe, given, o);
    const bindings = await bindingsOf(recipe, inputs, o);
    const page = `${IXIGO}${await fill(recipe.page, inputs, { url: true, bindings })}`;
    refusePayments(page);
    if (recipe.answer.as === 'link') {
      const who = recipe.answer.who ? await evaluate(recipe.answer.who, inputs, { inputs, ...bindings }) : null;
      return { as: 'link', link: page, title: await fill(recipe.answer.title, inputs, { url: false, bindings }), who: typeof who === 'string' ? who : null };
    }
    if (recipe.answer.as !== 'options' && recipe.answer.as !== 'facts') throw new TravelError('refused', `${recipe.title} is not a recipe Go runs this way.`);
    const runner = d.runner(o.tripId);
    if (!runner?.read) throw new TravelError('refused', "An ixigo.com search needs the trip's computer, which is not set up here.");
    // A capture's match may be a template too: "/plan/{$slug}$" keeps that one page's document, whatever the place.
    const match = (m: string): Promise<string> => (m.includes('{') ? fill(m, inputs, { url: false, bindings }) : Promise.resolve(m));
    const captures = async (cs: RecipeFile['capture']): Promise<CaptureSpec[]> =>
      Promise.all((cs ?? []).map(async (c) => ({ ...c, match: await match(c.match) }) as CaptureSpec));
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
    if (recipe.fast && runner.pageFetch) {
      const started = d.now().getTime();
      try {
        const url = await fill(recipe.fast.url, inputs, { url: true, bindings });
        refusePayments(url);
        const call = {
          url, method: recipe.fast.method,
          ...(recipe.fast.headers ? { headers: recipe.fast.headers } : {}),
          ...(recipe.fast.body ? { body: await fill(recipe.fast.body, inputs, { url: false, bindings }) } : {}),
        };
        const got = await runner.pageFetch(o.tripId, call, o.signal ? { signal: o.signal } : {});
        const absolute = new URL(got.url || url, IXIGO).toString();
        refusePayments(absolute);
        const answer = await answerFrom([{ ...got, url: absolute }], { ...filled, read: { ...filled.read!, rows: { ...filled.read!.rows, format: recipe.fast.format } } }, started);
        took('fast');
        return answer;
      } catch (err) {
        record(recipe.id, 'fast', d.now().getTime() - started, err instanceof TravelError ? err.code : 'failed');
        d.log?.warn({ recipe: recipe.id, err: String(err).slice(0, 200) }, 'book: the fast speed failed; the page speed runs');
      }
    }
    // A step's words may be templates too: what to type ("{area}") or which control to click, filled like a box's.
    const filledSteps = async (steps: Step[]): Promise<Step[]> =>
      Promise.all(
        steps.map(async (s) => ({
          ...s,
          ...('text' in s && s.text ? { text: await fill(s.text, inputs, { url: false, bindings }) } : {}),
          ...('name' in s && s.name ? { name: await fill(s.name, inputs, { url: false, bindings }) } : {}),
        }) as Step),
      );
    let plan: FetchPlan = { capture: await captures(recipe.capture) };
    for (const f of recipe.fetch ?? []) {
      if ((await evaluate(f.when, inputs, { inputs, ...bindings })) !== true) continue;
      plan = {
        capture: await captures(f.capture ?? recipe.capture),
        ...(f.steps ? { steps: await filledSteps(f.steps) } : {}),
        ...(f.timeout_ms ? { timeoutMs: f.timeout_ms } : {}),
        ...(f.settle_ms ? { settleMs: f.settle_ms } : {}),
      };
      break;
    }
    const started = d.now().getTime();
    o.onProgress?.({ type: 'opening', recipeId: recipe.id, url: page });
    const got = await runner.read(o.tripId, page, plan, { ...(o.signal ? { signal: o.signal } : {}), ...(o.onProgress ? { onProgress: o.onProgress } : {}) });
    refusePayments(got.finalUrl);
    o.onProgress?.({ type: 'captured', ms: d.now().getTime() - started });
    return answerFrom(got.captures, filled, started);
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
    /** Runs a recipe for the given inputs (place inputs as the person's words), timed and recorded. */
    answer(id: string, given: Record<string, unknown>, o: RunFor): Promise<EngineAnswer> {
      const recipe = d.book.get(id);
      let speed: Speed = recipe?.answer.as === 'link' ? 'link' : 'page';
      const took = (s: Speed): void => {
        speed = s;
      };
      if (recipe?.answer.as === 'facts') {
        const hit = keptHit(recipe, given);
        if (hit) return timed(id, 'kept', () => hit);
        return timed(id, () => speed, () => kept(id, given, run(id, given, o, took)));
      }
      return timed(id, () => speed, () => run(id, given, o, took));
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
