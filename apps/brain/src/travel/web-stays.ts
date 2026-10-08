/**
 * Booking a stay Go found on ixigo.com (TRAVEL_MODE ixigo_web), on Go's test rail. ixigo's own checkout isn't mapped (its
 * room review page errored on 7 Oct), so the booking is simulated and says so: the receipt reads "Booked (simulated)",
 * the reference is Go's own (SIM-…), never an ixigo booking id, and the payment is the test rail's, with the payer's two
 * approvals as for any booking. What is real: the trip's ixigo login is needed first, and the price is ixigo's own, read
 * again from the stay's page before the mandate and again at the hold.
 *
 * The 8 Oct demo asked "heyy can you try booking Saudades now" on a trip with no login, and Go answered with a link. Now a
 * booking ask with no login brings the login card back ("To book Saudades I need ixigo linked once, Rahul") and the ask
 * waits, parked on the trip's login; once the login reads in, Go carries on with exactly that stay, and nobody asks again.
 */
import { createHash } from 'node:crypto';
import { TravelError } from './mcp-travel.js';
import type { RecipeRunner } from './recipes/runners.js';
import type { ResultsStore } from './results.js';
import type { Confirmed, Hold, StoredOffer, Travel } from './travel.js';
import type { IxigoLogin, Parked } from './login.js';

/** A web stay's offer id: this prefix and the option's id. hold() and confirm() route on it. */
export const WEB_STAY = 'webstay:';
/** A simulated hold lasts as a real one would: long enough for the payer to approve on their phone. */
export const WEB_HOLD_MS = 15 * 60_000;
export const SIM_VENDOR = 'ixigo (simulated)';
/** A stay's own page on ixigo.com, as hotels.search links it: the hotel id, then the dates, rooms and guests in its query. */
const DETAILS = /^https:\/\/www\.ixigo\.com\/hotels\/(\d+)\/details\?/;

export interface WebStaysDeps {
  results: Pick<ResultsStore, 'offer'>;
  /** The trip's browser fetch; null while the trip's computer is not set up here. */
  runner: () => Pick<RecipeRunner, 'read'> | null;
  login: Pick<IxigoLogin, 'ensure'>;
  now: () => Date;
}

export interface WebStays {
  /** The offer id an ixigo.com stay gets, or null for anything else (a job's web find, a journey, a page that isn't a stay's). */
  offerIdFor(o: Pick<StoredOffer, 'optionId' | 'offerId' | 'kind' | 'sourceUrl'>): string | null;
  prepare: NonNullable<Travel['prepare']>;
  hold: Travel['hold'];
  confirm: Travel['confirm'];
}

const ddmmyyyy = (s: string | null): Date | null => {
  const m = /^(\d{2})(\d{2})(\d{4})$/.exec(s ?? '');
  return m ? new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00Z`) : null;
};

/** The stay's dates and rooms, from its page's own address. */
export function stayOf(sourceUrl: string): { hotelId: string; nights: number; rooms: number } | null {
  const id = DETAILS.exec(sourceUrl)?.[1];
  if (!id) return null;
  const q = new URL(sourceUrl).searchParams;
  const inDay = ddmmyyyy(q.get('checkinDate'));
  const outDay = ddmmyyyy(q.get('checkoutDate'));
  if (!inDay || !outDay) return null;
  const nights = Math.round((outDay.getTime() - inDay.getTime()) / 86_400_000);
  const rooms = Number(q.get('roomCount') ?? '1');
  if (nights < 1 || !Number.isInteger(rooms) || rooms < 1) return null;
  return { hotelId: id, nights, rooms };
}

/**
 * The whole stay's price from the page's rooms call, worked out as hotels.search works out the price a vote shows: the
 * cheapest rate's nightly fare plus taxes and fees, times the nights and the rooms. Null when ixigo listed no rate.
 */
export function wholeStayFromRooms(body: string, nights: number, rooms: number): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const first = (Array.isArray(parsed) ? parsed[0] : parsed) as { data?: { rooms?: Array<{ roomOptions?: Array<{ fareDetail?: Record<string, unknown> }> }> } } | undefined;
  const nightly = (first?.data?.rooms ?? [])
    .flatMap((r) => r.roomOptions ?? [])
    .map((o) => o.fareDetail ?? {})
    .filter((f) => typeof f.displayedBaseFare === 'number')
    .map((f) => Math.round(((f.displayedBaseFare as number) + (typeof f.taxesAndFees === 'number' ? f.taxesAndFees : 0)) * 100));
  return nightly.length > 0 ? Math.min(...nightly) * nights * rooms : null;
}

export function createWebStays(d: WebStaysDeps): WebStays {
  const optionOf = async (offerId: string): Promise<StoredOffer & { sourceUrl: string }> => {
    const o = offerId.startsWith(WEB_STAY) ? await d.results.offer(offerId.slice(WEB_STAY.length).split(':')[0] ?? '') : null;
    if (!o?.sourceUrl || !stayOf(o.sourceUrl)) throw new TravelError('unknown_offer', 'That stay is no longer one Go can book.');
    return o as StoredOffer & { sourceUrl: string };
  };

  /** ixigo's price for the whole stay now, read from its own page on the trip's computer; null when the page didn't say. */
  async function livePrice(tripId: string, sourceUrl: string): Promise<number | null> {
    const stay = stayOf(sourceUrl);
    const runner = d.runner();
    if (!stay || !runner) return null;
    const match = `/accommodations/details/${stay.hotelId}/rooms$`;
    try {
      const { captures } = await runner.read(tripId, sourceUrl, { capture: [{ match, required: true }], timeoutMs: 15_000 });
      const rooms = captures.find((c) => c.url.includes(`/accommodations/details/${stay.hotelId}/rooms`) && c.status === 200);
      return rooms ? wholeStayFromRooms(rooms.body, stay.nights, stay.rooms) : null;
    } catch (err) {
      if (err instanceof TravelError) return null;
      throw err;
    }
  }

  return {
    offerIdFor(o) {
      if (o.offerId || o.kind !== 'stay' || !o.sourceUrl || !stayOf(o.sourceUrl)) return null;
      return `${WEB_STAY}${o.optionId}`;
    },

    async prepare(optionId, o) {
      const offer = await d.results.offer(optionId);
      if (!offer?.sourceUrl || offer.offerId || offer.kind !== 'stay' || !stayOf(offer.sourceUrl)) return { ok: true, priceMinor: null };
      const park: Parked = { what: o.what, resume: o.resume };
      const login = await d.login.ensure(o.tripId, o.what, { park });
      if (!login.ok) return { ok: false, note: login.note };
      return { ok: true, priceMinor: await livePrice(o.tripId, offer.sourceUrl) };
    },

    async hold(offerId) {
      const o = await optionOf(offerId);
      const login = await d.login.ensure(o.tripId, `Booking ${o.title}`);
      if (!login.ok) throw new TravelError('refused', login.note);
      const amountMinor = await livePrice(o.tripId, o.sourceUrl);
      if (amountMinor === null) throw new TravelError('unreachable', `ixigo didn't show a price for ${o.title} just now.`);
      const expiresAt = new Date(d.now().getTime() + WEB_HOLD_MS);
      const h: Hold = {
        holdId: `${WEB_STAY}${o.optionId}:${expiresAt.getTime()}`,
        amountMinor,
        currency: o.currency ?? 'INR',
        merchant: `${SIM_VENDOR}: ${o.title}`,
        expiresAt: expiresAt.toISOString(),
        payment: { kind: 'fake' },
      };
      return h;
    },

    // The rail paid within the hold (the vault refuses a hold past its time), so this only names the booking. Go's own
    // reference, from the hold, never one that looks like ixigo's: the same hold confirmed twice gives the same answer.
    async confirm(holdId): Promise<Confirmed> {
      const o = await optionOf(holdId);
      const stay = stayOf(o.sourceUrl)!;
      return {
        ref: `SIM-${createHash('sha256').update(holdId).digest('hex').slice(0, 8).toUpperCase()}`,
        vendor: SIM_VENDOR,
        title: `${o.title}, ${stay.nights} ${stay.nights === 1 ? 'night' : 'nights'}`,
        kind: 'stay',
        simulated: true,
      };
    },
  };
}
