/**
 * The "I'll book it" tap and the card's first showing (claims.ts). The card rides on Go's own line about the closed vote
 * (context.addTurnCard), so the room gets one message, never two in a row. The first tap takes it: Go answers at once,
 * then sets the mandate for that person (the login gate and the price check as set_mandate always does) and posts the
 * mandate card with one line naming them, while the claim card says who is booking.
 */
import type * as C from '@go/contract';
import type { TurnCard } from '../composer/context.js';
import { mentionsIn } from '../composer/speak.js';
import type { CardTapParams, CardTapResult } from '../door/methods.js';
import type { Packs } from '../trips/pack.js';
import { claimCard, decisionOfClaimCard, type Claims } from './claims.js';
import { payerOf, postLine, type Later, type MoneyDeps } from './deps.js';
import { rid } from './ids.js';
import { setMandate, whyNotBookable } from './mandate.js';

export interface ClaimDeps {
  d: MoneyDeps;
  claims: Claims;
  packs: Pick<Packs, 'get'>;
  later: Later;
}

/** On the turn Go wakes for a closed vote: the claim card, when the winner is a stay Go can book and nobody holds it yet. */
export function claimCardOnClose(c: ClaimDeps): TurnCard {
  return async ({ tripId, wake, pack, turnId }) => {
    const closed = wake.find((w) => w.kind === 'trip_change' && (w.payload as { type?: string } | null)?.type === 'decision.closed');
    const decisionId = (closed?.payload as { decisionId?: string } | undefined)?.decisionId;
    const decision = decisionId ? pack.trip.decisions.find((x) => x.decision_id === decisionId) : undefined;
    if (!decision || decision.kind !== 'choice' || decision.mandate || decision.result_index == null) return null;
    const won = decision.options[decision.result_index];
    if (!won?.option_ref) return null;
    const offer = await c.d.travel()?.offer(won.option_ref);
    if (offer?.kind !== 'stay' || (await whyNotBookable(c.d, won))) return null;
    if (!(await c.claims.offer(tripId, decision.decision_id, turnId))) return null;
    return { card: claimCard({ decisionId: decision.decision_id, what: won.label, people: pack.trip.people.length, claimer: null }), line: '' };
  };
}

export function claimTap(c: ClaimDeps) {
  return async (tap: CardTapParams): Promise<CardTapResult> => {
    const decisionId = decisionOfClaimCard(tap.card_id);
    const pack = await c.packs.get(tap.trip_id);
    const decision = decisionId ? pack.trip.decisions.find((x) => x.decision_id === decisionId) : undefined;
    const won = decision && decision.result_index != null ? decision.options[decision.result_index] : undefined;
    if (!decision || !won) return { result: 'refused', toast: 'That card is not active any more.' };
    const nameOf = (id: string): string => pack.trip.people.find((p) => p.person_id === id)?.name ?? 'Someone';
    // A mandate set another way (the group named the payer before 1.1) holds as the claim.
    const holder = decision.mandate?.payer_person_id ?? (await c.claims.take(tap.trip_id, decision.decision_id, tap.person_id));
    if (holder !== tap.person_id) return { result: 'refused', toast: `${nameOf(holder)} is already booking this.` };
    if (decision.mandate) return { result: 'done', toast: "You're booking it" };
    const name = nameOf(tap.person_id);
    const people = pack.trip.people.length;
    // The tap answers now; setting the mandate (and asking for the login when it is out) runs behind it.
    c.later.run(c.d.log, 'booking for the group', async () => {
      await c.d.link.request('replace_card', { trip_id: tap.trip_id, card: claimCard({ decisionId: decision.decision_id, what: won.label, people, claimer: name }) });
      const cards: C.Card[] = [];
      const r = await setMandate(
        c.d,
        { tripId: tap.trip_id, stableId: (prefix) => rid(prefix, tap.tap_id), cards, pack },
        { decisionId: decision.decision_id, choiceIndex: decision.result_index!, refundableOnly: false, payerPersonId: tap.person_id },
      );
      const payer = payerOf({ payer_person_id: tap.person_id, payer_name: name });
      if ('cardId' in r) {
        const text = [r.booking, r.note, `Tap Yes, book it when you're ready.`].filter(Boolean).join(' ');
        const mentions = mentionsIn(text, payer);
        await c.d.link.request('post_message', {
          request_id: rid('go_claim', tap.tap_id),
          trip_id: tap.trip_id,
          text,
          ...(mentions.length ? { mentions } : {}),
          ...(cards[0] ? { card: cards[0] } : {}),
        });
        return;
      }
      // Parked on the login, and Go carries on when it is in. The login's own line and card went up just now, or they were
      // up already (or someone is logging in): then its one plain line says so (prod drill, 11 Oct: a tap a minute after the
      // hello's card said nothing at all), naming whoever it points at.
      if (r.parked) {
        if (r.line) await postLine(c.d, tap.trip_id, r.line, rid('go_claim_waits', tap.tap_id), pack.trip.people);
        return;
      }
      await postLine(c.d, tap.trip_id, r.refused, rid('go_claim_said', tap.tap_id), payer);
    });
    return { result: 'done', toast: pack.trip.people.length === 1 ? "You're booking it" : "You're booking it for everyone" };
  };
}
