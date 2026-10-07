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

const GOA: StayLocation = { locationId: 32, locationName: 'Goa', locationType: 'S', masterLocationId: 48569, countryId: 1 };

/** Every part of Goa searches all of Goa; each option then says its own area, so a stay is never placed where it isn't. */
const GOA_AREAS = [
  'goa', 'north goa', 'south goa', 'anjuna', 'vagator', 'calangute', 'candolim', 'baga', 'morjim', 'arambol', 'assagao', 'siolim', 'ashwem',
  'mandrem', 'panaji', 'panjim', 'mapusa', 'porvorim', 'colva', 'benaulim', 'varca', 'cavelossim', 'palolem', 'agonda', 'majorda', 'dona paula',
];

export function stayLocationOf(text: string): StayLocation {
  const t = norm(text).replace(/,?\s*goa$/, '');
  if (GOA_AREAS.includes(t) || GOA_AREAS.includes(norm(text))) return GOA;
  throw new TravelError('unknown_place', `Go can search ixigo stays in Goa and its areas (North Goa, South Goa, Anjuna, Vagator and others). "${text.slice(0, 60)}" is not one yet.`);
}

/** An airport's city from the table, for a page that shows only codes. */
export const airportCity = (code: string): string | null => AIRPORTS[code]?.city ?? null;

/** The place names (not codes) Go knows for a kind of search, longest first: what the travel ask reader looks for. */
export function placeWords(kind: 'flights' | 'trains' | 'buses' | 'stays'): string[] {
  const words = { flights: Object.keys(AIRPORT_WORDS), trains: Object.keys(STATION_WORDS), buses: Object.keys(BUS_WORDS), stays: GOA_AREAS }[kind];
  return [...words].sort((a, b) => b.length - a.length);
}
