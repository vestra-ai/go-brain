import type * as C from '@go/contract';
import type { Confirmed } from '../travel/travel.js';
import { payCardOf } from './ask.js';
import { ticketCard } from './cards.js';
import { payerOf, postLine, type MoneyDeps } from './deps.js';
import { rid } from './ids.js';
import type { Booked } from './pay.js';
import { roomParts } from './rooms.js';
import {
  byApproval,
  bumpAttempt,
  expireOverdue,
  getPayment,
  interruptStale,
  patchPayment,
  STEP_TRIES,
  transition,
  unsettled,
  type PaymentRow,
  type PaymentState,
  type ReleaseReason,
} from './store.js';
import { bookedLine, categoryFor, clip, declinedLine, failedLine, money, ticketPaidLine } from './words.js';

export type VaultFailReason = 'card_declined' | 'needs_authentication' | 'rail_error' | 'rail_not_ready';

const RELEASE: Record<'declined' | 'expired' | 'failed' | 'refused', ReleaseReason> = {
  declined: 'payer_declined',
  expired: 'expired',
  failed: 'payment_failed',
  refused: 'other',
};

/** The vault says the rail charged. Money moved, so the booking is finished whatever the row said before. */
export async function markPaid(d: MoneyDeps, p: { tripId: string; approvalId: string; railRef: string }): Promise<PaymentRow | null> {
  const row = await byApproval(d.pool, p.tripId, p.approvalId);
  if (!row) return null;
  if (row.state !== 'paid') {
    if (row.state !== 'waiting') d.log.warn({ payment_id: row.payment_id, was: row.state }, 'the vault paid a payment Go had closed; finishing it');
    const from: PaymentState[] = ['asking', 'waiting', 'confirming', 'expired', 'declined', 'failed', 'refused'];
    await transition(d.pool, row.payment_id, from, 'paid', { rail_ref: p.railRef }, d.now());
  }
  return getPayment(d.pool, row.payment_id);
}

/**
 * The Server paid it itself on the payer's tap (payment.completed: the demo, no vault, no money), wrote its booking and
 * expense, and set the card paid. The row takes the Server's ids and is paid: nothing expires, fails or declines it from
 * here (every timer and tap is on a waiting row), and the finish books nothing. Null: no payment of Go's for it.
 */
export async function markPaidByServer(
  d: MoneyDeps,
  p: { tripId: string; approvalId: string; bookingId: string | null; expenseId: string | null },
): Promise<PaymentRow | null> {
  const row = await byApproval(d.pool, p.tripId, p.approvalId);
  if (!row) return null;
  if (row.state === 'paid') return row;
  if (row.state !== 'waiting') d.log.warn({ payment_id: row.payment_id, was: row.state }, 'the Server paid a payment Go had closed; finishing it');
  const from: PaymentState[] = ['asking', 'waiting', 'confirming', 'expired', 'declined', 'failed', 'refused'];
  await transition(d.pool, row.payment_id, from, 'paid', { paid_by: 'server', booking_id: p.bookingId, expense_id: p.expenseId, card_state: 'paid' }, d.now());
  return getPayment(d.pool, row.payment_id);
}

/**
 * A paid booking's ticket card (a person's own, for them alone), with Go's line when Go booked it. Its request id comes
 * from the approval, so a retry posts it once.
 */
export async function postTicket(d: Pick<MoneyDeps, 'link'>, b: Booked, line?: string): Promise<void> {
  await d.link.request('post_message', {
    // A person's ticket keeps 'ticket' for its paid line (finishTicketPaid), so its card has its own id.
    request_id: rid('go_paid', b.approvalId, b.personId ? 'ticket_card' : 'ticket'),
    trip_id: b.tripId,
    ...(line ? { text: line } : {}),
    card: ticketCard({
      cardId: rid('c_ticket', b.approvalId), bookingId: b.bookingId, title: b.title, ref: b.ref, refundableUntil: b.refundableUntil,
      simulated: b.simulated, detail: b.detail ?? null,
    }),
    ...(b.personId ? { visible_to_person_ids: [b.personId] } : {}),
  });
}

/** The vault says the charge failed. Nothing was charged; a payment already paid stays paid. */
export async function markFailed(d: MoneyDeps, p: { tripId: string; approvalId: string; reason: VaultFailReason }): Promise<PaymentRow | null> {
  const row = await byApproval(d.pool, p.tripId, p.approvalId);
  if (!row) return null;
  await transition(d.pool, row.payment_id, ['asking', 'waiting', 'confirming', 'expired'], 'failed', { fail_reason: p.reason, release_reason: 'payment_failed' }, d.now());
  return getPayment(d.pool, row.payment_id);
}

/**
 * The vault says the bank has not answered about a charge yet. The payment waits on it: it never expires and cannot be
 * started again until the vault says paid or failed.
 */
export async function markConfirming(
  d: MoneyDeps,
  p: { tripId: string; approvalId: string; checking?: boolean },
): Promise<PaymentRow | null> {
  const row = await byApproval(d.pool, p.tripId, p.approvalId);
  if (!row) return null;
  try {
    await transition(d.pool, row.payment_id, ['waiting', 'expired'], 'confirming', {}, d.now());
  } catch (e) {
    // A fresh payment for the same vote is already open: this one stays closed, and a person has to look at it.
    if ((e as { code?: string }).code !== '23505') throw e;
    d.log.error({ payment_id: row.payment_id }, 'the vault is confirming a payment Go had closed while a fresh one is open');
  }
  // The vault will not ask the bank again: a person checks the charge, and the card says so.
  if (p.checking && !row.checking_at) await patchPayment(d.pool, row.payment_id, { checking_at: d.now() }, d.now());
  return getPayment(d.pool, row.payment_id);
}

/**
 * Brings the Server and the room in line with one payments row. Each step runs once, with an id made from
 * the approval, and the row records it as it lands. Safe to call any time, as often as needed.
 */
export async function reconcile(d: MoneyDeps, paymentId: string): Promise<void> {
  const row = await getPayment(d.pool, paymentId);
  if (!row || row.state === 'asking' || row.state === 'waiting') return;
  try {
    if (row.state === 'paid') await finishPaid(d, row);
    else if (row.state === 'confirming') await showConfirming(d, row);
    else await finishClosed(d, row, row.state);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'unknown';
    const tries = await bumpAttempt(d.pool, paymentId, message, d.now());
    if (row.state === 'paid' && tries === STEP_TRIES) {
      d.log.error({ payment_id: paymentId, err: message }, 'a paid payment is still not booked after 20 tries; the sweep keeps trying every 10 minutes');
    } else {
      d.log.warn({ payment_id: paymentId, err: message }, 'a payment step failed; the sweep will try again');
    }
  }
}

async function finishPaid(d: MoneyDeps, row: PaymentRow): Promise<void> {
  if (row.kind === 'ticket') return finishTicketPaid(d, row);
  if (row.paid_by === 'server') return finishServerPaid(d, row);
  const approvalId = row.approval_id;
  if (!approvalId || !row.hold_id || !row.rail_ref || row.amount_minor === null || !row.currency) {
    throw new Error('a paid payment is missing its approval, hold or rail reference');
  }
  const amountMinor = row.amount_minor;
  const id = (step: string) => rid('go_paid', approvalId, step);

  // 1. The travel layer confirms the hold the rail paid for.
  let confirmed: Confirmed | null = row.confirmed;
  if (!confirmed) {
    const travel = d.travel();
    if (!travel) throw new Error('no travel layer to confirm the booking');
    confirmed = await travel.confirm(row.hold_id, { approvalId, railRef: row.rail_ref });
    await patchPayment(d.pool, row.payment_id, { confirmed }, d.now());
  }
  const refundableUntil = confirmed.refundableUntil ?? row.refundable_until;

  // 2. The booking, carrying the approval it was paid with. The Server marks the approval used.
  let bookingId = row.booking_id;
  if (!bookingId) {
    const r = await d.link.request('add_booking', {
      request_id: id('booking'),
      trip_id: row.trip_id,
      kind: confirmed.kind,
      title: clip(confirmed.title, 120),
      vendor: clip(confirmed.vendor, 80),
      ref: clip(confirmed.ref, 80),
      amount_minor: amountMinor,
      currency: row.currency,
      payer_person_id: row.payer_person_id,
      for_person_ids: row.for_person_ids,
      decision_id: row.decision_id,
      approval_id: approvalId,
      ...(refundableUntil ? { refundable_until: refundableUntil } : {}),
      ...(confirmed.startsAt ? { starts_at: confirmed.startsAt } : {}),
      ...(confirmed.endsAt ? { ends_at: confirmed.endsAt } : {}),
      ...(confirmed.place ? { place: confirmed.place } : {}),
      ...(confirmed.journey ? { journey: confirmed.journey } : {}),
      ...(confirmed.imageUrl ? { image_url: confirmed.imageUrl } : {}),
    });
    bookingId = r.booking_id;
    await patchPayment(d.pool, row.payment_id, { booking_id: bookingId }, d.now());
  }

  // 3. The expense: the payer paid, split across the trip's people. A stay whose rooms the group shared (REV4 B6) is one
  //    expense a room, split between that room's people, each its part of what was paid, by the rooms kept when the payment
  //    was asked; each has its own request id, so a finish run again adds none of them twice. The row keeps the first
  //    room's id: the expenses are done.
  const rooms = confirmed.kind === 'stay' && row.rooms?.length ? roomParts(amountMinor, row.rooms) : null;
  if (!row.expense_id) {
    const expense = {
      trip_id: row.trip_id,
      paid_by_person_id: row.payer_person_id,
      currency: row.currency,
      category: categoryFor(confirmed.kind),
      booking_id: bookingId,
      // 1.1: the vault payment it was paid with.
      approval_id: approvalId,
    };
    let first: string | null = null;
    if (rooms) {
      for (const [i, part] of rooms.entries()) {
        if (part.amount_minor <= 0) continue;
        const r = await d.link.request('add_expense', {
          ...expense,
          request_id: id(`expense_room${i + 1}`),
          amount_minor: part.amount_minor,
          note: clip(`${confirmed.title}, ${part.room.label}`, 120),
          split_person_ids: part.room.person_ids,
        });
        first ??= r.expense_id;
      }
    } else {
      const r = await d.link.request('add_expense', {
        ...expense,
        request_id: id('expense'),
        amount_minor: amountMinor,
        note: clip(confirmed.title, 120),
        split_person_ids: row.for_person_ids,
      });
      first = r.expense_id;
    }
    await patchPayment(d.pool, row.payment_id, { expense_id: first }, d.now());
  }

  // 4. The pay card shows paid, with no buttons and no pin.
  if (row.card_state !== 'paid') {
    const card = payCardOf(row, 'paid');
    if (card) await d.link.request('replace_card', { trip_id: row.trip_id, card });
    await patchPayment(d.pool, row.payment_id, { card_state: 'paid' }, d.now());
  }

  // 5. The ticket, with one line in Go's voice: what was booked, never the money, which the Server's own line says.
  if (!row.ticket_posted_at) {
    const simulated = confirmed.simulated === true;
    const b: Booked = { tripId: row.trip_id, approvalId, bookingId, title: confirmed.title, ref: confirmed.ref, refundableUntil, simulated, personId: null };
    await postTicket(d, b, bookedLine({ title: confirmed.title, simulated }));
    // 6. The stay booked, each person's flights are next: before the ticket is marked posted, so a failed wake is tried
    //    again with it (the post and the wake are each once by their ids).
    if (confirmed.kind === 'stay') await d.stayBooked?.(row.trip_id, { bookingId, title: confirmed.title });
    await patchPayment(d.pool, row.payment_id, { ticket_posted_at: d.now() }, d.now());
  }
}

/**
 * A group's payment the Server paid and booked itself (payment.completed): its booking, expense, pay card and "booked" line
 * are the Server's, so Go adds none of them. The ticket card, alone, then for a stay the same next step as finishPaid's
 * (each person's flights). Its words come from the Server's booking, read once and kept with the payment.
 */
async function finishServerPaid(d: MoneyDeps, row: PaymentRow): Promise<void> {
  if (row.ticket_posted_at) return;
  if (!row.approval_id) throw new Error('a payment the Server paid is missing its approval');
  if (!row.booking_id) {
    d.log.warn({ payment_id: row.payment_id }, 'the Server paid a payment with no booking named: no ticket card to post');
    await patchPayment(d.pool, row.payment_id, { ticket_posted_at: d.now() }, d.now());
    return;
  }
  let confirmed = row.confirmed;
  if (!confirmed) {
    const trip = await d.link.request('read_trip', { trip_id: row.trip_id });
    const found = trip.bookings.find((x) => x.booking_id === row.booking_id);
    if (found) {
      confirmed = confirmedOf(found);
      await patchPayment(d.pool, row.payment_id, { confirmed }, d.now());
    }
  }
  const b: Booked = {
    tripId: row.trip_id, approvalId: row.approval_id, bookingId: row.booking_id, title: confirmed?.title ?? row.label, ref: confirmed?.ref ?? null,
    refundableUntil: confirmed?.refundableUntil ?? row.refundable_until, simulated: true, personId: null,
  };
  await postTicket(d, b);
  // As finishPaid's step 6, before the ticket is marked posted. A group's payment is a stay's unless the Server's booking
  // says otherwise.
  if ((confirmed?.kind ?? 'stay') === 'stay') await d.stayBooked?.(row.trip_id, { bookingId: row.booking_id, title: b.title });
  await patchPayment(d.pool, row.payment_id, { ticket_posted_at: d.now() }, d.now());
}

/** The Server's booking, as the travel layer would have confirmed it. */
function confirmedOf(b: C.Booking): Confirmed {
  return {
    ref: b.ref, vendor: b.vendor, title: b.title, kind: b.kind,
    ...(b.starts_at ? { startsAt: b.starts_at } : {}),
    ...(b.ends_at ? { endsAt: b.ends_at } : {}),
    ...(b.refundable_until ? { refundableUntil: b.refundable_until } : {}),
    ...(b.image_url ? { imageUrl: b.image_url } : {}),
    ...(b.place ? { place: b.place } : {}),
    ...(b.journey ? { journey: b.journey } : {}),
  };
}

/**
 * A traveller's ticket, paid: one line in Go's voice, naming the traveller. Its booking and ticket card are its own flow's
 * (the flight or bus booking that asked for it hears onPaid, then calls booked); on Go's test rails nothing real was paid,
 * and the line says so.
 */
async function finishTicketPaid(d: MoneyDeps, row: PaymentRow): Promise<void> {
  // A ticket with a pay card (askForTicketCard): the card shows paid, with no buttons, as a group's does.
  if (row.card_id && row.card_state !== 'paid') {
    const card = payCardOf(row, 'paid');
    if (card) await d.link.request('replace_card', { trip_id: row.trip_id, card });
    await patchPayment(d.pool, row.payment_id, { card_state: 'paid' }, d.now());
  }
  if (row.ticket_posted_at) return;
  // The Server paid it itself (payment.completed) and said so in the room: no second line.
  if (row.paid_by !== 'server') {
    if (!row.approval_id || row.amount_minor === null || !row.currency) throw new Error('a paid ticket is missing its approval or amount');
    const text = ticketPaidLine({
      what: row.label, payer: row.payer_name, amount: money(row.amount_minor, row.currency), simulated: row.payment_kind !== 'ixigo',
    });
    await postLine(d, row.trip_id, text, rid('go_paid', row.approval_id, 'ticket'), payerOf(row));
  }
  await patchPayment(d.pool, row.payment_id, { ticket_posted_at: d.now() }, d.now());
}

/**
 * The pay card says the bank is being asked (or, once the vault gave up asking, that a person is checking), with no
 * buttons, so nobody approves or starts it again.
 */
async function showConfirming(d: MoneyDeps, row: PaymentRow): Promise<void> {
  const look = row.checking_at ? 'checking' : 'confirming';
  if (!row.card_id || row.card_state === look) return;
  const card = payCardOf(row, look);
  if (card) await d.link.request('replace_card', { trip_id: row.trip_id, card });
  await patchPayment(d.pool, row.payment_id, { card_state: look }, d.now());
}

async function finishClosed(d: MoneyDeps, row: PaymentRow, state: 'declined' | 'expired' | 'failed' | 'refused'): Promise<void> {
  const key = row.approval_id ?? row.payment_id;
  const id = (step: string) => rid(`go_${state}`, key, step);

  // 1. The pay card says what happened, with no buttons left, first: the room sees it at once (the Server team's
  //    GO-TEAM-FINAL §6: a declined card kept live Approve and Decline for 46 s, while a vault call failed below and the
  //    sweep came back). Nothing can be paid from it either way: the payer's own Decline closed the row.
  if (state !== 'refused' && row.card_id && row.card_state !== state) {
    const card = payCardOf(row, state);
    try {
      if (card) await d.link.request('replace_card', { trip_id: row.trip_id, card });
    } catch (e) {
      // A card the Server refuses (it never reached the room: prod, 10 Oct, "card … is not on one of Go's messages") has
      // nothing to show: the approval is let go all the same. The Server unreachable (5xx) tries again on the sweep.
      const code = (e as { code?: unknown }).code;
      if (typeof code !== 'number' || code < 400 || code >= 500) throw e;
      d.log.warn({ payment_id: row.payment_id, err: e instanceof Error ? e.message : String(e) }, "a pay card the Server doesn't have was not updated; the payment closes all the same");
    }
    await patchPayment(d.pool, row.payment_id, { card_state: state }, d.now());
  }

  // 2. Let the Server's approval go, so the vote can be asked again. The vault first stops every pay link for it, so no
  //    page can pay after Go let it go; if the vault cannot be reached, nothing is released and the sweep tries again.
  if (row.approval_id && !row.released_at) {
    await d.vault.voidPayLinks(row.approval_id);
    await d.link.request('cancel_spend_approval', {
      request_id: id('release'),
      trip_id: row.trip_id,
      approval_id: row.approval_id,
      reason: row.release_reason ?? RELEASE[state],
    });
    await patchPayment(d.pool, row.payment_id, { released_at: d.now() }, d.now());
  }

  // 3. One line for a decline or a failure. An expiry stays quiet: the card already says it.
  if ((state === 'declined' || state === 'failed') && !row.said_at) {
    const text = state === 'declined' ? declinedLine(row.label) : failedLine({ payer: row.payer_name, what: row.label, reason: row.fail_reason });
    await postLine(d, row.trip_id, text, id('said'), payerOf(row));
    await patchPayment(d.pool, row.payment_id, { said_at: d.now() }, d.now());
  }
}

/** Every 30 s: expire what ran out, give up asks stuck halfway, and finish every payment the room is still waiting on. */
export async function sweepPayments(d: MoneyDeps): Promise<number> {
  const now = d.now();
  await expireOverdue(d.pool, now);
  await interruptStale(d.pool, now);
  const ids = await unsettled(d.pool, now);
  for (const id of ids) await reconcile(d, id);
  return ids.length;
}
