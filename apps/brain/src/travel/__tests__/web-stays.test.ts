import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BOOK_DIR } from '../book/book.js';
import type { Parked } from '../login.js';
import { TravelError } from '../mcp-travel.js';
import type { FetchPlan } from '../recipes/recipe.js';
import type { StoredOffer } from '../travel.js';
import { createWebStays, SIM_VENDOR, stayOf, WEB_STAY, wholeStayFromRooms } from '../web-stays.js';

// The demo's ask (8 Oct): Saudades won the vote, "heyy can you try booking Saudades now", and Go answered with a link.
// A stay from ixigo.com now books on Go's test rail, once the trip's ixigo login is in, at ixigo's price read again.

const PAGE = 'https://www.ixigo.com/hotels/54381/details?locationId=1366415&checkinDate=06112026&checkoutDate=09112026&adultCount=5&roomCount=3&hName=Saudades%20Homestays';
const ROOMS = readFileSync(`${BOOK_DIR}samples/hotels.rooms.json`, 'utf8');
/** The sample's cheapest rate: ₹13,440 a night plus ₹3,591 taxes and fees, for 3 nights and 3 rooms. */
const SAMPLE_WHOLE_STAY = 1703100 * 3 * 3;

const offer = (over: Partial<StoredOffer> = {}): StoredOffer => ({
  optionId: 'opt_saudades', tripId: 't_goa', cardId: 'c_opt_1', resultsId: 'r_1', n: 1, offerId: null, kind: 'stay', title: 'Saudades Homestays',
  priceMinor: 1589400, totalMinor: 4768200, currency: 'INR', priceNote: 'per night, per room', checkedAt: '2026-10-08T10:00:00Z', sourceUrl: PAGE, ...over,
});

function world(o: { login?: 'in' | 'out'; rooms?: string | null; stored?: StoredOffer | null } = {}) {
  const stored = o.stored === undefined ? offer() : o.stored;
  const reads: Array<{ url: string; plan: FetchPlan }> = [];
  const ensured: Array<{ tripId: string; what: string; park?: Parked }> = [];
  const stays = createWebStays({
    results: { offer: async (id) => (stored && id === stored.optionId ? stored : null) },
    runner: () => ({
      read: async (_trip: string, url: string, plan: FetchPlan) => {
        reads.push({ url, plan });
        const body = o.rooms === undefined ? ROOMS : o.rooms;
        if (body === null) throw new TravelError('unreachable', 'ixigo took too long to answer.');
        return { captures: [{ match: plan.capture[0]!.match, url: 'https://www.ixigo.com/accommodation-search/api/v1/accommodations/details/54381/rooms', status: 200, content_type: 'application/json', body, truncated: false, at_ms: 900 }], finalUrl: url };
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
  it("reads its dates and rooms from its own page's address, and the whole stay from the rooms call as the search prices it", () => {
    expect(stayOf(PAGE)).toEqual({ hotelId: '54381', nights: 3, rooms: 3 });
    expect(stayOf('https://www.ixigo.com/hotels/54381/details?checkinDate=09112026&checkoutDate=06112026&roomCount=3')).toBeNull();
    expect(stayOf('https://villa-sol.example.com/book')).toBeNull();
    expect(wholeStayFromRooms(ROOMS, 3, 3)).toBe(SAMPLE_WHOLE_STAY);
    expect(wholeStayFromRooms('{"data":{"rooms":[]}}', 3, 3)).toBeNull();
    expect(wholeStayFromRooms('<html>', 3, 3)).toBeNull();
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

  it("with the login in, reads ixigo's price for the whole stay now, from the stay's own page", async () => {
    const w = world();
    expect(await w.stays.prepare('opt_saudades', { tripId: 't_goa', what: 'Saudades Homestays', resume })).toEqual({ ok: true, priceMinor: SAMPLE_WHOLE_STAY });
    expect(w.reads).toEqual([{ url: PAGE, plan: { capture: [{ match: '/accommodations/details/54381/rooms$', required: true }], timeoutMs: 15_000 } }]);
    // A page that didn't answer: no price to say, and the hold reads it again.
    expect(await world({ rooms: null }).stays.prepare('opt_saudades', { tripId: 't_goa', what: 'Saudades Homestays', resume })).toEqual({ ok: true, priceMinor: null });
  });

  it('needs nothing first for any other option', async () => {
    const w = world({ stored: offer({ offerId: 'fake:st-villa-sol' }) });
    expect(await w.stays.prepare('opt_saudades', { tripId: 't_goa', what: 'Villa Sol', resume })).toEqual({ ok: true, priceMinor: null });
    expect(w.ensured).toEqual([]);
  });
});

describe('the hold and the booking, on the test rail', () => {
  it("holds at ixigo's price now, as simulated, on the fake rail", async () => {
    const w = world();
    const h = await w.stays.hold(`${WEB_STAY}opt_saudades`, { name: 'Rahul', personIds: ['p_rahul'] });
    expect(h).toEqual({
      holdId: `${WEB_STAY}opt_saudades:${Date.parse('2026-10-08T10:45:00Z')}`, amountMinor: SAMPLE_WHOLE_STAY, currency: 'INR',
      merchant: `${SIM_VENDOR}: Saudades Homestays`, expiresAt: '2026-10-08T10:45:00.000Z', payment: { kind: 'fake' },
    });
    expect(w.ensured).toEqual([{ tripId: 't_goa', what: 'Booking Saudades Homestays' }]);
  });

  it('holds nothing with the login out, or when ixigo showed no price', async () => {
    await expect(world({ login: 'out' }).stays.hold(`${WEB_STAY}opt_saudades`, { name: 'Rahul', personIds: [] })).rejects.toMatchObject({ code: 'refused' });
    await expect(world({ rooms: null }).stays.hold(`${WEB_STAY}opt_saudades`, { name: 'Rahul', personIds: [] })).rejects.toMatchObject({ code: 'unreachable' });
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
