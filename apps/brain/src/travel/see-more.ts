/**
 * "See more" (rev 5 R4; Keshav, 11 Oct: "show 10 then see more button, and on click 10 more etc"): the tap on an options
 * card (taps.ts), and the same asked in words right after the card ("show more", typed-more.ts), are one thing: the next
 * 10 of the same search, in the same vote for a shared thing, on a card of their own for a ticket.
 */
import { PERSONAL_KINDS, buildOptionsCard, isChooseCard } from './cards.js';
import { SocketCallError } from '../door/rpc.js';
import { stableId } from './ids.js';
import { MORE_CARD, optionKey, toResultOption, unseenNumbers, type ResultSet } from './results.js';
import { CARD_SHOWS, cardPicks } from './tools.js';
import type { Travel, TravelQuery } from './travel.js';
import { addToVote, VOTE_MOST } from './votes.js';
import type { TravelTapDeps } from './taps.js';

/** What a "See more" toasts while its card is still coming: a tap's toast, never a line of its own when typed (typed-more.ts). */
export const LOOKING_FOR_MORE = 'Looking for more on ixigo';
export const MORE_ON_THE_WAY = 'More are on the way';
export const WORKING_TOASTS: ReadonlySet<string> = new Set([LOOKING_FOR_MORE, MORE_ON_THE_WAY]);

/** "See more" with nothing more: the search's own all shown, and ixigo has no next page of it. */
export const ALL_SHOWN = "That's all ixigo has for this search";

/** What a "See more" answers at once: done (its card follows), or refused, with a few words when there are any. */
export type SeeMoreAnswer = { result: 'done'; toast?: string } | { result: 'refused'; toast: string };

/** key: what makes it once (a tap's id, or the message that asked): the same key again does each write once. */
export type SeeMore = (o: { tripId: string; cardId: string; personId: string; key: string }) => Promise<SeeMoreAnswer>;

export function createSeeMore(d: Pick<TravelTapDeps, 'results' | 'link' | 'log' | 'images' | 'travel' | 'placeCover'>): SeeMore {
  // The searches whose "See more" is running: a second ask meanwhile (a double tap, two people, another card of the same
  // search, a tap and a "show more") would add the same options again.
  const moreRunning = new Set<string>();

  /**
   * ixigo's next page of a stays search, read on the stage like any search: its stays the set doesn't hold are kept after
   * the set's own, and ixigo has no more after it (two pages, the most hotels.search reads). The set as kept now.
   */
  async function nextPage(tripId: string, set: ResultSet, travel: Pick<Travel, 'search'>): Promise<ResultSet> {
    const q: TravelQuery = { ...(set.query as TravelQuery), pages: 2 };
    const found = await travel.search('stays', q, { tripId });
    const known = new Set(set.options.map(optionKey));
    const fresh = found.results.map(toResultOption).filter((o) => {
      const key = optionKey(o);
      if (known.has(key)) return false;
      known.add(key);
      return true;
    });
    return (await d.results.extend(tripId, set.resultsId, { options: fresh, query: q, siteMore: false })) ?? set;
  }

  // "See more" (rev 5 R4; Keshav, 11 Oct: "show 10 then see more button, and on click 10 more etc"): the next 10 of the
  // same search that no card has shown, on a new card. A shared thing's joins the card's vote, up to the most one vote
  // takes (VOTE_MOST); a ticket's (PERSONAL_KINDS) is the tapper's own, for them alone, each person with their own next 10.
  // Once the set's own are all shown, a stays search ixigo has more of (siteMore) reads ixigo's next page first. The tap
  // answers at once and the card follows, and the card tapped hands its See more on to it; with nothing more, the vote
  // closed or full, a toast says so instead.
  return async (o) => {
    const row = await d.results.card(o.tripId, o.cardId);
    const set = row ? await d.results.get(o.tripId, row.resultsId) : null;
    const personal = !!row && PERSONAL_KINDS.has(row.optionKind);
    const decisionId = row?.card.decision_id ?? null;
    // A trip of one's card (Choose this, no vote): its next 10 are theirs to choose from too.
    const chooser = row && isChooseCard(row.card) ? (row.card.for_person_ids?.[0] ?? null) : null;
    const images = d.images;
    if (!row || !set || (!personal && !decisionId && !chooser) || !images) return { result: 'refused', toast: 'Those options are no longer here' };
    // A second tap meanwhile (a double tap, two people, another card of the same search) would add the same options again.
    const lock = personal ? `${set.resultsId}|${o.personId}` : set.resultsId;
    if (moreRunning.has(lock)) return { result: 'done', toast: MORE_ON_THE_WAY };
    // Claimed before anything waits, until its card is up or it gives up.
    moreRunning.add(lock);
    let running = false;
    try {
      const shownTo = personal ? o.personId : undefined;
      const unseen = unseenNumbers(set, await d.results.shownFrom(o.tripId, set.resultsId, shownTo));
      const travel = unseen.length === 0 && set.siteMore ? d.travel : undefined;
      if (unseen.length === 0 && !travel) return { result: 'done', toast: ALL_SHOWN };
      const trip = await d.link.request('read_trip', { trip_id: o.tripId });
      let voted = 0;
      if (decisionId) {
        const vote = trip.decisions.find((x) => x.decision_id === decisionId);
        if (vote?.status !== 'open') return { result: 'done', toast: 'The vote has closed' };
        if (vote.options.length >= VOTE_MOST) return { result: 'done', toast: `This vote has ${VOTE_MOST} options, the most one vote takes` };
        voted = vote.options.length;
      }
      const room = decisionId ? Math.min(CARD_SHOWS, VOTE_MOST - voted) : CARD_SHOWS;
      const people = typeof set.query['guests'] === 'number' ? set.query['guests'] : trip.people.length;
      // The card tapped is a person's own, or the vote's: its See more goes on to the next card. A ticket's card for the
      // room keeps it, for everyone else's next 10.
      const handsOn = !personal || (row.card.for_person_ids ?? []).join() === o.personId;
      // Outside a turn, ids come from the tap, so a repeat does each write once.
      const cardId = stableId(MORE_CARD, o.key);
      const more = async (): Promise<void> => {
        let shown = false;
        try {
          const from = travel ? await nextPage(o.tripId, set, travel) : set;
          const left = travel ? unseenNumbers(from, await d.results.shownFrom(o.tripId, set.resultsId, shownTo)) : unseen;
          if (left.length === 0) {
            // ixigo's next page held nothing new: the card tapped loses its See more.
            const card = await d.results.dropMore(o.tripId, o.cardId);
            if (card) await d.link.request('replace_card', { trip_id: o.tripId, card });
            return;
          }
          const numbers = left.slice(0, room);
          const after = (left.length > numbers.length || !!from.siteMore) && (!decisionId || voted + numbers.length < VOTE_MOST);
          const picks = await cardPicks(from, numbers, cardId, people, { images, ...(d.placeCover ? { placeCover: d.placeCover } : {}) });
          const title = `More: ${row.title.replace(/^More: /, '')}`;
          const card = buildOptionsCard({
            cardId, title, optionKind: row.optionKind, checkedAt: from.checkedAt, picks,
            ...(personal ? { forPersonIds: [o.personId], ...(after ? { more: true } : {}) } : {}),
            ...(chooser ? { choose: true, forPersonIds: [chooser], ...(after ? { more: true } : {}) } : {}),
          });
          await d.results.saveCard({ cardId, tripId: o.tripId, resultsId: set.resultsId, title: card.title, optionKind: row.optionKind, card }, picks, from.checkedAt);
          const requestId = stableId('go_more_card', o.key);
          if (decisionId) {
            await addToVote({ results: d.results, link: d.link }, { tripId: o.tripId, cardId, decisionId, requestId: stableId('go_more', o.key) });
            shown = true;
            const voting = await d.results.setCardDecision(o.tripId, cardId, decisionId, after);
            if (voting) await d.link.request('post_message', { trip_id: o.tripId, request_id: requestId, card: voting });
          } else {
            await d.link.request('post_message', { trip_id: o.tripId, request_id: requestId, card, visible_to_person_ids: [o.personId] });
            shown = true;
          }
          if (handsOn) {
            const tapped = await d.results.dropMore(o.tripId, o.cardId);
            if (tapped) await d.link.request('replace_card', { trip_id: o.tripId, card: tapped });
          }
        } catch (err) {
          // Options the Server refused (to add to the vote, or to post) were never shown, so the next See more offers them
          // again. A 503 (the Server unreachable, after the link's retries) may have taken them all the same: the card and
          // its offers are kept, unposted, so a winner among them can still be booked and none is added twice.
          const refused = err instanceof SocketCallError && err.code !== 503;
          if (!shown && refused) await d.results.dropCard(o.tripId, cardId).catch(() => undefined);
          throw err;
        } finally {
          moreRunning.delete(lock);
        }
      };
      // The card goes up after the answer: ixigo's next page, a page of photos and the Server's requests must not hold
      // the 3 s tap answer.
      running = true;
      void more().catch((err: unknown) => d.log.error({ err, cardId: o.cardId }, 'travel: See more failed'));
      return travel ? { result: 'done', toast: LOOKING_FOR_MORE } : { result: 'done' };
    } finally {
      if (!running) moreRunning.delete(lock);
    }
  };
}
