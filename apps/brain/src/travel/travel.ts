/**
 * Go's travel layer: one interface for search, status and booking, whatever answers behind it (ixigo's MCP
 * server, or the fake ixigo). Money is integer paise. Times keep their local offset, as the place uses them.
 */
import { z } from 'zod';
import type { Booking, Journey, Place } from '@go/contract';
import type { OptionPlace } from './results.js';

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
  /**
   * "<backend>:<the backend's own id>", e.g. "fake:fl-DEL-GOI-20261106-6E2134". hold() routes on the prefix. Absent when Go
   * cannot book the option: ixigo.com's own results (TRAVEL_MODE ixigo_web) are booked on ixigo, from sourceUrl.
   */
  offerId?: string;
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
  /** The option's own page on the site it came from; an options card opens an ixigo.com one ("See on ixigo"). */
  sourceUrl?: string;
}

export interface TravelSearch {
  results: TravelOption[];
  checkedAt: string;
  /** How many the backend found before the constraints were applied (set by the travel layer). */
  found?: number;
  /** When nothing fits: the option that misses the fewest constraints, and what it misses, in plain words. */
  closest?: { option: TravelOption; misses: string[] };
  /** The run that read it, when a backend runs one per search (ixigo_web): searches that shared a run share its id. */
  runId?: string;
}

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
  /** The option's own page, when it has one. */
  sourceUrl: string | null;
}

/**
 * Who a search is for. tripId: the trip whose computer runs it. messageId: the message whose early start ran it. turnId:
 * the composer turn whose search tool ran it. The last two say whose live card it is (ixigo_web).
 */
export interface SearchFor {
  tripId?: string;
  messageId?: string;
  turnId?: string;
}

/** What answers behind the layer: the fake ixigo, ixigo's MCP server, or ixigo.com itself through the recipes. */
export interface TravelBackend {
  /** tripId: the trip whose computer runs the search, for a backend that searches in the trip's browser (ixigo_web). */
  search(kind: TravelKind, q: TravelQuery, o?: SearchFor): Promise<TravelSearch>;
  /**
   * How much longer a search tool may wait for this search before it goes on and the options come when it finishes; null
   * (or no method) waits for it.
   */
  waitMs?(kind: TravelKind, q: TravelQuery, o?: { tripId?: string }): Promise<number | null>;
  status(q: StatusQuery): Promise<StatusResult>;
  hold(offerId: string, lead: { name: string; personIds: string[] }): Promise<Hold>;
  confirm(holdId: string, paid: { approvalId: string; railRef: string }): Promise<Confirmed>;
}

/** brain.travel: the master plan's methods (search, status, offer, hold, confirm), plus the demo's flight-delay switch. */
export interface Travel {
  /** Refuses (TravelError past_date) a check-in or departure before today in the trip's time zone. */
  search(kind: TravelKind, q: TravelQuery, o?: SearchFor): Promise<TravelSearch>;
  /** How much longer to wait for this search inline (TravelBackend.waitMs); null waits for it. */
  waitMs?(kind: TravelKind, q: TravelQuery, o?: { tripId?: string }): Promise<number | null>;
  status(q: StatusQuery): Promise<StatusResult>;
  /**
   * The offer behind an options card's option_id (which is also a vote option's option_ref); offerId null when the option
   * came from a job's web browsing (P5 refuses to book those). priceMinor is what a vote and a payment use: the whole stay
   * for a stay, the fare per person for a journey. Null when Go never showed that option.
   */
  offer(optionId: string): Promise<{ offerId: string | null; title: string; priceMinor: number | null; currency: string | null; kind: 'flight' | 'train' | 'bus' | 'stay'; link: string | null } | null>;
  /** The option's own name, place and area, for saving a stay or place a vote picked (composer/room-tools.ts). */
  placeOf?(optionId: string): Promise<OptionPlace | null>;
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
