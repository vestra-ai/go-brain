import type { TurnCtx } from '../composer/tools.js';
import type { Message, Trip } from '../door/methods.js';
import { ixigoPage } from '../travel/cards.js';
import type { Travel } from '../travel/travel.js';
import { GROUP_FARES } from './ask.js';
import { mandateCard } from './cards.js';
import { askersOf, claimCard, claimCardId } from './claims.js';
import type { MoneyDeps } from './deps.js';
import { money, refusalWords, shortDate } from './words.js';

/** The price plus up to 10%, rounded down to a whole ₹1,000 and never below the price: the most Go sets on its own. */
export function marginCap(priceMinor: number): number {
  return Math.max(priceMinor, Math.floor((priceMinor * 11) / 1_000_000) * 100_000);
}

/** The trip's nights from its dates (6 to 9 Nov is 3), or null when the trip has no dates yet. */
export function nightsOf(trip: Pick<Trip, 'dates'>): number | null {
  if (!trip.dates) return null;
  const n = Math.round((Date.parse(`${trip.dates.end}T00:00:00Z`) - Date.parse(`${trip.dates.start}T00:00:00Z`)) / 86_400_000);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

const UNITS: Record<string, number> = { k: 1_000, thousand: 1_000, l: 100_000, lakh: 100_000, lac: 100_000 };
const AMOUNT = /(?:₹|rs\.?|inr)?\s*(\d{1,3}(?:,\d{2,3})+|\d+(?:\.\d+)?)\s*(k|thousand|lakh|lac|l)?\b/gi;
/** "a head", "per person", "/head", "each", "pp", and the Hinglish "per banda". */
const PER_HEAD = /\b(?:a|per)\s+(?:head|person|pax|banda|bande)\b|\/\s*(?:head|person|pax)\b|\beach\b|\bpp\b/i;
/** "per night", "a night", "/night", "nightly". */
const PER_NIGHT = /\b(?:a|per)\s+night\b|\/\s*night\b|\bnightly\b/i;

/**
 * Every cap people wrote in the chat, in paise, read the way they meant it:
 *  - "8k a head per night" is 8,000 times the people times the trip's nights (left out when the trip has no dates);
 *  - "8k a head" is 8,000 times the people; "8k per night" is 8,000 times the nights;
 *  - a plain "40k" is the total, never multiplied.
 */
export function amountsSaid(messages: Message[], group: { heads: number; nights: number | null }): number[] {
  const out = new Set<number>();
  for (const m of messages.slice(-200)) {
    if (m.author.kind !== 'person' || !m.text) continue;
    for (const hit of m.text.matchAll(AMOUNT)) {
      const rupees = Number((hit[1] ?? '').replace(/,/g, '')) * (UNITS[(hit[2] ?? '').toLowerCase()] ?? 1);
      if (!Number.isFinite(rupees) || rupees < 100) continue;
      // The words right after the number, up to the next number or the end of the clause.
      const after = (m.text.slice((hit.index ?? 0) + hit[0].length).split(/[\d,.;!?]/)[0] ?? '').slice(0, 40);
      const perHead = PER_HEAD.test(after);
      const perNight = PER_NIGHT.test(after);
      // Per night with no trip dates: there are no nights to count, so the words are unclear.
      if (perNight && group.nights === null) continue;
      const times = (perHead ? group.heads : 1) * (perNight ? (group.nights ?? 1) : 1);
      out.add(Math.round(rupees * 100 * times));
    }
  }
  return [...out];
}

/**
 * Why Go cannot book an option for the group, in the words to say, or null when it can: Go books only an offer the travel
 * layer can hold for the whole group. A place found on the web has no offer; a flight, train or bus fare is per person
 * (booking those for a group is cut this week); an option with no option_ref is not one Go found at all. Those are
 * unbookable. A check that failed is not: the option may well be bookable, so it is only "try again", with no flag.
 */
export async function whyNotBookable(
  d: Pick<MoneyDeps, 'travel'>,
  option: Trip['decisions'][number]['options'][number],
  /** The trip: where Go books each person's own flight (BOOKING), a group flight says how they book theirs. */
  tripId?: string,
): Promise<{ refused: string; unbookable?: true } | null> {
  const words = { payer: 'The payer', what: option.label };
  const travel = d.travel();
  if (!option.option_ref || !travel) return { refused: `${option.label} isn't something I can book here, so there's nothing to set up for paying.`, unbookable: true };
  let offer: Awaited<ReturnType<Travel['offer']>>;
  try {
    offer = await travel.offer(option.option_ref);
  } catch {
    return { refused: `I couldn't check ${option.label} just now. Try again in a moment.` };
  }
  // The option's own page, said only when it is on ixigo.com.
  const link = ixigoPage(offer?.link);
  if (offer && GROUP_FARES.has(offer.kind)) {
    const own = offer.kind === 'flight' && tripId !== undefined && ((await travel.booksFlights?.(tripId).catch(() => false)) ?? false);
    return { refused: refusalWords('not_bookable_yet', { ...words, kind: offer.kind, ...(link ? { link } : {}), ...(own ? { own } : {}) }).text, unbookable: true };
  }
  if (!offer?.offerId) return { refused: refusalWords('not_bookable', { ...words, ...(link ? { link } : {}) }).text, unbookable: true };
  // A vote that outlived its stay's or journey's day: nothing to book, so no mandate.
  if (offer.past) {
    const was = offer.day ? `${option.label} was for ${shortDate(`${offer.day}T12:00:00Z`)}, which has passed` : `${option.label}'s date has passed`;
    return { refused: `${was}, so I can't book it. Want me to search again for dates ahead?`, unbookable: true };
  }
  return null;
}

/**
 * Records what the group allowed after a closed choice vote, and puts the mandate card in the turn.
 * It cannot pay anything: the payer still taps "Yes, book it", and paying still needs both keys.
 */
export async function setMandate(
  d: MoneyDeps,
  ctx: Pick<TurnCtx, 'tripId' | 'stableId' | 'cards' | 'pack'> & Partial<Pick<TurnCtx, 'turnId' | 'wake'>>,
  o: { decisionId: string; choiceIndex: number; capMinor?: number; refundableOnly: boolean; payerPersonId: string },
): Promise<
  | { cardId: string; capMinor: number; byMargin: boolean; note: string | null; booking: string }
  | { refused: string; unbookable?: true; parked?: true; claim?: true; line?: string }
> {
  const vague = { payer: 'The payer', what: 'it' };
  let trip: Trip;
  try {
    trip = await d.link.request('read_trip', { trip_id: ctx.tripId });
  } catch {
    return { refused: refusalWords('server_down', vague).text };
  }
  const decision = trip.decisions.find((x) => x.decision_id === o.decisionId);
  if (!decision || decision.kind !== 'choice') return { refused: refusalWords('no_vote', vague).text };
  if (decision.status !== 'closed') return { refused: refusalWords('decision_not_closed', vague).text };

  // The choice is the winner, or, after a tie, one of the options that tied at the top.
  const top = Math.max(0, ...decision.tally);
  const winner = decision.result_index ?? null;
  const allowed = winner !== null ? o.choiceIndex === winner : top > 0 && decision.tally[o.choiceIndex] === top;
  const winnerLabel = winner !== null ? (decision.options[winner]?.label ?? 'the winner') : 'one of the options that tied';
  const chosen = decision.options[o.choiceIndex];
  // A trip of one: nobody else to agree with, so "you", never "the group".
  const alone = trip.people.length === 1;
  if (!allowed || !chosen) return { refused: `${alone ? 'You' : 'The group'} picked ${winnerLabel}. I can only set that.` };

  // Something Go cannot book needs no payer: say so before anyone is asked who pays. A failed check only says try again.
  const cannot = await whyNotBookable(d, chosen, ctx.tripId);
  if (cannot) return cannot;

  const payer = trip.people.find((p) => p.person_id === o.payerPersonId);
  if (!payer) return { refused: "That person isn't in this trip." };

  // One person books a stay for all (claims.ts): the payer is whoever claimed it, by the card's I'll book it or by asking
  // Go to book it in their own words (that ask is their claim). Go never picks the payer itself.
  let claimedNow = false;
  if (d.claims && chosen.option_ref && (await d.travel()?.offer(chosen.option_ref).catch(() => null))?.kind === 'stay') {
    const held = await d.claims.get(ctx.tripId, o.decisionId);
    const nameOf = (id: string): string => trip.people.find((p) => p.person_id === id)?.name ?? 'Someone';
    // A mandate set before claims came holds as the claim.
    const holder = held?.personId ?? decision.mandate?.payer_person_id ?? null;
    if (holder) {
      if (holder !== payer.person_id) return { refused: `${nameOf(holder)} is already booking this.` };
    } else if (alone || (ctx.wake && askersOf(ctx.wake, ctx.pack).includes(payer.person_id))) {
      // A trip of one has nobody to ask who books: the one person is the payer, with no card asking the group.
      const first = await d.claims.take(ctx.tripId, o.decisionId, payer.person_id);
      if (first !== payer.person_id) return { refused: `${nameOf(first)} is already booking this.` };
      claimedNow = true;
      // The card, when it is up, says who is booking now.
      if (held?.offeredTurn) {
        await d.link.request('replace_card', {
          trip_id: ctx.tripId, card: claimCard({ decisionId: o.decisionId, what: chosen.label, people: trip.people.length, claimer: payer.name }),
        });
      }
    } else {
      // Nobody has claimed it: the card asks the group, on this turn's own post.
      const id = claimCardId(o.decisionId);
      if (ctx.turnId && (await d.claims.offer(ctx.tripId, o.decisionId, ctx.turnId)) && !ctx.cards.some((c) => c.card_id === id)) {
        ctx.cards.push(claimCard({ decisionId: o.decisionId, what: chosen.label, people: trip.people.length, claimer: null }));
      }
      return {
        refused: `One person books ${chosen.label} for all: whoever taps I'll book it on the card, or asks me to book it themselves, is the payer.`,
        claim: true,
      };
    }
  }

  // What the option needs first: a stay from ixigo.com needs the trip's ixigo login (the person is asked on its card, and
  // this call waits on it, made again when the login is in), and its price is ixigo's now, not the vote's.
  let live: number | null = null;
  const prepare = chosen.option_ref ? d.travel()?.prepare : undefined;
  if (prepare && chosen.option_ref) {
    const resume = {
      decision_id: o.decisionId, choice_index: o.choiceIndex, payer_person_id: payer.person_id, refundable_only: o.refundableOnly,
      ...(o.capMinor !== undefined ? { cap_minor: o.capMinor } : {}),
    };
    let ready: Awaited<ReturnType<typeof prepare>>;
    try {
      ready = await prepare(chosen.option_ref, { tripId: ctx.tripId, what: chosen.label, resume, for: payer.person_id });
    } catch {
      return { refused: `I couldn't check ${chosen.label} just now. Try again in a moment.` };
    }
    if (!ready.ok) return { refused: ready.note, parked: true, ...(ready.line ? { line: ready.line } : {}) };
    live = ready.priceMinor;
  }

  // The cap is never invented: an amount someone wrote in the chat, read as they meant it, or the price plus up to 10%.
  const said = amountsSaid(ctx.pack.messages, { heads: trip.people.length, nights: nightsOf(trip) });
  const voted = chosen.price_minor ?? null;
  const price = live ?? voted;
  const currency = chosen.currency ?? trip.money.currency;
  // A price that moved since the vote is said on the mandate, before anyone taps Yes, book it. prepare reads the same
  // number the vote showed, or none, so a move said here is a real one.
  const moved = live !== null && voted !== null && live !== voted
    ? `${chosen.label} is ${money(live, currency)} on ixigo now, ${live > voted ? 'up' : 'down'} from ${money(voted, currency)} on the vote.`
    : null;
  // No cap from the model: nobody said a clear number, so the whole price plus up to 10%, and Go says so.
  const byMargin = o.capMinor === undefined;
  let capMinor: number;
  if (o.capMinor !== undefined) capMinor = o.capMinor;
  else if (price !== null) capMinor = marginCap(price);
  else return { refused: alone ? `Tell me the most you want to spend on ${chosen.label}. I can't see its price.` : `Tell me the most the group agreed to spend on ${chosen.label}. I can't see its price.` };
  if (price !== null && capMinor < price) return { refused: `That cap is below the price of ${chosen.label} (${money(price, currency)}).` };
  const withinMargin = price !== null && capMinor <= marginCap(price);
  if (!withinMargin && !said.includes(capMinor)) {
    const most = price !== null ? `, up to ${money(marginCap(price), currency)},` : '';
    return {
      refused: alone
        ? `Tell me the most you want to spend. I can use the price plus a little margin${most} or a number you said.`
        : `Tell me the cap the group agreed on. I can use the price plus a little margin${most} or a number someone said.`,
    };
  }

  const m = decision.mandate;
  if (m && m.choice_index === o.choiceIndex && m.cap_minor === capMinor && m.currency === currency && m.refundable_only === o.refundableOnly && m.payer_person_id === payer.person_id) {
    return { refused: `That's already set. Waiting on ${payer.name} to tap Yes, book it.` };
  }

  await d.link.request('set_mandate', {
    request_id: ctx.stableId('go_mandate'),
    trip_id: ctx.tripId,
    decision_id: o.decisionId,
    choice_index: o.choiceIndex,
    cap_minor: capMinor,
    currency,
    refundable_only: o.refundableOnly,
    payer_person_id: payer.person_id,
  });
  const cardId = ctx.stableId('c_mandate');
  ctx.cards.push(
    mandateCard({ cardId, decisionId: o.decisionId, what: chosen.label, capMinor, currency, refundableOnly: o.refundableOnly, payerName: payer.name, moved }),
  );
  // Never "nobody said a number": an I'll book it tap sets it with no model reading the chat, where someone may have.
  const margin = byMargin ? `The card allows up to ${money(capMinor, currency)}, in case the price rises a little before it's booked.` : null;
  // Who books, said once: a group hears who books for all of them; one traveller hears what they're booking, and for how much.
  const nights = nightsOf(trip);
  const booking = alone
    ? `${payer.name}, you're booking ${chosen.label}${price !== null ? `, ${money(price, currency)}` : ''}${nights ? ` for ${nights} night${nights === 1 ? '' : 's'}` : ''}.`
    : `${payer.name}, you're booking for all ${trip.people.length}.`;
  const claimed = claimedNow ? booking : null;
  const note = [claimed, moved, margin].filter((x) => x !== null).join(' ') || null;
  return { cardId, capMinor, byMargin, note, booking };
}
