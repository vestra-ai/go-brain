import type { TurnCtx } from '../composer/tools.js';
import type { ToServerResult, Trip } from '../door/methods.js';
import type { Hold, Travel } from '../travel/travel.js';
import { payCard, type PayCard, type PayCardLook } from './cards.js';
import type { MoneyDeps } from './deps.js';
import { paymentIdFor, rid } from './ids.js';
import { getPayment, insertAsking, openForDecision, paidForDecision, patchPayment, transition, type PaymentRow } from './store.js';
import type { PaymentKind } from './vault-client.js';
import { clip, money, plain, refusalWords, type RefusalCode } from './words.js';

export type AskResult = { cardId: string; paymentId: string } | { refused: string; code: RefusalCode; say: boolean };

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
  /** For not_bookable_yet: the offer's kind and its booking page, when the travel layer has one. */
  kind?: string;
  link?: string;
}

function refuse(d: MoneyDeps, code: RefusalCode, words: Words, err?: unknown): AskResult {
  const said = refusalWords(code, words);
  d.log.info({ code, ...(err instanceof Error ? { err: err.message } : {}) }, 'ask to pay refused');
  return { refused: said.text, code, say: said.say };
}

const CODES: ReadonlySet<string> = new Set<RefusalCode>([
  'decision_not_found', 'decision_not_closed', 'no_mandate', 'payer_has_not_confirmed', 'payer_declined', 'over_cap',
  'currency_mismatch', 'not_refundable', 'approval_outstanding', 'no_vote', 'wrong_offer', 'not_bookable', 'not_bookable_yet', 'already_paid',
  'no_travel', 'hold_failed', 'rail_not_ready', 'vault_refused', 'server_down', 'closed',
]);

/** Fares Go does not book for the whole group this week (master §9 "Cut now"): they are per person. */
const GROUP_FARES: ReadonlySet<string> = new Set(['flight', 'train', 'bus']);

function codeOf(reason: string | null): RefusalCode {
  if (reason === 'vault_rail_not_ready') return 'rail_not_ready';
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
  if (offer && GROUP_FARES.has(offer.kind)) {
    return refuse(d, 'not_bookable_yet', { ...words, kind: offer.kind, ...(offer.link ? { link: offer.link } : {}) });
  }
  const offerId = offer?.offerId ?? null;
  if (!offerId) return refuse(d, 'not_bookable', words);

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
        decision_id: row.decision_id,
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
  if (!link.ok) return fail(`vault_${link.reason}`, link.reason === 'rail_not_ready' ? 'rail_not_ready' : 'vault_refused');

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
  try {
    await deliver(card);
  } catch (e) {
    return fail('server_down', 'server_down', e);
  }
  await transition(d.pool, row.payment_id, ['asking'], 'waiting', { card_state: 'waiting' }, d.now());
  return { cardId, paymentId: row.payment_id };
}
