import * as C from '@go/contract';
import type { TestAuthenticator } from '@go/vault/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Reply } from '../../__tests__/fixtures/fake-anthropic.js';
import { afterTools, goaWithStayVote, startMoneyRoom } from './money-room.js';

let room: Awaited<ReturnType<typeof startMoneyRoom>>;
let rahul: TestAuthenticator;
let mandateAsked = false;

/** The model: once the stay vote has closed with no mandate, it sets one (Rahul pays, refundable, the price plus a little); otherwise it stays quiet. */
function script(body: any): Reply {
  if (afterTools(body)) return { text: 'Villa Sol it is. Rahul, tap Yes, book it when you are ready.' };
  const vote = room?.server.trip().decisions.find((d) => d.decision_id === 'd_villa');
  if (vote?.status === 'closed' && !vote.mandate && !mandateAsked) {
    mandateAsked = true;
    return { tools: [{ name: 'set_mandate', input: { decision_id: 'd_villa', choice_index: 0, cap_minor: 5500000, refundable_only: true, payer_person_id: 'p_rahul' } }] };
  }
  return { tools: [{ name: 'stay_silent', input: { reason: 'nothing for Go' } }] };
}

beforeAll(async () => {
  room = await startMoneyRoom({ script });
  rahul = await room.vault.passkeyFor('p_rahul', { withCard: true });
}, 30_000);
afterAll(async () => {
  await room.stop();
});

describe('G4: Go books with two keys', () => {
  it('vote, mandate, Yes book it, pay card, Approve, Face ID, booked, expense, cards', async () => {
    const s = room.server;
    await s.createTrip(goaWithStayVote('open'));
    for (const [person, option] of [['p_rahul', 0], ['p_priya', 0], ['p_arjun', 1], ['p_meher', 0], ['p_kabir', 0]] as const) {
      await s.vote('d_villa', person, option);
    }
    // The fifth vote closes it in the simulator (everyone voted); close it by time only if it is still open.
    if (s.trip().decisions.find((d) => d.decision_id === 'd_villa')?.status === 'open') await s.closeVoteByTime('d_villa');
    // Whether or not the closed vote woke Go, Rahul's message does.
    await s.say('p_rahul', '@Go Villa Sol it is, I will pay for it');

    // The composer sets the mandate and posts the mandate card with its line.
    const mandate = await s.waitFor(() => s.trip().decisions.find((d) => d.decision_id === 'd_villa')?.mandate, 10_000);
    expect(mandate).toMatchObject({ choice_index: 0, cap_minor: 5500000, payer_person_id: 'p_rahul', refundable_only: true });
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

    // Only the payer may approve; the payer gets the vault page.
    expect(await s.tap(card.card_id, 'approve', 'p_priya')).toEqual({ result: 'refused', toast: 'Only Rahul can approve this payment.' });
    const open = await s.tap(card.card_id, 'approve', 'p_rahul');
    if (open.result !== 'open') throw new Error(JSON.stringify(open));
    expect(open.url).toMatch(/^https:\/\/vault\.test\/p\//);

    // Face ID on the vault page, then the FakeRail, then the signed callback.
    expect(await room.vault.approve(open.url, rahul)).toMatchObject({ state: 'paid' });
    const booking = await s.waitFor(() => s.trip().bookings[0], 10_000);
    expect(booking).toMatchObject({ approval_id: card.approval_id, decision_id: 'd_villa', amount_minor: 5420000, kind: 'stay', ref: 'IXG-7Q2K9' });
    const expense = await s.waitFor(() => s.trip().expenses[0], 10_000);
    expect(expense).toMatchObject({ category: 'stay', amount_minor: 5420000, paid_by_person_id: 'p_rahul', booking_id: booking.booking_id });
    expect(expense.split_person_ids).toHaveLength(s.trip().people.length);
    await s.waitFor(() => s.messages().find((m) => m.card?.kind === 'ticket'), 10_000);
    await s.waitFor(() => s.messages().find((m) => m.card?.card_id === card.card_id && m.card.kind === 'pay' && m.card.state === 'paid'), 10_000);

    expect(s.countWrites(`go_paid_${card.approval_id}_booking`)).toBe(1);
    expect(room.vault.rail.charges).toHaveLength(1);
    expect(await room.pay.withoutBothKeys()).toEqual({ count: 0, paid: 1, charged: 1 });
    expect(JSON.stringify(s.writes)).not.toMatch(/\u2014/);
  }, 60_000);
});
