/**
 * Opening a vote from an options card, once per card: a claim on the card's row (a turn id or a tap id) makes a second
 * tap a no-op, and the same key again (a rerun of the same turn) gets the same vote back. Each vote option's option_ref
 * is the option's id, so P5 finds the offer with brain.travel.offer(option_ref). A stay is put to the vote at its
 * whole-stay price, which is what gets paid. The caller shows the vote card: a turn puts it in ctx.cards, a tap posts it.
 */
import type * as C from '@go/contract';
import type { ServerLink } from '../door/server-link.js';
import { clip, formatInr } from './cards.js';
import type { OptionKind, ResultsStore } from './results.js';
import type { StoredOffer } from './travel.js';

export type VoteCard = Extract<C.Card, { kind: 'vote' }>;
export type VoteOutcome =
  | { ok: true; decisionId: string; voteCard: VoteCard }
  | { ok: false; reason: 'unknown_card' | 'already_voting' | 'too_few_options'; decisionId?: string };

const QUESTIONS: Record<OptionKind, string> = {
  stay: 'Where do we stay?', flight: 'Which flight?', train: 'Which train?', bus: 'Which bus?', place: 'Where do we go?', food: 'Where do we eat?', activity: 'What do we do?',
};

interface VoteOption { label: string; image_url?: string; price_minor?: number; currency?: string; option_ref: string; note?: string }

function voteOptions(offers: StoredOffer[], shown: Map<string, { image_url?: string | null | undefined; subtitle?: string | null | undefined }>): VoteOption[] {
  return offers.slice(0, 10).map((of) => {
    const c = shown.get(of.optionId);
    const price = of.totalMinor ?? of.priceMinor;
    return {
      label: clip(of.title, 120),
      ...(c?.image_url ? { image_url: c.image_url } : {}),
      ...(price !== null ? { price_minor: price, currency: of.currency ?? 'INR' } : {}),
      option_ref: of.optionId,
      ...(c?.subtitle ? { note: clip(c.subtitle, 120) } : {}),
    };
  });
}

function voteCardFor(id: string, decisionId: string, question: string, options: VoteOption[]): VoteCard {
  const listed = options.map((op) => (op.price_minor !== undefined ? `${op.label} ${formatInr(op.price_minor)}` : op.label)).join(', ');
  return { card_id: id, kind: 'vote', decision_id: decisionId, fallback_text: clip(`Vote: ${question} ${listed}. Open Go to vote.`, 300) };
}

export async function openVoteFromCard(
  d: { results: ResultsStore; link: Pick<ServerLink, 'request'>; now: () => Date },
  o: { tripId: string; cardId: string; key: string; requestId: string; voteCardId: string; question?: string; closesInHours?: number },
): Promise<VoteOutcome> {
  const row = await d.results.card(o.tripId, o.cardId);
  if (!row) return { ok: false, reason: 'unknown_card' };
  const offers = await d.results.offersOnCard(o.cardId);
  const shown = new Map(row.card.options.map((op) => [op.option_id, op]));
  const options = voteOptions(offers, shown);
  const question = clip(o.question ?? QUESTIONS[row.optionKind], 200);
  if (row.decisionId && !row.decisionId.startsWith('pending:')) {
    // The same key again is a rerun of the turn that opened it: show the same vote, open nothing new.
    if (row.voteKey === o.key) return { ok: true, decisionId: row.decisionId, voteCard: voteCardFor(o.voteCardId, row.decisionId, question, options) };
    return { ok: false, reason: 'already_voting', decisionId: row.decisionId };
  }
  if (offers.length < 2) return { ok: false, reason: 'too_few_options' };
  if (!(await d.results.claimVote(o.cardId, o.key))) return { ok: false, reason: 'already_voting' };
  try {
    const closesAt = new Date(d.now().getTime() + (o.closesInHours ?? 3) * 3_600_000).toISOString();
    const opened = await d.link.request('open_vote', {
      trip_id: o.tripId, request_id: o.requestId, question, kind: 'choice', anonymous: false, options, closes_at: closesAt,
    });
    await d.results.setDecision(o.cardId, opened.decision_id);
    return { ok: true, decisionId: opened.decision_id, voteCard: voteCardFor(o.voteCardId, opened.decision_id, question, options) };
  } catch (err) {
    await d.results.releaseVote(o.cardId, o.key);
    throw err;
  }
}
