/**
 * watch_ixigo and stop_watch: the group asks Go to keep an eye on ixigo for them ("tell us when 12608's waitlist
 * confirms"), and to stop. The first check runs at once: something already true is answered now, with no watch kept.
 * The checks after it are the watch runner's (recipe-watches.ts).
 */
import type pg from 'pg';
import { z } from 'zod';
import type { Switches } from '../admin/switches.js';
import type { QuickTool, TurnCtx } from '../composer/tools.js';
import type { Book } from './book/book.js';
import type { Engine } from './book/engine.js';
import { istAt } from './book/expr.js';
import type { RecipeFile } from './book/format.js';
import { clip } from './cards.js';
import { TravelError } from './mcp-travel.js';
import { activeWatches, DROPS_PCT, flipped, flipsOf, startWatch, stopWatch, WATCH_MAX_DAYS, WATCHES_PER_TRIP } from './recipe-watches.js';

export interface WatchToolDeps {
  pool: pg.Pool;
  book: Pick<Book, 'all'>;
  /** answerShared: a search in the same round (search_stays beside watch_ixigo), or a minute ago, answers the first
   *  check with no second load (8 Oct drill: two pages for one request). */
  engine: Pick<Engine, 'answerShared'>;
  switches: Pick<Switches, 'get'>;
  now: () => Date;
}

/** The recipes the group may ask Go to watch: searches with options, and facts recipes that name their flips. */
export function watchableRecipes(book: Pick<Book, 'all'>): RecipeFile[] {
  return book
    .all()
    .filter((r) => !r.changes_state && r.auth === 'none' && !r.steps && flipsOf(r).length > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** One recipe in the tool's description: its id, its inputs, its conditions ixigo filters on, and its flips. */
function line(r: RecipeFile): string {
  const inputs = Object.entries(r.inputs).filter(([, i]) => !i.value).map(([n, i]) => `${n}${i.optional ? '?' : ''}`).join(', ');
  const conditions = Object.keys(r.conditions ?? {});
  return `- ${r.id} (${inputs})${conditions.length ? ` conditions: ${conditions.join(', ')};` : ''} flips: ${flipsOf(r).join(', ')}`;
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

export function watchTools(d: WatchToolDeps): Array<QuickTool<any>> {
  const recipes = watchableRecipes(d.book);
  if (recipes.length === 0) return [];
  const ids = recipes.map((r) => r.id) as [string, ...string[]];
  const off = (): boolean => d.switches.get('RECIPE_WATCHES') !== 'on' || d.switches.get('TRAVEL_MODE') !== 'ixigo_web';

  const WatchArgs = z.object({
    recipe: z.enum(ids).describe('The recipe id'),
    inputs: z.record(z.string(), Value).describe("The recipe's inputs by name, places as the person said them, dates as YYYY-MM-DD"),
    conditions: z.array(z.string().min(1).max(40)).max(6).optional().describe('What ixigo filters a search on, as the recipe names them (pool, breakfast, …)'),
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
      const conditions = (a.conditions ?? []).filter((c) => c in (recipe.conditions ?? {}));
      const limit = a.flip === 'drops' ? (a.limit ?? DROPS_PCT) : (a.limit ?? null);
      // The first check, now: what is already true is answered, and no watch is kept.
      let first: Awaited<ReturnType<typeof flipped>>;
      try {
        const answer = await d.engine.answerShared(a.recipe, a.inputs, { tripId: ctx.tripId, conditions, signal: ctx.signal });
        first = await flipped(recipe, a.flip, answer, { inputs: a.inputs, limit, baseline: null });
      } catch (err) {
        if (!(err instanceof TravelError)) throw err;
        if (err.code === 'pick_place') return { recipe: a.recipe, choose: err.message };
        return { recipe: a.recipe, error: err.code, note: clip(err.message, 200) };
      }
      if (first.on && a.flip !== 'drops') {
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
