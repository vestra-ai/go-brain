import * as C from '@go/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CardTapResult } from '../../door/methods.js';
import type { ServerLink } from '../../door/server-link.js';
import { askOutsideTurn, askToPay, idsFrom, idsFromTurn, withTurn } from '../ask.js';
import { Later } from '../deps.js';
import { getPayment } from '../store.js';
import { approveTap } from '../taps.js';
import { FakeCallError, goaTrip, moneyKit, turnCtx, VILLA, type MoneyKit } from './kit.js';

let k: MoneyKit;
const payCards = () => [...k.server.cards.values()].filter((c) => c.kind === 'pay');
const spendAsks = () => k.server.writesOf('request_spend_approval');

beforeEach(async () => {
  k = await moneyKit();
});
afterEach(async () => {
  await k.drop();
});

describe('askToPay, when everything is in place', () => {
  it('turns the winning option into its offer, holds that offer, gets the Server approval, has the vault check it, then posts the pay card for the payer', async () => {
    const r = await k.ask();
    if (!('cardId' in r)) throw new Error(r.refused);
    // The vote names Villa Sol by its option_ref; the hold goes to the offer the travel layer gives for it.
    expect(k.travel.looked).toEqual(['opt_villa_sol']);
    expect(k.travel.holds).toEqual([
      { offerId: 'ixigo:stay:villa-sol-anjuna', lead: { name: 'Rahul', personIds: ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir'] }, holdId: 'hold_1' },
    ]);
    expect(spendAsks()[0]?.params).toMatchObject({
      request_id: 'go_spend_d_villa_trigger_1',
      decision_id: 'd_villa',
      amount_minor: 5420000,
      currency: 'INR',
      merchant: 'ixigo: Villa Sol, Anjuna',
      purpose: 'Villa Sol, 3 nights, 6 to 9 Nov',
      refundable_until: '2026-11-01T18:29:59Z',
    });
    const approvalId = [...k.server.approvals.keys()][0];
    expect(k.vault.payLinks[0]).toMatchObject({ approvalId, tripId: 't_goa', payerPersonId: 'p_rahul', hold: { holdId: 'hold_1', amountMinor: 5420000, paymentKind: 'fake' } });
    expect(r.cardId).toBe('c_pay_d_villa_trigger_1');
    expect(C.PayCard.parse(k.server.cards.get(r.cardId))).toMatchObject({ state: 'waiting', payer_person_id: 'p_rahul', for_person_ids: ['p_rahul'], approval_id: approvalId });
    expect(k.server.writesOf('post_message')[0]?.params.request_id).toBe('go_paycard_d_villa_trigger_1');
    expect(await getPayment(k.pool, r.paymentId)).toMatchObject({ state: 'waiting', card_id: r.cardId, card_state: 'waiting', approval_id: approvalId, label: 'Villa Sol' });
  });

  it('in a composer turn, takes its ids from the turn and lets the card ride with Go\'s message', async () => {
    const ctx = turnCtx('t_goa', k.server, k.server.trip('t_goa'));
    const r = await askToPay(k.deps, 't_goa', VILLA, idsFromTurn(ctx), withTurn(ctx));
    if (!('cardId' in r)) throw new Error(r.refused);
    expect(spendAsks()[0]?.params.request_id).toBe('go_spend_turn_test_1');
    expect(ctx.cards).toEqual([expect.objectContaining({ kind: 'pay', card_id: 'c_pay_turn_test_1' })]);
    expect(payCards()).toEqual([]);
  });

  it('is ready the moment the card shows: the payer taps Approve before the Server has answered Go, and the pay page opens', async () => {
    // The Server shows the card to the room, then answers Go. A quick payer, or a socket that drops before the answer
    // and makes Go send again, puts the tap in between.
    const later = new Later();
    const taps: CardTapResult[] = [];
    const server = k.server;
    const link: ServerLink = {
      isOpen: () => server.isOpen(),
      notify: () => undefined,
      request: async (method, params) => {
        const answer = await server.request(method, params);
        const card = (params as { card?: C.Card }).card;
        if (method === 'post_message' && card?.kind === 'pay') {
          const t = { d: k.deps, ask: (tripId: string, o: typeof VILLA, trigger: string) => askOutsideTurn(k.deps, tripId, o, trigger), later, reconcile: async () => undefined };
          taps.push(await approveTap(t, { tap_id: 'tap_quick', trip_id: 't_goa', card_id: card.card_id, action_id: 'approve', person_id: 'p_rahul' }, card));
        }
        return answer;
      },
    };
    k.deps.link = link;
    const r = await k.ask();
    if (!('cardId' in r)) throw new Error(r.refused);
    expect(taps).toEqual([{ result: 'open', url: 'https://vault.test/p/pay_1', expires_at: '2026-10-05T09:05:00.000Z' }]);
    await later.settled();
    expect((await getPayment(k.pool, r.paymentId))?.state).toBe('waiting');
  });

  it('does nothing twice when the same ask runs again, and carries on from where it stopped', async () => {
    const first = await k.ask(VILLA, 'trigger_x');
    if (!('cardId' in first)) throw new Error(first.refused);
    expect(await k.ask(VILLA, 'trigger_x')).toEqual(first);
    await k.pool.query("update payments set state = 'asking', card_state = null");
    expect(await k.ask(VILLA, 'trigger_x')).toEqual(first);
    expect(spendAsks()).toHaveLength(1);
    expect(k.server.writesOf('post_message')).toHaveLength(1);
    expect((await getPayment(k.pool, first.paymentId))?.state).toBe('waiting');
  });

  it('names the voted option in the purpose even when the model left it out', async () => {
    await k.ask({ ...VILLA, purpose: '3 nights in Anjuna' });
    expect(spendAsks()[0]?.params.purpose).toBe('Villa Sol: 3 nights in Anjuna');
  });
});

describe('askToPay refuses, in plain words, and posts nothing', () => {
  const expectNothingPosted = () => {
    expect(payCards()).toEqual([]);
    expect(spendAsks()).toEqual([]);
  };

  it('without a vote', async () => {
    const r = await k.ask({ decisionId: 'd_scuba', optionRef: 'opt_scuba', purpose: 'Scuba' });
    expect(r).toMatchObject({ code: 'no_vote', refused: expect.stringContaining('voted on') });
    expectNothingPosted();
    expect(k.travel.holds).toEqual([]);
  });

  it('while the vote is open', async () => {
    k.server.trips.set('t_goa', goaTrip('open'));
    expect(await k.ask()).toMatchObject({ code: 'decision_not_closed' });
    expectNothingPosted();
  });

  it('without a mandate', async () => {
    k.server.trips.set('t_goa', goaTrip('closed'));
    expect(await k.ask()).toMatchObject({ code: 'no_mandate' });
    expectNothingPosted();
  });

  it('before the payer taps Yes, book it', async () => {
    k.server.trips.set('t_goa', goaTrip('mandate'));
    expect(await k.ask()).toMatchObject({ code: 'payer_has_not_confirmed', refused: "Rahul, tap Yes, book it on the card above when you're ready." });
    expectNothingPosted();
  });

  it('after the payer said not now', async () => {
    k.server.trips.set('t_goa', goaTrip('declined'));
    expect(await k.ask()).toMatchObject({ code: 'payer_declined', refused: 'Holding off on Villa Sol for now.' });
    expectNothingPosted();
  });

  it('for an offer the group did not choose', async () => {
    expect(await k.ask({ ...VILLA, optionRef: 'opt_casa_azul' })).toMatchObject({ code: 'wrong_offer' });
    // A travel offer id is not how the vote names its options either.
    expect(await k.ask({ ...VILLA, optionRef: 'ixigo:stay:villa-sol-anjuna' })).toMatchObject({ code: 'wrong_offer' });
    expectNothingPosted();
    expect(k.travel.holds).toEqual([]);
  });

  it('when the winner came from browsing, or the travel layer has no offer for it, and holds nothing', async () => {
    k.travel.options.set('opt_villa_sol', null);
    expect(await k.ask()).toMatchObject({ code: 'not_bookable', refused: "I found this one on the web, so it can't be booked through me. Want the closest ones on ixigo, which I can book?" });
    k.travel.options.delete('opt_villa_sol');
    expect(await k.ask()).toMatchObject({ code: 'not_bookable' });
    expectNothingPosted();
    expect(k.travel.holds).toEqual([]);
  });

  it('for a stay from ixigo.com: no offer to hold, so Go points to View on ixigo in its details (never the link), and holds nothing', async () => {
    k.travel.options.set('opt_villa_sol', null);
    k.travel.pages.set('opt_villa_sol', 'https://www.ixigo.com/hotels/1384544/details?locationId=1366415&checkinDate=06112026&checkoutDate=09112026&adultCount=5&roomCount=3&hotelInfoToken=true%7C3001%7C1');
    expect(await k.ask()).toMatchObject({
      code: 'not_bookable',
      refused: "Villa Sol is booked on ixigo, not here: View on ixigo, in its details on its card, opens it there.",
    });
    // A page anywhere but ixigo.com is never handed out.
    k.travel.pages.set('opt_villa_sol', 'https://villa-sol.example.com/book');
    expect(await k.ask()).toMatchObject({ code: 'not_bookable', refused: "I found this one on the web, so it can't be booked through me. Want the closest ones on ixigo, which I can book?" });
    expectNothingPosted();
    expect(k.travel.holds).toEqual([]);
  });

  it('for a flight, train or bus: group travel is cut this week, so Go points to its card and holds nothing', async () => {
    // The group's winner resolves to a per-person flight fare.
    k.travel.options.set('opt_villa_sol', 'ixigo:flight:6e-2134');
    k.travel.offers.set('ixigo:flight:6e-2134', {
      amountMinor: 592000, currency: 'INR', merchant: 'ixigo: IndiGo 6E 2134', refundableUntil: null, title: 'IndiGo 6E 2134', kind: 'flight',
      link: 'https://www.ixigo.com/flights/6e-2134',
    });
    expect(await k.ask()).toMatchObject({
      code: 'not_bookable_yet',
      say: true,
      refused: "I can't book flights for the whole group yet. View on ixigo, in its details on its card, opens each one set up for you.",
    });
    // A train with no booking page from the travel layer: the first sentence alone.
    k.travel.options.set('opt_villa_sol', 'ixigo:train:12432');
    k.travel.offers.set('ixigo:train:12432', {
      amountMinor: 210000, currency: 'INR', merchant: 'ixigo: Rajdhani 12432', refundableUntil: null, title: 'Rajdhani 12432', kind: 'train',
    });
    expect(await k.ask()).toMatchObject({ code: 'not_bookable_yet', refused: "I can't book trains for the whole group yet." });
    expectNothingPosted();
    expect(k.travel.holds).toEqual([]);
  });

  it('when the live price is above the cap, and says the new price', async () => {
    k.travel.price('ixigo:stay:villa-sol-anjuna', 5640000);
    expect(await k.ask()).toMatchObject({
      code: 'over_cap',
      refused: 'Villa Sol is now ₹56,400, above the ₹55,000 the group allowed. Raise the cap or pick another option?',
    });
    expectNothingPosted();
  });

  it('when free cancellation is gone and the group asked for refundable only', async () => {
    k.travel.offers.set('ixigo:stay:villa-sol-anjuna', { ...k.travel.priced('ixigo:stay:villa-sol-anjuna'), refundableUntil: null });
    expect(await k.ask()).toMatchObject({ code: 'not_refundable' });
    expectNothingPosted();
  });

  it('when the price is in another currency', async () => {
    k.travel.offers.set('ixigo:stay:villa-sol-anjuna', { ...k.travel.priced('ixigo:stay:villa-sol-anjuna'), currency: 'USD' });
    expect(await k.ask()).toMatchObject({ code: 'currency_mismatch' });
    expectNothingPosted();
  });

  it('when the hold fails or there is no travel layer', async () => {
    k.travel.failHold = true;
    expect(await k.ask()).toMatchObject({ code: 'hold_failed' });
    const ids = idsFrom('no_travel', 'd_villa');
    expect(await askToPay({ ...k.deps, travel: () => undefined }, 't_goa', VILLA, ids, async () => undefined)).toMatchObject({ code: 'no_travel' });
    expectNothingPosted();
  });

  it('a second time while a pay card is waiting', async () => {
    await k.ask(VILLA, 'first');
    expect(await k.ask(VILLA, 'second')).toMatchObject({ code: 'approval_outstanding' });
    expect(payCards()).toHaveLength(1);
  });

  it('when the Server denies, and posts no card', async () => {
    const first = await k.ask(VILLA, 'first');
    if (!('cardId' in first)) throw new Error('first ask refused');
    await k.pool.query('delete from payments');
    expect(await k.ask(VILLA, 'second')).toMatchObject({ code: 'approval_outstanding' });
    expect(payCards()).toHaveLength(1);
    const rows = await k.pool.query('select state, refused_reason from payments');
    expect(rows.rows).toEqual([{ state: 'refused', refused_reason: 'approval_outstanding' }]);
  });

  it("when the vault turns the approval down before any page opened: Go couldn't start it, and why is logged and kept", async () => {
    k.vault.refuse = 'bad_approval';
    k.vault.refuseDetail = "the approval's signature is not valid for this vault's GO_SPEND_PUBLIC_KEY";
    expect(await k.ask()).toMatchObject({ code: 'vault_refused', refused: "I couldn't start this payment, so nothing was charged." });
    expect(payCards()).toEqual([]);
    const row = (await k.pool.query('select state, refused_reason from payments')).rows[0];
    expect(row).toEqual({
      state: 'refused',
      refused_reason: "vault_bad_approval: the approval's signature is not valid for this vault's GO_SPEND_PUBLIC_KEY",
    });
    const logged = k.lines.find((l) => l.includes('before any pay page opened'));
    expect(logged).toContain('signature is not valid');
    expect(logged).toContain('bad_approval');
  });

  it('when the vault refuses the approval, and keeps the approval for release', async () => {
    k.vault.refuse = 'over_amount';
    expect(await k.ask()).toMatchObject({ code: 'vault_refused' });
    expect(payCards()).toEqual([]);
    const row = (await k.pool.query('select state, refused_reason, release_reason, approval_id from payments')).rows[0];
    expect(row).toMatchObject({ state: 'refused', refused_reason: 'vault_over_amount', release_reason: 'other' });
    expect(row.approval_id).toMatch(/^ap_/);
  });

  it('when the Server cannot post the pay card: the payment is closed, so it cannot be paid from a card nobody saw', async () => {
    k.server.failNext.set('post_message', new FakeCallError(503, 'the Server is down'));
    expect(await k.ask()).toMatchObject({ code: 'server_down' });
    expect(payCards()).toEqual([]);
    expect((await k.pool.query('select state, refused_reason, release_reason from payments')).rows).toEqual([
      { state: 'refused', refused_reason: 'server_down', release_reason: 'other' },
    ]);
  });

  // The Server's already_booked (1.2): a booking someone added for the vote stands, so a second payment would charge twice.
  it('when the Server says the vote is booked already: says so and to cancel first, never to wait', async () => {
    await k.server.request('add_booking', {
      request_id: 'rq_by_hand', trip_id: 't_goa', kind: 'stay', title: 'Villa Sol', vendor: 'ixigo', ref: 'IXG-HAND', amount_minor: 5420000,
      currency: 'INR', payer_person_id: 'p_rahul', for_person_ids: ['p_rahul'], decision_id: 'd_villa',
    });
    const r = await k.ask();
    expect(r).toMatchObject({ code: 'already_booked', refused: 'Villa Sol is booked already. To book it again, cancel that booking first.' });
    expect('refused' in r && r.refused).not.toMatch(/wait/i);
    expect(payCards()).toEqual([]);
  });

  it('once the vote is already paid for', async () => {
    const first = await k.ask(VILLA, 'first');
    if (!('cardId' in first)) throw new Error('first ask refused');
    await k.pool.query("update payments set state = 'paid'");
    expect(await k.ask(VILLA, 'second')).toMatchObject({ code: 'already_paid', refused: 'Villa Sol is already booked.' });
  });
});
