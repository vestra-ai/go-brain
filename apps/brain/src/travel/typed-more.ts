/**
 * "more", "show more", "see more", "aur dikhao", said right after an options card: the same as its See more tap
 * (see-more.ts), with no model round. The lead, 11 Oct: a typed "show more" at 07:58 closed the card's vote and opened a
 * new one. Anything said with it, a turn woken for more than it, or no such card goes to the model as before.
 */
import type { DirectAnswer } from '../composer/context.js';
import { PERSONAL_KINDS } from './cards.js';
import type { ResultsStore } from './results.js';
import type { SeeMore } from './see-more.js';

/** How long after its card a "more" is still about it. */
export const MORE_WITHIN_MS = 2 * 60 * 60_000;

const MORE_WORDS =
  /^(?:(?:please|pls|can you|could you)\s+)?(?:(?:show|see|send|give|get)\s+)?(?:(?:me|us)\s+)?(?:some\s+)?more(?:\s+(?:options|ones|of these|of them|results|stays|hotels|villas|flights|trains|buses|places))?(?:\s+(?:please|pls))?[\s.!?]*$/i;
const MORE_HINGLISH = /^(?:aur|or|more)\s+(?:dikhao|dikha|batao|bhejo)(?:\s+(?:na|please|pls))?[\s.!?]*$/i;

/** A message that only asks for more of what Go showed, @Go or not. */
export const asksForMore = (text: string): boolean => {
  const said = text.replace(/@go\b[\s,:]*/gi, '').trim();
  return MORE_WORDS.test(said) || MORE_HINGLISH.test(said);
};

export function typedMoreAnswer(d: { seeMore: SeeMore; results: Pick<ResultsStore, 'card'> }): DirectAnswer {
  return async ({ tripId, wake, pack, ctx }) => {
    const item = wake[0];
    if (wake.length !== 1 || item?.kind !== 'message') return false;
    const id = (item.payload as { messageId?: string } | null)?.messageId ?? item.ref;
    const at = pack.messages.findIndex((m) => m.message_id === id);
    const said = pack.messages[at];
    if (!said || said.author.kind !== 'person' || !asksForMore(said.text ?? '')) return false;
    const personId = said.author.person_id;
    // The options card Go put up last before it, among those they see.
    const shown = pack.messages
      .slice(0, at)
      .reverse()
      .find((m) => m.author.kind === 'go' && m.card?.kind === 'options' && (!m.card.for_person_ids?.length || m.card.for_person_ids.includes(personId)));
    if (!shown?.card || Date.parse(said.sent_at) - Date.parse(shown.sent_at) > MORE_WITHIN_MS) return false;
    // A card See more answers for: a shared thing's vote, or a ticket's card.
    const row = await d.results.card(tripId, shown.card.card_id);
    if (!row || (!row.card.decision_id && !PERSONAL_KINDS.has(row.optionKind))) return false;
    const answer = await d.seeMore({ tripId, cardId: row.cardId, personId, key: said.message_id });
    // Its card follows, as a tap's does; what a tap would toast is said.
    if (answer.toast) ctx.lines.push(`${answer.toast}.`);
    ctx.answered = true;
    return true;
  };
}
