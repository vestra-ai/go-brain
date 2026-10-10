/**
 * A stay's rates as its own page's rooms call lists them (GET /accommodation-search/api/v1/accommodations/details/{id}/
 * rooms, hotels.rooms's call): each room, each of its rates with its whole-stay price, the coupon ixigo applied to it
 * itself, its cancellation and how it is paid. The rate Go books for the group is chosen from these in code, never by
 * the model.
 *
 * The call prices "per night for 1 room" (its metadata.rateMethod): the whole stay is the nightly fare plus taxes and
 * fees, times the nights and the rooms, as listingWholeStay prices the list (web-stays.ts), and as ixigo's own
 * payAtHotelAmount adds up (samples: (2775 + 375) x 3 nights = 9450). fareDetail.totalPrice is not it: that is the struck
 * fare before ixigo's discount, plus taxes.
 */

export interface StayRate {
  room: string;
  rate: string;
  /** The whole stay at this rate, for the nights and rooms its page was opened for, in paise. */
  totalMinor: number;
  /** The coupon ixigo applied to this rate itself (its fareDetail.couponCode), with its saving on the whole stay when ixigo says it. */
  coupon: { code: string; savingMinor: number | null } | null;
  /** ixigo's words for its cancellation ("Free Cancellation till 02 Nov 11:59 PM"); refundable when ixigo's code says so. */
  cancellation: string | null;
  refundable: boolean;
  /** PAY_NOW, PAY_AT_HOTEL or BOOK_WITH_ZERO_PAYMENT. */
  paymentType: string | null;
  recommended: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' && v !== 'None' ? v.trim() : null);

/** "Discount of ₹686 included. Coupon code IXIFIRST applied!": the rupees a night a room, in paise. */
function savingOf(message: string | null): number | null {
  const m = message ? /₹\s?([\d,]+)/.exec(message) : null;
  return m ? Number(m[1]!.replace(/,/g, '')) * 100 : null;
}

const PER_NIGHT_ONE_ROOM = 'per night for 1 room';

/** None when the call prices another way than a night for one room: a whole stay can't be worked out, so none is said. */
export function stayRates(body: unknown, stay: { nights: number; rooms: number }): StayRate[] {
  const root = Array.isArray(body) ? body[0] : body;
  const data = isObject(root) && isObject(root['data']) ? root['data'] : null;
  const method = data && isObject(data['metadata']) ? text(data['metadata']['rateMethod']) : null;
  if (method !== null && method !== PER_NIGHT_ONE_ROOM) return [];
  const times = stay.nights * stay.rooms;
  const rooms = data && Array.isArray(data['rooms']) ? data['rooms'] : [];
  return rooms.flatMap((room): StayRate[] => {
    if (!isObject(room) || !Array.isArray(room['roomOptions'])) return [];
    const roomName = text(room['name']);
    return room['roomOptions'].flatMap((o): StayRate[] => {
      if (!isObject(o) || !isObject(o['fareDetail']) || !roomName) return [];
      const fare = o['fareDetail'];
      const base = num(fare['displayedBaseFare']);
      const taxes = num(fare['taxesAndFees']);
      if (base === null || taxes === null || base <= 0) return [];
      const code = text(fare['couponCode']);
      const saving = savingOf(text(fare['offerMessage']));
      const cancel = isObject(o['cancellationBenefits']) ? o['cancellationBenefits'] : null;
      return [{
        room: roomName,
        rate: text(o['name']) ?? roomName,
        totalMinor: Math.round((base + taxes) * 100) * times,
        coupon: code ? { code, savingMinor: saving === null ? null : saving * times } : null,
        cancellation: text(cancel?.['data']),
        refundable: text(cancel?.['code']) === 'FULLY_REFUNDABLE',
        paymentType: text(o['paymentType']) ?? text(fare['paymentType']),
        recommended: o['isRecommended'] === true,
      }];
    });
  });
}

/**
 * The rate Go books for the group: the cheapest whole stay, the one the list priced the vote's card at; between two at
 * one price, ixigo's recommended one. (The rooms card's chosen arrangement is not read here yet.)
 */
export function chooseRate(rates: StayRate[]): StayRate | null {
  return [...rates].sort((a, b) => a.totalMinor - b.totalMinor || Number(b.recommended) - Number(a.recommended))[0] ?? null;
}
