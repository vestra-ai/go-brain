/**
 * The places Go has searched on ixigo.com, as ixigo's own codes: airports, railway stations, bus cities and hotel
 * locations. This is a cache, never a gate. The tables below seed it with places ixigo gave Go before; a search that ran
 * ixigo's own form adds what ixigo resolved (learnPlace, kept in travel_places). A flight may also come with the
 * airport code the model knows, in brackets ("London (LHR)"). A place in none of these is unknown_place, and the search
 * answers with ixigo's own page for that kind of search, where the group searches it.
 */
import { TravelError } from '../mcp-travel.js';
import type { TravelKind } from '../travel.js';

/** "  North Goa (GOX) " as "north goa (gox)": lower case, single spaces. */
const norm = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ');

/** A code people or the model wrote in brackets, "Goa (GOX)", or the whole text when it is a code. */
function codeIn(text: string): string | null {
  const m = /\(([a-z]{2,5})\)$/i.exec(text.trim()) ?? /^([a-z]{2,5})$/i.exec(text.trim());
  return m?.[1]?.toUpperCase() ?? null;
}

/** The words for a place, without a code in brackets: "London (LHR)" as "london". */
export const wordsOf = (text: string): string => norm(text.replace(/\([^)]*\)$/, ''));

function resolve<T>(text: string, codes: Record<string, T>, words: Record<string, string>): T | null {
  const code = codeIn(text);
  if (code && code in codes) return codes[code]!;
  const byWord = words[wordsOf(text)];
  return byWord ? codes[byWord]! : null;
}

// ── what ixigo resolved ──────────────────────────────────────────────────────

/** What ixigo's form resolved a place to, for each kind of search. */
export interface LearnedPlace { flights: Airport; trains: Station; buses: BusCity; stays: StayLocation }

/** Places ixigo resolved, by kind and the words people used. The same for every trip: they are ixigo's public codes. */
const learned: { [K in TravelKind]: Map<string, LearnedPlace[K]> } = {
  flights: new Map(), trains: new Map(), buses: new Map(), stays: new Map(),
};
const LEARNED_MAX = 5_000;

/** Keeps a place ixigo resolved, so the next search for the same words goes straight to its results page. */
export function learnPlace<K extends TravelKind>(kind: K, text: string, place: LearnedPlace[K]): void {
  const map = learned[kind];
  map.delete(wordsOf(text));
  map.set(wordsOf(text), place);
  while (map.size > LEARNED_MAX) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** For tests: forgets every place ixigo resolved. */
export function forgetLearnedPlaces(): void {
  for (const map of Object.values(learned)) map.clear();
}

const unknown = (what: string, text: string): TravelError =>
  new TravelError('unknown_place', `Go has no ixigo ${what} code for "${text.slice(0, 60)}" yet.`);

// ── airports ─────────────────────────────────────────────────────────────────

export interface Airport { code: string; city: string }

const AIRPORTS: Record<string, Airport> = Object.fromEntries(
  Object.entries({
    DEL: 'Delhi', GOI: 'Goa', GOX: 'Goa', BOM: 'Mumbai', BLR: 'Bengaluru', PNQ: 'Pune', HYD: 'Hyderabad', MAA: 'Chennai',
    CCU: 'Kolkata', AMD: 'Ahmedabad', JAI: 'Jaipur', COK: 'Kochi',
  }).map(([code, city]) => [code, { code, city }]),
);

// ixigo's search for GOI also answers flights into GOX (and DEL's, Hindon's and Noida's), so "Goa" is one search.
const AIRPORT_WORDS: Record<string, string> = {
  delhi: 'DEL', 'new delhi': 'DEL', goa: 'GOI', 'south goa': 'GOI', dabolim: 'GOI', 'north goa': 'GOX', mopa: 'GOX',
  mumbai: 'BOM', bombay: 'BOM', bangalore: 'BLR', bengaluru: 'BLR', pune: 'PNQ', hyderabad: 'HYD', chennai: 'MAA', madras: 'MAA',
  kolkata: 'CCU', calcutta: 'CCU', ahmedabad: 'AMD', jaipur: 'JAI', kochi: 'COK', cochin: 'COK',
};

/** An airport ixigo resolved before; else the airport code the model gave in brackets, "London (LHR)", as it is. */
export function airportOf(text: string): Airport {
  const a = resolve(text, AIRPORTS, AIRPORT_WORDS) ?? learned.flights.get(wordsOf(text));
  if (a) return a;
  const given = /^(.+?)\s*\(([A-Z]{3})\)$/.exec(text.trim());
  if (given) return { code: given[2]!, city: given[1]!.trim() };
  throw unknown('airport', text);
}

// ── railway stations ─────────────────────────────────────────────────────────

export interface Station { code: string; name: string }

const STATIONS: Record<string, Station> = Object.fromEntries(
  Object.entries({
    NDLS: 'New Delhi', NZM: 'Hazrat Nizamuddin', DLI: 'Old Delhi', CSMT: 'Mumbai CSMT', LTT: 'Lokmanya Tilak Terminus', BCT: 'Mumbai Central',
    MAO: 'Madgaon', KRMI: 'Karmali', THVM: 'Thivim', VSG: 'Vasco da Gama', PUNE: 'Pune', SBC: 'KSR Bengaluru', MAS: 'Chennai Central',
    HWH: 'Howrah', SC: 'Secunderabad', ADI: 'Ahmedabad', JP: 'Jaipur', ERS: 'Ernakulam',
  }).map(([code, name]) => [code, { code, name }]),
);

// A city's main station: ixigo answers trains from the city's other stations too (NDLS gives NZM's, CSMT gives LTT's).
const STATION_WORDS: Record<string, string> = {
  delhi: 'NDLS', 'new delhi': 'NDLS', nizamuddin: 'NZM', 'hazrat nizamuddin': 'NZM', 'old delhi': 'DLI',
  mumbai: 'CSMT', bombay: 'CSMT', 'mumbai cst': 'CSMT', cst: 'CSMT', 'lokmanya tilak': 'LTT', 'mumbai central': 'BCT',
  goa: 'MAO', 'north goa': 'MAO', 'south goa': 'MAO', madgaon: 'MAO', margao: 'MAO', karmali: 'KRMI', thivim: 'THVM', vasco: 'VSG', 'vasco da gama': 'VSG',
  pune: 'PUNE', bangalore: 'SBC', bengaluru: 'SBC', chennai: 'MAS', madras: 'MAS', kolkata: 'HWH', calcutta: 'HWH', howrah: 'HWH',
  hyderabad: 'SC', secunderabad: 'SC', ahmedabad: 'ADI', jaipur: 'JP', kochi: 'ERS', cochin: 'ERS', ernakulam: 'ERS',
};

export function stationOf(text: string): Station {
  const s = resolve(text, STATIONS, STATION_WORDS) ?? learned.trains.get(wordsOf(text));
  if (!s) throw unknown('station', text);
  return s;
}

// ── bus cities (AbhiBus ids, from ixigo's bus search box) ────────────────────

export interface BusCity { name: string; id: number }

const BUS_CITIES: Record<string, BusCity> = { MUMBAI: { name: 'Mumbai', id: 4 }, GOA: { name: 'Goa', id: 102 } };

const BUS_WORDS: Record<string, string> = {
  mumbai: 'MUMBAI', bombay: 'MUMBAI', goa: 'GOA', 'north goa': 'GOA', 'south goa': 'GOA', panaji: 'GOA', panjim: 'GOA',
};

export function busCityOf(text: string): BusCity {
  const c = BUS_CITIES[BUS_WORDS[norm(text)] ?? ''] ?? learned.buses.get(wordsOf(text));
  if (!c) throw unknown('bus city', text);
  return c;
}

// ── hotel locations ──────────────────────────────────────────────────────────

export interface StayLocation { locationId: number; locationName: string; locationType: string; masterLocationId: number; countryId: number }

export type GoaHalf = 'north' | 'south';

/** Where a stay search looks: ixigo's location, its area filters inside Goa, and the half of Goa the stays must be in. */
export interface StayPlace { location: StayLocation; areas: string[]; half: GoaHalf | null }

const GOA: StayLocation = { locationId: 32, locationName: 'Goa', locationType: 'S', masterLocationId: 48569, countryId: 1 };
/** Anjuna is a location of its own on ixigo, which takes in the stays around it (Morjim, Vagator, Assagao). */
const ANJUNA: StayLocation = { locationId: 1026, locationName: 'Anjuna', locationType: 'C', masterLocationId: 50347, countryId: 1 };

/**
 * ixigo's area filter for one place inside a Goa search: its town code (PA_C_*), which is the same on every load. A
 * search takes one: two or more don't add up (North Goa with fifteen gave 3 stays, all in Candolim), and ward codes
 * (PA_L_*) change from load to load. Baga has no code of its own and sits with Calangute; Anjuna is a location of its own.
 */
const GOA_AREA_CODES: Record<string, string> = {
  candolim: 'PA_C_1459', calangute: 'PA_C_1047', baga: 'PA_C_1047', vagator: 'PA_C_78528', morjim: 'PA_C_1067', arpora: 'PA_C_77993',
  mandrem: 'PA_C_1169', arambol: 'PA_C_1096', assagao: 'PA_C_78550', siolim: 'PA_C_1216', mapusa: 'PA_C_1060', panaji: 'PA_C_1091',
  panjim: 'PA_C_1091', colva: 'PA_C_1489', benaulim: 'PA_C_1057', varca: 'PA_C_1017', agonda: 'PA_C_79088',
  // Palolem's code is a ward code, but it stayed the same across the saved loads.
  palolem: 'PA_L_154858',
};

/** The places in each half of Goa, as ixigo names a stay's area or town: what "North Goa" and "South Goa" are checked against. */
const GOA_HALVES: Record<GoaHalf, string[]> = {
  north: [
    'calangute', 'candolim', 'baga', 'anjuna', 'vagator', 'chapora', 'morjim', 'ashwem', 'mandrem', 'arambol', 'querim', 'keri', 'assagao', 'siolim',
    'arpora', 'nagoa', 'saligao', 'sangolda', 'parra', 'nerul', 'sinquerim', 'reis magos', 'pilerne', 'verla', 'porvorim', 'mapusa', 'aldona',
    'thivim', 'tivim', 'pernem', 'mopa', 'bardez', 'panaji', 'panjim', 'miramar', 'caranzalem', 'dona paula', 'bambolim', 'old goa',
    'prabhu wada', 'khobra waddo', 'khobra vaddo', 'monteiro vaddo', 'montero waddo', 'dmello vaddo', 'north goa',
  ],
  south: [
    'colva', 'benaulim', 'sernabatim', 'varca', 'cavelossim', 'mobor', 'betul', 'majorda', 'utorda', 'betalbatim', 'arossim', 'cansaulim', 'velsao',
    'bogmalo', 'vasco', 'dabolim', 'chicalim', 'zuarinagar', 'verna', 'margao', 'madgaon', 'fatorda', 'navelim', 'nuvem', 'loutolim', 'salcete',
    'canacona', 'palolem', 'patnem', 'agonda', 'galgibaga', 'cola', 'quepem', 'carmona', 'fatona', 'south goa',
  ],
};

/** The half of Goa a place is in, from its name; null when the name doesn't say. */
export function goaHalfOf(text: string): GoaHalf | null {
  const t = norm(text);
  for (const half of ['north', 'south'] as const) {
    if (GOA_HALVES[half].some((place) => new RegExp(`(?<![a-z])${place}(?![a-z])`).test(t))) return half;
  }
  return null;
}

/** Goa's areas Go knows. One without its own location or area code searches all of Goa, and each stay says its own area. */
const GOA_AREAS = [
  'goa', 'north goa', 'south goa', 'anjuna', 'vagator', 'calangute', 'candolim', 'baga', 'morjim', 'arambol', 'assagao', 'siolim', 'ashwem',
  'mandrem', 'panaji', 'panjim', 'mapusa', 'porvorim', 'colva', 'benaulim', 'varca', 'cavelossim', 'palolem', 'agonda', 'majorda', 'dona paula',
  'arpora',
];

export function stayPlaceOf(text: string): StayPlace {
  const short = norm(text).replace(/,?\s*goa$/, '');
  const name = GOA_AREAS.includes(short) ? short : GOA_AREAS.includes(norm(text)) ? norm(text) : null;
  if (!name) {
    // Outside the Goa seed: the location ixigo resolved for these words.
    const location = learned.stays.get(wordsOf(text));
    if (!location) throw unknown('hotel location', text);
    return { location, areas: [], half: null };
  }
  if (name === 'goa') return { location: GOA, areas: [], half: null };
  // A half of Goa is all of Goa, its stays then checked against the half's places: ixigo's area codes don't add up.
  if (name === 'north goa') return { location: GOA, areas: [], half: 'north' };
  if (name === 'south goa') return { location: GOA, areas: [], half: 'south' };
  if (name === 'anjuna') return { location: ANJUNA, areas: [], half: 'north' };
  const code = GOA_AREA_CODES[name];
  return { location: GOA, areas: code ? [code] : [], half: goaHalfOf(name) };
}

/** An airport's city from the seed or what ixigo resolved, for a page that shows only codes. */
export function airportCity(code: string): string | null {
  return AIRPORTS[code]?.city ?? [...learned.flights.values()].find((a) => a.code === code)?.city ?? null;
}

/** The place names (not codes) Go knows for a kind of search, longest first: what the travel ask reader looks for. */
export function placeWords(kind: 'flights' | 'trains' | 'buses' | 'stays'): string[] {
  const words = { flights: Object.keys(AIRPORT_WORDS), trains: Object.keys(STATION_WORDS), buses: Object.keys(BUS_WORDS), stays: GOA_AREAS }[kind];
  return [...words].sort((a, b) => b.length - a.length);
}
