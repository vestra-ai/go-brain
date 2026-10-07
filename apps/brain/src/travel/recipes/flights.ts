/**
 * Flights on ixigo.com: the results page for one date, and its one search stream (all fares in one event).
 * displayFare is per person, taxes in, before coupons: for 4 adults on DEL to GOI, 6E 5341 showed 7,896, and ixigo's own
 * review page for those 4 travellers showed base ₹24,000 plus taxes ₹7,584, which is 4 × 7,896.
 */
import { z } from 'zod';
import { TravelError } from '../mcp-travel.js';
import type { TravelQuery } from '../travel.js';
import { airportCity, airportOf } from './places.js';
import {
  bodiesFor, clamp, ddmmyyyy, highlights, istAt, istOf, addDays, IXIGO, paise, pageScript, readBody, readRows, RECIPE_TTL_MS,
  type Capture, type Recipe, type RecipeOption,
} from './recipe.js';

export interface FlightSlots { from: string; to: string; date: string; adults: number }

const STREAM = '/flights/v2/search/stream';

const Leg = z.object({
  origin: z.string(),
  destination: z.string(),
  departureTime: z.string(),
  arrivalTime: z.string(),
  arrivingInDays: z.number().optional(),
  duration: z.object({ text: z.string(), time: z.number() }).optional(),
  stop: z.int().nonnegative(),
  headerTextWeb: z.string().min(1),
  subHeaderTextWeb: z.string(),
  airlineCode: z.string().optional(),
  departureTimeEpoch: z.number().optional(),
  arrivalTimeEpoch: z.number().optional(),
});
const Fare = z.object({
  flightKeys: z.string(),
  refundableType: z.string().optional(),
  fares: z.array(z.object({ fareDetails: z.object({ displayFare: z.number().positive() }), fareMetadata: z.array(z.object({ seatRemaining: z.number().optional() })).optional() })).min(1),
  flightDetails: z.array(Leg).min(1),
});
const Event = z.object({
  data: z.object({
    flightJourneys: z.array(z.object({ flightFare: z.array(Fare) })),
    airportDetails: z.record(z.string(), z.object({ city: z.string() })).optional(),
  }),
});

/** "6E5341" as "6E 5341". */
const spaced = (n: string): string => n.trim().replace(/^([A-Z0-9]{2})\s?(\d+)$/, '$1 $2');

/** "2h 35m" as 155. */
function minutesOf(text: string): number | undefined {
  const m = /^(\d+)h(?:\s*(\d+)m)?$/.exec(text.trim());
  return m ? Number(m[1]) * 60 + Number(m[2] ?? 0) : undefined;
}

const REFUNDABLE: Record<string, string> = { REFUNDABLE: 'yes', PARTIALLY_REFUNDABLE: 'partly', NON_REFUNDABLE: 'no' };

interface FlightRead {
  airline: string;
  numbers: string[];
  from: { code: string; city: string | null };
  to: { code: string; city: string | null };
  departAt: string;
  arriveAt: string;
  durationText?: string;
  durationMin?: number;
  stops: number;
  fareRupees: number;
  seatsLeft?: number;
  refundable?: string;
}

const placeName = (p: { code: string; city: string | null }): string => (p.city ? `${p.city} (${p.code})` : p.code);

function flightOption(f: FlightRead, sourceUrl: string): RecipeOption {
  const number = f.numbers[0] ?? '';
  return {
    kind: 'flight',
    title: `${f.airline} ${f.numbers.join(', ')}`,
    priceMinor: paise(f.fareRupees),
    currency: 'INR',
    priceNote: 'per person',
    journey: {
      mode: 'flight',
      origin: { name: placeName(f.from), code: f.from.code },
      destination: { name: placeName(f.to), code: f.to.code },
      depart_at: f.departAt,
      arrive_at: f.arriveAt,
      carrier_name: f.airline.slice(0, 60),
      ...(/^[A-Z0-9]{2}\s/.test(number) ? { carrier_code: number.slice(0, 2) } : {}),
      ...(number ? { number: number.slice(0, 20) } : {}),
      stops: f.stops,
    },
    highlights: highlights(
      f.stops === 0 ? 'Non-stop' : `${f.stops} stop${f.stops === 1 ? '' : 's'}`,
      f.durationText,
      f.seatsLeft !== undefined && f.seatsLeft <= 3 ? `${f.seatsLeft} seat${f.seatsLeft === 1 ? '' : 's'} left` : null,
    ),
    facts: {
      stops: f.stops,
      ...(f.durationMin !== undefined ? { duration_min: f.durationMin } : {}),
      ...(f.seatsLeft !== undefined ? { seats_left: f.seatsLeft } : {}),
      ...(f.refundable ? { refundable: f.refundable } : {}),
    },
    sourceUrl,
  };
}

/** Every SSE event's JSON in a stream body, in order. */
function events(body: string): string[] {
  return body.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter((l) => l.length > 0);
}

function extract(captures: Capture[], s: FlightSlots): RecipeOption[] {
  const bodies = bodiesFor(captures, STREAM);
  if (bodies.length === 0) throw new TravelError('refused', "ixigo's flight results page did not load its fares.");
  const url = flights.url(s);
  const out: RecipeOption[] = [];
  const seen = new Set<string>();
  for (const body of bodies) {
    for (const line of events(body)) {
      const ev = readBody(Event, line, 'the flight search');
      const cities = ev.data.airportDetails ?? {};
      for (const fare of ev.data.flightJourneys.flatMap((j) => j.flightFare)) {
        if (seen.has(fare.flightKeys)) continue;
        seen.add(fare.flightKeys);
        const leg = fare.flightDetails[0]!;
        const seats = fare.fares[0]!.fareMetadata?.[0]?.seatRemaining;
        out.push(flightOption({
          airline: leg.headerTextWeb,
          numbers: leg.subHeaderTextWeb.split(',').map(spaced).filter((n) => n.length > 0),
          from: { code: leg.origin, city: cities[leg.origin]?.city ?? airportCity(leg.origin) },
          to: { code: leg.destination, city: cities[leg.destination]?.city ?? airportCity(leg.destination) },
          departAt: leg.departureTimeEpoch ? istOf(leg.departureTimeEpoch) : istAt(s.date, leg.departureTime),
          arriveAt: leg.arrivalTimeEpoch ? istOf(leg.arrivalTimeEpoch) : istAt(addDays(s.date, leg.arrivingInDays ?? 0), leg.arrivalTime),
          ...(leg.duration ? { durationText: leg.duration.text, durationMin: leg.duration.time } : {}),
          stops: leg.stop,
          fareRupees: fare.fares[0]!.fareDetails.displayFare,
          ...(seats !== undefined ? { seatsLeft: seats } : {}),
          ...(fare.refundableType ? { refundable: REFUNDABLE[fare.refundableType] ?? fare.refundableType.toLowerCase() } : {}),
        }, url));
      }
    }
  }
  return out;
}

/**
 * Reads the flight cards from the page text: the airline, then the flight numbers, the times, airports, duration, stops
 * and the fare. It runs in the page, sent as its source, so it uses nothing outside itself.
 */
export function readFlightsPage(text: string): unknown[] {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    if (!/^[A-Z0-9]{2}\s?\d{1,4}(,\s*[A-Z0-9]{2}\s?\d{1,4})*$/.test(lines[i]!)) continue;
    const card = lines.slice(i + 1, i + 11);
    const times = card.filter((l) => /^\d{2}:\d{2}$/.test(l));
    const codes = card.filter((l) => /^[A-Z]{3}$/.test(l));
    const price = card.find((l) => /^₹[\d,]+$/.test(l));
    if (times.length < 2 || codes.length < 2 || !price) continue;
    const key = `${lines[i]} ${times[0]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      airline: lines[i - 1],
      numbers: lines[i],
      depart: times[0],
      from: codes[0],
      arrive: times[1],
      to: codes[1],
      duration: card.find((l) => /^\d+h(\s*\d+m)?$/.test(l)) ?? null,
      stops: card.find((l) => /^(non-stop|\d+ stops?)$/i.test(l)) ?? null,
      price: Number(price.slice(1).replace(/,/g, '')),
    });
  }
  return rows;
}

const Clock = z.string().regex(/^\d{2}:\d{2}$/);
const FlightRow = z.object({
  airline: z.string().min(1).max(60),
  numbers: z.string().min(2).max(60),
  depart: Clock,
  from: z.string().regex(/^[A-Z]{3}$/),
  arrive: Clock,
  to: z.string().regex(/^[A-Z]{3}$/),
  duration: z.string().max(20).nullable(),
  stops: z.string().max(20).nullable(),
  price: z.number().positive(),
});

function fromAgent(rows: unknown, s: FlightSlots): RecipeOption[] {
  const url = flights.url(s);
  return readRows(z.array(FlightRow), rows, 'flights').map((r) => {
    const stops = r.stops === null || /non-stop/i.test(r.stops) ? 0 : Number(/^(\d+)/.exec(r.stops)?.[1] ?? 0);
    const durationMin = r.duration ? minutesOf(r.duration) : undefined;
    return flightOption({
      airline: r.airline,
      numbers: r.numbers.split(',').map(spaced),
      from: { code: r.from, city: airportCity(r.from) },
      to: { code: r.to, city: airportCity(r.to) },
      departAt: istAt(s.date, r.depart),
      // The page shows clocks only: a flight landing at an earlier clock than it left lands the next day.
      arriveAt: istAt(r.arrive < r.depart ? addDays(s.date, 1) : s.date, r.arrive),
      ...(r.duration ? { durationText: r.duration } : {}),
      ...(durationMin !== undefined ? { durationMin } : {}),
      stops,
      fareRupees: r.price,
    }, url);
  });
}

/** ixigo's departure and arrival windows (p1-b's flights map), as the page's own filter shows them. */
const WINDOWS: Array<[name: string, from: string, to: string]> = [
  ['EARLY_MORNING', '00:00', '06:00'],
  ['MORNING', '06:00', '12:00'],
  ['AFTERNOON', '12:00', '18:00'],
  ['NIGHT', '18:00', '24:00'],
];

/** The windows a time range touches; null when there is no range. */
function windows(after: string | undefined, before: string | undefined): string | null {
  if (!after && !before) return null;
  const from = after ?? '00:00';
  const to = before ?? '24:00';
  return WINDOWS.filter(([, start, end]) => start < to && end > from).map(([name]) => name).join(',');
}

/** Who a results page is set for, read off its own link: "for 3 from Delhi". */
export function flyingFor(url: string): string | null {
  const page = new URL(url);
  const adults = Number(page.searchParams.get('adults'));
  const city = airportCity(page.searchParams.get('from') ?? '');
  return adults > 0 && city ? `for ${adults} from ${city}` : null;
}

/**
 * The results URL with what people asked for already set, in ixigo's own filter params (p1-b's flights map): non-stop,
 * the departure and arrival windows, and the price cap per person, with the cheapest first (the param ixigo's own
 * "Price / Low to High" sort writes). The page filters and sorts itself; nothing is clicked.
 */
export function withFlightFilters(url: string, q: TravelQuery): string {
  const params: string[] = [];
  if (q.mustHave?.includes('non_stop')) params.push('stops=0');
  const takeOff = windows(q.departAfter, q.departBefore);
  if (takeOff) params.push(`takeOff=${takeOff}`);
  const landing = windows(undefined, q.arriveBefore);
  if (landing) params.push(`landing=${landing}`);
  if (q.maxPriceMinor !== undefined) params.push(`price=0,${Math.floor(q.maxPriceMinor / 100)}`);
  params.push('sort_type=cheapest');
  return `${url}&${params.join('&')}`;
}

/**
 * How many members surely fly from somewhere else: their home city has another airport (Arjun, Bangalore, is not on a
 * flight from Delhi). A member with no home city, or one Go has no airport for, may fly from here, so counts as flying.
 */
function flyingElsewhere(airport: string, homes: string[] | undefined): number {
  return (homes ?? []).filter((home) => {
    try {
      return airportOf(home).code !== airport;
    } catch {
      return false;
    }
  }).length;
}

export const flights: Recipe<FlightSlots> = {
  id: 'ixigo.flights',
  kind: 'flights',
  slotsFrom(q: TravelQuery, trip) {
    if (!q.from || !q.to || !q.date) throw new TravelError('needs_more', 'A flight search needs where from, where to and the date.');
    const from = airportOf(q.from).code;
    // Nobody left (a search from a city no member lives in) asks for the whole group.
    const flying = trip.people - flyingElsewhere(from, trip.fromCities);
    return { from, to: airportOf(q.to).code, date: q.date, adults: clamp(q.guests ?? (flying > 0 ? flying : trip.people), 1, 9) };
  },
  url: (s) =>
    `${IXIGO}/search/result/flight?from=${s.from}&to=${s.to}&date=${ddmmyyyy(s.date)}&returnDate=&adults=${s.adults}&children=0&infants=0&class=e&source=Search%20Form`,
  capture: [{ match: STREAM, required: true, max_bytes: 2_000_000 }],
  fetchable: true,
  readyText: 'Flights Available',
  extract,
  agentExtractor: pageScript(readFlightsPage, 3),
  readPage: readFlightsPage,
  fromAgent,
  ttlMs: RECIPE_TTL_MS,
};
