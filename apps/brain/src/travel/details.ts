/**
 * An option's details sheet (contract 1.1 OptionDetails): what the App shows when someone opens an option, from what
 * Go's search already read, so it costs no load. Nothing is made up: what ixigo didn't give is left out, and a stay's
 * cancellation has no date, because ixigo's list gives none (the date is only on the hotel's own page, 8 Oct).
 */
import type { z } from 'zod';
import type * as C from '@go/contract';
import { hoursMinutes } from './book/expr.js';
import { clip, formatInr } from './cards.js';
import { shareOf } from './filters.js';
import type { ResultOption } from './results.js';
import type { TravelQuery } from './travel.js';

export type OptionDetailsT = z.infer<typeof C.OptionDetails>;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-11-04…" as "4 Nov": the day as written, wherever it is. */
const dayMonth = (iso: string): string => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);
const fact = (label: string, value: string | null): Array<{ label: string; value: string }> => (value ? [{ label, value: clip(value, 200) }] : []);

/** The beach within this many minutes on foot is "near the beach" (filters.ts). */
const BEACH_NEAR_MINUTES = 10;

/**
 * Why a stay fits, from the ask: each thing people asked for that the stay has, a reason a line. Only what was asked:
 * a pool nobody asked for is on the card already.
 */
function whyStay(o: ResultOption, q: TravelQuery): string[] {
  const why: string[] = [];
  const asked = new Set(q.mustHave ?? []);
  if (asked.has('pool') && o.facts['pool'] === true) why.push('Has a pool, as asked');
  if (asked.has('breakfast') && o.facts['breakfast'] === true) why.push('Breakfast included, as asked');
  if (asked.has('free_cancellation') && o.facts['free_cancellation'] === true) why.push('Free cancellation, as asked');
  const walk = num(o.facts['beach_minutes']);
  if (asked.has('beach') && walk !== null && walk <= BEACH_NEAR_MINUTES) why.push(`About ${walk} min on foot to the beach`);
  if (q.maxPriceMinor !== undefined && o.priceMinor !== undefined && o.priceMinor <= q.maxPriceMinor) {
    why.push(`Within ${formatInr(q.maxPriceMinor)} a night`);
  }
  const share = shareOf(o, q);
  if (q.maxShareMinor !== undefined && share !== null && share <= q.maxShareMinor) {
    why.push(`${formatInr(share)} each for the stay, within ${formatInr(q.maxShareMinor)} a head`);
  }
  if (q.minRating !== undefined && o.rating !== undefined && o.rating >= q.minRating) why.push(`Rated ${o.rating} out of 5`);
  return why.slice(0, 5);
}

/**
 * A stay's sheet: its photos (Go's re-hosted copies, up to seven from ixigo's list), why it fits, its cost for the stay
 * split between the people it sleeps, its amenities in ixigo's words, ixigo's rating out of 10 and its count, and the
 * facts the card has no room for. people: the head count the search was for.
 */
export function stayDetails(o: ResultOption, q: TravelQuery, people: number, gallery: string[]): OptionDetailsT | null {
  const nights = num(o.facts['nights']);
  const rooms = num(o.facts['rooms']);
  const total = o.totalMinor;
  const currency = o.currency ?? 'INR';
  // The whole stay split between the people it was priced for (ixigo's head count, else the search's): a line, and the
  // total it adds up to.
  const heads = num(o.facts['guests']) ?? people;
  const share = total !== undefined && heads > 0 ? Math.round(total / heads) : null;
  const span = nights !== null ? `${nights} night${nights === 1 ? '' : 's'}` : 'The stay';
  const costs = share !== null ? [{ label: clip(`${span}, each of ${heads}`, 60), emoji: '🛏️', amount_minor: share, currency }] : [];
  const rating = num(o.facts['rating_out_of_10']);
  const reviews = num(o.facts['reviews']);
  const amenities = (o.amenities ?? []).map((a) => clip(a, 40)).filter((a) => a.length > 0).slice(0, 30);
  const cancellation = o.refundableUntil
    ? `Free cancellation until ${dayMonth(o.refundableUntil)}`
    : o.facts['free_cancellation'] === true ? 'Free cancellation' : null;
  const whole = total !== undefined && nights !== null
    ? `${formatInr(total)} for ${span}${rooms !== null && rooms > 1 ? `, ${rooms} rooms` : ''}`
    : null;
  const stars = num(o.facts['stars']);
  const left = num(o.facts['rooms_left']);
  const facts = [
    ...fact('Area', text(o.facts['area'])),
    ...fact('Nearby', text(o.facts['distance'])),
    ...fact('Hotel class', stars !== null && stars > 0 ? `${stars}-star` : null),
    ...fact('Guests say', text(o.facts['rating_word'])),
    ...fact('Whole stay', whole),
    // ixigo's own offer, already in the price: its words when it gave them, else its code.
    ...fact('Offer', text(o.facts['offer']) ?? (text(o.facts['coupon']) ? `Code ${text(o.facts['coupon'])}, already in the price` : null)),
    ...fact('Pay', o.facts['book_with_zero'] === true ? 'Book with ₹0 now' : o.facts['pay_at_hotel'] === true ? 'Pay at the hotel' : null),
    ...fact('Rooms left', left !== null && left > 0 && left <= 5 ? `Only ${left} ${left === 1 ? 'room' : 'rooms'} left` : null),
  ];
  const why = whyStay(o, q);
  const details: OptionDetailsT = {
    ...(gallery.length ? { gallery_urls: gallery.slice(0, 12) } : {}),
    ...(why.length ? { why } : {}),
    ...(costs.length ? { costs, total_minor: share! } : {}),
    ...(amenities.length ? { amenities } : {}),
    ...(facts.length ? { facts } : {}),
    ...(cancellation ? { cancellation } : {}),
    ...(rating !== null && rating > 0 ? { rating } : {}),
    ...(reviews !== null && Number.isInteger(reviews) && reviews >= 0 ? { review_count: reviews } : {}),
  };
  return Object.keys(details).length > 0 ? details : null;
}

/**
 * A flight's sheet, from what ixigo's list said of its fare: the bags it takes (and what a check-in bag costs on a
 * handbag-only fare), seats left, a free meal, each change of plane, the code's saving, and Lock Price for the group: its fee
 * a person and for everyone, how long it holds the fare, and the most ixigo covers if the fare rises. people: the head count
 * the search was for. Its fare is the card's.
 */
export function flightDetails(o: ResultOption, people: number): OptionDetailsT | null {
  const withBag = num(o.facts['with_checkin_bag_minor']);
  const seats = num(o.facts['seats_left']);
  const fee = num(o.facts['lock_fee_minor']);
  const hours = num(o.facts['lock_hours']);
  const cover = num(o.facts['lock_cover_minor']);
  const group = fee !== null && people > 1 ? `, ${formatInr(fee * people)} for ${people}` : '';
  const checkin = text(o.facts['checkin_bag']);
  const facts = [
    ...fact('Fare', text(o.facts['fare_type'])),
    ...fact('Cabin bag', text(o.facts['cabin_bag'])),
    ...fact('Check-in bag', checkin === 'none' ? 'None on this fare' : checkin),
    ...fact('With a check-in bag', withBag !== null ? `${formatInr(withBag)} a person on this flight` : null),
    ...fact('Seats left', seats !== null && seats > 0 && seats <= 9 ? `${seats}` : null),
    ...fact('Meal', o.facts['free_meal'] === true ? 'Free meal' : null),
    ...fact('Change of plane', text(o.facts['layover'])),
    ...fact('Offer', text(o.facts['offer'])),
    ...fact('Lock Price', fee !== null && hours !== null ? `${formatInr(fee)} a person${group}, holds this fare ${hours} h` : null),
    ...fact('If the fare rises', fee !== null && cover !== null ? `ixigo covers up to ${formatInr(cover)}` : null),
    ...fact('Lock options', text(o.facts['lock_options'])),
  ];
  // ixigo's own words for the fare's refund (its filter's "Non Refundable", "Partially Refundable").
  const refund = REFUND_WORDS[text(o.facts['refundable']) ?? ''];
  const details: OptionDetailsT = { ...(facts.length > 0 ? { facts } : {}), ...(refund ? { cancellation: refund } : {}) };
  return Object.keys(details).length > 0 ? details : null;
}
const REFUND_WORDS: Record<string, string> = { REFUNDABLE: 'Refundable', PARTIALLY_REFUNDABLE: 'Partially refundable', NON_REFUNDABLE: 'Non-refundable' };

/** Indian Railways' classes in words, as the trains recipe names them on the card. */
const CLASS_WORDS: Record<string, string> = {
  '1A': 'AC First Class', '2A': 'AC 2 Tier', '3A': 'AC 3 Tier', '3E': 'AC 3 Economy', SL: 'Sleeper', CC: 'AC Chair Car',
  '2S': 'Second Sitting', EC: 'Executive Chair Car', EV: 'Vistadome', FC: 'First Class',
};

/**
 * A train's sheet: its class, its seats, ixigo's chance a waitlisted ticket confirms, the journey's length, and Tatkal
 * when it is open, as rows. Its fare is the card's.
 */
export function trainDetails(o: ResultOption): OptionDetailsT | null {
  const code = text(o.facts['class_code']);
  const chance = num(o.facts['chance']);
  const minutes = num(o.facts['duration_min']);
  const tatkal = text(o.facts['tatkal_availability']);
  const tatkalFare = num(o.facts['tatkal_fare_minor']);
  const facts = [
    ...fact('Class', code ? (CLASS_WORDS[code] ? `${CLASS_WORDS[code]} (${code})` : code) : null),
    ...fact('Seats', text(o.facts['availability'])),
    ...fact('Chance to confirm', chance !== null ? `${chance}%, ixigo's prediction` : null),
    ...fact('Journey', minutes !== null && minutes > 0 ? hoursMinutes(minutes) : null),
    ...fact('Tatkal', tatkal ? `${tatkal}${tatkalFare !== null ? `, ${formatInr(tatkalFare)}` : ''}` : null),
  ];
  return facts.length > 0 ? { facts } : null;
}
