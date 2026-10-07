/**
 * Places, the way a person finds one on ixigo: the words typed into ixigo's own search box, the suggestions ixigo
 * answers (the page's own call, kept by the browser fetch), and the pick a person would make. A lookup recipe says where
 * the box is and how its suggestions read; this file reads them and picks. Go keeps no list of places.
 */
import { norm } from '../recipes/places.js';
import type { Capture, CaptureSpec, Step } from '../recipes/recipe.js';
import { readBodyAs } from './bodies.js';
import { evaluate } from './expr.js';
import type { RecipeFile } from './format.js';
import { fill } from './template.js';

/** One suggestion under ixigo's box: what it shows, and the place it stands for. */
export interface Suggestion {
  name: string;
  /** City, state and country, as ixigo shows them under the name; empty when it shows none. */
  line: string;
  /** ixigo's entry for a whole city: "All Airports", "All stations", "All boarding points". */
  all: boolean;
  country: string | null;
  /** What Go keeps for the place. */
  place: Record<string, unknown>;
  /** The place's own name, which the pick may compare with the words; empty when the kind never picks by name. */
  placeName: string;
}

export type End = 'from' | 'to' | 'place';

const suggestionsOf = (r: RecipeFile) => {
  if (r.answer.as !== 'places') throw new Error(`${r.id} is not a lookup`);
  return r.answer.suggestions;
};

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The fetch that types each end's words into ixigo's box and keeps its suggestion calls. */
export async function boxPlan(r: RecipeFile, ends: Array<{ end: End; words: string }>): Promise<{ path: string; steps: Step[]; capture: CaptureSpec[] }> {
  if (!r.box || !r.capture) throw new Error(`${r.id} has no box`);
  const steps: Step[] = [];
  for (const [i, e] of ends.entries()) {
    const typing = r.box.type[e.end] ?? r.box.type.place ?? r.box.type.from ?? [];
    for (const s of typing) {
      // A popup is closed once, before the first box.
      if (i > 0 && s.op === 'click' && s.optional) continue;
      steps.push('text' in s && s.op === 'type' ? { ...s, text: await fill(s.text, { words: e.words }, { url: false }) } : s);
    }
  }
  const capture: CaptureSpec[] = r.capture.map((c) => ({
    match: c.match,
    required: c.required,
    min_count: Math.max(c.min_count ?? 1, ends.length),
    ...(c.max_count ? { max_count: c.max_count } : {}),
    ...(c.max_bytes ? { max_bytes: c.max_bytes } : {}),
  }));
  return { path: r.box.page, steps, capture };
}

/** The suggestions ixigo answered for the words, from the calls the fetch kept: the call made for these words if there is
 *  one, else the last one. */
export async function readSuggestions(r: RecipeFile, captures: Capture[], words: string): Promise<Suggestion[]> {
  const s = suggestionsOf(r);
  const calls = captures.filter((c) => c.status >= 200 && c.status < 300 && !c.truncated && r.capture!.some((spec) => spec.match === c.match));
  const forWords = calls.filter((c) => {
    try {
      return norm(new URL(c.url).searchParams.get(s.words_param) ?? '') === norm(words);
    } catch {
      return false;
    }
  });
  const call = forWords.at(-1) ?? (calls.length === 1 ? calls[0] : undefined);
  if (!call) return [];
  let body: unknown;
  try {
    body = readBodyAs(call.body, 'json', 'its suggestions');
  } catch {
    return [];
  }
  const listed = await evaluate(s.list, body);
  const out: Suggestion[] = [];
  for (const entry of Array.isArray(listed) ? listed : listed === undefined ? [] : [listed]) {
    try {
      if (s.skip && (await evaluate(s.skip, entry)) === true) continue;
      const place = await evaluate(s.place, entry);
      if (!place || typeof place !== 'object') continue;
      out.push({
        name: text(await evaluate(s.name, entry)),
        line: s.line ? text(await evaluate(s.line, entry)) : '',
        all: s.all ? (await evaluate(s.all, entry)) === true : false,
        country: s.country ? text(await evaluate(s.country, entry)) || null : null,
        place: place as Record<string, unknown>,
        placeName: s.place_name ? text(await evaluate(s.place_name, place)) : '',
      });
    } catch {
      // an entry that doesn't read is skipped
    }
  }
  return out.filter((x) => x.name.length > 0);
}

/** What ixigo's suggestions give for the words: the place, or the entries the model chooses from, or nothing. */
export type Picked = { place: Record<string, unknown> } | { choose: Suggestion[] } | null;

const tokens = (t: string): string[] => norm(t).split(/[^\p{L}\p{N}]+/u).filter((x) => x.length > 0);
const HOME = 'India';

/**
 * The pick a person makes from ixigo's list:
 * 1. the "All airports", "All stations" or "All boarding points" entry;
 * 2. else the one entry that is the place by its own name (a stay's city or state, an airport's city, a bus city), or the
 *    only entry that fits the words;
 * 3. else the model chooses from the entries that fit (Udaipur City (UDZ) or Udaipur (UDPU)).
 * An entry fits when every word of the ask is in its name or second line. Entries in India come first unless none fits.
 */
export function pickSuggestion(words: string, list: Suggestion[]): Picked {
  if (list.length === 0) return null;
  const asked = tokens(words);
  const fitting = list.filter((s) => {
    const seen = new Set(tokens(`${s.name} ${s.line}`));
    return asked.every((t) => seen.has(t));
  });
  const home = fitting.filter((s) => s.country === null || s.country === HOME);
  const pool = home.length > 0 ? home : fitting;
  const all = pool.find((s) => s.all);
  if (all) return { place: all.place };
  const byName = pool.filter((s) => s.placeName.length > 0 && norm(s.placeName) === norm(words));
  if (byName.length === 1) return { place: byName[0]!.place };
  if (pool.length === 1) return { place: pool[0]!.place };
  return { choose: (pool.length > 0 ? pool : list).slice(0, 6) };
}
