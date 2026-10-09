/**
 * watch_ixigo and stop_watch: the group asks Go to keep an eye on ixigo for them ("tell us when 12608's waitlist
 * confirms"), and to stop. The first check runs at once: something already true is answered now, with no watch kept,
 * and a search's options go up on a card with its line, as a stays search's do. It reads what is kept first, as an ask
 * does (a pool stay under ₹3,000 from the trip's head start), and loads a page only when that can't say it is so.
 * The checks after it are the watch runner's (recipe-watches.ts).
 */
import type pg from 'pg';
import { z } from 'zod';
import type { Switches } from '../admin/switches.js';
import type { QuickTool, TurnCtx } from '../composer/tools.js';
import type { Book } from './book/book.js';
import type { Engine, EngineAnswer } from './book/engine.js';
import { istAt } from './book/expr.js';
import type { RecipeFile } from './book/format.js';
import { clip } from './cards.js';
import type { Images } from './images.js';
import { TravelError } from './mcp-travel.js';
import { searchKindOf, type KeptAnswer } from './recipes/backend.js';
import { offersText } from './recipes/offers.js';
import { activeWatches, DROPS_PCT, flipped, flipsOf, startWatch, stopWatch, WATCH_MAX_DAYS, WATCHES_PER_TRIP } from './recipe-watches.js';
import type { ResultsStore } from './results.js';
import { answerItself } from './tools.js';
import type { TravelKind, TravelQuery } from './travel.js';

export interface WatchToolDeps {
  pool: pg.Pool;
  book: Pick<Book, 'all'>;
  /** answerShared: a search in the same round (search_stays beside watch_ixigo), or a minute ago, answers the first
   *  check with no second load (8 Oct drill: two pages for one request). */
  engine: Pick<Engine, 'answerShared'>;
  switches: Pick<Switches, 'get'>;
  now: () => Date;
  /** What Go's searches keep, read before a page loads (backend.ts keptAnswer); absent, the first check loads as before. */
  kept?: KeptAnswer;
  /** Where a search that is already so puts its options card; absent, it is said in words. */
  results?: ResultsStore;
  images?: Images;
}

/** The recipes the group may ask Go to watch: searches with options, and facts recipes that name their flips. */
export function watchableRecipes(book: Pick<Book, 'all'>): RecipeFile[] {
  return book
    .all()
    .filter((r) => !r.changes_state && r.auth === 'none' && !r.steps && flipsOf(r).length > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** One recipe in the tool's description: its id, its inputs, whether ixigo's own filters apply to it, and its flips. */
function line(r: RecipeFile): string {
  const inputs = Object.entries(r.inputs).filter(([, i]) => !i.value).map(([n, i]) => `${n}${i.optional ? '?' : ''}`).join(', ');
  return `- ${r.id} (${inputs})${r.offers ? " site_filters: ixigo's own, by name;" : ''} flips: ${flipsOf(r).join(', ')}`;
}

const Value = z.union([z.string().min(1).max(120), z.number()]);

const StopArgs = z.object({ watch_id: z.string().min(1).max(64).optional() });
type StopArgs = z.infer<typeof StopArgs>;

/** The person whose message woke this turn: who asked for the watch, named when it comes true. */
function askerOf(ctx: TurnCtx): string | null {
  const woke = new Set(ctx.wake.flatMap((w) => (w.kind === 'message' ? [(w.payload as { messageId?: string } | null)?.messageId] : [])));
  const asked = ctx.pack.messages.filter((m) => woke.has(m.message_id) && m.author.kind === 'person').at(-1);
  return asked && asked.author.kind === 'person' ? asked.author.person_id : null;
}

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

/** A watched search's inputs as the search tools ask it: for its card's title and line when it is already so. */
function queryOf(kind: TravelKind, inputs: Record<string, unknown>, filtered: string[], cap: number | null): TravelQuery {
  const text = (k: string): string | null => {
    const v = inputs[k];
    return typeof v === 'string' ? v : null;
  };
  const more = { ...(cap !== null ? { maxPriceMinor: Math.round(cap * 100) } : {}), ...(filtered.length ? { siteFilters: filtered } : {}) };
  if (kind === 'stays') {
    const [area, checkIn, checkOut, adults] = [text('place'), text('check_in'), text('check_out'), inputs['adults']];
    return { ...(area ? { area } : {}), ...(checkIn ? { checkIn } : {}), ...(checkOut ? { checkOut } : {}), ...(typeof adults === 'number' ? { guests: adults } : {}), ...more };
  }
  const [from, to, date] = [text('from'), text('to'), text('date')];
  return { ...(from ? { from } : {}), ...(to ? { to } : {}), ...(date ? { date } : {}), ...more };
}

export function watchTools(d: WatchToolDeps): Array<QuickTool<any>> {
  const recipes = watchableRecipes(d.book);
  if (recipes.length === 0) return [];
  const ids = recipes.map((r) => r.id) as [string, ...string[]];
  const off = (): boolean => d.switches.get('RECIPE_WATCHES') !== 'on' || d.switches.get('TRAVEL_MODE') !== 'ixigo_web';

  const WatchArgs = z.object({
    recipe: z.enum(ids).describe('The recipe id'),
    inputs: z.record(z.string(), Value).describe("The recipe's inputs by name, places as the person said them, dates as YYYY-MM-DD"),
    site_filters: z.array(z.string().min(1).max(80)).max(6).optional()
      .describe("ixigo's own filters for the watched search, by their names on ixigo's list for the place (in your context), as for search_stays"),
    flip: z.string().min(1).max(40).describe('What makes it come true'),
    limit: z.number().positive().max(10_000_000).optional().describe('under: the price in rupees; drops: the percent'),
    label: z.string().min(3).max(80).describe('What the group is waiting for, short: "12608\'s 3A to confirm"'),
    until: z.iso.date().optional().describe("The last day to watch; the ask's date when not said"),
  });
  const watch: QuickTool<z.infer<typeof WatchArgs>> = {
    name: 'watch_ixigo',
    description:
      "When the group asks Go to keep an eye on ixigo for them (\"tell us when it confirms\", \"if the fare drops\", \"if a pool stay under 4k opens up\"): " +
      'Go checks it every hour, every half hour near its date, and says so once, when it comes true. Flips: appears (anything at all), ' +
      `under (the cheapest at or under limit, in rupees), drops (the cheapest down limit percent, ${DROPS_PCT} when not said), or the recipe's own. ` +
      `At most ${WATCHES_PER_TRIP} at once in a trip. The recipes:\n${recipes.map(line).join('\n')}`,
    input: WatchArgs,
    timeoutMs: 20_000,
    async run(a, ctx: TurnCtx) {
      if (off()) return { error: 'not_here', note: 'Go does not watch ixigo here yet: say so, and offer to search now instead.' };
      const recipe = recipes.find((r) => r.id === a.recipe)!;
      const flips = flipsOf(recipe);
      if (!flips.includes(a.flip)) return { error: 'needs_more', note: `${a.recipe} can be watched for: ${flips.join(', ')}.` };
      if (a.flip === 'under' && a.limit === undefined) return { error: 'needs_more', note: 'under needs limit: the price in rupees.' };
      const going = await activeWatches(d.pool, ctx.tripId);
      if (going.length >= WATCHES_PER_TRIP) {
        return { error: 'too_many', note: `This trip already has ${going.length} watches: ${going.map((w) => `"${w.label}" (${w.watch_id})`).join(', ')}. Ask which one to stop (stop_watch) before another.` };
      }
      const now = d.now();
      // Until the ask's date (or the given day), never past 14 days from now.
      const date = typeof a.inputs['date'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.inputs['date']) ? a.inputs['date'] : null;
      const lastDay = a.until ?? date ?? ctx.pack.trip.dates?.start ?? null;
      const latest = now.getTime() + WATCH_MAX_DAYS * 86_400_000;
      const until = new Date(Math.min(lastDay ? Date.parse(istAt(lastDay, '23:59')) : latest, latest));
      if (until.getTime() <= now.getTime()) return { error: 'past_date', note: 'That day has passed: nothing to watch.' };
      // ixigo's own filters by name (kept in the watch's conditions): a recipe with no list of what its page offers takes none.
      const conditions = recipe.offers ? (a.site_filters ?? []) : [];
      const limit = a.flip === 'drops' ? (a.limit ?? DROPS_PCT) : (a.limit ?? null);
      // The first check, now: what is already true is answered, and no watch is kept. What is kept answers first, but
      // only that it is already so: "not yet" and a drop's baseline come from the page.
      let first: Awaited<ReturnType<typeof flipped>>;
      let answer: EngineAnswer;
      try {
        const kept = a.flip === 'drops' ? null : ((await d.kept?.(a.recipe, a.inputs, { tripId: ctx.tripId, siteFilters: conditions })) ?? null);
        const fromKept = kept ? await flipped(recipe, a.flip, kept, { inputs: a.inputs, limit, baseline: null }) : null;
        if (kept && fromKept?.on) {
          answer = kept;
          first = fromKept;
        } else {
          answer = await d.engine.answerShared(a.recipe, a.inputs, { tripId: ctx.tripId, siteFilters: conditions, signal: ctx.signal });
          // A watch on filters ixigo didn't apply would watch the wrong list: the model hears ixigo's own names instead.
          const unknown = answer.as === 'options' ? (answer.site?.unknown ?? []) : [];
          if (unknown.length > 0) {
            const list = answer.as === 'options' && answer.site?.list ? ` ixigo's own filters for this place: ${clip(offersText(answer.site.list), 1_500)}.` : '';
            return { recipe: a.recipe, error: 'needs_more', note: `ixigo applied no filter named ${unknown.join(', ')}.${list} Ask again with ixigo's names, or watch without them.` };
          }
          first = await flipped(recipe, a.flip, answer, { inputs: a.inputs, limit, baseline: null });
        }
      } catch (err) {
        if (!(err instanceof TravelError)) throw err;
        if (err.code === 'pick_place') return { recipe: a.recipe, choose: err.message };
        return { recipe: a.recipe, error: err.code, note: clip(err.message, 200) };
      }
      if (first.on && a.flip !== 'drops') {
        // A search's options that make it so go up on a card with its line, as a stays search's do: the group can pick
        // one or put them to a vote (8 Oct pass: "15 pool stays under ₹3,000" in words left nothing to tap).
        const kind = searchKindOf(a.recipe);
        if (answer.as === 'options' && kind && d.results && d.images) {
          const cap = a.flip === 'under' ? limit : null;
          const fit = answer.options.filter((o) => cap === null || (o.priceMinor > 0 && o.priceMinor <= cap * 100));
          const q = queryOf(kind, a.inputs, conditions, cap);
          // What ixigo did with the watch's filters, as the engine says it: the line names what it filtered on.
          const site = answer.site ? { filtered: answer.site.filtered, sorted: answer.site.sorted, unknown: answer.site.unknown, listed: answer.site.listed, offers: null } : null;
          const found = { results: fit, checkedAt: answer.checkedAt, found: answer.options.length, ...(answer.page ? { page: answer.page } : {}), ...(site ? { site } : {}) };
          const card = (await answerItself(kind, q, found, ctx, { results: d.results, images: d.images }, 'Already on ixigo: ')) as object;
          return { already: true, now: first.reading.what, ...card, note: 'It is already so on ixigo, and its card and line are up. Go keeps no watch for it.' };
        }
        return { already: true, now: first.reading.what, note: 'It is already so on ixigo: tell whoever asked, in one line. Go keeps no watch for it.' };
      }
      const watchId = ctx.stableId('rw');
      const started = await startWatch(
        d.pool,
        {
          watch_id: watchId, trip_id: ctx.tripId, recipe_id: a.recipe, inputs: a.inputs, conditions, flip: a.flip,
          flip_limit: limit === null ? null : String(limit), label: clip(a.label, 80), asked_by: askerOf(ctx),
          baseline: first.reading, until,
        },
        now,
      );
      return {
        watching: true,
        watch_id: watchId,
        now: first.reading.what,
        every_min: started.every_min,
        until: dayOf(until),
        tell_the_room: `Say in one line that Go will check ixigo every ${started.every_min} minutes until ${dayOf(until)} and tell them once ${clip(a.label, 80)}. Nothing else.`,
      };
    },
  };

  const stop: QuickTool<StopArgs> = {
    name: 'stop_watch',
    description: "Stops a watch on ixigo the group asked for. With no watch_id, it lists the trip's watches to choose from.",
    input: StopArgs,
    async run(a, ctx: TurnCtx) {
      if (!a.watch_id) {
        const going = await activeWatches(d.pool, ctx.tripId);
        return going.length === 0
          ? { watches: [], note: 'Go is watching nothing on ixigo for this trip.' }
          : { watches: going.map((w) => ({ watch_id: w.watch_id, label: w.label, until: dayOf(w.until) })), note: 'Call stop_watch again with the one to stop.' };
      }
      const label = await stopWatch(d.pool, ctx.tripId, a.watch_id, 'asked');
      return label ? { stopped: label } : { error: 'not_found', note: 'Go has no watch going by that id in this trip: call stop_watch with no id for the list.' };
    },
  };

  return [watch, stop];
}
