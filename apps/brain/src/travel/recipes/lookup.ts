/**
 * ixigo's own search box, for a place Go has not searched before: the person's words typed into the box on ixigo's
 * search page, the suggestions ixigo answered (the page's own call, kept by the browser fetch), and the pick a person
 * would make. Go keeps no list of places: ixigo resolves them. Design: docs/design/ixigo-recipes.md, "Places".
 */
import { z } from 'zod';
import type { TravelKind } from '../travel.js';
import { norm, type LearnedPlace } from './places.js';
import { IXIGO, type CaptureSpec, type Step } from './recipe.js';

/** One suggestion under ixigo's box: what it shows (its name and second line) and the place it stands for. */
export interface Suggestion<K extends TravelKind> {
  name: string;
  /** City, state and country, as ixigo shows them under the name; empty when ixigo shows none. */
  line: string;
  /** ixigo's entry for a whole city: "All Airports", "All stations", "All boarding points". */
  all: boolean;
  /** The country, when ixigo says it. */
  country: string | null;
  place: LearnedPlace[K];
}

const Id = z.union([z.int().positive(), z.string().regex(/^\d+$/).transform(Number)]);
const Text = z.string().trim().min(1);

const Airports = z.object({
  data: z.array(
    z.object({
      airportCode: z.string().regex(/^[A-Z]{3}$/),
      airportName: z.string().nullish(),
      cityName: Text,
      stateName: z.string().nullish(),
      countryName: z.string().nullish(),
      allAirport: z.boolean().nullish(),
    }).or(z.unknown().transform(() => null)),
  ),
});
const Stations = z.array(z.object({ e: Text, c: z.string().nullish() }).or(z.unknown().transform(() => null)));
const BusCities = z.array(
  z.object({
    id: Id,
    display_text: Text,
    display_subtext: z.string().nullish(),
    city: z.string().nullish(),
    state_name: z.string().nullish(),
    alias_type: z.string().nullish(),
  }).or(z.unknown().transform(() => null)),
);
const HotelPlaces = z.object({
  data: z.object({
    suggestions: z.array(
      z.object({
        name: Text,
        region: z.string().nullish(),
        locationType: z.string().regex(/^[A-Z]{1,3}$/),
        locationId: Id,
        masterLocationId: Id,
        countryId: Id,
        country: z.string().nullish(),
      }).or(z.unknown().transform(() => null)),
    ),
  }),
});

const joined = (...parts: Array<string | null | undefined>): string => parts.filter((p): p is string => !!p && p.trim().length > 0).join(', ');
const present = <T>(xs: Array<T | null>): T[] => xs.filter((x): x is T => x !== null);

function parsed<T>(schema: z.ZodType<T>, body: string): T | null {
  try {
    const r = schema.safeParse(JSON.parse(body));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** The suggestions in the body of ixigo's suggestion call, each read on its own: one that doesn't read is skipped. */
export const readSuggestions: { [K in TravelKind]: (body: string) => Array<Suggestion<K>> } = {
  flights: (body) =>
    present(parsed(Airports, body)?.data ?? []).map((a) => ({
      name: `${a.airportCode} ${a.airportName ?? a.cityName}`,
      line: joined(a.cityName, a.stateName, a.countryName),
      all: a.allAirport === true,
      country: a.countryName ?? null,
      place: { code: a.airportCode, city: a.cityName },
    })),
  trains: (body) =>
    present(parsed(Stations, body) ?? []).flatMap((s) => {
      // "Delhi - All stations(NDLS)", "Udaipur City (UDZ)": the station code is in the brackets.
      const m = /^(.*?)\s*\(([A-Z0-9]{1,6})\)\s*$/.exec(s.e);
      if (!m) return [];
      const all = /\ball stations\b/i.test(m[1]!);
      const name = all ? m[1]!.replace(/\s*-?\s*all stations\s*$/i, '').trim() : m[1]!.trim();
      return [{ name: s.e, line: s.c ?? '', all, country: 'India', place: { code: m[2]!, name: name || s.e } }];
    }),
  buses: (body) =>
    present(parsed(BusCities, body) ?? []).map((b) => ({
      name: b.display_text,
      line: b.display_subtext ?? b.state_name ?? '',
      // A city's own entry is ixigo's "All boarding points"; the rest are boarding points inside one.
      all: b.alias_type?.toLowerCase() === 'city',
      country: 'India',
      place: { name: b.city?.trim() || b.display_text, id: b.id },
    })),
  stays: (body) =>
    present(parsed(HotelPlaces, body)?.data.suggestions ?? [])
      // A property or a landmark is not a place to search around.
      .filter((h) => !['H', 'POI'].includes(h.locationType))
      .map((h) => ({
        name: h.name,
        line: h.region ?? '',
        all: false,
        country: h.country ?? null,
        place: { locationId: h.locationId, locationName: h.name, locationType: h.locationType, masterLocationId: h.masterLocationId, countryId: h.countryId },
      })),
};

/** What ixigo's suggestions give for the person's words: the place, or the entries the model chooses from, or nothing. */
export type Picked<K extends TravelKind> = { place: LearnedPlace[K] } | { choose: Array<Suggestion<K>> } | null;

const tokens = (text: string): string[] => norm(text).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
const HOME = 'India';

/**
 * The pick a person makes from ixigo's list (the map's rule):
 * 1. the "All airports", "All stations" or "All boarding points" entry for the place;
 * 2. else the one entry that is the place by name (a stay's city or state, an airport's city, a bus city), or the only
 *    entry that fits the words at all;
 * 3. else the model chooses from the entries that fit (Udaipur City (UDZ) or Udaipur (UDPU)).
 * An entry fits when every word of the ask is in its name or second line. Entries in India come first unless none fits.
 */
export function pickSuggestion<K extends TravelKind>(kind: K, words: string, list: Array<Suggestion<K>>): Picked<K> {
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
  const byName = pool.filter((s) => kind !== 'trains' && norm(placeName(kind, s)) === norm(words));
  if (byName.length === 1) return { place: byName[0]!.place };
  if (pool.length === 1) return { place: pool[0]!.place };
  return { choose: (pool.length > 0 ? pool : list).slice(0, 6) };
}

/** The place's own name, as the pick compares it with the words: a stay's location, an airport's city, a bus city. */
function placeName<K extends TravelKind>(kind: K, s: Suggestion<K>): string {
  const p = s.place as LearnedPlace[TravelKind];
  if (kind === 'stays') return ['C', 'S'].includes((p as LearnedPlace['stays']).locationType) ? (p as LearnedPlace['stays']).locationName : '';
  if (kind === 'flights') return (p as LearnedPlace['flights']).city;
  if (kind === 'buses') return (p as LearnedPlace['buses']).name;
  return '';
}

/** Where each kind's box is on ixigo, the steps that type into it, and the suggestion call the fetch keeps. */
export interface Box {
  page: string;
  /** The steps that type the words into the box for one end of the search ('from', 'to', or 'area' for a stay). */
  type(end: 'from' | 'to' | 'area', words: string): Step[];
  /** The page's suggestion call, as the fetch matches it. */
  call: string;
  /** The words a suggestion call was made for, from its URL. */
  wordsOf(url: string): string | null;
}

const param = (name: string) => (url: string): string | null => {
  try {
    return new URL(url).searchParams.get(name);
  } catch {
    return null;
  }
};

export const BOXES: Record<TravelKind, Box> = {
  // From and To show as text until clicked; the box that opens has no name and has the focus.
  flights: {
    page: `${IXIGO}/`,
    type: (end, words) => [
      { op: 'click', role: 'StaticText', name: end === 'to' ? 'To' : 'From' },
      { op: 'type', text: words },
      { op: 'wait_for', match: 'searchFor=airportSuggestions' },
    ],
    call: 'searchFor=airportSuggestions',
    wordsOf: param('value'),
  },
  stays: {
    page: `${IXIGO}/hotels`,
    type: (_end, words) => [
      { op: 'click', name: 'Close modal', optional: true },
      { op: 'type', role: 'textbox', name: 'Enter city, area or property name', text: words },
      { op: 'wait_for', match: '/hotels-autocompleter/api/v2/results' },
    ],
    call: '/hotels-autocompleter/api/v2/results',
    wordsOf: param('query'),
  },
  trains: {
    page: `${IXIGO}/trains`,
    type: (end, words) => [
      { op: 'type', role: 'searchbox', name: end === 'to' ? 'Enter Destination' : 'Enter Origin', text: words },
      { op: 'wait_for', match: 'searchFor=trainstationsLatLon' },
    ],
    call: 'searchFor=trainstationsLatLon',
    wordsOf: param('value'),
  },
  buses: {
    page: `${IXIGO}/buses`,
    type: (end, words) => [
      { op: 'type', role: 'textbox', name: end === 'to' ? 'Going To' : 'Leaving From', text: words },
      { op: 'wait_for', match: '/wap/abus-autocompleter/api/v1/results' },
    ],
    call: '/wap/abus-autocompleter/api/v1/results',
    wordsOf: param('s'),
  },
};

/** The fetch that types each end's words into ixigo's box and keeps the suggestion calls. */
export function boxPlan(kind: TravelKind, ends: Array<{ end: 'from' | 'to' | 'area'; words: string }>): { url: string; steps: Step[]; capture: CaptureSpec[] } {
  const box = BOXES[kind];
  const steps = ends.flatMap((e, i) => box.type(e.end, e.words).filter((s) => i === 0 || !(s.op === 'click' && s.optional)));
  return { url: box.page, steps, capture: [{ match: box.call, required: true, min_count: ends.length, max_count: 6, max_bytes: 200_000 }] };
}
