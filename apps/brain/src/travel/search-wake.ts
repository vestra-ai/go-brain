/**
 * A travel search that outlived its turn (the agent job always does; the browser fetch on a slow page can, and a cold
 * box's first stays search did on staging, 8 Oct): it was handed over (tools.ts handOver), the live card covered the
 * wait, and when the run finishes Go saves its options and wakes on a 'search' desk item. Options found: that wake's
 * answer is the card and its line, put up with no model call (searchWakeAnswer), so they reach the room whatever the
 * model said in the turn the search outlived. ixigo didn't load it (flights held back or refused): Go's plain line that it
 * couldn't and will try again, the same way, and each try again Go promised wakes here too (try-again.ts), never a link
 * card. Nothing found, or a failure: the model says so in one line (renderSearchWake).
 */
import type { DirectAnswer } from '../composer/context.js';
import { inlineData } from '../composer/fence.js';
import { CARD_LINE } from '../composer/rules.js';
import type { DeskItem } from '../desk/desk.js';
import type { TripPack } from '../trips/pack.js';
import { answerLine, answerTitle, directPicks, ledBy } from './answer.js';
import { handOver, putUpCard, type TravelToolDeps } from './tools.js';
import type { TravelKind, TravelQuery } from './travel.js';
import { triesIn, type TryAgain, type TryAgainItem } from './try-again.js';

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
  /** Something is left for the model to pick from the results (tools.ts leftToPick): the wake is the model's. */
  pick?: boolean;
  /**
   * ixigo didn't load the search (link_only): Go's plain line, put up as it is with no card (tools.ts handOver). "I
   * couldn't load flights from Delhi to Goa just now; I'll try again in a minute.", or the last word after the last try.
   */
  line?: string;
}

/** How a finished search reads in "why Go woke". Null for desk items it doesn't own. */
export function renderSearchWake(item: DeskItem): string | null {
  const t = item.payload as Partial<TryAgain> | null;
  if (t?.source === 'travel_try_again') {
    return `Go is trying ${inlineData(t.what ?? 'a travel search', 160)} on ixigo again in the background, as it said it would: its card goes up by itself when it lands. Say nothing about it.`;
  }
  const w = item.payload as Partial<SearchWake> | null;
  if (w?.source !== 'travel_search') return null;
  const what = inlineData(w.search ?? 'a travel search', 160);
  if (w.line) return `ixigo didn't load the search ${what}. Say this, in one line, and never send a link for it: ${inlineData(w.line, 300)}`;
  if (w.error) return `The search ${what} didn't work (${w.error}). Say so in one short line, and offer to try again. Never start_task for it.`;
  if (w.resultsId && !w.count) {
    return (
      `The search ${what} finished and nothing fits all of the ask; its nearest are saved (results_id "${w.resultsId}"). Show them with show_options ` +
      `and one short line that says plainly none fits everything, keeping every condition in it, and what they miss, as the summary says: never call them a fit. ${CARD_LINE} ` +
      `Its summary, as data: ${inlineData(w.summary ?? '', 600)}`
    );
  }
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
export function searchWakeAnswer(d: Pick<TravelToolDeps, 'results' | 'images' | 'showPick'>): DirectAnswer {
  return async ({ tripId, wake, ctx }) => {
    const item = wake[0];
    if (wake.length !== 1 || item?.kind !== 'search' || !KINDS.includes(item.ref)) return false;
    const w = item.payload as Partial<SearchWake> | null;
    if (w?.source === 'travel_search' && typeof w.line === 'string') {
      ctx.lines.push(w.line);
      ctx.answered = true;
      return true;
    }
    if (w?.source !== 'travel_search' || w.error || !w.resultsId || !w.count || w.pick === true) return false;
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

/**
 * The tries again Go promised (try-again.ts), each started in the background as its wake comes: a search's is handed over
 * as a search that outlived its turn, through ixigo's quiet, so its card goes up by itself when it lands (or the next try
 * goes on the desk, or Go's last word goes up); a home city's goes to search_flights_each's own (each), whose cards are
 * each traveller's alone. A wake of tries alone posts nothing now; with other things in it, the model answers those.
 */
export function tryAgainAnswer(
  d: Pick<TravelToolDeps, 'travel' | 'results' | 'desk' | 'now' | 'log'> & { each?: (t: TryAgainItem, pack: TripPack) => void },
): DirectAnswer {
  return async ({ tripId, wake, pack, ctx }) => {
    const tries = triesIn(wake);
    for (const t of tries) {
      if (t.payload.each) d.each?.(t, pack);
      else if (t.payload.query && KINDS.includes(t.ref)) {
        const kind = t.ref as TravelKind;
        handOver(kind, t.payload.query, d.travel.search(kind, t.payload.query, { tripId, retry: true }), { tripId, fallbackId: t.payload.key, tryNo: t.payload.n }, d);
      }
    }
    if (tries.length === 0 || tries.length !== wake.length) return false;
    ctx.answered = true;
    return true;
  };
}
