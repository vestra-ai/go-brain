/**
 * What ixigo's review page answers for one fare (7 Oct capture, logged out; the shape is the same logged in): its total
 * and fare types (GET /flight-booking/flight-fare), and the coupon ixigo applied itself (POST /graph,
 * insuranceCouponBurnV2). The same /graph answer carries the account's wallet ("burn"): never read, never logged.
 */

export type FareChoice = 'basic' | 'assured' | 'flex';

/**
 * ixigo's names for its fare types, and the click on each one's radio on the review page (E1, the drill browser, 10 Oct
 * 11:19Z): "I don't want Free Cancellation" is a named radio; Assured's and Assured Flex's radios have no name, each the
 * first radio after its own words ("Add Free Cancellation to your trip" heads Assured's, Flex's says "Free Cancellation +
 * Rescheduling").
 */
export const FARE_TYPES: Record<FareChoice, { type: string; words: string; click: { op: 'click'; role: 'radio'; text?: string; near_text?: string } }> = {
  basic: { type: 'BASIC_FARE', words: 'no free cancellation', click: { op: 'click', role: 'radio', text: "I don't want Free Cancellation" } },
  assured: { type: 'IXIGO_ASSURED', words: 'Assured (free cancellation)', click: { op: 'click', role: 'radio', near_text: 'Add Free Cancellation to your trip' } },
  flex: { type: 'ASSURED_FLEX', words: 'Assured Flex (free cancellation and rescheduling)', click: { op: 'click', role: 'radio', near_text: 'Free Cancellation + Rescheduling' } },
};

export interface ReviewFare {
  /** The whole fare for the travellers searched, in paise, as ixigo shows it before a coupon. */
  totalMinor: number;
  currency: string;
  /** Each fare type ixigo sells for it, with its whole price. */
  types: Array<{ choice: FareChoice; totalMinor: number }>;
}

export interface IxigoCoupon {
  code: string;
  /** Its instant saving, in paise. */
  savingMinor: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const paise = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null);

export function reviewFare(body: unknown): ReviewFare | null {
  const data = isObject(body) && isObject(body['data']) ? body['data'] : null;
  const fare = Array.isArray(data?.['flightFare']) && isObject(data['flightFare'][0]) ? data['flightFare'][0] : null;
  const summary = isObject(fare?.['fareSummary']) ? fare['fareSummary'] : null;
  const totalMinor = paise(summary?.['totalFareForAllPassengers']);
  if (!summary || totalMinor === null) return null;
  const listed = isObject(data?.['fareTypeResponse']) && Array.isArray(data['fareTypeResponse']['fareTypes']) ? data['fareTypeResponse']['fareTypes'] : [];
  const types = listed.flatMap((t): ReviewFare['types'] => {
    if (!isObject(t)) return [];
    const choice = (Object.keys(FARE_TYPES) as FareChoice[]).find((c) => FARE_TYPES[c].type === t['type']);
    const total = paise(t['finalTotalDisplayedFare']) ?? paise(t['totalFareForAllPassengers']);
    return choice && total !== null ? [{ choice, totalMinor: total }] : [];
  });
  return { totalMinor, currency: typeof summary['currency'] === 'string' ? summary['currency'] : 'INR', types };
}

/** The coupon ixigo applied itself (its "selected" one), or none: Go types no code and picks no bank's card offer. */
export function ixigoCoupon(body: unknown): IxigoCoupon | null {
  const burn = isObject(body) && isObject(body['data']) && isObject(body['data']['insuranceCouponBurnV2']) ? body['data']['insuranceCouponBurnV2'] : null;
  const list = isObject(burn?.['coupon']) && Array.isArray(burn['coupon']['data']) ? burn['coupon']['data'] : [];
  const picked = list.find((c) => isObject(c) && (c['selected'] === true || c['selected'] === 'True' || c['selected'] === 'true'));
  if (!isObject(picked) || typeof picked['couponCode'] !== 'string') return null;
  const off = isObject(picked['instantDiscount']) ? paise(picked['instantDiscount']['amount']) : null;
  return off === null ? null : { code: picked['couponCode'], savingMinor: off };
}
