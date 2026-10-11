/**
 * What a page read in the trip's browser is made of: the data calls Bash's browser fetch keeps, the steps it works, and
 * an option as a recipe reads it. The recipes themselves are files (apps/brain/recipes), run by the recipe engine
 * (book/engine.ts). Design: docs/design/ixigo-recipes.md.
 */
import type { Step } from '../book/format.js';
import type { TravelOption } from '../travel.js';

/** One data call the browser fetch keeps. */
export interface CaptureSpec {
  /** A part of the response URL; ending in "$", it must end the URL's path (the query aside). */
  match: string;
  /** False when the answer can be read without it, so a fetch that timed out with it missing still answers. */
  required: boolean;
  max_bytes?: number;
  /**
   * "last": an event stream whose every event is the whole answer so far (ixigo's flights) comes as its last complete event
   * alone, max_bytes being that event's (Bash's most: 4 MB). A Bash that predates it is sent none (runners.ts).
   */
  sse?: 'last';
  /** Bash waits for this many matching responses (pages) before it answers, and keeps at most max_count. */
  min_count?: number;
  max_count?: number;
  /** Never waited for, grace or none: kept when it came by the time the rest are in (a site's list of what it offers). */
  besides?: boolean;
}

/** One response the page received, as the browser fetch answers it. */
export interface Capture {
  match: string;
  url: string;
  status: number;
  content_type: string;
  body: string;
  truncated: boolean;
  at_ms: number;
}

/** Page controls the browser fetch works through the accessibility tree, as the recipe book's format writes them. */
export type { Step } from '../book/format.js';

/**
 * What the browser fetch keeps and does, how long it may take when that is less than Bash's most, and how long Bash
 * waits after the data is in before its last picture (settleMs; none when the page is not drawn by then, as buses).
 * graceMs (Bash's most is 3000): Bash answers once the required captures are in, waiting at most this long more for
 * the others, for a page whose calls depend on what it finds (ixigo's login calls). A plan with an optional capture and
 * none of its own takes OPTIONAL_GRACE_MS (runners.ts bashCaptures); one with nothing optional, none: Bash waits for every
 * capture.
 */
export interface FetchPlan { capture: CaptureSpec[]; steps?: Step[]; timeoutMs?: number; settleMs?: number; graceMs?: number }

/** An option as a recipe reads it: no offer id (booking stays on ixigo), and the option's own page on ixigo.com. */
export type RecipeOption = Omit<TravelOption, 'offerId'> & { sourceUrl: string };

/** How long a search's answer is reused, unless its recipe says otherwise. */
export const RECIPE_TTL_MS = 10 * 60_000;
export const IXIGO = 'https://www.ixigo.com';

/** Whether a response URL answers a capture's match, as Bash's browser fetch decides it. */
export function matches(match: string, url: string): boolean {
  if (!match.endsWith('$')) return url.includes(match);
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  return path.endsWith(match.slice(0, -1));
}

/**
 * The bodies of the successful responses that answer a match, in the order they came. A body cut at its cap is left out,
 * but for an event stream (events): its complete events are whole answers, and the reader drops the one cut partway.
 */
export function bodiesFor(captures: Capture[], match: string, events = false): string[] {
  return captures.filter((c) => c.status >= 200 && c.status < 300 && (events || !c.truncated) && matches(match, c.url)).map((c) => c.body);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
