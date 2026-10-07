/**
 * Taps on Go's options cards. "Put it to a vote" opens the vote in code (fast and once); "I'll take this" goes on the
 * desk, so the composer answers the person in the room; "See on ixigo" opens the option's own ixigo.com page.
 */
import type { Brain } from '../app.js';
import type { DeskItem } from '../desk/desk.js';
import type { TripPack } from '../trips/pack.js';
import { clip, ixigoPage } from './cards.js';
import { stableId } from './ids.js';
import type { ResultsStore } from './results.js';
import { openVoteFromCard } from './votes.js';

export interface TravelTapDeps {
  results: ResultsStore;
  link: Brain['door']['link'];
  desk: Brain['desk'];
  now: () => Date;
  log: Brain['log'];
}

/** How long the App may hold an ixigo page it was told to open: the time its prices count as fresh. */
export const OPEN_FOR_MS = 10 * 60_000;

export function registerTravelTaps(taps: Brain['taps'], d: TravelTapDeps): void {
  taps.on('options', 'vote', async (tap) => {
    const row = await d.results.card(tap.trip_id, tap.card_id);
    if (!row) return { result: 'refused', toast: 'Those options are no longer here' };
    if (row.decisionId) return { result: 'done', toast: 'Already up for a vote' };
    const failed = () =>
      d.desk.put({
        id: `travel:vote_failed:${tap.tap_id}`, tripId: tap.trip_id, kind: 'tap', ref: tap.card_id, dueAt: d.now(),
        payload: { source: 'options', action: 'vote_failed', cardId: tap.card_id, personId: tap.person_id },
      });
    // Outside a turn, ids come from the tap, so a repeat does each write once.
    const opening = async (): Promise<void> => {
      const r = await openVoteFromCard(
        { results: d.results, link: d.link, now: d.now },
        { tripId: tap.trip_id, cardId: tap.card_id, key: tap.tap_id, requestId: stableId('go_tap', tap.tap_id, 'vote'), voteCardId: stableId('c_vote', tap.tap_id) },
      );
      if (r.ok) {
        await d.link.request('post_message', { trip_id: tap.trip_id, request_id: stableId('go_tap', tap.tap_id, 'vote_card'), card: r.voteCard });
        return;
      }
      if (r.reason !== 'already_voting') await failed();
    };
    // The vote opens after the answer: two requests to the Server must not hold the 3 s tap answer.
    void opening()
      .catch(async (err: unknown) => {
        d.log.error({ err, cardId: tap.card_id }, 'travel: opening a vote from a tap failed');
        await failed();
      });
    return { result: 'done', toast: 'Putting it to a vote' };
  });

  taps.on('options', 'pick', async (tap) => {
    const offer = tap.option_id ? await d.results.offer(tap.option_id) : null;
    if (!offer || offer.cardId !== tap.card_id || offer.tripId !== tap.trip_id) return { result: 'refused', toast: 'That option is no longer available' };
    await d.desk.put({
      id: `travel:pick:${tap.tap_id}`, tripId: tap.trip_id, kind: 'tap', ref: tap.card_id, dueAt: d.now(),
      payload: { source: 'options', action: 'pick', cardId: tap.card_id, optionId: offer.optionId, n: offer.n, title: offer.title, personId: tap.person_id },
    });
    return { result: 'done', toast: 'Noted. Go will reply in the room.' };
  });

  // The flights link card: its own ixigo page, from the card itself.
  taps.on('notice', 'see_on_ixigo', async (_tap, card) => {
    const url = card.kind === 'notice' ? ixigoPage(card.source?.url) : null;
    if (!url) return { result: 'refused', toast: 'This card has no ixigo page' };
    return { result: 'open', url, expires_at: new Date(d.now().getTime() + OPEN_FOR_MS).toISOString() };
  });

  taps.on('options', 'open', async (tap) => {
    const offer = tap.option_id ? await d.results.offer(tap.option_id) : null;
    if (!offer || offer.cardId !== tap.card_id || offer.tripId !== tap.trip_id) return { result: 'refused', toast: 'That option is no longer here' };
    const url = ixigoPage(offer.sourceUrl);
    if (!url) return { result: 'refused', toast: 'This option has no ixigo page' };
    return { result: 'open', url, expires_at: new Date(d.now().getTime() + OPEN_FOR_MS).toISOString() };
  });
}

/** How an options tap reads in "why Go woke". Null for taps from other cards. */
export function renderOptionsTap(item: DeskItem, pack: TripPack): string | null {
  const p = item.payload as { source?: string; action?: string; cardId?: string; optionId?: string; title?: string; personId?: string };
  if (p.source !== 'options') return null;
  const who = pack.trip.people.find((x) => x.person_id === p.personId)?.name ?? 'Someone';
  if (p.action === 'pick') {
    return `${who} tapped "I'll take this" on "${clip(p.title ?? 'an option', 80)}" (option ${p.optionId}, card ${p.cardId}). Reply in the room: confirm it for them, or if the group should agree first, offer put_to_vote with card_id ${p.cardId}.`;
  }
  if (p.action === 'vote_failed') {
    return `${who} tapped "Put it to a vote" on card ${p.cardId}, but opening the vote failed. Try put_to_vote with card_id ${p.cardId}, or say in one line that it did not work.`;
  }
  return null;
}
