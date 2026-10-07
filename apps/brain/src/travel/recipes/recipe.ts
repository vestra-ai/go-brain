/**
 * ixigo.com recipes: for each kind of search, the page to open, which of the page's own data calls to read, and how
 * that data becomes Go's options. A runner opens the page in the trip's browser and brings back what the recipe names;
 * a recipe never calls ixigo itself. Each recipe also carries a page script for the fallback runner, which reads the
 * results as the page shows them instead of the data calls. Design: docs/design/ixigo-recipes.md.
 */
import type { z } from 'zod';
import { TravelError } from '../mcp-travel.js';
import type { Step } from '../book/format.js';
import type { TravelKind, TravelOption, TravelQuery } from '../travel.js';

/** One data call a runner asks Bash's browser fetch to keep. */
export interface CaptureSpec {
  /** A part of the response URL; ending in "$", it must end the URL's path (the query aside). */
  match: string;
  /** False when the options can be read without it, so a fetch that timed out with it missing still answers. */
  required: boolean;
  max_bytes?: number;
  /** Bash waits for this many matching responses (pages) before it answers, and keeps at most max_count. */
  min_count?: number;
  max_count?: number;
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
 */
export interface FetchPlan { capture: CaptureSpec[]; steps?: Step[]; timeoutMs?: number; settleMs?: number }

/** An option as a recipe reads it: no offer id (booking stays on ixigo), and the option's own page on ixigo.com. */
export type RecipeOption = Omit<TravelOption, 'offerId'> & { sourceUrl: string };

export type RecipeId = 'ixigo.flights' | 'ixigo.stays' | 'ixigo.trains' | 'ixigo.buses';

/** Who travels, for a search people gave no number for: the head count, and the home cities of the members who gave one. */
export interface TripCount {
  people: number;
  fromCities?: string[];
}

export interface Recipe<S> {
  id: RecipeId;
  kind: TravelKind;
  /** What the URL needs, resolved to ixigo's codes. The same query always gives the same slots, so they key the cache. */
  slotsFrom(q: TravelQuery, trip: TripCount): S;
  url(s: S): string;
  capture: CaptureSpec[];
  steps?: Step[];
  /** What the browser fetch keeps and does for these slots, when it differs from capture and steps (more pages), and how
   *  long it may take when that is less than Bash's most. */
  fetchFor?(s: S): FetchPlan;
  /** False when Bash's browser fetch can't read the page: its list loads only in a tab Chrome draws, so the agent job reads it. */
  fetchable: boolean;
  /** Text the page shows once its results are in: the agent job waits for it before it reads the page. */
  readyText: string;
  /** The options in the captured data calls. Throws TravelError('refused') when a required call is missing or unreadable. */
  extract(captures: Capture[], s: S): RecipeOption[];
  /** The fallback runner's page script: an expression whose value is the rows the page shows, at most 15, under 8 KB. */
  agentExtractor: string;
  /** The reader inside that script, for page text that comes back another way (a snapshot, when the script is held). */
  readPage: (text: string, links: string[]) => unknown[];
  /** The options in what agentExtractor returned. Throws TravelError('refused') when the rows don't read. */
  fromAgent(rows: unknown, s: S): RecipeOption[];
  /** How long a result is reused. */
  ttlMs: number;
}

export const RECIPE_TTL_MS = 10 * 60_000;
export const IXIGO = 'https://www.ixigo.com';
/** The page script's limits: computer_eval answers at most 8 KB. */
export const AGENT_MAX_ROWS = 15;
const AGENT_MAX_CHARS = 7_500;

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

/** The bodies of the successful responses that answer a match, in the order they came. */
export function bodiesFor(captures: Capture[], match: string): string[] {
  return captures.filter((c) => c.status >= 200 && c.status < 300 && !c.truncated && matches(match, c.url)).map((c) => c.body);
}

/** Reads a body with a schema; a body ixigo answered in another shape is refused, never half read. */
export function readBody<T>(schema: z.ZodType<T>, body: string, what: string): T {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new TravelError('refused', `ixigo's ${what} was not JSON.`);
  }
  const r = schema.safeParse(json);
  if (!r.success) throw new TravelError('refused', `ixigo answered ${what} in a shape Go does not read: ${r.error.issues[0]?.message ?? 'unknown'}`.slice(0, 300));
  return r.data;
}

/** The rows the page script returned, checked; anything else is refused, so the fallback fails closed. */
export function readRows<T>(schema: z.ZodType<T>, rows: unknown, what: string): T {
  const r = schema.safeParse(rows);
  if (!r.success) throw new TravelError('refused', `The ${what} read from ixigo's page did not check out: ${r.error.issues[0]?.message ?? 'unknown'}`.slice(0, 300));
  return r.data;
}

/**
 * The fallback's page script: scrolls a few screens so the page draws more results, then runs the recipe's reader on the
 * page text and links. The reader is passed as a function and sent as its source, so it must use nothing outside itself.
 */
export function pageScript(reader: (text: string, links: string[]) => unknown[], scrolls: number): string {
  return `(async () => {
  for (let i = 0; i < ${scrolls}; i++) { window.scrollBy(0, window.innerHeight * 2); await new Promise((r) => setTimeout(r, 400)); }
  window.scrollTo(0, 0);
  const links = Array.from(document.querySelectorAll('a[href]'), (a) => a.href);
  const rows = (${reader.toString()})(document.body.innerText, links).slice(0, ${AGENT_MAX_ROWS});
  while (rows.length > 0 && JSON.stringify(rows).length > ${AGENT_MAX_CHARS}) rows.pop();
  return rows;
})()`;
}

/**
 * The page's text lines from a computer_snapshot (Bash's accessibility tree, one node a line: `- role "name" [@e3]`):
 * the text nodes' names in order, which read as the page's own text does. A snapshot with no text nodes gives every name.
 */
export function snapshotText(snapshot: string): string {
  const named = snapshot.split('\n').flatMap((line) => {
    const m = /^\s*- (\S+) "((?:[^"\\]|\\.)*)"/.exec(line);
    return m ? [{ role: m[1]!, name: m[2]!.replace(/\\"/g, '"') }] : [];
  });
  const text = named.filter((n) => n.role === 'StaticText');
  return (text.length > 0 ? text : named).map((n) => n.name).join('\n');
}

/** "2026-11-06" as ixigo's "06112026". */
export const ddmmyyyy = (date: string): string => `${date.slice(8, 10)}${date.slice(5, 7)}${date.slice(0, 4)}`;

/** A wall-clock time in India as an ISO time with its offset: 2026-11-06T18:30:00+05:30. */
export const istAt = (date: string, hhmm: string): string => `${date}T${hhmm.slice(0, 5)}:00+05:30`;

/** An epoch time in India, as an ISO time with its offset. */
export const istOf = (epochMs: number): string => `${new Date(epochMs + 330 * 60_000).toISOString().slice(0, 19)}+05:30`;

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const nightsBetween = (checkIn: string, checkOut: string): number =>
  Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000);

/** Rupees as ixigo gives them, to paise. */
export const paise = (rupees: number): number => Math.round(rupees * 100);

/** Up to four highlights, the empty ones dropped. */
export const highlights = (...items: Array<string | null | undefined | false>): string[] =>
  items.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 4);

/** "2 h 35 m". */
export function hoursMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m === 0 ? `${h} h` : `${h} h ${m} m`;
}

export const clamp = (n: number, low: number, high: number): number => Math.min(high, Math.max(low, Math.round(n)));
