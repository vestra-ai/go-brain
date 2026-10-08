/**
 * The one owner of waking a trip's computer for travel. A new trip's computer is made at its setup (startComputerAtSetup);
 * after that it is woken on travel intent only: a line Jev's question 10 is sure asks for a search (the early start), a
 * search tool starting, and the recipe engine's runs. Under ixigo_web it holds the box awake for two minutes (tasks'
 * keep-warm, Bash's keep_ms); never for a kind that loads nothing (link only), and never in the other modes, whose
 * searches need no box. kind is null for a recipe outside the four searches that opens a page. Fire and forget: never
 * awaited, never throws.
 */
import type { Brain } from '../app.js';
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

/** Step 2's setup step. The organiser's ixigo login prompt (step 3) is the setup step that runs after it. */
export const IXIGO_WARM_STEP = 'travel.ixigo_warm';

/**
 * Step 2 of the trip's ixigo connection, right after its computer is made: the computer's Chrome visits ixigo once, its
 * popup closed, so the first search is not its first visit (runners.ts COLD_COMPUTER). Under ixigo_web only, and done at
 * once in the other modes or while the trip computer is not set up here. A visit ixigo did not answer throws, so setup
 * tries again, and the login prompt waits for it.
 */
export async function warmIxigoAtSetup(brain: Pick<Brain, 'switches' | 'recipeRunners'>, tripId: string): Promise<void> {
  if (brain.switches.get('TRAVEL_MODE') !== 'ixigo_web' || !brain.recipeRunners) return;
  await brain.recipeRunners.prime(tripId);
}
