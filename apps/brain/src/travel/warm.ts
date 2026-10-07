/**
 * The one owner of waking a trip's computer for travel. It is called on travel intent only: a line Jev's question 10 is
 * sure asks for a search (the early start), a search tool starting, and the recipe engine's runs. Under ixigo_web it holds
 * the box awake for two minutes (tasks' keep-warm, Bash's keep_ms); never for a kind that loads nothing (link only), and
 * never in the other modes, whose searches need no box. Fire and forget: never awaited, never throws.
 */
import type { Brain } from '../app.js';
import { LINK_ONLY_KINDS } from './recipes/backend.js';
import type { TravelKind } from './travel.js';

export function warmForTravel(brain: Pick<Brain, 'switches' | 'recipeRunners'>, tripId: string, kind: TravelKind): void {
  if (brain.switches.get('TRAVEL_MODE') !== 'ixigo_web' || LINK_ONLY_KINDS.has(kind)) return;
  brain.recipeRunners?.keepWarm(tripId);
}
