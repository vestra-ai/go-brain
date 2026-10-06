/**
 * The fake ixigo: deterministic flights, trains and buses into Goa, North and South Goa villas, live flight status,
 * and a two-step booking (hold, then confirm), answered in raw shapes like a partner API's. One table of tools
 * serves both the standalone MCP server (server.ts) and Go's in-process backend (mcp-caller.ts). Ids carry the route,
 * the date and the item, so a search and a hold read the same after a restart. Everything it sells is labelled
 * "ixigo (simulated)".
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const FAKE_VENDOR = 'ixigo (simulated)';
const IST = '+05:30';
const MAX_KEPT = 1_000;
const HOLD_MS = 15 * 60_000;

// ── time and small helpers ───────────────────────────────────────────────────

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const compactDate = (date: string): string => date.replaceAll('-', '');
const expandDate = (yyyymmdd: string): string => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
const at = (date: string, clock: string): string => `${date}T${clock}:00${IST}`;
const clockMinutes = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
/** A Date as an ISO time in India, e.g. 2026-11-06T20:10:00+05:30. */
const toIst = (d: Date): string => `${new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 19)}${IST}`;

function leg(date: string, dep: string, arr: string, days: number): { depart_at: string; arrive_at: string; duration_min: number } {
  return { depart_at: at(date, dep), arrive_at: at(addDays(date, days), arr), duration_min: days * 1440 + clockMinutes(arr) - clockMinutes(dep) };
}

function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000);
}

/** A small number from a string, the same every time. */
function seeded(text: string, mod: number): number {
  return createHash('sha256').update(text).digest().readUInt32BE(0) % mod;
}

function keepAtMost<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

// ── flights ──────────────────────────────────────────────────────────────────

const AIRPORTS: Record<string, string> = { DEL: 'Delhi', GOI: 'Goa (Dabolim)', GOX: 'North Goa (Mopa)', BOM: 'Mumbai', BLR: 'Bengaluru' };
const AIRPORT_WORDS: Record<string, string[]> = {
  delhi: ['DEL'], 'new delhi': ['DEL'], goa: ['GOI', 'GOX'], 'north goa': ['GOX'], mopa: ['GOX'], 'south goa': ['GOI'], dabolim: ['GOI'],
  mumbai: ['BOM'], bombay: ['BOM'], bangalore: ['BLR'], bengaluru: ['BLR'],
};

export function airportCodes(place: string): string[] {
  const words = AIRPORT_WORDS[place.trim().toLowerCase()];
  if (words) return words;
  const code = place.trim().toUpperCase();
  return code in AIRPORTS ? [code] : [];
}

interface Flight { from: string; to: string; airline: string; code: string; number: string; dep: string; arr: string; fare: number }

const FLIGHTS: Flight[] = [
  { from: 'DEL', to: 'GOI', airline: 'IndiGo', code: '6E', number: '515', dep: '06:15', arr: '08:50', fare: 489000 },
  { from: 'DEL', to: 'GOI', airline: 'SpiceJet', code: 'SG', number: '8169', dep: '09:40', arr: '12:20', fare: 521000 },
  { from: 'DEL', to: 'GOI', airline: 'Air India', code: 'AI', number: '2985', dep: '13:05', arr: '15:40', fare: 615000 },
  { from: 'DEL', to: 'GOI', airline: 'Akasa Air', code: 'QP', number: '1342', dep: '16:30', arr: '19:05', fare: 548000 },
  { from: 'DEL', to: 'GOI', airline: 'IndiGo', code: '6E', number: '2134', dep: '18:10', arr: '20:45', fare: 592000 },
  { from: 'DEL', to: 'GOI', airline: 'Air India', code: 'AI', number: '2981', dep: '19:45', arr: '22:20', fare: 598000 },
  { from: 'DEL', to: 'GOI', airline: 'IndiGo', code: '6E', number: '6721', dep: '21:20', arr: '23:55', fare: 564000 },
  { from: 'DEL', to: 'GOX', airline: 'IndiGo', code: '6E', number: '6153', dep: '07:30', arr: '10:05', fare: 535000 },
  { from: 'DEL', to: 'GOX', airline: 'Akasa Air', code: 'QP', number: '1846', dep: '17:50', arr: '20:25', fare: 604000 },
  { from: 'DEL', to: 'GOX', airline: 'Air India', code: 'AI', number: '2847', dep: '20:30', arr: '23:05', fare: 642000 },
  { from: 'BOM', to: 'GOI', airline: 'IndiGo', code: '6E', number: '5394', dep: '07:05', arr: '08:15', fare: 312000 },
  { from: 'BOM', to: 'GOI', airline: 'Air India', code: 'AI', number: '663', dep: '18:40', arr: '19:50', fare: 365000 },
  { from: 'BOM', to: 'GOX', airline: 'Akasa Air', code: 'QP', number: '1121', dep: '11:20', arr: '12:30', fare: 298000 },
  { from: 'BLR', to: 'GOI', airline: 'IndiGo', code: '6E', number: '7146', dep: '06:40', arr: '07:55', fare: 341000 },
  { from: 'BLR', to: 'GOI', airline: 'IndiGo', code: '6E', number: '7158', dep: '19:25', arr: '20:40', fare: 389000 },
  { from: 'BLR', to: 'GOX', airline: 'Akasa Air', code: 'QP', number: '1428', dep: '20:10', arr: '21:25', fare: 402000 },
  { from: 'GOI', to: 'DEL', airline: 'IndiGo', code: '6E', number: '6722', dep: '15:10', arr: '17:45', fare: 612000 },
  { from: 'GOI', to: 'DEL', airline: 'Air India', code: 'AI', number: '2982', dep: '19:30', arr: '22:05', fare: 585000 },
  { from: 'GOX', to: 'DEL', airline: 'Akasa Air', code: 'QP', number: '1847', dep: '21:00', arr: '23:35', fare: 571000 },
];

export interface RawFlight {
  fare_id: string; airline: string; airline_code: string; flight_no: string;
  from_code: string; from_city: string; to_code: string; to_city: string;
  depart_at: string; arrive_at: string; duration_min: number; stops: number;
  fare_paise: number; cabin: 'economy'; refundable_until: string | null; seats_left: number;
}

function rawFlight(f: Flight, date: string): RawFlight {
  const fareId = `fl-${f.from}-${f.to}-${compactDate(date)}-${f.code}${f.number}`;
  return {
    fare_id: fareId,
    airline: f.airline,
    airline_code: f.code,
    flight_no: f.number,
    from_code: f.from,
    from_city: AIRPORTS[f.from]!,
    to_code: f.to,
    to_city: AIRPORTS[f.to]!,
    ...leg(date, f.dep, f.arr, f.arr < f.dep ? 1 : 0),
    stops: 0,
    fare_paise: f.fare,
    cabin: 'economy',
    // Air India sells a fare that is free to cancel up to two days before; the others do not.
    refundable_until: f.code === 'AI' ? at(addDays(date, -2), '23:59') : null,
    seats_left: 2 + seeded(fareId, 8),
  };
}

export function searchFlights(a: { origin: string; destination: string; date: string }): { flights: RawFlight[] } {
  const from = airportCodes(a.origin);
  const to = airportCodes(a.destination);
  const flights = FLIGHTS.filter((f) => from.includes(f.from) && to.includes(f.to)).map((f) => rawFlight(f, a.date));
  return { flights: flights.sort((x, y) => x.depart_at.localeCompare(y.depart_at)) };
}

// ── trains ───────────────────────────────────────────────────────────────────

const STATIONS: Record<string, string> = { NZM: 'Delhi Hazrat Nizamuddin', MAO: 'Madgaon', THVM: 'Thivim (North Goa)', CSMT: 'Mumbai CSMT' };
const STATION_WORDS: Record<string, string[]> = {
  delhi: ['NZM'], 'new delhi': ['NZM'], goa: ['MAO', 'THVM'], madgaon: ['MAO'], margao: ['MAO'], thivim: ['THVM'], 'north goa': ['THVM'], mumbai: ['CSMT'],
};

function stationCodes(place: string): string[] {
  const words = STATION_WORDS[place.trim().toLowerCase()];
  if (words) return words;
  const code = place.trim().toUpperCase();
  return code in STATIONS ? [code] : [];
}

interface Train { from: string; to: string; no: string; name: string; dep: string; arr: string; days: number; fares: Record<string, number> }

const TRAINS: Train[] = [
  { from: 'NZM', to: 'MAO', no: '22414', name: 'Madgaon Rajdhani Express', dep: '10:55', arr: '10:20', days: 1, fares: { '3A': 412000, '2A': 565000 } },
  { from: 'NZM', to: 'MAO', no: '12450', name: 'Goa Sampark Kranti Express', dep: '06:00', arr: '12:40', days: 1, fares: { '3A': 301000, '2A': 425000 } },
  { from: 'NZM', to: 'THVM', no: '12780', name: 'Goa Express', dep: '15:00', arr: '15:45', days: 1, fares: { SL: 105000, '3A': 279000 } },
  { from: 'CSMT', to: 'THVM', no: '12051', name: 'Jan Shatabdi Express', dep: '05:10', arr: '12:45', days: 0, fares: { CC: 77500 } },
  { from: 'CSMT', to: 'THVM', no: '10103', name: 'Mandovi Express', dep: '07:10', arr: '17:30', days: 0, fares: { SL: 41000, '3A': 112000 } },
];

export interface RawTrain {
  fare_id: string; train_no: string; train_name: string; from_code: string; from_name: string; to_code: string; to_name: string;
  depart_at: string; arrive_at: string; duration_min: number; class_code: string; fare_paise: number; availability: string;
}

function rawTrain(t: Train, date: string, cls: string, fare: number): RawTrain {
  const fareId = `tr-${t.from}-${t.to}-${compactDate(date)}-${t.no}-${cls}`;
  const left = seeded(fareId, 30);
  return {
    fare_id: fareId, train_no: t.no, train_name: t.name, from_code: t.from, from_name: STATIONS[t.from]!, to_code: t.to, to_name: STATIONS[t.to]!,
    ...leg(date, t.dep, t.arr, t.days), class_code: cls, fare_paise: fare, availability: left > 3 ? `AVL ${left}` : `WL ${4 - left}`,
  };
}

export function searchTrains(a: { from_station: string; to_station: string; date: string }): { trains: RawTrain[] } {
  const from = stationCodes(a.from_station);
  const to = stationCodes(a.to_station);
  const trains: RawTrain[] = [];
  for (const t of TRAINS.filter((x) => from.includes(x.from) && to.includes(x.to))) {
    for (const [cls, fare] of Object.entries(t.fares)) trains.push(rawTrain(t, a.date, cls, fare));
  }
  return { trains: trains.sort((x, y) => x.depart_at.localeCompare(y.depart_at) || x.fare_paise - y.fare_paise) };
}

// ── buses ────────────────────────────────────────────────────────────────────

const BUS_CITY_WORDS: Record<string, string> = {
  mumbai: 'Mumbai', bombay: 'Mumbai', goa: 'Goa', panaji: 'Goa', mapusa: 'Goa', 'north goa': 'Goa', bangalore: 'Bengaluru', bengaluru: 'Bengaluru', pune: 'Pune',
};

interface Bus { from: string; to: string; operator: string; type: string; dep: string; arr: string; fare: number; rating: number }

const BUSES: Bus[] = [
  { from: 'Mumbai', to: 'Goa', operator: 'Paulo Travels', type: 'Volvo AC Sleeper', dep: '20:30', arr: '07:30', fare: 145000, rating: 4.4 },
  { from: 'Mumbai', to: 'Goa', operator: 'Neeta Tours and Travels', type: 'AC Sleeper', dep: '21:15', arr: '08:45', fare: 125000, rating: 4.1 },
  { from: 'Mumbai', to: 'Goa', operator: 'Kadamba Transport (KTCL)', type: 'Non-AC Seater', dep: '18:00', arr: '06:30', fare: 98000, rating: 3.8 },
  { from: 'Bengaluru', to: 'Goa', operator: 'VRL Travels', type: 'AC Sleeper', dep: '21:00', arr: '08:00', fare: 139000, rating: 4.2 },
  { from: 'Pune', to: 'Goa', operator: 'Atmaram Travels', type: 'AC Sleeper', dep: '22:00', arr: '08:30', fare: 115000, rating: 4.0 },
];

export interface RawBus {
  fare_id: string; operator: string; bus_type: string; from_city: string; to_city: string;
  depart_at: string; arrive_at: string; duration_min: number; fare_paise: number; seats_left: number; rating: number;
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const busKey = (b: Bus): string => `${slug(b.operator)}-${slug(b.from)}-${slug(b.to)}`;

function rawBus(b: Bus, date: string): RawBus {
  const fareId = `bus-${busKey(b)}-${compactDate(date)}`;
  return {
    fare_id: fareId, operator: b.operator, bus_type: b.type, from_city: b.from, to_city: b.to,
    ...leg(date, b.dep, b.arr, b.arr < b.dep ? 1 : 0), fare_paise: b.fare, seats_left: 3 + seeded(fareId, 20), rating: b.rating,
  };
}

export function searchBuses(a: { from_city: string; to_city: string; date: string }): { buses: RawBus[] } {
  const from = BUS_CITY_WORDS[a.from_city.trim().toLowerCase()];
  const to = BUS_CITY_WORDS[a.to_city.trim().toLowerCase()];
  return { buses: BUSES.filter((b) => b.from === from && b.to === to).map((b) => rawBus(b, a.date)).sort((x, y) => x.depart_at.localeCompare(y.depart_at)) };
}

// ── stays ────────────────────────────────────────────────────────────────────

interface Stay {
  slug: string; name: string; area: string; region: 'North Goa' | 'South Goa'; lat: number; lng: number; rating: number; reviews: number;
  sleeps: number; bedrooms: number; pool: boolean; beach: number; breakfast: boolean; night: number; freeCancel: boolean;
}

const STAYS: Stay[] = [
  { slug: 'villa-sol-anjuna', name: 'Villa Sol', area: 'Anjuna', region: 'North Goa', lat: 15.5835, lng: 73.7417, rating: 4.7, reviews: 212, sleeps: 6, bedrooms: 3, pool: true, beach: 8, breakfast: true, night: 1280000, freeCancel: true },
  { slug: 'casa-azul-assagao', name: 'Casa Azul', area: 'Assagao', region: 'North Goa', lat: 15.5976, lng: 73.7642, rating: 4.8, reviews: 168, sleeps: 8, bedrooms: 4, pool: true, beach: 15, breakfast: false, night: 1460000, freeCancel: false },
  { slug: 'the-palms-vagator', name: 'The Palms Villa', area: 'Vagator', region: 'North Goa', lat: 15.6011, lng: 73.7364, rating: 4.5, reviews: 301, sleeps: 6, bedrooms: 3, pool: true, beach: 5, breakfast: true, night: 1220000, freeCancel: true },
  { slug: 'villa-verde-siolim', name: 'Villa Verde', area: 'Siolim', region: 'North Goa', lat: 15.6215, lng: 73.765, rating: 4.4, reviews: 97, sleeps: 6, bedrooms: 3, pool: true, beach: 20, breakfast: false, night: 1150000, freeCancel: false },
  { slug: 'ocean-breeze-candolim', name: 'Ocean Breeze Villa', area: 'Candolim', region: 'North Goa', lat: 15.518, lng: 73.762, rating: 4.3, reviews: 254, sleeps: 5, bedrooms: 3, pool: true, beach: 3, breakfast: true, night: 1310000, freeCancel: true },
  { slug: 'casa-mareia-morjim', name: 'Casa Mareia', area: 'Morjim', region: 'North Goa', lat: 15.629, lng: 73.729, rating: 4.9, reviews: 88, sleeps: 6, bedrooms: 3, pool: true, beach: 2, breakfast: true, night: 1690000, freeCancel: true },
  { slug: 'saudade-parra', name: 'Saudade Villa', area: 'Parra', region: 'North Goa', lat: 15.57, lng: 73.79, rating: 4.2, reviews: 64, sleeps: 6, bedrooms: 3, pool: false, beach: 18, breakfast: false, night: 980000, freeCancel: false },
  { slug: 'villa-coco-arpora', name: 'Villa Coco', area: 'Arpora', region: 'North Goa', lat: 15.564, lng: 73.766, rating: 4.6, reviews: 143, sleeps: 4, bedrooms: 2, pool: true, beach: 12, breakfast: true, night: 1040000, freeCancel: false },
  { slug: 'casa-serena-benaulim', name: 'Casa Serena', area: 'Benaulim', region: 'South Goa', lat: 15.258, lng: 73.928, rating: 4.6, reviews: 120, sleeps: 6, bedrooms: 3, pool: true, beach: 6, breakfast: true, night: 1180000, freeCancel: true },
  { slug: 'villa-mar-colva', name: 'Villa Mar', area: 'Colva', region: 'South Goa', lat: 15.279, lng: 73.922, rating: 4.4, reviews: 76, sleeps: 8, bedrooms: 4, pool: true, beach: 4, breakfast: false, night: 1390000, freeCancel: false },
];

export interface RawStay {
  stay_id: string; name: string; type: 'villa'; area: string; region: string; address: string; lat: number; lng: number;
  image_url: string; rating: number; reviews: number; sleeps: number; bedrooms: number; private_pool: boolean; beach_minutes: number;
  breakfast: boolean; price_per_night_paise: number; nights: number; total_paise: number; free_cancellation_until: string | null;
}

function rawStay(s: Stay, checkIn: string, checkOut: string, guests: number): RawStay {
  const nights = nightsBetween(checkIn, checkOut);
  return {
    stay_id: `st-${s.slug}-${compactDate(checkIn)}-${compactDate(checkOut)}-${guests}`,
    name: s.name, type: 'villa', area: s.area, region: s.region, address: `${s.area}, ${s.region}, Goa`, lat: s.lat, lng: s.lng,
    image_url: `https://picsum.photos/seed/go-${s.slug}/800/600`,
    rating: s.rating, reviews: s.reviews, sleeps: s.sleeps, bedrooms: s.bedrooms, private_pool: s.pool, beach_minutes: s.beach,
    breakfast: s.breakfast, price_per_night_paise: s.night, nights, total_paise: s.night * nights,
    free_cancellation_until: s.freeCancel ? at(addDays(checkIn, -3), '23:59') : null,
  };
}

export function searchStays(a: { location: string; check_in: string; check_out: string; guests?: number | undefined }): { stays: RawStay[] } | { error: string } {
  const nights = nightsBetween(a.check_in, a.check_out);
  if (nights < 1 || nights > 30) return { error: 'invalid_dates' };
  const where = a.location.trim().toLowerCase();
  const matches = STAYS.filter((s) => where === 'goa' || where === s.region.toLowerCase() || where === s.area.toLowerCase() || s.name.toLowerCase().includes(where));
  const fits = matches.filter((s) => a.guests === undefined || s.sleeps >= a.guests);
  return { stays: fits.map((s) => rawStay(s, a.check_in, a.check_out, a.guests ?? 0)) };
}

// ── finding a fare again by its id ───────────────────────────────────────────

export interface RawJourney {
  mode: 'flight' | 'train' | 'bus'; from_name: string; from_code: string | null; to_name: string; to_code: string | null;
  depart_at: string; arrive_at: string; carrier: string; carrier_code: string | null; number: string | null;
}
export interface RawPlace { name: string; address: string; lat: number; lng: number }
export interface FareFound {
  kind: 'flight' | 'train' | 'bus' | 'stay'; title: string; unitPaise: number; perTraveller: boolean; startsAt: string; endsAt: string;
  refundableUntil: string | null; imageUrl: string | null; journey: RawJourney | null; place: RawPlace | null;
}

export function findFare(fareId: string): FareFound | null {
  const parts = fareId.split('-');
  if (parts[0] === 'fl' && parts.length === 5) {
    const [, from, to, day, flightKey] = parts as [string, string, string, string, string];
    const f = FLIGHTS.find((x) => x.from === from && x.to === to && `${x.code}${x.number}` === flightKey);
    if (!f || !/^\d{8}$/.test(day)) return null;
    const r = rawFlight(f, expandDate(day));
    return {
      kind: 'flight', title: `${f.airline} ${f.code} ${f.number}`, unitPaise: f.fare, perTraveller: true, startsAt: r.depart_at, endsAt: r.arrive_at,
      refundableUntil: r.refundable_until, imageUrl: null, place: null,
      journey: { mode: 'flight', from_name: r.from_city, from_code: f.from, to_name: r.to_city, to_code: f.to, depart_at: r.depart_at, arrive_at: r.arrive_at, carrier: f.airline, carrier_code: f.code, number: `${f.code} ${f.number}` },
    };
  }
  if (parts[0] === 'tr' && parts.length === 6) {
    const [, from, to, day, no, cls] = parts as [string, string, string, string, string, string];
    const t = TRAINS.find((x) => x.from === from && x.to === to && x.no === no);
    const fare = t?.fares[cls];
    if (!t || fare === undefined || !/^\d{8}$/.test(day)) return null;
    const r = rawTrain(t, expandDate(day), cls, fare);
    return {
      kind: 'train', title: `${t.name} ${t.no}`, unitPaise: fare, perTraveller: true, startsAt: r.depart_at, endsAt: r.arrive_at,
      refundableUntil: null, imageUrl: null, place: null,
      journey: { mode: 'train', from_name: r.from_name, from_code: t.from, to_name: r.to_name, to_code: t.to, depart_at: r.depart_at, arrive_at: r.arrive_at, carrier: 'Indian Railways', carrier_code: null, number: t.no },
    };
  }
  if (parts[0] === 'bus') {
    const day = fareId.slice(-8);
    const key = fareId.slice(4, -9);
    const b = BUSES.find((x) => busKey(x) === key);
    if (!b || !/^\d{8}$/.test(day)) return null;
    const r = rawBus(b, expandDate(day));
    return {
      kind: 'bus', title: b.operator, unitPaise: b.fare, perTraveller: true, startsAt: r.depart_at, endsAt: r.arrive_at,
      refundableUntil: null, imageUrl: null, place: null,
      journey: { mode: 'bus', from_name: b.from, from_code: null, to_name: b.to, to_code: null, depart_at: r.depart_at, arrive_at: r.arrive_at, carrier: b.operator, carrier_code: null, number: null },
    };
  }
  if (parts[0] === 'st' && parts.length >= 5) {
    const guests = Number(parts.at(-1));
    const out = parts.at(-2) ?? '';
    const into = parts.at(-3) ?? '';
    const stay = STAYS.find((s) => s.slug === parts.slice(1, -3).join('-'));
    if (!stay || !/^\d{8}$/.test(out) || !/^\d{8}$/.test(into) || !Number.isInteger(guests)) return null;
    const r = rawStay(stay, expandDate(into), expandDate(out), guests);
    if (r.nights < 1) return null;
    return {
      kind: 'stay', title: stay.name, unitPaise: r.total_paise, perTraveller: false, startsAt: at(expandDate(into), '14:00'), endsAt: at(expandDate(out), '11:00'),
      refundableUntil: r.free_cancellation_until, imageUrl: r.image_url, journey: null,
      place: { name: stay.name, address: r.address, lat: stay.lat, lng: stay.lng },
    };
  }
  return null;
}

// ── the store: status, holds and bookings ────────────────────────────────────

export interface RawFlightStatus { flight: string; date: string; status: 'scheduled' | 'delayed'; scheduled_departure: string; estimated_departure: string; delay_min: number }
export interface RawHold { hold_id: string; amount_paise: number; currency: 'INR'; merchant: string; expires_at: string; refundable_until: string | null }
export interface RawBooking {
  booking_ref: string; status: 'confirmed' | 'cancelled'; kind: FareFound['kind']; title: string; vendor: string; amount_paise: number;
  starts_at: string; ends_at: string; refundable_until: string | null; image_url: string | null; place: RawPlace | null; journey: RawJourney | null;
}

interface HoldRecord { fareId: string; amount: number; expiresAtMs: number; bookingRef: string | null }

export class FakeIxigoStore {
  private readonly holds = new Map<string, HoldRecord>();
  private readonly bookings = new Map<string, RawBooking>();
  private readonly delays = new Map<string, number>();
  private n = 0;

  constructor(private readonly o: { now: () => Date }) {}

  /** Makes one flight late on one day, for the demo's simulated watch. */
  setDelay(carrierCode: string, number: string, date: string, minutes: number): void {
    this.delays.set(`${carrierCode.toUpperCase()}${number}@${date}`, minutes);
  }

  flightStatus(a: { airline_code: string; flight_no: string; date: string }): RawFlightStatus | { error: string } {
    const f = FLIGHTS.find((x) => x.code === a.airline_code.toUpperCase() && x.number === a.flight_no);
    if (!f) return { error: 'flight_not_found' };
    const delay = this.delays.get(`${f.code}${f.number}@${a.date}`) ?? 0;
    const scheduled = at(a.date, f.dep);
    return {
      flight: `${f.code} ${f.number}`, date: a.date, status: delay > 0 ? 'delayed' : 'scheduled', scheduled_departure: scheduled,
      estimated_departure: toIst(new Date(Date.parse(scheduled) + delay * 60_000)), delay_min: delay,
    };
  }

  hold(a: { fare_id: string; lead_name: string; travellers: number }): RawHold | { error: string } {
    const fare = findFare(a.fare_id);
    if (!fare) return { error: 'fare_not_found' };
    this.n += 1;
    const holdId = `hold_${String(this.n).padStart(6, '0')}${seeded(`${a.fare_id}/${this.n}`, 1000).toString().padStart(3, '0')}`;
    const amount = fare.perTraveller ? fare.unitPaise * a.travellers : fare.unitPaise;
    const expiresAtMs = this.o.now().getTime() + HOLD_MS;
    this.holds.set(holdId, { fareId: a.fare_id, amount, expiresAtMs, bookingRef: null });
    keepAtMost(this.holds, MAX_KEPT);
    // A refundable fare says until when on the hold, so the payer sees it before paying.
    return { hold_id: holdId, amount_paise: amount, currency: 'INR', merchant: FAKE_VENDOR, expires_at: toIst(new Date(expiresAtMs)), refundable_until: fare.refundableUntil };
  }

  confirm(a: { hold_id: string; payment_ref: string }): RawBooking | { error: string } {
    const h = this.holds.get(a.hold_id);
    if (!h) return { error: 'hold_not_found' };
    if (h.bookingRef) {
      const done = this.bookings.get(h.bookingRef);
      if (done) return done;
    }
    if (this.o.now().getTime() > h.expiresAtMs) return { error: 'hold_expired' };
    const fare = findFare(h.fareId);
    if (!fare) return { error: 'fare_not_found' };
    const ref = `IXG${100000 + seeded(a.hold_id, 900000)}`;
    const booking: RawBooking = {
      booking_ref: ref, status: 'confirmed', kind: fare.kind, title: fare.title, vendor: FAKE_VENDOR, amount_paise: h.amount,
      starts_at: fare.startsAt, ends_at: fare.endsAt, refundable_until: fare.refundableUntil, image_url: fare.imageUrl, place: fare.place, journey: fare.journey,
    };
    this.bookings.set(ref, booking);
    keepAtMost(this.bookings, MAX_KEPT);
    h.bookingRef = ref;
    return booking;
  }

  cancel(a: { booking_ref: string }): { booking_ref: string; status: 'cancelled'; refund_paise: number } | { error: string } {
    const b = this.bookings.get(a.booking_ref);
    if (!b) return { error: 'booking_not_found' };
    if (b.status === 'cancelled') return { error: 'already_cancelled' };
    b.status = 'cancelled';
    return { booking_ref: b.booking_ref, status: 'cancelled', refund_paise: Math.round(b.amount_paise * 0.8) };
  }

  pnr(a: { pnr: string }): { pnr: string; status: 'confirmed' | 'cancelled' | 'not_found'; detail: string } {
    const b = this.bookings.get(a.pnr);
    return b ? { pnr: a.pnr, status: b.status, detail: b.title } : { pnr: a.pnr, status: 'not_found', detail: 'No booking with that reference' };
  }
}

// ── the tool table ───────────────────────────────────────────────────────────

const Day = z.iso.date();
export const FAKE_IXIGO_ARGS = {
  search_flights: z.object({ origin: z.string().min(2).max(60), destination: z.string().min(2).max(60), date: Day, adults: z.int().min(1).max(9).optional() }),
  search_trains: z.object({ from_station: z.string().min(2).max(60), to_station: z.string().min(2).max(60), date: Day }),
  search_buses: z.object({ from_city: z.string().min(2).max(60), to_city: z.string().min(2).max(60), date: Day }),
  search_stays: z.object({ location: z.string().min(2).max(60), check_in: Day, check_out: Day, guests: z.int().min(1).max(30).optional() }),
  flight_status: z.object({ airline_code: z.string().min(2).max(3), flight_no: z.string().min(1).max(5), date: Day }),
  pnr_status: z.object({ pnr: z.string().min(4).max(20) }),
  hold_booking: z.object({ fare_id: z.string().min(4).max(120), lead_name: z.string().min(1).max(80), travellers: z.int().min(1).max(30) }),
  confirm_booking: z.object({ hold_id: z.string().min(4).max(64), payment_ref: z.string().min(1).max(200) }),
  cancel_booking: z.object({ booking_ref: z.string().min(4).max(20) }),
} as const;
export type FakeIxigoToolName = keyof typeof FAKE_IXIGO_ARGS;

export interface FakeIxigoTool { name: FakeIxigoToolName; description: string; annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } }

export const FAKE_IXIGO_TOOLS: FakeIxigoTool[] = [
  { name: 'search_flights', description: 'Flights between two cities or airports on a date, with fares in paise. Read-only.', annotations: { readOnlyHint: true } },
  { name: 'search_trains', description: 'Trains between two stations or cities on a date, one fare per class, in paise. Read-only.', annotations: { readOnlyHint: true } },
  { name: 'search_buses', description: 'Buses between two cities on a date, with fares in paise. Read-only.', annotations: { readOnlyHint: true } },
  { name: 'search_stays', description: 'Villas and hotels in a place for check-in and check-out dates, with nightly and whole-stay prices in paise. Read-only.', annotations: { readOnlyHint: true } },
  { name: 'flight_status', description: 'Live status of a flight on a date: on schedule or late, with the expected departure. Read-only.', annotations: { readOnlyHint: true } },
  { name: 'pnr_status', description: 'The status of a booking by its reference. Read-only.', annotations: { readOnlyHint: true } },
  { name: 'hold_booking', description: 'Holds a fare for 15 minutes and says the amount to pay. Nothing is booked until confirm_booking.', annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'confirm_booking', description: 'Confirms a held fare once it is paid, and returns the booking.', annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'cancel_booking', description: 'Cancels a booking and refunds 80 percent.', annotations: { destructiveHint: true } },
];

function runTool(store: FakeIxigoStore, name: FakeIxigoToolName, a: Record<string, unknown>): unknown {
  switch (name) {
    case 'search_flights': return searchFlights(a as z.infer<typeof FAKE_IXIGO_ARGS.search_flights>);
    case 'search_trains': return searchTrains(a as z.infer<typeof FAKE_IXIGO_ARGS.search_trains>);
    case 'search_buses': return searchBuses(a as z.infer<typeof FAKE_IXIGO_ARGS.search_buses>);
    case 'search_stays': return searchStays(a as z.infer<typeof FAKE_IXIGO_ARGS.search_stays>);
    case 'flight_status': return store.flightStatus(a as z.infer<typeof FAKE_IXIGO_ARGS.flight_status>);
    case 'pnr_status': return store.pnr(a as z.infer<typeof FAKE_IXIGO_ARGS.pnr_status>);
    case 'hold_booking': return store.hold(a as z.infer<typeof FAKE_IXIGO_ARGS.hold_booking>);
    case 'confirm_booking': return store.confirm(a as z.infer<typeof FAKE_IXIGO_ARGS.confirm_booking>);
    case 'cancel_booking': return store.cancel(a as z.infer<typeof FAKE_IXIGO_ARGS.cancel_booking>);
  }
}

/** Runs one fake ixigo tool. A refusal is `{ error }` with isError, never a throw. */
export function callFakeIxigo(store: FakeIxigoStore, name: string, args: unknown): { value: unknown; isError: boolean } {
  if (!Object.hasOwn(FAKE_IXIGO_ARGS, name)) return { value: { error: 'unknown_tool' }, isError: true };
  const tool = name as FakeIxigoToolName;
  const parsed = FAKE_IXIGO_ARGS[tool].safeParse(args ?? {});
  if (!parsed.success) return { value: { error: 'invalid_arguments', detail: z.prettifyError(parsed.error) }, isError: true };
  const value = runTool(store, tool, parsed.data as Record<string, unknown>);
  const isError = typeof value === 'object' && value !== null && 'error' in value;
  return { value, isError };
}
