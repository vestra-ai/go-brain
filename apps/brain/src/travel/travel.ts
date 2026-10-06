/**
 * Go's travel layer: one interface for search, status and booking, whatever answers behind it (ixigo's MCP
 * server, or the fake ixigo). Money is integer paise. Times keep their local offset, as the place uses them.
 */
import { z } from 'zod';
import type { Booking, Journey, Place } from '@go/contract';

export const TravelKind = z.enum(['flights', 'trains', 'buses', 'stays']);
export type TravelKind = z.infer<typeof TravelKind>;

export const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM, like 18:00.');
export const MUST_HAVES = ['pool', 'beach', 'breakfast', 'free_cancellation', 'non_stop'] as const;

/** One search. The constraints (times, price, must-haves, rating) are applied in code after the search. */
export const TravelQuery = z.object({
  from: z.string().min(2).max(60).optional(),
  to: z.string().min(2).max(60).optional(),
  date: z.iso.date().optional(),
  area: z.string().min(2).max(60).optional(),
  checkIn: z.iso.date().optional(),
  checkOut: z.iso.date().optional(),
  guests: z.int().min(1).max(30).optional(),
  departAfter: Clock.optional(),
  departBefore: Clock.optional(),
  arriveBefore: Clock.optional(),
  /** Per person for journeys, per night for stays. */
  maxPriceMinor: z.int().positive().optional(),
  mustHave: z.array(z.enum(MUST_HAVES)).max(5).optional(),
  minRating: z.number().min(0).max(5).optional(),
});
export type TravelQuery = z.infer<typeof TravelQuery>;

export type TravelOptionKind = 'flight' | 'train' | 'bus' | 'stay';

export interface TravelOption {
  /** "<backend>:<the backend's own id>", e.g. "fake:fl-DEL-GOI-20261106-6E2134". hold() routes on the prefix. */
  offerId: string;
  kind: TravelOptionKind;
  title: string;
  subtitle?: string;
  priceMinor: number;
  currency: string;
  /** What the price covers: "per person", "per night". */
  priceNote: string;
  /** Stays: the whole stay for the nights searched. */
  totalMinor?: number;
  journey?: Journey;
  place?: Place;
  /** The backend's image; cards always show Go's re-hosted copy. */
  imageUrl?: string;
  logoUrl?: string;
  rating?: number;
  highlights: string[];
  refundableUntil?: string;
  /** Short facts the filters and the model read: pool, beach_minutes, sleeps, seats_left, class_code. */
  facts: Record<string, string | number | boolean>;
}

export interface TravelSearch { results: TravelOption[]; checkedAt: string }

export type StatusQuery =
  | { kind: 'flight'; carrierCode: string; number: string; date: string }
  | { kind: 'pnr'; pnr: string };

export type StatusResult =
  | {
      kind: 'flight';
      state: 'scheduled' | 'delayed' | 'cancelled' | 'departed' | 'landed';
      scheduledDepartAt: string;
      expectedDepartAt: string;
      delayMinutes: number;
      checkedAt: string;
    }
  | { kind: 'pnr'; state: 'confirmed' | 'waitlisted' | 'cancelled' | 'not_found'; detail: string; checkedAt: string };

export interface Hold {
  holdId: string;
  amountMinor: number;
  currency: string;
  merchant: string;
  expiresAt: string;
  /** Until when the booking is free to cancel, when the fare is refundable. P5 refuses a refundable-only mandate without it. */
  refundableUntil?: string;
  payment: { kind: 'fake' } | { kind: 'stripe_test' } | { kind: 'ixigo'; token: string };
}

export interface Confirmed {
  ref: string;
  vendor: string;
  title: string;
  kind: Booking['kind'];
  startsAt?: string;
  endsAt?: string;
  refundableUntil?: string;
  imageUrl?: string;
  place?: Place;
  journey?: Journey;
}

/** One option Go showed on an options card, kept so a tap, a vote or a payment can name it later. */
export interface StoredOffer {
  optionId: string;
  tripId: string;
  cardId: string;
  resultsId: string;
  /** Its number on the card, from 1. */
  n: number;
  /** Null when the option came from a job's web browsing: it can be shown and voted on, not booked through Go. */
  offerId: string | null;
  kind: string;
  title: string;
  priceMinor: number | null;
  /** Stays: the whole stay, which is what a vote and a payment use. */
  totalMinor: number | null;
  currency: string | null;
  priceNote: string | null;
  checkedAt: string;
  /** The option's own place and area (a stay's), as the search gave them. */
  place?: { name: string; address: string | null } | null;
  area?: string | null;
}

/** What answers behind the layer: the fake ixigo or ixigo's MCP server. */
export interface TravelBackend {
  search(kind: TravelKind, q: TravelQuery): Promise<TravelSearch>;
  status(q: StatusQuery): Promise<StatusResult>;
  hold(offerId: string, lead: { name: string; personIds: string[] }): Promise<Hold>;
  confirm(holdId: string, paid: { approvalId: string; railRef: string }): Promise<Confirmed>;
}

/** brain.travel: the master plan's methods (search, status, offer, hold, confirm), plus the demo's flight-delay switch. */
export interface Travel {
  /** Refuses (TravelError past_date) a check-in or departure before today in the trip's time zone. */
  search(kind: TravelKind, q: TravelQuery, o?: { tripId?: string }): Promise<TravelSearch>;
  status(q: StatusQuery): Promise<StatusResult>;
  /**
   * The offer behind an options card's option_id (which is also a vote option's option_ref); offerId null when the option
   * came from a job's web browsing (P5 refuses to book those). priceMinor is what a vote and a payment use: the whole stay
   * for a stay, the fare per person for a journey. Null when Go never showed that option.
   */
  offer(optionId: string): Promise<{
    offerId: string | null; title: string; priceMinor: number | null; currency: string | null; kind: 'flight' | 'train' | 'bus' | 'stay'; link: string | null;
    /** The option's own place and area (a stay's), as the search gave them: what Go saves when a vote picked it. */
    place?: { name: string; address: string | null } | null;
    area?: string | null;
  } | null>;
  /** Booking is two steps so card details only ever travel between the vault and the rail. Composer and P5 only. */
  hold(offerId: string, lead: { name: string; personIds: string[] }): Promise<Hold>;
  /** Safe to repeat: the same hold confirmed twice gives the same answer. */
  confirm(holdId: string, paid: { approvalId: string; railRef: string }): Promise<Confirmed>;
  /** True while searches come from the fake ixigo (TRAVEL_MODE is fake, or ixigo is not set up): the listings are simulated. */
  simulated?(): boolean;
  /** Present while the fake ixigo runs: makes a flight late, for the demo's labelled "simulated" watch. */
  simulate?: { setFlightDelay(carrierCode: string, number: string, date: string, minutes: number): void };
}

/** What Travel.offer answers for an option Go showed. */
export type OfferRef = NonNullable<Awaited<ReturnType<Travel['offer']>>>;
