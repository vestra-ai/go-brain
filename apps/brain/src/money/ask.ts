import { MAX_APPROVAL_TTL_SECONDS } from '@go/contract';
import type { TurnCtx } from '../composer/tools.js';
import type { ToServerResult, Trip } from '../door/methods.js';
import { ixigoPage } from '../travel/cards.js';
import type { Hold, Travel } from '../travel/travel.js';
import { payCard, type PayCard, type PayCardLook } from './cards.js';
import type { MoneyDeps } from './deps.js';
import { paymentIdFor, rid } from './ids.js';
import type { Room } from './rooms.js';
import { EXPIRY_GRACE_MS, getPayment, insertAsking, openForDecision, openTicket, paidForDecision, patchPayment, transition, type PaymentRow } from './store.js';
import { payLinkInput } from './taps.js';
import type { PaymentKind } from './vault-client.js';
import { clip, money, plain, refusalWords, type RefusalCode } from './words.js';

export type AskResult = { cardId: string; paymentId: string } | Refused;
type Refused = { refused: string; code: RefusalCode; say: boolean };

/** The ids one ask writes with. The spend request id also names the payments row. */
export interface AskIds {
  spend: string;
  card: string;
  cardId: string;
}

/** How the pay card reaches the room: with Go's message in a turn, or posted by money itself outside one. */
export type Deliver = (card: PayCard) => Promise<void>;

/** In a composer turn: a rerun of a crashed turn repeats these ids. */
export function idsFromTurn(ctx: Pick<TurnCtx, 'stableId'>): AskIds {
  return { spend: ctx.stableId('go_spend'), card: ctx.stableId('go_paycard'), cardId: ctx.stableId('c_pay') };
}

/** Outside a turn: from the event or tap that started the ask, e.g. go_spend_<decision_id>_<event_id>. */
export function idsFrom(trigger: string, decisionId: string): AskIds {
  return { spend: rid('go_spend', decisionId, trigger), card: rid('go_paycard', decisionId, trigger), cardId: rid('c_pay', decisionId, trigger) };
}

export function withTurn(ctx: Pick<TurnCtx, 'cards'>): Deliver {
  return async (card) => {
    ctx.cards.push(card);
  };
}

export function postCard(d: Pick<MoneyDeps, 'link'>, tripId: string, requestId: string): Deliver {
  return async (card) => {
    await d.link.request('post_message', { request_id: requestId, trip_id: tripId, card });
  };
}

/** An ask started by an event or a tap: ids from its trigger, and the card posted right away. */
export function askOutsideTurn(d: MoneyDeps, tripId: string, o: { decisionId: string; optionRef: string; purpose: string }, trigger: string): Promise<AskResult> {
  const ids = idsFrom(trigger, o.decisionId);
  return askToPay(d, tripId, o, ids, postCard(d, tripId, ids.card));
}

interface Words {
  payer: string;
  what: string;
  amount?: string;
  cap?: string;
  /** For not_bookable_yet: the offer's kind. For it and not_bookable: the option's own page, only ever on ixigo.com. */
  kind?: string;
  link?: string;
}

function refuse(d: MoneyDeps, code: RefusalCode, words: Words, err?: unknown): Refused {
  const said = refusalWords(code, words);
  d.log.info({ code, ...(err instanceof Error ? { err: err.message } : {}) }, 'ask to pay refused');
  return { refused: said.text, code, say: said.say };
}

const CODES: ReadonlySet<string> = new Set<RefusalCode>([
  'decision_not_found', 'decision_not_closed', 'no_mandate', 'payer_has_not_confirmed', 'payer_declined', 'over_cap',
  'currency_mismatch', 'not_refundable', 'approval_outstanding', 'no_vote', 'wrong_offer', 'not_bookable', 'not_bookable_yet', 'already_paid',
  'no_travel', 'hold_failed', 'rail_not_ready', 'vault_refused', 'server_down', 'closed', 'not_in_trip', 'already_booked',
]);

/** Fares Go does not book for the whole group this week (master §9 "Cut now"): they are per person. */
export const GROUP_FARES: ReadonlySet<string> = new Set(['flight', 'train', 'bus']);

function codeOf(reason: string | null): RefusalCode {
  if (reason?.startsWith('vault_rail_not_ready')) return 'rail_not_ready';
  if (reason?.startsWith('vault_')) return 'vault_refused';
  return reason && CODES.has(reason) ? (reason as RefusalCode) : 'server_down';
}

/**
 * Free cancellation, exactly as the travel layer gave it on the hold (it is signed into the approval). Without it a
 * refundable-only mandate is refused, never guessed.
 */
function refundableUntilOf(hold: Hold): string | null {
  return hold.refundableUntil ?? null;
}

/** The payer always sees the name of what the group voted for. */
function purposeFor(label: string, asked: string): string {
  const text = plain(asked);
  return clip(text.toLowerCase().includes(label.toLowerCase()) ? text : `${label}: ${text}`, 200);
}

/** The pay card for a payments row in a given state, or null when the row has no card yet. */
export function payCardOf(row: PaymentRow, state: PayCardLook): PayCard | null {
  if (!row.card_id || !row.approval_id || !row.approval_expires_at || row.amount_minor === null || !row.currency || !row.merchant) return null;
  return payCard(
    {
      cardId: row.card_id,
      approvalId: row.approval_id,
      payerPersonId: row.payer_person_id,
      payerName: row.payer_name,
      amountMinor: row.amount_minor,
      currency: row.currency,
      merchant: row.merchant,
      purpose: row.purpose,
      refundableUntil: row.refundable_until,
      expiresAt: row.approval_expires_at.toISOString(),
    },
    state,
  );
}

/**
 * `o.optionRef` is the winning vote option's `option_ref` (an options card's option_id), never a travel offer id. It is
 * checked against the vote, then turned into the travel offer with `travel.offer`; it is never held as it is.
 */
export async function askToPay(
  d: MoneyDeps,
  tripId: string,
  o: { decisionId: string; optionRef: string; purpose: string },
  ids: AskIds,
  deliver: Deliver,
): Promise<AskResult> {
  const { optionRef } = o;
  const paymentId = paymentIdFor(tripId, ids.spend);
  const known = await getPayment(d.pool, paymentId);
  if (known) return advance(d, known, ids, deliver);

  const now = d.now();
  let trip: Trip;
  try {
    trip = await d.link.request('read_trip', { trip_id: tripId });
  } catch (e) {
    return refuse(d, 'server_down', { payer: 'The payer', what: 'it' }, e);
  }
  const nameOf = (id: string) => trip.people.find((p) => p.person_id === id)?.name ?? 'The payer';
  const decision = trip.decisions.find((x) => x.decision_id === o.decisionId);
  if (!decision || decision.kind !== 'choice') return refuse(d, 'no_vote', { payer: 'The payer', what: 'it' });
  const m = decision.mandate ?? null;
  const chosen = decision.options[m?.choice_index ?? decision.result_index ?? 0];
  const words: Words = { payer: m ? nameOf(m.payer_person_id) : 'The payer', what: chosen?.label ?? 'it' };

  // What the group decided, read from the Server's rows.
  if (decision.status !== 'closed') return refuse(d, 'decision_not_closed', words);
  if (!m) return refuse(d, 'no_mandate', words);
  if (m.declined_at && (!m.confirmed_at || Date.parse(m.declined_at) > Date.parse(m.confirmed_at))) return refuse(d, 'payer_declined', words);
  if (!m.confirmed_at) return refuse(d, 'payer_has_not_confirmed', words);
  if (!chosen?.option_ref || chosen.option_ref !== optionRef) return refuse(d, 'wrong_offer', words);
  if (await paidForDecision(d.pool, tripId, o.decisionId)) return refuse(d, 'already_paid', words);
  if (await openForDecision(d.pool, tripId, o.decisionId)) return refuse(d, 'approval_outstanding', words);

  const travel = d.travel();
  if (!travel) return refuse(d, 'no_travel', words);
  // The vote names the winner by its option_ref; the travel layer says which offer that is. An option a job found by
  // browsing has no offer id, so Go cannot book it.
  let offer: Awaited<ReturnType<Travel['offer']>>;
  try {
    offer = await travel.offer(optionRef);
  } catch (e) {
    return refuse(d, 'hold_failed', words, e);
  }
  // Group flights, trains and buses are cut this week: a fare is per person, so Go hands over the link instead of paying
  // one fare for the whole group. Nothing is held.
  const link = ixigoPage(offer?.link);
  if (offer && GROUP_FARES.has(offer.kind)) {
    return refuse(d, 'not_bookable_yet', { ...words, kind: offer.kind, ...(link ? { link } : {}) });
  }
  const offerId = offer?.offerId ?? null;
  if (!offerId) return refuse(d, 'not_bookable', { ...words, ...(link ? { link } : {}) });

  // The live price, checked now.
  const people = trip.people.map((p) => p.person_id);
  let hold: Hold;
  try {
    hold = await travel.hold(offerId, { name: words.payer, personIds: people });
  } catch (e) {
    return refuse(d, 'hold_failed', words, e);
  }
  if (hold.currency !== m.currency) return refuse(d, 'currency_mismatch', words);
  if (hold.amountMinor > m.cap_minor) {
    return refuse(d, 'over_cap', { ...words, amount: money(hold.amountMinor, hold.currency), cap: money(m.cap_minor, m.currency) });
  }
  const refundableUntil = refundableUntilOf(hold);
  if (m.refundable_only && !(refundableUntil && Date.parse(refundableUntil) > now.getTime())) return refuse(d, 'not_refundable', words);
  if (Date.parse(hold.expiresAt) <= now.getTime() + 60_000) return refuse(d, 'hold_failed', words);

  const kind: PaymentKind = d.payRail();
  // The rooms the group picked for the stay (REV4 B6): asking for the payment closes the rooms card, and the pick it
  // closed with is kept with the payment; none picked is [], one expense across everyone.
  let rooms: Room[] | null = null;
  if (d.rooms) {
    try {
      rooms = (await d.rooms({ trip_id: tripId, decision_id: o.decisionId, option_ref: optionRef, payment_id: paymentId })) ?? [];
    } catch (e) {
      // The rooms never stop a payment: unread, it is one expense across everyone.
      d.log.warn({ payment_id: paymentId, err: e instanceof Error ? e.message : String(e) }, "the stay's picked rooms didn't read; its expense is one across everyone");
    }
  }
  const inserted = await insertAsking(
    d.pool,
    {
      payment_id: paymentId,
      trip_id: tripId,
      decision_id: o.decisionId,
      option_ref: optionRef,
      purpose: purposeFor(words.what, o.purpose),
      label: words.what,
      payer_person_id: m.payer_person_id,
      payer_name: words.payer,
      for_person_ids: people,
      hold_id: hold.holdId,
      amount_minor: hold.amountMinor,
      currency: hold.currency,
      merchant: clip(plain(hold.merchant), 120),
      payment_kind: kind,
      hold_expires_at: new Date(hold.expiresAt),
      refundable_until: refundableUntil,
      rooms,
    },
    now,
  );
  // A rerun that raced its own first run finds that row; anything else is a second ask for a vote already waiting.
  const row = await getPayment(d.pool, paymentId);
  if (!row) return refuse(d, inserted === 'busy' ? 'approval_outstanding' : 'server_down', words);
  return advance(d, row, ids, deliver);
}

/** Takes a payments row as far as it can go: the Server's approval, the vault's link, the pay card. Safe to repeat. */
async function advance(d: MoneyDeps, row: PaymentRow, ids: AskIds, deliver: Deliver): Promise<AskResult> {
  const words: Words = { payer: row.payer_name, what: row.label };
  // A traveller's ticket goes through askForTicket, never a vote's pay card.
  const decisionId = row.decision_id;
  if (decisionId === null) return refuse(d, 'closed', words);
  switch (row.state) {
    case 'paid':
      return refuse(d, 'already_paid', words);
    case 'declined':
      return refuse(d, 'payer_declined', words);
    case 'refused':
      return refuse(d, codeOf(row.refused_reason), words);
    case 'expired':
    case 'failed':
      return refuse(d, 'closed', words);
    case 'waiting': {
      const card = payCardOf(row, 'waiting');
      if (!card || !row.card_id) return refuse(d, 'closed', words);
      await deliver(card);
      return { cardId: row.card_id, paymentId: row.payment_id };
    }
    case 'confirming':
      // The vault is still asking the bank about this payment: never start it again meanwhile.
      return refuse(d, 'approval_outstanding', words);
    case 'asking':
      break;
  }
  if (row.amount_minor === null || !row.currency || !row.merchant || !row.hold_id || !row.hold_expires_at) return refuse(d, 'server_down', words);
  const amountMinor = row.amount_minor;
  const fail = async (reason: string, code: RefusalCode, err?: unknown): Promise<AskResult> => {
    await transition(d.pool, row.payment_id, ['asking'], 'refused', { refused_reason: reason, release_reason: 'other' }, d.now());
    return refuse(d, code, words, err);
  };

  // 1. The Server's key: its spend check reads only its own rows and signs a one-use approval.
  let approvalId = row.approval_id;
  let token = row.approval_token;
  let expiresAt = row.approval_expires_at;
  if (!approvalId || !token || !expiresAt) {
    let answer: ToServerResult<'request_spend_approval'>;
    try {
      answer = await d.link.request('request_spend_approval', {
        request_id: ids.spend,
        trip_id: row.trip_id,
        decision_id: decisionId,
        amount_minor: amountMinor,
        currency: row.currency,
        merchant: row.merchant,
        purpose: row.purpose,
        ...(row.refundable_until ? { refundable_until: row.refundable_until } : {}),
      });
    } catch (e) {
      return fail('server_down', 'server_down', e);
    }
    if (answer.status === 'denied') {
      await transition(d.pool, row.payment_id, ['asking'], 'refused', { refused_reason: answer.reason }, d.now());
      return refuse(d, answer.reason, words);
    }
    approvalId = answer.approval_id;
    token = answer.approval;
    expiresAt = new Date(answer.expires_at);
    await patchPayment(d.pool, row.payment_id, { approval_id: approvalId, approval_token: token, approval_expires_at: expiresAt }, d.now());
  }

  // 2. The vault checks the approval before anything is shown, so no pay card appears for a payment it would refuse.
  const link = await d.vault.payLink({
    approval: token,
    approvalId,
    tripId: row.trip_id,
    payerPersonId: row.payer_person_id,
    payerName: row.payer_name,
    hold: {
      holdId: row.hold_id,
      amountMinor,
      currency: row.currency,
      merchant: row.merchant,
      paymentKind: (row.payment_kind ?? 'fake') as PaymentKind,
      expiresAt: row.hold_expires_at.toISOString(),
    },
  });
  if (!link.ok) {
    // No pay page was ever opened: the vault turned the approval down first. Why is kept on the row (for the admin view)
    // and in the log, e.g. a signature not valid for the vault's key; the room only hears that Go couldn't start it.
    const why = link.detail ? `vault_${link.reason}: ${link.detail}` : `vault_${link.reason}`;
    d.log.warn(
      { payment_id: row.payment_id, approval_id: approvalId, reason: link.reason, detail: link.detail ?? null },
      'the vault refused the approval before any pay page opened',
    );
    return fail(why, link.reason === 'rail_not_ready' ? 'rail_not_ready' : 'vault_refused');
  }

  // 3. The pay card, for the payer only.
  const cardId = row.card_id ?? ids.cardId;
  await patchPayment(d.pool, row.payment_id, { card_id: cardId, pay_link_url: link.url, pay_link_expires_at: new Date(link.expiresAt) }, d.now());
  const card = payCard(
    {
      cardId,
      approvalId,
      payerPersonId: row.payer_person_id,
      payerName: row.payer_name,
      amountMinor,
      currency: row.currency,
      merchant: row.merchant,
      purpose: row.purpose,
      refundableUntil: row.refundable_until,
      expiresAt: expiresAt.toISOString(),
    },
    'waiting',
  );
  // Waiting before the card can show: the Server shows it to the room before its answer reaches Go, and a tap in between
  // (a quick payer, or a send repeated after a dropped socket) must find it ready.
  await transition(d.pool, row.payment_id, ['asking'], 'waiting', { card_state: 'waiting' }, d.now());
  try {
    await deliver(card);
  } catch (e) {
    await transition(d.pool, row.payment_id, ['waiting'], 'refused', { refused_reason: 'server_down', release_reason: 'other' }, d.now());
    return refuse(d, 'server_down', words, e);
  }
  return { cardId, paymentId: row.payment_id };
}

/** A traveller's own ticket (contract 1.2, REV4 B7: never voted on): what is paid, for whom, and what asked. */
export interface TicketAsk {
  /** The traveller, who is the payer. */
  personId: string;
  amountMinor: number;
  currency: string;
  /** Shown on the vault's page and signed into the approval, e.g. "IndiGo 6E2150, Fri 6 Nov, for Meher". */
  purpose: string;
  /** What is paid for, such as the flight booking that asked: one open payment per key and trip. */
  key: string;
  /** What asked, such as a tap's tap_id: the same trigger asks once. */
  trigger: string;
}

export type TicketLink = { url: string; expiresAt: string; approvalId: string; paymentId: string } | Refused;

/** A ticket's price is held for the payment as long as its approval may last: the caller's page holds the real fare. */
const TICKET_HOLD_MS = MAX_APPROVAL_TTL_SECONDS * 1000;

/** Words for a ticket's payment that is on its way or settled, as a toast on the caller's own card. */
const TICKET_TOASTS = {
  preparing: 'Getting your payment ready. Tap Pay again in a moment.',
  confirming: 'Your bank is still confirming the last payment for this ticket.',
  paid: 'This ticket is already paid.',
  closed: 'That payment is closed. Tap Pay again for a fresh one.',
} as const;
const toast = (text: string): TicketLink => ({ refused: text, code: 'closed', say: false });

/**
 * A traveller's own ticket: the Server's ticket approval for that person (no vote; they are the payer), then the vault's
 * pay page for them alone, where they pay with Face ID. From there it is a stay's payment: the vault's two keys, the rail,
 * the callbacks. No pay card is posted: the caller's own card opens the page. A second ask while one is open gets that
 * one's page; one whose approval ran out is let go and a fresh one asked.
 */
export async function askForTicket(d: MoneyDeps, tripId: string, o: TicketAsk): Promise<TicketLink> {
  const spend = rid('go_spend_ticket', o.key, o.trigger);
  const paymentId = paymentIdFor(tripId, spend);
  const mine = await getPayment(d.pool, paymentId);
  if (mine) return ticketLinkOf(d, mine, spend);
  const open = await openTicket(d.pool, tripId, o.key);
  if (open && !(await letGoIfRunOut(d, open))) return ticketLinkOf(d, open, null);

  let trip: Trip;
  try {
    trip = await d.link.request('read_trip', { trip_id: tripId });
  } catch (e) {
    return refuse(d, 'server_down', { payer: 'The traveller', what: 'the ticket' }, e);
  }
  const person = trip.people.find((p) => p.person_id === o.personId);
  const words: Words = { payer: person?.name ?? 'The traveller', what: clip(plain(o.purpose), 80) };
  if (!person) return refuse(d, 'not_in_trip', words);
  const now = d.now();
  const inserted = await insertAsking(
    d.pool,
    {
      payment_id: paymentId,
      trip_id: tripId,
      kind: 'ticket',
      decision_id: null,
      option_ref: o.key,
      purpose: clip(plain(o.purpose), 200),
      label: words.what,
      payer_person_id: o.personId,
      payer_name: words.payer,
      for_person_ids: [o.personId],
      hold_id: o.key,
      amount_minor: o.amountMinor,
      currency: o.currency,
      merchant: 'ixigo',
      payment_kind: d.payRail(),
      hold_expires_at: new Date(now.getTime() + TICKET_HOLD_MS),
      refundable_until: null,
    },
    now,
  );
  const row = (await getPayment(d.pool, paymentId)) ?? (inserted === 'busy' ? await openTicket(d.pool, tripId, o.key) : null);
  if (!row) return refuse(d, 'server_down', words);
  return ticketLinkOf(d, row, row.payment_id === paymentId ? spend : null);
}

/** A waiting ticket whose approval ran out is let go (the sweep releases it): true when it was. */
async function letGoIfRunOut(d: MoneyDeps, row: PaymentRow): Promise<boolean> {
  if (row.state !== 'waiting' || !row.approval_expires_at) return false;
  if (row.approval_expires_at.getTime() + EXPIRY_GRACE_MS > d.now().getTime()) return false;
  return transition(d.pool, row.payment_id, ['waiting'], 'expired', { release_reason: 'expired' }, d.now());
}

/**
 * Takes a ticket's row as far as it goes: the Server's approval, then the vault's page. `spend` is the row's own spend
 * request id, null for a row another ask started (its first ask is still on its way, or the answer is its page).
 */
async function ticketLinkOf(d: MoneyDeps, row: PaymentRow, spend: string | null): Promise<TicketLink> {
  const words: Words = { payer: row.payer_name, what: row.label };
  switch (row.state) {
    case 'paid':
      return toast(TICKET_TOASTS.paid);
    case 'confirming':
      return toast(TICKET_TOASTS.confirming);
    case 'declined':
    case 'expired':
    case 'failed':
      return toast(TICKET_TOASTS.closed);
    case 'refused':
      return refuse(d, codeOf(row.refused_reason), words);
    case 'waiting':
      return pageOf(d, row, words);
    case 'asking':
      break;
  }
  // Another ask's first try is still on its way: its page comes on the next tap.
  if (spend === null) return toast(TICKET_TOASTS.preparing);
  if (row.amount_minor === null || !row.currency || !row.merchant) return refuse(d, 'server_down', words);
  const fail = async (reason: string, code: RefusalCode, err?: unknown): Promise<TicketLink> => {
    await transition(d.pool, row.payment_id, ['asking'], 'refused', { refused_reason: reason, release_reason: 'other' }, d.now());
    return refuse(d, code, words, err);
  };

  // 1. The Server's key: the ticket form names the traveller, who is the payer, in place of a vote.
  if (!row.approval_id || !row.approval_token || !row.approval_expires_at) {
    let answer: ToServerResult<'request_spend_approval'>;
    try {
      answer = await d.link.request('request_spend_approval', {
        request_id: spend,
        trip_id: row.trip_id,
        kind: 'ticket',
        for_person_id: row.payer_person_id,
        amount_minor: row.amount_minor,
        currency: row.currency,
        merchant: row.merchant,
        purpose: row.purpose,
      });
    } catch (e) {
      return fail('server_down', 'server_down', e);
    }
    if (answer.status === 'denied') {
      await transition(d.pool, row.payment_id, ['asking'], 'refused', { refused_reason: answer.reason }, d.now());
      return refuse(d, answer.reason, words);
    }
    const patch = { approval_id: answer.approval_id, approval_token: answer.approval, approval_expires_at: new Date(answer.expires_at) };
    await patchPayment(d.pool, row.payment_id, patch, d.now());
    Object.assign(row, patch);
  }

  // 2. The vault checks the approval and opens the traveller's page; then the payment waits on them.
  const page = await pageOf(d, row, words);
  if ('refused' in page) {
    await transition(d.pool, row.payment_id, ['asking'], 'refused', { refused_reason: page.code === 'rail_not_ready' ? 'vault_rail_not_ready' : 'vault_refused', release_reason: 'other' }, d.now());
    return page;
  }
  await transition(d.pool, row.payment_id, ['asking'], 'waiting', {}, d.now());
  return page;
}

/** The traveller's vault page for a ticket's approval: the one already open while it lasts, else a fresh one. */
async function pageOf(d: MoneyDeps, row: PaymentRow, words: Words): Promise<TicketLink> {
  const now = d.now().getTime();
  if (!row.approval_id) return refuse(d, 'closed', words);
  if (row.pay_link_url && row.pay_link_expires_at && row.pay_link_expires_at.getTime() > now + 30_000) {
    return { url: row.pay_link_url, expiresAt: row.pay_link_expires_at.toISOString(), approvalId: row.approval_id, paymentId: row.payment_id };
  }
  const input = payLinkInput(row);
  if (!input) return refuse(d, 'closed', words);
  const link = await d.vault.payLink(input);
  if (!link.ok) {
    d.log.warn({ payment_id: row.payment_id, approval_id: row.approval_id, reason: link.reason, detail: link.detail ?? null }, 'the vault refused a ticket\'s approval');
    return refuse(d, link.reason === 'rail_not_ready' ? 'rail_not_ready' : 'vault_refused', words);
  }
  await patchPayment(d.pool, row.payment_id, { pay_link_url: link.url, pay_link_expires_at: new Date(link.expiresAt) }, d.now());
  return { url: link.url, expiresAt: link.expiresAt, approvalId: row.approval_id, paymentId: row.payment_id };
}
