import type * as C from '@go/contract';
import type { CardTapParams, CardTapResult } from '../door/methods.js';
import type { AskResult } from './ask.js';
import { postLine, type Later, type MoneyDeps } from './deps.js';
import { rid } from './ids.js';
import { byApproval, EXPIRY_GRACE_MS, patchPayment, transition, type PaymentRow } from './store.js';
import type { PayLinkInput, PaymentKind } from './vault-client.js';
import { TOASTS } from './words.js';

export interface TapDeps {
  d: MoneyDeps;
  /** An ask outside a turn, with ids from its trigger (askOutsideTurn). */
  ask: (tripId: string, o: { decisionId: string; optionRef: string; purpose: string }, trigger: string) => Promise<AskResult>;
  later: Later;
  reconcile: (paymentId: string) => Promise<void>;
}

const refused = (toast: string): CardTapResult => ({ result: 'refused', toast });
const done = (toast: string): CardTapResult => ({ result: 'done', toast });

function stateToast(row: PaymentRow): string {
  switch (row.state) {
    case 'paid':
      return TOASTS.paid;
    case 'declined':
      return TOASTS.declined;
    case 'failed':
      return TOASTS.failed;
    case 'confirming':
      return TOASTS.confirming;
    default:
      return TOASTS.notReady;
  }
}

function payLinkInput(row: PaymentRow): PayLinkInput | null {
  if (!row.approval_token || !row.approval_id || !row.hold_id || row.amount_minor === null || !row.currency || !row.merchant || !row.hold_expires_at) return null;
  return {
    approval: row.approval_token,
    approvalId: row.approval_id,
    tripId: row.trip_id,
    payerPersonId: row.payer_person_id,
    payerName: row.payer_name,
    hold: {
      holdId: row.hold_id,
      amountMinor: row.amount_minor,
      currency: row.currency,
      merchant: row.merchant,
      paymentKind: (row.payment_kind ?? 'fake') as PaymentKind,
      expiresAt: row.hold_expires_at.toISOString(),
    },
  };
}

/**
 * After the answer: release the old approval, then ask again with ids from the tap, so the same tap never asks twice.
 * A fresh ask runs the Server's spend check again and needs Face ID again.
 */
function startAgain(t: TapDeps, row: PaymentRow, tapId: string): void {
  t.later.run(t.d.log, 'start a payment again', async () => {
    await t.reconcile(row.payment_id);
    // The vote's option_ref again: the fresh ask resolves it to the travel offer and holds it anew.
    const r = await t.ask(row.trip_id, { decisionId: row.decision_id, optionRef: row.option_ref, purpose: row.purpose }, tapId);
    if ('refused' in r && r.say) await postLine(t.d, row.trip_id, r.refused, rid('go_said', tapId));
  });
}

async function paymentOf(t: TapDeps, tap: CardTapParams, card: C.Card): Promise<PaymentRow | null> {
  return card.kind === 'pay' ? byApproval(t.d.pool, tap.trip_id, card.approval_id) : null;
}

export async function approveTap(t: TapDeps, tap: CardTapParams, card: C.Card): Promise<CardTapResult> {
  if (card.kind !== 'pay') return refused(TOASTS.notPay);
  const row = await paymentOf(t, tap, card);
  if (!row) return refused(TOASTS.gone);
  if (tap.person_id !== row.payer_person_id) return refused(TOASTS.notPayer(row.payer_name));
  // The bank has not answered about a charge: no new page, and never Start again.
  if (row.state === 'confirming') return refused(TOASTS.confirming);
  if (row.state === 'expired') {
    startAgain(t, row, tap.tap_id);
    return done(TOASTS.restart);
  }
  if (row.state !== 'waiting') return refused(stateToast(row));

  const now = t.d.now();
  // The same grace as the sweep: inside it the vault's own expiry answers, and only the sweep turns the card expired.
  const approvalGone = !row.approval_expires_at || row.approval_expires_at.getTime() + EXPIRY_GRACE_MS <= now.getTime();
  const holdGone = !row.hold_expires_at || row.hold_expires_at.getTime() <= now.getTime() + 60_000;
  if (approvalGone || holdGone) {
    await transition(t.d.pool, row.payment_id, ['waiting'], 'expired', { release_reason: 'expired' }, now);
    startAgain(t, row, tap.tap_id);
    return done(TOASTS.fresh);
  }

  if (row.pay_link_url && row.pay_link_expires_at && row.pay_link_expires_at.getTime() > now.getTime() + 30_000) {
    return { result: 'open', url: row.pay_link_url, expires_at: row.pay_link_expires_at.toISOString() };
  }
  const input = payLinkInput(row);
  if (!input) return refused(TOASTS.notReady);
  const link = await t.d.vault.payLink(input, { timeoutMs: t.d.tapVaultMs ?? 1_500 });
  if (!link.ok) return refused(TOASTS.noPage);
  await patchPayment(t.d.pool, row.payment_id, { pay_link_url: link.url, pay_link_expires_at: new Date(link.expiresAt) }, t.d.now());
  return { result: 'open', url: link.url, expires_at: link.expiresAt };
}

export async function declineTap(t: TapDeps, tap: CardTapParams, card: C.Card): Promise<CardTapResult> {
  if (card.kind !== 'pay') return refused(TOASTS.notPay);
  const row = await paymentOf(t, tap, card);
  if (!row) return refused(TOASTS.gone);
  if (tap.person_id !== row.payer_person_id) return refused(TOASTS.notPayer(row.payer_name));
  if (row.state !== 'waiting') return refused(stateToast(row));
  if (!(await transition(t.d.pool, row.payment_id, ['waiting'], 'declined', { release_reason: 'payer_declined' }, t.d.now()))) {
    return refused(TOASTS.notReady);
  }
  t.later.run(t.d.log, 'decline a payment', () => t.reconcile(row.payment_id));
  return done(TOASTS.declinedDone);
}
