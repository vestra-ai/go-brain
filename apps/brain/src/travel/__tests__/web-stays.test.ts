import { describe, expect, it } from 'vitest';
import { loadBook } from '../book/book.js';
import { createEngine } from '../book/engine.js';
import type { Parked } from '../login.js';
import { TravelError } from '../mcp-travel.js';
import { capture, fixture } from '../recipes/__tests__/fixtures.js';
import type { FetchPlan } from '../recipes/recipe.js';
import type { StoredOffer } from '../travel.js';
import { createWebStays, listingWholeStay, SIM_VENDOR, stayOf, WEB_STAY } from '../web-stays.js';

// The demo's ask (8 Oct): Saudades won the vote, "heyy can you try booking Saudades now", and Go answered with a link.
// A stay from ixigo.com now books on Go's test rail, once the trip's ixigo login is in, at ixigo's price read again.

const PAGE = 'https://www.ixigo.com/hotels/54381/details?locationId=1366415&checkinDate=06112026&checkoutDate=09112026&adultCount=5&roomCount=3&hName=Saudades%20Homestays';
/** The search the options card came from: its result set keeps the page ("See all on ixigo"). */
const SEARCH_PAGE = 'https://www.ixigo.com/hotels/search/result?locationId=32&locationName=Goa&locationType=S&masterLocationId=48569&countryId=1&checkinDate=06112026&checkoutDate=09112026&adultCount=5&roomCount=3&childCount=0&filters=FL_HF_29';
const SEARCH_URL = 'https://www.ixigo.com/accommodation-search/api/v3/accommodations/search';
const SEARCH_CALL = '/accommodation-search/api/v3/accommodations/search$';
/**
 * Saudades on the demo's card: "₹5,298 per night, per room" and "₹47,682 for 3 nights" (3 rooms for 5). ixigo's list gives
 * the night as its fare plus taxes and fees (here ₹4,730 and ₹568), and the card's whole stay is that times 3 nights and 3 rooms.
 */
const list = (base: number, taxes: number): string =>
  JSON.stringify({
    data: {
      result: {
        inventoryInfoList: [
          { hotelId: 1384544, name: 'Meritas Auberge Calangute Goa', fareDetail: { displayedBaseFare: 6426, taxesAndFees: 1678, method: 'PRPN' } },
          { hotelId: 54381, name: 'Saudades Homestays', fareDetail: { displayedBaseFare: base, taxesAndFees: taxes, method: 'PRPN' } },
        ],
      },
    },
  });
const SAME = list(4730, 568);
const SAUDADES_WHOLE_STAY = 4768200;

const offer = (over: Partial<StoredOffer> = {}): StoredOffer => ({
  optionId: 'opt_saudades', tripId: 't_goa', cardId: 'c_opt_1', resultsId: 'r_1', n: 1, offerId: null, kind: 'stay', title: 'Saudades Homestays',
  priceMinor: 1589400, totalMinor: 4768200, currency: 'INR', priceNote: 'per night, per room', checkedAt: '2026-10-08T10:00:00Z', sourceUrl: PAGE, ...over,
});

function world(o: { login?: 'in' | 'out'; body?: string | null; stored?: StoredOffer | null; page?: string | null } = {}) {
  const stored = o.stored === undefined ? offer() : o.stored;
  const reads: Array<{ url: string; plan: FetchPlan }> = [];
  const ensured: Array<{ tripId: string; what: string; park?: Parked }> = [];
  const stays = createWebStays({
    results: {
      offer: async (id) => (stored && id === stored.optionId ? stored : null),
      get: async (tripId, resultsId) => {
        const page = o.page === undefined ? SEARCH_PAGE : o.page;
        return { resultsId, tripId, optionKind: 'stay', source: 'search', query: {}, options: [], checkedAt: '2026-10-08T10:00:00Z', ...(page ? { page } : {}) };
      },
    },
    runner: () => ({
      read: async (_trip: string, url: string, plan: FetchPlan) => {
        reads.push({ url, plan });
        const body = o.body === undefined ? SAME : o.body;
        if (body === null) throw new TravelError('unreachable', 'ixigo took too long to answer.');
        return { captures: [capture(SEARCH_CALL, SEARCH_URL, body)], finalUrl: url };
      },
    }),
    login: {
      ensure: async (tripId, what, x) => {
        ensured.push({ tripId, what, ...(x?.park ? { park: x.park } : {}) });
        return o.login === 'out' ? { ok: false as const, note: `Go asked Rahul to link ixigo for ${what}.` } : { ok: true as const };
      },
    },
    now: () => new Date('2026-10-08T10:30:00Z'),
  });
  return { stays, reads, ensured };
}

describe('a stay from ixigo.com', () => {
  it("reads its dates and rooms from its own page's address", () => {
    expect(stayOf(PAGE)).toEqual({ hotelId: '54381', nights: 3, rooms: 3 });
    expect(stayOf('https://www.ixigo.com/hotels/54381/details?checkinDate=09112026&checkoutDate=06112026&roomCount=3')).toBeNull();
    expect(stayOf('https://villa-sol.example.com/book')).toBeNull();
  });

  it("reads Saudades' whole stay from ixigo's list the way the card showed it: ₹5,298 a night a room, ₹47,682 for 3 nights and 3 rooms", () => {
    expect(listingWholeStay(SAME, '54381', 3, 3)).toBe(SAUDADES_WHOLE_STAY);
    expect(listingWholeStay(list(4900, 588), '54381', 3, 3)).toBe(4939200);
    // Not on the list, a fare that isn't two numbers, or not the list at all: no price, so no move is ever claimed.
    expect(listingWholeStay(SAME, '99999', 3, 3)).toBeNull();
    expect(listingWholeStay(JSON.stringify({ data: { result: { inventoryInfoList: [{ hotelId: 54381, fareDetail: { displayedBaseFare: 4730 } }] } } }), '54381', 3, 3)).toBeNull();
    expect(listingWholeStay('<html>', '54381', 3, 3)).toBeNull();
  });

  it('is the very number hotels.search put on the card, for every stay on a saved Goa page', async () => {
    const body = fixture('stays-goa-page1.json');
    const runner = { read: async (_trip: string, url: string) => ({ captures: [capture(SEARCH_CALL, SEARCH_URL, body)], finalUrl: url }) };
    const engine = createEngine({ book: loadBook().book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-07T12:00:00Z') });
    const got = await engine.answer('hotels.search', { place: 'Goa', check_in: '2026-11-06', check_out: '2026-11-09' }, { tripId: 't_goa', conditions: [] });
    if (got.as !== 'options') throw new Error('not options');
    expect(got.options.length).toBeGreaterThan(0);
    for (const o of got.options) {
      const stay = stayOf(o.sourceUrl)!;
      expect(listingWholeStay(body, stay.hotelId, stay.nights, stay.rooms)).toBe(o.totalMinor);
    }
  });

  it("gets Go's web-stay offer; a job's find on another site, a journey, or an option with its own offer does not", () => {
    const { stays } = world();
    expect(stays.offerIdFor(offer())).toBe(`${WEB_STAY}opt_saudades`);
    expect(stays.offerIdFor(offer({ sourceUrl: 'https://villa-sol.example.com/book' }))).toBeNull();
    expect(stays.offerIdFor(offer({ kind: 'train', sourceUrl: 'https://www.ixigo.com/trains/12432' }))).toBeNull();
    expect(stays.offerIdFor(offer({ offerId: 'fake:st-villa-sol' }))).toBeNull();
    expect(stays.offerIdFor(offer({ sourceUrl: null }))).toBeNull();
  });
});

describe('before the mandate', () => {
  const resume = { decision_id: 'd_villa', choice_index: 0, payer_person_id: 'p_rahul', refundable_only: false };

  it('with the login out, asks for it with the booking parked on it, and reads no price', async () => {
    const w = world({ login: 'out' });
    expect(await w.stays.prepare('opt_saudades', { tripId: 't_goa', what: 'Saudades Homestays', resume })).toEqual({
      ok: false, note: 'Go asked Rahul to link ixigo for Saudades Homestays.',
    });
    expect(w.ensured).toEqual([{ tripId: 't_goa', what: 'Saudades Homestays', park: { what: 'Saudades Homestays', resume } }]);
    expect(w.reads).toEqual([]);
  });

  it("with the login in, reads ixigo's price now from the search that showed the stay: the same, or moved", async () => {
    const w = world();
    expect(await w.stays.prepare('opt_saudades', { tripId: 't_goa', what: 'Saudades Homestays', resume })).toEqual({ ok: true, priceMinor: SAUDADES_WHOLE_STAY });
    expect(w.reads).toEqual([{ url: SEARCH_PAGE, plan: { capture: [{ match: SEARCH_CALL, required: true }], timeoutMs: 20_000 } }]);
    expect(await world({ body: list(4900, 588) }).stays.prepare('opt_saudades', { tripId: 't_goa', what: 'Saudades Homestays', resume })).toEqual({ ok: true, priceMinor: 4939200 });
  });

  it("can't prove a price, so gives none: the page didn't answer, the stay isn't on it now, or there is no page", async () => {
    const ask = { tripId: 't_goa', what: 'Saudades Homestays', resume };
    expect(await world({ body: null }).stays.prepare('opt_saudades', ask)).toEqual({ ok: true, priceMinor: null });
    expect(await world({ body: list(4730, 568).replace('54381', '54380') }).stays.prepare('opt_saudades', ask)).toEqual({ ok: true, priceMinor: null });
    const none = world({ page: null });
    expect(await none.stays.prepare('opt_saudades', ask)).toEqual({ ok: true, priceMinor: null });
    expect(none.reads).toEqual([]);
  });

  it('needs nothing first for any other option', async () => {
    const w = world({ stored: offer({ offerId: 'fake:st-villa-sol' }) });
    expect(await w.stays.prepare('opt_saudades', { tripId: 't_goa', what: 'Villa Sol', resume })).toEqual({ ok: true, priceMinor: null });
    expect(w.ensured).toEqual([]);
  });
});

describe('the hold and the booking, on the test rail', () => {
  it("holds at ixigo's price now, as simulated, on the fake rail", async () => {
    const w = world({ body: list(4900, 588) });
    const h = await w.stays.hold(`${WEB_STAY}opt_saudades`, { name: 'Rahul', personIds: ['p_rahul'] });
    expect(h).toEqual({
      holdId: `${WEB_STAY}opt_saudades:${Date.parse('2026-10-08T10:45:00Z')}`, amountMinor: 4939200, currency: 'INR',
      merchant: `${SIM_VENDOR}: Saudades Homestays`, expiresAt: '2026-10-08T10:45:00.000Z', payment: { kind: 'fake' },
    });
    expect(w.ensured).toEqual([{ tripId: 't_goa', what: 'Booking Saudades Homestays' }]);
  });

  it('with no price read this time, holds at the price the card and the vote showed; with none at all, nothing', async () => {
    expect(await world({ body: null }).stays.hold(`${WEB_STAY}opt_saudades`, { name: 'Rahul', personIds: [] })).toMatchObject({ amountMinor: SAUDADES_WHOLE_STAY });
    await expect(world({ body: null, stored: offer({ totalMinor: null }) }).stays.hold(`${WEB_STAY}opt_saudades`, { name: 'Rahul', personIds: [] })).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('holds nothing with the login out, or for an option Go no longer has', async () => {
    await expect(world({ login: 'out' }).stays.hold(`${WEB_STAY}opt_saudades`, { name: 'Rahul', personIds: [] })).rejects.toMatchObject({ code: 'refused' });
    await expect(world({ stored: null }).stays.hold(`${WEB_STAY}opt_saudades`, { name: 'Rahul', personIds: [] })).rejects.toMatchObject({ code: 'unknown_offer' });
  });

  it("confirms as simulated, with Go's own reference, never one like ixigo's, and the same answer twice", async () => {
    const w = world();
    const holdId = `${WEB_STAY}opt_saudades:${Date.parse('2026-10-08T10:45:00Z')}`;
    const paid = { approvalId: 'ap_1', railRef: 'fake_1' };
    const c = await w.stays.confirm(holdId, paid);
    expect(c).toEqual({ ref: expect.stringMatching(/^SIM-[0-9A-F]{8}$/), vendor: 'ixigo (simulated)', title: 'Saudades Homestays, 3 nights', kind: 'stay', simulated: true });
    expect(await w.stays.confirm(holdId, paid)).toEqual(c);
  });
});
