/**
 * The expressions inside recipe files: JSONata (jsonata.org), sandboxed, with no IO, plus a fixed set of generic
 * functions that any recipe may call. Nothing here knows a recipe, a place or a page: a function goes here only when
 * more than one kind of answer needs it.
 */
import jsonata from 'jsonata';
import { TravelError } from '../mcp-travel.js';

/** "2026-11-06" and "18:20" as 2026-11-06T18:20:00+05:30: a wall-clock time in India. */
export const istAt = (date: string, hhmm: string): string => `${date}T${hhmm.slice(0, 5)}:00+05:30`;

/** An epoch time (ms) in India, as an ISO time with its offset. */
export const istOf = (epochMs: number): string => `${new Date(epochMs + 330 * 60_000).toISOString().slice(0, 19)}+05:30`;

/** "2 h 35 m". */
export function hoursMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m === 0 ? `${h} h` : `${h} h ${m} m`;
}

/** The date forms a template may name after "|": {date|DDMMYYYY}. */
export const DATE_FORMS = ['DDMMYYYY', 'DD-MM-YYYY', 'D Month YYYY', 'D Mon'] as const;
export type DateForm = (typeof DATE_FORMS)[number];

/** "2026-11-06" as "06112026", "06-11-2026", "6 November 2026" or "6 Nov". */
export function dateAs(date: string, form: DateForm): string {
  const [y, m, d] = date.split('-');
  const month = new Date(`${date}T00:00:00Z`).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
  switch (form) {
    case 'DDMMYYYY':
      return `${d}${m}${y}`;
    case 'DD-MM-YYYY':
      return `${d}-${m}-${y}`;
    case 'D Month YYYY':
      return `${Number(d)} ${month} ${y}`;
    case 'D Mon':
      return `${Number(d)} ${month.slice(0, 3)}`;
  }
}

const escaped = (text: string): string => text.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');

const nothing = (x: unknown): boolean => x === undefined || x === null || x === false || (typeof x === 'string' && x.trim().length === 0);

const FUNCTIONS: Record<string, { fn: (...args: never[]) => unknown }> = {
  /** A number, from a number or a numeric string ("1530"); nothing otherwise. */
  num: { fn: (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : undefined) },
  /** Rupees as paise. */
  paise: { fn: (rupees: number) => Math.round(rupees * 100) },
  /** A date and a clock in India as an ISO time. */
  istAt: { fn: (date: string, hhmm: string) => istAt(date, hhmm) },
  /** An ISO time plus some minutes, in India. */
  istPlus: { fn: (iso: string, minutes: number) => istOf(Date.parse(iso) + minutes * 60_000) },
  /** An epoch in seconds as India's clock written as if it were UTC, the way some ixigo calls give it. */
  istFromWallSeconds: { fn: (seconds: number) => `${new Date(seconds * 1000).toISOString().slice(0, 19)}+05:30` },
  /** "16:25:00" or "16:25" as 985; "2h 35m" as 155; nothing when it doesn't read. */
  minutes: {
    fn: (text: string | undefined) => {
      if (typeof text !== 'string') return undefined;
      const clock = /^(\d+):(\d{2})(?::\d{2})?$/.exec(text.trim());
      if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
      const hm = /^(\d+)\s*h(?:\s*(\d+)\s*m)?$/.exec(text.trim());
      return hm ? Number(hm[1]) * 60 + Number(hm[2] ?? 0) : undefined;
    },
  },
  /** Minutes between two ISO times. */
  minutesBetween: { fn: (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 60_000) },
  hoursMinutes: { fn: (min: number) => hoursMinutes(min) },
  /** Nights between two dates. */
  nights: { fn: (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) },
  /** Up to four highlights, the empty ones dropped. */
  highlights: { fn: (...items: unknown[]) => items.flat().filter((x): x is string => typeof x === 'string' && !nothing(x)).slice(0, 4) },
  /** "MANDOVI EXPRESS" as "Mandovi Express"; codes and short words stay as written. */
  titleWords: {
    fn: (name: string) => name.trim().split(/\s+/).map((w) => (/^[A-Z]{4,}$/.test(w) ? `${w[0]}${w.slice(1).toLowerCase()}` : w)).join(' '),
  },
  /** The first match of a regular expression's groups in a text, as an array; nothing when it doesn't match. */
  groups: {
    fn: (text: string | undefined, pattern: string, flags?: string) => {
      if (typeof text !== 'string') return undefined;
      const m = new RegExp(pattern, flags ?? '').exec(text);
      return m ? m.slice(1).map((g) => g ?? '') : undefined;
    },
  },
  /** Whether a text names any of the words as words of its own: "Prabhu wada, Candolim" names "candolim". */
  mentions: {
    fn: (text: string | undefined, words: string[] | string | undefined) => {
      if (typeof text !== 'string' || !words) return false;
      const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
      return (Array.isArray(words) ? words : [words]).some((w) => new RegExp(`(?<![a-z])${escaped(w.toLowerCase())}(?![a-z])`).test(t));
    },
  },
  /** An address's query from an object, in order, as a browser writes it (a space is %20); empty values left out. */
  query: {
    fn: (o: Record<string, unknown> | undefined) =>
      new URLSearchParams(Object.entries(o ?? {}).flatMap(([k, v]): Array<[string, string]> => (v === undefined || v === null ? [] : [[k, String(v)]])))
        .toString()
        .replace(/\+/g, '%20'),
  },
  /** Rupees as people write them in India: "₹1,44,653". */
  rupees: { fn: (n: number) => `₹${n.toLocaleString('en-IN')}` },
  /** "2026-11-06" as "06112026", "06-11-2026", "6 November 2026" or "6 Nov". */
  dateAs: { fn: (date: string, form: string) => dateAs(date, form as DateForm) },
};


/**
 * Every evaluation is timeboxed by JSONata's own guardrails, counted per evaluation: a recursive expression, a runaway
 * loop or a huge sequence fails that run instead of stalling a turn. (A single regular expression can't be interrupted:
 * recipe files are reviewed for that.)
 */
export const LIMITS = { timeout: 50, stack: 250, sequence: 20_000 };
const GUARDRAILS = new Set(['D1011', 'D1012', 'D2015']);

const compiled = new Map<string, jsonata.Expression>();

/** A recipe's expression, compiled once with the generic functions. Throws on a syntax error (the loader's check). */
export function expr(source: string): jsonata.Expression {
  const hit = compiled.get(source);
  if (hit) return hit;
  const e = jsonata(source, LIMITS);
  for (const [name, f] of Object.entries(FUNCTIONS)) e.registerFunction(name, f.fn as (...args: unknown[]) => unknown);
  compiled.set(source, e);
  return e;
}

/**
 * Evaluates an expression over an input with the bindings ($inputs, $page and the recipe's own). An evaluation past the
 * limits is a TravelError, so the run fails as a whole and the next speed is tried; any other error is the expression's.
 */
export async function evaluate(source: string, input: unknown, bindings: Record<string, unknown> = {}): Promise<unknown> {
  try {
    return await expr(source).evaluate(input, bindings);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && GUARDRAILS.has(code)) throw new TravelError('unreachable', `A recipe took too long to read ixigo's answer (${code}).`);
    throw err;
  }
}
