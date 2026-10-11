import type * as C from '@go/contract';
import type { CardTapParams, CardTapResult, TripEvent } from '../door/methods.js';
import { newRequestId } from '../door/server-link.js';
import { askForTicket, askForTicketCard, askOutsideTurn } from './ask.js';
import { Later, type MoneyDeps } from './deps.js';
import { tripEvent } from './events.js';
import { markConfirming, markFailed, markPaid, markPaidByServer, postTicket, reconcile, sweepPayments, type VaultFailReason } from './finish.js';
import type { Paid, Pay } from './pay.js';
import { byApproval, paidApprovalIds } from './store.js';
import { approveTap, declineTap, type TapDeps } from './taps.js';

export interface PayEngine extends Pay {
  paid(p: Paid): Promise<'ok' | 'unknown'>;
  failed(p: { tripId: string; approvalId: string; reason: VaultFailReason }): Promise<'ok' | 'unknown'>;
  confirming(p: { tripId: string; approvalId: string; checking?: boolean }): Promise<'ok' | 'unknown'>;
  approveTap(tap: CardTapParams, card: C.Card): Promise<CardTapResult>;
  declineTap(tap: CardTapParams, card: C.Card): Promise<CardTapResult>;
  tripEvent(ev: TripEvent): Promise<void>;
  /** A trip change, handled after the trip log moves on. */
  heard(ev: TripEvent): void;
  sweep(): Promise<number>;
  /** Waits for every piece of work started after an answer (tests). */
  settled(): Promise<void>;
}

type PaymentCompleted = Extract<TripEvent, { type: 'payment.completed' }>;

export function createPay(d: MoneyDeps): PayEngine {
  const later = new Later();
  // The Server paid a waiting pay card on its payer's tap and booked it (the demo): paid, then on as after the vault's.
  const paidByServer = async (ev: PaymentCompleted): Promise<void> => {
    const p = ev.data;
    const row = await markPaidByServer(d, { tripId: ev.trip_id, approvalId: p.approval_id, bookingId: p.booking_id ?? null, expenseId: p.expense_id ?? null });
    if (!row) {
      d.log.info({ trip: ev.trip_id, approval_id: p.approval_id }, 'payment.completed for an approval Go has no payment for: ignored');
      return;
    }
    const paid: Paid = { tripId: ev.trip_id, approvalId: p.approval_id, railRef: p.method ?? 'demo', ...(p.booking_id ? { bookingId: p.booking_id } : {}) };
    for (const fn of listeners) later.run(d.log, 'a paid listener', () => fn(paid));
  };
  const t: TapDeps = {
    d, ask: (tripId, o, trigger) => askOutsideTurn(d, tripId, o, trigger), later, reconcile: (id) => reconcile(d, id), paidByServer,
  };
  // The first listener finishes the booking. Other lanes may add their own.
  const listeners: Array<(p: Paid) => Promise<void>> = [
    async (p) => {
      const row = await byApproval(d.pool, p.tripId, p.approvalId);
      if (row) await reconcile(d, row.payment_id);
    },
  ];
  return {
    async askToPay(tripId, o) {
      const r = await askOutsideTurn(d, tripId, o, newRequestId());
      return 'cardId' in r ? { cardId: r.cardId } : { refused: r.refused };
    },
    requestTicketApproval: (tripId, o) => askForTicket(d, tripId, o),
    requestTicketCard: (tripId, o) => askForTicketCard(d, tripId, o),
    travelDetails: (i) => d.vault.travelDetails(i),
    // The browser sheet: the vault opens only its home embedded (#431).
    travelLink: (personId, fields) => d.vault.homeLink({ personId, start: 'add_travel', display: 'sheet', ...(fields?.length ? { fields } : {}) }),
    onPaid(fn) {
      listeners.push(fn);
    },
    booked: (b, line) => postTicket(d, b, line),
    async withoutBothKeys() {
      const [vault, paid] = await Promise.all([d.vault.bothKeys(), paidApprovalIds(d.pool)]);
      const charged = new Set(vault.chargedApprovalIds);
      const missing = paid.filter((id) => !charged.has(id)).length;
      return { count: vault.withoutBothKeys + missing, paid: paid.length, charged: charged.size };
    },
    async paid(p) {
      if (!(await markPaid(d, p))) return 'unknown';
      for (const fn of listeners) later.run(d.log, 'a paid listener', () => fn(p));
      return 'ok';
    },
    async failed(p) {
      const row = await markFailed(d, p);
      if (!row) return 'unknown';
      later.run(d.log, 'a failed payment', () => reconcile(d, row.payment_id));
      return 'ok';
    },
    async confirming(p) {
      const row = await markConfirming(d, p);
      if (!row) return 'unknown';
      later.run(d.log, 'a payment the bank is confirming', () => reconcile(d, row.payment_id));
      return 'ok';
    },
    approveTap: (tap, card) => approveTap(t, tap, card),
    declineTap: (tap, card) => declineTap(t, tap, card),
    tripEvent: (ev) => tripEvent(t, ev),
    heard(ev) {
      later.run(d.log, 'a trip change', () => tripEvent(t, ev));
    },
    sweep: () => sweepPayments(d),
    settled: () => later.settled(),
  };
}
