/**
 * Opening a vote on an options card, once per card: a claim on the card's row (a turn id or a tap id) makes a second
 * tap a no-op, and the same key again (a rerun of the same turn) gets the same vote back. Each vote option's option_ref
 * is the option's id, so P5 finds the offer with brain.travel.offer(option_ref). A stay is put to the vote at its
 * whole-stay price, which is what gets paid.
 *
 * Since rev 5 (the Server team, 11 Oct, R5) a shared thing's card is its vote: the vote opens as the card goes up, and the
 * card names it (onCard), so the App draws Vote on each option; "See more" adds the next card's options to it (R4,
 * addToVote). A card from before, or put to the vote by put_to_vote, gets its vote card as before: a card with one option
 * is that option or "Keep looking", and the caller shows the vote card (a turn puts it in ctx.cards, a tap posts it).
 */
import type * as C from '@go/contract';
import type { ServerLink } from '../door/server-link.js';
import { clip, formatInr, ixigoPage, PERSONAL_KINDS, placeKindNotAll, stayLine, type OptionsCardT } from './cards.js';
import type { OptionFields, OptionKind, ResultOption, ResultsStore } from './results.js';
import type { StoredOffer } from './travel.js';

/** How long a vote runs unless asked otherwise: a day, as it opens with its card, before anyone has looked (the lead, 11 Oct). */
export const VOTE_HOURS = 24;
/** The most options one vote takes, with "See more" (contract 1.3's Decision.options). */
export const VOTE_MOST = 20;

export type VoteCard = Extract<C.Card, { kind: 'vote' }>;
export type VoteOutcome =
  /** size: how many options the vote holds now, when this opened or joined it (a card's See more needs room in it). */
  | { ok: true; decisionId: string; voteCard: VoteCard; size?: number }
  | { ok: false; reason: 'unknown_card' | 'already_voting' | 'too_few_options' | 'personal'; decisionId?: string };

const QUESTIONS: Record<OptionKind, string> = {
  stay: 'Where do we stay?', flight: 'Which flight?', train: 'Which train?', bus: 'Which bus?', place: 'Where do we go?', food: 'Where do we eat?', activity: 'What do we do?',
  cab: 'Which cab?',
};

/**
 * A vote on ixigo.com's stays never asks "Which pool villa?" of hotels and resorts: a kind of place the question names
 * that not every option is by its own name becomes "stay" ("Which pool stay for 6 to 9 Nov?"), as the options card's
 * title does (re-drill 7). Other votes keep the question as asked.
 */
function stayQuestion(question: string, offers: StoredOffer[]): string {
  if (!offers.some((of) => of.kind === 'stay' && ixigoPage(of.sourceUrl))) return question;
  const kind = placeKindNotAll(question, offers.map((of) => of.title));
  if (!kind) return question;
  return question.replace(new RegExp(`\\b(${kind})(s?)\\b`, 'gi'), (_w, k: string, s: string) => `${k[0] === k[0]!.toUpperCase() ? 'S' : 's'}tay${s}`);
}

type VoteOption = { label: string; image_url?: string; price_minor?: number; currency?: string; option_ref?: string; note?: string; details?: OptionsCardT['options'][number]['details'] } & OptionFields;

/** The other answer of a one-option vote: no offer behind it, so nothing is ever booked when it wins. */
export const KEEP_LOOKING = 'Keep looking';

/**
 * Each option as the options card shows it: its photos, its details and its rooms too, the top pick's from its own page
 * once read (pick-photos.ts, the Server team's 10 Oct B3 and B4; rev 5 R5). kept: each stay as its search saved it, for
 * its note.
 */
function voteOptions(offers: StoredOffer[], shown: Map<string, OptionsCardT['options'][number]>, kept: Map<string, ResultOption> = new Map()): VoteOption[] {
  return offers.slice(0, 10).map((of) => {
    const c = shown.get(of.optionId);
    // A stay's note says its whole stay first and its night in brackets (stayLine), as the pay card then says it.
    const stay = of.kind === 'stay' ? kept.get(of.optionId) : undefined;
    const note = stay ? stayLine(stay) : (c?.subtitle ?? null);
    // A stay's is its whole stay, as on its card, or none: never a night's (the Server team's 10 Oct §6c).
    const price = of.kind === 'stay' ? of.totalMinor : (of.totalMinor ?? of.priceMinor);
    return {
      label: clip(of.title, 120),
      ...(c?.image_url ? { image_url: c.image_url } : {}),
      ...(price !== null ? { price_minor: price, currency: of.currency ?? 'INR' } : {}),
      option_ref: of.optionId,
      ...(note ? { note: clip(note, 120) } : {}),
      ...(c?.photos?.length ? { photos: c.photos } : {}),
      ...(c?.details ? { details: c.details } : {}),
      ...(c?.room_types?.length ? { room_types: c.room_types } : {}),
      ...(typeof c?.price_min_minor === 'number' ? { price_min_minor: c.price_min_minor } : {}),
      ...(typeof c?.price_max_minor === 'number' ? { price_max_minor: c.price_max_minor } : {}),
    };
  });
}

type CardRow = NonNullable<Awaited<ReturnType<ResultsStore['card']>>>;

/**
 * A card's options as its vote gives them: each as the card shows it, and a stay's note from the stay as its search saved
 * it with its own offer (an offer's n is its place on the card, not in the search: a card of a search's 2nd, 5th and 7th
 * once took the 1st, 2nd and 3rd's notes).
 */
async function cardVoteOptions(results: Pick<ResultsStore, 'offersOnCard' | 'optionsOnCard'>, row: Pick<CardRow, 'cardId' | 'optionKind' | 'card'>) {
  const offers = await results.offersOnCard(row.cardId);
  const shown = new Map(row.card.options.map((op) => [op.option_id, op]));
  const kept = row.optionKind === 'stay' ? await results.optionsOnCard(row.cardId) : new Map<string, ResultOption>();
  return { offers, options: voteOptions(offers, shown, kept) };
}

/**
 * The trip's open vote on an earlier card of the same kind (another turn's or tap's), and how many options it has: a new
 * card of the same thing joins it, never closing it (the Manali room, 11 Oct: every new stays search closed the open vote
 * and opened another, four in 22 minutes, and votes cast would have gone the same way). Null when none is open. Two cards
 * in one reply are two votes the group just got: never one this same key opened.
 */
async function openVoteOfKind(
  d: { results: Pick<ResultsStore, 'votesOfKind'>; link: Pick<ServerLink, 'request'> }, tripId: string, kind: OptionKind, cardId: string, key: string,
): Promise<{ decisionId: string; count: number } | null> {
  const ids = await d.results.votesOfKind(tripId, kind, cardId, key);
  if (ids.length === 0) return null;
  const trip = await d.link.request('read_trip', { trip_id: tripId });
  const vote = trip.decisions.filter((dec) => ids.includes(dec.decision_id) && dec.status === 'open').at(-1);
  return vote ? { decisionId: vote.decision_id, count: vote.options.length } : null;
}

function voteCardFor(id: string, decisionId: string, question: string, options: VoteOption[]): VoteCard {
  const listed = options.map((op) => (op.price_minor !== undefined ? `${op.label} ${formatInr(op.price_minor)}` : op.label)).join(', ');
  return { card_id: id, kind: 'vote', decision_id: decisionId, fallback_text: clip(`Vote: ${question} ${listed}. Open Go to vote.`, 300) };
}

/**
 * onCard: the card is the vote (rev 5 R5), opened as it goes up, and the caller writes it into the card
 * (results.setCardDecision): a card with one option gets none (a "Keep looking" has no row on the card to vote on). With
 * the trip's vote of the same kind open (openVoteOfKind), the card joins it instead: its options are added
 * (add_vote_options, VOTE_MOST in all), and one with more than the vote has room for goes up without a vote, the open one as
 * it is. No vote is ever closed for a new card.
 */
export async function openVoteFromCard(
  d: { results: ResultsStore; link: Pick<ServerLink, 'request'>; now: () => Date },
  o: { tripId: string; cardId: string; key: string; requestId: string; voteCardId: string; question?: string; closesInHours?: number; anonymous?: boolean; onCard?: boolean },
): Promise<VoteOutcome> {
  const row = await d.results.card(o.tripId, o.cardId);
  if (!row) return { ok: false, reason: 'unknown_card' };
  // A ticket is its traveller's own (PERSONAL_KINDS): confirmed by them alone, never put to the group.
  if (PERSONAL_KINDS.has(row.optionKind)) return { ok: false, reason: 'personal' };
  const { offers, options: each } = await cardVoteOptions(d.results, row);
  if (o.onCard && offers.length < 2) return { ok: false, reason: 'too_few_options' };
  // A card with one option is put to the group as that option or keep looking: still a choice vote on the offer
  // itself, so its winner can be booked (8 Oct run sheet: a one-option card's vote failed here, Go opened a yes/no vote
  // of its own, and "I'll book it" then had nothing to book).
  const one = offers.length === 1;
  const options = one ? [...each, { label: KEEP_LOOKING }] : each;
  const question = clip(one ? (o.question ?? `Go with ${clip(offers[0]!.title, 120)}?`) : stayQuestion(o.question ?? QUESTIONS[row.optionKind], offers), 200);
  if (row.decisionId && !row.decisionId.startsWith('pending:')) {
    // The same key again is a rerun of the turn that opened it: show the same vote, open nothing new.
    if (row.voteKey === o.key) return { ok: true, decisionId: row.decisionId, voteCard: voteCardFor(o.voteCardId, row.decisionId, question, options) };
    return { ok: false, reason: 'already_voting', decisionId: row.decisionId };
  }
  if (offers.length === 0) return { ok: false, reason: 'too_few_options' };
  if (!(await d.results.claimVote(o.cardId, o.key))) return { ok: false, reason: 'already_voting' };
  try {
    // Best effort: a trip the Server can't read now still gets the card's vote.
    const open = o.onCard ? await openVoteOfKind(d, o.tripId, row.optionKind, o.cardId, o.key).catch(() => null) : null;
    if (open) {
      // Every option of the card, each by its own option_ref, so each of its Vote buttons is a vote (a stay an earlier
      // card shows too is on that card under its own).
      if (open.count + each.length > VOTE_MOST) {
        await d.results.releaseVote(o.cardId, o.key);
        return { ok: false, reason: 'already_voting', decisionId: open.decisionId };
      }
      await d.link.request('add_vote_options', { request_id: o.requestId, trip_id: o.tripId, decision_id: open.decisionId, options: each });
      await d.results.setDecision(o.cardId, open.decisionId);
      return { ok: true, decisionId: open.decisionId, voteCard: voteCardFor(o.voteCardId, open.decisionId, question, options), size: open.count + each.length };
    }
    const closesAt = new Date(d.now().getTime() + (o.closesInHours ?? VOTE_HOURS) * 3_600_000).toISOString();
    const opened = await d.link.request('open_vote', {
      trip_id: o.tripId, request_id: o.requestId, question, kind: 'choice', anonymous: o.anonymous ?? false, options, closes_at: closesAt,
    });
    await d.results.setDecision(o.cardId, opened.decision_id);
    return { ok: true, decisionId: opened.decision_id, voteCard: voteCardFor(o.voteCardId, opened.decision_id, question, options), size: options.length };
  } catch (err) {
    await d.results.releaseVote(o.cardId, o.key);
    throw err;
  }
}

/**
 * "See more" (rev 5 R4): a new card's options join the vote of the card it came from; the caller then writes the vote
 * into the new card (results.setCardDecision). The caller has checked the vote is open and has room (20 options in all,
 * the contract's); votes already cast stay. Throws when the card is gone or the Server refuses.
 */
export async function addToVote(
  d: { results: ResultsStore; link: Pick<ServerLink, 'request'> },
  o: { tripId: string; cardId: string; decisionId: string; requestId: string },
): Promise<void> {
  const row = await d.results.card(o.tripId, o.cardId);
  if (!row) throw new Error(`no card ${o.cardId} to add to the vote`);
  const { options } = await cardVoteOptions(d.results, row);
  await d.link.request('add_vote_options', { request_id: o.requestId, trip_id: o.tripId, decision_id: o.decisionId, options });
}
