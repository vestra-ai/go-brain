/**
 * Everything Go knows about ixigo's tools, in one table: each tool's name, how Go's query becomes its arguments,
 * and how its answer becomes Go's types. DEFAULT_IXIGO_MAP is the fake ixigo's. IXIGO_MAP is what IxigoTravel uses:
 * the fake's until ixigo shares its tool list (P4 Task 23 says what to fill in).
 */
import { z } from 'zod';
import type { Journey } from '@go/contract';
import type { Confirmed, StatusQuery, StatusResult, TravelOption, TravelQuery } from './travel.js';

export type MappedOption = Omit<TravelOption, 'offerId'> & { backendId: string };
export interface SearchMap {
  tool: string;
  /** Null when the query lacks what this search needs. */
  args(q: TravelQuery): Record<string, unknown> | null;
  results(data: unknown): MappedOption[];
}
export interface HoldMapped {
  backendHoldId: string; amountMinor: number; currency: string; merchant: string; expiresAt: string; paymentToken?: string;
  /** Until when the booking is free to cancel, when the answer says so. */
  refundableUntil?: string;
}
export interface IxigoMap {
  /** Flights and stays always; trains and buses once the stretch Task 8b maps them. A kind with no map is refused plainly. */
  search: { flights: SearchMap; stays: SearchMap; trains?: SearchMap; buses?: SearchMap };
  flightStatus: { tool: string; args(q: Extract<StatusQuery, { kind: 'flight' }>): Record<string, unknown>; result(data: unknown, checkedAt: string): StatusResult };
  pnrStatus: { tool: string; args(q: Extract<StatusQuery, { kind: 'pnr' }>): Record<string, unknown>; result(data: unknown, checkedAt: string): StatusResult };
  hold: { tool: string; args(backendId: string, lead: { name: string; travellers: number }): Record<string, unknown>; result(data: unknown): HoldMapped };
  confirm: { tool: string; args(backendHoldId: string, paid: { approvalId: string; railRef: string }): Record<string, unknown>; result(data: unknown): Confirmed };
  /**
   * The tool that answers the booking already made for a hold (null when there is none). When it is set, a confirm for a
   * hold this process has not confirmed looks there first, so a confirm repeated after a restart never books twice.
   * The fake leaves it out: its confirm_booking answers the same booking for a hold it already confirmed.
   */
  bookingForHold?: { tool: string; args(backendHoldId: string): Record<string, unknown>; result(data: unknown): Confirmed | null };
}

// ── the fake ixigo's raw shapes ──────────────────────────────────────────────

const RawFlight = z.object({
  fare_id: z.string(), airline: z.string(), airline_code: z.string(), flight_no: z.string(), from_code: z.string(), from_city: z.string(),
  to_code: z.string(), to_city: z.string(), depart_at: z.string(), arrive_at: z.string(), duration_min: z.number(),
  stops: z.int().nonnegative(), fare_paise: z.int().nonnegative(), refundable_until: z.string().nullable(), seats_left: z.int(),
});
const RawStay = z.object({
  stay_id: z.string(), name: z.string(), area: z.string(), region: z.string(), address: z.string(), lat: z.number(), lng: z.number(),
  image_url: z.string(), rating: z.number(), reviews: z.int(), sleeps: z.int(), bedrooms: z.int(), private_pool: z.boolean(),
  beach_minutes: z.number(), breakfast: z.boolean(), price_per_night_paise: z.int().nonnegative(), nights: z.int(),
  total_paise: z.int().nonnegative(), free_cancellation_until: z.string().nullable(),
});
const RawStatus = z.object({
  flight: z.string(), status: z.enum(['scheduled', 'delayed', 'cancelled', 'departed', 'landed']), scheduled_departure: z.string(),
  estimated_departure: z.string(), delay_min: z.number(),
});
const RawPnr = z.object({ pnr: z.string(), status: z.enum(['confirmed', 'waitlisted', 'cancelled', 'not_found']), detail: z.string() });
const RawHold = z.object({
  hold_id: z.string(), amount_paise: z.int().positive(), currency: z.string(), merchant: z.string(), expires_at: z.string(), payment_token: z.string().optional(),
  refundable_until: z.string().nullable().optional(),
});
const RawJourney = z.object({
  mode: z.enum(['flight', 'train', 'bus']), from_name: z.string(), from_code: z.string().nullable(), to_name: z.string(), to_code: z.string().nullable(),
  depart_at: z.string(), arrive_at: z.string(), carrier: z.string(), carrier_code: z.string().nullable(), number: z.string().nullable(),
});
const RawBooking = z.object({
  booking_ref: z.string(), status: z.enum(['confirmed', 'cancelled']), kind: z.enum(['flight', 'train', 'bus', 'stay']), title: z.string(),
  vendor: z.string(), amount_paise: z.int(), starts_at: z.string(), ends_at: z.string(), refundable_until: z.string().nullable(),
  image_url: z.string().nullable(), place: z.object({ name: z.string(), address: z.string(), lat: z.number(), lng: z.number() }).nullable(),
  journey: RawJourney.nullable(),
});

// ── small helpers ────────────────────────────────────────────────────────────

/** "2 h 35 m". */
export function hoursMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m === 0 ? `${h} h` : `${h} h ${m} m`;
}

const highlights = (...items: Array<string | null>): string[] => items.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 4);

function journeyOf(j: z.infer<typeof RawJourney>): Journey {
  return {
    mode: j.mode,
    origin: { name: j.from_name, ...(j.from_code ? { code: j.from_code } : {}) },
    destination: { name: j.to_name, ...(j.to_code ? { code: j.to_code } : {}) },
    depart_at: j.depart_at,
    arrive_at: j.arrive_at,
    carrier_name: j.carrier,
    ...(j.carrier_code ? { carrier_code: j.carrier_code } : {}),
    ...(j.number ? { number: j.number } : {}),
  };
}

function flightOption(f: z.infer<typeof RawFlight>): MappedOption {
  return {
    backendId: f.fare_id,
    kind: 'flight',
    title: `${f.airline} ${f.airline_code} ${f.flight_no}`,
    priceMinor: f.fare_paise,
    currency: 'INR',
    priceNote: 'per person',
    journey: {
      mode: 'flight',
      origin: { name: f.from_city, code: f.from_code },
      destination: { name: f.to_city, code: f.to_code },
      depart_at: f.depart_at,
      arrive_at: f.arrive_at,
      carrier_name: f.airline,
      carrier_code: f.airline_code,
      number: `${f.airline_code} ${f.flight_no}`,
      stops: f.stops,
    },
    highlights: highlights(f.stops === 0 ? 'Non-stop' : `${f.stops} stop`, hoursMinutes(f.duration_min), f.refundable_until ? 'Free cancellation' : null, f.seats_left <= 3 ? `${f.seats_left} seats left` : null),
    ...(f.refundable_until ? { refundableUntil: f.refundable_until } : {}),
    facts: { seats_left: f.seats_left, duration_min: f.duration_min, stops: f.stops },
  };
}

function stayOption(s: z.infer<typeof RawStay>): MappedOption {
  return {
    backendId: s.stay_id,
    kind: 'stay',
    title: s.name,
    priceMinor: s.price_per_night_paise,
    totalMinor: s.total_paise,
    currency: 'INR',
    priceNote: 'per night',
    place: { name: s.name, address: s.address, lat: s.lat, lng: s.lng },
    imageUrl: s.image_url,
    rating: s.rating,
    highlights: highlights(s.private_pool ? 'Private pool' : null, `${s.beach_minutes} min to the beach`, `Sleeps ${s.sleeps}`, s.breakfast ? 'Breakfast' : null, s.free_cancellation_until ? 'Free cancellation' : null),
    ...(s.free_cancellation_until ? { refundableUntil: s.free_cancellation_until } : {}),
    facts: { pool: s.private_pool, beach_minutes: s.beach_minutes, sleeps: s.sleeps, bedrooms: s.bedrooms, breakfast: s.breakfast, nights: s.nights, area: s.area, reviews: s.reviews },
  };
}

/** A booking answer as Go's Confirmed. Exported so ixigo's own map (Task 23) can reuse it for bookingForHold. */
export function confirmedOf(data: unknown): Confirmed {
  const b = RawBooking.parse(data);
  return {
    ref: b.booking_ref,
    vendor: b.vendor,
    title: b.title,
    kind: b.kind,
    startsAt: b.starts_at,
    endsAt: b.ends_at,
    ...(b.refundable_until ? { refundableUntil: b.refundable_until } : {}),
    ...(b.image_url ? { imageUrl: b.image_url } : {}),
    ...(b.place ? { place: { name: b.place.name, address: b.place.address, lat: b.place.lat, lng: b.place.lng } } : {}),
    ...(b.journey ? { journey: journeyOf(b.journey) } : {}),
  };
}

export const DEFAULT_IXIGO_MAP: IxigoMap = {
  search: {
    flights: {
      tool: 'search_flights',
      args: (q) => (q.from && q.to && q.date ? { origin: q.from, destination: q.to, date: q.date, ...(q.guests ? { adults: Math.min(q.guests, 9) } : {}) } : null),
      results: (data) => z.object({ flights: z.array(RawFlight) }).parse(data).flights.map(flightOption),
    },
    stays: {
      tool: 'search_stays',
      args: (q) => {
        const where = q.area ?? q.to;
        return where && q.checkIn && q.checkOut ? { location: where, check_in: q.checkIn, check_out: q.checkOut, ...(q.guests ? { guests: q.guests } : {}) } : null;
      },
      results: (data) => z.object({ stays: z.array(RawStay) }).parse(data).stays.map(stayOption),
    },
  },
  flightStatus: {
    tool: 'flight_status',
    args: (q) => ({ airline_code: q.carrierCode, flight_no: q.number, date: q.date }),
    result: (data, checkedAt) => {
      const s = RawStatus.parse(data);
      return { kind: 'flight', state: s.status, scheduledDepartAt: s.scheduled_departure, expectedDepartAt: s.estimated_departure, delayMinutes: s.delay_min, checkedAt };
    },
  },
  pnrStatus: {
    tool: 'pnr_status',
    args: (q) => ({ pnr: q.pnr }),
    result: (data, checkedAt) => {
      const p = RawPnr.parse(data);
      return { kind: 'pnr', state: p.status, detail: p.detail, checkedAt };
    },
  },
  hold: {
    tool: 'hold_booking',
    args: (backendId, lead) => ({ fare_id: backendId, lead_name: lead.name, travellers: lead.travellers }),
    result: (data) => {
      const h = RawHold.parse(data);
      return {
        backendHoldId: h.hold_id, amountMinor: h.amount_paise, currency: h.currency, merchant: h.merchant, expiresAt: h.expires_at,
        ...(h.payment_token ? { paymentToken: h.payment_token } : {}),
        ...(h.refundable_until ? { refundableUntil: h.refundable_until } : {}),
      };
    },
  },
  confirm: {
    tool: 'confirm_booking',
    args: (backendHoldId, paid) => ({ hold_id: backendHoldId, payment_ref: paid.railRef }),
    result: confirmedOf,
  },
};

/** What IxigoTravel uses. The fake's map until ixigo's real tool list is mapped (P4 Task 23). */
export const IXIGO_MAP: IxigoMap = DEFAULT_IXIGO_MAP;
