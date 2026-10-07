/**
 * Stays on ixigo.com: the hotel results page and its search call. A price is the room's nightly fare plus taxes and
 * fees, per night and per room, as ixigo shows it; the whole stay is that times the nights and the rooms. ixigo filters
 * the search itself, in the URL (p1-a's hotels map): to the area asked for, and on the must-haves it has codes for, so
 * the first page holds the right stays. The recipe takes the pages that came back.
 */
import { z } from 'zod';
import { TravelError } from '../mcp-travel.js';
import type { MUST_HAVES, TravelQuery } from '../travel.js';
import { goaHalfOf, stayPlaceOf, type GoaHalf, type StayLocation } from './places.js';
import {
  bodiesFor, clamp, ddmmyyyy, highlights, IXIGO, nightsBetween, paise, pageScript, readBody, readRows, RECIPE_TTL_MS,
  type Capture, type Recipe, type RecipeOption, type Step,
} from './recipe.js';

export interface StaySlots {
  location: StayLocation;
  checkIn: string;
  checkOut: string;
  adults: number;
  rooms: number;
  /** ixigo's filter codes, sorted: the areas, and the must-haves ixigo filters on. */
  filters: string[];
  /** The half of Goa the stays must be in: a stay ixigo gives from the other half is dropped. */
  half: GoaHalf | null;
  /** All of Goa, or a half of it: hundreds of stays, so the fetch takes two pages, not the top strip of one. */
  wide: boolean;
}

const SEARCH = '/accommodation-search/api/v3/accommodations/search$';
/**
 * The most a two-page fetch may take. Page 2 sometimes never comes (re-drill 6: a cold North Goa search ran to Bash's
 * 20 s and came back with page 1 only); at 12 s the timed-out fetch answers with page 1, which is read as it is. A box
 * asleep for 90 minutes gave both pages by 10 s once Bash scrolled only a drawn page (#4584), so 12 s leaves it room, and
 * stays within the turn's 12 s inline wait, with the live card covering it.
 */
export const WIDE_FETCH_MS = 12_000;
/**
 * How long Bash waits after the hotels are in before its last picture (#4585): about +0.55 s, and the results frames
 * show real cards (p5's staging measurement). Buses get none: ixigo draws their list a second or more after the data.
 */
export const STAYS_SETTLE_MS = 550;
/** ixigo's "Best Price Guarantee" popup's close button; not there most of the time, so optional. */
const CLOSE_POPUP: Step = { op: 'click', name: 'Close modal', optional: true };
/** Two to a room, as ixigo's own search starts ("1 Room, 2 Guests"). */
const PER_ROOM = 2;
const MAX_ROOMS = 8;
/** Walking pace, for "310 m from Colva Beach" as minutes to the beach. */
const METRES_A_MINUTE = 80;

/** The must-haves ixigo filters on, as its codes. "Beach" has none: it is a distance, read from each stay. */
const POOL = 'FL_HF_29';
const FREE_CANCELLATION = 'MP_FC';
const BREAKFAST = 'MP_FB';
const MUST_HAVE_CODES: Partial<Record<(typeof MUST_HAVES)[number], string>> = { pool: POOL, free_cancellation: FREE_CANCELLATION, breakfast: BREAKFAST };

const Hotel = z.object({
  hotelId: z.number(),
  locationId: z.number().optional(),
  name: z.string().min(1),
  locality: z.string().optional(),
  city: z.string().optional(),
  userRating: z.union([z.string(), z.number()]).optional(),
  starRating: z.number().optional(),
  userRatingCount: z.number().optional(),
  topOfferings: z.array(z.string()).optional(),
  amenities: z.array(z.object({ name: z.string() })).optional(),
  distanceFromSearchedEntity: z.string().nullish(),
  hotelInfoToken: z.string().optional(),
  geoLocationInfo: z.object({ lat: z.number(), lon: z.number() }).nullish(),
  imageInfoList: z.array(z.object({ url: z.string().optional(), urlMedium: z.string().optional() })).optional(),
  fareDetail: z.object({ displayedBaseFare: z.number().nonnegative(), taxesAndFees: z.number().nonnegative() }),
});
const Page = z.object({ data: z.object({ result: z.object({ inventoryInfoList: z.array(Hotel) }) }) });

interface StayRead {
  name: string;
  area?: string;
  city?: string;
  distance?: string;
  rating10?: number;
  reviews?: number;
  stars?: number;
  nightlyRupees: number;
  offerings: string[];
  hotelId?: number;
  locationId?: number;
  token?: string;
  lat?: number;
  lng?: number;
  imageUrl?: string;
}

/** "310 m from Colva Beach" as 4 minutes on foot; null when the distance isn't to a beach. */
function beachMinutes(distance: string | undefined): number | null {
  const m = distance ? /^([\d.]+)\s*(km|m)\b.*\bbeach\b/i.exec(distance) : null;
  if (!m) return null;
  const metres = Number(m[1]) * (m[2]!.toLowerCase() === 'km' ? 1000 : 1);
  return Number.isFinite(metres) ? Math.max(1, Math.ceil(metres / METRES_A_MINUTE)) : null;
}

function detailsUrl(h: StayRead, s: StaySlots): string {
  const loc = s.location;
  const q = new URLSearchParams({
    locationId: String(h.locationId ?? loc.locationId),
    locationName: loc.locationName,
    locationType: loc.locationType,
    masterLocationId: String(loc.masterLocationId),
    countryId: String(loc.countryId),
    checkinDate: ddmmyyyy(s.checkIn),
    checkoutDate: ddmmyyyy(s.checkOut),
    adultCount: String(s.adults),
    roomCount: String(s.rooms),
    childCount: '0',
    searchLocationId: String(loc.locationId),
    ...(h.token ? { hotelInfoToken: h.token } : {}),
    hName: h.name,
  });
  return `${IXIGO}/hotels/${h.hotelId}/details?${q.toString().replace(/\+/g, '%20')}`;
}

function stayOption(h: StayRead, s: StaySlots): RecipeOption {
  const nights = nightsBetween(s.checkIn, s.checkOut);
  const nightly = paise(h.nightlyRupees);
  // What ixigo filtered on, every stay it gave has; the rest is what it lists for the stay.
  const said = (re: RegExp, code: string): boolean => s.filters.includes(code) || h.offerings.some((o) => re.test(o));
  const pool = said(/pool/i, POOL);
  const breakfast = said(/breakfast/i, BREAKFAST);
  const freeCancellation = said(/free cancellation/i, FREE_CANCELLATION);
  const beach = beachMinutes(h.distance);
  const address = [...new Set([h.area, h.city].filter((x): x is string => typeof x === 'string' && x.length > 0))].join(', ');
  return {
    kind: 'stay',
    title: h.name,
    priceMinor: nightly,
    totalMinor: nightly * nights * s.rooms,
    currency: 'INR',
    priceNote: 'per night, per room',
    place: {
      name: h.name.slice(0, 120),
      ...(address ? { address: address.slice(0, 200) } : {}),
      ...(h.lat !== undefined && h.lng !== undefined ? { lat: h.lat, lng: h.lng } : {}),
    },
    ...(h.imageUrl ? { imageUrl: h.imageUrl } : {}),
    ...(h.rating10 !== undefined ? { rating: Math.round(h.rating10 * 5) / 10 } : {}),
    highlights: highlights(h.distance, freeCancellation && 'Free cancellation', breakfast && 'Breakfast included', pool && 'Pool'),
    facts: {
      nights,
      rooms: s.rooms,
      ...(h.area ? { area: h.area } : {}),
      ...(h.distance ? { distance: h.distance } : {}),
      ...(h.stars !== undefined ? { stars: h.stars } : {}),
      ...(h.rating10 !== undefined ? { rating_out_of_10: h.rating10 } : {}),
      ...(h.reviews !== undefined ? { reviews: h.reviews } : {}),
      // Only what ixigo filtered on or lists for the hotel: one it doesn't list counts as without.
      pool,
      breakfast,
      free_cancellation: freeCancellation,
      ...(beach !== null ? { beach_minutes: beach } : {}),
    },
    sourceUrl: h.hotelId !== undefined ? detailsUrl(h, s) : stays.url(s),
  };
}

const ratingOf = (r: string | number | undefined): number | undefined => {
  const n = typeof r === 'string' ? Number(r) : r;
  return n !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * The stays in the half of Goa asked for: one whose area or town is known to be in the other half is dropped ("North
 * Goa" never answers with a hotel in Vasco). One whose place isn't known either way is kept, with its own area.
 */
function inHalf(options: RecipeOption[], half: GoaHalf | null): RecipeOption[] {
  if (!half) return options;
  return options.filter((o) => {
    const fact = (k: string): string => (typeof o.facts[k] === 'string' ? (o.facts[k] as string) : '');
    // Its area first, then its town, then what it is near ("310 m from Colva Beach").
    const seen = goaHalfOf(fact('area')) ?? goaHalfOf(o.place?.address ?? '') ?? goaHalfOf(fact('distance'));
    return seen === null || seen === half;
  });
}

function extract(captures: Capture[], s: StaySlots): RecipeOption[] {
  const bodies = bodiesFor(captures, SEARCH);
  if (bodies.length === 0) throw new TravelError('refused', "ixigo's hotel results page did not load its hotels.");
  const seen = new Set<number>();
  const out: RecipeOption[] = [];
  for (const body of bodies) {
    for (const h of readBody(Page, body, 'the hotel search').data.result.inventoryInfoList) {
      if (seen.has(h.hotelId)) continue;
      seen.add(h.hotelId);
      const rating10 = ratingOf(h.userRating);
      const imageUrl = h.imageInfoList?.[0]?.urlMedium ?? h.imageInfoList?.[0]?.url;
      out.push(stayOption({
        name: h.name.trim(),
        ...(h.locality ? { area: h.locality } : {}),
        ...(h.city ? { city: h.city } : {}),
        ...(h.distanceFromSearchedEntity ? { distance: h.distanceFromSearchedEntity } : {}),
        ...(rating10 !== undefined ? { rating10 } : {}),
        ...(h.userRatingCount !== undefined ? { reviews: h.userRatingCount } : {}),
        ...(h.starRating ? { stars: h.starRating } : {}),
        nightlyRupees: h.fareDetail.displayedBaseFare + h.fareDetail.taxesAndFees,
        offerings: [...(h.topOfferings ?? []), ...(h.amenities ?? []).map((a) => a.name)],
        hotelId: h.hotelId,
        ...(h.locationId !== undefined ? { locationId: h.locationId } : {}),
        ...(h.hotelInfoToken ? { token: h.hotelInfoToken } : {}),
        ...(h.geoLocationInfo ? { lat: h.geoLocationInfo.lat, lng: h.geoLocationInfo.lon } : {}),
        ...(imageUrl ? { imageUrl } : {}),
      }, s));
    }
  }
  return inHalf(out, s.half);
}

/**
 * Reads the hotel cards from the page text: the name, then "area•distance", the rating and its count, what the hotel
 * offers, and the price with its taxes. The hotel's own page comes from its link, matched by the name in it. It runs in
 * the page, sent as its source, so it uses nothing outside itself.
 */
export function readStaysPage(text: string, links: string[]): unknown[] {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const rupees = (l: string | undefined): number | null => {
    const m = l ? /₹\s?([\d,]+)/.exec(l) : null;
    return m ? Number(m[1]!.replace(/,/g, '')) : null;
  };
  const byName = new Map<string, string>();
  for (const href of links) {
    try {
      const u = new URL(href);
      const name = u.searchParams.get('hName');
      if (/^\/hotels\/\d+\/details/.test(u.pathname) && name && !byName.has(name.trim())) byName.set(name.trim(), href);
    } catch {
      // not a link Go reads
    }
  }
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 1; i < lines.length; i++) {
    const where = /^([^•]+)•(.+)$/.exec(lines[i]!);
    if (!where) continue;
    let end = i + 1;
    while (end < lines.length && !/^per night/i.test(lines[end]!) && !/^[^•]+•.+$/.test(lines[end]!)) end++;
    if (end >= lines.length || !/^per night/i.test(lines[end]!)) continue;
    const price = rupees(lines[end - 2]);
    const taxes = /taxes/i.test(lines[end - 1]!) ? rupees(lines[end - 1]) : 0;
    if (price === null || taxes === null) continue;
    const name = lines[i - 1]!;
    const card = lines.slice(i + 1, end);
    const rating = card[0] && /^\d+(\.\d+)?$/.test(card[0]) ? Number(card[0]) : null;
    const count = card.find((l) => /^\d[\d,]* Ratings?$/i.test(l));
    const link = byName.get(name);
    let hotel: Record<string, unknown> = {};
    if (link) {
      const u = new URL(link);
      hotel = { hotel_id: Number(/^\/hotels\/(\d+)\//.exec(u.pathname)![1]), location_id: Number(u.searchParams.get('locationId')) || null, token: u.searchParams.get('hotelInfoToken') };
    }
    rows.push({
      name,
      area: where[1]!.trim(),
      distance: where[2]!.trim(),
      rating,
      reviews: count ? Number(count.replace(/[^\d]/g, '')) : null,
      offerings: card.filter((l) => /cancellation|breakfast|pool/i.test(l) && l.length <= 40),
      price,
      taxes,
      ...hotel,
    });
  }
  return rows;
}

const StayRow = z.object({
  name: z.string().min(1).max(120),
  area: z.string().max(80),
  distance: z.string().max(80),
  rating: z.number().min(0).max(10).nullable(),
  reviews: z.int().nonnegative().nullable(),
  offerings: z.array(z.string().max(40)).max(10),
  price: z.number().positive(),
  taxes: z.number().nonnegative(),
  hotel_id: z.int().positive().optional(),
  location_id: z.int().positive().nullable().optional(),
  token: z.string().max(60).nullable().optional(),
});

function fromAgent(rows: unknown, s: StaySlots): RecipeOption[] {
  const options = readRows(z.array(StayRow), rows, 'stays').map((r) =>
    stayOption({
      name: r.name,
      area: r.area,
      distance: r.distance,
      ...(r.rating !== null ? { rating10: r.rating } : {}),
      ...(r.reviews !== null ? { reviews: r.reviews } : {}),
      nightlyRupees: r.price + r.taxes,
      offerings: r.offerings,
      ...(r.hotel_id !== undefined ? { hotelId: r.hotel_id } : {}),
      ...(r.location_id ? { locationId: r.location_id } : {}),
      ...(r.token ? { token: r.token } : {}),
    }, s),
  );
  return inHalf(options, s.half);
}

export const stays: Recipe<StaySlots> = {
  id: 'ixigo.stays',
  kind: 'stays',
  slotsFrom(q: TravelQuery, trip) {
    const where = q.area ?? q.to;
    if (!where || !q.checkIn || !q.checkOut) throw new TravelError('needs_more', 'A stay search needs the place, check-in and check-out.');
    const adults = clamp(q.guests ?? trip.people, 1, 30);
    const place = stayPlaceOf(where);
    const codes = (q.mustHave ?? []).flatMap((m) => MUST_HAVE_CODES[m] ?? []);
    const filters = [...new Set([...place.areas, ...codes])].sort();
    return {
      location: place.location, checkIn: q.checkIn, checkOut: q.checkOut, adults, rooms: clamp(Math.ceil(adults / PER_ROOM), 1, MAX_ROOMS), filters,
      half: place.half,
      // The whole state with no area filter; an area (Vagator) or a location of its own (Anjuna) stays on page 1.
      wide: place.location.locationType === 'S' && place.areas.length === 0,
    };
  },
  url: (s) =>
    `${IXIGO}/hotels/search/result?locationId=${s.location.locationId}&locationName=${encodeURIComponent(s.location.locationName)}` +
    `&locationType=${s.location.locationType}&masterLocationId=${s.location.masterLocationId}&countryId=${s.location.countryId}` +
    `&checkinDate=${ddmmyyyy(s.checkIn)}&checkoutDate=${ddmmyyyy(s.checkOut)}&adultCount=${s.adults}&roomCount=${s.rooms}&childCount=0` +
    (s.filters.length ? `&filters=${encodeURIComponent(s.filters.join(','))}` : ''),
  // Page 1 for an area. All of Goa or a half takes pages 1 and 2 (p5's proven shape on staging, about 5 s): page 1 alone,
  // in ixigo's popularity order, is the Calangute and Candolim strip. Either way, once the results are in, ixigo's "Best
  // Price Guarantee" popup (once a day per browser, about 2 s in) is closed if it is there, so the card's picture is the
  // list, not the dark overlay: before the scrolls, which it can block, and again after them, for one that came late.
  // Each look is one read of the page with no wait.
  capture: [{ match: SEARCH, required: true }],
  fetchFor: (s) =>
    s.wide
      ? {
          capture: [{ match: SEARCH, required: true, min_count: 2, max_count: 2 }],
          steps: [{ op: 'wait_for', match: SEARCH }, CLOSE_POPUP, { op: 'scroll', times: 3 }, CLOSE_POPUP],
          timeoutMs: WIDE_FETCH_MS,
          settleMs: STAYS_SETTLE_MS,
        }
      : { capture: [{ match: SEARCH, required: true }], steps: [{ op: 'wait_for', match: SEARCH }, CLOSE_POPUP], settleMs: STAYS_SETTLE_MS },
  fetchable: true,
  readyText: 'per night, per room',
  extract,
  agentExtractor: pageScript(readStaysPage, 2),
  readPage: readStaysPage,
  fromAgent,
  ttlMs: RECIPE_TTL_MS,
};
