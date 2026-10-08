/**
 * Watches the group asked Go to keep on ixigo: "tell us when 12608's waitlist confirms", "if the Mumbai to Goa bus goes
 * under ₹900", "if a pool stay in North Goa under ₹4k opens up". A watch is a recipe from the book with the ask's inputs,
 * and a flip: what makes it come true. Searches with options have three (appears, under, drops); a facts recipe names its
 * own in its file (trains.confirm_chance's confirms).
 *
 * Go checks a watch every hour, every half hour within two days of its date, in the background: the check never holds
 * the trip's computer awake and keeps no tab open there, and a trip's watches share one check time, so one wake does them
 * all, woken before their pages. No check runs while no Server socket is open (a trip's details come through it), and
 * one the link drops under is not counted against its watch. It says so once, when the flip comes true, through the
 * proactive bar as the group's ask (it skips the daily budget and "two in a row"; night and the dedupe still hold), and
 * the watch ends. Never "still waitlisted". A watch also ends at its date, when someone stops it, after six checks in a
 * row that failed (said in one line), or when the trip goes.
 *
 * Budgets: three watches a trip at once, and at most WATCH_CHECKS_PER_10_MIN checks across every trip in ten minutes, so
 * no trip burns ixigo's patience with the one address every computer goes out from. The RECIPE_WATCHES switch turns
 * the whole thing off.
 */
import type pg from 'pg';
import type { Switches } from '../admin/switches.js';
import type { Candidate } from '../proactive/policy.js';
import type { ProactiveStore } from '../proactive/store.js';
import type { Book } from './book/book.js';
import type { Engine, EngineAnswer } from './book/engine.js';
import { evaluate } from './book/expr.js';
import type { RecipeFile } from './book/format.js';
import { clip } from './cards.js';

export const WATCHES_PER_TRIP = 3;
export const WATCH_EVERY_MIN = 60;
export const WATCH_SOON_EVERY_MIN = 30;
/** Within this of its date, a watch is checked every WATCH_SOON_EVERY_MIN. */
const SOON_MS = 48 * 3600_000;
export const WATCH_CHECKS_PER_10_MIN = 20;
const CAP_WINDOW_MS = 10 * 60_000;
/** Six checks in a row that failed end a watch, said in one line. */
export const WATCH_FAILURES = 6;
/** The longest a watch runs. */
export const WATCH_MAX_DAYS = 14;
const MIN = 60_000;

/** A search's flips: any option at all, the cheapest at or under a price (rupees), the cheapest down a percent. */
export const OPTION_FLIPS = ['appears', 'under', 'drops'] as const;
/** drops with no percent given. */
export const DROPS_PCT = 10;

/** What a check read: the cheapest price (paise) when there are options, how many rows, and what it shows, in a line. */
export interface Reading {
  cheapest: number | null;
  rows: number;
  what: string;
}

/** The flips a recipe may be watched for: a search's built-ins, or the ones its file names. */
export function flipsOf(r: RecipeFile): string[] {
  if (r.answer.as === 'options') return [...OPTION_FLIPS];
  if (r.answer.as === 'facts') return Object.keys(r.watch ?? {});
  return [];
}

const rupees = (paise: number): string => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;

/** A facts row as a line: its values, plainly ("Rajdhani 12608, 3A: Available 4"). */
const rowLine = (row: Record<string, unknown>): string =>
  clip(Object.values(row).flat().filter((v) => typeof v === 'string' || typeof v === 'number').join(', '), 300);

/**
 * Whether an answer makes the watch come true, and what it shows. limit: the ask's number (rupees for under, a percent
 * for drops); baseline: the first check's reading (drops compares with it).
 */
export async function flipped(
  r: RecipeFile,
  flip: string,
  a: EngineAnswer,
  o: { inputs: Record<string, unknown>; limit: number | null; baseline: Reading | null },
): Promise<{ on: boolean; reading: Reading }> {
  if (a.as === 'options') {
    const priced = a.options.filter((x) => x.priceMinor > 0).sort((x, y) => x.priceMinor - y.priceMinor);
    const best = priced[0];
    const cheapest = best ? best.priceMinor : null;
    const reading: Reading = {
      cheapest,
      rows: a.options.length,
      what: best ? `${a.options.length} on ixigo; the cheapest ${rupees(best.priceMinor)}: ${clip(best.title, 80)}` : 'nothing on ixigo',
    };
    const base = o.baseline?.cheapest ?? null;
    const on =
      flip === 'appears'
        ? a.options.length > 0
        : flip === 'under'
          ? cheapest !== null && o.limit !== null && cheapest <= o.limit * 100
          : flip === 'drops'
            ? cheapest !== null && base !== null && cheapest <= base * (1 - (o.limit ?? DROPS_PCT) / 100)
            : false;
    return { on, reading };
  }
  if (a.as === 'facts') {
    const expr = r.watch?.[flip];
    let hit: Record<string, unknown> | null = null;
    if (expr) {
      for (const row of a.rows) {
        if ((await evaluate(expr, row, { inputs: o.inputs, limit: o.limit })) === true) {
          hit = row;
          break;
        }
      }
    }
    const shown = hit ?? a.rows[0];
    return { on: hit !== null, reading: { cheapest: null, rows: a.rows.length, what: shown ? rowLine(shown) : 'nothing on ixigo' } };
  }
  return { on: false, reading: { cheapest: null, rows: 0, what: 'nothing to read' } };
}

/** How often a watch is checked: its own pace, and every half hour within two days of its date. */
export function everyMin(everyMinAsked: number, until: Date, now: Date): number {
  return until.getTime() - now.getTime() <= SOON_MS ? Math.min(everyMinAsked, WATCH_SOON_EVERY_MIN) : everyMinAsked;
}

/** How soon the date is, for the nudge's urgency: the closer, the more it matters now (and it may pass night's bar). */
const urgencyBy = (until: Date, now: Date): number => {
  const hours = (until.getTime() - now.getTime()) / 3600_000;
  return hours <= 24 ? 0.9 : hours <= 72 ? 0.8 : 0.6;
};

/** A row of recipe_watches. */
export interface WatchRow {
  watch_id: string;
  trip_id: string;
  recipe_id: string;
  inputs: Record<string, unknown>;
  conditions: string[];
  flip: string;
  flip_limit: string | null;
  label: string;
  asked_by: string | null;
  baseline: Reading | null;
  every_min: number;
  until: Date;
  errors: number;
}

const COLS = 'watch_id, trip_id, recipe_id, inputs, conditions, flip, flip_limit, label, asked_by, baseline, every_min, until, errors';

/** A trip's watches going, for the stage desk and the health view: how many, and when the next is checked. No watch ids. */
export interface TripWatches {
  trip_id: string;
  active: number;
  next_check_at: string;
}

/** Every trip with a watch going, the soonest check first. */
export async function watchesNow(pool: pg.Pool, limit = 20): Promise<TripWatches[]> {
  const r = await pool.query<{ trip_id: string; active: number; next: Date }>(
    `select trip_id, count(*)::int as active, min(next_check_at) as next from recipe_watches where active group by trip_id order by next limit $1`,
    [limit],
  );
  return r.rows.map((w) => ({ trip_id: w.trip_id, active: w.active, next_check_at: w.next.toISOString() }));
}

/** The trip's watches still going, oldest first. */
export async function activeWatches(pool: pg.Pool, tripId: string): Promise<WatchRow[]> {
  const r = await pool.query<WatchRow>(`select ${COLS} from recipe_watches where trip_id = $1 and active order by created_at`, [tripId]);
  return r.rows;
}

/**
 * Starts a watch, at the time the trip's other watches are next checked when that comes within its own pace, so one
 * wake of the trip's computer checks them all.
 */
export async function startWatch(
  pool: pg.Pool,
  w: Omit<WatchRow, 'errors' | 'every_min'> & { every_min?: number },
  now: Date,
): Promise<{ every_min: number; next_check_at: Date }> {
  const every = everyMin(w.every_min ?? WATCH_EVERY_MIN, w.until, now);
  const r = await pool.query<{ next: Date | null }>(`select min(next_check_at) as next from recipe_watches where trip_id = $1 and active`, [w.trip_id]);
  const shared = r.rows[0]?.next ?? null;
  const own = new Date(now.getTime() + every * MIN);
  const next = shared && shared.getTime() > now.getTime() && shared.getTime() <= own.getTime() ? shared : own;
  await pool.query(
    `insert into recipe_watches (watch_id, trip_id, recipe_id, inputs, conditions, flip, flip_limit, label, asked_by, baseline, every_min, next_check_at, until)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) on conflict (watch_id) do nothing`,
    [w.watch_id, w.trip_id, w.recipe_id, JSON.stringify(w.inputs), w.conditions, w.flip, w.flip_limit, w.label, w.asked_by, w.baseline ? JSON.stringify(w.baseline) : null, every, next, w.until],
  );
  return { every_min: every, next_check_at: next };
}

/** Stops a trip's watch; the label of the one stopped, or null when it has none by that id going. */
export async function stopWatch(pool: pg.Pool, tripId: string, watchId: string, why: string): Promise<string | null> {
  const r = await pool.query<{ label: string }>(
    `update recipe_watches set active = false, stopped = $3 where trip_id = $1 and watch_id = $2 and active returning label`,
    [tripId, watchId, why],
  );
  return r.rows[0]?.label ?? null;
}

export interface WatchRunnerDeps {
  pool: pg.Pool;
  book: Pick<Book, 'get'>;
  /** answerShared: a search the group just made (or one running) answers a check with no load. */
  engine: Pick<Engine, 'answerShared'>;
  store: Pick<ProactiveStore, 'add'>;
  switches: Pick<Switches, 'get'>;
  now: () => Date;
  log: { warn(obj: object, msg: string): void };
  /** Whether a Server socket is open: with none, no check runs, and one the link dropped under is not a failure. */
  linkOpen: () => boolean;
  /** Wakes the trip's computer before its checks (warm.ts wakeForCheck). One that throws is logged, and the checks go on. */
  wake?: (tripId: string) => Promise<void>;
  /** The cap across every trip in ten minutes (WATCH_CHECKS_PER_10_MIN). */
  capPer10Min?: number;
}

/**
 * The checks: every due watch, a trip's together, up to the cap across every trip. A pass already running is joined,
 * never doubled. Returns how many watches came true.
 */
export function createWatchRunner(d: WatchRunnerDeps): { tick(): Promise<number> } {
  const cap = d.capPer10Min ?? WATCH_CHECKS_PER_10_MIN;
  /** When the checks of the last ten minutes ran, across every trip. */
  const recent: number[] = [];
  let running: Promise<number> | null = null;

  const backoffMs = (errors: number): number => Math.min(60, 2 ** errors) * MIN;

  async function nudge(w: WatchRow, c: Pick<Candidate, 'dedupeKey' | 'topic' | 'importance' | 'confidence' | 'urgency' | 'expiresAt'>, facts: Record<string, unknown>, now: Date): Promise<void> {
    await d.store.add({
      tripId: w.trip_id,
      source: 'watch',
      dueAt: now,
      useful: ['message'],
      personIds: w.asked_by ? [w.asked_by] : [],
      facts: { recipeWatchId: w.watch_id, label: w.label, ...facts },
      simulated: false,
      small: false,
      asked: true,
      ...c,
    });
  }

  async function check(w: WatchRow, now: Date): Promise<boolean> {
    if (now.getTime() >= w.until.getTime()) {
      await stopWatch(d.pool, w.trip_id, w.watch_id, 'until');
      return false;
    }
    const recipe = d.book.get(w.recipe_id);
    if (!recipe) {
      await stopWatch(d.pool, w.trip_id, w.watch_id, 'recipe_gone');
      return false;
    }
    recent.push(now.getTime());
    let answer: EngineAnswer;
    try {
      answer = await d.engine.answerShared(w.recipe_id, w.inputs, { tripId: w.trip_id, conditions: w.conditions, background: true });
    } catch (err) {
      // The Server's socket went under the check: not the watch's failure, and it stays due for the link's return.
      if (!d.linkOpen()) return false;
      const errors = w.errors + 1;
      const why = String(err instanceof Error ? err.message : err).slice(0, 300);
      d.log.warn({ watchId: w.watch_id, recipe: w.recipe_id, errors, err: why }, 'travel: a watch check failed');
      if (errors >= WATCH_FAILURES) {
        await d.pool.query(`update recipe_watches set active = false, stopped = 'failed', errors = $2, last_error = $3 where watch_id = $1`, [w.watch_id, errors, why]);
        await nudge(w, { dedupeKey: `recipe_watch:${w.watch_id}:stopped`, topic: 'recipe_watch_stopped', importance: 0.7, confidence: 1, urgency: 0.7, expiresAt: new Date(now.getTime() + 24 * 3600_000) }, { tries: errors }, now);
        return false;
      }
      await d.pool.query(`update recipe_watches set errors = $2, last_error = $3, next_check_at = $4 where watch_id = $1`, [w.watch_id, errors, why, new Date(now.getTime() + backoffMs(errors))]);
      return false;
    }
    const limit = w.flip_limit === null ? null : Number(w.flip_limit);
    const { on, reading } = await flipped(recipe, w.flip, answer, { inputs: w.inputs, limit, baseline: w.baseline });
    if (on) {
      // Once: the watch ends with its nudge, and the nudge's key is the watch's own.
      await d.pool.query(`update recipe_watches set active = false, fired_at = $2, errors = 0, last_error = null where watch_id = $1`, [w.watch_id, now]);
      const page = answer.as === 'options' || answer.as === 'facts' ? answer.page : null;
      await nudge(
        w,
        { dedupeKey: `recipe_watch:${w.watch_id}:fired`, topic: 'recipe_watch', importance: 0.9, confidence: 0.9, urgency: urgencyBy(w.until, now), expiresAt: w.until },
        { what: reading.what, checkedAt: now.toISOString(), ...(page ? { page } : {}) },
        now,
      );
      return true;
    }
    const next = new Date(now.getTime() + everyMin(w.every_min, w.until, now) * MIN);
    await d.pool.query(`update recipe_watches set errors = 0, last_error = null, next_check_at = $2 where watch_id = $1`, [w.watch_id, next]);
    return false;
  }

  async function once(): Promise<number> {
    if (d.switches.get('RECIPE_WATCHES') !== 'on' || !d.linkOpen()) return 0;
    const now = d.now();
    // A trip the Server no longer has keeps no watches.
    await d.pool.query(
      `update recipe_watches w set active = false, stopped = 'trip_gone' from trips t where t.trip_id = w.trip_id and t.gone_at is not null and w.active`,
    );
    while (recent.length > 0 && recent[0]! <= now.getTime() - CAP_WINDOW_MS) recent.shift();
    const room = cap - recent.length;
    if (room <= 0) return 0;
    const due = await d.pool.query<WatchRow>(
      `select ${COLS} from recipe_watches where active and next_check_at <= $1 order by next_check_at limit $2`,
      [now, room],
    );
    const byTrip = new Map<string, WatchRow[]>();
    for (const w of due.rows) byTrip.set(w.trip_id, [...(byTrip.get(w.trip_id) ?? []), w]);
    let fired = 0;
    // A trip's watches together, so one wake of its computer checks them all; trips one after another.
    for (const [tripId, watches] of byTrip) {
      await d.wake?.(tripId).catch((err: unknown) => d.log.warn({ tripId, err: String(err).slice(0, 200) }, "travel: a watch's check could not wake its computer"));
      const done = await Promise.all(watches.map((w) => check(w, now).catch((err: unknown) => {
        d.log.warn({ watchId: w.watch_id, err: String(err).slice(0, 200) }, 'travel: a watch could not be checked');
        return false;
      })));
      fired += done.filter(Boolean).length;
    }
    return fired;
  }

  return {
    tick(): Promise<number> {
      if (!running) running = once().finally(() => { running = null; });
      return running;
    },
  };
}
