import * as C from '@go/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markConfirming, markFailed, markPaid, reconcile, sweepPayments } from '../finish.js';
import { getPayment, patchPayment, transition, unsettled } from '../store.js';
import { FakeCallError, moneyKit, type MoneyKit } from './kit.js';

let k: MoneyKit;
let paymentId: string;
let cardId: string;
let approvalId: string;

beforeEach(async () => {
  k = await moneyKit();
  const r = await k.ask();
  if (!('cardId' in r)) throw new Error(r.refused);
  paymentId = r.paymentId;
  cardId = r.cardId;
  approvalId = [...k.server.approvals.keys()][0] as string;
});
afterEach(async () => {
  await k.drop();
});

const paid = async () => {
  const row = await markPaid(k.deps, { tripId: 't_goa', approvalId, railRef: `fake_${approvalId}` });
  if (row) await reconcile(k.deps, row.payment_id);
};

describe("the rooms a stay's expenses split by (REV4 B6)", () => {
  const PICKED = [
    { label: 'Deluxe room', person_ids: ['p_rahul', 'p_priya', 'p_arjun'], price_minor: 3_600_000 },
    { label: 'Standard room', person_ids: ['p_meher', 'p_kabir'], price_minor: 1_800_000 },
  ];

  it('are the ones picked when the payment was asked: the rooms card closes at payment, and a later pick changes nothing', async () => {
    const r2 = await moneyKit();
    try {
      let picked: typeof PICKED | null = PICKED;
      r2.deps.rooms = async (row) => (row.decision_id === 'd_villa' && row.option_ref ? picked : null);
      const asked = await r2.ask();
      if (!('cardId' in asked)) throw new Error(asked.refused);
      expect((await getPayment(r2.pool, asked.paymentId))?.rooms).toEqual(PICKED);
      // A tap on the card after the payment was asked: never what the finish reads.
      picked = [{ label: 'Villa', person_ids: ['p_rahul'], price_minor: 1 }];
      const approval = [...r2.server.approvals.keys()][0] as string;
      const row = await markPaid(r2.deps, { tripId: 't_goa', approvalId: approval, railRef: `fake_${approval}` });
      await reconcile(r2.deps, row!.payment_id);
      expect(r2.server.writesOf('add_expense').map((w) => [w.params.split_person_ids, w.params.amount_minor])).toEqual([
        [['p_rahul', 'p_priya', 'p_arjun'], 3_613_333],
        [['p_meher', 'p_kabir'], 1_806_667],
      ]);
    } finally {
      await r2.drop();
    }
  });

  it('are none when nobody picked, or the pick did not read: the payment is asked all the same, one expense across everyone', async () => {
    for (const [rooms, kept] of [
      [async () => null, []],
      [async () => {
        throw new Error('the rooms cards table is busy');
      }, null],
    ] as const) {
      const r2 = await moneyKit();
      try {
        r2.deps.rooms = rooms;
        const asked = await r2.ask();
        if (!('cardId' in asked)) throw new Error(asked.refused);
        expect((await getPayment(r2.pool, asked.paymentId))?.rooms).toEqual(kept);
      } finally {
        await r2.drop();
      }
    }
  });
});

describe('a paid payment', () => {
  it('confirms the hold, records the booking and the expense, updates the pay card and posts the ticket', async () => {
    await paid();
    expect(k.travel.confirms).toEqual([{ holdId: 'hold_1', paid: { approvalId, railRef: `fake_${approvalId}` } }]);
    expect(k.server.writesOf('add_booking')[0]?.params).toMatchObject({
      request_id: `go_paid_${approvalId}_booking`,
      kind: 'stay',
      title: 'Villa Sol, 3 nights',
      vendor: 'ixigo',
      ref: 'IXG-7Q2K9',
      amount_minor: 5420000,
      currency: 'INR',
      payer_person_id: 'p_rahul',
      for_person_ids: ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir'],
      refundable_until: '2026-11-01T18:29:59Z',
      starts_at: '2026-11-06T14:00:00+05:30',
      place: { name: 'Villa Sol', address: 'Anjuna, North Goa' },
      decision_id: 'd_villa',
      approval_id: approvalId,
    });
    expect(k.server.approvals.get(approvalId)?.used).toBe(true);
    const bookingId = k.server.trip('t_goa').bookings[0]?.booking_id;
    expect(k.server.writesOf('add_expense')[0]?.params).toMatchObject({
      request_id: `go_paid_${approvalId}_expense`,
      paid_by_person_id: 'p_rahul',
      amount_minor: 5420000,
      category: 'stay',
      note: 'Villa Sol, 3 nights',
      split_person_ids: ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir'],
      booking_id: bookingId,
      // 1.1 B4: paid through the vault, so the Server records it approved at once, never pending.
      approval_id: approvalId,
    });
    const card = C.PayCard.parse(k.server.cards.get(cardId));
    expect(card.state).toBe('paid');
    expect(card.actions ?? null).toBeNull();
    const ticket = k.server.posts.at(-1);
    // What was booked, never the money: the Server posts its own line for the expense (GO-TEAM-FINAL §8).
    expect(ticket?.text).toBe('Booked Villa Sol, 3 nights!');
    expect(k.server.writesOf('post_message').at(-1)?.params.mentions ?? []).toEqual([]);
    expect(ticket?.card).toMatchObject({ kind: 'ticket', card_id: `c_ticket_${approvalId}`, booking_id: bookingId });
    expect(await getPayment(k.pool, paymentId)).toMatchObject({ state: 'paid', booking_id: bookingId, ticket_posted_at: expect.any(Date) });
    expect(await unsettled(k.pool, k.now())).toEqual([]);
  });

  // Saket's test, 11 Oct: the stay comes first. Once it is booked, Go wakes for each person's flights, once.
  it('the stay booked and its ticket up, Go wakes for the next step once', async () => {
    const woke: Array<{ tripId: string; bookingId: string; title: string }> = [];
    const deps = { ...k.deps, stayBooked: async (tripId: string, b: { bookingId: string; title: string }) => void woke.push({ tripId, ...b }) };
    for (let i = 0; i < 2; i++) {
      const row = await markPaid(deps, { tripId: 't_goa', approvalId, railRef: `fake_${approvalId}` });
      if (row) await reconcile(deps, row.payment_id);
    }
    expect(woke).toEqual([{ tripId: 't_goa', bookingId: k.server.trip('t_goa').bookings[0]?.booking_id, title: 'Villa Sol, 3 nights' }]);
  });

  it('does every step once when the vault calls back twice', async () => {
    await paid();
    await paid();
    await reconcile(k.deps, paymentId);
    expect(k.server.writesOf('add_booking')).toHaveLength(1);
    expect(k.server.writesOf('add_expense')).toHaveLength(1);
    expect(k.server.posts.filter((p) => p.card?.kind === 'ticket')).toHaveLength(1);
    expect(k.travel.confirms).toHaveLength(1);
  });

  it('finishes after a step fails, without doing the earlier steps again', async () => {
    k.server.failNext.set('add_expense', new FakeCallError(503, 'the Server is busy'));
    await paid();
    expect(await getPayment(k.pool, paymentId)).toMatchObject({ expense_id: null, attempts: 1, last_error: 'the Server is busy' });
    expect(await sweepPayments(k.deps)).toBe(1);
    expect(k.server.writesOf('add_booking')).toHaveLength(1);
    expect(k.server.writesOf('add_expense')).toHaveLength(1);
    expect((await getPayment(k.pool, paymentId))?.ticket_posted_at).not.toBeNull();
  });

  // REV4 B6: the group shared the villa's rooms (B5's arrangement), so each room's people owe their own room's part.
  const ROOMS = [
    { label: 'Deluxe room', person_ids: ['p_rahul', 'p_priya'], price_minor: 2_400_000 },
    { label: 'Deluxe room', person_ids: ['p_arjun', 'p_meher'], price_minor: 2_400_000 },
    { label: 'Standard room', person_ids: ['p_kabir'], price_minor: 1_800_000 },
  ];

  it('adds one expense a room when the group shared the rooms, each its part of what was paid, split between its people', async () => {
    // The rooms the payment kept when it was asked.
    await patchPayment(k.pool, paymentId, { rooms: ROOMS }, k.now());
    await paid();
    const expenses = k.server.writesOf('add_expense').map((w) => w.params);
    expect(expenses).toHaveLength(3);
    expect(expenses.map((e) => [e.request_id, e.amount_minor, e.split_person_ids, e.note])).toEqual([
      [`go_paid_${approvalId}_expense_room1`, 1_970_909, ['p_rahul', 'p_priya'], 'Villa Sol, 3 nights, Deluxe room'],
      [`go_paid_${approvalId}_expense_room2`, 1_970_909, ['p_arjun', 'p_meher'], 'Villa Sol, 3 nights, Deluxe room'],
      [`go_paid_${approvalId}_expense_room3`, 1_478_182, ['p_kabir'], 'Villa Sol, 3 nights, Standard room'],
    ]);
    const bookingId = k.server.trip('t_goa').bookings[0]?.booking_id;
    for (const e of expenses) expect(e).toMatchObject({ paid_by_person_id: 'p_rahul', currency: 'INR', category: 'stay', booking_id: bookingId, approval_id: approvalId });
    expect(expenses.reduce((s, e) => s + Number(e.amount_minor), 0)).toBe(5_420_000);
    expect(k.server.posts.at(-1)?.text).toBe('Booked Villa Sol, 3 nights!');
    expect((await getPayment(k.pool, paymentId))?.expense_id).toBe(k.server.trip('t_goa').expenses[0]?.expense_id);
  });

  it("adds each room's expense once, whether the vault calls back twice or a room's expense fails halfway", async () => {
    await patchPayment(k.pool, paymentId, { rooms: ROOMS }, k.now());
    // The second room's expense fails once: the first is in, the rest are not.
    const request = k.deps.link.request.bind(k.deps.link);
    let calls = 0;
    k.deps.link = { ...k.deps.link, request: (async (method: string, params: Record<string, unknown>) => {
      if (method === 'add_expense' && ++calls === 2) throw new FakeCallError(503, 'the Server is busy');
      return request(method as never, params as never);
    }) as unknown as typeof k.deps.link.request };
    await paid();
    expect(await getPayment(k.pool, paymentId)).toMatchObject({ expense_id: null, attempts: 1 });
    await sweepPayments(k.deps);
    await paid();
    await reconcile(k.deps, paymentId);
    expect(k.server.writesOf('add_expense').map((w) => w.params.request_id)).toEqual([
      `go_paid_${approvalId}_expense_room1`, `go_paid_${approvalId}_expense_room2`, `go_paid_${approvalId}_expense_room3`,
    ]);
    expect(k.server.trip('t_goa').expenses).toHaveLength(3);
    expect(k.server.posts.filter((p) => p.card?.kind === 'ticket')).toHaveLength(1);
  });

  it('adds one expense across everyone when no rooms were picked, or the rooms cannot split it', async () => {
    await patchPayment(k.pool, paymentId, { rooms: [] }, k.now());
    await paid();
    expect(k.server.writesOf('add_expense').map((w) => w.params)).toEqual([
      expect.objectContaining({ request_id: `go_paid_${approvalId}_expense`, amount_minor: 5_420_000, split_person_ids: ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir'] }),
    ]);
    expect(k.server.posts.at(-1)?.text).toBe('Booked Villa Sol, 3 nights!');
  });

  it('keeps trying when the travel layer has not confirmed yet', async () => {
    k.travel.failConfirm = true;
    await paid();
    expect(k.server.writesOf('add_booking')).toEqual([]);
    k.travel.failConfirm = false;
    await sweepPayments(k.deps);
    expect(k.server.writesOf('add_booking')).toHaveLength(1);
  });

  it('backs off a paid payment after 20 tries, never drops it, and logs an error on the 20th', async () => {
    k.travel.failConfirm = true;
    await markPaid(k.deps, { tripId: 't_goa', approvalId, railRef: `fake_${approvalId}` });
    await k.pool.query('update payments set attempts = 19');
    await reconcile(k.deps, paymentId);
    expect((await getPayment(k.pool, paymentId))?.attempts).toBe(20);
    expect(k.lines.join('\n')).toContain('still not booked after 20 tries');
    expect(await unsettled(k.pool, k.now())).toEqual([]);
    k.advance(11 * 60_000);
    expect(await unsettled(k.pool, k.now())).toEqual([paymentId]);
    k.travel.failConfirm = false;
    await sweepPayments(k.deps);
    expect(k.server.writesOf('add_booking')).toHaveLength(1);
  });
});

describe('a payment that did not happen', () => {
  it('after a failed charge: releases the approval, marks the card failed and says why, without card details', async () => {
    await markFailed(k.deps, { tripId: 't_goa', approvalId, reason: 'card_declined' });
    await reconcile(k.deps, paymentId);
    expect(k.server.writesOf('cancel_spend_approval')[0]?.params).toMatchObject({
      request_id: `go_failed_${approvalId}_release`,
      approval_id: approvalId,
      reason: 'payment_failed',
    });
    expect(k.server.cards.get(cardId)).toMatchObject({ state: 'failed' });
    expect(k.server.posts.at(-1)?.text).toBe(
      "Rahul, the payment for Villa Sol didn't go through (the bank declined the card). Nothing was charged. Want to try again?",
    );
    // Go addresses the payer, so the line carries the mention and Rahul gets a push.
    expect(k.server.writesOf('post_message').at(-1)?.params.mentions).toEqual(['p_rahul']);
  });

  it('ignores a failure for a payment that already went through', async () => {
    await paid();
    expect((await markFailed(k.deps, { tripId: 't_goa', approvalId, reason: 'rail_error' }))?.state).toBe('paid');
    expect((await getPayment(k.pool, paymentId))?.state).toBe('paid');
  });

  it('after a decline: releases as payer_declined and holds off once', async () => {
    await transition(k.pool, paymentId, ['waiting'], 'declined', { release_reason: 'payer_declined' }, k.now());
    await reconcile(k.deps, paymentId);
    await reconcile(k.deps, paymentId);
    expect(k.server.writesOf('cancel_spend_approval').map((w) => w.params.reason)).toEqual(['payer_declined']);
    expect(k.vault.voids).toEqual([approvalId]);
    expect(k.server.cards.get(cardId)).toMatchObject({ state: 'declined' });
    expect(k.server.posts.filter((p) => p.text === 'Holding off on Villa Sol for now.')).toHaveLength(1);
  });

  // The Server team's GO-TEAM-FINAL §6: after Decline the card kept live Approve and Decline for 46 s, while the release
  // waited on a failed vault call and the sweep. The card goes first now.
  it('after a decline the card says so at once, with no buttons, even while the vault cannot be reached', async () => {
    await transition(k.pool, paymentId, ['waiting'], 'declined', { release_reason: 'payer_declined' }, k.now());
    k.vault.failVoid = true;
    await reconcile(k.deps, paymentId);
    const card = C.PayCard.parse(k.server.cards.get(cardId));
    expect(card.state).toBe('declined');
    expect(card.actions ?? []).toEqual([]);
    expect(k.server.writesOf('cancel_spend_approval')).toEqual([]);
    // The sweep releases it later, and the card is not replaced again.
    const replaced = k.server.writesOf('replace_card').length;
    k.vault.failVoid = false;
    await reconcile(k.deps, paymentId);
    expect(k.server.writesOf('cancel_spend_approval')).toHaveLength(1);
    expect(k.server.writesOf('replace_card')).toHaveLength(replaced);
  });

  it('releases nothing until the vault has stopped the pay links, then does both once', async () => {
    await transition(k.pool, paymentId, ['waiting'], 'declined', { release_reason: 'payer_declined' }, k.now());
    k.vault.failVoid = true;
    await reconcile(k.deps, paymentId);
    expect(k.server.writesOf('cancel_spend_approval')).toEqual([]);
    expect((await getPayment(k.pool, paymentId))?.released_at).toBeNull();
    k.vault.failVoid = false;
    await sweepPayments(k.deps);
    await reconcile(k.deps, paymentId);
    expect(k.vault.voids).toEqual([approvalId]);
    expect(k.server.writesOf('cancel_spend_approval')).toHaveLength(1);
  });

  it('expires 120 s after the approval ran out, quietly, with a way to start again', async () => {
    k.setNow(new Date('2026-10-05T09:11:59Z'));
    await sweepPayments(k.deps);
    expect((await getPayment(k.pool, paymentId))?.state).toBe('waiting');
    k.setNow(new Date('2026-10-05T09:12:01Z'));
    await sweepPayments(k.deps);
    expect((await getPayment(k.pool, paymentId))?.state).toBe('expired');
    expect(k.server.writesOf('cancel_spend_approval')[0]?.params.reason).toBe('expired');
    const card = C.PayCard.parse(k.server.cards.get(cardId));
    expect(card.state).toBe('expired');
    expect(card.actions?.[0]).toMatchObject({ action_id: 'approve', label: 'Start again' });
    expect(k.server.posts.filter((p) => p.text !== null && p.card === null)).toEqual([]);
  });

  it('gives up an ask stuck halfway and releases its approval', async () => {
    await k.pool.query("update payments set state = 'asking', created_at = '2026-10-05T08:58:00Z'");
    await sweepPayments(k.deps);
    expect(await getPayment(k.pool, paymentId)).toMatchObject({ state: 'refused', refused_reason: 'interrupted', released_at: expect.any(Date) });
    expect(k.server.writesOf('cancel_spend_approval')[0]?.params.reason).toBe('other');
  });
});

describe('a payment the bank has not confirmed yet', () => {
  it('waits on the bank: the card says so, it never expires, and it finishes when the vault says paid', async () => {
    await markConfirming(k.deps, { tripId: 't_goa', approvalId });
    await reconcile(k.deps, paymentId);
    const card = C.PayCard.parse(k.server.cards.get(cardId));
    expect(card).toMatchObject({ state: 'waiting', fallback_text: expect.stringContaining('with the bank') });
    expect(card.actions ?? null).toBeNull();
    // Long after the approval ran out, the sweep leaves it alone and releases nothing.
    k.setNow(new Date('2026-10-05T09:20:00Z'));
    await sweepPayments(k.deps);
    expect((await getPayment(k.pool, paymentId))?.state).toBe('confirming');
    expect(k.server.writesOf('cancel_spend_approval')).toEqual([]);
    await markPaid(k.deps, { tripId: 't_goa', approvalId, railRef: `fake_${approvalId}` });
    await reconcile(k.deps, paymentId);
    expect(k.server.writesOf('add_booking')).toHaveLength(1);
    expect(C.PayCard.parse(k.server.cards.get(cardId)).state).toBe('paid');
  });

  it('says a person is checking once the vault stops asking the bank, and stays open', async () => {
    await markConfirming(k.deps, { tripId: 't_goa', approvalId });
    await reconcile(k.deps, paymentId);
    await markConfirming(k.deps, { tripId: 't_goa', approvalId, checking: true });
    await reconcile(k.deps, paymentId);
    expect(C.PayCard.parse(k.server.cards.get(cardId)).fallback_text).toBe("We couldn't confirm this payment. Don't pay again; we're checking.");
    expect(await getPayment(k.pool, paymentId)).toMatchObject({ state: 'confirming', card_state: 'checking' });
    expect(await k.ask()).toMatchObject({ code: 'approval_outstanding' });
    expect(k.server.writesOf('cancel_spend_approval')).toEqual([]);
  });

  it('turns failed, with nothing charged, when the vault says the charge failed', async () => {
    await markConfirming(k.deps, { tripId: 't_goa', approvalId });
    await markFailed(k.deps, { tripId: 't_goa', approvalId, reason: 'card_declined' });
    await reconcile(k.deps, paymentId);
    expect(await getPayment(k.pool, paymentId)).toMatchObject({ state: 'failed', release_reason: 'payment_failed' });
    expect(k.server.writesOf('cancel_spend_approval')).toHaveLength(1);
  });

  it('is the vote\'s open payment, so a second ask is refused', async () => {
    await markConfirming(k.deps, { tripId: 't_goa', approvalId });
    expect(await k.ask()).toMatchObject({ code: 'approval_outstanding' });
    expect(k.server.writesOf('request_spend_approval')).toHaveLength(1);
  });
});
