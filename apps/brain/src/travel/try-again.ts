/**
 * A search ixigo didn't load for Go (G1, the App team, 11 Oct: on prod one traveller got options and the other "Go can't
 * read ixigo's flights from its computer right now", on a link card). An ixigo search link card is never the answer: Go
 * says plainly it couldn't load them and will try again in a minute, then tries again in the background, a minute
 * apart, TRIES times. The card goes up when a try lands; when none does, one plain last line, never a link. Each wait is
 * a desk item, so a restart between tries keeps Go's word, and each try goes through ixigo's quiet after a refusal
 * (engine.ts RunFor.retry): a try our own pacer turned away would be no try at all.
 */
import type { Desk, DeskItem } from '../desk/desk.js';
import type { TravelKind, TravelQuery } from './travel.js';

/** The tries after the first, each about a minute after the last. */
export const TRIES = 2;
export const TRY_AGAIN_MS = 60_000;

export interface TryAgain {
  source: 'travel_try_again';
  /** The tries of one search share it: their desk ids, and the wakes their last one puts up. */
  key: string;
  /** What Go couldn't load, as the room hears it: "flights from Delhi to Goa". */
  what: string;
  /** This try's number, from 1 to TRIES. */
  n: number;
  /** A search's own ask (search_flights, search_stays, a search that outlived its turn): its card goes up for the room. */
  query?: TravelQuery;
  /** A home city's flights for the travellers who fly from it (search_flights_each): each one's card is theirs alone. */
  each?: { home: string; to: string; date: string; cabin?: string };
}

export type TryAgainItem = DeskItem & { payload: TryAgain };

/** The tries in a wake. */
export const triesIn = (wake: DeskItem[]): TryAgainItem[] =>
  wake.filter((i): i is TryAgainItem => i.kind === 'search' && (i.payload as Partial<TryAgain> | null)?.source === 'travel_try_again');

/** Puts try n on the desk, a minute from now: the same key and n are one item, however often they are put. */
export function tryAgain(d: { desk: Pick<Desk, 'put'>; now: () => Date }, tripId: string, kind: TravelKind, t: Omit<TryAgain, 'source'>): Promise<void> {
  return d.desk.put({
    id: `try_again:${tripId}:${t.key}:${t.n}`, tripId, kind: 'search', ref: kind, dueAt: new Date(d.now().getTime() + TRY_AGAIN_MS),
    payload: { source: 'travel_try_again', ...t } satisfies TryAgain,
  });
}

/** Go's line when ixigo didn't load a search: "I couldn't load flights from Delhi to Goa just now; I'll try again in a minute." */
export const notLoadedLine = (what: string): string => `I couldn't load ${what} just now; I'll try again in a minute.`;

/** Go's last word when no try landed: plain, with no link. */
export const stillNotLoadedLine = (what: string): string => `I tried again and still couldn't load ${what}. Ask me in a bit and I'll look once more.`;
