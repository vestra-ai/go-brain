/**
 * The "I'll book it" tap and the card's first showing (claims.ts). The card rides on Go's own line about the closed vote
 * (context.addTurnCard), so the room gets one message, never two in a row. The first tap takes it: Go answers at once,
 * then sets the mandate for that person (the login gate and the price check as set_mandate always does) and posts the
 * mandate card with one line naming them, while the claim card says who is booking.
 *
 * The stay comes first (Saket's test, 11 Oct: his flights card and the stay's card went up at once): a closed stays vote
 * brings its booking and nothing else, and a trip of one has nobody to ask who pays, so its booking goes up by itself.
 * Each person's flights come once the stay is booked (finish.ts, stayBooked), or sooner when someone asks.
 */
import type * as C from '@go/contract';
import type { DirectAnswer, TurnCard } from '../composer/context.js';
import { mentionsIn } from '../composer/speak.js';
import type { DeskItem } from '../desk/desk.js';
import type { CardTapParams, CardTapResult } from '../door/methods.js';
import type { Packs, TripPack } from '../trips/pack.js';
import { saveTrip } from '../trips/save-trip.js';
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

/** The vote this turn woke for, when it closed on a stay Go can book and nobody is booking it yet. */
async function closedStay(c: ClaimDeps, wake: readonly DeskItem[], pack: TripPack): Promise<{ decision: C.Decision; won: C.Decision['options'][number] } | null> {
  const closed = wake.find((w) => w.kind === 'trip_change' && (w.payload as { type?: string } | null)?.type === 'decision.closed');
  const decisionId = (closed?.payload as { decisionId?: string } | undefined)?.decisionId;
  const decision = decisionId ? pack.trip.decisions.find((x) => x.decision_id === decisionId) : undefined;
  if (!decision || decision.kind !== 'choice' || decision.mandate || decision.result_index == null) return null;
  const won = decision.options[decision.result_index];
  if (!won?.option_ref) return null;
  const offer = await c.d.travel()?.offer(won.option_ref);
  if (offer?.kind !== 'stay' || (await whyNotBookable(c.d, won))) return null;
  return { decision, won };
}

/**
 * On the turn Go wakes for a closed vote that picked a stay Go can book: the claim card. A trip of one gets no card (nobody
 * to ask who pays, and "One person books for all" was wrong there): its booking is set up for them now, once, and its
 * own message opens with the stay ("Seashell Suites it is.").
 */
export function claimCardOnClose(c: ClaimDeps): TurnCard {
  return async ({ tripId, wake, pack, turnId }) => {
    const stay = await closedStay(c, wake, pack);
    if (!stay) return null;
    const { decision, won } = stay;
    const one = pack.trip.people.length === 1 ? pack.trip.people[0] : undefined;
    if (one) {
      // Taken before it starts, so a rerun of this turn finds it taken and starts nothing.
      if ((await c.claims.get(tripId, decision.decision_id))?.personId) return null;
      await c.claims.take(tripId, decision.decision_id, one.person_id);
      c.later.run(c.d.log, 'booking the stay for the one person', () =>
        bookFor(c, { tripId, pack, decision, won, personId: one.person_id, key: `close_${decision.decision_id}`, lead: `${won.label} it is.`, claimCardUp: false }),
      );
      return null;
    }
    if (!(await c.claims.offer(tripId, decision.decision_id, turnId))) return null;
    return { card: claimCard({ decisionId: decision.decision_id, what: won.label, people: pack.trip.people.length, claimer: null }), line: '' };
  };
}

/**
 * The turn Go wakes for a closed stays vote, and nothing else, answered with no model round: the stay saved as the
 * group's, and its booking the one next step, in one plain line ("Seashell Suites it is. Tap I'll book it to book it.")
 * with the claim card on it (claimCardOnClose). No flights now, and no "tell me when". A trip of one says nothing here:
 * its booking's own message opens with the stay. Anything else in the turn goes to the model.
 */
export function stayClosedAnswer(c: ClaimDeps): DirectAnswer {
  return async ({ tripId, wake, pack, ctx }) => {
    if (wake.length !== 1) return false;
    const stay = await closedStay(c, wake, pack);
    if (!stay) return false;
    const saved = await saveTrip(
      { pool: c.d.pool, now: c.d.now, travel: c.d.travel },
      { link: ctx.link, tripId, pack, requestId: () => ctx.stableId('go_trip') },
      { stay: stay.won.label, decisionId: stay.decision.decision_id },
    );
    if (!saved.ok) c.d.log.warn({ trip: tripId, error: saved.error }, 'the stay a vote picked was not saved on the trip');
    if (pack.trip.people.length > 1) ctx.lines.push(`${stay.won.label} it is. Tap I'll book it to book it.`);
    ctx.answered = true;
    return true;
  };
}

/**
 * Sets the mandate for the person booking, behind their tap or a closed vote, and says it in one message: the mandate
 * card with its line, the login's one plain line when the booking waits on a login card already up, or why not. lead:
 * what the message opens with; claimCardUp: the claim card is in the room, and now says who is booking.
 */
async function bookFor(
  c: ClaimDeps,
  o: { tripId: string; pack: TripPack; decision: C.Decision; won: C.Decision['options'][number]; personId: string; key: string; lead?: string; claimCardUp: boolean },
): Promise<void> {
  const name = o.pack.trip.people.find((p) => p.person_id === o.personId)?.name ?? 'Someone';
  const people = o.pack.trip.people.length;
  if (o.claimCardUp) {
    await c.d.link.request('replace_card', { trip_id: o.tripId, card: claimCard({ decisionId: o.decision.decision_id, what: o.won.label, people, claimer: name }) });
  }
  const cards: C.Card[] = [];
  const r = await setMandate(
    c.d,
    { tripId: o.tripId, stableId: (prefix) => rid(prefix, o.key), cards, pack: o.pack },
    { decisionId: o.decision.decision_id, choiceIndex: o.decision.result_index!, refundableOnly: false, payerPersonId: o.personId },
  );
  const payer = payerOf({ payer_person_id: o.personId, payer_name: name });
  const said = (text: string): string => [o.lead, text].filter(Boolean).join(' ');
  if ('cardId' in r) {
    const text = said([r.booking, r.note, `Tap Yes, book it when you're ready.`].filter(Boolean).join(' '));
    const mentions = mentionsIn(text, payer);
    await c.d.link.request('post_message', {
      request_id: rid('go_claim', o.key),
      trip_id: o.tripId,
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
    if (r.line) await postLine(c.d, o.tripId, said(r.line), rid('go_claim_waits', o.key), o.pack.trip.people);
    return;
  }
  await postLine(c.d, o.tripId, said(r.refused), rid('go_claim_said', o.key), payer);
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
    // The tap answers now; setting the mandate (and asking for the login when it is out) runs behind it.
    c.later.run(c.d.log, 'booking for the group', () =>
      bookFor(c, { tripId: tap.trip_id, pack, decision, won, personId: tap.person_id, key: tap.tap_id, claimCardUp: true }),
    );
    return { result: 'done', toast: pack.trip.people.length === 1 ? "You're booking it" : "You're booking it for everyone" };
  };
}
