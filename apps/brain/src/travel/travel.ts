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
  /** Flights: the day back, for a round trip (both ways on one ixigo page, as pairs). */
  returnDate: z.iso.date().optional(),
  area: z.string().min(2).max(60).optional(),
  checkIn: z.iso.date().optional(),
  checkOut: z.iso.date().optional(),
  guests: z.int().min(1).max(30).optional(),
  /** Flights: children (2 to 11) and infants (under 2) besides the adults (guests), when the ask says so. */
  children: z.int().min(0).max(8).optional(),
  infants: z.int().min(0).max(4).optional(),
  /** Flights: the cabin, as ixigo sells it (it has no First). */
  cabin: z.enum(['economy', 'premium_economy', 'business']).optional(),
  /** Flights: one of ixigo's special fares; ixigo then lists only the flights that sell it. */
  specialFare: z.enum(['student', 'senior_citizen', 'armed_forces', 'doctor']).optional(),
  departAfter: Clock.optional(),
  departBefore: Clock.optional(),
  arriveBefore: Clock.optional(),
  /** Why a time applies when this ask didn't say it: from the trip ("Rahul can leave Friday after 6 pm"). Said with it. */
  because: z.string().min(3).max(80).optional(),
  /** Per person for journeys, per night for stays (as ixigo prices them: a room, or a whole house). */
  maxPriceMinor: z.int().positive().optional(),
  /** Stays: each person's share of the whole stay at most ("under 8k a head"): its total over the head count it was priced for. */
  maxShareMinor: z.int().positive().optional(),
  /**
   * Stays: the group's decided budget for the stay, per person, in paise: ixigo's own price bands filter the read by it,
   * one band over kept (backend.ts). Never a guess: a decided budget, or the ask's own per-person cap.
   */
  budgetMinor: z.int().positive().optional(),
  /** Stays: how many of ixigo's pages of the list to read; two for "See more" past the first page (taps.ts). One when absent. */
  pages: z.int().min(1).max(2).optional(),
  mustHave: z.array(z.enum(MUST_HAVES)).max(5).optional(),
  /** Buses: a pickup or drop point the group named ("Majestic", "Mapusa"): a bus that doesn't stop there doesn't fit. */
  boardAt: z.string().min(2).max(60).optional(),
  dropAt: z.string().min(2).max(60).optional(),
  minRating: z.number().min(0).max(5).optional(),
  /** The site's own filters and sort for the ask, by their names on the site's own list (recipes/offers.ts). */
  siteFilters: z.array(z.string().min(1).max(80)).max(8).optional(),
  siteSort: z.string().min(1).max(80).optional(),
  /** Anything else the group asked for, in their words: the model picks it from the results. */
  wants: z.array(z.string().min(1).max(80)).max(8).optional(),
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
  /** The backend's photos of it, larger, the card's picture first (a stay's: up to seven from ixigo's list); a details sheet
   *  shows Go's re-hosted copies. */
  imageUrls?: string[];
  /** What the place has, in the backend's own words ("Free Wifi", "Swimming pool at the property"). */
  amenities?: string[];
  logoUrl?: string;
  rating?: number;
  highlights: string[];
  refundableUntil?: string;
  /** Short facts the filters and the model read: pool, beach_minutes, sleeps, seats_left, class_code. */
  facts: Record<string, string | number | boolean>;
  /** The option's own page on the site it came from; an options card carries an ixigo.com one (its option's url). */
  sourceUrl?: string;
}

export interface TravelSearch {
  results: TravelOption[];
  checkedAt: string;
  /** How many the backend found before the constraints were applied (set by the travel layer). */
  found?: number;
  /** When nothing fits: the options that miss the fewest constraints (at most three), and what each misses, in plain words. */
  nearest?: Array<{ option: TravelOption; misses: string[] }>;
  /** When nothing fits: the limits that, each alone, leave out every option, in plain words (filters.ts missedByAll). */
  missedByAll?: string[];
  /** The run that read it, when a backend runs one per search (ixigo_web): searches that shared a run share its id. */
  runId?: string;
  /** The results page it read on ixigo.com, where the whole list is (ixigo_web). */
  page?: string;
  /** ixigo's list came cut short: these are the first it sent (a long flights stream past what Bash keeps), not all of it. */
  cut?: true;
  /**
   * How many ixigo's list held in this read, before Go kept a half of it (North Goa of all of Goa's page): one full page
   * of stays says ixigo has more, for a card's "See more" (ixigo_web).
   */
  listed?: number;
  /** The page's own lines about the whole list, for the model (ixigo's Smart Lock for a route). */
  notes?: string[];
  /** Buses: the group's stay each bus's nearest drop was measured from, and whose it is ("Casa Anjuna, the stay you voted for"). */
  nearStay?: string;
  /**
   * The conditions ixigo was asked to filter on and did not: its filtered page caught nothing in time, so the list is the
   * same page without them (ixigo_web, backend.ts). The travel layer picks the stays that say them, or, when none does,
   * shows the list without them and says so; then these are the ones it left off.
   */
  unapplied?: string[];
  /**
   * What the site itself did with the ask's site filters and sort (ixigo_web): what it filtered on and sorted by, in words;
   * the names it didn't apply (not on its list, or its list not known before this read: listed false); and its list as
   * it is now known, in words, for the model.
   */
  site?: { filtered: string[]; sorted: string | null; unknown: string[]; wanted?: string[]; listed: boolean; offers: string | null; priced?: number | null; strictest?: string };
  /**
   * ixigo's own filters left off because together they left no stay (stays: the strictest first, then the rest): these
   * options are the nearest without them, and the line says so (tools.ts leftOffLead).
   */
  dropped?: string[];
  /** Not read now: ixigo's page didn't answer, and this is Go's earlier read of the same page, checked when it was (stays). */
  earlier?: boolean;
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
  /** Booked on Go's test rail only, nothing on ixigo (a stay from ixigo.com: travel/web-stays.ts): the receipt says so. */
  simulated?: true;
}

/** A place ixigo resolved (placeFor). */
export interface ResolvedPlace {
  /** Contract 1.1's Place: place_id "ixigo:<locationId>", lat/lng from ixigo, timezone from its country, photo_url from ixigo's guide. */
  place: Place;
  /** ixigo's type: a state (Goa), a city (Manali), or an area inside one (Candolim, Old Manali). */
  kind: 'state' | 'city' | 'area';
  /** The city and state it is in, by ixigo's own names: Old Manali is in ["Manali", "Himachal Pradesh"]; a state, []. */
  within: string[];
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
  /** Stays: the whole stay, which is the price its card, a vote and a payment carry (never priceMinor, a night's). */
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
  /** A try again Go promised the room (try-again.ts): a paced page goes through ixigo's quiet (engine.ts RunFor.retry). */
  retry?: boolean;
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
  offer(optionId: string): Promise<{
    offerId: string | null; title: string; priceMinor: number | null; currency: string | null; kind: 'flight' | 'train' | 'bus' | 'stay'; link: string | null;
    /** The check-in or departure day (YYYY-MM-DD) when Go knows it, and past when that day is before today in the trip's time zone. */
    day?: string | null; past?: true;
  } | null>;
  /**
   * A stay as its payment names it beside the amount ("Anjuna: 3 nights (₹12,800 a night)", cards.ts stayPayWords), from
   * the stay as its search saved it; null for anything else, or an option Go never showed.
   */
  payWords?(optionId: string): Promise<string | null>;
  /** The option's own name, place and area, for saving a stay or place a vote picked (composer/room-tools.ts). */
  placeOf?(optionId: string): Promise<OptionPlace | null>;
  /**
   * A place by the words for it, as ixigo's hotel box knows it; null when ixigo doesn't know it (or it is a hotel). The
   * trip's destination is only ever saved as its place (trips/save-trip.ts). Filled by the travel lane (p4, place-for.ts).
   */
  placeFor?(words: string, o: { tripId: string }): Promise<ResolvedPlace | null>;
  /** Booking is two steps so card details only ever travel between the vault and the rail. Composer and P5 only. */
  hold(offerId: string, lead: { name: string; personIds: string[] }): Promise<Hold>;
  /** Safe to repeat: the same hold confirmed twice gives the same answer. */
  confirm(holdId: string, paid: { approvalId: string; railRef: string }): Promise<Confirmed>;
  /**
   * Before a mandate (P5's set_mandate): what booking the option needs first, and its price now. A stay from ixigo.com
   * needs the trip's ixigo login: with none, the person is asked on the login card and `resume` waits on the login, so Go
   * carries on with it once the login is in (ok false, and the note for the model). priceMinor is ixigo's price for it
   * now, read as the same number the vote showed (the whole stay from the same search's list), or null when that can't
   * be read: then nothing is said about the price moving. Absent: nothing is needed first.
   */
  prepare?(optionId: string, o: { tripId: string; what: string; resume: Record<string, unknown> }): Promise<{ ok: true; priceMinor: number | null } | { ok: false; note: string }>;
  /** Whether Go books each person's own flight on this trip (BOOKING, booking/flight-booking.ts bookingOnFor). */
  booksFlights?(tripId: string): Promise<boolean>;
  /** True while searches come from the fake ixigo (TRAVEL_MODE is fake, or ixigo is not set up): the listings are simulated. */
  simulated?(): boolean;
  /** Present while the fake ixigo runs: makes a flight late, for the demo's labelled "simulated" watch. */
  simulate?: { setFlightDelay(carrierCode: string, number: string, date: string, minutes: number): void };
}

/** What Travel.offer answers for an option Go showed. */
export type OfferRef = NonNullable<Awaited<ReturnType<Travel['offer']>>>;
