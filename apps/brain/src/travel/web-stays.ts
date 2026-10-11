/**
 * Booking a stay Go found on ixigo.com (TRAVEL_MODE ixigo_web), on Go's test rail. ixigo's own checkout isn't mapped (its
 * room review page errored on 7 Oct), so the booking is simulated and says so: the receipt reads "Booked (simulated)",
 * the reference is Go's own (SIM-…), never an ixigo booking id, and the payment is the test rail's, with the payer's two
 * approvals as for any booking. What is real: the trip's ixigo login is needed first, and the price is ixigo's own, read
 * again before the mandate and again at the hold, as the same number the options card and the vote showed (listingWholeStay).
 *
 * The 8 Oct demo asked "heyy can you try booking Saudades now" on a trip with no login, and Go answered with a link. Now a
 * booking ask with no login brings the login card back ("To book Saudades I need ixigo linked once, Rahul") and the ask
 * waits, parked on the trip's login; once the login reads in, Go carries on with exactly that stay, and nobody asks again.
 */
import { createHash } from 'node:crypto';
import type { ServerLink } from '../door/server-link.js';
import { bookingLiveCard } from './booking/flight-booking.js';
import { chooseRate, stayRates, type StayRate } from './booking/stay-rates.js';
import { formatInr } from './cards.js';
import { stableId } from './ids.js';
import { TravelError } from './mcp-travel.js';
import { bodiesFor } from './recipes/recipe.js';
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
/** The stays results page a search read, which its result set keeps ("See all on ixigo"), and that page's own list call. */
const SEARCH_PAGE = /^https:\/\/www\.ixigo\.com\/hotels\/search\/result\?/;
const SEARCH_CALL = '/accommodation-search/api/v3/accommodations/search$';

export interface WebStaysDeps {
  results: Pick<ResultsStore, 'offer' | 'get'>;
  /** The trip's browser fetch; null while the trip's computer is not set up here. */
  runner: () => Pick<RecipeRunner, 'read'> | null;
  login: Pick<IxigoLogin, 'ensure'>;
  now: () => Date;
  /**
   * BOOKING for the trip (booking/flight-booking.ts bookingOnFor): the stay is booked on ixigo's own pages where the room
   * watches (stageHold); absent or false, the price is read again as before.
   */
  bookingOn?: (tripId: string) => Promise<boolean>;
  /** Where the booking's live card goes. */
  link?: Pick<ServerLink, 'request'>;
  log?: { warn(obj: object, msg: string): void };
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

/** A stay page's check-in day (YYYY-MM-DD), from its address; null for anything else. */
export function checkInOf(sourceUrl: string | null | undefined): string | null {
  if (!sourceUrl || !DETAILS.test(sourceUrl)) return null;
  return ddmmyyyy(new URL(sourceUrl).searchParams.get('checkinDate'))?.toISOString().slice(0, 10) ?? null;
}

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
 * The whole stay's price as the options card and the vote showed it, from ixigo's stays list call: hotels.search prices a
 * stay at its listing's nightly fare plus taxes and fees (fareDetail, "per room per night", no room or plan named), in
 * paise, times the nights and the rooms. The same number from the same call, so a move is a real one. Null when the list
 * doesn't have the stay, or its fare isn't two numbers. (The stay's own rooms call is not the same number: its rates
 * carry ixigo's coupons, and nothing in it says which one the list showed.)
 */
export function listingWholeStay(body: string, hotelId: string, nights: number, rooms: number): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const first = (Array.isArray(parsed) ? parsed[0] : parsed) as { data?: { result?: { inventoryInfoList?: Array<{ hotelId?: unknown; fareDetail?: Record<string, unknown> }> } } } | undefined;
  const stay = (first?.data?.result?.inventoryInfoList ?? []).find((h) => String(h.hotelId) === hotelId);
  const base = stay?.fareDetail?.displayedBaseFare;
  const taxes = stay?.fareDetail?.taxesAndFees;
  if (typeof base !== 'number' || typeof taxes !== 'number') return null;
  return Math.round((base + taxes) * 100) * nights * rooms;
}

/** A stay page's rooms call, as hotels.rooms captures it. */
const roomsCall = (hotelId: string): string => `/accommodations/details/${hotelId}/rooms$`;

export function createWebStays(d: WebStaysDeps): WebStays {
  const optionOf = async (offerId: string): Promise<StoredOffer & { sourceUrl: string }> => {
    const o = offerId.startsWith(WEB_STAY) ? await d.results.offer(offerId.slice(WEB_STAY.length).split(':')[0] ?? '') : null;
    if (!o?.sourceUrl || !stayOf(o.sourceUrl)) throw new TravelError('unknown_offer', 'That stay is no longer one Go can book.');
    return o as StoredOffer & { sourceUrl: string };
  };

  /**
   * ixigo's price for the whole stay now: the search that showed it, opened again on the trip's computer, and the same
   * stay's listing read the same way (listingWholeStay). Null when there is no page to open, it didn't answer, or the stay
   * isn't on it now (a whole state's second page, or gone from the list).
   */
  async function livePrice(o: StoredOffer & { sourceUrl: string }): Promise<number | null> {
    const stay = stayOf(o.sourceUrl);
    const runner = d.runner();
    const page = (await d.results.get(o.tripId, o.resultsId))?.page ?? null;
    if (!stay || !runner || !page || !SEARCH_PAGE.test(page)) return null;
    try {
      const { captures } = await runner.read(o.tripId, page, { capture: [{ match: SEARCH_CALL, required: true }], timeoutMs: 20_000 });
      for (const c of captures) {
        if (c.status !== 200 || !c.url.includes('/accommodations/search')) continue;
        const price = listingWholeStay(c.body, stay.hotelId, stay.nights, stay.rooms);
        if (price !== null) return price;
      }
      return null;
    } catch (err) {
      if (err instanceof TravelError) return null;
      throw err;
    }
  }

  /**
   * The lead, 10 Oct: every "Book" ends in Go doing it, where the room watches. The group's voted stay, on ixigo's own
   * pages on the stage: the stay's page, its rooms read and the rate chosen in code (stay-rates.ts: the cheapest whole
   * stay), ixigo's own coupon on that rate kept and said. Its price is the hold's. The live card ticks each step for the
   * room (the stay is the group's). Null when the page didn't give a rate: the caller reads the price as before.
   */
  async function stageHold(o: StoredOffer & { sourceUrl: string }): Promise<StayRate | null> {
    const stay = stayOf(o.sourceUrl);
    const runner = d.runner();
    if (!stay || !runner || !d.link) return null;
    const tag = stableId('stay', o.optionId, d.now().getTime());
    const live = bookingLiveCard(
      { link: d.link, now: d.now, log: d.log ?? { warn: () => undefined } },
      o.tripId, stableId('c_stay', o.optionId, d.now().getTime()), `Booking ${o.title} for the group`,
      [`Opening ${o.title} on ixigo`, 'Choosing the rooms', "ixigo's coupon", 'Ready to pay'], null,
    );
    await live.step(0, 'doing');
    const read = await runner
      .read(o.tripId, o.sourceUrl, { capture: [{ match: roomsCall(stay.hotelId), required: true }], timeoutMs: 20_000 }, { stage: true, tag })
      .catch(() => null);
    const rates = read ? bodiesFor(read.captures, roomsCall(stay.hotelId)).flatMap((b) => {
      try {
        return stayRates(JSON.parse(b));
      } catch {
        return [];
      }
    }) : [];
    const rate = chooseRate(rates);
    if (!rate) {
      await live.step(0, 'failed');
      await live.finish(false);
      return null;
    }
    await live.step(0, 'done');
    await live.step(1, 'done');
    await live.step(2, 'done');
    await live.step(3, 'done');
    await live.finish(true);
    return rate;
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
      // Money is about to move: ixigo is read now, so a login it no longer has asks again instead of standing.
      const login = await d.login.ensure(o.tripId, o.what, { park, booking: true });
      if (!login.ok) return { ok: false, note: login.note };
      return { ok: true, priceMinor: await livePrice(offer as StoredOffer & { sourceUrl: string }) };
    },

    async hold(offerId) {
      const o = await optionOf(offerId);
      const login = await d.login.ensure(o.tripId, `Booking ${o.title}`, { booking: true });
      if (!login.ok) throw new TravelError('refused', login.note);
      // BOOKING: the stay's own page on the stage, its rate chosen and ixigo's coupon on it kept; its price is the hold's.
      const staged = d.bookingOn && (await d.bookingOn(o.tripId).catch(() => false)) ? await stageHold(o).catch(() => null) : null;
      // The room by its own name, without the extras ixigo writes after it ("Queen Cottage with Balcony - Happy Hours…").
      const room = staged ? `, ${staged.room.split(' - ')[0]!.trim()}` : '';
      const saving = staged?.coupon?.savingMinor ? ` ${formatInr(staged.coupon.savingMinor)} off` : '';
      const coupon = staged?.coupon ? `, ${staged.coupon.code}${saving}` : '';
      // ixigo's price now; when the list didn't have the stay this time, the price Go showed it at, which the vote used.
      const amountMinor = staged?.totalMinor ?? (await livePrice(o)) ?? o.totalMinor;
      if (amountMinor === null) throw new TravelError('unreachable', `ixigo didn't show a price for ${o.title} just now.`);
      const expiresAt = new Date(d.now().getTime() + WEB_HOLD_MS);
      const h: Hold = {
        holdId: `${WEB_STAY}${o.optionId}:${expiresAt.getTime()}`,
        amountMinor,
        currency: o.currency ?? 'INR',
        merchant: `${SIM_VENDOR}: ${o.title}${room}${coupon}`,
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
