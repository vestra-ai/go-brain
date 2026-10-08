/**
 * The one owner of waking a trip's computer for travel. A new trip's computer is made at its setup (startComputerAtSetup);
 * after that it is woken on travel intent only: a line Jev's question 10 is sure asks for a search (the early start), a
 * search tool starting, and the recipe engine's runs. Under ixigo_web it holds the box awake for two minutes (tasks'
 * keep-warm, Bash's keep_ms); never for a kind that loads nothing (link only), and never in the other modes, whose
 * searches need no box. kind is null for a recipe outside the four searches that opens a page. Fire and forget: never
 * awaited, never throws. A watch's check, which holds nothing awake, wakes the box first (wakeForCheck).
 */
import type { Brain } from '../app.js';
import type { RecipeStat } from './book/engine.js';
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
} {
  const tries = new Map<string, number>();
  const ms: number[] = [];
  let runs = 0;
  let failed = 0;
  const at = (p: number): number | null => {
    const sorted = [...ms].sort((a, b) => a - b);
    return sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
  };
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
      } catch (err) {
        failed += 1;
        if (attempt < IXIGO_WARM_TRIES) throw err;
        tries.delete(tripId);
        brain.log.warn(
          { tripId, tries: attempt, err: String(err).slice(0, 200) },
          "travel: ixigo never answered the new trip's computer; its warm is done with a warning",
        );
      }
    },
    stat: () => (runs === 0 ? null : { recipe: IXIGO_WARM_STEP, speed: 'page', runs, failed, p50_ms: at(50), p90_ms: at(90) }),
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
