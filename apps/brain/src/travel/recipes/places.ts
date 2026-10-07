/**
 * The places Go can search on ixigo.com, as ixigo's own codes: airports, railway stations, bus cities and hotel
 * locations. A place resolves from the hand tables first (instant), then from what ixigo's own search boxes told Go
 * about it (places-live.ts learns it before a search, cached by name), then, for a flight, from an airport code the model
 * wrote in brackets ("London (LHR)"). Anything else is refused as unknown_place, never guessed: the search answers with
 * ixigo's own page for that kind of search instead.
 */
import { TravelError } from '../mcp-travel.js';
import type { TravelKind } from '../travel.js';

/** "  North Goa (GOX) " as "north goa (gox)": lower case, single spaces. */
export const norm = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ');

/** A code people or the model wrote in brackets, "Goa (GOX)", or the whole text when it is a code. */
function codeIn(text: string): string | null {
  const m = /\(([a-z]{2,5})\)$/i.exec(text.trim()) ?? /^([a-z]{2,5})$/i.exec(text.trim());
  return m?.[1]?.toUpperCase() ?? null;
}

/** The name without a code in brackets: "London (LHR)" as "london". */
const nameOf = (text: string): string => norm(text.replace(/\([^)]*\)$/, ''));

function resolve<T>(text: string, codes: Record<string, T>, words: Record<string, string>): T | null {
  const code = codeIn(text);
  if (code && code in codes) return codes[code]!;
  const byWord = words[nameOf(text)];
  return byWord ? codes[byWord]! : null;
}

/** Place names that are everyday Hinglish too ("gaya", went; "puri", whole): those places go by their codes only. */
const NOT_PLACE_WORDS = new Set(['gaya', 'puri']);

/** The words for a table's places: each place's own name, the first place of a name winning, and the aliases. */
function wordsFor<T>(codes: Record<string, T>, nameOfPlace: (p: T) => string, aliases: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [code, place] of Object.entries(codes)) {
    const word = norm(nameOfPlace(place));
    if (!NOT_PLACE_WORDS.has(word)) out[word] ??= code;
  }
  return { ...out, ...aliases };
}

// ── what the live lookup learned ─────────────────────────────────────────────

/** Places ixigo's search boxes resolved, by kind and name. The same for every trip: they are ixigo's public codes. */
const learned = { flights: new Map<string, Airport>(), trains: new Map<string, Station>(), buses: new Map<string, BusCity>(), stays: new Map<string, StayLocation>() };
type Learned = { flights: Airport; trains: Station; buses: BusCity; stays: StayLocation };
const LEARNED_MAX = 2_000;

/** Keeps what ixigo's search box answered for a name, so the search's own (sync) slots resolve it. */
export function learnPlace<K extends TravelKind>(kind: K, text: string, place: Learned[K]): void {
  const map = learned[kind] as Map<string, Learned[K]>;
  map.delete(nameOf(text));
  map.set(nameOf(text), place);
  while (map.size > LEARNED_MAX) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** True when a search of this kind resolves the place now, without asking ixigo. */
export function knowsPlace(kind: TravelKind, text: string): boolean {
  try {
    if (kind === 'flights') airportOf(text);
    else if (kind === 'trains') stationOf(text);
    else if (kind === 'buses') busCityOf(text);
    else stayPlaceOf(text);
    return true;
  } catch (err) {
    if (err instanceof TravelError && err.code === 'unknown_place') return false;
    throw err;
  }
}

/** For tests: forgets what the live lookup learned. */
export function forgetLearnedPlaces(): void {
  for (const map of Object.values(learned)) map.clear();
}

const unknown = (what: string, text: string): TravelError =>
  new TravelError('unknown_place', `Go has no ixigo ${what} code for "${text.slice(0, 60)}".`);

// ── airports ─────────────────────────────────────────────────────────────────

export interface Airport { code: string; city: string }

const AIRPORTS: Record<string, Airport> = Object.fromEntries(
  Object.entries({
    // India: ixigo's search for GOI also answers flights into GOX (and DEL's, Hindon's and Noida's), so "Goa" is one search.
    DEL: 'Delhi', GOI: 'Goa', GOX: 'Goa', BOM: 'Mumbai', BLR: 'Bengaluru', PNQ: 'Pune', HYD: 'Hyderabad', MAA: 'Chennai',
    CCU: 'Kolkata', AMD: 'Ahmedabad', JAI: 'Jaipur', COK: 'Kochi', TRV: 'Thiruvananthapuram', CCJ: 'Kozhikode', CNN: 'Kannur',
    IXE: 'Mangaluru', LKO: 'Lucknow', VNS: 'Varanasi', PAT: 'Patna', IXR: 'Ranchi', BBI: 'Bhubaneswar', GAU: 'Guwahati',
    IXB: 'Bagdogra', IXC: 'Chandigarh', ATQ: 'Amritsar', SXR: 'Srinagar', IXJ: 'Jammu', IXL: 'Leh', DED: 'Dehradun',
    KUU: 'Kullu', DHM: 'Dharamshala', SLV: 'Shimla', UDR: 'Udaipur', JDH: 'Jodhpur', JSA: 'Jaisalmer', IDR: 'Indore',
    BHO: 'Bhopal', NAG: 'Nagpur', RPR: 'Raipur', VTZ: 'Visakhapatnam', VGA: 'Vijayawada', TIR: 'Tirupati', CJB: 'Coimbatore',
    IXM: 'Madurai', TRZ: 'Tiruchirappalli', IXZ: 'Port Blair', AGR: 'Agra', STV: 'Surat', BDQ: 'Vadodara', HBX: 'Hubballi',
    IXG: 'Belagavi', MYQ: 'Mysuru', IMF: 'Imphal', IXA: 'Agartala', DIB: 'Dibrugarh', AYJ: 'Ayodhya', IXD: 'Prayagraj',
    GOP: 'Gorakhpur', JLR: 'Jabalpur',
    // Abroad: the airports most flights from India go to.
    LHR: 'London', LGW: 'London', MAN: 'Manchester', BHX: 'Birmingham', EDI: 'Edinburgh', DXB: 'Dubai', AUH: 'Abu Dhabi',
    SHJ: 'Sharjah', DOH: 'Doha', BAH: 'Bahrain', MCT: 'Muscat', KWI: 'Kuwait', RUH: 'Riyadh', JED: 'Jeddah', SIN: 'Singapore',
    BKK: 'Bangkok', HKT: 'Phuket', KUL: 'Kuala Lumpur', HKG: 'Hong Kong', DPS: 'Bali', MLE: 'Maldives', CMB: 'Colombo',
    KTM: 'Kathmandu', DAC: 'Dhaka', HND: 'Tokyo', NRT: 'Tokyo', ICN: 'Seoul', PVG: 'Shanghai', SYD: 'Sydney', MEL: 'Melbourne',
    PER: 'Perth', BNE: 'Brisbane', AKL: 'Auckland', JFK: 'New York', EWR: 'Newark', ORD: 'Chicago', IAD: 'Washington',
    SFO: 'San Francisco', LAX: 'Los Angeles', SEA: 'Seattle', IAH: 'Houston', DFW: 'Dallas', ATL: 'Atlanta', BOS: 'Boston',
    YYZ: 'Toronto', YVR: 'Vancouver', CDG: 'Paris', FRA: 'Frankfurt', MUC: 'Munich', AMS: 'Amsterdam', ZRH: 'Zurich',
    VIE: 'Vienna', FCO: 'Rome', MXP: 'Milan', MAD: 'Madrid', BCN: 'Barcelona', IST: 'Istanbul', CPH: 'Copenhagen',
    ARN: 'Stockholm', HEL: 'Helsinki', DUB: 'Dublin', BRU: 'Brussels', LIS: 'Lisbon', ATH: 'Athens', NBO: 'Nairobi',
    JNB: 'Johannesburg', CPT: 'Cape Town', CAI: 'Cairo', MRU: 'Mauritius', SEZ: 'Seychelles', TBS: 'Tbilisi', GYD: 'Baku',
    ALA: 'Almaty', TAS: 'Tashkent', HAN: 'Hanoi', SGN: 'Ho Chi Minh City', MNL: 'Manila', CGK: 'Jakarta',
  }).map(([code, city]) => [code, { code, city }]),
);

/** Names people use for an airport's city or the places it serves. */
const AIRPORT_WORDS: Record<string, string> = wordsFor(AIRPORTS, (a) => a.city, {
  'new delhi': 'DEL', gurgaon: 'DEL', gurugram: 'DEL', noida: 'DEL', 'south goa': 'GOI', dabolim: 'GOI', 'north goa': 'GOX', mopa: 'GOX',
  bombay: 'BOM', bangalore: 'BLR', madras: 'MAA', calcutta: 'CCU', cochin: 'COK', ernakulam: 'COK', trivandrum: 'TRV',
  calicut: 'CCJ', mangalore: 'IXE', banaras: 'VNS', benares: 'VNS', manali: 'KUU', bhuntar: 'KUU', dharamsala: 'DHM',
  mcleodganj: 'DHM', kangra: 'DHM', rishikesh: 'DED', haridwar: 'DED', mussoorie: 'DED', ladakh: 'IXL', kashmir: 'SXR',
  gulmarg: 'SXR', pahalgam: 'SXR', siliguri: 'IXB', darjeeling: 'IXB', gangtok: 'IXB', sikkim: 'IXB', andaman: 'IXZ',
  havelock: 'IXZ', vizag: 'VTZ', trichy: 'TRZ', mysore: 'MYQ', hubli: 'HBX', belgaum: 'IXG', allahabad: 'IXD', baroda: 'BDQ',
  heathrow: 'LHR', 'london heathrow': 'LHR', gatwick: 'LGW', 'london gatwick': 'LGW', nyc: 'JFK', 'new york city': 'JFK',
  'washington dc': 'IAD', 'sri lanka': 'CMB', nepal: 'KTM', saigon: 'SGN', 'ho chi minh': 'SGN', denpasar: 'DPS',
});

/** An airport the table or ixigo's search box knows; else a code the model gave in brackets, "London (LHR)", as it is. */
export function airportOf(text: string): Airport {
  const a = resolve(text, AIRPORTS, AIRPORT_WORDS) ?? learned.flights.get(nameOf(text));
  if (a) return a;
  const given = /^(.+?)\s*\(([A-Z]{3})\)$/.exec(text.trim());
  if (given) return { code: given[2]!, city: given[1]!.trim() };
  throw unknown('airport', text);
}

// ── railway stations ─────────────────────────────────────────────────────────

export interface Station { code: string; name: string }

const STATIONS: Record<string, Station> = Object.fromEntries(
  Object.entries({
    NDLS: 'New Delhi', NZM: 'Hazrat Nizamuddin', DLI: 'Old Delhi', ANVT: 'Anand Vihar Terminal', CSMT: 'Mumbai CSMT',
    LTT: 'Lokmanya Tilak Terminus', BCT: 'Mumbai Central', MAO: 'Madgaon', KRMI: 'Karmali', THVM: 'Thivim', VSG: 'Vasco da Gama',
    PUNE: 'Pune', SBC: 'KSR Bengaluru', MAS: 'Chennai Central', MS: 'Chennai Egmore', HWH: 'Howrah', SDAH: 'Sealdah',
    SC: 'Secunderabad', HYB: 'Hyderabad Deccan', ADI: 'Ahmedabad', JP: 'Jaipur', ERS: 'Ernakulam', LKO: 'Lucknow',
    CNB: 'Kanpur Central', BSB: 'Varanasi', PNBE: 'Patna', PRYJ: 'Prayagraj', AGC: 'Agra Cantt', GWL: 'Gwalior', BPL: 'Bhopal',
    INDB: 'Indore', NGP: 'Nagpur', R: 'Raipur', BBS: 'Bhubaneswar', PURI: 'Puri', GHY: 'Guwahati', NJP: 'New Jalpaiguri',
    CDG: 'Chandigarh', ASR: 'Amritsar', JAT: 'Jammu Tawi', SVDK: 'Katra', KLK: 'Kalka', SML: 'Shimla', DDN: 'Dehradun',
    HW: 'Haridwar', YNRK: 'Rishikesh', UDZ: 'Udaipur City', JU: 'Jodhpur', JSM: 'Jaisalmer', AII: 'Ajmer', BKN: 'Bikaner',
    ST: 'Surat', BRC: 'Vadodara', RJT: 'Rajkot', MAQ: 'Mangaluru Central', CLT: 'Kozhikode', TVC: 'Thiruvananthapuram',
    CBE: 'Coimbatore', MDU: 'Madurai', TPTY: 'Tirupati', VSKP: 'Visakhapatnam', BZA: 'Vijayawada', MYS: 'Mysuru',
    UBL: 'Hubballi', NK: 'Nashik Road',
  }).map(([code, name]) => [code, { code, name }]),
);

// A city's main station: ixigo answers trains from the city's other stations too (NDLS gives NZM's, CSMT gives LTT's).
const STATION_WORDS: Record<string, string> = wordsFor(STATIONS, (s) => s.name, {
  delhi: 'NDLS', nizamuddin: 'NZM', 'anand vihar': 'ANVT', mumbai: 'CSMT', bombay: 'CSMT', 'mumbai cst': 'CSMT', cst: 'CSMT',
  'lokmanya tilak': 'LTT', goa: 'MAO', 'north goa': 'MAO', 'south goa': 'MAO', margao: 'MAO', vasco: 'VSG',
  bangalore: 'SBC', bengaluru: 'SBC', chennai: 'MAS', madras: 'MAS', egmore: 'MS', kolkata: 'HWH', calcutta: 'HWH',
  hyderabad: 'SC', kochi: 'ERS', cochin: 'ERS', kanpur: 'CNB', banaras: 'BSB', benares: 'BSB', allahabad: 'PRYJ', agra: 'AGC',
  siliguri: 'NJP', njp: 'NJP', darjeeling: 'NJP', jammu: 'JAT', 'vaishno devi': 'SVDK', udaipur: 'UDZ', baroda: 'BRC',
  mangaluru: 'MAQ', mangalore: 'MAQ', calicut: 'CLT', trivandrum: 'TVC', vizag: 'VSKP', mysore: 'MYS', hubli: 'UBL', nashik: 'NK',
});

export function stationOf(text: string): Station {
  const s = resolve(text, STATIONS, STATION_WORDS) ?? learned.trains.get(nameOf(text));
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
  const c = BUS_CITIES[BUS_WORDS[norm(text)] ?? ''] ?? learned.buses.get(nameOf(text));
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
    // Outside Goa: ixigo's own location for the place, as its hotel search box gave it.
    const location = learned.stays.get(nameOf(text));
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

/** An airport's city from the table or what ixigo's search box answered, for a page that shows only codes. */
export function airportCity(code: string): string | null {
  return AIRPORTS[code]?.city ?? [...learned.flights.values()].find((a) => a.code === code)?.city ?? null;
}

/** The place names (not codes) Go knows for a kind of search, longest first: what the travel ask reader looks for. */
export function placeWords(kind: 'flights' | 'trains' | 'buses' | 'stays'): string[] {
  const words = { flights: Object.keys(AIRPORT_WORDS), trains: Object.keys(STATION_WORDS), buses: Object.keys(BUS_WORDS), stays: GOA_AREAS }[kind];
  return [...words].sort((a, b) => b.length - a.length);
}
