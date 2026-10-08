import type { TripEvent } from '../door/methods.js';
import { postLine } from './deps.js';
import { rid } from './ids.js';
import { openForDecision, transition, type PaymentState, type ReleaseReason } from './store.js';
import type { TapDeps } from './taps.js';

async function closeWaiting(t: TapDeps, tripId: string, decisionId: string, to: PaymentState, reason: ReleaseReason): Promise<void> {
  const row = await openForDecision(t.d.pool, tripId, decisionId);
  if (!row || row.state !== 'waiting') return;
  if (await transition(t.d.pool, row.payment_id, ['waiting'], to, { release_reason: reason }, t.d.now())) await t.reconcile(row.payment_id);
}

/** The trip changes money reacts to. Every one is re-read from the Server before anything is paid. */
export async function tripEvent(t: TapDeps, ev: TripEvent): Promise<void> {
  switch (ev.type) {
    case 'mandate.confirmed': {
      // "Yes, book it": ask right away, no model turn in between. Both keys are still needed.
      const trip = await t.d.link.request('read_trip', { trip_id: ev.trip_id });
      const decision = trip.decisions.find((x) => x.decision_id === ev.data.decision_id);
      const m = decision?.mandate;
      const chosen = m ? decision?.options[m.choice_index] : undefined;
      if (!decision || !chosen?.option_ref) return;
      const purpose = chosen.note ? `${chosen.label}, ${chosen.note}` : chosen.label;
      // Ids from the event: a redelivered event finds the same payment and does nothing twice.
      // The winner's option_ref goes in as is; askToPay turns it into the travel offer.
      const r = await t.ask(ev.trip_id, { decisionId: decision.decision_id, optionRef: chosen.option_ref, purpose }, ev.event_id);
      if ('refused' in r && r.say && r.code !== 'approval_outstanding' && r.code !== 'already_paid') {
        await postLine(t.d, ev.trip_id, r.refused, rid('go_said', ev.event_id), trip.people);
      }
      return;
    }
    case 'mandate.declined':
      return closeWaiting(t, ev.trip_id, ev.data.decision_id, 'declined', 'payer_declined');
    case 'mandate.set':
      // A new mandate clears the payer's yes, so an approval made under the old one is let go.
      return closeWaiting(t, ev.trip_id, ev.data.decision_id, 'expired', 'price_changed');
    case 'decision.cancelled':
      return closeWaiting(t, ev.trip_id, ev.data.decision_id, 'expired', 'other');
    default:
      return;
  }
}
