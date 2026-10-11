import type * as C from '@go/contract';
import type { CardTapParams, CardTapResult, TripEvent } from '../door/methods.js';
import { newRequestId } from '../door/server-link.js';
import { askForTicket, askForTicketCard, askOutsideTurn } from './ask.js';
import { Later, type MoneyDeps } from './deps.js';
import { tripEvent } from './events.js';
import { markConfirming, markFailed, markPaid, reconcile, sweepPayments, type VaultFailReason } from './finish.js';
import type { Pay } from './pay.js';
import { byApproval, paidApprovalIds } from './store.js';
import { approveTap, declineTap, type TapDeps } from './taps.js';

type Paid = { tripId: string; approvalId: string; railRef: string };

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

export function createPay(d: MoneyDeps): PayEngine {
  const later = new Later();
  // The first listener finishes the booking. Other lanes may add their own.
  const listeners: Array<(p: Paid) => Promise<void>> = [
    async (p) => {
      const row = await byApproval(d.pool, p.tripId, p.approvalId);
      if (row) await reconcile(d, row.payment_id);
    },
  ];
  // Paid: the vault's callback, or the payer's one tap on ixigo money (Go's fake rail). Each listener runs after the answer.
  const paid = async (p: Paid): Promise<'ok' | 'unknown'> => {
    if (!(await markPaid(d, p))) return 'unknown';
    for (const fn of listeners) later.run(d.log, 'a paid listener', () => fn(p));
    return 'ok';
  };
  const t: TapDeps = { d, ask: (tripId, o, trigger) => askOutsideTurn(d, tripId, o, trigger), later, reconcile: (id) => reconcile(d, id), paid };
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
    async withoutBothKeys() {
      const [vault, paid] = await Promise.all([d.vault.bothKeys(), paidApprovalIds(d.pool)]);
      const charged = new Set(vault.chargedApprovalIds);
      const missing = paid.filter((id) => !charged.has(id)).length;
      return { count: vault.withoutBothKeys + missing, paid: paid.length, charged: charged.size };
    },
    paid,
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
