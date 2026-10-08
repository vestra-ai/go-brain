/**
 * The one owner of waking a trip's computer for travel. A new trip's computer is made at its setup (startComputerAtSetup);
 * after that it is woken on travel intent only: a line Jev's question 10 is sure asks for a search (the early start), a
 * search tool starting, and the recipe engine's runs. Under ixigo_web it holds the box awake for two minutes (tasks'
 * keep-warm, Bash's keep_ms); never for a kind that loads nothing (link only), and never in the other modes, whose
 * searches need no box. kind is null for a recipe outside the four searches that opens a page. Fire and forget: never
 * awaited, never throws. A watch's check, which holds nothing awake, wakes the box first (wakeForCheck).
 */
import type { Brain } from '../app.js';
import type { TripEvent } from '../door/methods.js';
import type { Log } from '../log.js';
import type { EngineAnswer, RecipeStat } from './book/engine.js';
import { LINK_ONLY_KINDS } from './recipes/backend.js';
import type { TravelKind } from './travel.js';

export function warmForTravel(brain: Pick<Brain, 'switches' | 'recipeRunners'>, tripId: string, kind: TravelKind | null): void {
  if (brain.switches.get('TRAVEL_MODE') !== 'ixigo_web' || (kind !== null && LINK_ONLY_KINDS.has(kind))) return;
  brain.recipeRunners?.keepWarm(tripId);
}

/**
 * A new trip's computer, made at the trip's setup under ixigo_web: step 1 of the trip's ixigo connection. Go trips are
 * travel trips, and making a box takes far longer than waking one from its sleep (measured on staging, 8 Oct: see the PR),
 * so the trip's first search never waits for its box to be made. No hold: the box sleeps again when idle, and travel
 * intent wakes it (warmForTravel). Nothing in the other modes, nor while the trip computer is not set up here. A /v1
 * refusal throws, so setup tries again.
 */
export async function startComputerAtSetup(brain: Pick<Brain, 'switches' | 'recipeRunners'>, tripId: string): Promise<void> {
  if (brain.switches.get('TRAVEL_MODE') !== 'ixigo_web' || !brain.recipeRunners) return;
  await brain.recipeRunners.start(tripId);
}

/** Step 3's setup step, after the organiser's ixigo login prompt (step 2, login.ts), which never waits on it. */
export const IXIGO_WARM_STEP = 'travel.ixigo_warm';
/** Tries a trip's warm gets. Each wakes the box, so with ixigo down the step stops there, done with a warning. */
export const IXIGO_WARM_TRIES = 3;

/**
 * Step 3 of the trip's ixigo connection, after its computer is started and the login prompt is out: the computer's Chrome
 * visits ixigo once, its popup closed, so the first search is not its first visit (runners.ts COLD_COMPUTER). Under
 * ixigo_web only, and done at once in the other modes or while the trip computer is not set up here. A visit ixigo did not
 * answer throws, so setup tries again, up to IXIGO_WARM_TRIES: then the step is done with a warning (the log, and its line
 * in the health view's recipes); the first search still has its one retry. Tries are counted in this process: a restart
 * starts a trip's count again.
 */
export function createIxigoWarm(brain: Pick<Brain, 'switches' | 'recipeRunners' | 'log' | 'now'>): {
  run(tripId: string): Promise<void>;
  /** The warms so far, as the health view's recipes line them; null before any. */
  stat(): RecipeStat | null;
  /** The trip's warm ended with its warning: ixigo never answered its computer (in this process). */
  gaveUp(tripId: string): boolean;
} {
  const tries = new Map<string, number>();
  const gaveUp = new Set<string>();
  const ms: number[] = [];
  let runs = 0;
  let failed = 0;
  const at = (p: number): number | null => percentileOf(ms, p);
  return {
    async run(tripId) {
      if (brain.switches.get('TRAVEL_MODE') !== 'ixigo_web' || !brain.recipeRunners) return;
      const attempt = (tries.get(tripId) ?? 0) + 1;
      tries.set(tripId, attempt);
      const started = brain.now().getTime();
      runs += 1;
      try {
        await brain.recipeRunners.prime(tripId);
        ms.push(brain.now().getTime() - started);
        if (ms.length > 100) ms.shift();
        tries.delete(tripId);
        gaveUp.delete(tripId);
      } catch (err) {
        failed += 1;
        if (attempt < IXIGO_WARM_TRIES) throw err;
        tries.delete(tripId);
        gaveUp.add(tripId);
        brain.log.warn(
          { tripId, tries: attempt, err: String(err).slice(0, 200) },
          "travel: ixigo never answered the new trip's computer; its warm is done with a warning",
        );
      }
    },
    stat: () => (runs === 0 ? null : { recipe: IXIGO_WARM_STEP, speed: 'page', runs, failed, p50_ms: at(50), p90_ms: at(90) }),
    gaveUp: (tripId) => gaveUp.has(tripId),
  };
}

/** The p-th percentile of the last times, for a health line; null before any. */
function percentileOf(ms: number[], p: number): number | null {
  const sorted = [...ms].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

/** The setup step after the ixigo warm: the trip's likely first stays search, run before anyone asks. */
export const STAYS_HEAD_START_STEP = 'travel.stays_head_start';
/** Head starts a trip may run in a day (UTC): each is a stays page on ixigo, a slow one for a whole state. */
export const HEAD_STARTS_PER_DAY = 4;
/** A trip whose dates or destination changed waits this long for the rest of the edit before its head start. */
export const HEAD_START_SETTLE_MS = 30_000;
/** A person's first line after the trip's head start ran out of its time runs it again, at most this often. */
export const HEAD_START_ON_MESSAGE_MS = 60 * 60_000;
/** The longest stay a head start searches, in nights. */
export const HEAD_START_MAX_NIGHTS = 30;

/** hotels.search's inputs for the trip's own place and dates; its head count is the trip's, as the engine fills it. */
export interface HeadStartAsk {
  place: string;
  check_in: string;
  check_out: string;
}

export interface StaysHeadStartDeps {
  switches: Brain['switches'];
  now: () => Date;
  log: Pick<Log, 'info' | 'warn'>;
  /** The trip's destination and dates as the trip has them, each null when not set. */
  trip(tripId: string): Promise<{ destination: string | null; start: string | null; end: string | null }>;
  /** The trip's own today, "YYYY-MM-DD" in its time zone. */
  today(tripId: string): Promise<string>;
  /**
   * The search through Go's searches (the backend's shareStep): a search kept or running for the same page answers it
   * (joined, nothing loads), else `run` runs and is kept under the ask's key for the next ask. No live card. Null when
   * hotels.search is not one Go keeps.
   */
  share(tripId: string, ask: HeadStartAsk, run: () => Promise<EngineAnswer>): Promise<{ answer: Promise<EngineAnswer>; joined: boolean } | null>;
  /** hotels.search on the trip's computer, as a run nobody waits on (background: no hold, behind people's fetches). */
  run(tripId: string, ask: HeadStartAsk): Promise<EngineAnswer>;
  /** How long a stays search is kept: hotels.search's TTL. */
  ttlMs: number;
  /** The trip's ixigo warm gave up: ixigo never answered its computer, so a head start would only fail. */
  warmGaveUp(tripId: string): boolean;
  /** The trip computer is set up here (the tasks lane's runners), as for every warm in this file. */
  computerSetUp(): boolean;
  /**
   * The trip's dates or destination changed and this head start loaded and kept their stays: Go may put them up
   * (head-start-wake.ts decides). Never at setup, on a person's line, or when the search was kept or running already
   * (an ask got there first, or the same dates were agreed again).
   */
  onChangedKept?(tripId: string, ask: HeadStartAsk, startedAt: Date): void;
}

const DAY_MS = 86_400_000;

/**
 * The stays head start, under ixigo_web: the trip's likely first stays search (its destination, its dates, its head
 * count, no conditions) run before anyone asks, so "stays for our dates" answers from the kept search in under a second.
 * It runs after the ixigo warm at setup, when the trip's dates or destination change (settled HEAD_START_SETTLE_MS), and
 * on a person's first line after the last one ran out of its time (at most once in HEAD_START_ON_MESSAGE_MS). It goes
 * through Go's searches, so it posts nothing in the room and an ask of the same page joins it; nothing loads when a
 * search for that page is kept or running already. Never in the other modes or while the trip computer is not set up
 * here, without a destination and both dates, for
 * dates gone by or a stay over HEAD_START_MAX_NIGHTS, after the trip's warm gave up, or past HEAD_STARTS_PER_DAY loads a
 * day. Fire and forget: never awaited by setup or the trip log, never throws. Counts live in this process.
 */
export function createStaysHeadStart(d: StaysHeadStartDeps): {
  /** The setup step's run: starts the head start and returns at once, so setup never waits on ixigo. */
  atSetup(tripId: string): Promise<void>;
  /** The trip log's listener: trip.updated (dates, destination) and a person's message. */
  onEvent(ev: TripEvent): void;
  /** The head starts so far, as the health view's recipes line them; null before any. */
  stat(): RecipeStat | null;
  stop(): void;
} {
  const loadsToday = new Map<string, { day: string; count: number }>();
  /** When each trip's last head start ran or joined one: its search is kept until ttlMs after. */
  const lastAt = new Map<string, number>();
  const lastOnMessage = new Map<string, number>();
  const settling = new Map<string, ReturnType<typeof setTimeout>>();
  const ms: number[] = [];
  let runs = 0;
  let failed = 0;

  async function start(tripId: string, why: 'setup' | 'changed' | 'message'): Promise<void> {
    if (d.switches.get('TRAVEL_MODE') !== 'ixigo_web' || !d.computerSetUp() || d.warmGaveUp(tripId)) return;
    const t = await d.trip(tripId);
    if (!t.destination || !t.start || !t.end) return;
    const nights = Math.round((Date.parse(t.end) - Date.parse(t.start)) / DAY_MS);
    if (!(nights >= 1 && nights <= HEAD_START_MAX_NIGHTS) || t.start < (await d.today(tripId))) return;
    const day = d.now().toISOString().slice(0, 10);
    const used = loadsToday.get(tripId);
    const count = used?.day === day ? used.count : 0;
    if (count >= HEAD_STARTS_PER_DAY) {
      d.log.info({ tripId, why }, "travel: the trip's stays head starts are used up for today");
      return;
    }
    const ask: HeadStartAsk = { place: t.destination, check_in: t.start, check_out: t.end };
    const started = d.now().getTime();
    lastAt.set(tripId, started);
    const shared = await d.share(tripId, ask, () => d.run(tripId, ask));
    // A search for the same page kept or running answers it: nothing loads.
    if (!shared || shared.joined) return;
    loadsToday.set(tripId, { day, count: count + 1 });
    runs += 1;
    try {
      const answer = await shared.answer;
      ms.push(d.now().getTime() - started);
      if (ms.length > 100) ms.shift();
      // A place ixigo's box resolved during the run keys the next ask on the page it opens, not the words: keep the
      // answer under that key too (a share whose run is the answer itself loads nothing).
      await d.share(tripId, ask, () => Promise.resolve(answer));
      d.log.info({ tripId, why, ms: d.now().getTime() - started }, "travel: the trip's stays head start is kept");
      if (why === 'changed') d.onChangedKept?.(tripId, ask, new Date(started));
    } catch (err) {
      failed += 1;
      lastAt.delete(tripId);
      d.log.warn({ tripId, why, err: String(err).slice(0, 200) }, "travel: the trip's stays head start failed; the ask runs its own search");
    }
  }

  const go = (tripId: string, why: 'setup' | 'changed' | 'message'): void => {
    start(tripId, why).catch((err: unknown) => d.log.warn({ tripId, why, err: String(err).slice(0, 200) }, "travel: the trip's stays head start could not start"));
  };

  return {
    async atSetup(tripId) {
      go(tripId, 'setup');
    },
    onEvent(ev) {
      if (ev.type === 'trip.updated') {
        if (!ev.data.changed.some((c) => c === 'dates' || c === 'destination')) return;
        clearTimeout(settling.get(ev.trip_id));
        const timer = setTimeout(() => {
          settling.delete(ev.trip_id);
          go(ev.trip_id, 'changed');
        }, HEAD_START_SETTLE_MS);
        timer.unref?.();
        settling.set(ev.trip_id, timer);
        return;
      }
      if (ev.type !== 'message.created' || ev.data.message.author.kind !== 'person') return;
      const nowMs = d.now().getTime();
      if (nowMs - (lastAt.get(ev.trip_id) ?? -Infinity) < d.ttlMs) return;
      if (nowMs - (lastOnMessage.get(ev.trip_id) ?? -Infinity) < HEAD_START_ON_MESSAGE_MS) return;
      lastOnMessage.set(ev.trip_id, nowMs);
      go(ev.trip_id, 'message');
    },
    stat: () => (runs === 0 ? null : { recipe: STAYS_HEAD_START_STEP, speed: 'page', runs, failed, p50_ms: percentileOf(ms, 50), p90_ms: percentileOf(ms, 90) }),
    stop() {
      for (const timer of settling.values()) clearTimeout(timer);
      settling.clear();
    },
  };
}

/**
 * How long a watch's check gives its trip's computer to wake before its page. A page's own time (FETCH_TIMEOUT_MS) counts
 * the wake, and a check finds its box asleep more often than not (it holds nothing awake); Bash's wake gate holds a
 * wake's mean at 5 s, and this is twice that.
 */
export const CHECK_WAKE_LEAD_MS = 10_000;

const nap = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref());

/**
 * A watch's check, under ixigo_web: the trip's computer woken with no hold before the check's page, and given
 * CHECK_WAKE_LEAD_MS unless it was up already, so the page's time goes on ixigo, not on the wake. Nothing in the other
 * modes, nor while the trip computer is not set up here. A /v1 refusal throws; the page wakes the box itself then.
 */
export async function wakeForCheck(brain: Pick<Brain, 'switches' | 'recipeRunners'>, tripId: string, sleep = nap): Promise<void> {
  if (brain.switches.get('TRAVEL_MODE') !== 'ixigo_web' || !brain.recipeRunners) return;
  if ((await brain.recipeRunners.start(tripId)) !== 'ready') await sleep(CHECK_WAKE_LEAD_MS);
}
