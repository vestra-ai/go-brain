/**
 * The places Go can search on ixigo.com, as ixigo's own codes: airports, railway stations, bus cities and hotel
 * locations. A place not in these tables is refused with the list of places that work, never guessed; live lookups
 * through ixigo's own search boxes come later.
 */
import { TravelError } from '../mcp-travel.js';

/** "  North Goa (GOX) " as "north goa (gox)": lower case, single spaces. */
const norm = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ');

/** A code people or the model wrote in brackets, "Goa (GOX)", or the whole text when it is a code. */
function codeIn(text: string): string | null {
  const m = /\(([a-z]{2,5})\)$/i.exec(text.trim()) ?? /^([a-z]{2,5})$/i.exec(text.trim());
  return m?.[1]?.toUpperCase() ?? null;
}

function resolve<T>(text: string, codes: Record<string, T>, words: Record<string, string>): T | null {
  const code = codeIn(text);
  if (code && code in codes) return codes[code]!;
  const word = norm(text.replace(/\([^)]*\)$/, ''));
  const byWord = words[word];
  return byWord ? codes[byWord]! : null;
}

const listOf = (names: string[]): string => [...new Set(names)].join(', ');

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

export function airportOf(text: string): Airport {
  const a = resolve(text, AIRPORTS, AIRPORT_WORDS);
  if (!a) throw new TravelError('unknown_place', `Go can search ixigo flights for these places: ${listOf(Object.values(AIRPORTS).map((x) => x.city))}. "${text.slice(0, 60)}" is not one yet.`);
  return a;
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
  const s = resolve(text, STATIONS, STATION_WORDS);
  if (!s) throw new TravelError('unknown_place', `Go can search ixigo trains for these places: Delhi, Mumbai, Goa, Pune, Bengaluru, Chennai, Kolkata, Hyderabad, Ahmedabad, Jaipur, Kochi. "${text.slice(0, 60)}" is not one yet.`);
  return s;
}

// ── bus cities (AbhiBus ids, from ixigo's bus search box) ────────────────────

export interface BusCity { name: string; id: number }

const BUS_CITIES: Record<string, BusCity> = { MUMBAI: { name: 'Mumbai', id: 4 }, GOA: { name: 'Goa', id: 102 } };

const BUS_WORDS: Record<string, string> = {
  mumbai: 'MUMBAI', bombay: 'MUMBAI', goa: 'GOA', 'north goa': 'GOA', 'south goa': 'GOA', panaji: 'GOA', panjim: 'GOA',
};

export function busCityOf(text: string): BusCity {
  const c = BUS_CITIES[BUS_WORDS[norm(text)] ?? ''];
  if (!c) throw new TravelError('unknown_place', `Go can search ixigo buses between ${listOf(Object.values(BUS_CITIES).map((x) => x.name))}. "${text.slice(0, 60)}" is not one yet.`);
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
 * ixigo's area filters inside a Goa search: all twenty from its search metadata (6 to 9 Nov), by the place each sits in.
 * The search keeps to stays in those areas. Baga has no code of its own and sits with Calangute; Anjuna's stays sit in
 * its wards (Monteiro and D'Mello Vaddo) inside a Goa search, and Anjuna asked for alone is a location of its own.
 */
const GOA_AREA_CODES: Record<string, string[]> = {
  candolim: ['PA_C_1459', 'PA_L_159632'], // Prabhu wada is in Candolim
  calangute: ['PA_C_1047', 'PA_L_159635'], // Khobra Waddo is in Calangute
  baga: ['PA_C_1047', 'PA_L_159635'],
  vagator: ['PA_C_78528'], morjim: ['PA_C_1067'], arpora: ['PA_C_77993'], mandrem: ['PA_C_1169'], arambol: ['PA_C_1096'],
  assagao: ['PA_C_78550'], siolim: ['PA_C_1216'], panaji: ['PA_C_1091'], panjim: ['PA_C_1091'],
  anjuna: ['PA_L_165727', 'PA_L_156530'], // Monteiro Vaddo and D'Mello Vaddo
  'north goa': ['PA_C_78647'], // ixigo's own "North Goa" area
  palolem: ['PA_L_154858'], agonda: ['PA_C_79088'], colva: ['PA_L_154689'], // Fatona is in Colva
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
  if (!name) throw new TravelError('unknown_place', `Go can search ixigo stays in Goa and its areas (North Goa, South Goa, Anjuna, Vagator and others). "${text.slice(0, 60)}" is not one yet.`);
  if (name === 'goa') return { location: GOA, areas: [], half: null };
  // A half of Goa is every area in it ixigo has a code for; the stays are then checked against the half's places too.
  if (name === 'north goa' || name === 'south goa') {
    const half: GoaHalf = name === 'north goa' ? 'north' : 'south';
    const areas = [...new Set(GOA_HALVES[half].flatMap((place) => GOA_AREA_CODES[place] ?? []))].sort();
    return { location: GOA, areas, half };
  }
  if (name === 'anjuna') return { location: ANJUNA, areas: [], half: 'north' };
  return { location: GOA, areas: [...(GOA_AREA_CODES[name] ?? [])].sort(), half: goaHalfOf(name) };
}

/** An airport's city from the table, for a page that shows only codes. */
export const airportCity = (code: string): string | null => AIRPORTS[code]?.city ?? null;

/** The place names (not codes) Go knows for a kind of search, longest first: what the travel ask reader looks for. */
export function placeWords(kind: 'flights' | 'trains' | 'buses' | 'stays'): string[] {
  const words = { flights: Object.keys(AIRPORT_WORDS), trains: Object.keys(STATION_WORDS), buses: Object.keys(BUS_WORDS), stays: GOA_AREAS }[kind];
  return [...words].sort((a, b) => b.length - a.length);
}
