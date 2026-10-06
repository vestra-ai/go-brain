import type { TurnCtx } from '../composer/tools.js';
import type { Message, Trip } from '../door/methods.js';
import { mandateCard } from './cards.js';
import type { MoneyDeps } from './deps.js';
import { money, refusalWords } from './words.js';

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
 * Records what the group allowed after a closed choice vote, and puts the mandate card in the turn.
 * It cannot pay anything: the payer still taps "Yes, book it", and paying still needs both keys.
 */
export async function setMandate(
  d: MoneyDeps,
  ctx: Pick<TurnCtx, 'tripId' | 'stableId' | 'cards' | 'pack'>,
  o: { decisionId: string; choiceIndex: number; capMinor?: number; refundableOnly: boolean; payerPersonId: string },
): Promise<{ cardId: string; capMinor: number; byMargin: boolean; note: string | null } | { refused: string }> {
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
  if (!allowed || !chosen) return { refused: `The group picked ${winnerLabel}. I can only set that.` };

  const payer = trip.people.find((p) => p.person_id === o.payerPersonId);
  if (!payer) return { refused: "That person isn't in this trip." };

  // The cap is never invented: an amount someone wrote in the chat, read as they meant it, or the price plus up to 10%.
  const said = amountsSaid(ctx.pack.messages, { heads: trip.people.length, nights: nightsOf(trip) });
  const price = chosen.price_minor ?? null;
  const currency = chosen.currency ?? trip.money.currency;
  // No cap from the model: nobody said a clear number, so the whole price plus up to 10%, and Go says so.
  const byMargin = o.capMinor === undefined;
  let capMinor: number;
  if (o.capMinor !== undefined) capMinor = o.capMinor;
  else if (price !== null) capMinor = marginCap(price);
  else return { refused: `Tell me the most the group agreed to spend on ${chosen.label}. I can't see its price.` };
  if (price !== null && capMinor < price) return { refused: `That cap is below the price of ${chosen.label} (${money(price, currency)}).` };
  const withinMargin = price !== null && capMinor <= marginCap(price);
  if (!withinMargin && !said.includes(capMinor)) {
    const most = price !== null ? `, up to ${money(marginCap(price), currency)},` : '';
    return { refused: `Tell me the cap the group agreed on. I can use the price plus a little margin${most} or a number someone said.` };
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
    mandateCard({ cardId, decisionId: o.decisionId, what: chosen.label, capMinor, currency, refundableOnly: o.refundableOnly, payerName: payer.name }),
  );
  const note = byMargin ? `Nobody said a clear number, so I set the cap at ${money(capMinor, currency)}: the price plus a little margin.` : null;
  return { cardId, capMinor, byMargin, note };
}
