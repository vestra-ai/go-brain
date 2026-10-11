import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { askForTicket, type TicketAsk } from '../ask.js';
import { markFailed, markPaid, reconcile, sweepPayments } from '../finish.js';
import { getPayment, paidButNotBooked } from '../store.js';
import { moneyKit, type MoneyKit } from './kit.js';

// REV4 B7, contract 1.3 (G3): a traveller's own ticket is never voted on. Go asks the Server for a personal approval that
// names their pick (Go's card and the option they tapped), the vault opens their page, and they pay with their own Face
// ID: the Server's key and theirs, as for a stay.
let k: MoneyKit;
const MEHER: TicketAsk = {
  personId: 'p_meher',
  cardId: 'c_flights_meher',
  optionId: 'opt_flight_2',
  amountMinor: 753600,
  currency: 'INR',
  purpose: 'IndiGo 6E2150, Fri 6 Nov, for Meher',
  key: 'fb_meher_1',
  trigger: 'tap_1',
};
const spendAsks = () => k.server.writesOf('request_spend_approval');
const ask = async (o: Partial<TicketAsk> = {}) => {
  const r = await askForTicket(k.deps, 't_goa', { ...MEHER, ...o });
  if (!('url' in r)) throw new Error(r.refused);
  return r;
};

beforeEach(async () => {
  k = await moneyKit();
});
afterEach(async () => {
  await k.drop();
});

describe("a traveller's own ticket", () => {
  it('asks the Server with the personal form (their pick), has the vault open the page for them alone, and posts no pay card', async () => {
    const r = await ask();
    expect(spendAsks()[0]?.params).toEqual({
      request_id: 'go_spend_ticket_fb_meher_1_tap_1',
      trip_id: 't_goa',
      personal: { person_id: 'p_meher', card_id: 'c_flights_meher', option_id: 'opt_flight_2' },
      amount_minor: 753600,
      currency: 'INR',
      merchant: 'ixigo',
      purpose: 'IndiGo 6E2150, Fri 6 Nov, for Meher',
    });
    expect(k.vault.payLinks[0]).toMatchObject({
      approvalId: r.approvalId,
      payerPersonId: 'p_meher',
      hold: { holdId: 'fb_meher_1', amountMinor: 753600, currency: 'INR', paymentKind: 'fake' },
    });
    expect(r.url).toBe('https://vault.test/p/pay_1');
    expect(await getPayment(k.pool, r.paymentId)).toMatchObject({
      kind: 'ticket', decision_id: null, state: 'waiting', payer_person_id: 'p_meher', for_person_ids: ['p_meher'], card_id: null,
      pick_card_id: 'c_flights_meher', pick_option_id: 'opt_flight_2',
    });
    expect(k.server.writesOf('post_message')).toEqual([]);
  });

  it('asks once for a tap, and a second tap while it waits opens the same page', async () => {
    const first = await ask();
    expect(await ask()).toEqual(first);
    expect(await ask({ trigger: 'tap_2' })).toEqual(first);
    expect(spendAsks()).toHaveLength(1);
  });

  it('asks afresh once its approval ran out, and lets the old one go', async () => {
    const first = await ask();
    k.advance(13 * 60_000);
    const fresh = await ask({ trigger: 'tap_2' });
    expect(fresh.approvalId).not.toBe(first.approvalId);
    expect(spendAsks()).toHaveLength(2);
    expect((await getPayment(k.pool, first.paymentId))?.state).toBe('expired');
    await sweepPayments(k.deps);
    expect(k.server.writesOf('cancel_spend_approval').map((w) => w.params.approval_id)).toEqual([first.approvalId]);
  });

  it('is refused for someone not in the trip before anything is asked, and when the vault turns it down', async () => {
    expect(await askForTicket(k.deps, 't_goa', { ...MEHER, personId: 'p_nobody' })).toMatchObject({ code: 'not_in_trip' });
    expect(spendAsks()).toEqual([]);
    k.vault.refuse = 'rail_not_ready';
    expect(await askForTicket(k.deps, 't_goa', MEHER)).toMatchObject({ code: 'rail_not_ready' });
  });

  it("paid: one line naming the traveller, simulated on Go's test rail; its booking is its own flow's", async () => {
    const r = await ask();
    const row = await markPaid(k.deps, { tripId: 't_goa', approvalId: r.approvalId, railRef: `fake_${r.approvalId}` });
    await reconcile(k.deps, row!.payment_id);
    expect(k.server.writesOf('add_booking')).toEqual([]);
    expect(k.server.writesOf('post_message').map((w) => w.params.text)).toEqual([
      "Paid (simulated): IndiGo 6E2150, Fri 6 Nov, for Meher. Meher's test payment of ₹7,536; nothing was booked on ixigo.",
    ]);
    expect(await sweepPayments(k.deps)).toBe(0);
    expect(await paidButNotBooked(k.pool, new Date(k.now().getTime() + 3_600_000))).toEqual({ missing: 0, paid: 0 });
  });

  it('failed: the approval is let go and the traveller hears it, as for a stay', async () => {
    const r = await ask();
    const row = await markFailed(k.deps, { tripId: 't_goa', approvalId: r.approvalId, reason: 'card_declined' });
    await reconcile(k.deps, row!.payment_id);
    expect(k.vault.voids).toEqual([r.approvalId]);
    expect(k.server.writesOf('cancel_spend_approval')[0]?.params).toMatchObject({ approval_id: r.approvalId, reason: 'payment_failed' });
    expect(k.server.writesOf('post_message').map((w) => w.params.text)).toEqual([
      "Meher, the payment for IndiGo 6E2150, Fri 6 Nov, for Meher didn't go through (the bank declined the card). Nothing was charged. Want to try again?",
    ]);
  });
});
