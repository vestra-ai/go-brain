/**
 * Opening a vote from an options card, once per card: a claim on the card's row (a turn id or a tap id) makes a second
 * tap a no-op, and the same key again (a rerun of the same turn) gets the same vote back. Each vote option's option_ref
 * is the option's id, so P5 finds the offer with brain.travel.offer(option_ref). A stay is put to the vote at its
 * whole-stay price, which is what gets paid. A card with one option is that option or "Keep looking". The caller shows
 * the vote card: a turn puts it in ctx.cards, a tap posts it.
 */
import type * as C from '@go/contract';
import type { ServerLink } from '../door/server-link.js';
import { clip, formatInr, ixigoPage, PERSONAL_KINDS, placeKindNotAll, stayLine, type OptionsCardT } from './cards.js';
import type { OptionFields, OptionKind, ResultOption, ResultsStore } from './results.js';
import type { StoredOffer } from './travel.js';

export type VoteCard = Extract<C.Card, { kind: 'vote' }>;
export type VoteOutcome =
  | { ok: true; decisionId: string; voteCard: VoteCard }
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

type VoteOption = { label: string; image_url?: string; price_minor?: number; currency?: string; option_ref?: string; note?: string } & OptionFields;

/** The other answer of a one-option vote: no offer behind it, so nothing is ever booked when it wins. */
export const KEEP_LOOKING = 'Keep looking';

/**
 * Each option as the options card shows it: its photos and its rooms too, the top pick's from its own page once read
 * (pick-photos.ts, the Server team's 10 Oct B3 and B4). kept: each stay as its search saved it, for its note.
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
      ...(c?.room_types?.length ? { room_types: c.room_types } : {}),
      ...(typeof c?.price_min_minor === 'number' ? { price_min_minor: c.price_min_minor } : {}),
      ...(typeof c?.price_max_minor === 'number' ? { price_max_minor: c.price_max_minor } : {}),
    };
  });
}

/** Each stay on a card as its search saved it (its facts, its night and its whole stay), by its option id. */
async function keptStays(results: Pick<ResultsStore, 'get'>, tripId: string, offers: StoredOffer[]): Promise<Map<string, ResultOption>> {
  const sets = new Map<string, Awaited<ReturnType<ResultsStore['get']>>>();
  const kept = new Map<string, ResultOption>();
  for (const offer of offers) {
    if (!sets.has(offer.resultsId)) sets.set(offer.resultsId, await results.get(tripId, offer.resultsId));
    const option = sets.get(offer.resultsId)?.options[offer.n - 1];
    if (option) kept.set(offer.optionId, option);
  }
  return kept;
}

function voteCardFor(id: string, decisionId: string, question: string, options: VoteOption[]): VoteCard {
  const listed = options.map((op) => (op.price_minor !== undefined ? `${op.label} ${formatInr(op.price_minor)}` : op.label)).join(', ');
  return { card_id: id, kind: 'vote', decision_id: decisionId, fallback_text: clip(`Vote: ${question} ${listed}. Open Go to vote.`, 300) };
}

export async function openVoteFromCard(
  d: { results: ResultsStore; link: Pick<ServerLink, 'request'>; now: () => Date },
  o: { tripId: string; cardId: string; key: string; requestId: string; voteCardId: string; question?: string; closesInHours?: number; anonymous?: boolean },
): Promise<VoteOutcome> {
  const row = await d.results.card(o.tripId, o.cardId);
  if (!row) return { ok: false, reason: 'unknown_card' };
  // A ticket is its traveller's own (PERSONAL_KINDS): confirmed by them alone, never put to the group.
  if (PERSONAL_KINDS.has(row.optionKind)) return { ok: false, reason: 'personal' };
  const offers = await d.results.offersOnCard(o.cardId);
  const shown = new Map(row.card.options.map((op) => [op.option_id, op]));
  const kept = row.optionKind === 'stay' ? await keptStays(d.results, o.tripId, offers) : new Map<string, ResultOption>();
  // A card with one option is put to the group as that option or keep looking: still a choice vote on the offer
  // itself, so its winner can be booked (8 Oct run sheet: a one-option card's vote failed here, Go opened a yes/no vote
  // of its own, and "I'll book it" then had nothing to book).
  const one = offers.length === 1;
  const options = one ? [...voteOptions(offers, shown, kept), { label: KEEP_LOOKING }] : voteOptions(offers, shown, kept);
  const question = clip(one ? (o.question ?? `Go with ${clip(offers[0]!.title, 120)}?`) : stayQuestion(o.question ?? QUESTIONS[row.optionKind], offers), 200);
  if (row.decisionId && !row.decisionId.startsWith('pending:')) {
    // The same key again is a rerun of the turn that opened it: show the same vote, open nothing new.
    if (row.voteKey === o.key) return { ok: true, decisionId: row.decisionId, voteCard: voteCardFor(o.voteCardId, row.decisionId, question, options) };
    return { ok: false, reason: 'already_voting', decisionId: row.decisionId };
  }
  if (offers.length === 0) return { ok: false, reason: 'too_few_options' };
  if (!(await d.results.claimVote(o.cardId, o.key))) return { ok: false, reason: 'already_voting' };
  try {
    const closesAt = new Date(d.now().getTime() + (o.closesInHours ?? 3) * 3_600_000).toISOString();
    const opened = await d.link.request('open_vote', {
      trip_id: o.tripId, request_id: o.requestId, question, kind: 'choice', anonymous: o.anonymous ?? false, options, closes_at: closesAt,
    });
    await d.results.setDecision(o.cardId, opened.decision_id);
    return { ok: true, decisionId: opened.decision_id, voteCard: voteCardFor(o.voteCardId, opened.decision_id, question, options) };
  } catch (err) {
    await d.results.releaseVote(o.cardId, o.key);
    throw err;
  }
}
