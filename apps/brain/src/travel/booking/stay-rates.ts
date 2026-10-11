/**
 * A stay's rates as its own page's rooms call lists them (POST /accommodation-search/api/v1/accommodations/details/{id}/
 * rooms, hotels.rooms's call): each room, each of its rates with ixigo's own price for the whole stay, the coupon ixigo
 * applied to it itself, its cancellation and how it is paid. The rate Go books for the group is chosen from these in
 * code, never by the model.
 *
 * The whole stay is ixigo's totalBookingAmount less its "Coupon Discount" (fareDetail.discountMap): on the drill browser
 * (H1, 10 Oct) that is the amount ixigo charges, its totalPGAmount, on every rate. totalPGAmount itself is never read: on
 * a logged-in browser it can take the account's ixigo money off too, which Go never reads. The page's own fares
 * (displayedBaseFare, taxesAndFees, totalPrice) are a night for one room, before ixigo's fees and reversals.
 */

export interface StayRate {
  room: string;
  rate: string;
  /** What ixigo charges for the whole stay at this rate, for the dates and rooms its page was opened for, in paise. */
  totalMinor: number;
  /** The coupon ixigo applied to this rate itself (its fareDetail.couponCode), with its saving on the whole stay. */
  coupon: { code: string; savingMinor: number | null } | null;
  /** ixigo's words for its cancellation ("Free Cancellation till 18 Nov 11:59 PM"); refundable when ixigo's code says so. */
  cancellation: string | null;
  refundable: boolean;
  /** PAY_NOW, PAY_AT_HOTEL or BOOK_WITH_ZERO_PAYMENT. */
  paymentType: string | null;
  recommended: boolean;
}

const COUPON_DISCOUNT = 'Coupon Discount';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' && v !== 'None' ? v.trim() : null);

/** A fareDetail's whole stay as ixigo charges it, with its coupon: a rate's on the stay's page and the review's alike. */
function wholeStay(fare: Record<string, unknown>): Pick<StayRate, 'totalMinor' | 'coupon'> | null {
  const booking = num(fare['totalBookingAmount']);
  const discount = (isObject(fare['discountMap']) ? num(fare['discountMap'][COUPON_DISCOUNT]) : null) ?? 0;
  if (booking === null || booking - discount <= 0) return null;
  const code = text(fare['couponCode']);
  return { totalMinor: Math.round((booking - discount) * 100), coupon: code ? { code, savingMinor: discount > 0 ? Math.round(discount * 100) : null } : null };
}

/** None when the call has no whole-stay total for a rate: Go never works one out of a night's fare. */
export function stayRates(body: unknown): StayRate[] {
  const root = Array.isArray(body) ? body[0] : body;
  const rooms = isObject(root) && isObject(root['data']) && Array.isArray(root['data']['rooms']) ? root['data']['rooms'] : [];
  return rooms.flatMap((room): StayRate[] => {
    if (!isObject(room) || !Array.isArray(room['roomOptions'])) return [];
    const roomName = text(room['name']);
    return room['roomOptions'].flatMap((o): StayRate[] => {
      if (!isObject(o) || !isObject(o['fareDetail']) || !roomName) return [];
      const fare = o['fareDetail'];
      const whole = wholeStay(fare);
      if (!whole) return [];
      const cancel = isObject(o['cancellationBenefits']) ? o['cancellationBenefits'] : null;
      return [{
        room: roomName,
        rate: text(o['name']) ?? roomName,
        ...whole,
        cancellation: text(cancel?.['data']),
        refundable: text(cancel?.['code']) === 'FULLY_REFUNDABLE',
        paymentType: text(o['paymentType']) ?? text(fare['paymentType']),
        recommended: o['isRecommended'] === true,
      }];
    });
  });
}

/**
 * The rate Go books for the group: the cheapest whole stay; between two at one price, ixigo's recommended one. (The
 * rooms card's chosen arrangement is not read here yet.)
 */
export function chooseRate(rates: StayRate[]): StayRate | null {
  return [...rates].sort((a, b) => a.totalMinor - b.totalMinor || Number(b.recommended) - Number(a.recommended))[0] ?? null;
}

/** ixigo's review of the stay Go reserved: the room it reserved, and what it charges for the whole stay, with its coupon. */
export interface StayReview {
  room: string | null;
  totalMinor: number;
  coupon: StayRate['coupon'];
}

/**
 * The review page's call (POST …/accommodations/booking/review, H2 10 Oct): its room (bookingDetail.travelDetails.
 * roomType) and its fare (bookingDetail.fareDetail), priced by the same rule as a rate. Only these are read: the answer
 * also carries the lead guest and the account's ixigo money, and Go reads neither.
 */
export function stayReview(body: unknown): StayReview | null {
  const root = Array.isArray(body) ? body[0] : body;
  const detail = isObject(root) && isObject(root['data']) && isObject(root['data']['bookingDetail']) ? root['data']['bookingDetail'] : null;
  const whole = detail && isObject(detail['fareDetail']) ? wholeStay(detail['fareDetail']) : null;
  if (!detail || !whole) return null;
  const travel = isObject(detail['travelDetails']) ? detail['travelDetails'] : null;
  return { room: text(travel?.['roomType']), ...whole };
}

const words = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Whether the review reserved the chosen rate's room, by ixigo's names with case and punctuation set aside (the page's
 * own Reserve is pressed after the room's name, so a page that names it twice could reserve another). A review that
 * names no room passes on its price alone.
 */
export function sameRoom(review: StayReview, rate: Pick<StayRate, 'room'>): boolean {
  if (review.room === null) return true;
  const a = words(review.room);
  const b = words(rate.room);
  return a.includes(b) || b.includes(a);
}
