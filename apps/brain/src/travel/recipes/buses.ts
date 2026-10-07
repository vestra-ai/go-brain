/**
 * Buses on ixigo.com (p4's B1): the results page for one date and its one services call, every bus in it. A price is
 * the lowest seat fare, after the offer ixigo applies on its own ("₹3000, From ₹2700" on the card is 2,700).
 */
import { z } from 'zod';
import { TravelError } from '../mcp-travel.js';
import type { TravelQuery } from '../travel.js';
import { busCityOf, type BusCity } from './places.js';
import {
  bodiesFor, highlights, hoursMinutes, istAt, istOf, IXIGO, paise, pageScript, readBody, readRows, RECIPE_TTL_MS,
  type Capture, type Recipe, type RecipeOption,
} from './recipe.js';

export interface BusSlots { from: BusCity; to: BusCity; date: string }

// The page first loads /buslist/v3/services/meta/{n}: the "$" keeps the list itself.
const SERVICES = '/buslist/v3/services$';

const Service = z.object({
  travelerAgentName: z.string().min(1),
  busTypeName: z.string().optional(),
  serviceId: z.union([z.number(), z.string()]).optional(),
  rating: z.number().optional(),
  noOfRatings: z.number().optional(),
  fares: z.object({ fare: z.number().positive(), offerPrice: z.number().positive().nullish(), fareList: z.array(z.number()).optional() }),
  timings: z.object({ startTimeDateFormat: z.iso.datetime({ offset: true }), travelTime: z.string().optional(), arriveTimestamp: z.number().optional() }),
  seatStats: z.object({ availableSeats: z.number() }).optional(),
});
const Services = z.object({ services: z.array(Service) });

/** "16:25:00" as 985. */
const travelMinutes = (t: string | undefined): number | undefined => {
  const m = t ? /^(\d+):(\d{2})/.exec(t) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
};

interface BusRead {
  operator: string;
  type?: string;
  departAt: string;
  arriveAt: string;
  durationMin?: number;
  fareRupees: number;
  seatsLeft?: number;
  rating?: number;
  reviews?: number;
}

function busOption(b: BusRead, s: BusSlots): RecipeOption {
  return {
    kind: 'bus',
    title: b.operator,
    priceMinor: paise(b.fareRupees),
    currency: 'INR',
    priceNote: 'per seat, from',
    journey: {
      mode: 'bus',
      origin: { name: s.from.name },
      destination: { name: s.to.name },
      depart_at: b.departAt,
      arrive_at: b.arriveAt,
      carrier_name: b.operator.slice(0, 60),
    },
    ...(b.rating !== undefined && (b.reviews ?? 1) > 0 ? { rating: b.rating } : {}),
    highlights: highlights(
      b.type,
      b.durationMin !== undefined ? hoursMinutes(b.durationMin) : null,
      b.seatsLeft !== undefined && b.seatsLeft <= 5 ? `${b.seatsLeft} seat${b.seatsLeft === 1 ? '' : 's'} left` : null,
    ),
    facts: {
      ...(b.type ? { bus_type: b.type } : {}),
      ...(b.seatsLeft !== undefined ? { seats_left: b.seatsLeft } : {}),
      ...(b.durationMin !== undefined ? { duration_min: b.durationMin } : {}),
      ...(b.reviews !== undefined ? { reviews: b.reviews } : {}),
    },
    // ixigo has no page per bus: its "Select Seats" opens on the results.
    sourceUrl: buses.url(s),
  };
}

function extract(captures: Capture[], s: BusSlots): RecipeOption[] {
  const body = bodiesFor(captures, SERVICES)[0];
  if (body === undefined) throw new TravelError('refused', "ixigo's bus results page did not load its buses.");
  return readBody(Services, body, 'the bus search').services.flatMap((v) => {
    const durationMin = travelMinutes(v.timings.travelTime);
    // arriveTimestamp is India's clock written as if it were UTC (5 h 30 m late in all 71 buses mapped), so the arrival
    // is the departure plus the journey time, and that clock only when the journey time is missing.
    const arriveAt = durationMin !== undefined
      ? istOf(Date.parse(v.timings.startTimeDateFormat) + durationMin * 60_000)
      : v.timings.arriveTimestamp
        ? `${new Date(v.timings.arriveTimestamp * 1000).toISOString().slice(0, 19)}+05:30`
        : null;
    if (arriveAt === null) return [];
    return [busOption({
      operator: v.travelerAgentName.trim(),
      ...(v.busTypeName ? { type: v.busTypeName } : {}),
      departAt: v.timings.startTimeDateFormat,
      arriveAt,
      ...(durationMin !== undefined ? { durationMin } : {}),
      fareRupees: v.fares.offerPrice ?? v.fares.fare,
      ...(v.seatStats ? { seatsLeft: v.seatStats.availableSeats } : {}),
      ...(v.rating !== undefined ? { rating: v.rating } : {}),
      ...(v.noOfRatings !== undefined ? { reviews: v.noOfRatings } : {}),
    }, s)];
  });
}

/**
 * Reads the bus cards from the page text: the operator, the bus type, the departure time and city, the journey time
 * ("16h.25m"), the arrival time and city, then the rating, the "From" price and the seats left. It runs in the page,
 * sent as its source, so it uses nothing outside itself.
 */
export function readBusesPage(text: string): unknown[] {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 4; i < lines.length - 2; i++) {
    const took = /^(\d{1,2})h(?:\.(\d{1,2})m)?$/.exec(lines[i]!);
    if (!took || !/^\d{2}:\d{2}$/.test(lines[i - 2]!) || !/^\d{2}:\d{2}$/.test(lines[i + 1]!)) continue;
    let end = i + 3;
    while (end < lines.length && !/^Select Seats$/i.test(lines[end]!) && !/^\d{1,2}h(\.\d{1,2}m)?$/.test(lines[end]!)) end++;
    if (end >= lines.length || !/^Select Seats$/i.test(lines[end]!)) continue;
    const card = lines.slice(i + 3, end);
    const from = card.lastIndexOf('From');
    const price = from >= 0 ? /^₹\s?([\d,]+)$/.exec(card[from + 1] ?? '') : null;
    if (!price) continue;
    const rating = card.findIndex((l) => /^\d\.\d$/.test(l));
    const seats = /^(\d+) Seats? Left$/i.exec(lines[end + 1] ?? '');
    rows.push({
      // "VRL TravelsAD": the card's ad tag runs into the name.
      operator: lines[i - 4]!.replace(/(?<=[a-z])AD$/, '').slice(0, 80),
      type: lines[i - 3]!.slice(0, 60),
      depart: lines[i - 2],
      arrive: lines[i + 1],
      duration_min: Number(took[1]) * 60 + Number(took[2] ?? 0),
      price: Number(price[1]!.replace(/,/g, '')),
      rating: rating >= 0 ? Number(card[rating]) : null,
      seats_left: seats ? Number(seats[1]) : null,
    });
  }
  return rows;
}

const Clock = z.string().regex(/^\d{2}:\d{2}$/);
const BusRow = z.object({
  operator: z.string().min(1).max(80),
  type: z.string().max(60),
  depart: Clock,
  arrive: Clock,
  duration_min: z.int().positive().max(3 * 1440),
  price: z.number().positive(),
  rating: z.number().min(0).max(5).nullable(),
  seats_left: z.int().nonnegative().nullable(),
});

function fromAgent(rows: unknown, s: BusSlots): RecipeOption[] {
  return readRows(z.array(BusRow), rows, 'buses').map((r) => {
    const departAt = istAt(s.date, r.depart);
    const arriveAt = istOf(Date.parse(departAt) + r.duration_min * 60_000);
    // The arrival clock the page shows must match the journey time; when it doesn't, the row was misread.
    if (arriveAt.slice(11, 16) !== r.arrive) throw new TravelError('refused', `A bus read from ixigo's page arrives at ${r.arrive}, not ${arriveAt.slice(11, 16)} as its journey time says.`);
    return busOption({
      operator: r.operator,
      type: r.type,
      departAt,
      arriveAt,
      durationMin: r.duration_min,
      fareRupees: r.price,
      ...(r.seats_left !== null ? { seatsLeft: r.seats_left } : {}),
      ...(r.rating !== null ? { rating: r.rating } : {}),
    }, s);
  });
}

/** "2026-11-06" as ixigo's bus URLs write it, "06-11-2026". */
const dashed = (date: string): string => `${date.slice(8, 10)}-${date.slice(5, 7)}-${date.slice(0, 4)}`;

export const buses: Recipe<BusSlots> = {
  id: 'ixigo.buses',
  kind: 'buses',
  slotsFrom(q: TravelQuery) {
    if (!q.from || !q.to || !q.date) throw new TravelError('needs_more', 'A bus search needs where from, where to and the date.');
    return { from: busCityOf(q.from), to: busCityOf(q.to), date: q.date };
  },
  url: (s) => `${IXIGO}/buses/bus_search/${encodeURIComponent(s.from.name)}/${s.from.id}/${encodeURIComponent(s.to.name)}/${s.to.id}/${dashed(s.date)}/O`,
  capture: [{ match: SERVICES, required: true }],
  // The bus list loads only in a tab Chrome draws (p5's staging drill): the browser fetch's tab never gets it.
  fetchable: false,
  readyText: 'Select Seats',
  extract,
  agentExtractor: pageScript(readBusesPage, 3),
  readPage: readBusesPage,
  fromAgent,
  ttlMs: RECIPE_TTL_MS,
};
