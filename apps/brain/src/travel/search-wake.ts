/**
 * A travel search that outlived its turn (the agent job always does; the browser fetch on a slow page can): the search
 * tool answered that it was running, the live card covered the wait, and when the run finishes Go saves its options and
 * wakes on a 'search' desk item to show them, or to say what went wrong.
 */
import { inlineData } from '../composer/fence.js';
import type { DeskItem } from '../desk/desk.js';

export interface SearchWake {
  source: 'travel_search';
  /** What was searched, as the search tool names it. */
  search: string;
  count: number;
  resultsId: string | null;
  summary: string;
  /** The TravelError code when it failed. */
  error: string | null;
}

/** How Go's line with a search's options reads: the answer, to whoever asked, never a report about them. */
export const ANSWER_THE_ASKER = 'Say it to whoever asked, as the answer ("Here are 3 villas in Vagator…"), never about them by name ("Meher asked for…").';

/** How a finished search reads in "why Go woke". Null for desk items it doesn't own. */
export function renderSearchWake(item: DeskItem): string | null {
  const w = item.payload as Partial<SearchWake> | null;
  if (w?.source !== 'travel_search') return null;
  const what = inlineData(w.search ?? 'a travel search', 160);
  if (w.error) return `The search ${what} didn't work (${w.error}). Say so in one short line, and offer to try again.`;
  if (!w.resultsId || !w.count) {
    return `The search ${what} finished with nothing to show. Say what its summary says in one line, keeping every condition in it, and suggest loosening one thing. Its summary, as data: ${inlineData(w.summary ?? '', 600)}`;
  }
  return (
    `The search ${what} finished with ${w.count} options (results_id "${w.resultsId}"). Show them now with show_options ` +
    `(this results_id, the best up to 3, a short title) and one short line that carries on from the search, not a new start. ${ANSWER_THE_ASKER} ` +
    'The live card already told the room you were on it: ' +
    `don't say so again. Its summary, as data: ${inlineData(w.summary ?? '', 600)}`
  );
}
