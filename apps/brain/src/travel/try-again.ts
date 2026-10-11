/**
 * A search ixigo didn't load for Go (G1, the App team, 11 Oct: on prod one traveller got options and the other "Go can't
 * read ixigo's flights from its computer right now", on a link card). An ixigo search link card is never the answer: Go
 * says plainly it couldn't load them and will try again in a minute, then tries again in the background, a minute
 * apart, TRIES times. The card goes up when a try lands; when none does, one plain last line, never a link. Each wait is
 * a desk item, so a restart between tries keeps Go's word. A try goes through Go's own quiet after a failed load
 * (engine.ts RunFor.retry): a try our own pacer turned away would be no try at all. But when ixigo itself refused (a 403,
 * a 429, Cloudflare's check), asking again inside its quiet risks the shared address for every trip: the try waits past
 * it, and the line says so ("ixigo asked us to slow down").
 */
import type { Desk, DeskItem } from '../desk/desk.js';
import type { TravelKind, TravelQuery } from './travel.js';

/** The tries after the first, each about a minute after the last. */
export const TRIES = 2;
export const TRY_AGAIN_MS = 60_000;
/** A try that waits out ixigo's own quiet comes this long after it ends. */
export const PAST_QUIET_MS = 5_000;

export interface TryAgainDeps {
  desk: Pick<Desk, 'put'>;
  now: () => Date;
  /** When ixigo's own quiet on this search's page ends, in ms, or null (engine.ts ixigoQuietUntil). */
  ixigoQuiet?: (kind: TravelKind, q: TravelQuery) => number | null;
}

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

/** The search a try runs: its own ask, or a home city's flights. */
const askOf = (t: Pick<TryAgain, 'query' | 'each'>): TravelQuery => t.query ?? (t.each ? { from: t.each.home, to: t.each.to, date: t.each.date } : {});

const waitPast = (now: Date, until: number | null): number => (until === null ? TRY_AGAIN_MS : Math.max(TRY_AGAIN_MS, until - now.getTime() + PAST_QUIET_MS));

/** How long until a try: a minute, or just past ixigo's own quiet when ixigo refused this page (ixigoQuiet). */
export const waitFor = (d: Pick<TryAgainDeps, 'now' | 'ixigoQuiet'>, kind: TravelKind, q: TravelQuery): number => waitPast(d.now(), d.ixigoQuiet?.(kind, q) ?? null);

/** Whether ixigo's own quiet is on for a try's page now: the try waits past it (tryAgain), asking nothing. */
export const inIxigoQuiet = (d: Pick<TryAgainDeps, 'ixigoQuiet'>, kind: TravelKind, t: Pick<TryAgain, 'query' | 'each'>): boolean =>
  (d.ixigoQuiet?.(kind, askOf(t)) ?? null) !== null;

/**
 * Puts try n on the desk, a minute out or just past ixigo's own quiet, and says how long it waits. The same key and n are
 * one item however often they are put; one put past a quiet is keyed by that quiet too, so a try a later quiet puts off
 * again is a new item.
 */
export async function tryAgain(d: TryAgainDeps, tripId: string, kind: TravelKind, t: Omit<TryAgain, 'source'>): Promise<number> {
  const until = d.ixigoQuiet?.(kind, askOf(t)) ?? null;
  const wait = waitPast(d.now(), until);
  await d.desk.put({
    id: `try_again:${tripId}:${t.key}:${t.n}${until === null ? '' : `:${until}`}`, tripId, kind: 'search', ref: kind, dueAt: new Date(d.now().getTime() + wait),
    payload: { source: 'travel_try_again', ...t } satisfies TryAgain,
  });
  return wait;
}

/**
 * Go's line when ixigo didn't load a search, by how long until it tries again (waitFor): "I couldn't load flights from
 * Delhi to Goa just now; I'll try again in a minute.", or, past ixigo's own quiet, "…: ixigo asked us to slow down, so
 * I'll try again in about 10 minutes."
 */
export const notLoadedLine = (what: string, waitMs = TRY_AGAIN_MS): string =>
  waitMs > TRY_AGAIN_MS
    ? `I couldn't load ${what}: ixigo asked us to slow down, so I'll try again in about ${Math.max(2, Math.round(waitMs / 60_000))} minutes.`
    : `I couldn't load ${what} just now; I'll try again in a minute.`;

/** Go's last word when no try landed: plain, with no link. */
export const stillNotLoadedLine = (what: string): string => `I tried again and still couldn't load ${what}. Ask me in a bit and I'll look once more.`;
