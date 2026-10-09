/**
 * A travel search that outlived its turn (the agent job always does; the browser fetch on a slow page can, and a cold
 * box's first stays search did on staging, 8 Oct): it was handed over (tools.ts handOver), the live card covered the
 * wait, and when the run finishes Go saves its options and wakes on a 'search' desk item. Options found: that wake's
 * answer is the card and its line, put up with no model call (searchWakeAnswer), so they reach the room whatever the
 * model said in the turn the search outlived. Nothing found, or a failure: the model says so in one line (renderSearchWake).
 */
import type { DirectAnswer } from '../composer/context.js';
import { inlineData } from '../composer/fence.js';
import { CARD_LINE } from '../composer/rules.js';
import type { DeskItem } from '../desk/desk.js';
import { answerLine, answerTitle, directPicks, ledBy } from './answer.js';
import { putUpCard, type TravelToolDeps } from './tools.js';
import type { TravelKind, TravelQuery } from './travel.js';

export interface SearchWake {
  source: 'travel_search';
  /** What was searched, as the search tool names it. */
  search: string;
  count: number;
  resultsId: string | null;
  summary: string;
  /** The TravelError code when it failed. */
  error: string | null;
  /** Words before the card's line: a search ixigo left filters off says so first (answer.ts leftOff). */
  lead?: string;
}

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
    `(this results_id, the best up to 3, a short title) and one short line that carries on from the search, not a new start. ${CARD_LINE} ` +
    'The live card already told the room you were on it: ' +
    `don't say so again. Its summary, as data: ${inlineData(w.summary ?? '', 600)}`
  );
}

const KINDS: readonly string[] = ['flights', 'trains', 'buses', 'stays'];

/**
 * A finished search's wake, answered with no model call: its saved options on a card (the same picks a search that
 * answers its turn makes) and the card's line, one line. Any other wake, a search that found nothing or failed, or a set
 * no longer saved, goes to the model as before.
 */
export function searchWakeAnswer(d: Pick<TravelToolDeps, 'results' | 'images'>): DirectAnswer {
  return async ({ tripId, wake, ctx }) => {
    const item = wake[0];
    if (wake.length !== 1 || item?.kind !== 'search' || !KINDS.includes(item.ref)) return false;
    const w = item.payload as Partial<SearchWake> | null;
    if (w?.source !== 'travel_search' || w.error || !w.resultsId || !w.count) return false;
    const set = await d.results.get(tripId, w.resultsId);
    if (!set || set.options.length === 0) return false;
    const kind = item.ref as TravelKind;
    const q = set.query as TravelQuery;
    const numbers = directPicks(kind, set.options);
    const line = ledBy(typeof w.lead === 'string' ? w.lead : undefined, answerLine(kind, q, numbers.map((n) => set.options[n - 1]!)));
    await putUpCard(set, numbers, { title: answerTitle(kind, q), line }, ctx, d);
    ctx.answered = true;
    return true;
  };
}
