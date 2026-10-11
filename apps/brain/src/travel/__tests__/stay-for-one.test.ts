import { describe, expect, it } from 'vitest';
import type { Paid } from '../../money/pay.js';
import { createStayForOne } from '../booking/stay-for-one.js';
import type { StoredOffer } from '../travel.js';

// Keshav, 12 Oct: a trip of one never gets a vote, so its stay can't go the group's way (a mandate needs a closed vote).
// Their Choose this is their pick, and it is booked as their own flight is: the login, the hold, their pay card.

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const offer: StoredOffer = {
  optionId: 'opt_1', tripId: 't_one', cardId: 'c_opt_1', resultsId: 'r_1', n: 1, offerId: null, kind: 'stay', title: 'Villa Sol',
  priceMinor: 5_070_000, totalMinor: 5_070_000, currency: 'INR', priceNote: null, checkedAt: '2026-10-12T09:00:00Z', sourceUrl: 'https://www.ixigo.com/hotels/1',
};
const ask = { tapId: 'tap_1', tripId: 't_one', personId: 'p_rahul', name: 'Rahul', offer };

function world(o: { login?: Array<{ ok: true } | { ok: false; note: string; line?: string }>; holdMinor?: number; paymentKind?: 'stay' | 'flight' } = {}) {
  const posts: Array<Record<string, unknown>> = [];
  const asks: unknown[] = [];
  const booked: unknown[] = [];
  const woke: unknown[] = [];
  const confirms: string[] = [];
  const logins = [...(o.login ?? [{ ok: true as const }])];
  let paid: ((p: Paid) => Promise<void>) | null = null;
  const stays = createStayForOne({
    pool: {
      query: async () => ({ rows: [{ hold_id: 'web_stay:opt_1:1', payer_person_id: 'p_rahul', amount_minor: '5100000', currency: 'INR', pick_option_id: o.paymentKind === 'flight' ? 'opt_flight' : 'opt_1' }] }),
    } as never,
    link: {
      request: async (method: string, params: Record<string, unknown>) => {
        posts.push({ method, ...params });
        return method === 'add_booking' ? { booking_id: 'b_go', seq: 2 } : { message_id: 'm_1', seq: 1 };
      },
    } as never,
    travel: () => ({
      offer: async () => ({ offerId: 'web_stay:opt_1', title: 'Villa Sol', priceMinor: 5_070_000, currency: 'INR', kind: 'stay' as const, link: null }),
      hold: async () => ({ holdId: 'web_stay:opt_1:1', amountMinor: o.holdMinor ?? 5_100_000, currency: 'INR', merchant: 'ixigo (simulated): Villa Sol', expiresAt: '2026-10-12T10:10:00Z', payment: { kind: 'fake' as const } }),
      confirm: async (holdId: string) => (confirms.push(holdId), { ref: 'SIM-ABCD1234', vendor: 'ixigo (simulated)', title: 'Villa Sol, 3 nights', kind: 'stay' as const, simulated: true }),
    }),
    login: { ensure: async () => logins.shift() ?? { ok: true as const } },
    pay: () => ({
      requestTicketCard: async (_tripId: string, a: unknown) => (asks.push(a), { cardId: 'c_pay_ticket_1', paymentId: 'pay_1' }),
      onPaid: (fn: (p: Paid) => Promise<void>) => void (paid = fn),
      booked: async (b: unknown) => void booked.push(b),
    }),
    results: { offer: async (id: string) => (id === 'opt_1' ? offer : { ...offer, optionId: id, kind: 'flight' }) },
    stayBooked: async (tripId, b) => void woke.push({ tripId, ...b }),
    log: quiet,
  });
  return { stays, posts, asks, booked, woke, confirms, paid: (p: Paid) => paid!(p) };
}

describe('a stay for a trip of one', () => {
  it('waits on the login with one plain line, then books it once the login is in: the hold, and their pay card for their pick', async () => {
    const line = "Booking Villa Sol needs the trip's ixigo login: @Rahul, tap Log in to ixigo on your card above.";
    const w = world({ login: [{ ok: false, note: 'For the model.', line }] });
    expect(w.stays.start(ask)).toBe('started');
    await w.stays.settled();
    expect(w.posts).toEqual([expect.objectContaining({ method: 'post_message', trip_id: 't_one', text: line })]);
    expect(w.asks).toEqual([]);
    w.stays.resumeWaiting('t_one');
    await w.stays.settled();
    expect(w.asks).toEqual([{
      personId: 'p_rahul', cardId: 'c_opt_1', optionId: 'opt_1', amountMinor: 5_100_000, currency: 'INR', purpose: 'Villa Sol, for Rahul', key: 'web_stay:opt_1:1', trigger: 'tap_1_in',
    }]);
    // A second wait finds none: nothing is booked twice.
    w.stays.resumeWaiting('t_one');
    await w.stays.settled();
    expect(w.asks).toHaveLength(1);
  });

  it('says a price that went up more than 5% since the card, and asks for no payment', async () => {
    const w = world({ holdMinor: 5_400_000 });
    w.stays.start(ask);
    await w.stays.settled();
    expect(w.asks).toEqual([]);
    expect(String(w.posts[0]?.text)).toMatch(/^Villa Sol is ₹54,000 on ixigo now, up from ₹50,700 on the card, so I haven't booked it\./);
  });

  it('paid: the booking on the trip (theirs), their ticket card, and Go wakes for their flights; the Server paying books nothing more', async () => {
    const w = world();
    w.stays.start(ask);
    await w.stays.settled();
    await w.paid({ tripId: 't_one', approvalId: 'appr_1', railRef: 'fake_appr_1' });
    expect(w.confirms).toEqual(['web_stay:opt_1:1']);
    expect(w.posts.find((p) => p.method === 'add_booking')).toMatchObject({
      kind: 'stay', title: 'Villa Sol, 3 nights', ref: 'SIM-ABCD1234', amount_minor: 5_100_000, payer_person_id: 'p_rahul', for_person_ids: ['p_rahul'], approval_id: 'appr_1',
    });
    expect(w.booked).toEqual([expect.objectContaining({ bookingId: 'b_go', title: 'Villa Sol, 3 nights', personId: 'p_rahul', simulated: true })]);
    expect(w.woke).toEqual([{ tripId: 't_one', bookingId: 'b_go', title: 'Villa Sol, 3 nights' }]);
    // payment.completed: the Server's own booking.
    const server = world();
    server.stays.start(ask);
    await server.stays.settled();
    await server.paid({ tripId: 't_one', approvalId: 'appr_2', railRef: 'server', bookingId: 'b_server' });
    expect(server.confirms).toEqual([]);
    expect(server.posts.some((p) => p.method === 'add_booking')).toBe(false);
    expect(server.woke).toEqual([{ tripId: 't_one', bookingId: 'b_server', title: 'Villa Sol' }]);
  });

  it("leaves a flight's ticket to its own flow", async () => {
    const w = world({ paymentKind: 'flight' });
    w.stays.start(ask);
    await w.stays.settled();
    await w.paid({ tripId: 't_one', approvalId: 'appr_3', railRef: 'fake' });
    expect(w.confirms).toEqual([]);
    expect(w.booked).toEqual([]);
    expect(w.woke).toEqual([]);
  });
});
