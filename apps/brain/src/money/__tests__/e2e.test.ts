import * as C from '@go/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Reply } from '../../__tests__/fixtures/fake-anthropic.js';
import { afterTools, goaWithStayVote, startMoneyRoom } from './money-room.js';

let room: Awaited<ReturnType<typeof startMoneyRoom>>;

/**
 * The model stays quiet: who books the stay is the group's to say, never Go's (contract 1.1 A10). The closed vote's turn
 * puts the I'll book it card on its post, and Rahul's tap on it sets the mandate with no model turn at all.
 */
function script(body: any): Reply {
  if (afterTools(body)) return { text: 'Villa Sol it is. Rahul, tap Yes, book it when you are ready.' };
  return { tools: [{ name: 'stay_silent', input: { reason: 'nothing for Go' } }] };
}

beforeAll(async () => {
  room = await startMoneyRoom({ script });
}, 30_000);
afterAll(async () => {
  await room.stop();
});

// Keshav, 11 Oct: payment is mocked for the demo. The payer's one tap on Pay with ixigo money pays (Go's fake rail): no
// vault page, no Face ID. The Server's approval still stands behind it, and the booking moves on as after the vault's paid.
describe('G4: Go books, the payer paying in one tap with ixigo money', () => {
  it('vote, mandate, Yes book it, pay card, Pay with ixigo money, booked, expense, cards', async () => {
    const s = room.server;
    await s.createTrip(goaWithStayVote('open'));
    for (const [person, option] of [['p_rahul', 0], ['p_priya', 0], ['p_arjun', 1], ['p_meher', 0], ['p_kabir', 0]] as const) {
      await s.vote('d_villa', person, option);
    }
    // The fifth vote closes it in the simulator (everyone voted); close it by time only if it is still open.
    if (s.trip().decisions.find((d) => d.decision_id === 'd_villa')?.status === 'open') await s.closeVoteByTime('d_villa');
    // One person books it for all: the closed vote's turn puts up I'll book it, and Rahul takes it.
    const claim = await s.waitFor(() => s.messages().find((m) => m.card?.card_id === 'c_claim_d_villa'), 10_000);
    expect(claim.card).toMatchObject({ kind: 'notice', title: 'One person books for all', actions: [{ action_id: 'claim', label: "I'll book it" }] });
    expect(await s.tap('c_claim_d_villa', 'claim', 'p_rahul')).toMatchObject({ result: 'done' });
    expect(await s.tap('c_claim_d_villa', 'claim', 'p_priya')).toMatchObject({ result: 'refused', toast: 'Rahul is already booking this.' });

    // His tap sets the mandate (the price plus a little, nobody said a number) and posts the mandate card with its line.
    const mandate = await s.waitFor(() => s.trip().decisions.find((d) => d.decision_id === 'd_villa')?.mandate, 10_000);
    expect(mandate).toMatchObject({ choice_index: 0, cap_minor: 5900000, payer_person_id: 'p_rahul', refundable_only: false });
    await s.waitFor(() => s.messages().find((m) => m.card?.kind === 'mandate'), 10_000);

    // Rahul taps "Yes, book it": Go asks right away, with no model turn in between.
    await s.confirmMandate('d_villa');
    const payMessage = await s.waitFor(() => s.messages().find((m) => m.card?.kind === 'pay'), 10_000);
    const card = C.PayCard.parse(payMessage.card);
    expect(card).toMatchObject({ state: 'waiting', payer_person_id: 'p_rahul', amount_minor: 5420000, for_person_ids: ['p_rahul'] });
    // The vote's option_ref was turned into the travel offer before anything was held.
    // (set_mandate and "right now" also look it up, to check Go can book it, so only the option is checked, not the count.)
    expect([...new Set(room.travel.looked)]).toEqual(['opt_villa_sol']);
    expect(room.travel.holds.map((h) => h.offerId)).toEqual(['ixigo:stay:villa-sol-anjuna']);

    // Only the payer may pay; their one tap on the card pays, with ixigo money. No page opens.
    expect(card.actions?.[0]).toMatchObject({ action_id: 'approve', label: 'Pay with ixigo money' });
    expect(await s.tap(card.card_id, 'approve', 'p_priya')).toEqual({ result: 'refused', toast: 'Only Rahul can approve this payment.' });
    expect(await s.tap(card.card_id, 'approve', 'p_rahul')).toEqual({ result: 'done', toast: 'Paid with ixigo money.' });
    const booking = await s.waitFor(() => s.trip().bookings[0], 10_000);
    expect(booking).toMatchObject({ approval_id: card.approval_id, decision_id: 'd_villa', amount_minor: 5420000, kind: 'stay', ref: 'IXG-7Q2K9' });
    const expense = await s.waitFor(() => s.trip().expenses[0], 10_000);
    expect(expense).toMatchObject({ category: 'stay', amount_minor: 5420000, paid_by_person_id: 'p_rahul', booking_id: booking.booking_id });
    expect(expense.split_person_ids).toHaveLength(s.trip().people.length);
    await s.waitFor(() => s.messages().find((m) => m.card?.kind === 'ticket'), 10_000);
    await s.waitFor(() => s.messages().find((m) => m.card?.card_id === card.card_id && m.card.kind === 'pay' && m.card.state === 'paid'), 10_000);

    expect(s.countWrites(`go_paid_${card.approval_id}_booking`)).toBe(1);
    // The vault charged nothing: the payment was the demo's, and never counts as one without its keys.
    expect(room.vault.rail.charges).toHaveLength(0);
    expect(await room.pay.withoutBothKeys()).toEqual({ count: 0, paid: 0, charged: 0 });
    const paid = s.messages().find((m) => m.card?.card_id === card.card_id)?.card;
    expect(paid?.fallback_text).toMatch(/^Paid ₹54,200 with ixigo money for /);
    expect(JSON.stringify(s.writes)).not.toMatch(/\u2014/);
  }, 60_000);
});
